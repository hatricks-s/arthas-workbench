"""Loopback-only integration fixtures; no installed kubectl or real JVM is used."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
from pathlib import Path
import socket
import sys
import uuid

# Discovery is runnable from any cwd; avoid bytecode outside the test runtime.
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from workbench.app import create_app
from workbench.config import ServerConfig

TOKENS = {
    "userA": "test-userA-abcdefghijklmnopqrstuvwxyz012345",
    "userB": "test-userB-zyxwvutsrqponmlkjihgfedcba987654",
    "nodeA": "test-nodeA-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "nodeB": "test-nodeB-ZYXWVUTSRQPONMLKJIHGFEDCBA987654",
}


def headers(user="userA"):
    return {"Authorization": f"Bearer {TOKENS[user]}"}


async def eventually(predicate, timeout=8, description="condition"):
    async with asyncio.timeout(timeout):
        while True:
            result = predicate()
            if hasattr(result, "__await__"):
                result = await result
            if result:
                return result
            await asyncio.sleep(0.02)


class QuietServer(uvicorn.Server):
    @contextlib.contextmanager
    def capture_signals(self):
        yield


class LiveServer:
    """Reserve port 0 before building config, then serve in the caller's loop."""

    def __init__(self):
        self.socket = socket.socket()
        self.socket.bind(("127.0.0.1", 0))
        self.port = self.socket.getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.task = None

    async def start(self, app):
        self.server = QuietServer(uvicorn.Config(
            app, host="127.0.0.1", port=self.port, log_level="error",
            access_log=False, lifespan="on", timeout_graceful_shutdown=3,
            ws="websockets-sansio",
        ))
        self.task = asyncio.create_task(self.server.serve(sockets=[self.socket]))

        def started():
            if self.task.done():
                self.task.result()
                raise RuntimeError("ASGI server exited before startup")
            return self.server.started

        await eventually(started, description="ASGI startup")
        return self

    async def close(self):
        if self.task is not None and not self.task.done():
            self.server.should_exit = True
            try:
                await asyncio.wait_for(asyncio.shield(self.task), 6)
            except asyncio.TimeoutError:
                self.server.force_exit = True
                self.task.cancel()
                await asyncio.gather(self.task, return_exceptions=True)
        self.socket.close()


class MockArthas:
    """Stateful JSON/SSE MCP mock which validates every upstream session."""

    def __init__(self, identity):
        self.identity = identity
        self.sessions = set()
        self.initialized = set()
        self.deleted = []
        self.calls = []
        self.tasks = {}
        self.cancelled = []
        self.result_started = asyncio.Event()
        self.result_delay = 1.0
        self.invalid_sessions = []
        self.app = Starlette(routes=[Route("/mcp", self.handle, methods=["GET", "POST", "DELETE"])])

    def tool_result(self, name, arguments):
        value = {"target": self.identity, "tool": name, "unicode": "诊断完成", "arguments": arguments}
        if arguments.get("large"):
            value["padding"] = "0123456789abcdef" * 45000  # > 8 * 64 KiB credits.
        return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}], "isError": False}

    async def fragmented(self, event, delay=0):
        # Send headers/comment immediately, then emulate a long upstream task.
        yield b": mock keepalive\r\n\r\n"
        if delay:
            await asyncio.sleep(delay)
        unrelated = {"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progress": 1}}
        yield ("data: " + json.dumps(unrelated) + "\r\n\r\n").encode()
        body = ("event: message\r\ndata: " + json.dumps(event, ensure_ascii=False) + "\r\n\r\n").encode()
        # Deliberately split inside a multibyte UTF-8 character and CRLF boundary.
        pivot = body.find("诊".encode())
        cuts = sorted({0, 1, 7, 21, len(body), *(range(0, len(body), 23)), *([pivot + 1, pivot + 2] if pivot >= 0 else [])})
        for left, right in zip(cuts, cuts[1:]):
            yield body[left:right]
            await asyncio.sleep(0.001)

    async def handle(self, request: Request):
        if request.method == "GET":
            return Response(status_code=405)
        session = request.headers.get("mcp-session-id")
        if request.method == "DELETE":
            if session not in self.sessions:
                return Response(status_code=404)
            self.deleted.append(session)
            self.sessions.remove(session)
            return Response(status_code=204)
        payload = await request.json()
        method = payload["method"]
        params = payload.get("params", {})
        self.calls.append({"method": method, "params": params, "session": session, "headers": dict(request.headers)})
        if method == "initialize":
            session = f"{self.identity}-{uuid.uuid4().hex}"
            self.sessions.add(session)
            return JSONResponse({"jsonrpc": "2.0", "id": payload["id"], "result": {
                "protocolVersion": "2025-06-18", "capabilities": {"tools": {}, "tasks": {}},
                "serverInfo": {"name": self.identity, "version": "test"},
            }}, headers={"mcp-session-id": session})
        if session not in self.sessions:
            self.invalid_sessions.append(session)
            return JSONResponse({"error": "invalid session"}, status_code=404)
        if method == "notifications/initialized":
            self.initialized.add(session)
            return Response(status_code=202)
        if session not in self.initialized:
            return JSONResponse({"error": "initialize notification missing"}, status_code=400)
        if method == "tools/list":
            result = {"tools": [{"name": name, "description": "mock " + name,
                "inputSchema": {"type": "object", "properties": {}}}
                for name in ["jvm", "memory", "thread", "version", "trace", "watch", "unsafe_extra"]]}
        elif method == "tools/call":
            name, arguments = params["name"], params.get("arguments", {})
            if name in {"trace", "watch"}:
                if "task" not in params:
                    return JSONResponse({"error": "task mode required"}, status_code=400)
                task_id = uuid.uuid4().hex
                self.tasks[task_id] = self.tool_result(name, arguments)
                result = {"task": {"taskId": task_id, "status": "working"}}
            else:
                result = self.tool_result(name, arguments)
        elif method == "tasks/result":
            self.result_started.set()
            result = self.tasks[params["taskId"]]
            event = {"jsonrpc": "2.0", "id": payload["id"], "result": result}
            return StreamingResponse(self.fragmented(event, self.result_delay), media_type="text/event-stream")
        elif method == "tasks/cancel":
            self.cancelled.append(params["taskId"])
            result = {"task": {"taskId": params["taskId"], "status": "cancelled"}}
        else:
            return JSONResponse({"jsonrpc": "2.0", "id": payload.get("id"), "error": {"code": -32601, "message": "unknown method"}})
        event = {"jsonrpc": "2.0", "id": payload["id"], "result": result}
        if method == "tools/call" and params.get("arguments", {}).get("sse"):
            return StreamingResponse(self.fragmented(event), media_type="text/event-stream")
        return JSONResponse(event)


class FakeConnector:
    """Independent protocol-v1 peer with real HTTP forwarding and eight credits."""

    def __init__(self, gateway, node, targets):
        self.gateway, self.node, self.targets = gateway, node, targets
        self.work = {}
        self.credits = {}
        self.acks = 0
        self.chunks = 0
        self.cancels = []
        self.commands = []
        self.errors = []
        self.http = httpx.AsyncClient(trust_env=False, timeout=70)

    async def start(self):
        self.ws = await connect(self.gateway.replace("http", "ws", 1) + "/connectors/ws",
            additional_headers={**headers(self.node), "x-node-id": self.node}, proxy=None,
            max_size=2 * 1024 * 1024)
        await self.send({"type": "hello", "version": 1, "targets": [
            {"id": key, "name": key, "kind": "local", "status": "ready"} for key in self.targets
        ], "capabilities": ["scan_java", "attach_local"]})
        self.reader = asyncio.create_task(self.receive())
        return self

    async def send(self, value):
        await self.ws.send(json.dumps(value))

    async def forward(self, message, credits):
        request_id = message["id"]
        try:
            async with self.http.stream(message["method"], self.targets[message["target_id"]] + message["path"],
                    headers=message["headers"], content=base64.b64decode(message["body_base64"])) as response:
                await self.send({"type": "response_start", "id": request_id,
                    "status": response.status_code, "headers": dict(response.headers)})
                async for chunk in response.aiter_raw():
                    for offset in range(0, len(chunk), 32768):
                        await credits.acquire()
                        self.chunks += 1
                        await self.send({"type": "response_chunk", "id": request_id,
                            "data_base64": base64.b64encode(chunk[offset:offset + 32768]).decode()})
                await self.send({"type": "response_end", "id": request_id})
        except asyncio.CancelledError:
            raise
        except ConnectionClosed:
            pass
        except Exception as exc:
            self.errors.append(exc)
            with contextlib.suppress(ConnectionClosed):
                await self.send({"type": "response_error", "id": request_id, "error": str(exc)})

    async def receive(self):
        try:
            async for raw in self.ws:
                message = json.loads(raw)
                request_id = message["id"]
                if message["type"] == "request":
                    credits = self.credits[request_id] = asyncio.Semaphore(8)
                    self.work[request_id] = asyncio.create_task(self.forward(message, credits))
                elif message["type"] == "ack":
                    self.acks += 1
                    if request_id in self.credits:
                        self.credits[request_id].release()
                elif message["type"] == "cancel":
                    self.cancels.append(request_id)
                    task = self.work.pop(request_id, None)
                    if task:
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                    self.credits.pop(request_id, None)
                elif message["type"] == "command":
                    self.commands.append(message)
                    result = {"available": True, "processes": [{"pid": 123, "identity": "test.Main"}]}
                    await self.send({"type": "command_result", "id": request_id, "result": result})
                else:
                    raise AssertionError(f"unexpected gateway frame: {message}")
        except ConnectionClosed:
            pass

    async def close(self):
        if hasattr(self, "ws"):
            await self.ws.close()
            await self.reader
        for task in self.work.values():
            task.cancel()
        await asyncio.gather(*self.work.values(), return_exceptions=True)
        self.work.clear()
        await self.http.aclose()


class GatewayFixture:
    async def start(self, fake=True):
        self.servers, self.connectors = [], []
        self.mock_a, self.mock_b = MockArthas("local-A"), MockArthas("pod-B")
        self.upstream_a = await LiveServer().start(self.mock_a.app)
        self.servers.append(self.upstream_a)
        self.upstream_b = await LiveServer().start(self.mock_b.app)
        self.servers.append(self.upstream_b)
        self.gateway = LiveServer()
        self.config = ServerConfig.model_validate({
            "port": self.gateway.port, "public_url": self.gateway.url,
            "nodes": [{"id": n, "token": TOKENS[n]} for n in ["nodeA", "nodeB"]],
            "users": [{"id": "userA", "token": TOKENS["userA"], "nodes": ["nodeA"], "scopes": ["diagnose", "attach"]},
                      {"id": "userB", "token": TOKENS["userB"], "nodes": ["nodeB"], "scopes": ["diagnose"]}],
        })
        self.app = create_app(self.config)
        await self.gateway.start(self.app)
        self.servers.append(self.gateway)
        self.http = httpx.AsyncClient(base_url=self.gateway.url, trust_env=False, timeout=75)
        if fake:
            self.peer_a = await self.add_connector("nodeA", {"local": self.upstream_a.url})
            self.peer_b = await self.add_connector("nodeB", {"pod": self.upstream_b.url})
            await self.wait_ready("userA", 1)
            await self.wait_ready("userB", 1)
        return self

    async def add_connector(self, node, targets):
        peer = await FakeConnector(self.gateway.url, node, targets).start()
        self.connectors.append(peer)
        return peer

    async def state(self, user="userA"):
        response = await self.http.get("/api/state", headers=headers(user))
        response.raise_for_status()
        return response.json()

    async def wait_ready(self, user="userA", count=1, timeout=12):
        async def ready():
            state = await self.state(user)
            return state if len(state["instances"]) == count and all(i["status"] == "ready" for i in state["instances"]) else None
        return await eventually(ready, timeout, "ready targets")

    async def submit(self, action="diagnose", user="userA", instance="nodeA:local", **kwargs):
        response = await self.http.post("/api/jobs", headers=headers(user),
            json={"action": action, "instance_id": instance, **kwargs})
        if response.status_code != 202:
            raise AssertionError(f"job submission failed: {response.status_code} {response.text}")
        return response.json()["id"]

    async def job(self, job_id, user="userA", timeout=10):
        async def done():
            response = await self.http.get(f"/api/jobs/{job_id}", headers=headers(user))
            response.raise_for_status()
            record = response.json()
            return record if record["status"] != "running" else None
        return await eventually(done, timeout, "job completion")

    async def diagnose(self, instance="nodeA:local", tool="jvm", arguments=None, user="userA", timeout=10):
        job_id = await self.submit(user=user, instance=instance, tool=tool, arguments=arguments or {})
        result = await self.job(job_id, user, timeout)
        if result["status"] != "succeeded":
            raise AssertionError(result)
        return json.loads(result["result"]["content"][0]["text"])

    async def rpc(self, method, params=None, user="userA", rpc_id=1):
        payload = {"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params or {}}
        response = await self.http.post("/mcp", headers={**headers(user),
            "accept": "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18"}, json=payload)
        response.raise_for_status()
        if "text/event-stream" not in response.headers.get("content-type", ""):
            return response.json()
        for block in response.text.replace("\r\n", "\n").split("\n\n"):
            data = "\n".join(line[5:].lstrip() for line in block.splitlines() if line.startswith("data:"))
            if data:
                event = json.loads(data)
                if event.get("id") == rpc_id:
                    return event
        raise AssertionError(f"no matching RPC result: {response.text[:500]}")

    async def close(self):
        if hasattr(self, "app"):
            await self.app.app.state.jobs.close()
            await self.app.app.state.arthas.close()
        for peer in getattr(self, "connectors", []):
            await peer.close()
        if hasattr(self, "http"):
            await self.http.aclose()
        for server in reversed(getattr(self, "servers", [])):
            await server.close()
