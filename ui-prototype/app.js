/* Offline design prototype. No process, cluster, model provider or MCP network access. */
(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const icon = (name, small = false) =>
    `<svg class="icon${small ? " small" : ""}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const tools = {
    trace: ["方法追踪", "拆解一次方法调用，定位耗时发生在哪里。", "layers"],
    watch: ["方法观测", "观察方法执行时的入参、返回值与异常。", "search"],
    thread: ["线程分析", "查看线程与调用栈，定位阻塞和热点。", "activity"],
    jvm: ["JVM 信息", "查看当前 Java 进程的运行信息。", "server"],
    memory: ["内存概览", "查看堆、元空间与直接内存。", "grid"],
    ognl: ["表达式求值", "结构化求值结果；原型不会执行表达式。", "code"],
    sc: ["类检查", "查看已加载的类、类加载器与代码来源。", "file"],
    profiler: ["性能采样", "按采样占比查看调用热点。", "clock"],
  };
  const channelNames = {
    ready: ["已连接", "green"],
    reconnecting: ["重连中", "amber"],
    discovered: ["待接入", "gray"],
    offline: ["助手离线", "gray"],
    retired: ["已替换", "red"],
  };
  const taskNames = {
    queued: ["排队中", "gray"],
    running: ["进行中", "blue"],
    succeeded: ["已完成", "green"],
    partial: ["部分完成", "amber"],
    cancelled: ["已取消", "gray"],
    interrupted: ["已中断", "red"],
  };
  const active = (task) => ["queued", "running"].includes(task.status);
  const store = window.WorkbenchDemo.createStore();
  const state = store.state;
  let page = "workspace",
    environment = "production",
    workload = "all",
    namespace = "all",
    node = "all",
    tab = "instances",
    tool = "trace",
    pageIndex = 0;
  const PAGE_SIZE = 8;
  let selected = store.listPods(environment)[0]?.key,
    checked = new Set(),
    remembered = new Map(),
    taskByTool = new Map();
  let runDetail = null,
    taskDetail = null,
    dialogTargets = [],
    dialogSource = "web",
    pendingConnection = null,
    toastTimer,
    lastSignature = "";
  const envFor = (id) => state.environments.find((item) => item.id === id);
  const currentEnvironment = () => envFor(environment);
  const isLocal = () => currentEnvironment()?.kind === "local";
  const environmentName = (id) => envFor(id)?.name || id;
  const podFor = (key) => state.pods.find((pod) => pod.key === key);
  const selectedPod = () => podFor(selected);
  const allPods = () => store.listPods(environment);
  const inScope = (target) =>
    target.environment === environment &&
    (workload === "all" || target.app === workload) &&
    (namespace === "all" || target.namespace === namespace) &&
    (node === "all" || target.node === node);
  const currentPods = () => allPods().filter(inScope);
  const date = (value) =>
    value == null
      ? "—"
      : new Intl.DateTimeFormat("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(new Date(value));
  const status = (value, kind = "channel") => {
    const [label, color] = (kind === "task" ? taskNames : channelNames)[
      value
    ] || [value, "gray"];
    return `<span class="status ${color}">${label}</span>`;
  };
  const badge = (source) =>
    `<span class="source-badge ${source === "mcp" ? "mcp" : ""}">${icon(source === "mcp" ? "code" : "monitor", true)}${source === "mcp" ? "MCP" : "Web"}</span>`;
  const scopeLabel = (target) =>
    target.kind === "local"
      ? `PID ${target.pid}`
      : `${target.namespace} / ${target.workloadName || target.appName || target.app}`;
  const runTasks = (run) =>
    run.taskIds
      .map((id) => state.tasks.find((task) => task.id === id))
      .filter(Boolean);
  const scopeRuns = () =>
    state.runs.filter((run) =>
      runTasks(run).some((task) => inScope(task.target)),
    );
  const visiblePods = () =>
    currentPods().filter((pod) => {
      const query = $("#pod-search").value.trim().toLowerCase();
      return (
        (!query ||
          `${pod.name} ${pod.namespace} ${pod.workloadName} ${pod.node} ${pod.pid}`
            .toLowerCase()
            .includes(query)) &&
        ($("#channel-filter").value === "all" ||
          pod.channel === $("#channel-filter").value)
      );
    });
  const groupValue = (pod) => {
    const mode = $("#node-group").value;
    return mode === "namespace"
      ? pod.namespace
      : mode === "workload"
        ? `${pod.namespace} / ${pod.workloadName}`
        : mode === "node"
          ? pod.node
          : "";
  };
  function orderedPods() {
    const pods = visiblePods();
    return $("#node-group").value === "none"
      ? pods
      : [...pods].sort((a, b) =>
          String(groupValue(a)).localeCompare(String(groupValue(b))),
        );
  }
  function pagePods() {
    const pods = orderedPods();
    pageIndex = Math.min(
      pageIndex,
      Math.max(0, Math.ceil(pods.length / PAGE_SIZE) - 1),
    );
    return pods.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE);
  }
  function toast(message) {
    clearTimeout(toastTimer);
    $("#toast").textContent = message;
    $("#toast").hidden = false;
    toastTimer = setTimeout(() => ($("#toast").hidden = true), 4500);
  }
  const narrowNavigation = matchMedia("(max-width: 820px)");
  function syncNavigation() {
    const open = $("#sidebar").classList.contains("open");
    $("#sidebar").inert = narrowNavigation.matches && !open;
    $(".shell").inert = narrowNavigation.matches && open;
  }
  function closeNavigation() {
    const focused = $("#sidebar").contains(document.activeElement);
    $("#sidebar").classList.remove("open");
    $("#nav-scrim").hidden = true;
    $("#mobile-menu").setAttribute("aria-expanded", "false");
    syncNavigation();
    if (focused && narrowNavigation.matches) $("#mobile-menu").focus();
  }
  narrowNavigation.addEventListener("change", closeNavigation);
  function clearFilters() {
    workload = "all";
    namespace = "all";
    node = "all";
    pageIndex = 0;
    checked.clear();
    $("#pod-search").value = "";
    $("#channel-filter").value = "all";
    $("#node-group").value = "none";
  }
  function reconcileSelection() {
    const list = visiblePods();
    if (!list.some((pod) => pod.key === selected))
      selected =
        list.find((pod) => pod.key === remembered.get(environment))?.key ||
        list[0]?.key;
  }
  function changeEnvironment(id) {
    if (!envFor(id)) return;
    remembered.set(environment, selected);
    environment = id;
    clearFilters();
    selected = remembered.get(id);
    reconcileSelection();
    page = "workspace";
    tab = "instances";
    closeNavigation();
    render();
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function showPage(next) {
    page = next;
    closeNavigation();
    render();
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function scopeChanged() {
    checked.clear();
    pageIndex = 0;
    reconcileSelection();
    render();
  }
  function options(items, value) {
    return items
      .map(
        ([id, label]) =>
          `<option value="${escape(id)}" ${id === value ? "selected" : ""}>${escape(label)}</option>`,
      )
      .join("");
  }
  function workloadOptions() {
    const map = new Map();
    allPods()
      .filter((p) => namespace === "all" || p.namespace === namespace)
      .forEach((p) =>
        map.set(p.app, {
          id: p.app,
          name: p.workloadName || p.name,
          namespace: p.namespace,
          kind: p.workloadKind || "Deployment",
        }),
      );
    return [...map.values()];
  }
  function renderNavigation() {
    $$("[data-page]").forEach((button) => {
      const yes = button.dataset.page === page;
      button.classList.toggle("active", yes);
      if (yes) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    $("#environment").value = environment;
    $(".environment-control").dataset.env = environment;
    $("#environment-count").textContent = state.environments.length;
    $("#app-navigation").hidden = page !== "workspace";
    $("#all-targets-count").textContent = allPods().length;
    $("#all-targets-view").classList.toggle(
      "active",
      workload === "all" && namespace === "all" && node === "all",
    );
    $("#sidebar-context-note").textContent = isLocal()
      ? "一台已配对设备，一个本机环境。仅运行中的 JVM 是诊断目标。"
      : "一个集群，一个环境。Namespace 与工作负载是筛选条件。";
    $("#app-search").parentElement.hidden = isLocal();
    const query = $("#app-search").value.trim().toLowerCase();
    $("#app-list").innerHTML = isLocal()
      ? `<div class="device-info">${icon("monitor")}<span>${escape(currentEnvironment().device)}<small>${currentEnvironment().online === false ? "助手离线 · 保留上次清单" : "助手在线 · 模拟"}</small></span></div>`
      : workloadOptions()
          .filter((w) =>
            `${w.name} ${w.namespace}`.toLowerCase().includes(query),
          )
          .map(
            (w) =>
              `<button class="app-link${workload === w.id ? " active" : ""}" data-workload="${escape(w.id)}"><span class="app-indicator"></span><span class="workload-nav-name">${escape(w.name)}<small>${escape(w.namespace)} · ${escape(w.kind)}</small></span><span class="app-quantity">${allPods().filter((p) => p.app === w.id).length}</span></button>`,
          )
          .join("") ||
        '<div class="empty-state compact">没有匹配的工作负载</div>';
    $("#global-task-count").textContent = state.runs.filter(
      (run) => store.runSummary(run.id).status === "running",
    ).length;
    $("#breadcrumb-context").textContent =
      page === "workspace" ? environmentName(environment) : "团队工作空间";
    $("#breadcrumb-page").textContent = {
      workspace: isLocal() ? "Java 进程" : "诊断目标",
      tasks: "诊断任务",
      mcp: "MCP 接入",
      settings: "资源与执行节点",
    }[page];
    ["workspace", "tasks", "mcp", "settings"].forEach(
      (id) => ($(`#${id}-page`).hidden = page !== id),
    );
  }
  function renderHeading() {
    const env = currentEnvironment(),
      pods = allPods(),
      ready = pods.filter((p) => p.channel === "ready").length;
    $("#application-category").textContent = isLocal()
      ? "LOCAL DEVICE / 本机环境"
      : "KUBERNETES / 集群环境";
    $("#application-name").textContent = env.name;
    $("#application-description").textContent = isLocal()
      ? "在已配对设备中发现 Java 进程，通过同一入口完成诊断。"
      : "发现集群中的 Java 目标，维护通道，让 Web 与 AI 共用诊断能力。";
    $("#application-meta").innerHTML = isLocal()
      ? `<span>${icon("monitor")}${escape(env.device)}</span><span class="meta-divider"></span><span>${icon("link")}${env.online === false ? "助手离线" : "助手在线"} · 模拟</span>`
      : `<span>${icon("layers")}${escape(env.cluster)}</span><span class="meta-divider"></span><span>${icon("box")}${new Set(pods.map((p) => p.namespace)).size} 个 Namespace</span><span class="meta-divider"></span><span>${new Set(pods.map((p) => p.app)).size} 个工作负载</span><span class="meta-badge">Java 诊断范围</span>`;
    $("#environment-access").innerHTML =
      `<div>${icon("code")}<span><strong>${ready} / ${pods.length} 个目标可通过 MCP 诊断</strong><small>${isLocal() && env.online === false ? "设备离线，不能扫描、连接或执行任务。" : "可用状态由诊断通道决定；发现目标不会自动 Attach。"} · 全部模拟</small></span></div><button class="text-button" id="environment-mcp-demo" ${ready ? "" : "disabled"}>体验多目标调用 ${icon("arrow", true)}</button>`;
    $("#scope-filters").hidden = isLocal();
    const namespaces = [...new Set(pods.map((p) => p.namespace))].filter(
      Boolean,
    );
    $("#namespace-filter").innerHTML = options(
      [["all", "全部 Namespace"], ...namespaces.map((id) => [id, id])],
      namespace,
    );
    $("#workload-filter").innerHTML = options(
      [
        ["all", "全部工作负载"],
        ...workloadOptions().map((w) => [w.id, `${w.name} · ${w.namespace}`]),
      ],
      workload,
    );
    $("#node-filter").innerHTML = options(
      [
        ["all", "全部 Node"],
        ...[
          ...new Set(
            pods
              .filter(
                (p) =>
                  (namespace === "all" || p.namespace === namespace) &&
                  (workload === "all" || p.app === workload),
              )
              .map((p) => p.node),
          ),
        ].map((id) => [id, id]),
      ],
      node,
    );
    $("#instance-column-title").textContent = isLocal()
      ? "进程 / JVM"
      : "Pod / JVM 目标";
    $("#scope-column-title").textContent = isLocal()
      ? "设备 / 执行器"
      : "Namespace / 工作负载";
    $("#local-scan-button").hidden = !isLocal();
    $("#local-scan-button").disabled = env.online === false;
    $("#refresh-button").title = isLocal()
      ? "扫描模拟 Java 进程"
      : "刷新模拟目标";
    $("#refresh-button").setAttribute("aria-label", $("#refresh-button").title);
    $("#refresh-button").disabled = isLocal() && env.online === false;
    $("#node-group").disabled = isLocal();
    $("#policy-button").disabled =
      !currentPods().length || env.online === false;
    $("#diagnose-button").disabled =
      !selectedPod() ||
      selectedPod().retired ||
      selectedPod().channel === "offline";
    $("#pod-count").textContent = currentPods().length;
    $("#app-task-count").textContent = scopeRuns().length;
    $$(".section-tabs>[data-tab]").forEach((button) => {
      const yes = button.dataset.tab === tab;
      button.setAttribute("aria-selected", yes);
      button.tabIndex = yes ? 0 : -1;
    });
    $("#instances-panel").hidden = tab !== "instances";
    $("#application-tasks-panel").hidden = tab !== "tasks";
    $("#events-panel").hidden = tab !== "events";
    $("#diagnostic-workspace").hidden = tab !== "instances" || !selectedPod();
  }
  function renderPods() {
    const pods = pagePods(),
      filtered = visiblePods();
    let previous;
    $("#pod-rows").innerHTML =
      pods
        .map((pod) => {
          const group = groupValue(pod);
          let groupRow = "";
          if (group && group !== previous) {
            groupRow = `<tr class="group-row"><td colspan="7">${escape(group)}</td></tr>`;
            previous = group;
          }
          const running = state.tasks.filter(
            (task) => task.target.key === pod.key && active(task),
          ).length;
          return `${groupRow}<tr class="${pod.key === selected ? "selected" : ""}" data-pod-row="${escape(pod.key)}"><td class="selection-cell"><input type="checkbox" data-select-pod="${escape(pod.key)}" aria-label="选择 ${escape(pod.namespace || environmentName(pod.environment))} / ${escape(pod.name)}" ${checked.has(pod.key) ? "checked" : ""} ${pod.channel !== "ready" ? "disabled" : ""}></td><td><button class="pod-name-button" data-select="${escape(pod.key)}" aria-label="查看 ${escape(pod.namespace || environmentName(pod.environment))} / ${escape(pod.name)}">${icon(pod.kind === "local" ? "monitor" : "box")}<span>${escape(pod.name)}</span></button><div class="pod-secondary"><span>${pod.kind === "local" ? `PID ${pod.pid}` : escape(pod.namespace)}</span><span class="tiny-separator"></span><span>g${pod.generation} · ${escape(pod.age)}</span>${running ? `<span class="pod-active-task">${running} 个任务</span>` : ""}</div></td><td><strong class="scope-cell">${escape(pod.kind === "local" ? currentEnvironment().device : pod.namespace)}</strong><small class="scope-workload">${escape(pod.kind === "local" ? pod.connector : pod.workloadName)}${pod.kind === "local" ? "" : ` · ${escape(pod.workloadKind || "Deployment")}`}</small></td><td><span class="node-label">${icon(pod.kind === "local" ? "monitor" : "server")}${escape(pod.node)}</span><small class="pod-readiness">${pod.channel === "offline" ? "上次发现" : pod.kind === "local" ? "进程在线" : `${pod.readyContainers}/${pod.containers.filter((c) => c.role !== "init").length} Ready`} · 重启 ${pod.restarts}</small></td><td>${status(pod.channel)}</td><td><span class="mcp-availability ${pod.channel === "ready" ? "available" : ""}">${pod.channel === "ready" ? icon("check", true) : "—"}${pod.channel === "ready" ? "可调用" : ""}</span></td><td><button class="row-action" data-${pod.channel === "ready" ? "diagnose" : "connect"}="${escape(pod.key)}" ${pod.channel === "offline" ? "disabled" : ""}>${pod.channel === "ready" ? "诊断" : pod.channel === "offline" ? "离线" : "连接"}${icon("arrow", true)}</button></td></tr>`;
        })
        .join("") ||
      '<tr class="empty-row"><td colspan="7">没有匹配的目标。请调整 Namespace、工作负载或连接筛选。</td></tr>';
    $("#instance-summary").textContent =
      `${filtered.length} 个匹配目标 · 本页 ${pods.length} 个${checked.size ? ` · 已选择 ${checked.size} 个` : ""}`;
    $("#page-number").textContent =
      `${pageIndex + 1} / ${Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))}`;
    $("#previous-page").disabled = pageIndex === 0;
    $("#next-page").disabled = (pageIndex + 1) * PAGE_SIZE >= filtered.length;
    $("#selected-diagnose").hidden = !checked.size;
    $("#selected-diagnose").textContent = `诊断所选 ${checked.size} 个目标`;
    const available = pods.filter((p) => p.channel === "ready");
    $("#select-all").checked =
      !!available.length && available.every((p) => checked.has(p.key));
    $("#select-all").indeterminate =
      available.some((p) => checked.has(p.key)) && !$("#select-all").checked;
    $("#select-all").disabled = !available.length;
  }
  function renderEvents() {
    const events = state.events
      .filter((event) => {
        const target = podFor(event.targetKey);
        const eventNamespace =
          target?.namespace ||
          state.apps.find((item) => item.id === event.app)?.namespace;
        return (
          event.environment === environment &&
          (workload === "all" || event.app === workload) &&
          (namespace === "all" || eventNamespace === namespace) &&
          (node === "all" || target?.node === node)
        );
      })
      .slice()
      .reverse();
    $("#connection-events").innerHTML =
      events
        .map(
          (event) =>
            `<li><span class="event-dot ${escape(event.kind)}"></span><div><strong>${escape(event.title)}</strong><p>${escape(event.detail)}</p></div><time>${date(event.at)}</time></li>`,
        )
        .join("") ||
      "<li><div><strong>暂无连接事件</strong><p>连接、重连、任务提交和实例更替都会记录在这里。</p></div></li>";
  }
  function renderRuns(target, runs) {
    $(target).innerHTML =
      runs
        .slice()
        .reverse()
        .map((run) => {
          const summary = store.runSummary(run.id),
            tasks = runTasks(run),
            first = tasks[0]?.target;
          return `<article class="run-list-row"><span class="task-list-icon">${icon(tools[run.tool]?.[2] || "activity")}</span><div class="run-title"><button class="run-open" data-open-run="${escape(run.id)}">${escape(run.title)}</button><p>${escape(first?.environmentName || environmentName(first?.environment))} · ${summary.total} 个目标 · ${escape(run.tool)} · ${date(run.createdAt)}</p></div><div class="run-source">${badge(run.source)}<small>${escape(run.client)}</small></div><div class="run-progress">${status(summary.status, "task")}<small>${summary.completed} / ${summary.total} 已结束${summary.counts.queued ? ` · ${summary.counts.queued} 排队` : ""}</small></div><button class="text-button" data-open-run="${escape(run.id)}">查看批次 ${icon("arrow", true)}</button></article>`;
        })
        .join("") ||
      '<div class="empty-state compact"><h3>暂无匹配的诊断批次</h3><p>从目标发起诊断，或体验 MCP 多目标调用。</p></div>';
  }
  function chosenTask() {
    const tasks = state.tasks.filter(
      (task) => task.target.key === selected && task.tool === tool,
    );
    return (
      tasks.find((task) => task.id === taskByTool.get(`${selected}/${tool}`)) ||
      tasks.at(-1)
    );
  }
  function resultData(task) {
    const result = task.result;
    if (task.tool === "trace")
      return `<div class="result-table-scroll"><table class="trace-table"><thead><tr><th>方法调用</th><th class="time-cell">耗时</th><th class="percent-cell">占比</th></tr></thead><tbody>${result.trace.map((row) => `<tr class="${row.depth > 0 && row.percent > 70 ? "slow-row" : ""}"><td><span class="tree-indent">${row.depth ? "　".repeat(row.depth - 1) + "└─" : "↳"}</span>${escape(row.method)}</td><td class="time-cell">${row.ms.toFixed(1)} ms</td><td class="percent-cell">${row.percent.toFixed(1)}%</td></tr>`).join("")}</tbody></table></div>`;
    if (task.tool === "thread")
      return `<div class="result-table-scroll"><table class="plain-table"><thead><tr><th>ID / 线程</th><th>状态</th><th>CPU（示例）</th></tr></thead><tbody>${result.threads.map((thread) => `<tr><td><span class="thread-name">${thread.id} · ${escape(thread.name)}</span><details class="stack-details"><summary>查看调用栈</summary><pre>${escape(thread.stack.join("\n"))}</pre></details></td><td><span class="status ${thread.state === "RUNNABLE" ? "green" : "gray"}">${escape(thread.state)}</span></td><td>${thread.cpu}%</td></tr>`).join("")}</tbody></table></div>`;
    if (task.tool === "watch")
      return result.samples
        .map(
          (sample, index) =>
            `<article class="watch-sample"><header><span>观测 #${index + 1} · ${date(new Date(sample.time).getTime())}</span><span>正常返回 · 示例</span></header><pre>${escape(JSON.stringify({ params: sample.params, returnObj: sample.returnObj, throwExp: sample.throwExp }, null, 2))}</pre></article>`,
        )
        .join("");
    if (task.tool === "jvm") {
      const names = {
        name: "虚拟机",
        javaVersion: "Java 版本",
        pid: "进程 PID",
        application: "所属工作负载",
        uptime: "运行时间",
        processors: "可用处理器",
        arguments: "启动参数",
      };
      return `<div class="result-key-values">${result.rows.map((row) => `<div class="key-value"><span>${escape(names[row.name] || row.name)}</span><strong>${escape(row.value)}</strong></div>`).join("")}</div>`;
    }
    if (task.tool === "memory")
      return `<div class="result-table-scroll"><table class="plain-table"><thead><tr><th>内存区域</th><th>已使用</th><th>已提交</th><th>最大值</th></tr></thead><tbody>${result.memory.map((row) => `<tr><td>${escape(row.name)}</td><td>${escape(row.used)}</td><td>${escape(row.committed)}</td><td>${escape(row.max)}</td></tr>`).join("")}</tbody></table></div>`;
    if (task.tool === "ognl")
      return `<pre class="value-result">${escape(JSON.stringify(result.value, null, 2))}</pre>`;
    if (task.tool === "sc")
      return result.classes
        .map(
          (row) =>
            `<div class="class-row">${escape(row.name)}<span>${escape(row.classLoader)} · ${escape(row.codeSource)}</span></div>`,
        )
        .join("");
    if (task.tool === "profiler")
      return `<div class="result-table-scroll"><table class="plain-table"><thead><tr><th>采样栈（模拟）</th><th>样本数</th><th>占比</th></tr></thead><tbody>${result.frames.map((row) => `<tr><td class="thread-name"><span class="tree-indent">${row.depth ? "　".repeat(row.depth - 1) + "└─" : ""}</span>${escape(row.name)}</td><td>${row.samples}</td><td>${row.percent}%</td></tr>`).join("")}</tbody></table></div>`;
    return "";
  }
  function taskResult(task, standalone = false) {
    const pod = podFor(task.target.key),
      target = task.target;
    const header = `<div class="result-target-line">${badge(task.source)}<span class="result-target-copy">${escape(target.environmentName)} / ${escape(target.namespace || "本机")} / ${escape(target.name)} · JVM g${target.generation}</span>${status(task.status, "task")}</div>`;
    let content;
    if (active(task))
      content = `<div class="state-message"><span class="spinner"></span><div><strong>${task.status === "queued" ? "已排队，等待并发名额" : pod?.channel === "reconnecting" ? "通道恢复中，保留原任务身份" : ["trace", "watch"].includes(task.tool) ? "等待目标方法执行…" : "正在收集模拟诊断结果…"}</strong><span>可继续切换环境；此任务始终绑定当前 UID 和 JVM 代次。</span></div><button class="button secondary" data-cancel="${task.id}">${icon("stop")}取消</button></div>`;
    else if (task.status !== "succeeded")
      content = `<div class="state-message">${icon("info")}<div><strong>${task.status === "interrupted" ? "任务已中断，未自动重放" : "模拟任务已取消"}</strong><span>${task.status === "interrupted" ? "实例更替或等待超时。旧结果保留原目标，不能转移到新 JVM。" : "此子任务结束，其他目标不受影响。"}</span></div></div>`;
    else
      content = `<div class="result-summary"><span class="sample-badge">模拟采样</span><span>${escape(task.result.summary)}</span></div>${resultData(task)}<div class="result-footnote"><span>${escape(task.id)} · ${date(task.finishedAt)} · 示例数值</span><button class="text-button" data-raw="${task.id}" aria-expanded="false">原始结果 ${icon("code", true)}</button></div><pre class="raw-result" id="raw-${task.id}${standalone ? "-standalone" : ""}" hidden>${escape(JSON.stringify(task.result, null, 2))}</pre>`;
    return `${header}${content}<button class="text-button result-run-link" data-open-run="${escape(task.runId)}">查看所属诊断批次 ${icon("arrow", true)}</button>`;
  }
  function renderResult() {
    const pod = selectedPod();
    $("#diagnostic-workspace").hidden = !pod || tab !== "instances";
    if (!pod) return;
    $("#detail-pod").textContent = pod.name;
    $("#detail-subtitle").textContent =
      `${environmentName(pod.environment)} / ${scopeLabel(pod)} · JVM g${pod.generation}${pod.retired ? " · 原实例已替换" : ""}`;
    $$("[data-tool]").forEach((button) => {
      const yes = button.dataset.tool === tool;
      button.classList.toggle("active", yes);
      button.setAttribute("aria-pressed", yes);
    });
    const task = chosenTask(),
      tasks = state.tasks.filter(
        (item) => item.target.key === selected && item.tool === tool,
      );
    let content = `<div class="result-heading"><div><h2>${tools[tool][0]}<span class="tool-code">${tool}</span></h2><p>${tools[tool][1]}</p></div><div class="result-heading-actions">${task?.status === "succeeded" ? `<button class="text-button" data-copy-result="${task.id}">${icon("copy", true)}复制</button>` : ""}<button class="button secondary" data-diagnose="${escape(selected)}" ${pod.retired || pod.channel === "offline" ? "disabled" : ""}>${icon("play")}${pod.channel === "ready" ? "运行诊断" : pod.channel === "offline" ? "设备离线" : "连接并诊断"}</button></div></div>`;
    if (tasks.length > 1)
      content += `<div class="task-tabs">${tasks
        .slice(-6)
        .map(
          (item) =>
            `<button class="task-tab${item.id === task?.id ? " active" : ""}" data-task-tab="${item.id}" aria-pressed="${item.id === task?.id}">${badge(item.source)}${escape(item.id.replace("demo-task-", "#"))} · ${date(item.createdAt)}</button>`,
        )
        .join("")}</div>`;
    content += task
      ? taskResult(task)
      : `<div class="empty-state"><h3>${pod.retired ? "原实例已替换" : pod.channel === "offline" ? "本机助手离线" : `在此目标上开始${tools[tool][0]}`}</h3><p>${pod.channel === "offline" ? "保留上次发现的进程；助手上线前不接受诊断。" : "操作均为模拟，任务绑定具体容器、UID 与 JVM 代次。"}</p><button class="button primary" data-diagnose="${escape(selected)}" ${pod.retired || pod.channel === "offline" ? "disabled" : ""}>${icon("play")}${pod.channel === "ready" ? "配置诊断" : "连接并诊断"}</button></div>`;
    $("#result-content").innerHTML = content;
  }
  function comparison(task) {
    if (!task.result)
      return {
        label: "—",
        value:
          task.status === "queued"
            ? "尚未开始"
            : task.status === "running"
              ? "采集中"
              : "无结果",
      };
    if (task.tool === "thread")
      return {
        label: "最高线程 CPU",
        value: `${Math.max(...task.result.threads.map((t) => t.cpu))}%`,
      };
    if (task.tool === "trace")
      return { label: "根调用耗时", value: `${task.result.trace[0]?.ms} ms` };
    if (task.tool === "memory")
      return { label: "Heap 已使用", value: task.result.memory[0]?.used };
    if (task.tool === "watch")
      return { label: "观测事件", value: `${task.result.samples.length} 条` };
    if (task.tool === "jvm")
      return { label: "Java 版本", value: task.result.jvm.javaVersion };
    return { label: "诊断结果", value: "已返回" };
  }
  function renderRunDetail() {
    const run = state.runs.find((item) => item.id === runDetail);
    $("#run-detail").hidden = !run;
    if (!run) return;
    const summary = store.runSummary(run.id),
      tasks = runTasks(run);
    $("#run-detail").innerHTML =
      `<div class="run-detail-heading"><div><div class="eyebrow">DIAGNOSTIC RUN / ${escape(run.id)}</div><h2>${escape(run.title)}</h2><p>${badge(run.source)} ${escape(run.client)} · ${summary.total} 个固定目标 · 最多同时执行 ${run.concurrency} 个</p></div><div class="run-heading-actions">${summary.status === "running" ? `<button class="button secondary" data-cancel-run="${run.id}">${icon("stop")}取消剩余任务</button>` : ""}<button class="icon-button" id="close-run-detail" aria-label="关闭批次详情">${icon("close")}</button></div></div><div class="run-counts">${status(summary.status, "task")}<span>完成 ${summary.counts.succeeded}</span><span>执行 ${summary.counts.running}</span><span>排队 ${summary.counts.queued}</span><span>取消 ${summary.counts.cancelled}</span><span>中断 ${summary.counts.interrupted}</span></div><div class="comparison-wrap"><table class="plain-table comparison-table"><thead><tr><th>目标 / Namespace</th><th>状态</th><th>结果摘要（模拟）</th><th>开始 / 结束</th><th>操作</th></tr></thead><tbody>${tasks
        .map((task) => {
          const metric = comparison(task);
          return `<tr data-child-task="${task.id}"><td><strong>${escape(task.target.name)}</strong><small>${escape(task.target.environmentName)} / ${escape(task.target.namespace || "本机")} · g${task.target.generation}</small></td><td>${status(task.status, "task")}</td><td><strong>${escape(metric.value)}</strong><small>${escape(metric.label)}</small></td><td class="task-time">${date(task.startedAt)}<small>${date(task.finishedAt)}</small></td><td><button class="text-button" data-open-task="${task.id}">详情</button>${active(task) ? `<button class="text-button" data-cancel="${task.id}">取消</button>` : ""}</td></tr>`;
        })
        .join(
          "",
        )}</tbody></table></div><div class="run-detail-foot">结果保留各自采样时间与参数，不代表严格同步采样。MCP 只是调用来源；这里不会生成或伪造 AI 分析结论。<button class="text-button" data-run-parameters="${run.id}">查看参数快照 ${icon("code", true)}</button></div>`;
  }
  function renderAllTasks() {
    const query = $("#task-search").value.trim().toLowerCase(),
      filter = $("#task-status-filter").value,
      source = $("#task-source-filter").value;
    renderRuns(
      "#all-tasks",
      state.runs.filter(
        (run) =>
          (filter === "all" || store.runSummary(run.id).status === filter) &&
          (source === "all" || run.source === source) &&
          (!query ||
            `${run.title} ${run.tool} ${run.client} ${runTasks(run)
              .map(
                (t) =>
                  `${t.target.name} ${t.target.namespace} ${t.target.environmentName}`,
              )
              .join(" ")}`
              .toLowerCase()
              .includes(query)),
      ),
    );
    renderRunDetail();
    const task = state.tasks.find((item) => item.id === taskDetail);
    $("#task-result").hidden = !task;
    if (task)
      $("#task-result").innerHTML =
        `<div class="result-heading"><div><h2>${tools[task.tool][0]}<span class="tool-code">${task.tool}</span></h2><p>按提交时的精确目标保存，独立于当前环境筛选。</p></div><button class="icon-button" id="close-task-result" aria-label="关闭任务结果">${icon("close")}</button></div><div class="task-result-label">${escape(task.target.podUid)} · ${escape(task.id)}</div>${taskResult(task, true)}`;
  }
  function renderMcp() {
    const ready = state.pods.filter(
      (p) => !p.retired && p.channel === "ready",
    ).length;
    $("#mcp-scope").innerHTML =
      `${icon("link")}<span><strong>统一 MCP 入口 · Streamable HTTP</strong><small>${state.environments.length} 个环境，${ready} 个当前可诊断目标 · 全部为模拟</small><small>演示范围：${escape(environmentName(environment))} · ${checked.size ? `已选 ${checked.size} 个目标` : "当前筛选内最多 3 个已连接目标"}</small></span><span class="outline-label">示例服务，不可真实调用</span>`;
    $("#mcp-environments").innerHTML =
      `<table class="plain-table"><thead><tr><th>环境</th><th>类型</th><th>可调用 / 已发现</th><th>状态</th><th></th></tr></thead><tbody>${state.environments
        .map((env) => {
          const pods = store.listPods(env.id),
            count = pods.filter((p) => p.channel === "ready").length;
          return `<tr><td><strong>${escape(env.name)}</strong><small>${escape(env.cluster || env.device)}</small></td><td>${env.kind === "local" ? "本机设备" : "Kubernetes"}</td><td>${count} / ${pods.length}</td><td>${status(env.online === false ? "offline" : count ? "ready" : "discovered")}</td><td><button class="text-button" data-environment="${escape(env.id)}">查看目标 ${icon("arrow", true)}</button></td></tr>`;
        })
        .join("")}</tbody></table>`;
    renderRuns(
      "#mcp-recent",
      state.runs.filter((run) => run.source === "mcp").slice(-4),
    );
  }
  function signature() {
    return JSON.stringify([
      state.pods.map((p) => [p.key, p.channel, p.managed, p.retired]),
      state.tasks.map((t) => [t.id, t.status]),
      state.runs.map((r) => r.id),
      state.events.map((e) => e.id),
      state.policies,
    ]);
  }
  function render() {
    renderNavigation();
    if (page === "workspace") {
      renderHeading();
      renderPods();
      renderRuns("#application-tasks", scopeRuns());
      renderEvents();
      renderResult();
    }
    if (page === "tasks") renderAllTasks();
    if (page === "mcp") renderMcp();
    lastSignature = signature();
  }
  function selectPod(key) {
    selected = key;
    remembered.set(environment, key);
    renderHeading();
    renderPods();
    renderResult();
  }
  function showInfo(title, content, eyebrow = "WORKSPACE") {
    $("#info-title").textContent = title;
    $("#info-eyebrow").textContent = eyebrow;
    $("#info-content").innerHTML = content;
    if (!$("#info-dialog").open) $("#info-dialog").showModal();
  }
  function openIdentity() {
    const pod = selectedPod();
    if (!pod) return;
    const pairs = [
      ["环境", environmentName(pod.environment)],
      ["Namespace", pod.namespace || "不适用"],
      ["工作负载", pod.workloadName || "本机进程"],
      ["实例名称", pod.name],
      ["目标 UID", pod.podUid],
      ["容器实例", pod.containerId || pod.container],
      ["JVM 身份", pod.jvmIdentity || `g${pod.generation} / PID ${pod.pid}`],
      ["JVM 代次", `g${pod.generation}`],
      ["执行容器 / PID", `${pod.container} / ${pod.pid}`],
      ["K8s Node", pod.kind === "k8s" ? pod.node : "不适用"],
      ["Connector", pod.connector],
      ["诊断通道", channelNames[pod.channel][0]],
    ];
    const containers = pod.containers || [];
    showInfo(
      "目标身份",
      `<dl class="identity-grid">${pairs.map(([key, value]) => `<dt>${key}</dt><dd>${escape(value)}</dd>`).join("")}</dl>${containers.length ? `<div class="container-list"><h3>容器清单</h3>${containers.map((c) => `<div><strong>${escape(c.name)}</strong><span>${c.role === "init" ? "初始化容器 · 不作为 JVM 目标" : "应用容器"} · ${escape(c.state)}</span></div>`).join("")}</div>` : ""}<div class="inline-note">Pod 重建或 JVM 重启后，原任务保留旧身份。初始化容器不会被当成可诊断进程。</div>`,
      "TARGET IDENTITY",
    );
  }
  function openPolicy() {
    const scoped = workloadOptions().filter(
      (w) => workload === "all" || w.id === workload,
    );
    const candidates = isLocal()
      ? [{ id: "local", name: currentEnvironment().device, namespace: "本机" }]
      : scoped;
    const choices = candidates.map((w) => [w.id, `${w.name} · ${w.namespace}`]);
    if (!choices.length) {
      toast("当前范围没有可维护的工作负载。");
      return;
    }
    showInfo(
      "连接维护策略",
      `<p class="body-copy">${escape(environmentName(environment))} · 策略按工作负载／设备设置，不会隐式应用到整个集群。</p><form id="policy-form"><label class="form-field">维护范围<select id="policy-workload">${options(choices, workload === "all" ? choices[0][0] : workload)}</select></label><div id="policy-options"></div><div class="inline-note">已有连接独立维护。新副本是否接入由策略决定；状态与恢复均在浏览器中模拟。</div><p id="policy-error" class="form-error" role="alert"></p><div class="dialog-footer"><button class="button secondary" type="button" data-close>取消</button><button class="button primary" type="submit">应用模拟策略</button></div></form>`,
      "CONNECTION POLICY",
    );
    const renderOptions = () => {
      const current =
        state.policies[`${environment}/${$("#policy-workload").value}`] ||
        "selected";
      $("#policy-options").innerHTML = [
        [
          "selected",
          "维护已接入目标",
          "新发现副本等待明确接入；现有目标独立维护。",
        ],
        [
          "all",
          isLocal() ? "维护此设备的全部 JVM" : "维护此工作负载全部副本",
          "包含当前目标和后续新实例。不会自动迁移旧诊断任务。",
        ],
        [
          "discover",
          "仅发现，不维护连接",
          "该范围有排队或进行中任务时不可切换。",
        ],
      ]
        .map(
          ([id, title, description]) =>
            `<label class="policy-option"><input type="radio" name="policy" value="${id}" ${id === current ? "checked" : ""}><span><strong>${title}</strong><p>${description}</p></span></label>`,
        )
        .join("");
    };
    renderOptions();
    $("#policy-workload").addEventListener("change", renderOptions);
    $("#policy-form").addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        store.setPolicy(
          environment,
          $("#policy-workload").value,
          new FormData(event.currentTarget).get("policy"),
        );
        $("#info-dialog").close();
        render();
        toast("指定范围的模拟维护策略已更新。");
      } catch (error) {
        $("#policy-error").textContent = error.message;
      }
    });
  }
  function openScenarios() {
    const pod = selectedPod();
    if (!pod || pod.retired || pod.channel === "offline") {
      toast("请选择在线环境中的当前目标。");
      return;
    }
    showInfo(
      "体验连接生命周期",
      `<div class="target-summary"><strong>${escape(pod.name)}</strong>${escape(environmentName(pod.environment))} / ${escape(pod.namespace || "本机")} · g${pod.generation}</div><p class="field-hint">可先发起多目标 Watch，再观察其中一个目标中断后的批次状态。</p><div class="scenario-options"><button class="scenario-option" data-scenario="disconnect" ${!pod.managed ? "disabled" : ""}>${icon("refresh")}<span><strong>模拟短暂断线</strong><small>约 5 秒后独立恢复，不影响其他实例。</small></span>${icon("arrow")}</button><button class="scenario-option" data-scenario="replace">${icon("box")}<span><strong>模拟同名实例重建</strong><small>UID 与 JVM 代次变化，旧任务中断，不自动重放。</small></span>${icon("arrow")}</button></div><div class="dialog-footer"><button class="button secondary" data-close>返回工作台</button></div>`,
      "LIFECYCLE DEMO",
    );
    $$("#info-content [data-scenario]").forEach((button) =>
      button.addEventListener("click", () => {
        try {
          if (button.dataset.scenario === "disconnect")
            store.disconnect(pod.key);
          else {
            const replacement = store.replacePod(pod.key);
            checked.delete(pod.key);
            remembered.set(environment, replacement.key);
          }
          $("#info-dialog").close();
          render();
          toast(
            button.dataset.scenario === "disconnect"
              ? "所选通道开始独立恢复。"
              : "新实例已被发现。旧任务保留原身份，未自动重放。",
          );
        } catch (error) {
          toast(error.message);
        }
      }),
    );
  }
  function toolFields() {
    const value = $("#diagnose-tool").value,
      method = ["trace", "watch"].includes(value),
      expression = ["watch", "ognl"].includes(value);
    $("#method-fields").hidden = !method;
    $$("#method-fields input").forEach((input) => {
      input.disabled = !method;
      input.required = method;
    });
    $("#expression-field").hidden = !expression;
    $("#expression").disabled = !expression;
    if (value === "ognl")
      $("#expression").value = '@java.lang.System@getProperty("java.version")';
    else if (value === "watch")
      $("#expression").value = "{params, returnObj, throwExp}";
  }
  function prepareDiagnosis(keys, source = "web") {
    const pods = [...new Set(keys)].map(podFor);
    if (!pods.length || pods.some((p) => !p || p.retired)) {
      toast("目标已更替，请重新选择当前实例。");
      return;
    }
    if (pods.some((p) => p.channel === "offline")) {
      toast("本机助手离线，暂不可诊断。");
      return;
    }
    if (pods.some((p) => p.channel !== "ready")) {
      if (pods.length > 1) {
        toast("批量诊断前，请先连接所有所选目标。");
        return;
      }
      const pod = pods[0];
      try {
        store.connect(pod.key);
      } catch (error) {
        toast(error.message);
        return;
      }
      pendingConnection = { key: pod.key, tool, source };
      render();
      showInfo(
        "正在准备诊断通道",
        `<div class="target-summary"><strong>${escape(pod.name)}</strong>${escape(scopeLabel(pod))} · JVM g${pod.generation}</div><div class="state-message"><span class="spinner"></span><div><strong>模拟识别与连接…</strong><span>约 2 秒后进入诊断配置，不访问真实进程。</span></div></div>`,
        "PREPARE TARGET",
      );
      return;
    }
    dialogSource = source;
    dialogTargets = pods.map((p) => ({
      key: p.key,
      generation: p.generation,
      podUid: p.podUid,
    }));
    $("#diagnose-title").textContent =
      source === "mcp" ? "演示 MCP 多目标诊断" : "发起诊断";
    $("#diagnose-targets").innerHTML =
      `<strong>${escape(environmentName(pods[0].environment))} · ${pods.length} 个固定目标</strong>${pods.map((p) => `<code>${escape(p.namespace || "本机")} / ${escape(p.name)} · g${p.generation}</code>`).join("")}`;
    $("#submission-context").innerHTML =
      `${badge(source)}<span>${source === "mcp" ? "模拟 IDE 客户端提交；不会连接模型或外部 MCP 服务。" : "Web 工作台提交；与 MCP 调用共用任务记录。"}</span>`;
    $("#run-title").value =
      `${source === "mcp" ? "MCP" : "Web"} · ${pods.length > 1 ? "多目标" : pods[0].workloadName || "本机"}诊断`;
    $("#diagnose-tool").value = source === "mcp" ? "thread" : tool;
    $("#run-concurrency").value = "2";
    $("#diagnose-error").textContent = "";
    toolFields();
    $("#diagnose-dialog").showModal();
  }
  function simulateMcp() {
    const keys = checked.size
      ? [...checked]
      : visiblePods()
          .filter((p) => p.channel === "ready")
          .slice(0, 3)
          .map((p) => p.key);
    if (!keys.length) {
      toast("当前环境没有可诊断目标，请先接入或切换环境。");
      return;
    }
    prepareDiagnosis(keys, "mcp");
  }
  $("#diagnose-form").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      if (!dialogTargets.length) throw new Error("请选择诊断目标。");
      const pods = dialogTargets.map((target) => {
        const pod = podFor(target.key);
        if (
          !pod ||
          pod.retired ||
          pod.generation !== target.generation ||
          pod.podUid !== target.podUid ||
          pod.channel !== "ready"
        )
          throw new Error("目标状态已变化，请关闭配置后重新选择。");
        return pod;
      });
      const selectedTool = $("#diagnose-tool").value,
        parameters = {};
      if (["trace", "watch"].includes(selectedTool)) {
        parameters.classPattern = $("#class-pattern").value.trim();
        parameters.methodPattern = $("#method-pattern").value.trim();
        parameters.timeoutSeconds = Number($("#task-timeout").value);
      }
      if (["watch", "ognl"].includes(selectedTool))
        parameters.expression = $("#expression").value;
      const run = store.startRun(
        pods.map((p) => p.key),
        selectedTool,
        parameters,
        {
          source: dialogSource,
          client:
            dialogSource === "mcp" ? "IDE MCP 客户端（模拟）" : "Web 工作台",
          title: $("#run-title").value.trim(),
          concurrency: Number($("#run-concurrency").value),
        },
      );
      runTasks(run).forEach((task) =>
        taskByTool.set(`${task.target.key}/${task.tool}`, task.id),
      );
      selected = pods[0].key;
      tool = selectedTool;
      checked.clear();
      $("#diagnose-dialog").close();
      if (pods.length > 1 || dialogSource === "mcp") {
        runDetail = run.id;
        taskDetail = null;
        page = "tasks";
        render();
        $("#run-detail").scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      } else {
        tab = "instances";
        render();
        $("#diagnostic-workspace").scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      }
      toast(
        `诊断批次已创建：${pods.length} 个目标，最多并行 ${run.concurrency} 个。`,
      );
    } catch (error) {
      $("#diagnose-error").textContent = error.message;
    }
  });
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制。");
    } catch {
      showInfo(
        "复制内容",
        `<p class="body-copy">浏览器未允许剪贴板访问，可选中以下内容复制。</p><pre class="raw-result">${escape(text)}</pre>`,
        "COPY",
      );
    }
  }
  function openRun(id) {
    runDetail = id;
    taskDetail = null;
    page = "tasks";
    closeNavigation();
    render();
    $("#run-detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button,[data-copy]");
    if (!button || button.disabled) return;
    const data = button.dataset;
    try {
      if ("close" in data) {
        button.closest("dialog")?.close();
        return;
      }
      if (data.page) {
        showPage(data.page);
        return;
      }
      if (data.environment) {
        changeEnvironment(data.environment);
        return;
      }
      if (data.workload) {
        workload = data.workload;
        node = "all";
        page = "workspace";
        tab = "instances";
        scopeChanged();
        closeNavigation();
        return;
      }
      if (data.select) {
        selectPod(data.select);
        return;
      }
      if (data.tool) {
        tool = data.tool;
        renderResult();
        return;
      }
      if (data.tab) {
        tab = data.tab;
        renderHeading();
        return;
      }
      if (data.diagnose) {
        prepareDiagnosis([data.diagnose]);
        return;
      }
      if (data.connect) {
        store.connect(data.connect);
        render();
        toast("正在模拟连接，约 2 秒后就绪。");
        return;
      }
      if (data.cancel) {
        store.cancelTask(data.cancel);
        render();
        toast("此子任务已取消，其他目标继续执行。");
        return;
      }
      if (data.cancelRun) {
        store.cancelRun(data.cancelRun);
        render();
        toast("批次内排队与进行中的任务已取消，已完成结果保留。");
        return;
      }
      if (data.openRun) {
        openRun(data.openRun);
        return;
      }
      if (data.openTask) {
        const task = state.tasks.find((item) => item.id === data.openTask);
        if (!task) return;
        taskDetail = task.id;
        runDetail = task.runId;
        page = "tasks";
        render();
        $("#task-result").scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
        return;
      }
      if (data.runParameters) {
        const run = state.runs.find((item) => item.id === data.runParameters);
        showInfo(
          "批次参数快照",
          `<p class="body-copy">所有子任务使用相同参数；目标集合在提交时固定。</p><pre class="raw-result">${escape(JSON.stringify({ source: run.source, client: run.client, tool: run.tool, parameters: run.parameters, concurrency: run.concurrency }, null, 2))}</pre>`,
          "RUN PARAMETERS",
        );
        return;
      }
      if (data.taskTab) {
        taskByTool.set(`${selected}/${tool}`, data.taskTab);
        renderResult();
        return;
      }
      if (data.raw) {
        const pre = button
          .closest(".result-workspace,.standalone-result")
          .querySelector(".raw-result");
        if (pre) {
          pre.hidden = !pre.hidden;
          button.setAttribute("aria-expanded", !pre.hidden);
        }
        return;
      }
      if (data.copy) {
        copy($(`#${data.copy}`).textContent);
        return;
      }
      if (data.copyResult) {
        const task = state.tasks.find((item) => item.id === data.copyResult);
        copy(
          JSON.stringify({ target: task.target, result: task.result }, null, 2),
        );
        return;
      }
      if (button.id === "close-task-result") {
        taskDetail = null;
        renderAllTasks();
        return;
      }
      if (button.id === "close-run-detail") {
        runDetail = null;
        taskDetail = null;
        renderAllTasks();
        return;
      }
      if (button.id === "environment-mcp-demo") simulateMcp();
    } catch (error) {
      toast(error.message);
    }
  });
  $("#environment").innerHTML = ["k8s", "local"]
    .map(
      (kind) =>
        `<optgroup label="${kind === "k8s" ? "Kubernetes 集群" : "本机设备"}">${options(
          state.environments
            .filter((env) => env.kind === kind)
            .map((env) => [
              env.id,
              env.name + (env.online === false ? " · 离线" : ""),
            ]),
          environment,
        )}</optgroup>`,
    )
    .join("");
  $("#environment").addEventListener("change", () =>
    changeEnvironment($("#environment").value),
  );
  $("#all-targets-view").addEventListener("click", () => {
    tab = "instances";
    clearFilters();
    scopeChanged();
    closeNavigation();
  });
  $("#reset-filters").addEventListener("click", () => {
    clearFilters();
    scopeChanged();
  });
  $("#app-search").addEventListener("input", renderNavigation);
  $("#namespace-filter").addEventListener("change", () => {
    namespace = $("#namespace-filter").value;
    workload = "all";
    node = "all";
    scopeChanged();
  });
  $("#workload-filter").addEventListener("change", () => {
    workload = $("#workload-filter").value;
    node = "all";
    scopeChanged();
  });
  $("#node-filter").addEventListener("change", () => {
    node = $("#node-filter").value;
    scopeChanged();
  });
  $("#pod-search").addEventListener("input", scopeChanged);
  $("#channel-filter").addEventListener("change", scopeChanged);
  $("#node-group").addEventListener("change", () => {
    pageIndex = 0;
    renderPods();
  });
  $("#previous-page").addEventListener("click", () => {
    pageIndex--;
    renderPods();
  });
  $("#next-page").addEventListener("click", () => {
    pageIndex++;
    renderPods();
  });
  $("#pod-rows").addEventListener("change", (event) => {
    const key = event.target.dataset.selectPod;
    if (key) {
      event.target.checked ? checked.add(key) : checked.delete(key);
      renderPods();
    }
  });
  $("#select-all").addEventListener("change", (event) => {
    pagePods()
      .filter((p) => p.channel === "ready")
      .forEach((p) =>
        event.target.checked ? checked.add(p.key) : checked.delete(p.key),
      );
    renderPods();
  });
  $("#task-search").addEventListener("input", renderAllTasks);
  $("#task-status-filter").addEventListener("change", renderAllTasks);
  $("#task-source-filter").addEventListener("change", renderAllTasks);
  $("#diagnose-tool").addEventListener("change", toolFields);
  $("#diagnose-button").addEventListener("click", () =>
    prepareDiagnosis(checked.size ? [...checked] : [selected]),
  );
  $("#selected-diagnose").addEventListener("click", () =>
    prepareDiagnosis([...checked]),
  );
  $("#identity-button").addEventListener("click", openIdentity);
  $("#policy-button").addEventListener("click", openPolicy);
  $("#scenario-button").addEventListener("click", openScenarios);
  $("#simulate-mcp").addEventListener("click", simulateMcp);
  $("#refresh-button").addEventListener("click", () => {
    try {
      if (isLocal()) {
        const before = allPods().length;
        store.scanLocal(environment);
        render();
        toast(
          allPods().length > before
            ? "模拟扫描发现 1 个新增 JVM。"
            : "模拟扫描完成，暂无新增进程。",
        );
      } else {
        store.tick();
        render();
        toast("模拟目标状态已同步。");
      }
    } catch (error) {
      toast(error.message);
    }
  });
  $("#local-scan-button").addEventListener("click", () =>
    $("#refresh-button").click(),
  );
  $("#mobile-menu").addEventListener("click", () => {
    const open = !$("#sidebar").classList.contains("open");
    $("#sidebar").classList.toggle("open", open);
    $("#nav-scrim").hidden = !open;
    $("#mobile-menu").setAttribute("aria-expanded", open);
    syncNavigation();
    if (open) $("#environment").focus();
  });
  $("#nav-scrim").addEventListener("click", closeNavigation);
  $("#about-button").addEventListener("click", () =>
    showInfo(
      "环境、目标与诊断，清晰对应。",
      '<div class="info-copy"><p>v0.3 以集群或本机设备为环境，Namespace、工作负载和 Node 用于筛选，不要求先登记应用。</p><p>Web 与 MCP 来源的模拟调用共用诊断批次，逐目标排队、执行、取消和保留结果。不会实际调用 AI，也不生成分析结论。</p><p>全部名称、指标、进程和配置均为虚构。无真实 API 请求，刷新后恢复初始状态。后台保活、批量 MCP 和资源管理仍需正式实现。</p></div>',
      "PROTOTYPE / 0.3",
    ),
  );
  $("#info-dialog").addEventListener("close", () => (pendingConnection = null));
  $$("dialog").forEach((dialog) =>
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        const rect = dialog.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          dialog.close();
      }
    }),
  );
  $(".section-tabs").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = $$(".section-tabs>[data-tab]");
    let index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
            buttons.length;
    tab = buttons[index].dataset.tab;
    renderHeading();
    buttons[index].focus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeNavigation();
  });
  $("#mcp-config").textContent = JSON.stringify(
    {
      mcpServers: {
        "arthas-workbench": {
          type: "http",
          url: "https://workbench.example/mcp",
          headers: { Authorization: "Bearer <YOUR_USER_TOKEN>" },
        },
      },
    },
    null,
    2,
  );
  syncNavigation();
  render();
  setInterval(() => {
    store.tick();
    if (pendingConnection) {
      const pending = pendingConnection,
        pod = podFor(pending.key);
      if (pod?.channel === "ready" && !pod.retired) {
        pendingConnection = null;
        $("#info-dialog").close();
        tool = pending.tool;
        prepareDiagnosis([pending.key], pending.source);
      } else if (!pod || pod.retired) {
        pendingConnection = null;
        $("#info-dialog").close();
        toast("目标已经更替，请重新选择。");
      }
    }
    if (signature() !== lastSignature) render();
  }, 500);
})();
