# Runtime behavior

## Targets and trust

A target belongs to an explicitly configured connector. The connector can reach local loopback Arthas or start a kubectl port-forward to a configured Pod. It never accepts an arbitrary remote upstream URL from the browser. All calls use `node:target` instance IDs.

Local endpoint URLs must be HTTP loopback origins. Remote connector connections require WSS, except loopback WS development connections. Redirects and upstream proxy inheritance are disabled for loopback requests. The gateway forwards only approved MCP/HTTP headers, not user Bearer credentials or cookies.

The external MCP transport is stateless; each request authenticates independently. Upstream Arthas sessions are keyed by user, node, connection generation and target. Per-target concurrency is shared across users inside the one gateway process. This is not a distributed quota or multi-replica implementation.

## Local Attach

Attach is disabled by default. Enabling it requires a complete, operator-supplied offline Arthas distribution with boot/core/agent/spy JARs, a permitted user, and explicit PID/identity selection. It currently attaches to a localhost/127.0.0.1 endpoint and refuses an occupied port because ownership of that listener cannot be established.

The connector stages a private home under its configured data directory and does not rewrite shared user Arthas configuration. Staged files are retained because the attached JVM may still use them. The target JVM's own runtime behavior and logging remain subject to that JVM's configuration and OS permissions.

`jps` visibility is limited by user permissions and JVM/JDK configuration. A browser window is not a process identity. Containers have their own process namespace; running the workbench in a container does not automatically reveal host JVMs.

## Kubernetes

The current prototype assumes Arthas is already running. It does not upload resources or run kubectl exec. The connector launches port-forward with explicit arguments and owns the resulting process tree. The local listening port is allocated internally.

A configured `container` identifies intent but does not create a per-container network namespace: port-forward reaches the Pod's network. The prototype fixes a Pod name and does not follow a Deployment replacement automatically. Verify the target after Pod recreation.

Child HOME, temporary files and kubectl cache are isolated under the connector data directory. Credential plugins that normally read a user's home-directory login cache may require explicitly configured paths. Kubeconfig is trusted operator input; do not accept untrusted uploaded kubeconfig containing executable credential hooks without a separate policy.

## Tasks, cancellation and shutdown

- Closing a page does not stop Java or automatically detach Arthas.
- Diagnostic cancellation attempts to cancel an upstream task and drops its forwarding request. A network partition can prevent immediate upstream cancellation.
- Cancelling the wait for Attach does not guarantee undoing an already executed Attach.
- Disconnect fails pending calls; reconnect creates a new generation. Possibly executed calls are not automatically replayed.
- Only owned port-forward subprocesses are cleaned up. Unknown processes are not killed by port number.
- K8s child exit marks the target unavailable; connector reconnect recreates the forwarding process.
- A manual probe can recover a local target that started after the connector's first check.
- Sessions, jobs and history are in memory; restart does not restore them.

## Limits

| Boundary | Prototype limit |
| --- | --- |
| Incoming request body | 1 MiB |
| Decoded stream chunk | 64 KiB |
| Outstanding chunks/request | 8 |
| Connector in-flight operations | 16 |
| Diagnostic concurrency/target | 4 |
| Diagnostic result | 16 MiB |
| trace/watch timeout | 1–300 seconds |
| Gateway jobs | 32 total; 4 running/user |

Large file transfer is not implemented. Raising a JSON result limit is not a substitute for a dedicated artifact transfer path.

## Compatibility and validation

The tested baseline uses Python 3.13, FastMCP 2.11.3 and MCP SDK 1.30.0. Dependency pins serve this prototype and require maintenance. Older dependency imports may emit deprecation warnings; they are not a production support commitment.

Automated fixtures exercise actual components against loopback mocks. They do not validate a real cluster's RBAC/networking, actual JVM Attach across JDKs, a specific IDE's configuration UI, reverse proxy timeouts, every OS or every Arthas version. Document these as separate acceptance results when they are performed.
