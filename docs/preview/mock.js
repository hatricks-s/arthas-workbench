/* Static review adapter. Deliberately no real network, process, JVM, or cluster access. */
(() => {
  const state = {
    user: '原型体验', scopes: ['diagnose', 'attach'], mcp_url: 'https://workbench.example/mcp',
    nodes: [
      {id: 'workstation', online: true, capabilities: ['scan_java', 'attach_local']},
      {id: 'test-cluster', online: true, capabilities: []}
    ],
    instances: [
      {id: 'workstation:order-service', target_id: 'order-service', node_id: 'workstation', name: 'Order Service · 本机', kind: 'local', status: 'ready', detail: '模拟本机连接：选择 JVM 后即可在同一工作台中诊断。'},
      {id: 'test-cluster:payment-pod', target_id: 'payment-pod', node_id: 'test-cluster', name: 'Payment Service · K8s', kind: 'k8s', status: 'ready', detail: '模拟 K8s 连接：测试集群 / demo / payment-service。'}
    ]
  };
  const jobs = new Map();
  let nextId = 1;
  const reply = (value, status = 200) => Promise.resolve(new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}}));
  function resultFor(operation) {
    if (operation.action === 'scan_java') return {simulated: true, available: true, processes: [
      {pid: 24080, identity: 'demo.OrderService -Xmx1g'}, {pid: 28120, identity: 'demo.InventoryService -Xmx512m'}
    ]};
    if (operation.action === 'attach_local') return {simulated: true, success: true, pid: operation.pid, message: '模拟 Attach 完成。没有访问或修改任何本机进程。'};
    if (operation.action === 'probe') return {simulated: true, protocol: '2025-06-18', tasks: true, status: '连接检查完成', instance: operation.instance_id, tools: ['jvm', 'memory', 'thread', 'version', 'trace', 'watch']};
    const common = {simulated: true, instance: operation.instance_id, tool: operation.tool};
    if (operation.tool === 'jvm') return {...common, java_version: '21.0.5', vm: 'OpenJDK 64-Bit Server VM', process: operation.instance_id.startsWith('workstation') ? 'demo.OrderService' : 'demo.PaymentService', uptime: '2h 18m', heap_max: '1 GiB'};
    if (operation.tool === 'memory') return {...common, heap: {used: '248 MiB', committed: '512 MiB', max: '1 GiB'}, non_heap: {used: '96 MiB'}};
    if (operation.tool === 'thread') return {...common, threads: [{id: 21, name: 'http-worker-1', state: 'RUNNABLE', cpu: '2.4%'}, {id: 34, name: 'scheduler-1', state: 'TIMED_WAITING', cpu: '0.1%'}]};
    if (operation.tool === 'version') return {...common, version: 'mock-arthas', message: 'This is simulated version data, not a compatibility claim.'};
    return {...common, class: operation.arguments?.classPattern, method: operation.arguments?.methodPattern, executions: 1, elapsed_ms: 12.8, message: '模拟捕获一次方法调用。实际操作会等待目标方法被执行。'};
  }
  window.fetch = async (input, options = {}) => {
    const raw = typeof input === 'string' ? input : input.url;
    const path = raw.startsWith('/') ? raw.split('?')[0] : new URL(raw, location.href).pathname;
    const method = (options.method || 'GET').toUpperCase();
    if (path === '/api/state') return reply(state);
    if (path === '/api/jobs' && method === 'POST') {
      const operation = JSON.parse(options.body || '{}');
      const id = `preview-${nextId++}`;
      const long = ['trace', 'watch'].includes(operation.tool);
      const job = {id, status: 'running', result: resultFor(operation), error: null, finish: Date.now() + (long ? 3500 : 700)};
      jobs.set(id, job);
      return reply({id, status: 'running'}, 202);
    }
    if (path.startsWith('/api/jobs/')) {
      const job = jobs.get(path.split('/').pop());
      if (!job) return reply({error: '模拟任务不存在'}, 404);
      if (method === 'DELETE') {job.status = 'cancelled';job.error = '已取消模拟任务。';return reply({cancel_requested: true});}
      if (job.status === 'running' && Date.now() >= job.finish) job.status = 'succeeded';
      return reply(job);
    }
    throw new Error('静态预览禁止真实网络请求');
  };
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('#token').value = 'preview-only-not-a-real-token';
    document.querySelector('#login-form').requestSubmit();
  });
})();
