/* Static review adapter. Deliberately no real network, process, JVM, or cluster access. */
(() => {
  window.WORKBENCH_PREVIEW = true;
  const tools = ['jvm', 'memory', 'thread', 'version', 'trace', 'watch'];
  const processes = [
    {pid: 24080, identity: 'demo.OrderService -Xmx1g'},
    {pid: 28120, identity: 'demo.InventoryService -Xmx512m'}
  ];
  const state = {
    user: '演示体验', scopes: ['diagnose', 'attach'], mcp_url: 'https://workbench.example/mcp',
    nodes: [
      {id: 'workstation', online: true, capabilities: ['scan_java', 'attach_local']},
      {id: 'test-cluster', online: true, capabilities: []},
      {id: 'staging-cluster', online: false, capabilities: []}
    ],
    instances: [
      {id: 'workstation:order-service', target_id: 'order-service', node_id: 'workstation', name: '订单服务 · 本机', kind: 'local', status: 'ready', detail: '演示环境 · PID 24080 · 已完成模拟连接检查，可体验六种诊断工具。'},
      {id: 'test-cluster:payment-pod', target_id: 'payment-pod', node_id: 'test-cluster', name: '支付服务 · K8s', kind: 'k8s', status: 'unavailable', detail: '演示环境 · test / demo / payment-service · 连接器在线，Arthas 端点暂不可用。检查连接可体验恢复流程。'},
      {id: 'workstation:inventory-service', target_id: 'inventory-service', node_id: 'workstation', name: '库存服务 · 本机', kind: 'local', status: 'unknown', detail: '演示环境 · 尚未检查连接。可先探测，或扫描 JVM 后选择 PID 28120 体验 Attach。'},
      {id: 'staging-cluster:report-pod', target_id: 'report-pod', node_id: 'staging-cluster', name: '报表服务 · K8s', kind: 'k8s', status: 'offline', detail: '演示环境 · staging / demo / report-service · 连接器离线，保留上次登记信息，暂不能执行操作。'}
    ]
  };
  const runtimeByTarget = new Map([
    ['workstation:order-service', processes[0]],
    ['workstation:inventory-service', processes[1]]
  ]);
  const jobs = new Map();
  let nextId = 1;
  const reply = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: {'content-type': 'application/json'}
  });
  const instanceFor = id => state.instances.find(instance => instance.id === id);

  function validate(operation) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return '请求内容必须是操作对象。';
    if (!['scan_java', 'attach_local', 'probe', 'diagnose'].includes(operation.action)) return '静态预览不支持该操作。';
    const instance = instanceFor(operation.instance_id);
    if (operation.action !== 'scan_java' && !instance) return '模拟实例不存在。';
    const connector = state.nodes.find(node => node.id === (operation.action === 'scan_java' ? operation.node_id : instance.node_id));
    if (!connector) return '模拟连接器不存在。';
    if (!connector.online) return '连接器已离线，无法执行模拟操作。';
    if (operation.action === 'scan_java' && !connector.capabilities.includes('scan_java')) return '此连接器不支持扫描本机 JVM。';
    if (operation.action === 'attach_local') {
      if (instance.kind !== 'local' || !connector.capabilities.includes('attach_local')) return '仅本机目标支持 Attach。';
      if (!processes.some(process => process.pid === operation.pid && process.identity === operation.identity)) return '请选择扫描列表中的准确 PID 和进程身份。';
    }
    if (operation.action === 'diagnose') {
      if (!tools.includes(operation.tool)) return '该工具未实现；可用工具为 jvm、memory、thread、version、trace、watch。';
      if (instance.status !== 'ready') return '实例尚未就绪，请先检查连接或完成 Attach。';
      const args = operation.arguments ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) return '工具参数必须是对象。';
      if (['trace', 'watch'].includes(operation.tool) && (typeof args.classPattern !== 'string' || !args.classPattern.trim())) return '请填写目标类名。';
    }
    return null;
  }

  function resultFor(operation) {
    if (operation.action === 'scan_java') return {
      simulated: true, available: true, processes,
      detail: '固定演示列表，未扫描本机进程。选择 PID 与进程身份后可体验 Attach。'
    };
    if (operation.action === 'attach_local') return {
      simulated: true, success: true, instance: operation.instance_id,
      pid: operation.pid, identity: operation.identity,
      message: '模拟 Attach 完成，已更新此登记目标。未访问或修改任何本机进程。'
    };
    if (operation.action === 'probe') return {
      simulated: true, protocol: '2025-06-18', tasks: true, status: '模拟连接检查通过',
      instance: operation.instance_id, tools,
      message: '模拟握手与工具发现成功，目标已就绪；未连接真实端点。'
    };
    const common = {
      simulated: true, instance: operation.instance_id, tool: operation.tool,
      message: '固定演示数据，非实际 JVM 采样。'
    };
    const runtime = runtimeByTarget.get(operation.instance_id);
    if (operation.tool === 'jvm') return {
      ...common, java_version: 'OpenJDK 21（示例配置）',
      process: runtime?.identity || 'demo.PaymentService（示例）', pid: runtime?.pid ?? null,
      guidance: '核对 Java 版本与启动参数，再结合内存和线程结果定位问题。'
    };
    if (operation.tool === 'memory') return {
      ...common, heap: {used: null, committed: null, max: null}, non_heap: {used: null},
      guidance: '预览不提供实测内存。真实诊断时先看堆占用与上限，再结合 GC 判断是否持续增长。'
    };
    if (operation.tool === 'thread') return {
      ...common, threads: [
        {name: 'http-worker-demo', state: 'RUNNABLE', stack: 'demo.OrderService.createOrder → demo.InventoryClient.reserve'},
        {name: 'scheduler-demo', state: 'TIMED_WAITING', stack: 'java.util.concurrent.ScheduledThreadPoolExecutor'}
      ], guidance: '线程与调用栈均为示例。RUNNABLE 不等于高 CPU；真实排查需结合采样与多次堆栈。'
    };
    if (operation.tool === 'version') return {
      ...common, version: 'mock-arthas-preview',
      message: '模拟版本标识，不代表真实 Arthas 版本或兼容性。'
    };
    const method = {class: operation.arguments.classPattern, method: operation.arguments.methodPattern || '*'};
    if (operation.tool === 'trace') return {
      ...common, ...method, calls: ['目标方法', '  demo.InventoryClient.reserve（示例下游调用）', '  demo.OrderRepository.save（示例持久化调用）'],
      guidance: '仅展示调用树结构，未采样耗时。真实 trace 需等待目标方法执行。'
    };
    if (operation.tool === 'watch') return {
      ...common, ...method, expression: operation.arguments.express || '{params,returnObj,throwExp}',
      sample: {params: [{orderId: 'DEMO-1001'}], returnObj: {status: 'ACCEPTED'}, throwExp: null},
      guidance: '入参、返回值与异常均为固定示例。真实 watch 需等待目标方法执行。'
    };
    throw new Error('静态预览未实现此诊断工具。');
  }

  function complete(job) {
    if (job.status !== 'running' || Date.now() < job.finish) return;
    const operation = job.operation;
    job.result = resultFor(operation);
    if (['probe', 'attach_local'].includes(operation.action)) {
      const instance = instanceFor(operation.instance_id);
      instance.status = 'ready';
      if (operation.action === 'attach_local') {
        runtimeByTarget.set(instance.id, processes.find(process => process.pid === operation.pid));
        instance.detail = `演示环境 · 已模拟 Attach 到 PID ${operation.pid} · ${operation.identity}。可继续体验诊断。`;
      } else {
        instance.detail = '演示环境 · 模拟握手与六项工具检查通过，可继续诊断；未连接真实 JVM 或集群。';
      }
    }
    job.status = 'succeeded';
  }

  window.fetch = async (input, options = {}) => {
    const blocked = () => new Error('静态预览禁止真实网络请求或未知接口');
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (typeof raw !== 'string') throw blocked();
    const page = new URL(location.href);
    let url;
    try { url = new URL(raw, page); } catch { throw blocked(); }
    // File pages have an opaque "null" origin; never equate it with another scheme or host.
    const sameOrigin = page.protocol === 'file:'
      ? url.protocol === 'file:' && url.host === page.host
      : ['http:', 'https:'].includes(page.protocol) && url.origin === page.origin;
    if (!sameOrigin || url.username || url.password) throw blocked();
    // Windows file URLs retain their drive when resolving a root-relative API path.
    const root = page.protocol === 'file:' ? new URL('/', page).pathname : '/';
    if (!url.pathname.startsWith(root)) throw blocked();
    const path = '/' + url.pathname.slice(root.length);
    const method = (options.method || input?.method || 'GET').toUpperCase();
    if (path === '/api/state' && method === 'GET') return reply(state);
    if (path === '/api/jobs' && method === 'POST') {
      let operation;
      try {
        const body = options.body ?? (typeof input?.clone === 'function' ? await input.clone().text() : '{}');
        operation = JSON.parse(body);
      } catch { return reply({error: '请求内容必须是有效 JSON。'}, 400); }
      const error = validate(operation);
      if (error) return reply({error}, 400);
      const id = `preview-${nextId++}`;
      const long = operation.action === 'diagnose' && ['trace', 'watch'].includes(operation.tool);
      jobs.set(id, {id, status: 'running', result: null, error: null, operation, finish: Date.now() + (long ? 3500 : 700)});
      return reply({id, status: 'running'}, 202);
    }
    const match = path.match(/^\/api\/jobs\/([^/]+)$/);
    if (match && ['GET', 'DELETE'].includes(method)) {
      const job = jobs.get(match[1]);
      if (!job) return reply({error: '模拟任务不存在。'}, 404);
      if (method === 'DELETE') {
        const requested = job.status === 'running';
        if (requested) { job.status = 'cancelled'; job.error = '已取消模拟任务，未应用任何变更。'; }
        return reply({id: job.id, cancel_requested: requested});
      }
      complete(job);
      return reply({id: job.id, status: job.status, result: job.result, error: job.error});
    }
    throw blocked();
  };
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('#token').value = 'preview-only-not-a-real-token';
    document.querySelector('#login-form').requestSubmit();
  });
})();
