from __future__ import annotations

import asyncio
import base64
import json
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import AsyncIterator, Literal

from pydantic import Field
from starlette.websockets import WebSocket, WebSocketDisconnect

from .config import ServerConfig, StrictModel, User

MAX_BODY = 1024 * 1024
MAX_CHUNK = 64 * 1024
HEADERS = {"accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"}
RESPONSE_HEADERS = {"content-type", "mcp-session-id", "mcp-protocol-version", "cache-control", "retry-after"}


class TunnelError(RuntimeError):
    pass


class Target(StrictModel):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,128}$")
    name: str = Field(min_length=1, max_length=256)
    kind: Literal["local", "k8s"]
    status: Literal["ready", "unknown", "unavailable"]
    detail: str | None = Field(default=None, max_length=4096)


class Hello(StrictModel):
    type: Literal["hello"]
    version: Literal[1]
    targets: list[Target] = Field(max_length=128)
    capabilities: list[Literal["scan_java", "attach_local"]] = []


@dataclass
class Pending:
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=12))


class ResponseStream:
    def __init__(self, connection: NodeConnection, request_id: str, pending: Pending, start: dict):
        self.connection, self.id, self.pending = connection, request_id, pending
        self.status = int(start["status"])
        self.headers = {k.lower(): str(v) for k, v in start.get("headers", {}).items() if k.lower() in RESPONSE_HEADERS}

    async def chunks(self) -> AsyncIterator[bytes]:
        while True:
            message = await self.pending.queue.get()
            kind = message.get("type")
            if kind == "response_end":
                return
            if kind == "response_error":
                raise TunnelError(str(message.get("error", "connector failed")))
            if kind != "response_chunk":
                raise TunnelError("unexpected connector response sequence")
            try:
                chunk = base64.b64decode(message["data_base64"], validate=True)
            except (ValueError, KeyError) as exc:
                raise TunnelError("invalid connector chunk") from exc
            if len(chunk) > MAX_CHUNK:
                raise TunnelError("connector chunk exceeds 64 KiB")
            yield chunk
            # Acknowledge only after the downstream consumer has consumed the chunk.
            await self.connection.send({"type": "ack", "id": self.id})


@dataclass
class NodeConnection:
    node_id: str
    websocket: WebSocket
    targets: dict[str, Target]
    capabilities: list[str]
    generation: str = field(default_factory=lambda: uuid.uuid4().hex)
    connected_at: float = field(default_factory=time.time)
    alive: bool = True
    pending: dict[str, Pending] = field(default_factory=dict)
    writer: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, message: dict) -> None:
        if not self.alive:
            raise TunnelError("connector is offline")
        async with self.writer:
            try:
                await asyncio.wait_for(self.websocket.send_json(message), timeout=10)
            except (RuntimeError, OSError, WebSocketDisconnect, asyncio.TimeoutError) as exc:
                raise TunnelError("connector connection was lost") from exc

    @asynccontextmanager
    async def stream(self, target_id: str, method: str, path: str, headers: dict, body: bytes, timeout: float):
        if target_id not in self.targets:
            raise TunnelError("target does not exist")
        if method not in {"GET", "POST", "DELETE"} or path not in {"/mcp", "/api"} or (path == "/api" and method != "POST"):
            raise ValueError("unsupported upstream route")
        if len(body) > MAX_BODY:
            raise ValueError("upstream request exceeds 1 MiB")
        if len(self.pending) >= 16:
            raise TunnelError("connector busy; maximum 16 in-flight operations")
        request_id, pending = str(uuid.uuid4()), Pending()
        self.pending[request_id] = pending
        try:
            async with asyncio.timeout(min(max(timeout, 1), 360)):
                await self.send({
                    "type": "request", "id": request_id, "target_id": target_id,
                    "method": method, "path": path,
                    "headers": {k.lower(): v for k, v in headers.items() if k.lower() in HEADERS},
                    "body_base64": base64.b64encode(body).decode(),
                    "timeout_ms": int(min(max(timeout, 1), 360) * 1000),
                })
                start = await pending.queue.get()
                if start.get("type") == "response_error":
                    raise TunnelError(str(start.get("error", "connector failed")))
                if start.get("type") != "response_start" or not 100 <= int(start.get("status", 0)) <= 599:
                    raise TunnelError("invalid connector response headers")
                yield ResponseStream(self, request_id, pending, start)
        finally:
            self.pending.pop(request_id, None)
            if self.alive:
                try:
                    await self.send({"type": "cancel", "id": request_id})
                except TunnelError:
                    pass

    async def command(self, action: str, arguments: dict, timeout: float = 30) -> dict:
        if action not in self.capabilities:
            raise TunnelError(f"connector does not enable {action}")
        if len(self.pending) >= 16:
            raise TunnelError("connector is busy")
        request_id, pending = str(uuid.uuid4()), Pending()
        self.pending[request_id] = pending
        try:
            await self.send({"type": "command", "id": request_id, "action": action, "arguments": arguments})
            result = await asyncio.wait_for(pending.queue.get(), timeout)
            if result.get("type") != "command_result":
                raise TunnelError(str(result.get("error", "connector command failed")))
            return result.get("result", {})
        finally:
            self.pending.pop(request_id, None)

    def disconnect(self) -> None:
        self.alive = False
        for pending in self.pending.values():
            # Wake every waiter immediately, including ones blocked behind buffered chunks.
            while not pending.queue.empty():
                pending.queue.get_nowait()
            pending.queue.put_nowait({"type": "response_error", "error": "connector disconnected; operation not retried"})


class Hub:
    def __init__(self, config: ServerConfig):
        self.config = config
        self.connections: dict[str, NodeConnection] = {}
        self.last_targets: dict[str, dict[str, Target]] = {}

    def node(self, user: User, node_id: str) -> NodeConnection:
        if node_id not in user.nodes:
            raise PermissionError("node is not authorized")
        connection = self.connections.get(node_id)
        if not connection or not connection.alive:
            raise TunnelError("connector is offline")
        return connection

    def resolve(self, user: User, instance_id: str) -> tuple[NodeConnection, str]:
        if not isinstance(instance_id, str):
            raise ValueError("instance ID must be a string")
        parts = instance_id.split(":")
        if len(parts) != 2:
            raise ValueError("instance ID must be node:target")
        node_id, target_id = parts
        connection = self.node(user, node_id)
        if target_id not in connection.targets:
            raise ValueError("target does not exist")
        return connection, target_id

    def state(self, user: User) -> dict:
        nodes, instances = [], []
        for node_id in user.nodes:
            current = self.connections.get(node_id)
            online = bool(current and current.alive)
            nodes.append({"id": node_id, "online": online,
                          "capabilities": current.capabilities if online else []})
            targets = current.targets if online else self.last_targets.get(node_id, {})
            for target in targets.values():
                instances.append({**target.model_dump(), "id": f"{node_id}:{target.id}",
                                  "target_id": target.id, "node_id": node_id,
                                  "status": target.status if online else "offline"})
        return {"user": user.id, "scopes": user.scopes, "nodes": nodes, "instances": instances,
                "mcp_url": self.config.public_url + "/mcp"}

    async def websocket(self, websocket: WebSocket) -> None:
        node_id = websocket.headers.get("x-node-id", "")
        if websocket.headers.get("origin") or not self.config.authenticate_node(node_id, websocket.headers.get("authorization", "")):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        connection = None
        try:
            raw = await asyncio.wait_for(websocket.receive_text(), 10)
            if len(raw) > 128 * 1024:
                raise ValueError("hello too large")
            hello = Hello.model_validate_json(raw)
            targets = {t.id: t for t in hello.targets}
            if len(targets) != len(hello.targets):
                raise ValueError("duplicate target ID")
            old = self.connections.get(node_id)
            if old and old.alive:
                await websocket.close(code=1008, reason="node already connected")
                return
            connection = NodeConnection(node_id, websocket, targets, hello.capabilities)
            self.connections[node_id] = connection
            self.last_targets[node_id] = targets
            while True:
                raw = await websocket.receive_text()
                if len(raw) > 128 * 1024:
                    raise ValueError("connector message too large")
                message = json.loads(raw)
                if not isinstance(message, dict):
                    raise ValueError("connector message must be an object")
                if message.get("type") == "target_status":
                    target_id = message.get("target_id")
                    if target_id in targets:
                        targets[target_id] = Target.model_validate({**targets[target_id].model_dump(),
                            "status": message.get("status"), "detail": message.get("detail")})
                elif message.get("type") in {"response_start", "response_chunk", "response_end", "response_error", "command_result", "command_error"}:
                    pending = connection.pending.get(message.get("id"))
                    if pending:
                        pending.queue.put_nowait(message)
                else:
                    raise ValueError("unsupported connector message")
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass
        except (ValueError, TypeError, asyncio.TimeoutError, asyncio.QueueFull):
            try:
                await websocket.close(code=1008, reason="invalid connector protocol")
            except (RuntimeError, OSError):
                pass
        finally:
            if connection:
                connection.disconnect()
                if self.connections.get(node_id) is connection:
                    self.connections.pop(node_id, None)

    async def close(self) -> None:
        for connection in list(self.connections.values()):
            connection.disconnect()
            try:
                await connection.websocket.close(code=1001)
            except (RuntimeError, OSError):
                pass
