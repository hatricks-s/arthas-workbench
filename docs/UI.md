# Application diagnostics prototype

The **v0.2 design prototype** is a standalone, offline interaction model. Its source is `ui-prototype/`; `scripts/build_preview.py` copies it to `docs/preview/` for GitHub Pages. The runnable Python gateway continues to serve `workbench/static/`. These are intentionally separate: design simulations must not be presented as implemented gateway capabilities.

## Product model

The shared team server is the main product. Environments organize application deployments; a specific Pod/container/JVM is the execution target. Kubernetes worker nodes and connector execution nodes have different identities. The same application name can exist in production, staging and development without sharing target IDs, permissions or task state.

The prototype starts with three environments and four applications. Production `order-service` has six fictional Pods across three worker nodes: four connected, one awaiting reconnection, and one discovered but not connected. A completed Trace result and a running Watch task make the workspace reviewable immediately. The local page contains two fictional JVMs and an idempotent simulated scan that discovers a third.

## Interface

- One light theme: neutral surfaces, blue actions, compact data tables, locally served DM Sans plus installed Chinese fonts. No theme switch or external font dependency.
- Persistent environment context and application navigation; instances can be searched, filtered and grouped by worker node.
- Pod running state and diagnostic-channel state are separate columns.
- The selected instance opens a diagnostic workspace with Trace, Watch, Thread, JVM, Memory, OGNL, class inspection and Profiler views.
- Results use call trees, thread tables/stacks, observation events, key/value details and sampling tables. Raw JSON remains available as an optional view.
- A global task page preserves the original environment, application, Pod identity and JVM generation when the user navigates elsewhere. Several tasks can run independently; batch submission creates separately cancellable child tasks.
- Native dialogs configure diagnostics, explain exact target identity, set connection policy, and expose deterministic failure scenarios.
- MCP access and infrastructure configuration sit outside the daily diagnostic flow. The resource page describes central ZIP distribution, integrity verification, caching and Perl transfer without pretending to provide a working download or installer.

## Connection and task simulations

Each target has a stable key, Pod/instance UID and generation. Submitted task snapshots and parameters are deeply frozen. A short simulated outage recovers only that target's channel. A same-name replacement receives a new UID and generation, retires the old target, and interrupts its running tasks without replaying them.

Connection policies:

- **Selected:** maintain explicitly connected instances; new replicas remain discovered.
- **All:** connect all current replicas and future replacements in the selected application/environment.
- **Discover:** release idle simulated channels; rejected while that scope has running tasks.

The model is deterministic and has no DOM, networking, storage or timers. The UI drives its clock. A browser refresh resets the scenario. Closing the page ends the simulation. **Production background supervision, durable tasks, identity verification and replacement detection are not implemented by this frontend.**

All displayed metrics and observations are fabricated, explicitly marked as examples. No real process, Java runtime, kubeconfig, Kubernetes API or MCP service is contacted. A restrictive Content Security Policy uses `connect-src 'none'`. There are no credentials in the design preview and no API fetch adapter.

## Capability boundary

| Design preview | Runnable gateway today |
| --- | --- |
| Environment/application navigation and dynamic instance list | Static configured local/K8s targets |
| Per-target background-maintenance simulation | Connector WS heartbeat and owned forwarding-process lifecycle |
| Multiple tracked tasks and immutable identity simulation | In-memory jobs, current node/target routing |
| Trace, Watch, Thread, JVM, Memory, OGNL, SC, Profiler result designs | JVM, Memory, Thread, Version, Trace, Watch |
| Local discovery/connection simulation | `jps` scan and optional explicit local Attach |
| Resource lifecycle design | No central ZIP distribution, installer or pairing yet |

New real local Attach retains `arthas.telnetPort=-1`; the design has no interactive Telnet console. This does not prove existing instances have Telnet disabled.

## Build and checks

```sh
python -B scripts/build_preview.py
node --check ui-prototype/app.js
node --check ui-prototype/model.js
node scripts/check_preview.mjs
```

The focused Node checks exercise environment isolation, immutable snapshots, independent reconnect, cancellation, replacement without replay, maintenance policies, idempotent scanning, input validation and bounded task/event retention using a fake clock. Browser review should cover desktop/mobile layouts, environment switching during active tasks, batch diagnosis, cancellation, reconnection and replacement, exact target details, result rendering, navigation, keyboard focus and console errors.

## Browser verification — 2026-11-18

The actual static site was served locally and driven in Chrome. Checks passed for submitting all eight diagnostic forms and rendering their semantic result views; preserving production task identity while switching to staging; separate batch child tasks; cancellation; independent channel recovery; same-name replacement interrupting old tasks; all-replica maintenance; rejecting discovery-only policy with running tasks; idempotent local scans; connection preparation; and placeholder-only MCP configuration.

A navigation regression found during review was fixed: returning from Local → Tasks/MCP/Settings → Cluster now restores a cluster target instead of retaining the local JVM in the result panel. The reverse route also restores the local target. Mobile navigation removes closed offscreen controls from keyboard focus and isolates the open navigation; application tabs support arrow keys. Console checks reported no errors or warnings.

Desktop 1440px, phone 375px/390px and landscape 844px layouts were checked. All five pages fit the viewport without whole-page horizontal scrolling. Mobile prioritizes instance identity, connection state and action; exact node/container details remain in the identity dialog. Reduced-motion settings were exercised. Screenshots are captured from the offline design preview, never from a customer environment. UI checks are not real-JVM, real-cluster or production-resilience acceptance.
