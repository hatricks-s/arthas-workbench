/* Offline workbench controller — deterministic model, no network, no inline styles. */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);

  const TOOLS = {
    thread: { label: "线程快照", args: "none" },
    trace: { label: "调用链追踪", args: "pattern" },
    watch: { label: "方法观测", args: "pattern" },
    memory: { label: "内存分代", args: "none" },
    profiler: { label: "CPU 采样", args: "none" },
    jvm: { label: "JVM 信息", args: "none" },
    ognl: { label: "OGNL 表达式", args: "expression" },
    sc: { label: "类加载检查", args: "none" },
  };

  const TASK_LABEL = {
    mounting: "注入中",
    queued: "排队中",
    running: "采样中",
    succeeded: "已完成",
    cancelled: "已取消",
    interrupted: "已中断",
  };

  const store = window.WorkbenchDemo.createStore();
  const state = store.state;

  let view = "workbench";
  let envId = "production";
  let nsFilter = "all";
  let query = "";
  let focusedKey = store.listPods("production")[0]?.key || null;
  const selected = new Set();
  let tool = "trace";

  let activeRunId = "run-0002";
  let activeTaskId = null;
  let ledgerRunId = "run-0002";
  let paletteIndex = 0;
  let toastTimer = null;

  const clk = (ms) =>
    ms == null
      ? "—"
      : new Intl.DateTimeFormat("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(new Date(ms));

  const env = () => state.environments.find((e) => e.id === envId);
  const podOf = (k) => state.pods.find((p) => p.key === k);
  const runOf = (id) => state.runs.find((r) => r.id === id);
  const tasksOf = (run) =>
    run
      ? run.taskIds.map((id) => state.tasks.find((t) => t.id === id)).filter(Boolean)
      : [];

  function toast(msg) {
    const el = $("#toast");
    clearTimeout(toastTimer);
    el.textContent = msg;
    el.hidden = false;
    toastTimer = setTimeout(() => (el.hidden = true), 3200);
  }

  /* ---------------------------- list ---------------------------- */

  function visiblePods() {
    const q = query.trim().toLowerCase();
    return store.listPods(envId).filter((p) => {
      if (nsFilter !== "all" && p.namespace !== nsFilter) return false;
      if (q && !`${p.name} ${p.workloadName} ${p.namespace} ${p.node} ${p.pid}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }

  function groupOf(p) {
    return `${p.namespace}/${p.app}`;
  }

  function renderList() {
    const pods = visiblePods();
    $("#target-count").textContent = String(pods.length);

    if (!pods.some((p) => p.key === focusedKey)) {
      focusedKey = pods[0]?.key || null;
    }

    const namespaces = [...new Set(store.listPods(envId).map((p) => p.namespace))];
    $("#ns-select").innerHTML = [
      `<option value="all">全部 Namespace</option>`,
      ...namespaces.map(
        (n) => `<option value="${esc(n)}" ${n === nsFilter ? "selected" : ""}>${esc(n)}</option>`,
      ),
    ].join("");

    if (!pods.length) {
      $("#list").innerHTML = `<p class="empty">没有匹配的目标</p>`;
      renderFoot();
      return;
    }

    const sorted = [...pods].sort((a, b) =>
      groupOf(a).localeCompare(groupOf(b)) || a.name.localeCompare(b.name),
    );

    let last = null;
    const html = [];
    for (const p of sorted) {
      if (groupOf(p) !== last) {
        last = groupOf(p);
        const n = store.listPods(envId, p.app).length;
        html.push(
          `<div class="group"><strong>${esc(p.workloadName)}</strong> <span>${esc(p.namespace)} · ${n}</span></div>`,
        );
      }
      const st =
        p.channel === "ready"
          ? "ready"
          : p.channel === "discovered"
            ? "discovered"
            : p.channel === "offline"
              ? "offline"
              : "mounting";
      const label =
        p.channel === "ready"
          ? "就绪"
          : p.channel === "discovered"
            ? "待注入"
            : p.channel === "offline"
              ? "离线"
              : "注入中";
      const hot = p.cpuLoad >= 65 || p.heapPct >= 80;
      const suffix =
        p.kind === "local" ? `pid ${p.pid}` : p.name.split("-").slice(-1).join("-") || p.name;

      html.push(`
        <div class="row ${p.key === focusedKey ? "focused" : ""} ${selected.has(p.key) ? "checked" : ""}"
             data-key="${esc(p.key)}" role="option" aria-selected="${selected.has(p.key)}" tabindex="0"
             title="${esc(p.name)}">
          <input type="checkbox" ${selected.has(p.key) ? "checked" : ""}
                 ${p.channel === "offline" ? "disabled" : ""}
                 aria-label="选择 ${esc(p.name)}" data-check="${esc(p.key)}" />
          <div class="row-main">
            <span class="row-id">${esc(suffix)}</span>
            ${p.generation > 1 ? `<span class="row-gen">g${p.generation}</span>` : ""}
          </div>
          <span class="row-state"><i class="dot ${st}"></i>${esc(label)}</span>
          <span class="row-metric ${hot ? "hot" : ""}">${p.cpuLoad}%</span>
        </div>
      `);
    }

    $("#list").innerHTML = html.join("");
    renderFoot();
  }

  function renderFoot() {
    const pods = visiblePods();
    const ready = pods.filter((p) => p.channel === "ready").length;
    const pending = pods.filter((p) => p.channel === "discovered").length;
    const parts = [`${ready} 已就绪`];
    if (pending) parts.push(`${pending} 待注入`);
    const run = runOf(activeRunId);
    if (run) {
      const s = store.runSummary(run.id);
      parts.push(`当前批次 ${s.completed}/${s.total}`);
    }
    $("#list-foot").textContent = parts.join(" · ");
  }

  /* -------------------------- header/rail ------------------------- */

  function renderChrome() {
    const e = env();
    $("#tier").textContent = e.tier;
    $("#tier").dataset.tier = e.tier;
    $("#env-select").innerHTML = state.environments
      .map(
        (x) => `<option value="${esc(x.id)}" ${x.id === envId ? "selected" : ""}>${esc(x.shortName)}</option>`,
      )
      .join("");

    $$(".rail-btn[data-view]").forEach((b) => {
      if (b.dataset.view === view) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });

    $("#view-workbench").hidden = view !== "workbench";
    $("#view-ledger").hidden = view !== "ledger";
    $("#view-pipeline").hidden = view !== "pipeline";

    const n = selected.size;
    $("#slot-idle").hidden = n > 0;
    $("#slot-action").hidden = n === 0;
    if (n > 0) {
      $("#sel-count").textContent = `已选 ${n} 个`;
      const args = TOOLS[tool].args;
      $("#arg-class").hidden = args === "none";
      $("#arg-method").hidden = args !== "pattern";
      if (args === "expression") {
        $("#arg-class").value = "@org.springframework.boot.SpringApplication@class.getName()";
      } else if (args === "pattern") {
        $("#arg-class").value =
          $("#arg-class").value.startsWith("@")
            ? "sample.orders.OrderOrchestrator"
            : $("#arg-class").value;
      }
    }
  }

  /* --------------------------- evidence --------------------------- */

  function summaryLine(run) {
    const s = store.runSummary(run.id);
    const bad = s.status === "partial" || s.status === "interrupted" || s.verdict.includes("异常");
    return { text: s.verdict, tone: bad ? "bad" : s.status === "running" ? "" : "ok" };
  }

  function laneMarkup(task, max) {
    const r = task.result;
    const val = r?.headlineValue || 0;
    const width = r ? Math.max(6, Math.round((val / max) * 100)) : 0;
    const pending = ["mounting", "queued", "running"].includes(task.status);
    const tone = r?.anomalous ? "bad" : pending ? "pending" : "";
    const valueClass = r ? (r.anomalous ? "bad" : "ok") : "muted";
    const label = r ? r.headlineMetric : TASK_LABEL[task.status] || task.status;
    return `
      <div class="lane ${task.id === activeTaskId ? "active" : ""}" data-task="${esc(task.id)}" role="button" tabindex="0">
        <div class="lane-top">
          <span class="lane-name">${esc(task.target.name)}</span>
          ${r?.anomalous ? '<span class="lane-flag">偏离基线</span>' : ""}
        </div>
        <span class="lane-value ${valueClass}">${esc(label)}</span>
        <div class="lane-track">
          <svg viewBox="0 0 100 2" preserveAspectRatio="none" aria-hidden="true"><rect class="lane-fill ${tone}" width="${width}" height="2" /></svg>
        </div>
      </div>
    `;
  }

  function flameMarkup(rows, kind) {
    return `<div class="flame">${rows
      .map((r) => {
        const pct = kind === "profiler" ? r.percent : r.percent;
        const tone = pct >= 55 ? "bad" : pct >= 20 ? "warn" : "";
        const label = kind === "profiler" ? r.name : r.method;
        const cost =
          kind === "profiler"
            ? `${r.samples} samples · ${pct}%`
            : `${r.ms} ms · ${pct}%`;
        return `
          <div class="flame-row d${Math.min(2, r.depth)}">
            <svg class="fill-svg" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
              <rect class="fill-rect ${tone}" width="${Math.max(2, pct)}" height="10" />
            </svg>
            <span class="sig">${r.depth ? "└ " : ""}${esc(label)}</span>
            <span class="cost ${tone}">${esc(cost)}</span>
          </div>`;
      })
      .join("")}</div>`;
  }

  function threadMarkup(threads) {
    return threads
      .map(
        (t) => `
        <div class="thread">
          <div class="thread-head">
            <span class="state ${esc(t.state)}">${esc(t.state)}</span>
            <span>#${t.id} ${esc(t.name)}</span>
            <span class="cpu">${t.cpu}%</span>
          </div>
          ${t.lockInfo ? `<p class="thread-note">${esc(t.lockInfo)}</p>` : ""}
          <pre class="stack">${t.stack.map((l) => `<span class="frame-arrow">  at </span>${esc(l)}`).join("\n")}</pre>
        </div>`,
      )
      .join("");
  }

  function detailMarkup(task) {
    const t = task.target;
    const r = task.result;

    if (["mounting", "queued", "running"].includes(task.status)) {
      if (task.status === "mounting") {
        const mp = store.mountProgress(t.key);
        const stageIndex = mp?.stageIndex ?? 0;
        const stages = mp?.stages || ["建立通道", "下发运行时", "注入并执行"];
        return `
          <article class="detail">
            <div class="progress">
              <h3>正在注入运行时${mp ? ` · ${mp.percent}%` : ""}</h3>
              <p>${esc(t.name)} · ${esc(t.mountStrategy)}</p>
              <div class="steps-line">
                ${stages
                  .map(
                    (s, i) =>
                      `<span class="step ${i < stageIndex ? "done" : i === stageIndex ? "active" : ""}"><i class="dot"></i>${esc(s)}</span>`,
                  )
                  .join("")}
              </div>
            </div>
          </article>`;
      }
      return `
        <article class="detail">
          <div class="progress">
            <h3>${task.status === "queued" ? "等待并发槽位" : "正在采样"}</h3>
            <p>${esc(t.name)} · ${esc(task.tool.toUpperCase())}${
              task.startedAt ? ` · 开始于 ${clk(task.startedAt)}` : ""
            }</p>
          </div>
        </article>`;
    }

    if (!r || ["interrupted", "cancelled"].includes(task.status)) {
      return `
        <article class="detail">
          <div class="detail-head"><strong>${esc(t.name)}</strong><span>${task.status === "interrupted" ? "已中断" : "已取消"}</span></div>
          <p class="detail-note">${
            task.status === "interrupted"
              ? "目标在采样期间被重建或超出时间窗，任务已终止。不会在新实例上重放。"
              : "该目标已取消，同批其他结果保留。"
          }</p>
        </article>`;
    }

    let body = "";
    if (task.tool === "trace" && r.trace) body = flameMarkup(r.trace, "trace");
    else if (task.tool === "profiler" && r.frames) body = flameMarkup(r.frames, "profiler");
    else if (task.tool === "thread" && r.threads) body = threadMarkup(r.threads);
    else if (task.tool === "memory" && r.memory) {
      body = `<div class="flame">${r.memory
        .map((m) => {
          const tone = m.usage >= 85 ? "bad" : m.usage >= 65 ? "warn" : "";
          return `<div class="flame-row">
            <svg class="fill-svg" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect class="fill-rect ${tone}" width="${Math.min(100, m.usage)}" height="10" /></svg>
            <span class="sig">${esc(m.name)} · ${esc(m.used)} / ${esc(m.max)}</span>
            <span class="cost ${tone}">${m.usage}%</span>
          </div>`;
        })
        .join("")}</div>`;
    } else if (task.tool === "watch" && r.samples) {
      body = `<table class="kv"><tbody>${r.samples
        .map(
          (s) => `<tr><th>${esc(s.time.slice(11, 19))} · ${s.costMs.toFixed(1)} ms</th><td>${esc(
            s.throwExp ? s.throwExp : s.returnObj,
          )}<br />${esc(s.params)}</td></tr>`,
        )
        .join("")}</tbody></table>`;
    } else {
      body = `<table class="kv"><tbody>${(r.rows || [])
        .map((row) => `<tr><th>${esc(row.name)}</th><td>${esc(row.value ?? "")}</td></tr>`)
        .join("")}</tbody></table>`;
    }

    return `
      <article class="detail">
        <div class="detail-head">
          <strong>${esc(t.name)}</strong>
          <span>${esc(t.namespace)} · ${esc(t.podUid)}</span>
          <span class="metric">${esc(r.headlineMetric)}</span>
        </div>
        <p class="detail-note">${esc(r.summary)}</p>
        ${body}
      </article>`;
  }

  function evidenceMarkup(run) {
    if (!run) {
      return `<div class="ev-inner">
        <div class="ev-empty">
          勾选左侧目标后执行诊断，这里会显示各副本的结果对比。<br />
          未注入的目标会在执行时自动完成注入，无需提前操作。
        </div>
      </div>`;
    }

    const tasks = tasksOf(run);
    if (!tasks.some((t) => t.id === activeTaskId)) {
      const inflight = tasks.find((t) => ["mounting", "running"].includes(t.status));
      const bad = tasks.find((t) => t.result?.anomalous);
      activeTaskId = (inflight || bad || tasks[0])?.id || null;
    }
    const active = tasks.find((t) => t.id === activeTaskId) || tasks[0];
    const max = Math.max(1, ...tasks.map((t) => t.result?.headlineValue || 0));
    const v = summaryLine(run);

    return `<div class="ev-inner">
      <header class="ev-head">
        <div>
          <h1>${esc(run.title)}</h1>
          <div class="ev-sub">${esc(run.id)} · ${esc(run.client)} · ${esc(run.tool.toUpperCase())} · ${clk(run.createdAt)}</div>
        </div>
        <div class="ev-actions">
          <button class="ghost-btn back-btn" id="back-btn" type="button">返回列表</button>
          <select class="run-picker" id="run-picker" aria-label="切换批次">
            ${[...state.runs]
              .reverse()
              .slice(0, 12)
              .map(
                (r) =>
                  `<option value="${esc(r.id)}" ${r.id === run.id ? "selected" : ""}>${esc(r.title)}</option>`,
              )
              .join("")}
          </select>
          <button class="ghost-btn" id="copy-link" type="button" aria-label="复制证据链接" title="复制证据链接">
            <svg class="ic sm"><use href="#i-link" /></svg>
          </button>
        </div>
      </header>
      <p class="verdict ${v.tone}"><i class="dot ${v.tone === "bad" ? "mounting" : "ready"}"></i><span>${esc(v.text)}</span><span class="hint">${tasks.length} 个目标</span></p>
      <div class="lanes">${tasks.map((t) => laneMarkup(t, max)).join("")}</div>
      ${active ? detailMarkup(active) : ""}
    </div>`;
  }

  function renderEvidence() {
    $("#evidence").innerHTML = evidenceMarkup(runOf(activeRunId));
  }

  /* ---------------------------- ledger ---------------------------- */

  function renderLedger() {
    const q = ($("#ledger-search")?.value || "").trim().toLowerCase();
    const src = $("#ledger-source")?.value || "all";
    const runs = [...state.runs].reverse().filter((r) => {
      if (src !== "all" && r.source !== src) return false;
      if (!q) return true;
      return `${r.id} ${r.title} ${r.tool} ${r.targetSnapshots.map((t) => t.name).join(" ")}`
        .toLowerCase()
        .includes(q);
    });

    if (!runs.some((r) => r.id === ledgerRunId)) ledgerRunId = runs[0]?.id || null;

    $("#ledger-rows").innerHTML = runs.length
      ? runs
          .map((r) => {
            const s = store.runSummary(r.id);
            return `
              <button class="ledger-row ${r.id === ledgerRunId ? "active" : ""}" data-ledger-run="${esc(r.id)}" type="button">
                <div class="t"><span>${esc(r.title)}</span><span class="src ${r.source === "mcp" ? "mcp" : ""}">${r.source.toUpperCase()}</span></div>
                <div class="s">${clk(r.createdAt)} · ${s.completed}/${s.total} · ${esc(TOOLS[r.tool]?.label || r.tool)}</div>
              </button>`;
          })
          .join("")
      : `<p class="empty">没有匹配的批次</p>`;

    $("#ledger-evidence").innerHTML = evidenceMarkup(runOf(ledgerRunId));
  }

  /* --------------------------- pipeline --------------------------- */

  function renderPipeline() {
    $("#env-rows").innerHTML = state.environments
      .map((e) => {
        const pods = store.listPods(e.id);
        const ready = pods.filter((p) => p.channel === "ready").length;
        return `<tr>
          <td>${esc(e.shortName)}</td>
          <td><code>${esc(e.protocol)}</code></td>
          <td>${ready} / ${pods.length}</td>
          <td><button class="btn-text" data-goto-env="${esc(e.id)}" type="button">打开</button></td>
        </tr>`;
      })
      .join("");
  }

  function renderAll() {
    renderChrome();
    if (view === "workbench") {
      renderList();
      renderEvidence();
    } else if (view === "ledger") {
      renderLedger();
    } else {
      renderPipeline();
    }
  }

  /* ---------------------------- actions ---------------------------- */

  function launch() {
    const keys = [...selected];
    if (!keys.length) return;
    const spec = TOOLS[tool];
    const args = {};
    if (spec.args === "pattern") {
      args.classPattern = $("#arg-class").value.trim();
      args.methodPattern = $("#arg-method").value.trim();
    } else if (spec.args === "expression") {
      args.expression = $("#arg-class").value.trim();
    }
    try {
      const workload = podOf(keys[0])?.workloadName || "目标";
      const run = store.startRun(keys, tool, args, {
        autoMount: true,
        concurrency: 2,
        title: `${TOOLS[tool].label} · ${workload}（${keys.length} 个副本）`,
      });
      activeRunId = run.id;
      ledgerRunId = run.id;
      const tasks = tasksOf(run);
      activeTaskId =
        tasks.find((t) => t.status === "mounting")?.id || tasks[0]?.id || null;
      selected.clear();
      renderAll();
      $(`.lane[data-task="${activeTaskId}"]`)?.scrollIntoView({ block: "nearest" });
      toast(`已提交 ${run.id}，${tasks.length} 个目标`);
    } catch (err) {
      toast(err.message || String(err));
    }
  }

  function focusPod(key) {
    focusedKey = key;
    const task = [...state.tasks].reverse().find((t) => t.target.key === key);
    if (task) {
      activeRunId = task.runId;
      activeTaskId = task.id;
    }
    renderList();
    renderEvidence();
  }

  function openIdentity(key) {
    const p = podOf(key);
    if (!p) return;
    const rows = [
      ["环境", env().name],
      ["Namespace", p.namespace],
      ["工作负载", p.workloadName],
      ["实例", p.name],
      ["Pod UID", p.podUid],
      ["容器实例", p.containerId || "本机进程"],
      ["Java PID", `${p.pid}${p.kind === "k8s" ? "（非 1 号进程）" : ""}`],
      ["JVM 身份", p.jvmIdentity],
      ["注入方式", p.mountStrategy],
      ["端点鉴权", p.authMode],
      ["Node", p.node],
    ];
    $("#sheet-title").textContent = p.name;
    $("#sheet-body").innerHTML = `<dl class="idl">${rows
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
      .join("")}</dl>`;
    $("#sheet").showModal();
  }

  /* ---------------------------- palette ---------------------------- */

  function commands() {
    return [
      {
        label: "对比 order-service 前三个副本的调用链",
        hint: "MCP",
        run: () => {
          setEnv("production");
          const pods = store.listPods("production", "orders").slice(0, 3);
          selected.clear();
          pods.forEach((p) => selected.add(p.key));
          tool = "trace";
          renderAll();
          launch();
        },
      },
      {
        label: "注入并采样一个未挂载的副本",
        hint: "AUTO",
        run: () => {
          setEnv("production");
          const p = store.listPods("production", "orders").find((x) => x.channel === "discovered");
          if (!p) return;
          selected.clear();
          selected.add(p.key);
          tool = "thread";
          renderAll();
          launch();
        },
      },
      {
        label: "模拟采样中 Pod 重建",
        hint: "DRILL",
        run: () => {
          setEnv("production");
          const pods = store.listPods("production", "orders").slice(0, 3);
          selected.clear();
          pods.forEach((p) => selected.add(p.key));
          tool = "trace";
          renderAll();
          launch();
          const replaced = store.replacePod(pods[1].key);
          toast(`已重建 ${pods[1].name} → ${replaced.podUid}`);
          renderAll();
        },
      },
      {
        label: "切换到本机开发机",
        hint: "LOCAL",
        run: () => {
          setEnv("local");
          try {
            store.scanLocal("local");
            toast("已扫描本机 JVM");
          } catch (e) {
            toast(e.message);
          }
          renderAll();
        },
      },
      { label: "查看接入链路与 MCP 配置", hint: "DOC", run: () => { view = "pipeline"; renderAll(); } },
      { label: "打开批次账本", hint: "LEDGER", run: () => { view = "ledger"; renderAll(); } },
    ];
  }

  function renderPalette() {
    const q = $("#palette-input").value.trim().toLowerCase();
    const items = commands().filter((c) => !q || `${c.label} ${c.hint}`.toLowerCase().includes(q));
    paletteIndex = Math.min(paletteIndex, Math.max(0, items.length - 1));
    $("#palette-list").innerHTML = items.length
      ? items
          .map(
            (c, i) =>
              `<button class="palette-item ${i === paletteIndex ? "active" : ""}" data-cmd="${i}" type="button"><span>${esc(c.label)}</span><small>${c.hint}</small></button>`,
          )
          .join("")
      : `<p class="palette-empty">没有匹配的命令</p>`;
    return items;
  }

  function openPalette() {
    $("#palette-input").value = "";
    paletteIndex = 0;
    renderPalette();
    if (!$("#palette").open) $("#palette").showModal();
    $("#palette-input").focus();
  }

  function setEnv(id) {
    if (!state.environments.some((e) => e.id === id)) return;
    envId = id;
    nsFilter = "all";
    selected.clear();
    focusedKey = store.listPods(envId)[0]?.key || null;
    view = "workbench";
    renderAll();
  }

  /* ---------------------------- events ---------------------------- */

  document.addEventListener("click", (ev) => {
    const viewBtn = ev.target.closest("[data-view]");
    if (viewBtn) {
      view = viewBtn.dataset.view;
      renderAll();
      return;
    }

    const check = ev.target.closest("[data-check]");
    if (check) {
      ev.stopPropagation();
      const key = check.dataset.check;
      if (check.checked) selected.add(key);
      else selected.delete(key);
      // Toggle in place: rebuilding the list would drop focus and scroll position.
      check.closest(".row")?.classList.toggle("checked", check.checked);
      renderChrome();
      renderFoot();
      return;
    }

    const row = ev.target.closest(".row[data-key]");
    if (row) {
      focusPod(row.dataset.key);
      return;
    }

    const lane = ev.target.closest(".lane[data-task]");
    if (lane) {
      activeTaskId = lane.dataset.task;
      renderEvidence();
      return;
    }

    const lr = ev.target.closest("[data-ledger-run]");
    if (lr) {
      ledgerRunId = lr.dataset.ledgerRun;
      activeRunId = ledgerRunId;
      activeTaskId = null;
      renderLedger();
      return;
    }

    const goEnv = ev.target.closest("[data-goto-env]");
    if (goEnv) {
      setEnv(goEnv.dataset.gotoEnv);
      return;
    }

    const cmd = ev.target.closest("[data-cmd]");
    if (cmd) {
      const items = renderPalette();
      const c = items[Number(cmd.dataset.cmd)];
      $("#palette").close();
      c?.run();
    }
  });

  document.addEventListener("change", (ev) => {
    if (ev.target.id === "env-select") setEnv(ev.target.value);
    else if (ev.target.id === "ns-select") {
      nsFilter = ev.target.value;
      selected.clear();
      renderAll();
    } else if (ev.target.id === "tool-select") {
      tool = ev.target.value;
      renderChrome();
    } else if (ev.target.id === "run-picker") {
      activeRunId = ev.target.value;
      activeTaskId = null;
      renderEvidence();
    } else if (ev.target.id === "ledger-source") {
      renderLedger();
    }
  });

  document.addEventListener("input", (ev) => {
    if (ev.target.id === "search") {
      query = ev.target.value;
      renderList();
    } else if (ev.target.id === "ledger-search") {
      renderLedger();
    } else if (ev.target.id === "palette-input") {
      paletteIndex = 0;
      renderPalette();
    }
  });

  document.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      openPalette();
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter" && selected.size) {
      ev.preventDefault();
      launch();
      return;
    }
    if ($("#palette").open) {
      const items = renderPalette();
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        paletteIndex = (paletteIndex + 1) % Math.max(1, items.length);
        renderPalette();
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        paletteIndex = (paletteIndex - 1 + items.length) % Math.max(1, items.length);
        renderPalette();
      } else if (ev.key === "Enter" && items[paletteIndex]) {
        const c = items[paletteIndex];
        $("#palette").close();
        c.run();
      }
    }
  });

  document.addEventListener("dblclick", (ev) => {
    const row = ev.target.closest(".row[data-key]");
    if (row) openIdentity(row.dataset.key);
  });

  $("#open-cmdk").addEventListener("click", openPalette);
  $("#cmdk-btn").addEventListener("click", openPalette);
  $("#run-btn").addEventListener("click", launch);
  $("#clear-sel").addEventListener("click", () => {
    selected.clear();
    renderChrome();
    renderList();
  });
  $("#sheet-close").addEventListener("click", () => $("#sheet").close());
  $("#palette").addEventListener("click", (ev) => {
    if (ev.target === $("#palette")) $("#palette").close();
  });

  document.addEventListener("click", (ev) => {
    if (ev.target.id === "copy-link") {
      const hash = `#run=${encodeURIComponent(activeRunId || "")}&task=${encodeURIComponent(activeTaskId || "")}`;
      history.replaceState(null, "", hash);
      navigator.clipboard?.writeText(`${location.origin}${location.pathname}${hash}`).catch(() => {});
      toast("已复制证据链接");
    }
    if (ev.target.closest("#back-btn")) {
      $("#view-workbench").classList.remove("show-evidence");
      $("#view-ledger").classList.remove("show-evidence");
    }
    if (ev.target.id === "copy-mcp") {
      navigator.clipboard?.writeText($("#mcp-config").textContent).catch(() => {});
      toast("已复制 MCP 配置");
    }
  });

  // On narrow screens tapping a row opens the evidence pane.
  $("#list").addEventListener("click", (ev) => {
    if (window.matchMedia("(max-width: 900px)").matches && !ev.target.closest("[data-check]")) {
      $("#view-workbench").classList.add("show-evidence");
    }
  });

  /* ---------------------------- deep links ---------------------------- */

  function applyHash() {
    const raw = location.hash.replace(/^#/, "");
    if (!raw) return;
    const p = new URLSearchParams(raw);
    const v = p.get("view");
    if (["workbench", "ledger", "pipeline"].includes(v)) view = v;
    const e = p.get("env");
    if (e && state.environments.some((x) => x.id === e)) {
      envId = e;
      focusedKey = store.listPods(envId)[0]?.key || null;
    }
    const r = p.get("run");
    if (r && runOf(r)) {
      activeRunId = r;
      ledgerRunId = r;
    }
    activeTaskId = p.get("task") || null;
  }

  window.addEventListener("hashchange", () => {
    applyHash();
    renderAll();
  });

  /* ---------------------------- boot ---------------------------- */

  $("#tool-select").innerHTML = Object.entries(TOOLS)
    .map(([id, t]) => `<option value="${id}" ${id === tool ? "selected" : ""}>${t.label}</option>`)
    .join("");

  applyHash();
  renderAll();

  let last = "";
  setInterval(() => {
    store.tick();
    const sig = JSON.stringify([
      state.pods.map((p) => [p.key, p.channel]),
      state.tasks.map((t) => [t.id, t.status]),
    ]);
    if (sig !== last) {
      last = sig;
      renderAll();
    }
  }, 400);
})();
