"""Strict port-forward stand-in. Never invokes kubectl, a shell, or a cluster."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import signal
import sys


def validated_arguments(argv, expected):
    if len(argv) != 11:
        raise ValueError(f"expected exactly 11 arguments, got {len(argv)}")
    fixed = {0: "--kubeconfig", 2: "--cache-dir", 4: "-n", 5: expected["namespace"],
             6: "port-forward", 7: "pod/" + expected["pod"], 9: "--address", 10: "127.0.0.1"}
    for index, value in fixed.items():
        if argv[index] != value:
            raise ValueError(f"unexpected argv[{index}]={argv[index]!r}")
    for index, name in [(1, "kubeconfig"), (3, "cache_dir")]:
        if not Path(argv[index]).is_absolute() or Path(argv[index]).resolve() != Path(expected[name]).resolve():
            raise ValueError(f"unexpected {name}")
    ports = argv[8].split(":")
    if len(ports) != 2 or not all(port.isdecimal() for port in ports):
        raise ValueError("port mapping must be LOCAL:REMOTE")
    local, remote = map(int, ports)
    if not 1 <= local <= 65535 or remote != expected["remote_port"]:
        raise ValueError("unexpected local or remote port")
    if not Path(argv[1]).is_file():
        raise ValueError("test kubeconfig does not exist")
    return local


async def run(expected, local_port):
    stop = asyncio.Event()
    clients = set()

    async def relay(reader, writer):
        task = asyncio.current_task()
        clients.add(task)
        upstream_writer = None
        pipes = []
        try:
            upstream_reader, upstream_writer = await asyncio.open_connection("127.0.0.1", expected["upstream_port"])

            async def copy(source, destination):
                while data := await source.read(65536):
                    destination.write(data)
                    await destination.drain()

            pipes = [asyncio.create_task(copy(reader, upstream_writer)), asyncio.create_task(copy(upstream_reader, writer))]
            await asyncio.wait(pipes, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for pipe in pipes:
                pipe.cancel()
            await asyncio.gather(*pipes, return_exceptions=True)
            writer.close()
            if upstream_writer:
                upstream_writer.close()
            clients.discard(task)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))
    server = await asyncio.start_server(relay, "127.0.0.1", local_port)
    log = Path(expected["log"])
    print(f"Writing test relay record: {log.resolve()}", flush=True)
    with log.open("a", encoding="utf-8") as output:
        output.write(json.dumps({"pid": os.getpid(), "port": local_port, "argv": sys.argv[1:]}) + "\n")
    print(f"Forwarding from 127.0.0.1:{local_port} -> {expected['remote_port']}", flush=True)
    try:
        async with server:
            await stop.wait()
    finally:
        for client in tuple(clients):
            client.cancel()
        await asyncio.gather(*clients, return_exceptions=True)


def main():
    expected_path = Path(os.environ["WORKBENCH_FAKE_KUBECTL_EXPECTED"])
    root = Path(__file__).resolve().parents[2] / ".runtime"
    if not expected_path.is_absolute() or not expected_path.resolve().is_relative_to(root.resolve()):
        raise ValueError("expectations must be in prototype .runtime")
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    for name in ["log", "kubeconfig", "cache_dir"]:
        path = Path(expected[name])
        if not path.is_absolute() or not path.resolve().is_relative_to(expected_path.parent.resolve()):
            raise ValueError(f"{name} must stay inside this test runtime")
    local_port = validated_arguments(sys.argv[1:], expected)
    asyncio.run(run(expected, local_port))


if __name__ == "__main__":
    main()
