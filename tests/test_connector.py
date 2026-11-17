"""Optional tests automatically run when the built Windows connector exists."""
import asyncio
import os
import unittest
from unittest.mock import AsyncMock, Mock, patch

from smoke_connector import BINARY, RustFixture, port_open, process_alive
from support import eventually


class PortProbeTests(unittest.IsolatedAsyncioTestCase):
    async def test_peer_reset_during_close_does_not_prove_port_closed(self):
        writer = Mock()
        writer.wait_closed = AsyncMock(side_effect=ConnectionResetError(10054, "peer reset"))
        with patch("smoke_connector.asyncio.open_connection", new_callable=AsyncMock) as connect:
            connect.return_value = (object(), writer)
            self.assertTrue(await port_open(12345))
            connect.assert_awaited_once_with("127.0.0.1", 12345)
        writer.close.assert_called_once()
        writer.wait_closed.assert_awaited_once()

    async def test_refused_connection_reports_port_closed(self):
        with patch("smoke_connector.asyncio.open_connection", new_callable=AsyncMock) as connect:
            connect.side_effect = ConnectionRefusedError("no listener")
            self.assertFalse(await port_open(12345))

    async def test_probe_close_does_not_swallow_cancellation(self):
        writer = Mock()
        writer.wait_closed = AsyncMock(side_effect=asyncio.CancelledError)
        with patch("smoke_connector.asyncio.open_connection", new_callable=AsyncMock) as connect:
            connect.return_value = (object(), writer)
            with self.assertRaises(asyncio.CancelledError):
                await port_open(12345)
        writer.close.assert_called_once()


@unittest.skipUnless(BINARY.is_file() and os.name == "nt", "build the Windows Rust connector before running real-connector smoke")
class RealConnectorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture = RustFixture()
        self.addAsyncCleanup(self.fixture.close)
        await self.fixture.start()

    async def test_local_and_k8s_use_one_gateway_with_streaming(self):
        f = self.fixture
        state = await f.state()
        self.assertEqual({i["id"]: i["kind"] for i in state["instances"]}, {"nodeA:local": "local", "nodeA:pod": "k8s"})
        self.assertEqual(state["mcp_url"], f.gateway.url + "/mcp")
        for instance, identity in [("nodeA:local", "local-A"), ("nodeA:pod", "pod-B")]:
            probe = await f.job(await f.submit(action="probe", instance=instance))
            self.assertEqual(probe["status"], "succeeded", probe)
            self.assertTrue(probe["result"]["tasks"])
            for tool, arguments in [("jvm", {}), ("memory", {"large": True}), ("thread", {"sse": True}), ("version", {})]:
                result = await f.diagnose(instance, tool, arguments)
                self.assertEqual(result["target"], identity)
                self.assertEqual(result["tool"], tool)
                if arguments.get("large"):
                    self.assertEqual(len(result["padding"]), 720000)
            task = await f.diagnose(instance, "trace", {"timeout": 5})
            self.assertEqual(task["target"], identity)
        self.assertEqual(len(f.relay_records()), 1)
        relay = f.relay_records()[0]
        self.assertTrue(process_alive(relay["pid"]))
        self.assertEqual(relay["argv"][-2:], ["--address", "127.0.0.1"])
        self.assertNotIn("--container", relay["argv"])
        self.assertFalse(f.mock_a.invalid_sessions + f.mock_b.invalid_sessions)
        self.assertTrue(all("authorization" not in c["headers"] for c in f.mock_a.calls + f.mock_b.calls))
        sessions = set(f.mock_a.sessions) | set(f.mock_b.sessions)
        await f.app.app.state.arthas.close()
        self.assertEqual(set(f.mock_a.deleted + f.mock_b.deleted), sessions)
        await f.disconnect()
        await f.wait_relay_gone(relay)

    async def test_cancel_disconnect_and_reconnect_cleanup(self):
        f = self.fixture
        f.mock_b.result_delay = 60
        task_id = await f.submit(instance="nodeA:pod", tool="watch", arguments={"timeout": 90})
        await asyncio.wait_for(f.mock_b.result_started.wait(), 5)
        from support import headers
        cancelled = await f.http.delete(f"/api/jobs/{task_id}", headers=headers())
        self.assertEqual(cancelled.status_code, 200)
        self.assertEqual((await f.job(task_id))["status"], "cancelled")
        self.assertEqual(len(f.mock_b.cancelled), 1)
        f.mock_b.result_started.clear()
        pending = await f.submit(instance="nodeA:pod", tool="trace", arguments={"timeout": 90})
        await asyncio.wait_for(f.mock_b.result_started.wait(), 5)
        old_sessions = set(f.mock_b.sessions)
        old_relay = f.relay_records()[0]
        old_generation = await f.disconnect()
        self.assertEqual((await f.job(pending))["status"], "failed")
        await f.wait_relay_gone(old_relay)
        f.mock_b.sessions.clear()
        f.mock_b.initialized.clear()
        f.mock_b.result_delay = 1

        def reconnected():
            connection = f.app.app.state.hub.connections.get("nodeA")
            return connection and connection.generation != old_generation

        await eventually(reconnected, timeout=12)
        await f.wait_ready(count=2)
        self.assertEqual((await f.diagnose("nodeA:pod", "jvm"))["target"], "pod-B")
        self.assertTrue(old_sessions.isdisjoint(f.mock_b.sessions))
        self.assertFalse(f.mock_b.invalid_sessions)
        self.assertEqual(sum(c["method"] == "initialize" for c in f.mock_b.calls), 2)
        self.assertEqual(sum(c["method"] == "tools/call" and c["params"]["name"] == "trace" for c in f.mock_b.calls), 1)
        self.assertGreaterEqual(len(f.relay_records()), 2)
        self.assertNotEqual(f.relay_records()[-1]["pid"], old_relay["pid"])

    @unittest.skipUnless(os.environ.get("WORKBENCH_LONG_TESTS") == "1", "set WORKBENCH_LONG_TESTS=1 for actual connector >35s task")
    async def test_real_connector_task_wait_exceeds_thirty_seconds(self):
        f = self.fixture
        f.mock_b.result_delay = 35.5
        started = asyncio.get_running_loop().time()
        from fastmcp import Client
        from fastmcp.client.transports import StreamableHttpTransport
        import httpx
        import json
        from support import headers

        def client_factory(headers=None, timeout=None, auth=None):
            return httpx.AsyncClient(headers=headers, timeout=timeout, auth=auth, trust_env=False)

        transport = StreamableHttpTransport(f.gateway.url + "/mcp", headers=headers(),
            httpx_client_factory=client_factory)
        async with Client(transport, timeout=60) as client:
            response = await client.call_tool("watch", {"instance_id": "nodeA:pod",
                "class_pattern": "example.Service", "timeout": 45}, timeout=60)
        self.assertGreaterEqual(asyncio.get_running_loop().time() - started, 35)
        result = json.loads(response.content[0].text)
        self.assertEqual(json.loads(result["content"][0]["text"])["target"], "pod-B")


if __name__ == "__main__":
    unittest.main()
