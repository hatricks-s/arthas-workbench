/* Offline Precision Workbench Controller — deterministic model, zero network I/O. */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (val) =>
    String(val ?? "").replace(
      /[&<>"']/g,
      (ch) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[ch],
    );

  const TOOL_META = {
    thread: { label: "线程分析", short: "Thread", needsPattern: false },
    trace: { label: "调用链追踪", short: "Trace", needsPattern: true },
    watch: { label: "方法观测", short: "Watch", needsPattern: true },
    memory: { label: "内存分代", short: "Memory", needsPattern: false },
    profiler: { label: "CPU 火焰采样", short: "Profiler", needsPattern: false },
    jvm: { label: "JVM 运行时", short: "JVM", needsPattern: false },
    ognl: { label: "OGNL 表达式", short: "OGNL", needsPattern: false },
    sc: { label: "类加载检查", short: "SC", needsPattern: false },
  };

  const CHANNEL_META = {
    ready: ["已就绪", "ready"],
    discovered: ["待按需挂载", "discovered"],
    reconnecting: ["自举/重连中", "reconnecting"],
    offline: ["助手离线", "offline"],
    retired: ["已退役", "offline"],
  };

  const TASK_STATUS_META = {
    mounting: ["挂载探针中", "warn"],
    queued: ["排队等待", "muted"],
    running: ["采样执行中", "run"],
    succeeded: ["已完成", "ok"],
    partial: ["部分完成", "warn"],
    cancelled: ["已取消", "muted"],
    interrupted: ["身份变更中断", "crit"],
  };

  const store = window.WorkbenchDemo.createStore();
  const { state } = store;

  let currentView = "workbench";
  let envId = "production";
  let nsFilter = "all";
  let wlFilter = "all";
  let chFilter = "all";
  let groupBy = "workload";
  let stageMode = "diff"; // "diff" | "single"
  let stageTheme = "obsidian";
  let mobilePane = "targets";

  let focusedKey = store.listPods("production")[0]?.key || null;
  const checkedKeys = new Set();
  let dockTool = "trace";
  let singleTool = "trace";

  let activeRunId = "run-0002";
  let activeDiffTaskId = null;
  let ledgerRunId = "run-0002";
  let cmdkIndex = 0;
  let toastTimer = null;

  const fmtTime = (ms) =>
    ms == null
      ? "—"
      : new Intl.DateTimeFormat("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(new Date(ms));

  const currentEnv = () => state.environments.find((e) => e.id === envId);
  const podByKey = (key) => state.pods.find((p) => p.key === key);
  const runById = (id) => state.runs.find((r) => r.id === id);
  const tasksOfRun = (run) =>
    run ? run.taskIds.map((id) => state.tasks.find((t) => t.id === id)).filter(Boolean) : [];

  function toast(msg) {
    const el = $("#toast-bar");
    clearTimeout(toastTimer);
    el.textContent = msg;
    el.hidden = false;
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 3800);
  }

  function filteredPods() {
    const q = ($("#target-search")?.value || "").trim().toLowerCase();
    return store.listPods(envId).filter((p) => {
      if (nsFilter !== "all" && p.namespace !== nsFilter) return false;
      if (wlFilter !== "all" && p.app !== wlFilter) return false;
      if (chFilter !== "all" && p.channel !== chFilter) return false;
      if (q) {
        const hay = `${p.name} ${p.namespace} ${p.workloadName} ${p.node} ${p.podIp} ${p.pid}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function ensureValidFocus() {
    const visible = filteredPods();
    if (!visible.some((p) => p.key === focusedKey)) {
      focusedKey = visible[0]?.key || store.listPods(envId)[0]?.key || null;
    }
  }

  /* ========================
     Render Top Bar & Rail
     ======================== */
  function renderChrome() {
    $$("[data-view]").forEach((btn) => {
      const active = btn.dataset.view === currentView;
      btn.classList.toggle("active", active);
      if (active) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });

    $("#view-workbench").hidden = currentView !== "workbench";
    $("#view-ledger").hidden = currentView !== "ledger";
    $("#view-pipeline").hidden = currentView !== "pipeline";
    $("#bar-scope-strip").hidden = currentView !== "workbench";

    const activeCount = state.runs.filter(
      (r) => store.runSummary(r.id).status === "running",
    ).length;
    const badge = $("#rail-active-runs");
    badge.textContent = String(activeCount);
    badge.hidden = activeCount === 0;

    const env = currentEnv();
    $("#env-select").innerHTML = state.environments
      .map(
        (e) =>
          `<option value="${esc(e.id)}" ${e.id === envId ? "selected" : ""}>${esc(e.name)}</option>`,
      )
      .join("");
    const tierEl = $("#env-tier-badge");
    tierEl.textContent = env.tier;
    tierEl.dataset.tier = env.tier;

    const protoPill = $("#protocol-pill");
    protoPill.classList.toggle("offline", env.online === false);
    $("#protocol-text").textContent = env.protocol;

    const envPods = store.listPods(envId);
    const readyCount = envPods.filter((p) => p.channel === "ready").length;
    $("#ready-ratio").textContent = `${readyCount} / ${envPods.length}`;
    $("#m-target-count").textContent = String(filteredPods().length);

    // Scope dropdowns
    const namespaces = [...new Set(envPods.map((p) => p.namespace).filter(Boolean))];
    $("#ns-filter").innerHTML = [
      `<option value="all">全部 (${namespaces.length})</option>`,
      ...namespaces.map(
        (ns) =>
          `<option value="${esc(ns)}" ${ns === nsFilter ? "selected" : ""}>${esc(ns)}</option>`,
      ),
    ].join("");

    const wlMap = new Map();
    envPods
      .filter((p) => nsFilter === "all" || p.namespace === nsFilter)
      .forEach((p) => {
        if (!wlMap.has(p.app)) {
          wlMap.set(p.app, `${p.workloadName} (${p.namespace})`);
        }
      });
    $("#workload-filter").innerHTML = [
      `<option value="all">全部负载 (${wlMap.size})</option>`,
      ...[...wlMap.entries()].map(
        ([id, label]) =>
          `<option value="${esc(id)}" ${id === wlFilter ? "selected" : ""}>${esc(label)}</option>`,
      ),
    ].join("");

    $("#channel-filter").value = chFilter;
    const hasFilter =
      nsFilter !== "all" ||
      wlFilter !== "all" ||
      chFilter !== "all" ||
      Boolean($("#target-search")?.value.trim());
    $("#reset-filters-btn").hidden = !hasFilter;

    $("#local-scan-btn").hidden = env.kind !== "local";
    $("#local-scan-btn").disabled = env.online === false;
    $("#quick-select-replicas").hidden = env.kind === "local";

    $("#view-workbench").dataset.mobilePane = mobilePane;
    $$("[data-mpane]").forEach((btn) => {
      const yes = btn.dataset.mpane === mobilePane;
      btn.classList.toggle("active", yes);
      btn.setAttribute("aria-selected", String(yes));
    });
  }

  /* ========================
     Render Left Target Matrix & Launch Dock
     ======================== */
  function renderWorkloadStrip() {
    const envPods = store.listPods(envId);
    if (currentEnv().kind === "local") {
      const online = currentEnv().online !== false;
      $("#workload-strip").innerHTML = `
        <span class="wl-pill active">本机进程 (${envPods.length})</span>
        <span class="wl-pill">${online ? "arthas-wb:// 已配对在线" : "设备离线 · 仅保留上次发现快照"}</span>
      `;
      return;
    }

    const groups = new Map();
    for (const p of envPods) {
      const cur = groups.get(p.app) || {
        id: p.app,
        name: p.workloadName,
        ns: p.namespace,
        count: 0,
      };
      cur.count++;
      groups.set(p.app, cur);
    }

    $("#workload-strip").innerHTML = [
      `<button type="button" class="wl-pill ${wlFilter === "all" ? "active" : ""}" data-wl-chip="all">全部目标 <small>${envPods.length}</small></button>`,
      ...[...groups.values()].map(
        (g) =>
          `<button type="button" class="wl-pill ${wlFilter === g.id ? "active" : ""}" data-wl-chip="${esc(g.id)}">${esc(g.name)} <small>${esc(g.ns)}·${g.count}</small></button>`,
      ),
    ].join("");
  }

  function barTone(val) {
    return val >= 75 ? "crit" : val >= 58 ? "warn" : "";
  }

  function shortSuffix(pod) {
    if (pod.kind === "local") return `PID ${pod.pid}`;
    const parts = pod.name.split("-");
    return parts.slice(-2).join("-");
  }

  function renderMatrix() {
    ensureValidFocus();
    renderWorkloadStrip();

    const pods = filteredPods();
    const selectable = pods.filter((p) => p.channel !== "offline");
    const checkAll = $("#check-all");
    checkAll.disabled = selectable.length === 0;
    checkAll.checked =
      selectable.length > 0 && selectable.every((p) => checkedKeys.has(p.key));

    if (!pods.length) {
      $("#target-tbody").innerHTML = `<tr><td colspan="5" class="empty-cell">当前筛选条件下没有匹配的 JVM 目标。</td></tr>`;
      renderDock();
      return;
    }

    const sorted = [...pods];
    if (groupBy !== "none") {
      sorted.sort((a, b) => {
        const ka =
          groupBy === "workload"
            ? `${a.namespace}/${a.workloadName}`
            : groupBy === "namespace"
              ? a.namespace
              : a.node;
        const kb =
          groupBy === "workload"
            ? `${b.namespace}/${b.workloadName}`
            : groupBy === "namespace"
              ? b.namespace
              : b.node;
        return String(ka).localeCompare(String(kb));
      });
    }

    let lastGroup = null;
    const rowsHtml = [];
    for (const pod of sorted) {
      if (groupBy !== "none") {
        const gLabel =
          groupBy === "workload"
            ? `${pod.namespace} / ${pod.workloadName} (${pod.workloadKind})`
            : groupBy === "namespace"
              ? `Namespace: ${pod.namespace}`
              : `Node: ${pod.node}`;
        if (gLabel !== lastGroup) {
          lastGroup = gLabel;
          rowsHtml.push(
            `<tr class="group-row"><td colspan="5">${esc(gLabel)}</td></tr>`,
          );
        }
      }

      const isFocused = pod.key === focusedKey;
      const isChecked = checkedKeys.has(pod.key);
      const [chLabel, chCls] = CHANNEL_META[pod.channel] || [pod.channel, "offline"];
      const mp = store.mountProgress(pod.key);
      const probeSub = mp
        ? `${mp.percent}% · ${mp.stage}`
        : pod.channel === "ready"
          ? `:${pod.arthasPort}/mcp · g${pod.generation}`
          : pod.channel === "discovered"
            ? "点击诊断自动挂载"
            : pod.node;

      const hot = pod.cpuLoad >= 65 || pod.heapPct >= 80;

      rowsHtml.push(`
        <tr class="target-row ${isFocused ? "focused" : ""} ${isChecked ? "checked" : ""}" data-row-key="${esc(pod.key)}">
          <td class="col-check" data-stop-row="1">
            <input type="checkbox" data-check-key="${esc(pod.key)}" ${isChecked ? "checked" : ""} ${pod.channel === "offline" ? "disabled" : ""} aria-label="勾选 ${esc(pod.name)}" />
          </td>
          <td>
            <div class="pod-cell-title">
              <span>${esc(pod.workloadName)}</span>
              <span class="pod-suffix">${esc(shortSuffix(pod))}</span>
              ${hot ? '<span class="hot-badge">HOT</span>' : ""}
            </div>
            <div class="pod-cell-sub">
              <span>${esc(pod.namespace)}</span>
              <span>·</span>
              <span>PID ${pod.pid}</span>
              <span>·</span>
              <span>JDK ${esc(pod.javaVersion)}</span>
            </div>
          </td>
          <td>
            <div class="meter-stack">
              <div class="micro-bar-row">
                <span>CPU</span>
                <span class="micro-track"><svg class="svg-meter" viewBox="0 0 100 5" preserveAspectRatio="none" aria-hidden="true"><rect class="svg-fill ${barTone(pod.cpuLoad)}" width="${pod.cpuLoad}" height="5" /></svg></span>
                <span>${pod.cpuLoad}%</span>
              </div>
              <div class="micro-bar-row">
                <span>Heap</span>
                <span class="micro-track"><svg class="svg-meter" viewBox="0 0 100 5" preserveAspectRatio="none" aria-hidden="true"><rect class="svg-fill ${barTone(pod.heapPct)}" width="${pod.heapPct}" height="5" /></svg></span>
                <span>${pod.heapPct}%</span>
              </div>
            </div>
          </td>
          <td>
            <span class="probe-pill ${chCls}">${esc(chLabel)}</span>
            <span class="probe-sub">${esc(probeSub)}</span>
          </td>
          <td class="col-act" data-stop-row="1">
            <div class="row-actions">
              <button type="button" class="row-icon-btn" data-inspect-single="${esc(pod.key)}" title="在右侧单实例显微镜中打开">
                <svg class="ic xs"><use href="#i-terminal" /></svg>
              </button>
              <button type="button" class="row-icon-btn" data-open-id="${esc(pod.key)}" title="查看 Pod UID / 容器与注入链路指纹">
                <svg class="ic xs"><use href="#i-id" /></svg>
              </button>
            </div>
          </td>
        </tr>
      `);
    }

    $("#target-tbody").innerHTML = rowsHtml.join("");
    renderDock();
  }

  function renderDock() {
    const dock = $("#launch-dock");
    for (const k of [...checkedKeys]) {
      const p = podByKey(k);
      if (!p || p.retired || p.environment !== envId || p.channel === "offline") {
        checkedKeys.delete(k);
      }
    }

    if (checkedKeys.size === 0) {
      dock.hidden = true;
      return;
    }

    dock.hidden = false;
    const selectedPods = [...checkedKeys].map(podByKey).filter(Boolean);
    const needMount = selectedPods.filter((p) => p.channel !== "ready").length;

    $("#dock-count").textContent = `已锁定 ${selectedPods.length} 个 JVM 目标`;
    $("#dock-mount-hint").textContent = needMount
      ? `含 ${needMount} 个待挂载目标 · 自动 HTTP Pull + jattach`
      : "通道全部就绪 · 毫秒级并发下发";

    $("#dock-tools").innerHTML = ["thread", "trace", "watch", "memory", "profiler"]
      .map(
        (t) =>
          `<button type="button" class="dock-tool-btn ${dockTool === t ? "active" : ""}" data-dock-tool="${t}">${TOOL_META[t].short}</button>`,
      )
      .join("");

    $("#dock-params").hidden = !TOOL_META[dockTool].needsPattern;
    $("#dock-fire-label").textContent =
      selectedPods.length > 1
        ? needMount
          ? "一键挂载并对比"
          : "并发采样对比"
        : needMount
          ? "自动挂载并诊断"
          : "立即执行采样";
  }

  /* ========================
     Render Right Obsidian Evidence Stage
     ======================== */
  function renderTaskEvidenceBody(task) {
    if (!task) {
      return `<div class="evidence-card"><div class="evidence-head">暂无选中任务</div></div>`;
    }

    if (task.status === "mounting") {
      const mp = store.mountProgress(task.target.key) || {
        percent: 45,
        stage: "流式注入与 jattach 挂载中",
        stages: [
          "WS v4.channel 握手",
          "内网 HTTP Pull / 流式缓存核验",
          "jattach 零 JVM 挂载 + 随机鉴权",
        ],
        stageIndex: 1,
      };
      return `
        <div class="bootstrap-card">
          <div class="verdict-title"><svg class="ic xs"><use href="#i-bolt" /></svg><span>正在免运维自举挂载探针 · ${esc(task.target.name)} (${mp.percent}%)</span></div>
          <div class="verdict-meta">
            <span>容器真实 PID: ${task.target.pid}</span>
            <span>策略: ${esc(task.target.mountStrategy)}</span>
          </div>
          <div class="step-track">
            ${mp.stages
              .map(
                (st, idx) =>
                  `<div class="step-node ${idx < mp.stageIndex ? "done" : idx === mp.stageIndex ? "active" : ""}">0${idx + 1} · ${esc(st)}</div>`,
              )
              .join("")}
          </div>
        </div>
      `;
    }

    if (task.status === "queued" || task.status === "running") {
      return `
        <div class="bootstrap-card">
          <div class="verdict-title">${task.status === "running" ? "◉ 正在实时采集运行时证据…" : "◌ 并发槽位排队等待中…"}</div>
          <div class="verdict-meta">
            <span>目标: ${esc(task.target.name)}</span>
            <span>UID: ${esc(task.target.podUid)}</span>
            <span>工具: ${esc(task.tool.toUpperCase())}</span>
          </div>
          <div class="mt-sm">
            <button type="button" class="stage-btn" data-cancel-task="${esc(task.id)}">
              <svg class="ic xs"><use href="#i-stop" /></svg>取消该实例采样
            </button>
          </div>
        </div>
      `;
    }

    if (task.status === "interrupted" || task.status === "cancelled" || !task.result) {
      return `
        <div class="evidence-card">
          <div class="evidence-head">
            <strong>${esc(task.target.name)} · 未产出采样结果（不会伪造 0 值）</strong>
            <span>${esc(TASK_STATUS_META[task.status]?.[0] || task.status)}</span>
          </div>
          <div class="stage-note">
            ${
              task.status === "interrupted"
                ? "执行期间检测到目标 Pod 重建（UID 变更）或超出采样窗口。根据严格身份冻结契约，旧任务已立即终止，绝不在同名新实例上静默重放。"
                : "该目标采样已被用户手动取消，同批次其他已完成副本的证据不受影响。"
            }
          </div>
        </div>
      `;
    }

    const res = task.result;
    let detailHtml = "";

    if (task.tool === "trace" && res.trace) {
      detailHtml = `
        <div class="flame-list">
          ${res.trace
            .map((node) => {
              const tone =
                node.percent >= 55 ? "crit" : node.percent >= 20 ? "warn" : "ok";
              return `
                <div class="flame-row depth-${Math.min(3, node.depth)}">
                  <svg class="flame-bg-svg" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect class="flame-bg-rect ${tone}" width="${Math.max(3, node.percent)}" height="10" /></svg>
                  <span class="flame-sig">${node.depth ? "├─ " : ""}${esc(node.method)}</span>
                  <span class="flame-cost ${tone}">${node.ms} ms (${node.percent}%)</span>
                </div>
              `;
            })
            .join("")}
        </div>
      `;
    } else if (task.tool === "profiler" && res.frames) {
      detailHtml = `
        <div class="flame-list">
          ${res.frames
            .map((f) => {
              const tone =
                f.percent >= 60 ? "crit" : f.percent >= 25 ? "warn" : "ok";
              return `
                <div class="flame-row depth-${Math.min(3, f.depth)}">
                  <svg class="flame-bg-svg" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect class="flame-bg-rect ${tone}" width="${f.percent}" height="10" /></svg>
                  <span class="flame-sig">${esc(f.name)}</span>
                  <span class="flame-cost ${tone}">${f.samples} samples (${f.percent}%)</span>
                </div>
              `;
            })
            .join("")}
        </div>
      `;
    } else if (task.tool === "thread" && res.threads) {
      detailHtml = res.threads
        .map(
          (th) => `
          <div class="thread-block">
            <div class="thread-head">
              <div>
                <span class="state-chip ${esc(th.state)}">${esc(th.state)}</span>
                <strong class="ml-xs">#${th.id} ${esc(th.name)}</strong>
              </div>
              <span class="flame-cost ${th.cpu >= 50 ? "crit" : "ok"}">CPU ${th.cpu}%</span>
            </div>
            ${th.lockInfo ? `<div class="lock-alert"><svg class="ic xs"><use href="#i-alert" /></svg><span>${esc(th.lockInfo)}</span></div>` : ""}
            <ul class="stack-lines">
              ${th.stack.map((line) => `<li>${esc(line)}</li>`).join("")}
            </ul>
          </div>
        `,
        )
        .join("");
    } else if (task.tool === "memory" && res.memory) {
      detailHtml = `
        <div class="flame-list">
          ${res.memory
            .map((m) => {
              const tone =
                m.usage >= 85 ? "crit" : m.usage >= 65 ? "warn" : "ok";
              return `
                <div class="flame-row">
                  <svg class="flame-bg-svg" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect class="flame-bg-rect ${tone}" width="${Math.min(100, m.usage)}" height="10" /></svg>
                  <span class="flame-sig">${esc(m.name)} · 已用 ${esc(m.used)} / 上限 ${esc(m.max)}</span>
                  <span class="flame-cost ${tone}">${m.usage}%</span>
                </div>
              `;
            })
            .join("")}
        </div>
      `;
    } else if (task.tool === "watch" && res.samples) {
      detailHtml = `
        <table class="kv-table">
          <thead><tr><th>采样时间 / 耗时</th><th>入参 / 返回 / 异常</th></tr></thead>
          <tbody>
            ${res.samples
              .map(
                (s) => `
                <tr>
                  <td>${esc(s.time.slice(11, 23))}<br><span class="muted-text">${s.costMs.toFixed(1)} ms</span></td>
                  <td>
                    <div>params: ${esc(s.params)}</div>
                    <div>return: ${esc(s.returnObj)}</div>
                    ${s.throwExp ? `<div class="throw-text">throw: ${esc(s.throwExp)}</div>` : ""}
                  </td>
                </tr>
              `,
              )
              .join("")}
          </tbody>
        </table>
      `;
    } else {
      detailHtml = `
        <table class="kv-table">
          <tbody>
            ${(res.rows || [])
              .map(
                (r) =>
                  `<tr><th>${esc(r.name)}</th><td>${esc(r.value ?? `${r.classLoader} · ${r.codeSource}`)}</td></tr>`,
              )
              .join("")}
          </tbody>
        </table>
      `;
    }

    return `
      <div class="evidence-card">
        <div class="evidence-head">
          <div>
            <strong>${esc(task.target.name)}</strong>
            <span class="evidence-submeta">${esc(task.target.namespace)} · UID ${esc(task.target.podUid)} · 采样于 ${fmtTime(task.finishedAt)}</span>
          </div>
          <span class="flame-cost ${res.anomalous ? "crit" : "ok"}">${esc(res.headlineMetric)}</span>
        </div>
        <div class="evidence-summary-bar">
          ${esc(res.summary)}
        </div>
        ${detailHtml}
      </div>
    `;
  }

  function renderDiffModeHtml(run) {
    if (!run) {
      return `<div class="evidence-card"><div class="stage-note">尚无诊断批次，请在左侧勾选 2~3 个副本点击「并发采样对比」。</div></div>`;
    }

    const summary = store.runSummary(run.id);
    const tasks = tasksOfRun(run);
    if (!tasks.some((t) => t.id === activeDiffTaskId)) {
      // While a run is still in flight, surface whatever is bootstrapping or
      // sampling first, so an auto-mounted replica shows its mount progress
      // instead of silently sitting behind an already-finished sibling.
      const inFlight = tasks.find((t) =>
        ["mounting", "running"].includes(t.status),
      );
      const outlier = tasks.find((t) => t.result?.anomalous);
      activeDiffTaskId = (inFlight || outlier || tasks[0])?.id || null;
    }
    const activeTask = tasks.find((t) => t.id === activeDiffTaskId) || tasks[0];

    const maxMetric = Math.max(
      1,
      ...tasks.map((t) => t.result?.headlineValue || 0),
    );
    const hasOutlier =
      tasks.length > 1 && tasks.some((t) => t.result?.anomalous);

    const recentRuns = [...state.runs].reverse().slice(0, 6);

    return `
      <div class="run-selector-strip" aria-label="最近诊断批次切换">
        ${recentRuns
          .map((r) => {
            const sum = store.runSummary(r.id);
            return `
              <button type="button" class="run-pill ${r.id === run.id ? "active" : ""}" data-pick-run="${esc(r.id)}">
                <span class="src-tag ${r.source === "mcp" ? "mcp" : ""}">${r.source.toUpperCase()}</span>
                <span>${esc(r.title)}</span>
                <small class="pill-ratio">${sum.completed}/${sum.total}</small>
              </button>
            `;
          })
          .join("")}
      </div>

      <div class="verdict-banner ${hasOutlier ? "anomaly" : summary.status === "running" ? "running" : ""}">
        <div>
          <div class="verdict-title">
            <svg class="ic xs"><use href="#i-${hasOutlier ? "alert" : summary.status === "running" ? "bolt" : "check"}" /></svg>
            <span>${esc(summary.verdict)}</span>
          </div>
          <div class="verdict-meta">
            <span>批次 ${esc(run.id)}</span>
            <span>来源: ${esc(run.client)}</span>
            <span>工具: ${esc(run.tool.toUpperCase())}</span>
            <span>并发上限: ${run.concurrency}</span>
            <span>各副本保留独立采样窗口（非严格同步时钟）</span>
          </div>
        </div>
        ${
          summary.status === "running"
            ? `<button type="button" class="stage-btn" data-cancel-run="${esc(run.id)}"><svg class="ic xs"><use href="#i-stop" /></svg>取消剩余</button>`
            : ""
        }
      </div>

      <div class="replica-diff-grid">
        <div class="diff-grid-head">
          <span>副本横向对比轨道（点击任意副本切换下方详细调用栈 / 火焰图）</span>
          <span>完成 ${summary.counts.succeeded} · 运行 ${summary.counts.running + summary.counts.mounting} · 中断 ${summary.counts.interrupted}</span>
        </div>
        ${tasks
          .map((t) => {
            const val = t.result?.headlineValue || 0;
            const isRunning = ["running", "mounting"].includes(t.status);
            const widthPct =
              t.status === "succeeded"
                ? Math.max(8, Math.round((val / maxMetric) * 100))
                : isRunning
                  ? 42
                  : 0;
            const isOutlier = Boolean(t.result?.anomalous);
            const [stLabel] = TASK_STATUS_META[t.status] || [t.status];
            const metricCls = isOutlier
              ? "outlier"
              : t.status === "succeeded"
                ? "ok"
                : "muted";
            const fillCls = isOutlier ? "crit" : isRunning ? "run" : "ok";
            return `
              <div class="replica-lane ${t.id === activeTask?.id ? "active" : ""}" data-pick-task="${esc(t.id)}">
                <div class="lane-top">
                  <div class="lane-name">
                    <span>${esc(t.target.name)}</span>
                    ${isOutlier ? '<span class="hot-badge">偏离基线</span>' : ""}
                  </div>
                  <div class="lane-metric ${metricCls}">
                    ${t.result ? esc(t.result.headlineMetric) : esc(stLabel)}
                  </div>
                </div>
                <div class="lane-bar-wrap">
                  <svg class="svg-meter" viewBox="0 0 100 7" preserveAspectRatio="none" aria-hidden="true"><rect class="svg-fill ${fillCls}" width="${widthPct}" height="7" /></svg>
                </div>
                <div class="lane-foot">
                  <span>${esc(t.target.namespace)} · Node ${esc(t.target.node)} · UID ${esc(t.target.podUid)}</span>
                  <span>${t.startedAt ? `${fmtTime(t.startedAt)} → ${fmtTime(t.finishedAt)}` : stLabel}</span>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>

      ${renderTaskEvidenceBody(activeTask)}
    `;
  }

  function renderSingleModeHtml() {
    const pod = podByKey(focusedKey);
    if (!pod) {
      return `<div class="evidence-card"><div class="stage-note">请在左侧点击任意目标实例。</div></div>`;
    }

    const matchingTasks = state.tasks.filter(
      (t) => t.target.key === pod.key && t.tool === singleTool,
    );
    const latestTask = matchingTasks[matchingTasks.length - 1] || null;
    const needsPattern = TOOL_META[singleTool].needsPattern;

    return `
      <div class="single-toolbar">
        <div class="single-target-bar">
          <div>
            <div class="single-target-id">${esc(pod.name)}</div>
            <div class="verdict-meta">
              <span>${esc(pod.namespace)}</span>
              <span>PID ${pod.pid}</span>
              <span>UID ${esc(pod.podUid)}</span>
              <span>${esc(pod.mountStrategy)}</span>
            </div>
          </div>
          <div class="row-gap-xs">
            <button type="button" class="stage-btn" id="single-replace-btn" title="演练：模拟此 Pod 发生滚动升级重建（UID 变更）">
              模拟重建
            </button>
            <button type="button" class="stage-btn" data-open-id="${esc(pod.key)}">
              身份指纹
            </button>
          </div>
        </div>

        <div class="tool-tabs" role="tablist" aria-label="单实例诊断工具">
          ${Object.entries(TOOL_META)
            .map(
              ([id, meta]) =>
                `<button type="button" class="tool-tab ${singleTool === id ? "active" : ""}" data-single-tool="${id}">${esc(meta.label)}<code>${id}</code></button>`,
            )
            .join("")}
        </div>

        <form class="inline-run-form" id="single-run-form">
          ${
            needsPattern
              ? `
            <input name="classPattern" value="sample.${esc(pod.app === "local" ? "local" : pod.app.replace(/-/g, ""))}.OrderOrchestrator" placeholder="类全限定名 Pattern" aria-label="类匹配" />
            <input name="methodPattern" value="createOrder" placeholder="方法名 Pattern" aria-label="方法匹配" />
          `
              : singleTool === "ognl"
                ? `<input name="expression" value="@org.springframework.boot.SpringApplication@class.getName()" placeholder="只读 OGNL 表达式" aria-label="OGNL 表达式" />`
                : `<span class="inline-hint-muted">${pod.channel === "ready" ? "探针已就绪，点击右侧按钮立即在当前 JVM 采样" : "当前目标尚未挂载，点击执行将自动完成流式注入 + jattach 并采样"}</span>`
          }
          <button class="run-exec-btn" type="submit" ${pod.channel === "offline" ? "disabled" : ""}>
            <svg class="ic xs"><use href="#i-play" /></svg>
            <span>${pod.channel === "ready" ? `运行 ${TOOL_META[singleTool].short}` : `自动挂载并运行 ${TOOL_META[singleTool].short}`}</span>
          </button>
        </form>
      </div>

      ${
        latestTask
          ? renderTaskEvidenceBody(latestTask)
          : `<div class="evidence-card"><div class="stage-note">当前实例尚未运行过 <code>${esc(singleTool)}</code>。点击上方运行按钮即可采集（未挂载实例将自动完成免运维挂载）。</div></div>`
      }
    `;
  }

  function renderStage() {
    const stageEl = $("#pane-stage");
    stageEl.dataset.stageTheme = stageTheme;
    $("#ledger-preview-pane").dataset.stageTheme = stageTheme;

    $("#toggle-stage-theme").innerHTML = `<svg class="ic xs"><use href="#i-${stageTheme === "obsidian" ? "sun" : "moon"}" /></svg>`;

    const run = runById(activeRunId) || state.runs[state.runs.length - 1];
    if (run) activeRunId = run.id;
    $("#diff-run-tag").textContent = run
      ? `${run.targetSnapshots.length} 副本`
      : "0";

    $$("[data-smode]").forEach((btn) => {
      const yes = btn.dataset.smode === stageMode;
      btn.classList.toggle("active", yes);
      btn.setAttribute("aria-selected", String(yes));
    });

    $("#stage-body").innerHTML =
      stageMode === "diff" ? renderDiffModeHtml(run) : renderSingleModeHtml();
  }

  /* ========================
     Render Ledger & Pipeline Views
     ======================== */
  function renderLedger() {
    const q = ($("#ledger-search")?.value || "").trim().toLowerCase();
    const src = $("#ledger-source")?.value || "all";
    const st = $("#ledger-status")?.value || "all";

    const runs = [...state.runs].reverse().filter((r) => {
      const sum = store.runSummary(r.id);
      if (src !== "all" && r.source !== src) return false;
      if (st !== "all" && sum.status !== st) return false;
      if (q) {
        const hay = `${r.id} ${r.title} ${r.tool} ${r.client} ${r.targetSnapshots.map((t) => `${t.name} ${t.namespace}`).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (!runs.some((r) => r.id === ledgerRunId)) {
      ledgerRunId = runs[0]?.id || null;
    }

    $("#ledger-rows").innerHTML = runs.length
      ? runs
          .map((r) => {
            const sum = store.runSummary(r.id);
            const [stText] = TASK_STATUS_META[sum.status] || [sum.status];
            return `
              <div class="ledger-item ${r.id === ledgerRunId ? "active" : ""}" data-ledger-run="${esc(r.id)}">
                <div class="ledger-item-top">
                  <span>${esc(r.title)}</span>
                  <span class="src-tag ${r.source === "mcp" ? "mcp" : ""}">${r.source.toUpperCase()}</span>
                </div>
                <div class="ledger-item-sub">${esc(sum.verdict)}</div>
                <div class="ledger-item-meta">
                  <span>${esc(r.id)}</span>
                  <span>${esc(stText)} (${sum.completed}/${sum.total})</span>
                  <span>${fmtTime(r.createdAt)}</span>
                </div>
              </div>
            `;
          })
          .join("")
      : `<div class="empty-cell">没有匹配的诊断批次记录。</div>`;

    const chosen = runById(ledgerRunId);
    $("#ledger-preview-pane").innerHTML = `
      <header class="stage-header">
        <strong class="mono-cell">${chosen ? `${esc(chosen.id)} · 不可变批次证据快照` : "未选择批次"}</strong>
        ${chosen ? `<button type="button" class="stage-btn" data-jump-workbench="${esc(chosen.id)}">在诊断台中打开</button>` : ""}
      </header>
      <div class="stage-body">${renderDiffModeHtml(chosen)}</div>
    `;
  }

  function renderPipeline() {
    $("#mcp-env-table-wrap").innerHTML = `
      <table class="env-cap-table">
        <thead>
          <tr>
            <th>环境</th>
            <th>底层通道</th>
            <th>就绪 / 总数</th>
            <th>动作</th>
          </tr>
        </thead>
        <tbody>
          ${state.environments
            .map((env) => {
              const pods = store.listPods(env.id);
              const ready = pods.filter((p) => p.channel === "ready").length;
              return `
                <tr>
                  <td><strong>${esc(env.shortName)}</strong><br><small class="ink-muted-sub">${esc(env.cluster || env.device)}</small></td>
                  <td class="mono-cell">${esc(env.protocol)}</td>
                  <td class="mono-bold">${ready} / ${pods.length}</td>
                  <td><button type="button" class="micro-btn" data-switch-env="${esc(env.id)}">进入</button></td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    `;
  }

  function renderAll() {
    renderChrome();
    if (currentView === "workbench") {
      renderMatrix();
      renderStage();
    } else if (currentView === "ledger") {
      renderLedger();
    } else {
      renderPipeline();
    }
  }

  /* ========================
     Modals & Command Palette
     ======================== */
  function openModal(eyebrow, title, html) {
    $("#modal-eyebrow").textContent = eyebrow;
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = html;
    const dlg = $("#modal-dialog");
    if (!dlg.open) dlg.showModal();
  }

  function showIdentityModal(key) {
    const pod = podByKey(key);
    if (!pod) return;
    const rows = [
      ["所属环境", currentEnv()?.name || pod.environment],
      ["Namespace", pod.namespace],
      ["工作负载", `${pod.workloadName} (${pod.workloadKind})`],
      ["实例名称", pod.name],
      ["冻结 Pod UID", pod.podUid],
      ["容器实例 ID", pod.containerId || "OS Native Process"],
      ["真实 Java PID", `PID ${pod.pid}（跳过容器 1 号 shell 与 init 容器）`],
      ["JVM 唯一代次", `${pod.jvmIdentity} · g${pod.generation}`],
      ["挂载与传输策略", pod.mountStrategy],
      ["端点安全策略", pod.authMode],
      ["宿主机 Node", pod.node],
    ];
    const initList = (pod.containers || [])
      .map(
        (c) =>
          `<div class="container-topo-item"><strong>${esc(c.name)}</strong><span>${c.role === "init" ? "初始化容器 (completed · 已自动排除目标)" : "业务 Java 容器 (running)"}</span></div>`,
      )
      .join("");

    openModal(
      "IMMUTABLE TARGET IDENTITY",
      pod.name,
      `
        <dl class="id-dl">
          ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}
        </dl>
        ${initList ? `<div class="container-topo-box"><strong>Pod 容器拓扑识别</strong>${initList}</div>` : ""}
      `,
    );
  }

  function showPolicyModal() {
    const env = currentEnv();
    const appId =
      env.kind === "local"
        ? "local"
        : wlFilter !== "all"
          ? wlFilter
          : store.listPods(envId)[0]?.app;
    if (!appId) return;
    const current = state.policies[`${envId}/${appId}`] || "selected";
    openModal(
      "PROBE SUPERVISION POLICY",
      `探针维护策略 · ${appId}`,
      `
        <p class="modal-lead">策略仅作用于当前环境下的指定工作负载，绝不会跨 Namespace 误伤同名服务。</p>
        <div class="chaos-actions">
          ${[
            ["selected", "按需维护已挂载副本（推荐）", "发现新 Pod 不自动注入；用户发起诊断时自动完成流式挂载并保持心跳。"],
            ["all", "全副本自动预热挂载", "当前及未来滚动扩容的新副本自动后台预挂载探针（旧任务仍不重放）。"],
            ["discover", "仅发现清单，释放空闲探针", "释放当前无活动任务的通道；若有运行中任务将原子拒绝。"],
          ]
            .map(
              ([val, title, desc]) => `
              <button type="button" class="chaos-btn ${current === val ? "selected" : ""}" data-apply-policy="${val}" data-policy-app="${esc(appId)}">
                <strong>${current === val ? "✓ " : ""}${esc(title)}</strong>
                <span>${esc(desc)}</span>
              </button>
            `,
            )
            .join("")}
        </div>
      `,
    );
  }

  function showChaosModal() {
    openModal(
      "RESILIENCE & CHAOS DRILLS",
      "运行时韧性与边界演练",
      `
        <div class="chaos-actions">
          <button type="button" class="chaos-btn" data-chaos="auto-mount-diff">
            <strong><svg class="ic xs"><use href="#i-bolt" /></svg>演练 1：包含「未挂载副本」的一键自举并发对比</strong>
            <span>同时锁定已就绪副本与待挂载副本（00006），演示零手工干预自动流式挂载 + 接续采样对比。</span>
          </button>
          <button type="button" class="chaos-btn" data-chaos="pod-replace">
            <strong><svg class="ic xs"><use href="#i-refresh" /></svg>演练 2：采样途中 Pod 滚动重建（UID 变化绝不重放）</strong>
            <span>对 3 个副本发起并发采样，随后立即触发 00002 重建为 g2，验证仅该子任务中断、不误打新容器。</span>
          </button>
          <button type="button" class="chaos-btn" data-chaos="ws-flap">
            <strong><svg class="ic xs"><use href="#i-link" /></svg>演练 3：K8s WebSocket 隧道闪断自愈</strong>
            <span>模拟当前聚焦实例 WS 通道断开并在 4 秒后无进程自动重连恢复。</span>
          </button>
        </div>
      `,
    );
  }

  /* Command Palette */
  function buildCmdkItems() {
    return [
      {
        label: "并发对比：order-service 前 3 个副本跑 Trace 调用链差分",
        hint: "Replica Diff",
        run: () => {
          changeEnv("production");
          const keys = store
            .listPods("production", "orders")
            .slice(0, 3)
            .map((p) => p.key);
          launchBatch(keys, "trace", {
            classPattern: "sample.orders.OrderOrchestrator",
            methodPattern: "createOrder",
          });
        },
      },
      {
        label: "一键自举：勾选含未挂载副本 (00006) 自动注入并抓 Thread",
        hint: "Auto-Mount",
        run: () => runChaos("auto-mount-diff"),
      },
      {
        label: "演练：采样途中触发 Pod 同名重建（验证 UID 隔离不重放）",
        hint: "Resilience",
        run: () => runChaos("pod-replace"),
      },
      {
        label: "切换环境：计算集群 · flink-engine（纯 JRE 无 tools.jar 场景）",
        hint: "DATA Cluster",
        run: () => changeEnv("flink"),
      },
      {
        label: "切换环境：我的开发机 · dev-workstation 并执行 hsperfdata 扫描",
        hint: "Local JVM",
        run: () => {
          changeEnv("local");
          store.scanLocal("local");
          toast("已完成本机 hsperfdata 10ms 扫描，发现新进程 PID 31240");
          renderAll();
        },
      },
      {
        label: "切换证据舱画布主题（深曜石暗色 / 冷白亮色）",
        hint: "Theme",
        run: () => {
          stageTheme = stageTheme === "obsidian" ? "light" : "obsidian";
          renderAll();
        },
      },
      {
        label: "查看免运维三级注入链路与统一 MCP 配置",
        hint: "Architecture",
        run: () => {
          currentView = "pipeline";
          renderAll();
        },
      },
    ];
  }

  function renderCmdk() {
    const q = ($("#cmdk-input")?.value || "").trim().toLowerCase();
    const items = buildCmdkItems().filter(
      (it) => !q || `${it.label} ${it.hint}`.toLowerCase().includes(q),
    );
    cmdkIndex = Math.min(cmdkIndex, Math.max(0, items.length - 1));
    $("#cmdk-list").innerHTML = items.length
      ? items
          .map(
            (it, idx) => `
            <button type="button" class="cmdk-item ${idx === cmdkIndex ? "active" : ""}" data-cmdk-idx="${idx}">
              <span>${esc(it.label)}</span>
              <small>${esc(it.hint)}</small>
            </button>
          `,
          )
          .join("")
      : `<div class="stage-note">无匹配命令</div>`;
    return items;
  }

  function openCmdk() {
    const dlg = $("#cmdk-dialog");
    $("#cmdk-input").value = "";
    cmdkIndex = 0;
    renderCmdk();
    if (!dlg.open) dlg.showModal();
    $("#cmdk-input").focus();
  }

  /* ========================
     Core Actions & Chaos Drills
     ======================== */
  function changeEnv(nextId) {
    if (!state.environments.some((e) => e.id === nextId)) return;
    envId = nextId;
    nsFilter = "all";
    wlFilter = "all";
    chFilter = "all";
    checkedKeys.clear();
    if ($("#target-search")) $("#target-search").value = "";
    focusedKey = store.listPods(envId)[0]?.key || null;
    currentView = "workbench";
    renderAll();
  }

  function launchBatch(keys, tool, params = {}, extraOptions = {}) {
    try {
      const run = store.startRun(keys, tool, params, {
        autoMount: true,
        concurrency: 2,
        ...extraOptions,
      });
      activeRunId = run.id;
      const launched = run.taskIds
        .map((id) => state.tasks.find((task) => task.id === id))
        .filter(Boolean);
      activeDiffTaskId =
        launched.find((task) => task.status === "mounting")?.id ||
        launched[0]?.id ||
        null;
      ledgerRunId = run.id;
      stageMode = "diff";
      mobilePane = "stage";
      currentView = "workbench";
      checkedKeys.clear();
      renderAll();
      toast(`已提交批次 ${run.id}（锁定 ${keys.length} 个 JVM 快照）`);
      return run;
    } catch (err) {
      toast(err.message || String(err));
      return null;
    }
  }

  function fireFromDock() {
    const keys = [...checkedKeys];
    if (!keys.length) return;
    const args = TOOL_META[dockTool].needsPattern
      ? {
          classPattern: $("#dock-class").value.trim(),
          methodPattern: $("#dock-method").value.trim(),
        }
      : {};
    launchBatch(keys, dockTool, args);
  }

  function runChaos(kind) {
    $("#modal-dialog").close();
    if (kind === "auto-mount-diff") {
      changeEnv("production");
      const orders = store.listPods("production", "orders");
      const pick = [orders[0], orders[1], orders[orders.length - 1]].filter(Boolean);
      launchBatch(
        pick.map((p) => p.key),
        "thread",
        {},
        { title: "一键自举挂载 + 三副本线程差分" },
      );
    } else if (kind === "pod-replace") {
      changeEnv("production");
      const orders = store.listPods("production", "orders").slice(0, 3);
      const run = launchBatch(
        orders.map((p) => p.key),
        "trace",
        {
          classPattern: "sample.orders.OrderOrchestrator",
          methodPattern: "createOrder",
        },
        { concurrency: 1, title: "重建中断演练 · createOrder" },
      );
      if (run) {
        const replaced = store.replacePod(orders[1].key);
        focusedKey = replaced.key;
        renderAll();
        toast(`已模拟 ${orders[1].name} 重建为 g${replaced.generation}，旧排队任务已安全中断`);
      }
    } else if (kind === "ws-flap") {
      const pod = podByKey(focusedKey) || store.listPods("production")[0];
      if (pod) {
        if (!pod.managed) store.connect(pod.key);
        else store.disconnect(pod.key);
        renderAll();
        toast(`已触发 ${pod.name} 通道闪断重连模拟`);
      }
    }
  }

  function syncUrlHash() {
    const hash = location.hash.replace(/^#/, "");
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const v = params.get("view");
    if (v && ["workbench", "ledger", "pipeline"].includes(v)) {
      currentView = v;
    }
    const envParam = params.get("env");
    if (envParam && state.environments.some((e) => e.id === envParam)) {
      envId = envParam;
      focusedKey = store.listPods(envId)[0]?.key || null;
    }
    const rId = params.get("run");
    const tId = params.get("task");
    if (rId && runById(rId)) {
      activeRunId = rId;
      ledgerRunId = rId;
      stageMode = "diff";
      if (tId) activeDiffTaskId = tId;
    }
    if (params.get("dock") === "demo") {
      wlFilter = "orders";
      const orders = store.listPods("production", "orders");
      [orders[0], orders[1], orders[5]].filter(Boolean).forEach((p) => checkedKeys.add(p.key));
    }
    if (params.get("mpane") === "stage") {
      mobilePane = "stage";
    }
  }

  /* ========================
     Event Delegation & Shortcuts
     ======================== */
  document.addEventListener("click", (ev) => {
    const viewBtn = ev.target.closest("[data-view]");
    if (viewBtn) {
      currentView = viewBtn.dataset.view;
      renderAll();
      return;
    }

    const mpBtn = ev.target.closest("[data-mpane]");
    if (mpBtn) {
      mobilePane = mpBtn.dataset.mpane;
      renderChrome();
      return;
    }

    const wlChip = ev.target.closest("[data-wl-chip]");
    if (wlChip) {
      wlFilter = wlChip.dataset.wlChip;
      checkedKeys.clear();
      renderAll();
      return;
    }

    const openIdBtn = ev.target.closest("[data-open-id]");
    if (openIdBtn) {
      showIdentityModal(openIdBtn.dataset.openId);
      return;
    }

    const singleInspectBtn = ev.target.closest("[data-inspect-single]");
    if (singleInspectBtn) {
      focusedKey = singleInspectBtn.dataset.inspectSingle;
      stageMode = "single";
      mobilePane = "stage";
      renderAll();
      return;
    }

    const row = ev.target.closest("[data-row-key]");
    if (row && !ev.target.closest("[data-stop-row]")) {
      focusedKey = row.dataset.rowKey;
      renderMatrix();
      if (stageMode === "single") renderStage();
      return;
    }

    const dockToolBtn = ev.target.closest("[data-dock-tool]");
    if (dockToolBtn) {
      dockTool = dockToolBtn.dataset.dockTool;
      renderDock();
      return;
    }

    const smodeBtn = ev.target.closest("[data-smode]");
    if (smodeBtn) {
      stageMode = smodeBtn.dataset.smode;
      renderStage();
      return;
    }

    const pickRunBtn = ev.target.closest("[data-pick-run]");
    if (pickRunBtn) {
      activeRunId = pickRunBtn.dataset.pickRun;
      activeDiffTaskId = null;
      renderStage();
      return;
    }

    const pickTaskEl = ev.target.closest("[data-pick-task]");
    if (pickTaskEl) {
      activeDiffTaskId = pickTaskEl.dataset.pickTask;
      renderStage();
      if (currentView === "ledger") renderLedger();
      return;
    }

    const singleToolBtn = ev.target.closest("[data-single-tool]");
    if (singleToolBtn) {
      singleTool = singleToolBtn.dataset.singleTool;
      renderStage();
      return;
    }

    const cancelTaskBtn = ev.target.closest("[data-cancel-task]");
    if (cancelTaskBtn) {
      store.cancelTask(cancelTaskBtn.dataset.cancelTask);
      renderAll();
      toast("已取消该子任务，其余已完成副本结果保留");
      return;
    }

    const cancelRunBtn = ev.target.closest("[data-cancel-run]");
    if (cancelRunBtn) {
      store.cancelRun(cancelRunBtn.dataset.cancelRun);
      renderAll();
      toast("已取消批次中剩余未完成任务");
      return;
    }

    const ledgerItem = ev.target.closest("[data-ledger-run]");
    if (ledgerItem) {
      ledgerRunId = ledgerItem.dataset.ledgerRun;
      activeRunId = ledgerRunId;
      activeDiffTaskId = null;
      renderLedger();
      return;
    }

    const jumpBtn = ev.target.closest("[data-jump-workbench]");
    if (jumpBtn) {
      activeRunId = jumpBtn.dataset.jumpWorkbench;
      stageMode = "diff";
      currentView = "workbench";
      renderAll();
      return;
    }

    const switchEnvBtn = ev.target.closest("[data-switch-env]");
    if (switchEnvBtn) {
      changeEnv(switchEnvBtn.dataset.switchEnv);
      return;
    }

    const policyChoice = ev.target.closest("[data-apply-policy]");
    if (policyChoice) {
      try {
        store.setPolicy(
          envId,
          policyChoice.dataset.policyApp,
          policyChoice.dataset.applyPolicy,
        );
        $("#modal-dialog").close();
        renderAll();
        toast("工作负载探针维护策略已更新");
      } catch (err) {
        toast(err.message);
      }
      return;
    }

    const chaosBtn = ev.target.closest("[data-chaos]");
    if (chaosBtn) {
      runChaos(chaosBtn.dataset.chaos);
      return;
    }

    const cmdkBtn = ev.target.closest("[data-cmdk-idx]");
    if (cmdkBtn) {
      const items = renderCmdk();
      const item = items[Number(cmdkBtn.dataset.cmdkIdx)];
      $("#cmdk-dialog").close();
      if (item) item.run();
      return;
    }

    if (ev.target.id === "single-replace-btn") {
      try {
        const next = store.replacePod(focusedKey);
        focusedKey = next.key;
        renderAll();
        toast(`已模拟 Pod 重建，生成新 UID (${next.podUid})`);
      } catch (err) {
        toast(err.message);
      }
    }
  });

  document.addEventListener("change", (ev) => {
    if (ev.target.id === "env-select") {
      changeEnv(ev.target.value);
    } else if (ev.target.id === "ns-filter") {
      nsFilter = ev.target.value;
      wlFilter = "all";
      checkedKeys.clear();
      renderAll();
    } else if (ev.target.id === "workload-filter") {
      wlFilter = ev.target.value;
      checkedKeys.clear();
      renderAll();
    } else if (ev.target.id === "channel-filter") {
      chFilter = ev.target.value;
      checkedKeys.clear();
      renderAll();
    } else if (ev.target.id === "group-by-select") {
      groupBy = ev.target.value;
      renderMatrix();
    } else if (ev.target.id === "check-all") {
      const selectable = filteredPods().filter((p) => p.channel !== "offline");
      if (ev.target.checked) selectable.forEach((p) => checkedKeys.add(p.key));
      else selectable.forEach((p) => checkedKeys.delete(p.key));
      renderMatrix();
    } else if (ev.target.dataset.checkKey) {
      const k = ev.target.dataset.checkKey;
      if (ev.target.checked) checkedKeys.add(k);
      else checkedKeys.delete(k);
      renderMatrix();
    } else if (
      ev.target.id === "ledger-source" ||
      ev.target.id === "ledger-status"
    ) {
      renderLedger();
    }
  });

  document.addEventListener("input", (ev) => {
    if (ev.target.id === "target-search") {
      renderChrome();
      renderMatrix();
    } else if (ev.target.id === "ledger-search") {
      renderLedger();
    } else if (ev.target.id === "cmdk-input") {
      cmdkIndex = 0;
      renderCmdk();
    }
  });

  document.addEventListener("submit", (ev) => {
    if (ev.target.id === "single-run-form") {
      ev.preventDefault();
      const pod = podByKey(focusedKey);
      if (!pod) return;
      const fd = new FormData(ev.target);
      const args = {};
      if (TOOL_META[singleTool].needsPattern) {
        args.classPattern = String(fd.get("classPattern") || "").trim();
        args.methodPattern = String(fd.get("methodPattern") || "").trim();
      } else if (singleTool === "ognl") {
        args.expression = String(fd.get("expression") || "").trim();
      }
      try {
        const run = store.startRun([pod.key], singleTool, args, {
          autoMount: true,
          title: `${singleTool.toUpperCase()} · ${pod.name}`,
        });
        activeRunId = run.id;
        ledgerRunId = run.id;
        renderAll();
        toast(`已向 ${pod.name} 提交 ${TOOL_META[singleTool].label}`);
      } catch (err) {
        toast(err.message);
      }
    }
  });

  $("#brand-home").addEventListener("click", () => {
    currentView = "workbench";
    renderAll();
  });

  $("#reset-filters-btn").addEventListener("click", () => {
    nsFilter = "all";
    wlFilter = "all";
    chFilter = "all";
    $("#target-search").value = "";
    checkedKeys.clear();
    renderAll();
  });

  $("#quick-select-replicas").addEventListener("click", () => {
    const candidates = filteredPods().filter((p) => p.channel !== "offline");
    checkedKeys.clear();
    candidates.slice(0, 3).forEach((p) => checkedKeys.add(p.key));
    dockTool = "trace";
    renderMatrix();
    toast(`已快速锁定 ${checkedKeys.size} 个副本，按 ⌘↵ 或点右下按钮即可对比`);
  });

  $("#local-scan-btn").addEventListener("click", () => {
    try {
      store.scanLocal(envId);
      renderAll();
      toast("本机 hsperfdata 扫描完成：10ms 发现新增进程 PID 31240 (:8085)");
    } catch (err) {
      toast(err.message);
    }
  });

  $("#policy-btn").addEventListener("click", showPolicyModal);
  $("#open-chaos-btn").addEventListener("click", showChaosModal);
  $("#dock-clear").addEventListener("click", () => {
    checkedKeys.clear();
    renderMatrix();
  });
  $("#dock-fire-btn").addEventListener("click", fireFromDock);

  $("#toggle-stage-theme").addEventListener("click", () => {
    stageTheme = stageTheme === "obsidian" ? "light" : "obsidian";
    renderAll();
  });

  $("#copy-Permalink-btn").addEventListener("click", async () => {
    const hash = `#run=${encodeURIComponent(activeRunId || "")}&task=${encodeURIComponent(activeDiffTaskId || "")}`;
    history.replaceState(null, "", hash);
    const full = `${location.origin}${location.pathname}${hash}`;
    try {
      await navigator.clipboard.writeText(full);
    } catch {
      /* ignore clipboard restrictions in headless contexts */
    }
    toast(`已固定并复制证据快照链接：${hash}`);
  });

  $("#copy-mcp-json").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#mcp-json-code").textContent);
    } catch {
      /* ignore */
    }
    toast("已复制 Streamable HTTP MCP 客户端配置");
  });

  $("#trigger-mcp-batch-demo").addEventListener("click", () => {
    changeEnv("production");
    const orders = store.listPods("production", "orders");
    const keys = [orders[0].key, orders[1].key, orders[5].key];
    launchBatch(
      keys,
      "thread",
      {},
      {
        source: "mcp",
        client: "Claude Code MCP",
        title: "MCP 多副本并发抓线程 (含自动挂载)",
      },
    );
  });

  $("#cmdk-trigger").addEventListener("click", openCmdk);
  $("#open-cmdk-rail").addEventListener("click", openCmdk);
  $("#modal-close").addEventListener("click", () => $("#modal-dialog").close());
  $("#modal-dialog").addEventListener("click", (ev) => {
    if (ev.target === $("#modal-dialog")) $("#modal-dialog").close();
  });
  $("#cmdk-dialog").addEventListener("click", (ev) => {
    if (ev.target === $("#cmdk-dialog")) $("#cmdk-dialog").close();
  });

  document.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      openCmdk();
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter" && checkedKeys.size > 0) {
      ev.preventDefault();
      fireFromDock();
      return;
    }
    if ($("#cmdk-dialog").open) {
      const items = renderCmdk();
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        cmdkIndex = (cmdkIndex + 1) % Math.max(1, items.length);
        renderCmdk();
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        cmdkIndex = (cmdkIndex - 1 + items.length) % Math.max(1, items.length);
        renderCmdk();
      } else if (ev.key === "Enter" && items[cmdkIndex]) {
        ev.preventDefault();
        const chosen = items[cmdkIndex];
        $("#cmdk-dialog").close();
        chosen.run();
      }
    }
  });

  /* Split Pane Drag Resizer */
  const resizer = $("#split-resizer");
  let dragging = false;
  resizer.addEventListener("pointerdown", (ev) => {
    dragging = true;
    resizer.setPointerCapture(ev.pointerId);
  });
  resizer.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const shellRect = $("#view-workbench").getBoundingClientRect();
    const pct = ((ev.clientX - shellRect.left) / shellRect.width) * 100;
    const steps = [36, 40, 44, 47, 52, 56, 60];
    const nearest = steps.reduce((a, b) =>
      Math.abs(b - pct) < Math.abs(a - pct) ? b : a,
    );
    $("#view-workbench").dataset.split = String(nearest);
  });
  resizer.addEventListener("pointerup", () => {
    dragging = false;
  });
  resizer.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    const steps = [36, 40, 44, 47, 52, 56, 60];
    const shell = $("#view-workbench");
    const current = Number(shell.dataset.split) || 47;
    const index = steps.indexOf(current);
    const next =
      steps[
        Math.min(
          steps.length - 1,
          Math.max(0, (index < 0 ? 3 : index) + (ev.key === "ArrowRight" ? 1 : -1)),
        )
      ];
    shell.dataset.split = String(next);
  });

  /* Deterministic UI Tick Loop */
  let prevSig = "";
  function computeSig() {
    return JSON.stringify([
      state.pods.map((p) => [p.key, p.channel, p.retired]),
      state.tasks.map((t) => [t.id, t.status]),
       [...connectionsBucket()],
    ]);
  }
  function connectionsBucket() {
    return state.pods
      .filter((p) => p.channel === "reconnecting")
      .map((p) => store.mountProgress(p.key)?.percent ?? -1);
  }

  setInterval(() => {
    store.tick();
    const nextSig = computeSig();
    if (nextSig !== prevSig) {
      prevSig = nextSig;
      renderAll();
    }
  }, 350);

  // Shared evidence links and browser back/forward keep working inside one tab:
  // a fragment change alone does not reload the document, so re-apply the hash.
  window.addEventListener("hashchange", () => {
    syncUrlHash();
    renderAll();
  });

  syncUrlHash();
  renderAll();
})();
