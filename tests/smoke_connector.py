"""Actual connector smoke and browser demo, with no real kubectl or cluster.

Run this absolute script with prototype/.venv/Scripts/python.exe -B.
Use --serve to keep the isolated demo alive; details are in .runtime/test-demo/demo.json.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import uuid

from support import GatewayFixture, ROOT, TOKENS, eventually

BINARY = ROOT / ".build" / "connector" / "debug" / ("arthas-connector.exe" if os.name == "nt" else "arthas-connector")


def write_runtime(path, content):
    path = path.resolve()
    if not path.is_relative_to((ROOT / ".runtime").resolve()):
        raise ValueError("runtime writes must stay in prototype .runtime")
    print(f"Writing test runtime: {path}", flush=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


async def port_open(port):
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), 0.5)
    except (OSError, asyncio.TimeoutError):
        return False
    writer.close()
    await writer.wait_closed()
    return True


def process_alive(pid):
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def kill_owned_fixture(pid):
    """Emergency cleanup is restricted to PIDs recorded by our own relay."""
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.TerminateProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(1, False, pid)
        if handle:
            try:
                kernel.TerminateProcess(handle, 1)
            finally:
                kernel.CloseHandle(handle)
    else:
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGTERM)


class RustFixture(GatewayFixture):
    async def start(self, runtime=None):
        if not BINARY.is_file():
            raise FileNotFoundError(f"Build the connector first: {BINARY}")
        if os.name != "nt":
            raise RuntimeError("this prototype smoke currently supplies a Windows kubectl wrapper")
        await super().start(fake=False)
        self.runtime = (runtime or ROOT / ".runtime" / ("test-rust-" + uuid.uuid4().hex[:10])).resolve()
        self.relay_log = self.runtime / "relay.jsonl"
        self.process = None
        self.log_file = None
        data_dir = self.runtime / "connector-data"
        kubeconfig = self.runtime / "fake kubeconfig.json"
        expectation = self.runtime / "relay-expectations.json"
        config_path = self.runtime / "connector.json"
        write_runtime(self.relay_log, "")
        write_runtime(kubeconfig, json.dumps({"fixture": "not a real kubeconfig"}))
        write_runtime(expectation, json.dumps({
            "namespace": "test-ns", "pod": "mock-pod", "remote_port": 8563,
            "kubeconfig": str(kubeconfig), "cache_dir": str(data_dir / "kube-cache"),
            "upstream_port": self.upstream_b.port, "log": str(self.relay_log),
        }))
        wrapper = ROOT / "tests" / "helpers" / "fake_kubectl.cmd"
        write_runtime(config_path, json.dumps({
            "server_url": self.gateway.url.replace("http", "ws", 1) + "/connectors/ws",
            "node_id": "nodeA", "token": TOKENS["nodeA"], "data_dir": str(data_dir),
            "kubectl": str(wrapper), "jps": str(self.runtime / "never-run-jps.exe"),
            "java": str(self.runtime / "never-run-java.exe"), "allow_attach": False,
            "targets": [
                {"kind": "local", "id": "local", "name": "Local mock JVM", "endpoint": self.upstream_a.url},
                {"kind": "k8s", "id": "pod", "name": "Kubernetes mock JVM", "kubeconfig": str(kubeconfig),
                 "namespace": "test-ns", "pod": "mock-pod", "container": "app", "remote_port": 8563},
            ],
        }, indent=2))
        log_path = self.runtime / "connector.log"
        for path in [data_dir, self.relay_log, log_path]:
            print(f"Connector test writes: {path.resolve()}", flush=True)
        self.log_file = log_path.open("w", encoding="utf-8")
        environment = {**os.environ, "WORKBENCH_TEST_PYTHON": sys.executable,
            "WORKBENCH_FAKE_KUBECTL_EXPECTED": str(expectation), "PYTHONDONTWRITEBYTECODE": "1",
            "TMP": str(self.runtime), "TEMP": str(self.runtime), "TMPDIR": str(self.runtime)}
        self.process = await asyncio.create_subprocess_exec(str(BINARY), "--config", str(config_path),
            cwd=str(self.runtime), env=environment, stdout=self.log_file, stderr=self.log_file)
        try:
            await self.wait_ready(count=2, timeout=18)
        except Exception:
            self.log_file.flush()
            print(log_path.read_text(encoding="utf-8"), file=sys.stderr)
            raise
        return self

    def relay_records(self):
        if not self.relay_log.is_file():
            return []
        return [json.loads(line) for line in self.relay_log.read_text(encoding="utf-8").splitlines() if line]

    async def disconnect(self):
        connection = self.app.app.state.hub.connections["nodeA"]
        await connection.websocket.close(code=1012, reason="test reconnect")
        return connection.generation

    async def wait_relay_gone(self, record):
        async def gone():
            return not process_alive(record["pid"]) and not await port_open(record["port"])
        await eventually(gone, timeout=6, description="owned kubectl descendant cleanup")

    async def close(self):
        try:
            if hasattr(self, "app"):
                await self.app.app.state.jobs.close()
                await self.app.app.state.arthas.close()
                await self.app.app.state.hub.close()
            if hasattr(self, "runtime"):
                # Let the connector observe WS close and destroy its owned processes.
                for record in self.relay_records():
                    with contextlib.suppress(asyncio.TimeoutError):
                        await self.wait_relay_gone(record)
            if getattr(self, "process", None) and self.process.returncode is None:
                self.process.terminate()
                await asyncio.wait_for(self.process.wait(), 5)
        finally:
            if hasattr(self, "runtime"):
                for record in self.relay_records():
                    if process_alive(record["pid"]):
                        kill_owned_fixture(record["pid"])
            if getattr(self, "log_file", None):
                self.log_file.close()
            await super().close()


async def serve():
    fixture = RustFixture()
    try:
        await fixture.start(ROOT / ".runtime" / "test-demo")
        stop_file = fixture.runtime / "STOP"
        if stop_file.exists():
            print(f"Removing stale stop file: {stop_file}", flush=True)
            stop_file.unlink()
        info = {"url": fixture.gateway.url, "user_token": TOKENS["userA"], "node": "nodeA",
                "instances": ["nodeA:local", "nodeA:pod"], "pid": os.getpid(),
                "stop_file": str(stop_file), "connector_pid": fixture.process.pid,
                "mock_upstreams": [fixture.upstream_a.url, fixture.upstream_b.url]}
        write_runtime(fixture.runtime / "demo.json", json.dumps(info, indent=2))
        print(json.dumps(info), flush=True)
        print("Demo ready; Ctrl+C stops the gateway, connector, and owned relay.", flush=True)
        stopped = asyncio.Event()
        loop = asyncio.get_running_loop()
        for signum in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, lambda *_: loop.call_soon_threadsafe(stopped.set))
        while not stopped.is_set() and not stop_file.exists():
            try:
                await asyncio.wait_for(stopped.wait(), 0.25)
            except asyncio.TimeoutError:
                pass
    finally:
        await fixture.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args()
    if args.serve:
        asyncio.run(serve())
    else:
        import unittest
        from test_connector import RealConnectorTests
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(RealConnectorTests))
        raise SystemExit(not result.wasSuccessful())


if __name__ == "__main__":
    main()
