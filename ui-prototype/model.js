(function (root) {
  "use strict";

  const TOOLS = [
    "jvm",
    "memory",
    "thread",
    "trace",
    "watch",
    "ognl",
    "sc",
    "profiler",
  ];
  const LIMIT = 100;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  function freeze(value) {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }

  function createStore({ now = () => Date.now() } = {}) {
    const startedAt = now();
    const state = {
      environments: [
        {
          id: "production",
          name: "生产环境",
          kind: "k8s",
          clusterId: "demo-cluster-production",
          cluster: "demo-production",
          namespace: "commerce",
        },
        {
          id: "staging",
          name: "预发环境",
          kind: "k8s",
          clusterId: "demo-cluster-staging",
          cluster: "demo-staging",
          namespace: "commerce",
        },
        {
          id: "development",
          name: "开发环境",
          kind: "k8s",
          clusterId: "demo-cluster-development",
          cluster: "demo-development",
          namespace: "commerce",
        },
        {
          id: "local",
          name: "开发工作站",
          kind: "local",
          device: "dev-workstation",
          online: true,
          cluster: null,
        },
        {
          id: "local-build",
          name: "构建工作站",
          kind: "local",
          device: "build-workstation",
          online: false,
          cluster: null,
        },
      ],
      apps: [
        {
          id: "orders",
          name: "order-service",
          description: "订单创建与履约服务",
          namespace: "commerce",
          kind: "Deployment",
          owner: "Commerce team",
          javaVersion: "21.0.5",
        },
        {
          id: "payments",
          name: "payment-service",
          description: "支付处理与账单服务",
          namespace: "commerce",
          kind: "Deployment",
          owner: "Payments team",
          javaVersion: "21.0.5",
        },
        {
          id: "inventory",
          name: "inventory-service",
          description: "库存预留与仓储服务",
          namespace: "commerce",
          kind: "Deployment",
          owner: "Supply team",
          javaVersion: "21.0.5",
        },
        {
          id: "gateway",
          name: "api-gateway",
          description: "应用入口与请求路由",
          namespace: "platform",
          kind: "Deployment",
          owner: "Platform team",
          javaVersion: "21.0.5",
        },
        {
          id: "orders-lab",
          name: "order-service",
          description: "沙箱订单工作负载（同名、不同命名空间）",
          namespace: "sandbox",
          kind: "Deployment",
          owner: "Demo lab",
          javaVersion: "17.0.13",
        },
      ],
      pods: [],
      runs: [],
      tasks: [],
      events: [],
      policies: {},
    };
    const connections = new Map();
    const readySince = new Map();
    const dueAt = new Map();
    const runTiming = new Map();
    let taskSequence = 0;
    let runSequence = 0;
    let eventSequence = 0;
    const localScanned = new Set();
    const policyKey = (environment, app) => `${environment}/${app}`;
    const pending = (task) => ["queued", "running"].includes(task.status);
    const identityFields = [
      "key",
      "environment",
      "clusterId",
      "device",
      "namespace",
      "app",
      "workloadName",
      "workloadKind",
      "podUid",
      "generation",
      "container",
      "containerId",
      "pid",
      "jvmIdentity",
    ];
    const sameIdentity = (pod, target) =>
      pod &&
      !pod.retired &&
      identityFields.every((field) => pod[field] === target[field]);
    const environmentFor = (id) =>
      state.environments.find((item) => item.id === id);
    const online = (pod) => environmentFor(pod.environment)?.online !== false;
    function requireOnline(environment) {
      if (environment?.online === false)
        throw new Error("本地设备离线 (offline device)");
    }

    for (const environment of state.environments.filter(
      (item) => item.kind === "k8s",
    )) {
      for (const app of state.apps) {
        state.policies[policyKey(environment.id, app.id)] = "selected";
        const count =
          app.id === "orders"
            ? { production: 6, staging: 3, development: 2 }[environment.id]
            : 2;
        for (let index = 0; index < count; index++) {
          const channel =
            environment.id === "production" && app.id === "orders"
              ? index === 4
                ? "reconnecting"
                : index === 5
                  ? "discovered"
                  : "ready"
              : index === count - 1
                ? "discovered"
                : "ready";
          const node = `worker-0${(index % 3) + 1}`;
          const containerId = `containerd://demo-${environment.id}-${app.id}-${index}-g1`;
          const containers = [
            {
              name: app.name,
              role: "application",
              state: "running",
              javaCandidate: true,
            },
          ];
          if (
            environment.id === "production" &&
            app.id === "orders" &&
            index === 0
          )
            containers.push({
              name: "init-config",
              role: "init",
              state: "completed",
              javaCandidate: false,
            });
          state.pods.push({
            key: `${environment.id}-${app.id}-${index}-g1`,
            environment: environment.id,
            app: app.id,
            kind: "k8s",
            name: `${app.name}-7d8b9c6f5d-${String(index + 1).padStart(5, "0")}`,
            clusterId: environment.clusterId,
            cluster: environment.cluster,
            namespace: app.namespace,
            workloadName: app.name,
            workloadKind: app.kind,
            javaVersion: app.javaVersion,
            containerCount: containers.length,
            readyContainers: 1,
            containers,
            containerId,
            jvmIdentity: `${containerId}/pid-1`,
            javaCandidate: true,
            podUid: `demo-uid-${environment.id}-${app.id}-${index}-g1`,
            generation: 1,
            node,
            connector:
              environment.id === "production"
                ? "cluster-connector-prod"
                : "cluster-connector-nonprod",
            container: app.name,
            pid: 1,
            channel,
            managed: channel !== "discovered",
            restarts: index % 2,
            age: `${index + 2}天`,
            retired: false,
          });
        }
      }
    }
    function localPod(environment, pid, name, channel) {
      return {
        key: `${environment.id}-jvm-${pid}-g1`,
        environment: environment.id,
        app: "local",
        kind: "local",
        name,
        cluster: null,
        clusterId: null,
        namespace: null,
        workloadName: name,
        workloadKind: "JavaProcess",
        device: environment.device,
        podUid: `demo-${environment.device}-${pid}-g1`,
        generation: 1,
        node: environment.device,
        connector: environment.device,
        container: "本机 JVM",
        containerId: null,
        containerCount: 0,
        readyContainers: 0,
        containers: [],
        javaCandidate: true,
        javaVersion: pid === 28120 ? "17.0.13" : "21.0.5",
        jvmIdentity: `${environment.device}/pid-${pid}-g1`,
        pid,
        channel,
        managed: channel === "ready",
        restarts: 0,
        age: "42分钟",
        retired: false,
      };
    }
    for (const environment of state.environments.filter(
      (item) => item.kind === "local",
    )) {
      state.pods.push(
        localPod(
          environment,
          24080,
          "demo.OrderApplication",
          environment.online ? "ready" : "offline",
        ),
        localPod(
          environment,
          28120,
          "demo.InventoryApplication",
          environment.online ? "discovered" : "offline",
        ),
      );
      state.policies[policyKey(environment.id, "local")] = "selected";
    }
    state.pods
      .filter((pod) => pod.channel === "ready")
      .forEach((pod) => readySince.set(pod.key, startedAt));

    function listPods(environment, app = "all") {
      return state.pods.filter(
        (pod) =>
          !pod.retired &&
          pod.environment === environment &&
          (app === "all" || pod.app === app),
      );
    }
    function livePod(key) {
      const pod = state.pods.find((item) => item.key === key);
      if (!pod) throw new Error("目标不存在 (unknown target)");
      if (pod.retired) throw new Error("目标已被替换 (retired target)");
      return pod;
    }
    function addEvent(kind, title, detail, target, at = now()) {
      state.events.push({
        id: `demo-event-${++eventSequence}`,
        at,
        kind,
        title,
        detail,
        targetKey: target.key || null,
        environment: target.environment,
        app: target.app,
      });
      if (state.events.length > LIMIT)
        state.events.splice(0, state.events.length - LIMIT);
    }
    function snapshot(pod) {
      return freeze(
        clone({
          ...pod,
          environmentName:
            state.environments.find((item) => item.id === pod.environment)
              ?.name || "本机环境",
          appName:
            state.apps.find((item) => item.id === pod.app)?.name ||
            "本机 Java 进程",
        }),
      );
    }

    function resultFor(task, at) {
      const { target, parameters, tool } = task;
      const variant =
        Array.from(target.key).reduce(
          (sum, char) => sum + char.charCodeAt(0),
          0,
        ) % 7;
      const javaVersion = target.javaVersion || "21.0.5";
      const className = `demo.${target.app}.ApplicationService`;
      const method = `${parameters.classPattern || className}.${parameters.methodPattern || "execute"}()`;
      const result = { simulated: true, tool, summary: "", rows: [] };
      switch (tool) {
        case "jvm": {
          result.summary = `模拟 JVM 概览：Java ${javaVersion}，进程运行正常。`;
          result.jvm = {
            name: "OpenJDK 64-Bit Server VM",
            javaVersion,
            pid: target.pid,
            application: target.appName,
            uptime: "2天 4小时",
            processors: 4,
            arguments: "-Xms512m -Xmx1g",
          };
          result.rows = Object.entries(result.jvm).map(([name, value]) => ({
            name,
            value,
          }));
          break;
        }
        case "memory":
          result.summary = `模拟内存快照：堆使用率 ${37.5 + variant * 3.125}%，无真实采样。`;
          result.memory = [
            {
              name: "heap",
              used: `${384 + variant * 32} MiB`,
              committed: "768 MiB",
              max: "1024 MiB",
              usage: 37.5 + variant * 3.125,
            },
            {
              name: "metaspace",
              used: "96 MiB",
              committed: "112 MiB",
              max: "256 MiB",
              usage: 37.5,
            },
            {
              name: "direct",
              used: "24 MiB",
              committed: "32 MiB",
              max: "128 MiB",
              usage: 18.75,
            },
          ];
          result.rows = result.memory;
          break;
        case "thread":
          result.summary = "模拟线程快照：展示 3 个线程及示例调用栈。";
          result.threads = [
            {
              id: 41,
              name: "http-nio-8080-exec-3",
              state: "RUNNABLE",
              cpu: Number((12.4 + variant * 3.1).toFixed(1)),
              stack: [
                `${className}.execute(ApplicationService.java:84)`,
                "demo.web.RequestHandler.handle(RequestHandler.java:32)",
              ],
            },
            {
              id: 27,
              name: "demo-scheduler-1",
              state: "TIMED_WAITING",
              cpu: 0.6,
              stack: [
                "java.lang.Thread.sleep(Thread.java:509)",
                "demo.jobs.SampleJob.run(SampleJob.java:25)",
              ],
            },
            {
              id: 12,
              name: "demo-pool-1",
              state: "WAITING",
              cpu: 0.1,
              stack: [
                "java.util.concurrent.locks.LockSupport.park(LockSupport.java:221)",
              ],
            },
          ];
          result.rows = result.threads;
          break;
        case "trace":
          result.summary = "模拟调用链：总耗时 84.6 ms，库存查询占 72.6%。";
          result.trace = [
            { depth: 0, method, ms: 84.6, percent: 100 },
            {
              depth: 1,
              method: "demo.orders.OrderValidator.validate()",
              ms: 3.2,
              percent: 3.8,
            },
            {
              depth: 1,
              method: "demo.inventory.InventoryClient.reserve()",
              ms: 61.4,
              percent: 72.6,
            },
            {
              depth: 2,
              method: "demo.http.HttpClient.exchange()",
              ms: 57.8,
              percent: 68.3,
            },
            {
              depth: 1,
              method: "demo.orders.OrderRepository.save()",
              ms: 17.6,
              percent: 20.8,
            },
          ];
          result.rows = result.trace;
          break;
        case "watch":
          result.summary = "模拟方法观测：参数、返回值和异常均为演示数据。";
          result.samples = Array.from(
            { length: parameters.maxResults || 3 },
            (_, index) => ({
              time: new Date(at - index * 200).toISOString(),
              params: [{ orderId: `DEMO-${1042 + index}`, items: index + 1 }],
              returnObj: { accepted: true, status: "CREATED" },
              throwExp: null,
            }),
          );
          result.rows = result.samples;
          break;
        case "ognl":
          result.summary = "模拟表达式结果：表达式仅展示，不会被执行。";
          result.value = {
            application: target.appName,
            javaVersion,
            demo: true,
          };
          result.rows = [
            {
              name: "expression",
              value: parameters.expression || "@demo.RuntimeInfo@get()",
            },
            { name: "value", value: JSON.stringify(result.value) },
          ];
          break;
        case "sc":
          result.summary = "模拟类信息：展示演示应用中的 2 个类。";
          result.classes = [
            className,
            `demo.${target.app}.ApplicationRepository`,
          ].map((name) => ({
            name,
            classLoader: "demo.AppClassLoader",
            isInterface: false,
            codeSource: "demo-application.jar",
          }));
          result.rows = result.classes;
          break;
        case "profiler":
          result.summary = "模拟 CPU 采样：示例热点集中在请求处理和序列化。";
          result.frames = [
            { depth: 0, name: "all samples", samples: 100, percent: 100 },
            {
              depth: 1,
              name: `${className}.execute`,
              samples: 78,
              percent: 78,
            },
            {
              depth: 2,
              name: "demo.json.JsonCodec.encode",
              samples: 46,
              percent: 46,
            },
            {
              depth: 2,
              name: "demo.store.Repository.save",
              samples: 32,
              percent: 32,
            },
            {
              depth: 1,
              name: "demo.jobs.SampleJob.run",
              samples: 22,
              percent: 22,
            },
          ];
          result.rows = result.frames;
          break;
      }
      return result;
    }

    function runTasks(run) {
      return run.taskIds.map((id) =>
        state.tasks.find((task) => task.id === id),
      );
    }
    function getRun(id) {
      const run = state.runs.find((item) => item.id === id);
      if (!run) throw new Error("诊断运行不存在 (unknown run)");
      return run;
    }
    function runSummary(id) {
      const tasks = runTasks(getRun(id));
      const counts = {
        queued: 0,
        running: 0,
        succeeded: 0,
        cancelled: 0,
        interrupted: 0,
      };
      for (const task of tasks) counts[task.status]++;
      const total = tasks.length;
      const completed = total - counts.queued - counts.running;
      const status =
        completed < total
          ? "running"
          : counts.succeeded === total
            ? "succeeded"
            : counts.cancelled === total
              ? "cancelled"
              : counts.interrupted === total
                ? "interrupted"
                : "partial";
      return { status, total, completed, counts };
    }
    function capacityEvictions(size) {
      let tasks = state.tasks.length + size;
      let runs = state.runs.length + 1;
      const evictions = [];
      const terminal = state.runs
        .filter((run) => runTasks(run).every((task) => !pending(task)))
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const run of terminal) {
        if (tasks <= LIMIT && runs <= LIMIT) break;
        evictions.push(run);
        tasks -= run.taskIds.length;
        runs--;
      }
      if (tasks > LIMIT || runs > LIMIT)
        throw new Error("任务容量不足，活动批次不会被淘汰 (task limit)");
      return evictions;
    }
    function makeTask(run, target) {
      return {
        id: `demo-task-${String(++taskSequence).padStart(4, "0")}`,
        runId: run.id,
        source: run.source,
        client: run.client,
        target,
        tool: run.tool,
        status: "queued",
        createdAt: run.createdAt,
        startedAt: null,
        finishedAt: null,
        parameters: run.parameters,
        result: null,
        deadline: null,
      };
    }
    function createRun(
      targetSnapshots,
      tool,
      parameters,
      metadata,
      at,
      timing,
      evictions = [],
    ) {
      for (const old of evictions) {
        state.tasks = state.tasks.filter((task) => task.runId !== old.id);
        state.runs.splice(state.runs.indexOf(old), 1);
        runTiming.delete(old.id);
      }
      const run = {
        id: `demo-run-${String(++runSequence).padStart(4, "0")}`,
        ...metadata,
        tool,
        parameters,
        targetSnapshots,
        createdAt: at,
        taskIds: [],
      };
      const tasks = targetSnapshots.map((target) => makeTask(run, target));
      run.taskIds = freeze(tasks.map((task) => task.id));
      state.runs.push(run);
      state.tasks.push(...tasks);
      runTiming.set(run.id, timing);
      addEvent(
        "info",
        "诊断运行已提交",
        `${run.title} · ${run.client} · ${tasks.length} 个演示目标`,
        targetSnapshots[0],
        at,
      );
      scheduleRun(run, at);
      return run;
    }
    function scheduleRun(run, at) {
      const tasks = runTasks(run);
      let active = tasks.filter((task) => task.status === "running").length;
      for (const task of tasks) {
        if (task.status !== "queued") continue;
        const pod = state.pods.find((item) => item.key === task.target.key);
        if (!sameIdentity(pod, task.target)) {
          finish(task, "interrupted", at);
          continue;
        }
        if (
          active >= run.concurrency ||
          !online(pod) ||
          pod.channel !== "ready"
        )
          break;
        const timing = runTiming.get(run.id);
        task.status = "running";
        task.startedAt = at;
        task.deadline = at + timing.timeout;
        dueAt.set(task.id, at + timing.duration);
        active++;
      }
    }
    function finish(task, status, at) {
      task.status = status;
      task.finishedAt = at;
      task.result = status === "succeeded" ? resultFor(task, at) : null;
      dueAt.delete(task.id);
      const title = {
        succeeded: "诊断任务已完成",
        cancelled: "诊断任务已取消",
        interrupted: "诊断任务已中断",
      }[status];
      addEvent(
        status === "succeeded"
          ? "success"
          : status === "interrupted"
            ? "warning"
            : "info",
        title,
        `${task.tool} · ${task.target.name} · ${task.id}`,
        task.target,
        at,
      );
    }
    function validateParameters(tool, args) {
      if (!TOOLS.includes(tool))
        throw new Error("不支持的诊断工具 (unsupported tool)");
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("参数必须为对象 (parameters)");
      if (
        args.timeoutSeconds !== undefined &&
        (!Number.isInteger(args.timeoutSeconds) ||
          args.timeoutSeconds < 5 ||
          args.timeoutSeconds > 120)
      )
        throw new Error("timeoutSeconds 必须为 5–120 的整数");
      if (
        args.maxResults !== undefined &&
        (!Number.isInteger(args.maxResults) ||
          args.maxResults < 1 ||
          args.maxResults > 10)
      )
        throw new Error("maxResults 必须为 1–10 的整数");
      const ancestors = new Set();
      function validateJSON(value) {
        if (
          value === null ||
          typeof value === "string" ||
          typeof value === "boolean"
        )
          return;
        if (typeof value === "number" && Number.isFinite(value)) return;
        if (
          typeof value !== "object" ||
          ancestors.has(value) ||
          (!Array.isArray(value) &&
            Object.prototype.toString.call(value) !== "[object Object]") ||
          Object.getOwnPropertySymbols(value).length
        )
          throw new Error("参数必须是有限、无循环的 JSON 数据 (parameters)");
        ancestors.add(value);
        for (const item of Array.isArray(value) ? value : Object.values(value))
          validateJSON(item);
        ancestors.delete(value);
      }
      validateJSON(args);
      const parameters = clone(args);
      const observing = tool === "trace" || tool === "watch";
      if (observing) {
        for (const field of ["classPattern", "methodPattern"]) {
          if (
            typeof parameters[field] !== "string" ||
            !parameters[field].trim()
          )
            throw new Error(`必须填写 ${field}`);
          parameters[field] = parameters[field].trim();
        }
      }
      const timeout = (parameters.timeoutSeconds || 30) * 1000;
      const duration = observing
        ? parameters.maxResults
          ? 8000
          : 12000
        : tool === "profiler"
          ? 5000
          : 3000;
      return {
        parameters: freeze(parameters),
        timing: { duration: Math.min(duration, timeout), timeout },
      };
    }
    function startRun(keys, tool, args = {}, options = {}) {
      if (!Array.isArray(keys) || !keys.length)
        throw new Error("至少选择一个目标 (empty targets)");
      if (new Set(keys).size !== keys.length)
        throw new Error("目标不可重复 (duplicate targets)");
      const pods = Array.from(keys, (key) => {
        const pod = livePod(key);
        requireOnline(environmentFor(pod.environment));
        if (pod.channel !== "ready")
          throw new Error("目标通道尚未就绪 (not ready)");
        return pod;
      });
      if (pods.some((pod) => pod.environment !== pods[0].environment))
        throw new Error("一次运行只能属于同一环境 (mixed environments)");
      const { parameters, timing } = validateParameters(tool, args);
      if (!options || typeof options !== "object" || Array.isArray(options))
        throw new Error("运行选项必须为对象 (options)");
      const source = options.source === undefined ? "web" : options.source;
      if (!["web", "mcp"].includes(source))
        throw new Error("不支持的调用来源 (unsupported source)");
      const client =
        options.client === undefined
          ? source === "mcp"
            ? "IDE MCP 客户端"
            : "Web 工作台"
          : options.client;
      const title =
        options.title === undefined
          ? `${tool} · ${pods.length} 个目标`
          : options.title;
      const concurrency =
        options.concurrency === undefined ? 2 : options.concurrency;
      if (
        typeof client !== "string" ||
        !client.trim() ||
        typeof title !== "string" ||
        !title.trim()
      )
        throw new Error("运行标题和客户端名称不可为空 (options)");
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
        throw new Error("concurrency 必须为 1–4 的整数");
      const targets = freeze(pods.map(snapshot));
      const evictions = capacityEvictions(pods.length);
      return createRun(
        targets,
        tool,
        parameters,
        { title, source, client, concurrency },
        now(),
        timing,
        evictions,
      );
    }
    function startTask(key, tool, args = {}) {
      const run = startRun([key], tool, args);
      return runTasks(run)[0];
    }
    function cancelTask(id) {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) throw new Error("任务不存在 (unknown task)");
      if (pending(task)) finish(task, "cancelled", now());
      return task;
    }
    function cancelRun(id) {
      const run = getRun(id);
      const at = now();
      for (const task of runTasks(run)) {
        if (pending(task)) finish(task, "cancelled", at);
      }
      return run;
    }
    function schedule(pod, delay) {
      connections.set(pod.key, {
        target: snapshot(pod),
        readyAt: now() + delay,
      });
      readySince.delete(pod.key);
    }
    function connect(key) {
      const pod = livePod(key);
      requireOnline(environmentFor(pod.environment));
      pod.managed = true;
      if (pod.channel === "ready" || connections.has(key)) return pod;
      pod.channel = "reconnecting";
      schedule(pod, 2000);
      addEvent(
        "info",
        "正在准备诊断通道",
        `${pod.name} · 模拟准备约 2 秒`,
        pod,
      );
      return pod;
    }
    function disconnect(key) {
      const pod = livePod(key);
      requireOnline(environmentFor(pod.environment));
      if (!pod.managed) throw new Error("目标尚未纳管 (not managed)");
      pod.channel = "reconnecting";
      schedule(pod, 5000);
      addEvent(
        "warning",
        "诊断通道暂时断开",
        `${pod.name} · 仅恢复此实例通道，不重放诊断任务`,
        pod,
      );
      return pod;
    }
    function tick() {
      const at = now();
      for (const [key, pending] of connections) {
        const pod = state.pods.find((item) => item.key === key);
        if (!sameIdentity(pod, pending.target) || !pod.managed) {
          connections.delete(key);
        } else if (online(pod) && at >= pending.readyAt) {
          pod.channel = "ready";
          readySince.set(key, pending.readyAt);
          connections.delete(key);
          addEvent(
            "success",
            "诊断通道已就绪",
            `${pod.name} · 实例代次 ${pod.generation}`,
            pod,
            pending.readyAt,
          );
        }
      }
      for (const task of state.tasks) {
        if (!pending(task)) continue;
        const pod = state.pods.find((item) => item.key === task.target.key);
        if (!sameIdentity(pod, task.target)) {
          finish(task, "interrupted", at);
          continue;
        }
        if (task.status === "queued") continue;
        const completionAt = Math.max(
          dueAt.get(task.id),
          readySince.get(pod.key) ?? at,
        );
        if (
          online(pod) &&
          pod.channel === "ready" &&
          at >= completionAt &&
          completionAt <= task.deadline
        ) {
          finish(task, "succeeded", completionAt);
        } else if (at >= task.deadline) {
          finish(task, "interrupted", task.deadline);
        }
      }
      for (const run of state.runs) scheduleRun(run, at);
      return state;
    }
    function replacePod(key) {
      const pod = livePod(key);
      const generation = pod.generation + 1;
      const managed =
        online(pod) &&
        state.policies[policyKey(pod.environment, pod.app)] === "all";
      const replacement = {
        ...pod,
        key: pod.key.replace(/-g\d+$/, `-g${generation}`),
        podUid: pod.podUid.replace(/-g\d+$/, `-g${generation}`),
        containerId:
          pod.containerId?.replace(/-g\d+$/, `-g${generation}`) || null,
        jvmIdentity: pod.jvmIdentity.replace(
          /-g\d+(?=\/|$)/,
          `-g${generation}`,
        ),
        containers: clone(pod.containers),
        generation,
        channel: !online(pod)
          ? "offline"
          : managed
            ? "reconnecting"
            : "discovered",
        managed,
        restarts: 0,
        age: "刚刚",
        retired: false,
      };
      pod.retired = true;
      pod.channel = "retired";
      pod.managed = false;
      connections.delete(key);
      readySince.delete(key);
      for (const task of state.tasks) {
        if (task.target.key === key && pending(task))
          finish(task, "interrupted", now());
      }
      state.pods.push(replacement);
      if (managed) schedule(replacement, 2000);
      addEvent(
        "warning",
        "发现同名新实例",
        `${pod.name} · UID 已变化，历史任务保留原目标`,
        replacement,
      );
      return replacement;
    }
    function setPolicy(environment, app, policy) {
      const key = policyKey(environment, app);
      if (!Object.hasOwn(state.policies, key))
        throw new Error("环境或应用不存在 (unknown context)");
      if (!["selected", "all", "discover"].includes(policy))
        throw new Error("不支持的纳管策略 (unsupported policy)");
      if (
        policy === "discover" &&
        state.tasks.some(
          (task) =>
            pending(task) &&
            task.target.environment === environment &&
            task.target.app === app,
        )
      ) {
        throw new Error(
          "此工作负载仍有排队或运行中的任务，请先取消或等待完成 (running tasks)",
        );
      }
      if (policy === "all") requireOnline(environmentFor(environment));
      state.policies[key] = policy;
      for (const pod of listPods(environment, app)) {
        if (policy === "all") connect(pod.key);
        if (policy === "discover") {
          pod.managed = false;
          pod.channel = online(pod) ? "discovered" : "offline";
          connections.delete(pod.key);
          readySince.delete(pod.key);
        }
      }
      addEvent(
        "info",
        "纳管策略已更新",
        `${environment} / ${app} · ${policy}`,
        { environment, app },
      );
      return policy;
    }
    function scanLocal(environment = "local") {
      const device = environmentFor(environment);
      if (!device || device.kind !== "local")
        throw new Error("本地设备不存在 (unknown local environment)");
      requireOnline(device);
      if (!localScanned.has(environment)) {
        localScanned.add(environment);
        const pod = localPod(
          device,
          31240,
          "demo.PaymentApplication",
          "discovered",
        );
        state.pods.push(pod);
        addEvent(
          "info",
          "本机扫描已完成",
          "发现 1 个新增演示 JVM，未访问真实进程",
          pod,
        );
        if (state.policies[policyKey(environment, "local")] === "all")
          connect(pod.key);
      }
      return listPods(environment, "local");
    }

    function seedRun(pods, tool, args, source, title, at, duration) {
      const { parameters, timing } = validateParameters(tool, args);
      if (duration !== undefined) timing.duration = duration;
      return createRun(
        freeze(pods.map(snapshot)),
        tool,
        parameters,
        {
          source,
          client: source === "mcp" ? "IDE MCP 客户端" : "Web 工作台",
          title,
          concurrency: 2,
        },
        at,
        timing,
      );
    }
    const production = listPods("production", "orders");
    const traceRun = seedRun(
      [production[0]],
      "trace",
      {
        classPattern: "demo.orders.OrderService",
        methodPattern: "createOrder",
      },
      "web",
      "订单创建链路 · 演示",
      startedAt - 60000,
    );
    finish(runTasks(traceRun)[0], "succeeded", startedAt - 48000);
    const threadRun = seedRun(
      [listPods("staging", "orders")[0]],
      "thread",
      {},
      "web",
      "预发线程快照 · 演示",
      startedAt - 30000,
    );
    finish(runTasks(threadRun)[0], "succeeded", startedAt - 27000);
    const mcpRun = seedRun(
      production.slice(0, 3),
      "thread",
      {},
      "mcp",
      "订单实例线程对比 · MCP 演示",
      startedAt - 20000,
    );
    const mcpTasks = runTasks(mcpRun);
    finish(mcpTasks[0], "succeeded", startedAt - 17000);
    finish(mcpTasks[1], "succeeded", startedAt - 17000);
    scheduleRun(mcpRun, startedAt - 17000);
    finish(mcpTasks[2], "succeeded", startedAt - 14000);
    const watchRun = seedRun(
      [production[1]],
      "watch",
      {
        classPattern: "demo.orders.OrderService",
        methodPattern: "createOrder",
        timeoutSeconds: 90,
      },
      "web",
      "订单方法观测 · 演示",
      startedAt,
      90000,
    );
    const watch = runTasks(watchRun)[0];
    addEvent(
      "info",
      "方法观测正在运行",
      `${watch.target.name} · 演示观测窗口 90 秒`,
      watch.target,
      startedAt,
    );
    addEvent(
      "warning",
      "实例通道待恢复",
      "演示断连状态：点击连接后才会恢复",
      production[4],
      startedAt,
    );

    return {
      state,
      listPods,
      startRun,
      runSummary,
      cancelRun,
      startTask,
      cancelTask,
      tick,
      disconnect,
      replacePod,
      setPolicy,
      scanLocal,
      connect,
    };
  }

  root.WorkbenchDemo = { createStore };
})(window);
