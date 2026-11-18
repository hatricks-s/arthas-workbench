# Environment diagnostics prototype

The **v0.3 design prototype** is a standalone, offline interaction model. Its source is `ui-prototype/`; `scripts/build_preview.py` copies it to `docs/preview/` for GitHub Pages. The runnable Python gateway continues to serve `workbench/static/`. Design simulations must not be presented as implemented gateway capabilities.

## Product model

One registered Kubernetes cluster is one environment. A local environment represents one paired device, not the browser machine or the server's localhost. Environments open an inventory of candidate Java targets without requiring an application registration or selection. Namespace, workload and Kubernetes Node are optional filters and grouping dimensions. A concrete Pod/container/JVM remains the execution target.

The prototype contains three fictional clusters and two local devices, one offline. Production has fourteen targets across three namespaces and five workload groups. Two workloads share the name `order-service` in different namespaces; their identities, maintenance policies and task records remain separate. One Pod includes a completed initialization container, which is shown in the identity dialog but is not a JVM target. Kubernetes worker nodes and Connector execution nodes have different identities.

The environment inventory is deliberately small enough for a design review. Eight targets are shown per page. This does not validate discovery, rendering or persistence at production cluster scale.

## Interface

- One light theme: neutral surfaces, blue actions, compact data tables, locally served DM Sans plus installed Chinese fonts. No theme switch or external font dependency.
- A shared environment selector covers clusters and local devices. Workload shortcuts are optional views; **All targets** restores the full environment inventory.
- Namespace, workload, Node, connection status and text filters narrow the inventory. Targets can be grouped by Node, Namespace or workload. A filter or environment change clears bulk selection; pagination can retain explicitly selected targets.
- Readiness/restart information, diagnostic-channel state and MCP availability are distinct. MCP availability is derived from a ready channel, not a separate optimistic registration flag. Discovery does not automatically attach every JVM.
- Selecting a target opens Trace, Watch, Thread, JVM, Memory, OGNL, class inspection and Profiler views. Results use call trees, thread tables/stacks, observation events, key/value details and sampling tables. Raw JSON is optional.
- Web and simulated MCP submissions create the same kind of diagnostic run: source, client, name, tool, immutable parameters, exact target snapshots and a concurrency limit. The task page offers source/status filters, run details and independently cancellable child tasks.
- Run comparison shows deterministic example metrics with separate start/end times. Interrupted or cancelled tasks show missing results, never a fabricated zero. This is not synchronized sampling or an AI-generated conclusion.
- The MCP page shows availability per environment, recent MCP runs and a configurable multi-target demonstration. It uses the current environment and inventory filters, or explicitly selected targets; it does not contact an external MCP service or model provider.
- Local scanning is device-specific and idempotent. Offline devices retain an earlier inventory, with scanning, connection and diagnostics disabled.
- Resource configuration remains outside the daily diagnostic flow. It describes central ZIP distribution, integrity verification, caching and Perl transfer without presenting a working download or installer.

## Run and connection simulations

`startRun(keys, tool, parameters, options)` validates every target and parameter before changing state. A batch stays within one environment. It freezes the target set, including cluster/device identity, Namespace, workload, Pod UID, container instance and JVM identity. Child tasks retain their own target and reference the run's shared parameters.

Concurrency is bounded to 1–4 targets per run. Queued tasks receive no execution deadline until promoted. Each task is independently queued, running, succeeded, cancelled or interrupted. The run status is derived from its children: active, completed, partially completed, cancelled or interrupted. Cancelling the remainder preserves completed results. Different batches can execute independently; production-wide admission control is outside this simulation.

A short outage recovers only the affected target's channel. Same-name replacement retires the old identity and interrupts both running and queued tasks for that identity without replaying them. Exact identity is checked again before a queued child starts. The model retains at most 100 tasks and 100 runs by evicting complete terminal runs; completed siblings of active runs stay available.

Connection policies are scoped to a workload within one environment, or to one local device:

- **Selected:** maintain explicitly connected instances; new replicas remain discovered.
- **All:** connect current replicas and future replacements within the explicitly selected scope.
- **Discover:** release idle simulated channels; rejected while that scope has queued or running tasks.

The deterministic model has no DOM, networking, storage or timers. The UI drives its clock. Refresh resets the scenario; closing the page ends the simulation. **Production background supervision, durable runs, identity verification and replacement detection are not implemented by this frontend.**

All names, metrics and observations are fabricated. No real process, Java runtime, kubeconfig, Kubernetes API or MCP service is contacted. Content Security Policy includes `connect-src 'none'`. The public preview contains no organization-specific environment data or credentials.

## Capability boundary

| Design preview | Runnable gateway today |
| --- | --- |
| Cluster/device environments and dynamic inventory | Static configured local/K8s targets |
| Namespace/workload/Node filtering and exact identity simulation | Current node/target routing; strong JVM identity verification remains incomplete |
| Per-target maintenance and replacement simulation | Connector WS heartbeat and owned forwarding-process lifecycle |
| Shared Web/MCP runs, queueing, cancellation and comparison | In-memory Web jobs; MCP diagnostic calls do not yet share the Web job ledger |
| Trace, Watch, Thread, JVM, Memory, OGNL, SC, Profiler views | JVM, Memory, Thread, Version, Trace, Watch |
| Multiple-device discovery/connection simulation | `jps` scan and optional explicit local Attach |
| Resource lifecycle design | No central ZIP distribution, installer or pairing yet |

Full RBAC, organization management and embedded AI chat are outside the initial product scope. Basic authentication, revocation, explicit connection scope, capability controls and operation records remain necessary. External AI clients perform reasoning; this workbench supplies target access and execution evidence.

New real local Attach retains `arthas.telnetPort=-1`; the design has no interactive Telnet console. This does not prove existing instances have Telnet disabled.

## Build and checks

```sh
python -B scripts/build_preview.py
node --check ui-prototype/app.js
node --check ui-prototype/model.js
node scripts/check_preview.mjs
```

Nineteen focused Node checks exercise environment/namespace/device isolation, immutable snapshots, independent reconnect, cancellation, replacement without replay, policies, scanning, validation, batch concurrency, FIFO promotion, partial completion, atomic rejection and bounded retention. They run with a fake clock inside a VM where network, storage, DOM and timers are forbidden.

Browser verification on **2026-11-18** drove the actual static site through Namespace/workload/Node and text filters, pagination, device-specific scanning, offline action refusal, Web/MCP forms, all eight semantic result views, bounded batch queueing, independent/group cancellation, partial completion, replacement without replay, connection preparation, independent recovery and workload-scoped policy validation. The review checked 1440px desktop, 375px/390px phones and 844px landscape; all four pages fit without whole-page horizontal scrolling. Wide comparison tables scroll within their own container. Closed mobile navigation is inert, open navigation isolates the background, and tab lists support arrow/Home keys. Reduced motion was exercised. Screenshots must come from the fictional offline preview, never an internal or customer environment. UI checks are not real-JVM, real-cluster or production-resilience acceptance.
