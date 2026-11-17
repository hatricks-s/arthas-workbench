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
          cluster: "demo-production",
          namespace: "commerce-prod",
        },
        {
          id: "staging",
          name: "预发环境",
          cluster: "demo-staging",
          namespace: "commerce-stage",
        },
        {
          id: "development",
          name: "开发环境",
          cluster: "demo-development",
          namespace: "commerce-dev",
        },
      ],
      apps: [
        {
          id: "orders",
          name: "order-service",
          description: "订单创建与履约服务",
          owner: "Commerce team",
          javaVersion: "21.0.5",
        },
        {
          id: "payments",
          name: "payment-service",
          description: "支付处理与账单服务",
          owner: "Payments team",
          javaVersion: "21.0.5",
        },
        {
          id: "inventory",
          name: "inventory-service",
          description: "库存预留与仓储服务",
          owner: "Supply team",
          javaVersion: "21.0.5",
        },
        {
          id: "gateway",
          name: "api-gateway",
          description: "应用入口与请求路由",
          owner: "Platform team",
          javaVersion: "21.0.5",
        },
      ],
      pods: [],
      tasks: [],
      events: [],
      policies: {},
    };
    const connections = new Map();
    const readySince = new Map();
    const dueAt = new Map();
    let taskSequence = 0;
    let eventSequence = 0;
    let localScanned = false;
    const policyKey = (environment, app) => `${environment}/${app}`;

    for (const environment of state.environments) {
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
          state.pods.push({
            key: `${environment.id}-${app.id}-${index}-g1`,
            environment: environment.id,
            app: app.id,
            kind: "k8s",
            name: `${app.name}-${index}`,
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
    function localPod(pid, name, channel) {
      return {
        key: `local-jvm-${pid}-g1`,
        environment: "local",
        app: "local",
        kind: "local",
        name,
        podUid: `demo-local-${pid}-g1`,
        generation: 1,
        node: "demo-workstation",
        connector: "my-workstation",
        container: "本机 JVM",
        pid,
        channel,
        managed: channel === "ready",
        restarts: 0,
        age: "42分钟",
        retired: false,
      };
    }
    state.pods.push(
      localPod(24080, "demo.OrderApplication", "ready"),
      localPod(28120, "demo.InventoryApplication", "discovered"),
    );
    state.policies["local/local"] = "selected";
    state.pods
      .filter((pod) => pod.channel === "ready")
      .forEach((pod) => readySince.set(pod.key, startedAt));

    function listPods(environment, app) {
      return state.pods.filter(
        (pod) =>
          !pod.retired && pod.environment === environment && pod.app === app,
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
      const className = `demo.${target.app}.ApplicationService`;
      const method = `${parameters.classPattern || className}.${parameters.methodPattern || "execute"}()`;
      const result = { simulated: true, tool, summary: "", rows: [] };
      switch (tool) {
        case "jvm": {
          result.summary = "模拟 JVM 概览：Java 21，进程运行正常。";
          result.jvm = {
            name: "OpenJDK 64-Bit Server VM",
            javaVersion: "21.0.5",
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
          result.summary = "模拟内存快照：堆使用率 37.5%，无真实采样。";
          result.memory = [
            {
              name: "heap",
              used: "384 MiB",
              committed: "768 MiB",
              max: "1024 MiB",
              usage: 37.5,
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
              cpu: 18.4,
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
            javaVersion: "21.0.5",
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

    function makeTask(pod, tool, parameters, createdAt, duration, timeout) {
      if (
        state.tasks.filter((task) => task.status === "running").length >= LIMIT
      ) {
        throw new Error("运行中的任务已达 100 个 (task limit)");
      }
      if (state.tasks.length >= LIMIT)
        state.tasks.splice(
          state.tasks.findIndex((task) => task.status !== "running"),
          1,
        );
      const task = {
        id: `demo-task-${String(++taskSequence).padStart(4, "0")}`,
        target: snapshot(pod),
        tool,
        status: "running",
        createdAt,
        finishedAt: null,
        parameters: freeze(clone(parameters)),
        result: null,
        deadline: createdAt + timeout,
      };
      state.tasks.push(task);
      dueAt.set(task.id, createdAt + duration);
      return task;
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
    function startTask(key, tool, args = {}) {
      const pod = livePod(key);
      if (pod.channel !== "ready")
        throw new Error("目标通道尚未就绪 (not ready)");
      if (!TOOLS.includes(tool))
        throw new Error("不支持的诊断工具 (unsupported tool)");
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("参数必须为对象 (parameters)");
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
      if (
        args.timeoutSeconds !== undefined &&
        (!Number.isInteger(args.timeoutSeconds) ||
          args.timeoutSeconds < 5 ||
          args.timeoutSeconds > 120)
      ) {
        throw new Error("timeoutSeconds 必须为 5–120 的整数");
      }
      if (
        args.maxResults !== undefined &&
        (!Number.isInteger(args.maxResults) ||
          args.maxResults < 1 ||
          args.maxResults > 10)
      ) {
        throw new Error("maxResults 必须为 1–10 的整数");
      }
      const timeout = (parameters.timeoutSeconds || 30) * 1000;
      const duration = observing
        ? parameters.maxResults
          ? 8000
          : 12000
        : tool === "profiler"
          ? 5000
          : 3000;
      const task = makeTask(
        pod,
        tool,
        parameters,
        now(),
        Math.min(duration, timeout),
        timeout,
      );
      addEvent(
        "info",
        "诊断任务已启动",
        `${tool} · ${pod.name} · 仅演示数据`,
        pod,
        task.createdAt,
      );
      return task;
    }
    function cancelTask(id) {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) throw new Error("任务不存在 (unknown task)");
      if (task.status === "running") finish(task, "cancelled", now());
      return task;
    }
    function schedule(pod, delay) {
      connections.set(pod.key, {
        generation: pod.generation,
        podUid: pod.podUid,
        readyAt: now() + delay,
      });
      readySince.delete(pod.key);
    }
    function connect(key) {
      const pod = livePod(key);
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
        if (
          !pod ||
          pod.retired ||
          !pod.managed ||
          pod.generation !== pending.generation ||
          pod.podUid !== pending.podUid
        ) {
          connections.delete(key);
        } else if (at >= pending.readyAt) {
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
        if (task.status !== "running") continue;
        const pod = state.pods.find((item) => item.key === task.target.key);
        if (
          !pod ||
          pod.retired ||
          pod.generation !== task.target.generation ||
          pod.podUid !== task.target.podUid
        ) {
          finish(task, "interrupted", at);
          continue;
        }
        const completionAt = Math.max(
          dueAt.get(task.id),
          readySince.get(pod.key) ?? at,
        );
        if (
          pod.channel === "ready" &&
          at >= completionAt &&
          completionAt <= task.deadline
        ) {
          finish(task, "succeeded", completionAt);
        } else if (at >= task.deadline) {
          finish(task, "interrupted", task.deadline);
        }
      }
      return state;
    }
    function replacePod(key) {
      const pod = livePod(key);
      const generation = pod.generation + 1;
      const managed =
        state.policies[policyKey(pod.environment, pod.app)] === "all";
      const replacement = {
        ...pod,
        key: pod.key.replace(/-g\d+$/, `-g${generation}`),
        podUid: pod.podUid.replace(/-g\d+$/, `-g${generation}`),
        generation,
        channel: managed ? "reconnecting" : "discovered",
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
        if (task.target.key === key && task.status === "running")
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
            task.status === "running" &&
            task.target.environment === environment &&
            task.target.app === app,
        )
      ) {
        throw new Error(
          "此应用仍有运行中的任务，请先取消或等待完成 (running tasks)",
        );
      }
      state.policies[key] = policy;
      for (const pod of listPods(environment, app)) {
        if (policy === "all") connect(pod.key);
        if (policy === "discover") {
          pod.managed = false;
          pod.channel = "discovered";
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
    function scanLocal() {
      if (!localScanned) {
        localScanned = true;
        const pod = localPod(31240, "demo.PaymentApplication", "discovered");
        state.pods.push(pod);
        addEvent(
          "info",
          "本机扫描已完成",
          "发现 1 个新增演示 JVM，未访问真实进程",
          pod,
        );
        if (state.policies["local/local"] === "all") connect(pod.key);
      }
      return listPods("local", "local");
    }

    const production = listPods("production", "orders");
    const trace = makeTask(
      production[0],
      "trace",
      {
        classPattern: "demo.orders.OrderService",
        methodPattern: "createOrder",
      },
      startedAt - 60000,
      12000,
      30000,
    );
    finish(trace, "succeeded", startedAt - 48000);
    const thread = makeTask(
      listPods("staging", "orders")[0],
      "thread",
      {},
      startedAt - 30000,
      3000,
      30000,
    );
    finish(thread, "succeeded", startedAt - 27000);
    const watch = makeTask(
      production[1],
      "watch",
      {
        classPattern: "demo.orders.OrderService",
        methodPattern: "createOrder",
        timeoutSeconds: 90,
      },
      startedAt,
      90000,
      90000,
    );
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
