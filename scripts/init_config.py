"""Create private prototype configuration without printing tokens or contacting targets."""
from __future__ import annotations

import argparse
import json
import secrets
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, help="absolute directory for private generated configuration")
    parser.add_argument("--port", type=int, default=18880)
    parser.add_argument("--local-port", type=int, default=8563)
    parser.add_argument("--kubeconfig", help="absolute kubeconfig path; no Kubernetes request is made")
    parser.add_argument("--namespace")
    parser.add_argument("--pod")
    parser.add_argument("--container")
    parser.add_argument("--remote-port", type=int, default=8563)
    parser.add_argument("--arthas-home", help="absolute directory of a complete offline Arthas distribution; enables local Attach")
    args = parser.parse_args()
    root = Path(args.output_dir)
    if not root.is_absolute():
        parser.error("--output-dir must be absolute")
    for value in (args.port, args.local_port, args.remote_port):
        if not 1 <= value <= 65535:
            parser.error("ports must be between 1 and 65535")
    if any((args.kubeconfig, args.namespace, args.pod)) and not all((args.kubeconfig, args.namespace, args.pod)):
        parser.error("K8s requires --kubeconfig, --namespace and --pod together")
    if args.kubeconfig and not Path(args.kubeconfig).is_absolute():
        parser.error("--kubeconfig must be absolute")
    if args.arthas_home and not Path(args.arthas_home).is_absolute():
        parser.error("--arthas-home must be absolute")
    files = [root / name for name in ("server.json", "local-connector.json", "k8s-connector.json")]
    if any(file.exists() for file in files):
        parser.error("configuration already exists; select a fresh directory instead of overwriting tokens")
    tokens = {name: secrets.token_urlsafe(32) for name in ("operator", "observer", "local", "k8s")}
    server = {"host": "127.0.0.1", "port": args.port, "public_url": f"http://127.0.0.1:{args.port}",
        "users": [
            {"id": "operator", "token": tokens["operator"], "nodes": ["local-node", "k8s-node"], "scopes": ["diagnose", "attach"]},
            {"id": "observer", "token": tokens["observer"], "nodes": ["k8s-node"], "scopes": ["diagnose"]}],
        "nodes": [{"id": "local-node", "token": tokens["local"]}, {"id": "k8s-node", "token": tokens["k8s"]}]}
    local = {"server_url": f"ws://127.0.0.1:{args.port}/connectors/ws", "node_id": "local-node", "token": tokens["local"],
             "data_dir": str(root / "local-data"), "allow_attach": bool(args.arthas_home),
             "targets": [{"id": "jvm", "name": "本机 Java", "kind": "local", "endpoint": f"http://127.0.0.1:{args.local_port}"}]}
    if args.arthas_home:
        local["arthas_home"] = args.arthas_home
    k8s = {"server_url": local["server_url"], "node_id": "k8s-node", "token": tokens["k8s"],
           "data_dir": str(root / "k8s-data"), "allow_attach": False, "targets": []}
    if args.kubeconfig:
        target = {"id": "pod", "name": "K8s Java", "kind": "k8s", "kubeconfig": args.kubeconfig,
                  "namespace": args.namespace, "pod": args.pod, "remote_port": args.remote_port}
        if args.container:
            target["container"] = args.container
        k8s["targets"].append(target)
    root.mkdir(parents=True, exist_ok=True)
    for file, content in zip(files, (server, local, k8s)):
        with file.open("x", encoding="utf-8") as output:
            json.dump(content, output, ensure_ascii=False, indent=2)
            output.write("\n")
        print(file)
    print("Private tokens were written to the files above, not printed. Do not commit them.")
    if not args.kubeconfig:
        print("K8s configuration has no target. Configure an authorized Pod before starting that connector.")


if __name__ == "__main__":
    main()
