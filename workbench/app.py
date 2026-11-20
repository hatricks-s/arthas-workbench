from __future__ import annotations

import asyncio
import json
import time
import uuid
from contextlib import asynccontextmanager
from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_request
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route, WebSocketRoute

from .arthas import ArthasClient
from .config import ServerConfig, User
from .tunnel import Hub, TunnelError


class Jobs:
    def __init__(self):
        self.records: dict[str, dict] = {}
        self.tasks: dict[str, asyncio.Task] = {}

    def submit(self, user: User, operation: str, coroutine_factory) -> dict:
        if len(self.tasks) >= 32 or sum(r["owner"] == user.id and r["status"] == "running" for r in self.records.values()) >= 4:
            raise ValueError("too many running operations; wait or cancel an existing task")
        # Bound in-memory history; never evict a running job.
        for key in list(self.records):
            if len(self.records) < 200:
                break
            if self.records[key]["status"] != "running":
                self.records.pop(key)
        job_id = uuid.uuid4().hex
        record = {"id": job_id, "owner": user.id, "operation": operation, "status": "running",
                  "created_at": time.time(), "result": None, "error": None}
        self.records[job_id] = record

        async def execute():
            try:
                async with asyncio.timeout(350):
                    record["result"] = await coroutine_factory()
                record["status"] = "succeeded"
            except asyncio.CancelledError:
                record["status"] = "cancelled"
                record["error"] = "已取消等待；已发出的 Attach 可能仍在目标端执行，请重新探测状态。"
            except Exception as exc:
                record["status"] = "failed"
                record["error"] = str(exc)[:4000] or type(exc).__name__
            finally:
                record["finished_at"] = time.time()
                self.tasks.pop(job_id, None)

        self.tasks[job_id] = asyncio.create_task(execute())
        return self.public(record)

    @staticmethod
    def public(record: dict) -> dict:
        return {k: v for k, v in record.items() if k != "owner"}

    def get(self, user: User, job_id: str) -> dict:
        record = self.records.get(job_id)
        if not record or record["owner"] != user.id:
            raise PermissionError("job not found or not authorized")
        return self.public(record)

    async def close(self):
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


class AuthBoundary:
    def __init__(self, app, config: ServerConfig):
        self.app, self.config = app, config

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            return await self.app(scope, receive, send)
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        if scope["type"] == "websocket":
            return await self.app(scope, receive, send)  # Node token checked by Hub.
        origin = headers.get("origin")
        if origin and origin != self.config.public_url:
            return await JSONResponse({"error": "origin is not allowed"}, 403)(scope, receive, send)
        path = scope["path"]
        if path.startswith("/api/") or path.rstrip("/") == "/mcp":
            user = self.config.authenticate(headers.get("authorization", ""))
            if not user:
                return await JSONResponse({"error": "valid user Bearer token required"}, 401,
                    headers={"WWW-Authenticate": "Bearer"})(scope, receive, send)
            scope["workbench.user"] = user
        if scope["method"] in {"POST", "PUT", "PATCH"}:
            # Buffer at most 1 MiB before passing to framework parsing.
            chunks, total = [], 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                total += len(message.get("body", b""))
                if total > 1024 * 1024:
                    return await JSONResponse({"error": "request exceeds 1 MiB"}, 413)(scope, receive, send)
                chunks.append(message.get("body", b""))
                if not message.get("more_body", False):
                    break
            delivered = False

            async def limited_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
                return await receive()
            await self.app(scope, limited_receive, send)
        else:
            await self.app(scope, receive, send)


def create_app(config: ServerConfig):
    hub, jobs = Hub(config), Jobs()
    arthas = ArthasClient(hub)
    mcp = FastMCP("Arthas Workbench", auth=None,
                  instructions="先 list_instances，随后每次调用明确指定 instance_id。仅显示当前身份可访问的实例。")

    def mcp_user() -> User:
        user = get_http_request().scope.get("workbench.user")
        if not isinstance(user, User):
            raise PermissionError("authenticated user context is required")
        return user

    @mcp.tool()
    async def list_instances() -> dict:
        """列出当前用户可访问的本机和 K8s 实例；instance_id 是 node:target。"""
        return hub.state(mcp_user())

    @mcp.tool()
    async def jvm(instance_id: str) -> dict:
        """读取指定实例的 JVM 信息。"""
        return await arthas.diagnose(mcp_user(), instance_id, "jvm", {})

    @mcp.tool()
    async def memory(instance_id: str) -> dict:
        """读取指定实例的 JVM 内存信息。"""
        return await arthas.diagnose(mcp_user(), instance_id, "memory", {})

    @mcp.tool()
    async def version(instance_id: str) -> dict:
        """读取目标 Arthas 版本。"""
        return await arthas.diagnose(mcp_user(), instance_id, "version", {})

    @mcp.tool()
    async def thread(instance_id: str, top_n: int = 5) -> dict:
        """查看最繁忙的线程；top_n 范围 1–50。"""
        if not 1 <= top_n <= 50:
            raise ValueError("top_n must be between 1 and 50")
        return await arthas.diagnose(mcp_user(), instance_id, "thread", {"topN": top_n})

    @mcp.tool()
    async def trace(instance_id: str, class_pattern: str, method_pattern: str = "*", timeout: int = 30) -> dict:
        """跟踪指定方法调用。被动等待方法执行，timeout 1–300 秒；要求上游 task 支持。"""
        return await arthas.diagnose(mcp_user(), instance_id, "trace", {
            "classPattern": class_pattern, "methodPattern": method_pattern,
            "numberOfExecutions": 1, "timeout": timeout})

    @mcp.tool()
    async def watch(instance_id: str, class_pattern: str, method_pattern: str = "*", timeout: int = 30) -> dict:
        """观察一次方法的入参、返回值与异常；timeout 1–300 秒，要求上游 task 支持。"""
        return await arthas.diagnose(mcp_user(), instance_id, "watch", {
            "classPattern": class_pattern, "methodPattern": method_pattern,
            "express": "{params,returnObj,throwExp}", "numberOfExecutions": 1, "timeout": timeout})

    async def state(request: Request):
        return JSONResponse(hub.state(request.scope["workbench.user"]))

    async def operate(request: Request):
        user: User = request.scope["workbench.user"]
        try:
            data = await request.json()
            if not isinstance(data, dict):
                raise ValueError("request body must be an object")
            action = data.get("action")
            node_id, instance_id = data.get("node_id", ""), data.get("instance_id", "")
            if action == "scan_java":
                node = hub.node(user, node_id)
                factory = lambda: node.command("scan_java", {})
            elif action == "attach_local":
                if "attach" not in user.scopes:
                    raise PermissionError("attach scope is required")
                node, target_id = hub.resolve(user, instance_id)
                if node.targets[target_id].kind != "local":
                    raise ValueError("attach_local requires a local target")
                pid, identity = data.get("pid"), data.get("identity")
                if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0 or not isinstance(identity, str) or not identity:
                    raise ValueError("select an exact scanned PID and identity before attaching")
                factory = lambda: node.command("attach_local", {"target_id": target_id, "pid": pid, "identity": identity}, 120)
            elif action == "probe":
                hub.resolve(user, instance_id)
                factory = lambda: arthas.probe(user, instance_id)
            elif action == "diagnose":
                hub.resolve(user, instance_id)
                if "diagnose" not in user.scopes:
                    raise PermissionError("diagnose scope is required")
                factory = lambda: arthas.diagnose(user, instance_id, data.get("tool", "jvm"), data.get("arguments", {}))
            else:
                raise ValueError("unsupported operation")
            return JSONResponse(jobs.submit(user, f"{action}: {instance_id or node_id}", factory), 202)
        except PermissionError as exc:
            return JSONResponse({"error": str(exc)}, 403)
        except (ValueError, TypeError, TunnelError) as exc:
            return JSONResponse({"error": str(exc)}, 400)

    async def job(request: Request):
        user: User = request.scope["workbench.user"]
        try:
            result = jobs.get(user, request.path_params["job_id"])
            if request.method == "DELETE":
                task = jobs.tasks.get(result["id"])
                if task:
                    task.cancel()
                return JSONResponse({"id": result["id"], "cancel_requested": True})
            return JSONResponse(result)
        except PermissionError as exc:
            return JSONResponse({"error": str(exc)}, 404)

    async def health(request: Request):
        return JSONResponse({"status": "ok", "prototype": True, "version": "0.1.0"})

    # Stateless *external* MCP avoids sharing user state through bearer session IDs.
    # The upstream Arthas sessions are still explicitly user/target/generation scoped.
    mcp_app = mcp.http_app(path="/mcp", stateless_http=True)

    @asynccontextmanager
    async def lifespan(app):
        async with mcp_app.lifespan(app):
            try:
                yield
            finally:
                await jobs.close()
                await arthas.close()
                await hub.close()

    app = Starlette(routes=[
        Route("/health", health),
        Route("/api/state", state), Route("/api/jobs", operate, methods=["POST"]),
        Route("/api/jobs/{job_id}", job, methods=["GET", "DELETE"]),
        WebSocketRoute("/connectors/ws", hub.websocket),
        Mount("/", app=mcp_app),
    ], lifespan=lifespan)
    app.state.hub, app.state.arthas, app.state.jobs = hub, arthas, jobs
    return AuthBoundary(app, config)
