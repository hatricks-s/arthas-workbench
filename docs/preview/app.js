/* Design prototype only. No fetch, credentials, real JVMs or Kubernetes access. */
(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  const icon = (name, small = false) =>
    `<svg class="icon${small ? " small" : ""}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const tools = {
    trace: ["方法追踪", "拆解一次方法调用，定位耗时发生在哪里。", "layers"],
    watch: ["方法观测", "观察方法执行时的入参、返回值与异常。", "search"],
    thread: ["线程分析", "查看活跃线程及调用栈，找到阻塞与热点。", "activity"],
    jvm: ["JVM 信息", "查看当前 Java 进程的运行信息。", "server"],
    memory: ["内存概览", "查看堆、元空间与直接内存的使用情况。", "grid"],
    ognl: ["表达式求值", "展示结构化求值结果，原型不会执行表达式。", "code"],
    sc: ["类检查", "查看已加载的类、类加载器与代码来源。", "file"],
    profiler: ["性能采样", "按采样占比查看调用热点。", "clock"],
  };
  const labels = {
    orders: "订单服务",
    payments: "支付服务",
    inventory: "库存服务",
    gateway: "API 网关",
  };
  const channelNames = {
    ready: ["已连接", "green"],
    reconnecting: ["重连中", "amber"],
    discovered: ["待接入", "gray"],
    retired: ["已替换", "red"],
  };
  const taskNames = {
    running: ["进行中", "blue"],
    succeeded: ["已完成", "green"],
    cancelled: ["已取消", "gray"],
    interrupted: ["已中断", "red"],
  };
  const store = window.WorkbenchDemo.createStore();
  const state = store.state;
  let page = "workspace",
    environment = "production",
    app = "orders",
    tab = "instances",
    tool = "trace";
  let selected = store.listPods(environment, app)[0].key;
  let checked = new Set(),
    selectionByContext = new Map(),
    taskByTool = new Map();
  let taskDetail = null,
    dialogTargets = [],
    toastTimer,
    lastSignature = "",
    pendingConnection = null;
  const context = () =>
    page === "local" ? ["local", "local"] : [environment, app];
  const currentPods = () => store.listPods(...context());
  const podFor = (key) => state.pods.find((pod) => pod.key === key);
  const selectedPod = () => podFor(selected);
  const environmentName = (id) =>
    state.environments.find((item) => item.id === id)?.name || "本机环境";
  const appName = (id) =>
    state.apps.find((item) => item.id === id)?.name || "本机 Java 进程";
  const date = (value) =>
    new Intl.DateTimeFormat("zh-CN", {
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
  const appTasks = () => {
    const [env, application] = context();
    return state.tasks.filter(
      (task) =>
        task.target.environment === env && task.target.app === application,
    );
  };
  const visiblePods = () =>
    currentPods().filter((pod) => {
      const query = $("#pod-search").value.trim().toLowerCase();
      return (
        (!query ||
          `${pod.name} ${pod.node} ${pod.pid}`.toLowerCase().includes(query)) &&
        ($("#channel-filter").value === "all" ||
          pod.channel === $("#channel-filter").value)
      );
    });
  function toast(message) {
    clearTimeout(toastTimer);
    $("#toast").textContent = message;
    $("#toast").hidden = false;
    toastTimer = setTimeout(() => {
      $("#toast").hidden = true;
    }, 4500);
  }
  const narrowNavigation = matchMedia("(max-width: 820px)");
  function syncNavigation() {
    const open = $("#sidebar").classList.contains("open");
    $("#sidebar").inert = narrowNavigation.matches && !open;
    $(".shell").inert = narrowNavigation.matches && open;
  }
  function closeNavigation() {
    const hadFocus = $("#sidebar").contains(document.activeElement);
    $("#sidebar").classList.remove("open");
    $("#nav-scrim").hidden = true;
    $("#mobile-menu").setAttribute("aria-expanded", "false");
    syncNavigation();
    if (hadFocus && narrowNavigation.matches) $("#mobile-menu").focus();
  }
  narrowNavigation.addEventListener("change", () => {
    closeNavigation();
    syncNavigation();
  });
  function resetSelection() {
    const key = context().join("/");
    const remembered = selectionByContext.get(key);
    selected = currentPods().some((pod) => pod.key === remembered)
      ? remembered
      : currentPods()[0]?.key;
    checked.clear();
    $("#pod-search").value = "";
    $("#channel-filter").value = "all";
  }
  function showPage(next) {
    if (page === "workspace" || page === "local")
      selectionByContext.set(context().join("/"), selected);
    page = next;
    if (
      (page === "workspace" || page === "local") &&
      !currentPods().some((pod) => pod.key === selected)
    )
      resetSelection();
    if (page === "workspace" || page === "local") tab = "instances";
    closeNavigation();
    render();
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function renderNavigation() {
    $$("[data-page]").forEach((button) => {
      const active = button.dataset.page === page;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    $("#app-navigation").hidden = !["workspace"].includes(page);
    $("#environment").value = environment;
    $(".environment-control").dataset.env = environment;
    const query = $("#app-search").value.toLowerCase().trim();
    $("#app-list").innerHTML =
      state.apps
        .filter((item) =>
          `${item.name} ${item.description}`.toLowerCase().includes(query),
        )
        .map(
          (item) =>
            `<button class="app-link${item.id === app ? " active" : ""}" data-app="${item.id}"${item.id === app ? ' aria-current="true"' : ""}><span class="app-indicator"></span><span>${escape(item.name)}</span><span class="app-quantity">${store.listPods(environment, item.id).length}</span></button>`,
        )
        .join("") || '<div class="empty-state compact">没有匹配的应用</div>';
    const count = state.tasks.filter(
      (task) => task.status === "running",
    ).length;
    $("#global-task-count").textContent = count;
    $("#breadcrumb-context").textContent =
      page === "local"
        ? "我的电脑"
        : page === "workspace"
          ? environmentName(environment)
          : "团队工作空间";
    $("#breadcrumb-page").textContent = {
      workspace: labels[app],
      local: "Java 进程",
      tasks: "诊断任务",
      mcp: "MCP 接入",
      settings: "资源与执行节点",
    }[page];
    for (const id of ["workspace", "tasks", "mcp", "settings"])
      $(`#${id}-page`).hidden =
        id === "workspace"
          ? !["workspace", "local"].includes(page)
          : page !== id;
  }
  function renderHeading() {
    const local = page === "local";
    const application = state.apps.find((item) => item.id === app);
    const env = state.environments.find((item) => item.id === environment);
    $("#application-category").textContent = local
      ? "LOCAL / 我的电脑"
      : `APPLICATION / ${labels[app]}`;
    $("#application-name").textContent = local
      ? "本机 Java 进程"
      : application.name;
    $("#application-description").textContent = local
      ? "通过本机助手发现进程，与集群诊断共用工作区。"
      : application.description;
    $("#application-meta").innerHTML = local
      ? `<span>${icon("monitor")}demo-workstation</span><span class="meta-divider"></span><span>${icon("link")}本机助手在线 · 模拟</span><span class="meta-divider"></span><span>仅当前用户的演示进程</span>`
      : `<span>${icon("layers")}${escape(env.cluster)}</span><span class="meta-divider"></span><span>${icon("box")}${escape(env.namespace)}</span><span class="meta-divider"></span><span class="meta-badge">Java ${escape(application.javaVersion)}</span><span class="meta-owner">${escape(application.owner)}</span>`;
    $("#instance-column-title").textContent = local
      ? "进程 / JVM"
      : "实例 / POD";
    $("#local-scan-button").hidden = !local;
    $("#refresh-button").title = local ? "扫描模拟 Java 进程" : "刷新模拟实例";
    $("#refresh-button").setAttribute("aria-label", $("#refresh-button").title);
    $("#pod-count").textContent = currentPods().length;
    $("#app-task-count").textContent = appTasks().length;
    $$(".section-tabs>[data-tab]").forEach((button) => {
      const active = button.dataset.tab === tab;
      button.setAttribute("aria-selected", active);
      button.tabIndex = active ? 0 : -1;
    });
    $("#instances-panel").hidden = tab !== "instances";
    $("#application-tasks-panel").hidden = tab !== "tasks";
    $("#events-panel").hidden = tab !== "events";
  }
  function renderPods() {
    let pods = visiblePods();
    const grouped = $("#node-group").value === "node";
    if (grouped) pods = [...pods].sort((a, b) => a.node.localeCompare(b.node));
    let previousNode;
    $("#pod-rows").innerHTML =
      pods
        .map((pod) => {
          let group = "";
          if (grouped && pod.node !== previousNode) {
            group = `<tr class="group-row"><td colspan="7">${escape(pod.node)} · ${pods.filter((item) => item.node === pod.node).length} 个实例</td></tr>`;
            previousNode = pod.node;
          }
          const running = state.tasks.filter(
            (task) => task.target.key === pod.key && task.status === "running",
          ).length;
          return `${group}<tr class="${pod.key === selected ? "selected" : ""}" data-pod-row="${escape(pod.key)}"><td class="selection-cell"><input type="checkbox" data-select-pod="${escape(pod.key)}" aria-label="选择 ${escape(pod.name)}" ${checked.has(pod.key) ? "checked" : ""} ${pod.channel !== "ready" ? "disabled" : ""}></td><td><button class="pod-name-button" data-select="${escape(pod.key)}" aria-label="查看 ${escape(pod.name)} 的诊断工作区">${icon(pod.kind === "local" ? "monitor" : "box")}<span>${escape(pod.name)}</span></button><div class="pod-secondary"><span>${pod.kind === "local" ? `PID ${pod.pid}` : escape(pod.container)}</span><span class="tiny-separator"></span><span>${escape(pod.age)}</span><span class="tiny-separator"></span><span>代次 ${pod.generation}</span></div></td><td><span class="node-label">${icon(pod.kind === "local" ? "monitor" : "server")}${escape(pod.node)}</span></td><td><span class="running-state"><span class="status-dot green"></span>Running</span></td><td>${status(pod.channel)}</td><td><span class="task-cell${running ? " active" : ""}">${running ? icon("activity") : ""}${running ? `${running} 进行中` : "—"}</span></td><td><button class="row-action" data-${pod.channel === "ready" ? "diagnose" : "connect"}="${escape(pod.key)}">${pod.channel === "ready" ? "诊断" : "连接"}${icon("arrow", true)}</button></td></tr>`;
        })
        .join("") ||
      '<tr class="empty-row"><td colspan="7">没有匹配的实例。调整搜索内容或连接状态筛选。</td></tr>';
    const ready = currentPods().filter((pod) => pod.channel === "ready").length;
    const managed = currentPods().filter((pod) => pod.managed).length;
    $("#instance-summary").textContent =
      `${pods.length} / ${currentPods().length} 个实例 · ${ready} 已连接 · ${managed} 已纳管${checked.size ? ` · 已选择 ${checked.size} 个` : ""}`;
    $("#selected-diagnose").hidden = !checked.size;
    $("#selected-diagnose").textContent = `诊断所选 ${checked.size} 个实例`;
    const available = pods.filter((pod) => pod.channel === "ready");
    $("#select-all").checked =
      available.length > 0 && available.every((pod) => checked.has(pod.key));
    $("#select-all").indeterminate =
      available.some((pod) => checked.has(pod.key)) &&
      !$("#select-all").checked;
    $("#select-all").disabled = !available.length;
  }
  function renderEvents() {
    const [env, application] = context();
    const events = state.events
      .filter((event) => event.environment === env && event.app === application)
      .slice()
      .reverse();
    $("#connection-events").innerHTML =
      events
        .map(
          (event) =>
            `<li><span class="event-dot ${escape(event.kind)}"></span><div><strong>${escape(event.title)}</strong><p>${escape(event.detail)}</p></div><time>${date(event.at)}</time></li>`,
        )
        .join("") ||
      "<li><div><strong>暂无连接事件</strong><p>连接、重连、任务提交与实例替换都会记录在这里。</p></div></li>";
  }
  function renderTasks(target, tasks) {
    $(target).innerHTML =
      tasks
        .slice()
        .reverse()
        .map(
          (task) =>
            `<article class="task-list-row"><span class="task-list-icon">${icon(tools[task.tool][2])}</span><div><h3>${escape(tools[task.tool][0])} <span class="tool-code">${escape(task.tool)}</span></h3><p>${escape(task.target.name)} · g${task.target.generation} · ${escape(task.id.replace("demo-task-", "#"))}</p></div><span class="task-env">${escape(task.target.environmentName)}<br>${escape(task.target.appName)}</span><span class="task-status">${status(task.status, "task")}</span><time>${date(task.createdAt)}</time><div class="task-list-actions"><button class="text-button" data-open-task="${task.id}">查看</button>${task.status === "running" ? `<button class="text-button" data-cancel="${task.id}">取消</button>` : ""}</div></article>`,
        )
        .join("") ||
      `<div class="empty-state compact">${icon("activity")}<h3>暂无匹配的诊断任务</h3><p>从实例发起诊断后，可以在这里跨环境追踪结果。</p></div>`;
  }
  function chosenTask() {
    const tasks = state.tasks.filter(
      (task) => task.target.key === selected && task.tool === tool,
    );
    const id = taskByTool.get(`${selected}/${tool}`);
    return tasks.find((task) => task.id === id) || tasks.at(-1);
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
        application: "所属应用",
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
      return `<div class="result-table-scroll"><table class="plain-table"><thead><tr><th>采样栈（模拟）</th><th>样本数</th><th>样本占比</th></tr></thead><tbody>${result.frames.map((row) => `<tr><td class="thread-name"><span class="tree-indent">${row.depth ? "　".repeat(row.depth - 1) + "└─" : ""}</span>${escape(row.name)}</td><td>${row.samples}</td><td>${row.percent}%</td></tr>`).join("")}</tbody></table></div>`;
    return "";
  }
  function taskResult(task, standalone = false) {
    const pod = podFor(task.target.key);
    const target = task.target;
    const targetLine = `<div class="result-target-line">${icon("box")}<span class="result-target-copy">${escape(target.environmentName)} / ${escape(target.name)} <span>· JVM g${target.generation}</span></span>${status(task.status, "task")}</div>`;
    let content;
    if (task.status === "running")
      content = `<div class="state-message"><span class="spinner"></span><div><strong>${pod?.channel === "reconnecting" ? "通道恢复中，保留原任务身份" : ["trace", "watch"].includes(task.tool) ? "等待目标方法执行…" : "正在收集模拟诊断结果…"}</strong><span>模拟任务可独立运行，切换页面不会改变执行目标。</span></div><button class="button secondary" data-cancel="${task.id}">${icon("stop")}取消任务</button></div>`;
    else if (task.status !== "succeeded")
      content = `<div class="state-message">${icon(task.status === "interrupted" ? "info" : "stop")}<div><strong>${task.status === "interrupted" ? "任务已中断，未自动重放" : "模拟任务已取消"}</strong><span>${task.status === "interrupted" ? "实例已更替或等待超时。历史目标与代次保留，不能转移到新 JVM。" : "结果不会在取消后继续写入。真实任务停止仍需目标端确认。"}</span></div></div>`;
    else
      content = `<div class="result-summary"><span class="sample-badge">模拟采样</span><span>${escape(task.result.summary.replace(/^模拟调用链：|^模拟线程快照：|^模拟 JVM 概览：/, ""))}</span></div>${resultData(task)}<div class="result-footnote"><span>${escape(task.id)} · ${date(task.finishedAt)} · 所有数值为示例</span><button class="text-button" data-raw="${task.id}" aria-expanded="false">原始结果 ${icon("code", true)}</button></div><pre class="raw-result" id="raw-${task.id}${standalone ? "-standalone" : ""}" hidden>${escape(JSON.stringify(task.result, null, 2))}</pre>`;
    return `${targetLine}${content}`;
  }
  function renderResult() {
    const pod = selectedPod();
    $("#diagnostic-workspace").hidden = !pod;
    if (!pod) return;
    $("#detail-pod").textContent = pod.name;
    $("#detail-subtitle").textContent =
      `${environmentName(pod.environment)} / ${pod.kind === "local" ? `PID ${pod.pid}` : pod.node} · JVM g${pod.generation}${pod.retired ? " · 原实例已替换" : ""}`;
    $$("[data-tool]").forEach((button) => {
      const active = button.dataset.tool === tool;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const task = chosenTask();
    const tasks = state.tasks.filter(
      (item) => item.target.key === selected && item.tool === tool,
    );
    let content = `<div class="result-heading"><div><h2>${tools[tool][0]}<span class="tool-code">${tool}</span></h2><p>${tools[tool][1]}</p></div><div class="result-heading-actions">${task?.status === "succeeded" ? `<button class="text-button" data-copy-result="${task.id}">${icon("copy", true)}复制</button>` : ""}<button class="button secondary" data-diagnose="${escape(selected)}">${icon("play")}${pod.channel === "ready" ? "运行诊断" : "连接并诊断"}</button></div></div>`;
    if (tasks.length > 1)
      content += `<div class="task-tabs" aria-label="该实例的历史任务">${tasks
        .slice(-6)
        .map(
          (item) =>
            `<button class="task-tab${item.id === task?.id ? " active" : ""}" data-task-tab="${item.id}" aria-pressed="${item.id === task?.id}"><span class="status-dot ${item.status === "succeeded" ? "green" : item.status === "running" ? "amber" : ""}"></span>${escape(item.id.replace("demo-task-", "#"))} · ${date(item.createdAt)}</button>`,
        )
        .join("")}</div>`;
    content += task
      ? taskResult(task)
      : `<div class="empty-state">${icon(tools[tool][2])}<h3>${pod.retired ? "原实例已替换" : `在此实例上开始${tools[tool][0]}`}</h3><p>${pod.retired ? "历史任务仍绑定原 UID；请在上方选择新实例。" : pod.channel === "ready" ? "配置诊断参数，结果会按任务保留。示例操作不会影响真实进程。" : "通道尚未就绪。模拟连接完成后，可在此配置诊断。"}</p><button class="button primary" data-diagnose="${escape(selected)}" ${pod.retired ? "disabled" : ""}>${icon("play")}${pod.channel === "ready" ? "配置诊断" : "连接并诊断"}</button></div>`;
    $("#result-content").innerHTML = content;
  }
  function renderAllTasks() {
    const query = $("#task-search").value.trim().toLowerCase(),
      filter = $("#task-status-filter").value;
    renderTasks(
      "#all-tasks",
      state.tasks.filter(
        (task) =>
          (filter === "all" || task.status === filter) &&
          (!query ||
            `${task.target.name} ${task.target.appName} ${task.target.environmentName} ${task.tool}`
              .toLowerCase()
              .includes(query)),
      ),
    );
    const task = state.tasks.find((task) => task.id === taskDetail);
    $("#task-result").hidden = !task;
    if (task)
      $("#task-result").innerHTML =
        `<div class="result-heading"><div><h2>${tools[task.tool][0]}<span class="tool-code">${task.tool}</span></h2><p>此结果绑定提交时的目标，独立于当前导航环境。</p></div><button class="icon-button" id="close-task-result" aria-label="关闭任务结果">${icon("close")}</button></div><div class="task-result-label">${escape(task.target.podUid)} · ${escape(task.id)}</div>${taskResult(task, true)}`;
  }
  function signature() {
    return JSON.stringify([
      state.pods.map((p) => [p.key, p.channel, p.managed, p.retired]),
      state.tasks.map((t) => [t.id, t.status]),
      state.events.length,
      state.policies,
    ]);
  }
  function render() {
    renderNavigation();
    if (page === "workspace" || page === "local") {
      renderHeading();
      renderPods();
      renderTasks("#application-tasks", appTasks());
      renderEvents();
      renderResult();
    }
    if (page === "tasks") renderAllTasks();
    lastSignature = signature();
  }
  function selectPod(key) {
    selected = key;
    selectionByContext.set(context().join("/"), key);
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
      ["应用", appName(pod.app)],
      ["实例名称", pod.name],
      ["Pod / 进程 UID", pod.podUid],
      ["JVM 代次", `g${pod.generation}`],
      ["容器 / PID", `${pod.container} / ${pod.pid}`],
      ["K8s Node", pod.kind === "k8s" ? pod.node : "不适用"],
      ["执行节点", pod.connector],
      ["通道状态", channelNames[pod.channel][0]],
    ];
    showInfo(
      "实例身份",
      `<dl class="identity-grid">${pairs.map(([key, value]) => `<dt>${key}</dt><dd>${escape(value)}</dd>`).join("")}</dl><div class="inline-note">同名实例重建后会生成新的 UID。已提交任务不会转移到新实例。</div>`,
      "TARGET IDENTITY",
    );
  }
  function openPolicy() {
    const [env, application] = context();
    const current = state.policies[`${env}/${application}`];
    const options = [
      [
        "selected",
        "维护已接入实例",
        "已纳管的每个实例独立保活；新发现的副本等待明确接入。",
      ],
      [
        "all",
        "维护应用的全部副本",
        "接入当前全部副本，并纳管之后发现的新副本。真实部署需配额和权限。",
      ],
      [
        "discover",
        "仅发现，不维护连接",
        "停止此应用的连接维护。存在进行中任务时不可切换。",
      ],
    ];
    showInfo(
      "连接维护策略",
      `<p class="body-copy">${escape(environmentName(env))} / ${escape(appName(application))}</p><form id="policy-form">${options.map(([value, title, description]) => `<label class="policy-option"><input type="radio" name="policy" value="${value}" ${value === current ? "checked" : ""}><span><strong>${title}</strong><p>${description}</p></span></label>`).join("")}<div class="inline-note">当前保活和恢复均在浏览器中模拟。正式产品由后台维护，不依赖网页是否打开。</div><p id="policy-error" class="form-error" role="alert"></p><div class="dialog-footer"><button class="button secondary" type="button" data-close>取消</button><button class="button primary" type="submit">应用模拟策略</button></div></form>`,
      "CONNECTION POLICY",
    );
    $("#policy-form").addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        store.setPolicy(
          env,
          application,
          new FormData(event.currentTarget).get("policy"),
        );
        $("#info-dialog").close();
        render();
        toast("模拟连接策略已更新。");
      } catch (error) {
        $("#policy-error").textContent = error.message;
      }
    });
  }
  function openScenarios() {
    const pod = selectedPod();
    if (!pod || pod.retired) {
      toast("请先选择一个当前实例。");
      return;
    }
    showInfo(
      "体验连接生命周期",
      `<div class="target-summary"><strong>${escape(pod.name)}</strong>${escape(environmentName(pod.environment))} · JVM g${pod.generation}</div><p class="field-hint">仅操作所选模拟实例。可先发起 Watch，再体验重连或重建。</p><div class="scenario-options"><button class="scenario-option" data-scenario="disconnect" ${!pod.managed ? "disabled" : ""}>${icon("refresh")}<span><strong>模拟短暂断线</strong><small>单条通道约 5 秒后恢复，其他实例不受影响。</small></span>${icon("arrow")}</button><button class="scenario-option" data-scenario="replace">${icon("box")}<span><strong>模拟同名实例重建</strong><small>UID 与 JVM 代次变化，旧任务中断，不自动重放。</small></span>${icon("arrow")}</button></div><div class="dialog-footer"><button class="button secondary" data-close>返回工作台</button></div>`,
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
            selectionByContext.set(context().join("/"), replacement.key);
          }
          $("#info-dialog").close();
          render();
          toast(
            button.dataset.scenario === "disconnect"
              ? "所选通道已模拟断开，将独立恢复。"
              : "发现同名新实例。下方保留旧任务，上方可选择新代次。",
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
  function prepareDiagnosis(keys) {
    const pods = keys.map(podFor).filter(Boolean);
    if (!pods.length || pods.some((pod) => pod.retired)) {
      toast("目标已替换，请重新选择当前实例。");
      return;
    }
    if (pods.some((pod) => pod.channel !== "ready")) {
      if (pods.length > 1) {
        toast("批量诊断前请先连接全部所选实例。");
        return;
      }
      const pod = pods[0];
      store.connect(pod.key);
      pendingConnection = { key: pod.key, tool };
      render();
      showInfo(
        "正在准备诊断通道",
        `<div class="target-summary"><strong>${escape(pod.name)}</strong>${escape(environmentName(pod.environment))} · JVM g${pod.generation}</div><div class="state-message"><span class="spinner"></span><div><strong>模拟识别与连接…</strong><span>约 2 秒后进入诊断配置，不会访问真实进程。</span></div></div>`,
        "PREPARE TARGET",
      );
      return;
    }
    dialogTargets = pods.map((pod) => ({
      key: pod.key,
      generation: pod.generation,
      podUid: pod.podUid,
    }));
    $("#diagnose-targets").innerHTML =
      `<strong>${escape(environmentName(pods[0].environment))} / ${escape(appName(pods[0].app))} · ${pods.length} 个目标</strong>${pods.map((pod) => `<code>${escape(pod.name)} · JVM g${pod.generation}</code>`).join("")}`;
    $("#diagnose-tool").value = tool;
    $("#diagnose-error").textContent = "";
    toolFields();
    $("#diagnose-dialog").showModal();
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
      const selectedTool = $("#diagnose-tool").value;
      const parameters = {};
      if (["trace", "watch"].includes(selectedTool)) {
        parameters.classPattern = $("#class-pattern").value.trim();
        parameters.methodPattern = $("#method-pattern").value.trim();
        parameters.timeoutSeconds = Number($("#task-timeout").value);
      }
      if (["watch", "ognl"].includes(selectedTool))
        parameters.expression = $("#expression").value;
      // Prevalidate the whole group before creating any child task.
      if (
        ["trace", "watch"].includes(selectedTool) &&
        (!parameters.classPattern ||
          !parameters.methodPattern ||
          !Number.isInteger(parameters.timeoutSeconds) ||
          parameters.timeoutSeconds < 5 ||
          parameters.timeoutSeconds > 120)
      )
        throw new Error("请填写类名、方法名，以及 5–120 秒的整数等待上限。");
      if (
        state.tasks.filter((task) => task.status === "running").length +
          pods.length >
        100
      )
        throw new Error("模拟任务数量已达上限，请先完成或取消部分任务。");
      const tasks = pods.map((pod) =>
        store.startTask(pod.key, selectedTool, parameters),
      );
      tasks.forEach((task) =>
        taskByTool.set(`${task.target.key}/${task.tool}`, task.id),
      );
      selected = pods[0].key;
      tool = selectedTool;
      tab = "instances";
      checked.clear();
      $("#diagnose-dialog").close();
      render();
      toast(
        tasks.length > 1
          ? `已创建 ${tasks.length} 个独立任务，可在诊断任务中分别查看与取消。`
          : "模拟诊断已开始，可继续切换应用或环境。",
      );
      $("#diagnostic-workspace").scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
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
        `<p class="body-copy">当前浏览器未允许剪贴板访问，可选中下方内容复制。</p><pre class="raw-result">${escape(text)}</pre>`,
        "COPY",
      );
    }
  }
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button,[data-copy]");
    if (!button) return;
    const data = button.dataset;
    if ("close" in data) {
      button.closest("dialog")?.close();
      return;
    }
    if (data.page) {
      showPage(data.page);
      return;
    }
    if (data.app) {
      selectionByContext.set(context().join("/"), selected);
      app = data.app;
      page = "workspace";
      tab = "instances";
      resetSelection();
      closeNavigation();
      render();
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
      toast("模拟任务已取消。");
      return;
    }
    if (data.openTask) {
      taskDetail = data.openTask;
      page = "tasks";
      render();
      $("#task-result").scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
      return;
    }
    if (data.taskTab) {
      const task = state.tasks.find((task) => task.id === data.taskTab);
      if (task) {
        taskByTool.set(`${selected}/${tool}`, task.id);
        renderResult();
      }
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
      const task = state.tasks.find((task) => task.id === data.copyResult);
      copy(
        JSON.stringify({ target: task.target, result: task.result }, null, 2),
      );
      return;
    }
    if (button.id === "close-task-result") {
      taskDetail = null;
      renderAllTasks();
    }
  });
  $("#environment").addEventListener("change", () => {
    selectionByContext.set(context().join("/"), selected);
    environment = $("#environment").value;
    page = "workspace";
    tab = "instances";
    resetSelection();
    render();
  });
  $("#app-search").addEventListener("input", renderNavigation);
  $("#pod-search").addEventListener("input", renderPods);
  $("#channel-filter").addEventListener("change", renderPods);
  $("#node-group").addEventListener("change", renderPods);
  $("#pod-rows").addEventListener("change", (event) => {
    const key = event.target.dataset.selectPod;
    if (key) {
      event.target.checked ? checked.add(key) : checked.delete(key);
      renderPods();
    }
  });
  $("#select-all").addEventListener("change", (event) => {
    visiblePods()
      .filter((pod) => pod.channel === "ready")
      .forEach((pod) =>
        event.target.checked ? checked.add(pod.key) : checked.delete(pod.key),
      );
    renderPods();
  });
  $("#task-search").addEventListener("input", renderAllTasks);
  $("#task-status-filter").addEventListener("change", renderAllTasks);
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
  $("#refresh-button").addEventListener("click", () => {
    if (page === "local") {
      const before = currentPods().length;
      store.scanLocal();
      render();
      toast(
        currentPods().length > before
          ? "模拟扫描完成，发现 1 个新 JVM。"
          : "模拟扫描完成，暂无新进程。",
      );
    } else {
      store.tick();
      render();
      toast("模拟实例状态已同步。");
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
      "一个工作台，明确每一个目标。",
      '<div class="info-copy"><p>这是 Arthas Workbench 的交互设计原型，展示多环境应用、多副本诊断、连接维护与任务生命周期。</p><p>全部进程、集群、指标与操作均为模拟。页面不发送 API 请求，不访问本机进程，刷新会恢复初始场景。</p><p>环境模型、独立保活、OGNL、Profiler、资源下发和持久任务仍需后端实现；现有双链路运行原型的能力以项目文档为准。</p></div>',
      "PROTOTYPE / 0.2",
    ),
  );
  $("#info-dialog").addEventListener("close", () => {
    pendingConnection = null;
  });
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
        prepareDiagnosis([pending.key]);
      } else if (!pod || pod.retired) {
        pendingConnection = null;
        $("#info-dialog").close();
        toast("目标已经更替，请重新选择。");
      }
    }
    if (signature() !== lastSignature) render();
  }, 500);
})();
