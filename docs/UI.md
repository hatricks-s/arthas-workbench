# Workbench interface

The interface is built around one workflow: connect an execution node → discover/select a JVM → verify its MCP capabilities → diagnose through the Web UI or a shared MCP URL.

## Navigation

- **连接与诊断 / Connections and diagnostics:** local and Kubernetes target search, type filters, execution-node status, MCP verification, local process scanning and explicit Attach, six diagnostic tools, task cancellation and a read-only result viewer.
- **诊断记录 / Session history:** up to 50 calls from the current browser page, with target, time, status and result. This is not persistent audit storage. Refreshing or signing out clears history. Clearing history also removes the displayed per-target results.
- **MCP 接入 / MCP access:** the authenticated user's gateway URL, a placeholder-only client configuration template, transport and authentication guidance, and the currently enabled tool list.
- **资源与助手 / Resources and connector:** current setup guidance plus clearly marked planned capabilities for a one-launch connector, device pairing, central Arthas distribution and Perl transfer.

OGNL, Profiler, class inspection and hot update are visible as planned capabilities. Their buttons open an explanation; they do not submit unsupported diagnostic requests. The six enabled tools are JVM, Memory, Thread, Version, Trace and Watch.

## Connection states

`ready` from the gateway is rendered as **端点可达 / endpoint reachable**, not proof of a verified JVM identity. The current page adds **MCP 已验证 / MCP verified** only after a successful explicit `probe` returns the tool list. Diagnostic actions then respect the reported tools, task support, user scopes and connector availability. Verification is discarded when a target becomes unavailable or offline, when state synchronization fails, after a failed diagnostic operation, or when Attach starts. Browser-side checks improve feedback; the server remains the authorization boundary.

The current protocol does not report a durable target-generation identity to the browser. A disconnect/reconnect entirely between refreshes may not be visible to the UI; subsequent requests are still subject to server-side connection/session handling. A successful MCP handshake is not a complete proof of PID ownership. Strong JVM identity verification and automatic reuse remain backend work.

The page locks target switching and repeated submissions while an operation is being submitted or running. Failed result polling retries only the GET request; it never replays a diagnostic POST. A failed submission without an HTTP response is shown as an unknown execution outcome. Logout clears page credentials and results, but does not promise to cancel operations already accepted by the server.

## Telnet policy

New local Attach already stages `arthas.telnetPort=-1`. The interface exposes HTTP/MCP tools and a read-only result pane; it has no interactive Telnet terminal. This policy does not stop an existing Arthas or change its listeners. Existing-target Telnet state is not reported and must not be displayed as a verified disabled listener.

## Design and accessibility

Graphite surfaces, a restrained lime action color, compact target rows and a dedicated diagnostic workspace form the default dark theme. A separate light palette is available. Fonts use locally available Aptos/Bahnschrift and Chinese fallbacks, with Cascadia Code/Consolas for identifiers; there are no remote font or icon requests.

The layout adapts from a desktop side navigation and split workspace to a four-entry navigation and stacked workspace on phones. Controls have visible focus states; tabs support arrow/Home/End navigation; native dialogs support Escape and return focus; meaningful controls have labels. Motion respects `prefers-reduced-motion`. Mobile controls use at least 44-pixel touch heights, and the result pane wraps long text.

## Static preview

`docs/preview` is generated from `workbench/static` with `scripts/build_preview.py`. The mock adapter supplies four fictional targets in reachable, unverified, unavailable and offline states. Successful probe and Attach jobs update the mock only on completion; cancellation leaves the state unchanged. Every result is marked `simulated: true`. No JVM, Kubernetes API, real MCP endpoint or resource distribution service is contacted.

The preview intentionally does not simulate unsupported tools as working. Its sample MCP address is not a usable endpoint. The banner and resource status labels should remain visible and honest when extending the design.

## Redesign verification (2026-11-17)

- Static adapter checks cover file/HTTP/HTTPS origins, login, four targets, six tools, scan/Attach, offline refusal, cancellation, recovery, and unknown/external request blocking.
- Browser checks cover probe-before-diagnosis, local and K8s target switching, tool forms, Watch cancellation, explicit Attach confirmation, filters/search, session history, resource explanations and credential-free MCP templates.
- The actual ASGI gateway was launched against the repository's simulated JVM/connector fixtures. Browser calls verified diagnosis, repeated-click suppression, cancellation, logout cleanup, per-user target isolation and Attach-scope restrictions.
- Desktop and 375-pixel mobile layouts, dark/light themes, landscape, reduced motion, and enlarged text were inspected. These checks are not a real-JVM or real-cluster acceptance test.

Screenshots in `docs/images` are captured from the simulated static preview.
