"""Run with .venv/Scripts/python.exe -B -m unittest discover -s ABS/tests -v."""
import asyncio
import json
import os
import unittest

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from support import GatewayFixture, TOKENS, eventually, headers
from workbench.config import ServerConfig


class GatewayIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture = GatewayFixture()
        self.addAsyncCleanup(self.fixture.close)
        await self.fixture.start()

    async def test_authentication_and_origin_boundaries(self):
        f = self.fixture
        for path in ["/api/state", "/mcp"]:
            for auth in [None, "Bearer invalid", "Bearer " + TOKENS["nodeA"]]:
                with self.subTest(path=path, auth=auth and auth[:15]):
                    response = await f.http.get(path, headers={"Authorization": auth} if auth else {})
                    self.assertEqual(response.status_code, 401)
            response = await f.http.get(path, headers={**headers(), "Origin": "https://untrusted.example"})
            self.assertEqual(response.status_code, 403)
        response = await f.http.get("/api/state", headers={**headers(), "Origin": f.gateway.url})
        self.assertEqual(response.status_code, 200)
        response = await f.http.post("/api/jobs", headers=headers(), content=b"x" * (1024 * 1024 + 1))
        self.assertEqual(response.status_code, 413)
        for node_headers in [
            {"x-node-id": "nodeA", "Authorization": "Bearer invalid"},
            {"x-node-id": "nodeA", **headers("userA")},
            {"x-node-id": "nodeA", **headers("nodeA"), "Origin": f.gateway.url},
            {"x-node-id": "nodeB", **headers("nodeA")},
        ]:
            with self.subTest(ws_headers=list(node_headers)):
                with self.assertRaises(InvalidStatus) as rejected:
                    async with connect(f.gateway.url.replace("http", "ws") + "/connectors/ws",
                            additional_headers=node_headers, proxy=None):
                        self.fail("unauthorized connector was accepted")
                self.assertEqual(rejected.exception.response.status_code, 403)

    async def test_user_nodes_jobs_and_mcp_are_isolated(self):
        f = self.fixture
        for user, node, instance in [("userA", "nodeA", "nodeA:local"), ("userB", "nodeB", "nodeB:pod")]:
            state = await f.state(user)
            self.assertEqual([n["id"] for n in state["nodes"]], [node])
            self.assertEqual([i["id"] for i in state["instances"]], [instance])
            self.assertEqual(state["mcp_url"], f.gateway.url + "/mcp")
            initialized = await f.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "independent-test", "version": "1"}}, user=user)
            self.assertIn("serverInfo", initialized["result"])
            listed = await f.rpc("tools/call", {"name": "list_instances", "arguments": {}}, user=user)
            payload = json.loads(listed["result"]["content"][0]["text"])
            self.assertEqual([i["id"] for i in payload["instances"]], [instance])
        job_a = await f.submit(tool="jvm")
        job_b = await f.submit(user="userB", instance="nodeB:pod", tool="memory")
        self.assertEqual((await f.job(job_a))["status"], "succeeded")
        self.assertEqual((await f.job(job_b, "userB"))["status"], "succeeded")
        for user, other_job, forbidden in [("userA", job_b, "nodeB:pod"), ("userB", job_a, "nodeA:local")]:
            for method in ["GET", "DELETE"]:
                response = await f.http.request(method, f"/api/jobs/{other_job}", headers=headers(user))
                self.assertEqual(response.status_code, 404)
            for action in ["probe", "diagnose"]:
                response = await f.http.post("/api/jobs", headers=headers(user),
                    json={"action": action, "instance_id": forbidden, "tool": "jvm"})
                self.assertEqual(response.status_code, 403)
            rejected = await f.rpc("tools/call", {"name": "jvm", "arguments": {"instance_id": forbidden}}, user=user)
            self.assertTrue(rejected["result"]["isError"])
        result = await f.rpc("tools/call", {"name": "version", "arguments": {"instance_id": "nodeA:local"}})
        nested = json.loads(result["result"]["content"][0]["text"])
        self.assertEqual(json.loads(nested["content"][0]["text"])["target"], "local-A")
        self.assertFalse(f.mock_a.invalid_sessions + f.mock_b.invalid_sessions)

    async def test_probe_json_fragmented_sse_and_ack_window(self):
        f = self.fixture
        # Arthas may start after the connector's first health check. Manual probe must recover.
        f.app.app.state.hub.connections["nodeA"].targets["local"].status = "unavailable"
        probe = await f.job(await f.submit(action="probe"))
        self.assertEqual(probe["status"], "succeeded")
        self.assertEqual((await f.state())["instances"][0]["status"], "ready")
        self.assertTrue(probe["result"]["tasks"])
        self.assertEqual({t["name"] for t in probe["result"]["tools"]}, {"jvm", "memory", "thread", "version", "trace", "watch"})
        before = f.peer_a.chunks
        large = await f.diagnose(tool="memory", arguments={"large": True})
        self.assertEqual(len(large["padding"]), 720000)
        self.assertGreater(f.peer_a.chunks - before, 8)
        self.assertGreater(f.peer_a.acks, 8)
        fragmented = await f.diagnose(tool="thread", arguments={"sse": True})
        self.assertEqual(fragmented["unicode"], "诊断完成")
        self.assertEqual(fragmented["target"], "local-A")
        for tool in ["trace", "watch"]:
            result = await f.diagnose(tool=tool, arguments={"timeout": 5})
            self.assertEqual(result["tool"], tool)
            self.assertEqual(result["target"], "local-A")
        self.assertEqual(sum(call["method"] == "initialize" for call in f.mock_a.calls), 1)
        self.assertEqual(len(f.mock_a.initialized), 1)
        self.assertFalse(f.peer_a.errors)
        self.assertTrue(all("authorization" not in call["headers"] for call in f.mock_a.calls))

    async def test_disconnect_fails_waiter_and_reconnect_uses_fresh_session(self):
        f = self.fixture
        await f.diagnose()
        old_sessions = set(f.mock_a.sessions)
        f.mock_a.result_delay = 60
        job_id = await f.submit(tool="trace", arguments={"timeout": 90})
        await asyncio.wait_for(f.mock_a.result_started.wait(), 5)
        await f.peer_a.close()
        failed = await f.job(job_id, timeout=5)
        self.assertEqual(failed["status"], "failed")
        self.assertIn("disconnect", failed["error"])
        self.assertEqual((await f.state())["instances"][0]["status"], "offline")
        f.mock_a.sessions.clear()  # An upstream restart makes any stale ID observable.
        f.mock_a.initialized.clear()
        f.mock_a.result_delay = 1
        f.peer_a = await f.add_connector("nodeA", {"local": f.upstream_a.url})
        await f.wait_ready()
        self.assertEqual((await f.diagnose())["target"], "local-A")
        self.assertTrue(old_sessions.isdisjoint(f.mock_a.sessions))
        self.assertEqual(sum(c["method"] == "initialize" for c in f.mock_a.calls), 2)
        self.assertFalse(f.mock_a.invalid_sessions)
        self.assertEqual(sum(c["method"] == "tools/call" and c["params"]["name"] == "trace" for c in f.mock_a.calls), 1)

    async def test_cancel_task_and_delete_upstream_session(self):
        f = self.fixture
        f.mock_a.result_delay = 60
        job_id = await f.submit(tool="watch", arguments={"timeout": 90})
        await asyncio.wait_for(f.mock_a.result_started.wait(), 5)
        response = await f.http.delete(f"/api/jobs/{job_id}", headers=headers())
        self.assertTrue(response.json()["cancel_requested"])
        record = await f.job(job_id)
        self.assertEqual(record["status"], "cancelled")
        self.assertEqual(len(f.mock_a.cancelled), 1)
        self.assertIn(f.mock_a.cancelled[0], f.mock_a.tasks)
        await eventually(lambda: not f.app.app.state.hub.connections["nodeA"].pending)
        sessions = set(f.mock_a.sessions)
        self.assertEqual(len(sessions), 1)
        await f.app.app.state.arthas.close()
        self.assertEqual(set(f.mock_a.deleted), sessions)
        self.assertFalse(f.mock_a.sessions)

    async def test_standard_fastmcp_client_preserves_request_identity(self):
        from fastmcp import Client
        from fastmcp.client.transports import StreamableHttpTransport
        import httpx

        def client_factory(headers=None, timeout=None, auth=None):
            return httpx.AsyncClient(headers=headers, timeout=timeout, auth=auth, trust_env=False)

        f = self.fixture
        clients = [Client(StreamableHttpTransport(f.gateway.url + "/mcp", headers=headers(user),
                    httpx_client_factory=client_factory), timeout=15)
                   for user in ["userA", "userB"]]
        async with clients[0] as client_a, clients[1] as client_b:
            tools = await client_a.list_tools()
            self.assertEqual({tool.name for tool in tools}, {"list_instances", "jvm", "memory", "thread", "version", "trace", "watch"})
            lists = await asyncio.gather(client_a.call_tool("list_instances", {}), client_b.call_tool("list_instances", {}))
            for result, expected in zip(lists, ["nodeA:local", "nodeB:pod"]):
                state = json.loads(result.content[0].text)
                self.assertEqual([item["id"] for item in state["instances"]], [expected])
            result = await client_a.call_tool("jvm", {"instance_id": "nodeA:local"})
            nested = json.loads(result.content[0].text)
            self.assertEqual(json.loads(nested["content"][0]["text"])["target"], "local-A")
            rejected = await client_b.call_tool("jvm", {"instance_id": "nodeA:local"}, raise_on_error=False)
            self.assertTrue(rejected.is_error)

    async def test_scan_attach_permissions_and_validation(self):
        f = self.fixture
        job_id = await f.submit(action="scan_java", node_id="nodeA")
        record = await f.job(job_id)
        self.assertEqual(record["result"]["processes"][0]["pid"], 123)
        allowed = await f.submit(action="attach_local", pid=123, identity="test.Main")
        self.assertEqual((await f.job(allowed))["status"], "succeeded")
        self.assertEqual(f.peer_a.commands[-1]["arguments"], {"target_id": "local", "pid": 123, "identity": "test.Main"})
        for body, user, expected in [
            ({"action": "scan_java", "node_id": "nodeA"}, "userB", 403),
            ({"action": "attach_local", "instance_id": "nodeB:pod", "pid": 123, "identity": "test.Main"}, "userB", 403),
            ({"action": "attach_local", "instance_id": "nodeA:local", "pid": True, "identity": "test.Main"}, "userA", 400),
            ({"action": "attach_local", "instance_id": "nodeA:local", "pid": 123}, "userA", 400),
        ]:
            response = await f.http.post("/api/jobs", headers=headers(user), json=body)
            self.assertEqual(response.status_code, expected)
        self.assertFalse(f.peer_b.commands)

    @unittest.skipUnless(os.environ.get("WORKBENCH_LONG_TESTS") == "1", "set WORKBENCH_LONG_TESTS=1 for >35s task regression")
    async def test_task_wait_exceeds_thirty_seconds(self):
        f = self.fixture
        f.mock_a.result_delay = 35.5
        started = asyncio.get_running_loop().time()
        result = await f.diagnose(tool="trace", arguments={"timeout": 45}, timeout=60)
        self.assertGreaterEqual(asyncio.get_running_loop().time() - started, 35)
        self.assertEqual(result["tool"], "trace")


class ConfigurationTests(unittest.TestCase):
    def test_rejects_weak_duplicate_tokens_and_invalid_authorization_map(self):
        base = {"nodes": [{"id": "nodeA", "token": TOKENS["nodeA"]}],
                "users": [{"id": "userA", "token": TOKENS["userA"], "nodes": ["nodeA"]}]}
        self.assertEqual(ServerConfig.model_validate(base).users[0].id, "userA")
        for change in [
            {"users": [{"id": "userA", "token": "too-short", "nodes": ["nodeA"]}]},
            {"users": [{"id": "userA", "token": TOKENS["nodeA"], "nodes": ["nodeA"]}]},
            {"users": [{"id": "userA", "token": TOKENS["userA"], "nodes": ["missing"]}]},
            {"public_url": "http://public.example"},
            {"public_url": "http://127.0.0.1:18880/path"},
        ]:
            with self.subTest(change=list(change)), self.assertRaises(ValueError):
                ServerConfig.model_validate({**base, **change})


if __name__ == "__main__":
    unittest.main()
