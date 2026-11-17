"""MCP-over-reverse-stream client, adapted from the legacy bridge's wire protocol.

The prototype deliberately exposes a small tool set and does not replay failed calls.
Upstream task mode preserves the existing trace/watch behavior beyond 30 seconds.
"""
from __future__ import annotations

import asyncio
import codecs
import itertools
import json
from dataclasses import dataclass

from .config import User
from .tunnel import Hub, NodeConnection, TunnelError

TOOLS = frozenset({"jvm", "memory", "thread", "version", "trace", "watch"})
MAX_RESULT = 16 * 1024 * 1024


@dataclass
class Session:
    id: str | None
    version: str
    tasks: bool
    connection: NodeConnection
    target_id: str

    def headers(self) -> dict[str, str]:
        headers = {"accept": "application/json, text/event-stream", "content-type": "application/json",
                   "mcp-protocol-version": self.version}
        if self.id:
            headers["mcp-session-id"] = self.id
        return headers


class ArthasClient:
    def __init__(self, hub: Hub):
        self.hub = hub
        self.sessions: dict[tuple, Session] = {}
        self.locks: dict[tuple, asyncio.Lock] = {}
        self.limits: dict[tuple, asyncio.Semaphore] = {}
        self.request_ids = itertools.count(1)

    async def exchange(self, connection: NodeConnection, target_id: str, payload: dict,
                       headers: dict, timeout: float = 30) -> tuple[dict, dict]:
        body = json.dumps(payload, ensure_ascii=False).encode()
        async with connection.stream(target_id, "POST", "/mcp", headers, body, timeout) as response:
            if response.status >= 400:
                raise TunnelError(f"Arthas returned HTTP {response.status}; call was not replayed")
            if "id" not in payload:
                return {}, response.headers
            expected_id, size = payload["id"], 0
            decoder = codecs.getincrementaldecoder("utf-8")()
            buffer, event_lines = "", []
            is_sse = "text/event-stream" in response.headers.get("content-type", "")
            async for chunk in response.chunks():
                size += len(chunk)
                if size > MAX_RESULT:
                    raise TunnelError("Arthas response exceeds prototype 16 MiB limit")
                buffer += decoder.decode(chunk)
                if not is_sse:
                    continue
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.rstrip("\r")
                    if line.startswith("data:"):
                        event_lines.append(line[5:].lstrip(" "))
                    elif line == "" and event_lines:
                        event = json.loads("\n".join(event_lines))
                        event_lines.clear()
                        if isinstance(event, dict) and event.get("id") == expected_id:
                            return self.result(event), response.headers
            buffer += decoder.decode(b"", final=True)
            if not is_sse and buffer.strip():
                event = json.loads(buffer)
                if isinstance(event, dict) and event.get("id") == expected_id:
                    return self.result(event), response.headers
            raise TunnelError("Arthas closed the response without a matching JSON-RPC result")

    @staticmethod
    def result(event: dict) -> dict:
        if "error" in event:
            error = event["error"]
            raise TunnelError(f"Arthas JSON-RPC error: {str(error)[:2000]}")
        result = event.get("result")
        if not isinstance(result, dict):
            raise TunnelError("Arthas result must be an object")
        return result

    async def session(self, user: User, connection: NodeConnection, target_id: str) -> Session:
        key = (user.id, connection.node_id, connection.generation, target_id)
        # A reconnect invalidates all previous upstream sessions for that node.
        for stale in list(self.sessions):
            if stale[1] == connection.node_id and stale[2] != connection.generation:
                self.sessions.pop(stale, None)
                self.locks.pop(stale, None)
        async with self.locks.setdefault(key, asyncio.Lock()):
            if key in self.sessions:
                return self.sessions[key]
            result, headers = await self.exchange(connection, target_id, {
                "jsonrpc": "2.0", "id": next(self.request_ids), "method": "initialize",
                "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "arthas-workbench", "version": "0.1.0"}},
            }, {"accept": "application/json, text/event-stream", "content-type": "application/json"})
            session = Session(headers.get("mcp-session-id"), result.get("protocolVersion", "2025-06-18"),
                              isinstance(result.get("capabilities", {}).get("tasks"), dict), connection, target_id)
            await self.exchange(connection, target_id,
                {"jsonrpc": "2.0", "method": "notifications/initialized"}, session.headers())
            self.sessions[key] = session
            return session

    async def rpc(self, session: Session, method: str, params: dict, timeout: float = 30) -> dict:
        result, _ = await self.exchange(session.connection, session.target_id,
            {"jsonrpc": "2.0", "id": next(self.request_ids), "method": method, "params": params},
            session.headers(), timeout)
        return result

    async def diagnose(self, user: User, instance_id: str, tool: str, arguments: dict) -> dict:
        if "diagnose" not in user.scopes:
            raise PermissionError("diagnose scope is required")
        if tool not in TOOLS:
            raise ValueError("tool is not enabled in this prototype")
        if not isinstance(arguments, dict):
            raise ValueError("arguments must be a JSON object")
        connection, target_id = self.hub.resolve(user, instance_id)
        limit_key = (connection.node_id, connection.generation, target_id)
        # Shared JVM quota across users; upstream sessions themselves remain user-scoped.
        async with self.limits.setdefault(limit_key, asyncio.Semaphore(4)):
            session = await self.session(user, connection, target_id)
            try:
                if tool not in {"trace", "watch"}:
                    return await self.rpc(session, "tools/call", {"name": tool, "arguments": arguments}, 60)
                args = dict(arguments)
                timeout = args.get("timeout", 30)
                if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 300:
                    raise ValueError("trace/watch timeout must be an integer from 1 to 300 seconds")
                args["timeout"] = timeout
                if not session.tasks:
                    raise TunnelError("This Arthas endpoint does not advertise task support; long trace/watch is unavailable")
                created = await self.rpc(session, "tools/call", {
                    "name": tool, "arguments": args, "task": {"ttl": timeout * 1000 + 5000}}, 30)
                task_id = created.get("task", {}).get("taskId")
                if not isinstance(task_id, str) or not task_id:
                    raise TunnelError("Arthas did not return a task ID; request was not replayed")
                try:
                    return await self.rpc(session, "tasks/result", {"taskId": task_id}, timeout + 20)
                except BaseException:
                    try:
                        async with asyncio.timeout(3):
                            await self.rpc(session, "tasks/cancel", {"taskId": task_id}, 2)
                    except (Exception, asyncio.CancelledError):
                        pass
                    raise
            except (TunnelError, asyncio.TimeoutError):
                # Forget the session for next call, without replaying possibly executed work.
                key = (user.id, connection.node_id, connection.generation, target_id)
                self.sessions.pop(key, None)
                raise

    async def probe(self, user: User, instance_id: str) -> dict:
        if "diagnose" not in user.scopes:
            raise PermissionError("diagnose scope is required")
        connection, target_id = self.hub.resolve(user, instance_id)
        session = await self.session(user, connection, target_id)
        result = await self.rpc(session, "tools/list", {})
        tools = result.get("tools", [])
        connection.targets[target_id] = connection.targets[target_id].model_copy(update={
            "status": "ready", "detail": "Arthas 协议握手与工具探测成功"})
        return {"protocol": session.version, "tasks": session.tasks,
                "tools": [{"name": t.get("name"), "description": t.get("description", ""),
                           "inputSchema": t.get("inputSchema", {})} for t in tools if t.get("name") in TOOLS]}

    async def close(self) -> None:
        async def close_one(session: Session):
            if not session.id or not session.connection.alive:
                return
            try:
                async with session.connection.stream(session.target_id, "DELETE", "/mcp", session.headers(), b"", 2):
                    pass
            except Exception:
                pass
        await asyncio.gather(*(close_one(s) for s in self.sessions.values()))
        self.sessions.clear()
