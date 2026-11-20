(function (root) {
  "use strict";

  const TOOLS = [
    "thread",
    "trace",
    "watch",
    "memory",
    "profiler",
    "jvm",
    "ognl",
    "sc",
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
          name: "生产集群 · zj-prod",
          shortName: "生产集群",
          tier: "PROD",
          kind: "k8s",
          clusterId: "c-prod-zj",
          cluster: "zj-data-pd-cluster",
          protocol: "K8s WS v4.channel · 免进程隧道",
          namespace: "commerce",
        },
        {
          id: "staging",
          name: "测试集群 · zj-sprint",
          shortName: "测试集群",
          tier: "TEST",
          kind: "k8s",
          clusterId: "c-test-zj",
          cluster: "zj-data-te-cluster",
          protocol: "K8s WS v4.channel · 免进程隧道",
          namespace: "commerce",
        },
        {
          id: "flink",
          name: "计算集群 · flink-engine",
          shortName: "计算集群",
          tier: "DATA",
          kind: "k8s",
          clusterId: "c-flink-vpc",
          cluster: "sg-flink-vpc-cluster",
          protocol: "K8s WS v4.channel · JRE jattach",
          namespace: "streaming",
        },
        {
          id: "local",
          name: "我的开发机 · dev-workstation",
          shortName: "我的开发机",
          tier: "LOCAL",
          kind: "local",
          device: "dev-workstation",
          protocol: "Outbound WSS · hsperfdata + jattach",
          online: true,
          cluster: null,
        },
        {
          id: "local-build",
          name: "离线设备 · build-box",
          shortName: "离线设备",
          tier: "OFFLINE",
          kind: "local",
          device: "build-workstation",
          protocol: "Outbound WSS · 通道未连接",
          online: false,
          cluster: null,
        },
      ],
      apps: [
        {
          id: "orders",
          name: "order-service",
          description: "核心交易下单与状态编排服务",
          namespace: "commerce",
          kind: "Deployment",
          owner: "交易核心组",
          javaVersion: "17.0.14",
        },
        {
          id: "inventory",
          name: "inventory-service",
          description: "库存扣减、分布式锁与配额中心",
          namespace: "commerce",
          kind: "Deployment",
          owner: "供应链平台组",
          javaVersion: "17.0.14",
        },
        {
          id: "payments",
          name: "payment-service",
          description: "收单路由、清结算与账务核对",
          namespace: "commerce",
          kind: "Deployment",
          owner: "支付清结算组",
          javaVersion: "21.0.5",
        },
        {
          id: "gateway",
          name: "api-gateway",
          description: "统一鉴权与南北向流量网关",
          namespace: "platform",
          kind: "Deployment",
          owner: "基础架构组",
          javaVersion: "21.0.5",
        },
        {
          id: "orders-lab",
          name: "order-service",
          description: "压测沙箱同名服务（跨 Namespace 身份隔离验证）",
          namespace: "sandbox",
          kind: "Deployment",
          owner: "稳定性沙箱",
          javaVersion: "17.0.13",
        },
        {
          id: "flink-job",
          name: "kyuubi-flink-sql",
          description: "Flink 实时指标流计算引擎（纯 JRE 容器无 tools.jar）",
          namespace: "streaming",
          kind: "Deployment",
          owner: "实时数据组",
          javaVersion: "11.0.22",
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
    const pending = (task) =>
      ["mounting", "queued", "running"].includes(task.status);
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
      Boolean(
        pod &&
          !pod.retired &&
          identityFields.every((field) => pod[field] === target[field]),
      );
    const environmentFor = (id) =>
      state.environments.find((item) => item.id === id);
    const online = (pod) => environmentFor(pod.environment)?.online !== false;

    function requireOnline(environment) {
      if (environment?.online === false) {
        throw new Error("本机助手处于离线状态，无法扫描或发起实时操作 (offline device)");
      }
    }

    for (const environment of state.environments.filter(
      (item) => item.kind === "k8s",
    )) {
      const envApps =
        environment.id === "flink"
          ? state.apps.filter((a) => a.id === "flink-job")
          : state.apps.filter((a) => a.id !== "flink-job");

      for (const app of envApps) {
        state.policies[policyKey(environment.id, app.id)] = "selected";
        const count =
          app.id === "orders"
            ? { production: 6, staging: 3 }[environment.id] || 2
            : app.id === "flink-job"
              ? 3
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

          const node = `10.125.19${(index % 3) + 3}.${42 + index * 17}`;
          const containerId = `containerd://${environment.id}-${app.id}-${index}-g1`;
          const containers = [
            {
              name: app.name,
              role: "application",
              state: "running",
              javaCandidate: true,
            },
          ];
          if (
            (environment.id === "production" && index < 4) ||
            environment.id === "flink"
          ) {
            containers.push({
              name: "init-image-tools",
              role: "init",
              state: "completed",
              javaCandidate: false,
            });
          }

          const skewed =
            environment.id === "production" && app.id === "orders" && index === 0;
          const cpuLoad = skewed
            ? 74
            : app.id === "orders"
              ? [74, 18, 21, 16, 38, 15][index] || 19
              : 12 + ((index * 13 + app.name.length * 3) % 28);
          const heapPct = skewed
            ? 84
            : app.id === "orders"
              ? [84, 46, 49, 43, 61, 39][index] || 45
              : 38 + ((index * 17 + app.name.length * 5) % 33);
          const mountStrategy =
            environment.id === "flink"
              ? "HTTP Pull 核心包 (12MB) + jattach (无 tools.jar)"
              : index % 3 === 2
                ? "WS v4 二进制流解包 + jattach"
                : "内网 HTTP Pull 0.2s 缓存命中 + jattach";

          state.pods.push({
            key: `${environment.id}-${app.id}-${index}-g1`,
            environment: environment.id,
            app: app.id,
            kind: "k8s",
            name: `${app.name}-54b4fbd47c-${String(index + 1).padStart(5, "0")}`,
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
            jvmIdentity: `${containerId}/pid-8`,
            javaCandidate: true,
            podUid: `uid-${environment.id}-${app.id}-${index}-g1`,
            generation: 1,
            node,
            podIp: `10.0.${index % 6}.${118 + index * 13}`,
            cpuLoad,
            heapPct,
            heapLimit: app.id === "orders" ? "4500 MiB" : "2500 MiB",
            mountStrategy,
            authMode: "单实例随机 BasicAuth · Telnet 已禁 (-1)",
            connector:
              environment.id === "production"
                ? "hub-k8s-ws-engine"
                : "hub-k8s-ws-nonprod",
            container: app.name,
            pid: 8,
            arthasPort: 8616,
            channel,
            managed: channel !== "discovered",
            restarts: skewed ? 2 : index % 2,
            age: `${index + 2}d`,
            retired: false,
          });
        }
      }
    }

    function localPod(environment, pid, name, portLabel, channel) {
      return {
        key: `${environment.id}-jvm-${pid}-g1`,
        environment: environment.id,
        app: "local",
        kind: "local",
        name,
        cluster: null,
        clusterId: null,
        namespace: "local-process",
        workloadName: name,
        workloadKind: "LocalJVM",
        device: environment.device,
        podUid: `uid-${environment.device}-${pid}-g1`,
        generation: 1,
        node: environment.device,
        podIp: `127.0.0.1:${portLabel}`,
        cpuLoad: pid === 24080 ? 26 : 9,
        heapPct: pid === 24080 ? 54 : 31,
        heapLimit: "1024 MiB",
        mountStrategy: "本机 hsperfdata 识别 + 内置 jattach",
        authMode: "Loopback 127.0.0.1 · Telnet 已禁 (-1)",
        connector: environment.device,
        container: "OS Process",
        containerId: null,
        containerCount: 0,
        readyContainers: 0,
        containers: [],
        javaCandidate: true,
        javaVersion: pid === 28120 ? "17.0.14" : "21.0.5",
        jvmIdentity: `${environment.device}/pid-${pid}-g1`,
        pid,
        arthasPort: 8563 + (pid % 20),
        channel,
        managed: channel === "ready",
        restarts: 0,
        age: "48m",
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
          "com.acme.OrderApplication",
          "8080",
          environment.online ? "ready" : "offline",
        ),
        localPod(
          environment,
          28120,
          "com.acme.InventoryApplication",
          "8082",
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
      if (pod.retired) throw new Error("目标已重建退役，禁止在旧身份重放 (retired target)");
      return pod;
    }

    function addEvent(kind, title, detail, target, at = now()) {
      state.events.push({
        id: `evt-${++eventSequence}`,
        at,
        kind,
        title,
        detail,
        targetKey: target.key || null,
        environment: target.environment,
        app: target.app,
      });
      if (state.events.length > LIMIT) {
        state.events.splice(0, state.events.length - LIMIT);
      }
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
            pod.workloadName ||
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
      const skewed = target.key.includes("production-orders-0-");
      const javaVersion = target.javaVersion || "17.0.14";
      const pkg = `sample.${target.app === "local" ? "local" : target.app.replace(/-/g, "")}`;
      const className = `${pkg}.OrderOrchestrator`;
      const method = `${parameters.classPattern || className}#${parameters.methodPattern || "createOrder"}()`;
      const result = {
        simulated: true,
        tool,
        anomalous: skewed,
        headlineMetric: "",
        headlineValue: 0,
        summary: "",
        rows: [],
      };

      switch (tool) {
        case "thread": {
          const topCpu = skewed
            ? 68.4
            : Number((13.2 + variant * 2.4).toFixed(1));
          result.headlineMetric = `最高线程 CPU ${topCpu}%`;
          result.headlineValue = topCpu;
          result.summary = skewed
            ? "检出 1 条 BLOCKED 分布式库存锁竞争线程（CPU 68.4%），其余副本无此阻塞栈。"
            : `线程状态平稳，峰值工作线程 CPU ${topCpu}%，无死锁或锁阻塞。`;
          result.threads = [
            {
              id: 41,
              name: "http-nio-8080-exec-17",
              state: skewed ? "BLOCKED" : "RUNNABLE",
              cpu: topCpu,
              lockInfo: skewed
                ? "waiting to lock <0x000000071a8c4210> (InventoryQuotaLock)"
                : null,
              stack: skewed
                ? [
                    `${pkg}.InventoryQuotaLock.acquireSlot(InventoryQuotaLock.java:78)`,
                    `${className}.createOrder(OrderOrchestrator.java:142)`,
                    "org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:885)",
                  ]
                : [
                    `${className}.createOrder(OrderOrchestrator.java:142)`,
                    "org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:885)",
                  ],
            },
            {
              id: 29,
              name: "lettuce-epollEventLoop-4-2",
              state: "RUNNABLE",
              cpu: skewed ? 19.2 : 3.4,
              lockInfo: null,
              stack: [
                "io.netty.channel.epoll.Native.epollWait(Native Method)",
                "io.netty.channel.epoll.EpollEventLoop.run(EpollEventLoop.java:392)",
              ],
            },
            {
              id: 14,
              name: "arthas-command-execute",
              state: "TIMED_WAITING",
              cpu: 0.4,
              lockInfo: null,
              stack: [
                "java.lang.Thread.sleep(Thread.java:509)",
                "com.taobao.arthas.core.shell.command.internal.TermImpl.read(TermImpl.java:118)",
              ],
            },
          ];
          result.rows = result.threads;
          break;
        }
        case "trace": {
          const totalMs = skewed
            ? 184.6
            : Number((15.4 + variant * 1.9).toFixed(1));
          const lockMs = skewed
            ? 148.2
            : Number((4.6 + variant * 0.8).toFixed(1));
          const rpcMs = skewed
            ? 139.5
            : Number((3.8 + variant * 0.7).toFixed(1));
          const dbMs = skewed ? 28.1 : 6.8;
          const valMs = 3.1;
          const pct = (v) => Number(((v / totalMs) * 100).toFixed(1));
          result.headlineMetric = `总耗时 ${totalMs} ms`;
          result.headlineValue = totalMs;
          result.summary = skewed
            ? `慢调用告警：总耗时 ${totalMs} ms，InventoryClient#reserveQuota 独占 ${pct(lockMs)}%（远超其余副本 ~16ms）。`
            : `调用链耗时 ${totalMs} ms，各子调用均在正常阈值内。`;
          result.trace = [
            { depth: 0, method, ms: totalMs, percent: 100, status: skewed ? "slow" : "ok" },
            {
              depth: 1,
              method: `${pkg}.OrderValidator#checkSignature()`,
              ms: valMs,
              percent: pct(valMs),
              status: "ok",
            },
            {
              depth: 1,
              method: `${pkg}.InventoryClient#reserveQuota()`,
              ms: lockMs,
              percent: pct(lockMs),
              status: skewed ? "critical" : "ok",
            },
            {
              depth: 2,
              method: "okhttp3.internal.connection.RealCall#execute()",
              ms: rpcMs,
              percent: pct(rpcMs),
              status: skewed ? "critical" : "ok",
            },
            {
              depth: 1,
              method: `${pkg}.OrderMapper#insertSelective()`,
              ms: dbMs,
              percent: pct(dbMs),
              status: skewed ? "warn" : "ok",
            },
          ];
          result.rows = result.trace;
          break;
        }
        case "watch": {
          result.headlineMetric = `${parameters.maxResults || 3} 次方法命中`;
          result.headlineValue = parameters.maxResults || 3;
          result.summary = skewed
            ? "捕获到入参重试放大与 TimeoutException 异常样本。"
            : "方法入参、返回值观测完成，全部返回 CREATED。";
          result.samples = Array.from(
            { length: parameters.maxResults || 3 },
            (_, idx) => ({
              time: new Date(at - idx * 240).toISOString(),
              costMs: skewed ? 182.4 - idx * 14 : 14.8 + idx * 1.2,
              params: `{ orderNo: "ORD-2026-${8841 + idx}", skuCount: ${idx + 2} }`,
              returnObj:
                skewed && idx === 0
                  ? "null"
                  : `{ accepted: true, shard: "s${variant}" }`,
              throwExp:
                skewed && idx === 0
                  ? "java.util.concurrent.TimeoutException: quota lock wait > 150ms"
                  : null,
            }),
          );
          result.rows = result.samples;
          break;
        }
        case "memory": {
          const heapUsage = skewed
            ? 84.2
            : Number((42.5 + variant * 3.4).toFixed(1));
          result.headlineMetric = `堆占用 ${heapUsage}%`;
          result.headlineValue = heapUsage;
          result.summary = skewed
            ? `老年代占用偏高（堆总使用率 ${heapUsage}%，容器 cgroup 内存 79%）。`
            : `堆内存使用率 ${heapUsage}%，GC 回收水位健康。`;
          result.memory = [
            {
              name: "heap (总堆)",
              used: skewed ? "862 MiB" : `${430 + variant * 28} MiB`,
              committed: "1024 MiB",
              max: "1024 MiB",
              usage: heapUsage,
            },
            {
              name: "tenured_gen (老年代)",
              used: skewed ? "498 MiB" : `${210 + variant * 18} MiB`,
              committed: "512 MiB",
              max: "512 MiB",
              usage: skewed ? 97.2 : Number((41.0 + variant * 3.5).toFixed(1)),
            },
            {
              name: "metaspace (元空间)",
              used: "146 MiB",
              committed: "154 MiB",
              max: "512 MiB",
              usage: 28.5,
            },
            {
              name: "direct (直接内存)",
              used: "24 MiB",
              committed: "32 MiB",
              max: "256 MiB",
              usage: 9.4,
            },
          ];
          result.rows = result.memory;
          break;
        }
        case "profiler": {
          const topPct = skewed ? 76.4 : 44.0;
          result.headlineMetric = `热点栈占比 ${topPct}%`;
          result.headlineValue = topPct;
          result.summary = skewed
            ? "async-profiler CPU 火焰热点集中在锁自旋与 JSON 反序列化。"
            : "CPU 采样分布均匀，主要耗时在常规业务编排与序列化。";
          result.frames = [
            { depth: 0, name: "all-cpu-samples", samples: 250, percent: 100 },
            {
              depth: 1,
              name: `${className}.createOrder`,
              samples: skewed ? 191 : 110,
              percent: topPct,
            },
            {
              depth: 2,
              name: skewed
                ? `${pkg}.InventoryQuotaLock.acquireSlot`
                : "com.fasterxml.jackson.databind.ObjectMapper.writeValueAsBytes",
              samples: skewed ? 158 : 68,
              percent: skewed ? 63.2 : 27.2,
            },
            {
              depth: 2,
              name: `${pkg}.OrderMapper.insertSelective`,
              samples: 33,
              percent: 13.2,
            },
            {
              depth: 1,
              name: "io.netty.channel.epoll.EpollEventLoop.run",
              samples: 42,
              percent: 16.8,
            },
          ];
          result.rows = result.frames;
          break;
        }
        case "jvm": {
          result.headlineMetric = `JDK ${javaVersion} · PID ${target.pid}`;
          result.headlineValue = target.pid;
          result.summary = `OpenJDK ${javaVersion}（容器 PID ${target.pid}，${target.authMode}）。`;
          result.jvm = {
            "VM-NAME": "OpenJDK 64-Bit Server VM (Temurin)",
            "JAVA-VERSION": javaVersion,
            "CONTAINER-PID": `${target.pid} (PID 1 为启动入口 sh -c)`,
            "JVM-IDENTITY": target.jvmIdentity,
            "INPUT-ARGS": "-Xms1g -Xmx1g -Xmn512m --add-opens=java.base/java.lang=ALL-UNNAMED",
            "MOUNT-MODE": target.mountStrategy,
            "SECURITY": target.authMode,
          };
          result.rows = Object.entries(result.jvm).map(([name, value]) => ({
            name,
            value,
          }));
          break;
        }
        case "ognl": {
          const expr =
            parameters.expression ||
            "@org.springframework.boot.SpringApplication@class.getName()";
          result.headlineMetric = "只读 OGNL 求值完成";
          result.headlineValue = 1;
          result.summary = "已自动启用 JDBC 超时保护；原型仅返回确定性结构，不执行任何外部代码。";
          result.value = {
            target: target.name,
            namespace: target.namespace,
            evaluatedExpression: expr,
            activeProfile: target.environment === "production" ? "prod" : "sprint",
            connectionPoolActive: skewed ? 48 : 6,
            connectionPoolMax: 50,
          };
          result.rows = Object.entries(result.value).map(([name, value]) => ({
            name,
            value: String(value),
          }));
          break;
        }
        case "sc": {
          result.headlineMetric = "匹配 2 个已加载类";
          result.headlineValue = 2;
          result.summary = `已定位类加载器与 JAR 来源（${target.workloadName}）。`;
          result.classes = [
            {
              name: className,
              classLoader: "LaunchedURLClassLoader@3d4eac69",
              isInterface: false,
              codeSource: `file:/app/${target.workloadName}.jar!/BOOT-INF/classes!/`,
            },
            {
              name: `${pkg}.InventoryClient`,
              classLoader: "LaunchedURLClassLoader@3d4eac69",
              isInterface: true,
              codeSource: "file:/app/lib/inventory-sdk-2.4.1.jar",
            },
          ];
          result.rows = result.classes;
          break;
        }
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
      if (!run) throw new Error("诊断批次不存在 (unknown run)");
      return run;
    }

    function runSummary(id) {
      const run = getRun(id);
      const tasks = runTasks(run);
      const counts = {
        mounting: 0,
        queued: 0,
        running: 0,
        succeeded: 0,
        cancelled: 0,
        interrupted: 0,
      };
      for (const task of tasks) counts[task.status]++;
      const total = tasks.length;
      const completed =
        total - counts.mounting - counts.queued - counts.running;
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

      const succeededTasks = tasks.filter((t) => t.status === "succeeded" && t.result);
      const anomaly = succeededTasks.find((t) => t.result.anomalous);
      let verdict = "";
      if (status === "running") {
        verdict = `执行中：已完成 ${completed}/${total}（运行 ${counts.running} · 挂载中 ${counts.mounting} · 排队 ${counts.queued}）`;
      } else if (anomaly && succeededTasks.length > 1) {
        verdict = `异常定位：${total} 个目标中 ${anomaly.target.name} 指标显著偏离基线（${anomaly.result.headlineMetric}）`;
      } else if (status === "partial") {
        verdict = `部分完成：${counts.succeeded} 个成功，${counts.interrupted} 个因身份变更/超时中断，${counts.cancelled} 个已取消`;
      } else if (status === "succeeded") {
        verdict =
          total > 1
            ? `${total} 个副本全部完成采样，横向对比未见单点锁阻塞或明显毛刺`
            : `采样完成：${succeededTasks[0]?.result?.headlineMetric || run.tool}`;
      } else if (status === "interrupted") {
        verdict = "批次已中断：目标 Pod 重建或通道超时，历史快照未在同名新实例重放";
      } else {
        verdict = "批次已取消";
      }

      return { status, total, completed, counts, verdict };
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
      if (tasks > LIMIT || runs > LIMIT) {
        throw new Error("活动任务已达上限，运行中的批次不会被强制淘汰 (task limit)");
      }
      return evictions;
    }

    function validateParameters(tool, args) {
      if (!TOOLS.includes(tool)) {
        throw new Error("不支持的诊断工具 (unsupported tool)");
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("参数必须为对象 (parameters)");
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
        ) {
          throw new Error("参数必须是有限、无循环的 JSON 数据 (parameters)");
        }
        ancestors.add(value);
        for (const item of Array.isArray(value) ? value : Object.values(value)) {
          validateJSON(item);
        }
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
          ) {
            throw new Error(`必须填写 ${field}`);
          }
          parameters[field] = parameters[field].trim();
        }
      }
      const timeout = (parameters.timeoutSeconds || 30) * 1000;
      const duration = observing
        ? parameters.maxResults
          ? 6000
          : 8000
        : tool === "profiler"
          ? 4000
          : 2500;
      return {
        parameters: freeze(parameters),
        timing: { duration: Math.min(duration, timeout), timeout },
      };
    }

    function schedule(pod, delay, stages = null) {
      connections.set(pod.key, {
        target: snapshot(pod),
        startedAt: now(),
        readyAt: now() + delay,
        stages:
          stages || [
            "WS v4.channel 握手",
            "内网 HTTP Pull / 流式缓存核验",
            "jattach 零 JVM 挂载 + 随机鉴权",
          ],
      });
      readySince.delete(pod.key);
    }

    function connect(key) {
      const pod = livePod(key);
      requireOnline(environmentFor(pod.environment));
      pod.managed = true;
      if (pod.channel === "ready" || connections.has(key)) return pod;
      pod.channel = "reconnecting";
      schedule(pod, 1800);
      addEvent(
        "info",
        "开始自举挂载探针",
        `${pod.name} · ${pod.mountStrategy}`,
        pod,
      );
      return pod;
    }

    function disconnect(key) {
      const pod = livePod(key);
      requireOnline(environmentFor(pod.environment));
      if (!pod.managed) throw new Error("目标尚未挂载探针 (not managed)");
      pod.channel = "reconnecting";
      schedule(pod, 4000, ["WS 隧道闪断重连", "核验 Pod UID 与单实例鉴权"]);
      addEvent(
        "warning",
        "WS 诊断通道闪断",
        `${pod.name} · 正在无进程重连，不会静默重放任务`,
        pod,
      );
      return pod;
    }

    function finish(task, status, at) {
      task.status = status;
      task.finishedAt = at;
      task.result = status === "succeeded" ? resultFor(task, at) : null;
      dueAt.delete(task.id);
      const title = {
        succeeded: "诊断采样已完成",
        cancelled: "诊断任务已取消",
        interrupted: "任务因身份变更或超时中断",
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

    function scheduleRun(run, at) {
      const tasks = runTasks(run);
      let active = tasks.filter((task) => task.status === "running").length;
      for (const task of tasks) {
        if (!["mounting", "queued"].includes(task.status)) continue;
        const pod = state.pods.find((item) => item.key === task.target.key);
        if (!sameIdentity(pod, task.target)) {
          finish(task, "interrupted", at);
          continue;
        }
        if (pod.channel !== "ready") {
          task.status = "mounting";
          continue;
        }
        if (task.status === "mounting") {
          task.status = "queued";
        }
        if (active >= run.concurrency || !online(pod)) {
          continue;
        }
        const timing = runTiming.get(run.id);
        task.status = "running";
        task.startedAt = at;
        task.deadline = at + timing.timeout;
        dueAt.set(task.id, at + timing.duration);
        active++;
      }
    }

    function startRun(keys, tool, args = {}, options = {}) {
      if (!Array.isArray(keys) || !keys.length) {
        throw new Error("至少选择一个目标 (empty targets)");
      }
      if (new Set(keys).size !== keys.length) {
        throw new Error("目标不可重复 (duplicate targets)");
      }
      const autoMount = options && options.autoMount === true;
      const pods = Array.from(keys, (key) => {
        const pod = livePod(key);
        requireOnline(environmentFor(pod.environment));
        if (!autoMount && pod.channel !== "ready") {
          throw new Error("目标探针尚未挂载，请启用一键自动挂载或先连接 (not ready)");
        }
        return pod;
      });
      if (pods.some((pod) => pod.environment !== pods[0].environment)) {
        throw new Error("单次诊断批次只能属于同一环境 (mixed environments)");
      }
      const { parameters, timing } = validateParameters(tool, args);
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new Error("运行选项必须为对象 (options)");
      }
      const source = options.source === undefined ? "web" : options.source;
      if (!["web", "mcp"].includes(source)) {
        throw new Error("不支持的调用来源 (unsupported source)");
      }
      const client =
        options.client === undefined
          ? source === "mcp"
            ? "Cursor / Claude MCP"
            : "Web 精密工作台"
          : options.client;
      const title =
        options.title === undefined
          ? `${tool.toUpperCase()} · ${pods[0].workloadName} (${pods.length} 副本)`
          : options.title;
      const concurrency =
        options.concurrency === undefined ? 2 : options.concurrency;
      if (
        typeof client !== "string" ||
        !client.trim() ||
        typeof title !== "string" ||
        !title.trim()
      ) {
        throw new Error("批次标题与客户端标识不可为空 (options)");
      }
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
        throw new Error("concurrency 必须为 1–4 的整数");
      }

      const evictions = capacityEvictions(pods.length);
      for (const old of evictions) {
        state.tasks = state.tasks.filter((task) => task.runId !== old.id);
        state.runs.splice(state.runs.indexOf(old), 1);
        runTiming.delete(old.id);
      }

      const at = now();
      if (autoMount) {
        for (const pod of pods) {
          if (pod.channel !== "ready") {
            connect(pod.key);
          }
        }
      }

      const targets = freeze(pods.map(snapshot));
      const run = {
        id: `run-${String(++runSequence).padStart(4, "0")}`,
        title,
        source,
        client,
        concurrency,
        autoMount,
        environment: pods[0].environment,
        tool,
        parameters,
        targetSnapshots: targets,
        createdAt: at,
        taskIds: [],
      };
      const tasks = targets.map((target) => ({
        id: `task-${String(++taskSequence).padStart(4, "0")}`,
        runId: run.id,
        source: run.source,
        client: run.client,
        target,
        tool: run.tool,
        status: target.channel === "ready" ? "queued" : "mounting",
        createdAt: at,
        startedAt: null,
        finishedAt: null,
        parameters: run.parameters,
        result: null,
        deadline: null,
      }));
      run.taskIds = freeze(tasks.map((t) => t.id));
      state.runs.push(run);
      state.tasks.push(...tasks);
      runTiming.set(run.id, timing);

      addEvent(
        "info",
        "诊断批次已锁定目标快照",
        `${run.title} · 来源 ${run.source.toUpperCase()} · 并发上限 ${concurrency}`,
        targets[0],
        at,
      );
      scheduleRun(run, at);
      return run;
    }

    function startTask(key, tool, args = {}, options = {}) {
      const run = startRun([key], tool, args, options);
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

    function mountProgress(key) {
      const item = connections.get(key);
      if (!item) return null;
      const total = Math.max(1, item.readyAt - item.startedAt);
      const elapsed = Math.max(0, Math.min(total, now() - item.startedAt));
      const pct = Math.min(99, Math.floor((elapsed / total) * 100));
      const stageIdx = Math.min(
        item.stages.length - 1,
        Math.floor((elapsed / total) * item.stages.length),
      );
      return {
        percent: pct,
        stage: item.stages[stageIdx],
        stages: item.stages,
        stageIndex: stageIdx,
      };
    }

    function tick() {
      const at = now();
      for (const [key, pendingConn] of connections) {
        const pod = state.pods.find((item) => item.key === key);
        if (!sameIdentity(pod, pendingConn.target) || !pod.managed) {
          connections.delete(key);
        } else if (online(pod) && at >= pendingConn.readyAt) {
          pod.channel = "ready";
          readySince.set(key, pendingConn.readyAt);
          connections.delete(key);
          addEvent(
            "success",
            "探针就绪 · WS 免进程通道已连通",
            `${pod.name} · PID ${pod.pid} · 代次 g${pod.generation}`,
            pod,
            pendingConn.readyAt,
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
        if (task.status !== "running") continue;
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
        cpuLoad: 16,
        heapPct: 38,
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
        if (task.target.key === key && pending(task)) {
          finish(task, "interrupted", now());
        }
      }
      state.pods.push(replacement);
      if (managed) schedule(replacement, 1800);
      addEvent(
        "warning",
        "检测到 Pod 重建（UID 变更）",
        `${pod.name} -> g${generation} · 旧批次立即中断且绝不自动重放`,
        replacement,
      );
      return replacement;
    }

    function setPolicy(environment, app, policy) {
      const key = policyKey(environment, app);
      if (!Object.hasOwn(state.policies, key)) {
        throw new Error("环境或工作负载不存在 (unknown context)");
      }
      if (!["selected", "all", "discover"].includes(policy)) {
        throw new Error("不支持的纳管策略 (unsupported policy)");
      }
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
          "该工作负载仍有执行或排队中的诊断任务，禁止释放通道 (running tasks)",
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
        "探针维护策略已更新",
        `${environment} / ${app} -> ${policy}`,
        { environment, app },
      );
      return policy;
    }

    function scanLocal(environment = "local") {
      const device = environmentFor(environment);
      if (!device || device.kind !== "local") {
        throw new Error("本地设备不存在 (unknown local environment)");
      }
      requireOnline(device);
      if (!localScanned.has(environment)) {
        localScanned.add(environment);
        const pod = localPod(
          device,
          31240,
          "com.acme.PaymentApplication",
          "8085",
          "discovered",
        );
        state.pods.push(pod);
        addEvent(
          "info",
          "hsperfdata 本机扫描完成",
          "10ms 内发现 1 个新 JVM 进程 (PID 31240 :8085)",
          pod,
        );
        if (state.policies[policyKey(environment, "local")] === "all") {
          connect(pod.key);
        }
      }
      return listPods(environment, "local");
    }

    function seedRun(pods, tool, args, source, title, at, duration) {
      const { parameters, timing } = validateParameters(tool, args);
      if (duration !== undefined) timing.duration = duration;
      const targets = freeze(pods.map(snapshot));
      const run = {
        id: `run-${String(++runSequence).padStart(4, "0")}`,
        source,
        client: source === "mcp" ? "Cursor / Claude MCP" : "Web 精密工作台",
        title,
        concurrency: 2,
        autoMount: false,
        environment: pods[0].environment,
        tool,
        parameters,
        targetSnapshots: targets,
        createdAt: at,
        taskIds: [],
      };
      const tasks = targets.map((target) => ({
        id: `task-${String(++taskSequence).padStart(4, "0")}`,
        runId: run.id,
        source: run.source,
        client: run.client,
        target,
        tool: run.tool,
        status: "queued",
        createdAt: at,
        startedAt: null,
        finishedAt: null,
        parameters: run.parameters,
        result: null,
        deadline: null,
      }));
      run.taskIds = freeze(tasks.map((t) => t.id));
      state.runs.push(run);
      state.tasks.push(...tasks);
      runTiming.set(run.id, timing);
      scheduleRun(run, at);
      return run;
    }

    const prodOrders = listPods("production", "orders");
    const mcpDiffRun = seedRun(
      prodOrders.slice(0, 3),
      "thread",
      {},
      "mcp",
      "order-service 三副本线程横向差分",
      startedAt - 24000,
    );
    const mcpTasks = runTasks(mcpDiffRun);
    finish(mcpTasks[0], "succeeded", startedAt - 21000);
    finish(mcpTasks[1], "succeeded", startedAt - 21000);
    scheduleRun(mcpDiffRun, startedAt - 21000);
    finish(mcpTasks[2], "succeeded", startedAt - 18000);

    const traceRun = seedRun(
      prodOrders.slice(0, 3),
      "trace",
      {
        classPattern: "sample.orders.OrderOrchestrator",
        methodPattern: "createOrder",
      },
      "web",
      "createOrder 三副本调用链耗时对比",
      startedAt - 14000,
    );
    const traceTasks = runTasks(traceRun);
    finish(traceTasks[0], "succeeded", startedAt - 9000);
    finish(traceTasks[1], "succeeded", startedAt - 9000);
    scheduleRun(traceRun, startedAt - 9000);
    finish(traceTasks[2], "succeeded", startedAt - 4000);

    const stagingRun = seedRun(
      [listPods("staging", "orders")[0]],
      "memory",
      {},
      "web",
      "测试集群内存基线核验",
      startedAt - 8000,
    );
    finish(runTasks(stagingRun)[0], "succeeded", startedAt - 5500);

    const liveWatchRun = seedRun(
      [prodOrders[1]],
      "watch",
      {
        classPattern: "sample.orders.OrderOrchestrator",
        methodPattern: "createOrder",
        timeoutSeconds: 90,
      },
      "web",
      "生产副本 00002 实时入参监听",
      startedAt,
      90000,
    );
    addEvent(
      "info",
      "实时方法观测运行中",
      `${runTasks(liveWatchRun)[0].target.name} · 监听窗口 90s`,
      prodOrders[1],
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
      mountProgress,
    };
  }

  root.WorkbenchDemo = { createStore };
})(window);
