import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const adapter = readFileSync(new URL('../docs/preview/mock.js', import.meta.url), 'utf8');
const tools = ['jvm', 'memory', 'thread', 'version', 'trace', 'watch'];
const origins = [
  'file:///C:/checkout/docs/preview/index.html',
  'https://example.github.io/arthas-workbench/preview/',
  'http://localhost:8080/docs/preview/'
];
for (const href of origins) {
  let clock = 0, nativeCalls = 0, submitted = 0, onReady;
  const token = {value: ''};
  const loginForm = {requestSubmit() {
    assert.equal(token.value, 'preview-only-not-a-real-token');
    submitted++;
  }};
  const sandbox = {
    window: {fetch() { nativeCalls++; throw new Error('Native network must never run'); }},
    document: {
      addEventListener(event, handler) { assert.equal(event, 'DOMContentLoaded'); onReady = handler; },
      querySelector(selector) {
        assert.ok(['#token', '#login-form'].includes(selector));
        return selector === '#token' ? token : loginForm;
      }
    },
    location: {href}, URL, Response,
    Date: class extends Date {static now() {return clock;}}
  };
  vm.runInNewContext(adapter, sandbox);
  assert.equal(sandbox.window.WORKBENCH_PREVIEW, true);
  assert.equal(submitted, 0);
  onReady();
  assert.equal(submitted, 1);
  const fetch = sandbox.window.fetch;
  const readState = async () => (await fetch('/api/state')).json();
  const readJob = async job => (await fetch(`/api/jobs/${job.id}`)).json();
  const post = operation => fetch('/api/jobs', {method: 'POST', body: JSON.stringify(operation)});
  const start = async operation => {
    const response = await post(operation);
    assert.equal(response.status, 202);
    const created = await response.json();
    assert.equal(created.status, 'running');
    return created;
  };
  const reject = async (operation, message) => {
    const response = await post(operation);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, message);
  };
  const finish = async (job, delay = 700) => {
    let current = await readJob(job);
    assert.equal(current.status, 'running');
    assert.equal(current.result, null);
    clock += delay - 1;
    current = await readJob(job);
    assert.equal(current.status, 'running');
    assert.equal(current.result, null);
    clock++;
    current = await readJob(job);
    assert.equal(current.status, 'succeeded');
    assert.equal(current.error, null);
    assert.equal(current.result.simulated, true);
    return current.result;
  };
  const cancel = async job => {
    const response = await fetch(`/api/jobs/${job.id}`, {method: 'DELETE'});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {id: job.id, cancel_requested: true});
    clock += 5000;
    const cancelled = await readJob(job);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.result, null);
    assert.match(cancelled.error, /已取消/);
  };

  const initial = await readState();
  assert.equal(initial.instances.length, 4);
  assert.equal(initial.instances[0].id, 'workstation:order-service');
  assert.equal(initial.instances[0].kind, 'local');
  assert.equal(initial.instances[0].status, 'ready');
  assert.equal(initial.instances[1].id, 'test-cluster:payment-pod');
  assert.equal(initial.instances[1].kind, 'k8s');
  assert.equal(initial.instances.filter(instance => instance.kind === 'local').length, 2);
  assert.equal(initial.instances.filter(instance => instance.kind === 'k8s').length, 2);
  assert.deepEqual(initial.instances.map(instance => instance.status).sort(), ['offline', 'ready', 'unavailable', 'unknown']);
  assert.equal(new Set(initial.instances.map(instance => instance.id)).size, 4);
  assert.ok(initial.scopes.includes('attach'));
  for (const instance of initial.instances) {
    const connector = initial.nodes.find(node => node.id === instance.node_id);
    assert.ok(connector);
    assert.equal(instance.id, `${instance.node_id}:${instance.target_id}`);
    assert.equal(connector.online, instance.status !== 'offline');
    assert.deepEqual(connector.capabilities, instance.kind === 'local' ? ['scan_java', 'attach_local'] : []);
  }
  const ready = initial.instances[0];
  const unknown = initial.instances.find(instance => instance.status === 'unknown');
  const unavailable = initial.instances.find(instance => instance.status === 'unavailable');
  const offline = initial.instances.find(instance => instance.status === 'offline');

  // Root-relative APIs work under file:// and hosted subdirectories; same-origin URLs also work.
  const stateURL = new URL('/api/state?preview=1', href);
  assert.deepEqual(await (await fetch(stateURL.href)).json(), initial);
  assert.deepEqual(await (await fetch(stateURL)).json(), initial);
  assert.deepEqual(await (await fetch(new Request(stateURL))).json(), initial);
  const scanRequest = new Request(new URL('/api/jobs', href), {
    method: 'POST', body: JSON.stringify({action: 'scan_java', node_id: ready.node_id})
  });
  const scanResponse = await fetch(scanRequest);
  assert.equal(scanResponse.status, 202);
  const scanned = await finish(await scanResponse.json());
  assert.equal(scanned.available, true);
  assert.deepEqual(scanned.processes, [
    {pid: 24080, identity: 'demo.OrderService -Xmx1g'},
    {pid: 28120, identity: 'demo.InventoryService -Xmx512m'}
  ]);

  // Offline connectors reject every operation and never become ready.
  for (const operation of [
    {action: 'probe', instance_id: offline.id},
    {action: 'diagnose', instance_id: offline.id, tool: 'jvm'},
    {action: 'scan_java', node_id: offline.node_id},
    {action: 'attach_local', instance_id: offline.id, ...scanned.processes[0]}
  ]) await reject(operation, /离线/);
  await reject({action: 'scan_java', node_id: unavailable.node_id}, /不支持扫描/);
  await reject({action: 'attach_local', instance_id: unavailable.id, ...scanned.processes[0]}, /仅本机/);
  await reject({action: 'diagnose', instance_id: unavailable.id, tool: 'jvm'}, /尚未就绪/);
  await reject({action: 'diagnose', instance_id: ready.id, tool: 'ognl'}, /未实现/);
  await reject({action: 'diagnose', instance_id: ready.id, tool: 'not-a-tool'}, /未实现/);
  await reject({action: 'probe', instance_id: 'missing:target'}, /不存在/);
  await reject({action: 'scan_java', node_id: 'missing'}, /不存在/);
  await reject({action: 'attach_local', instance_id: unknown.id, pid: 28120, identity: 'wrong-process'}, /准确 PID/);
  await reject({action: 'attach_local', instance_id: unknown.id, pid: 99999, identity: scanned.processes[1].identity}, /准确 PID/);
  await reject({action: 'unsupported'}, /不支持/);
  await reject(null, /操作对象/);
  await reject([], /操作对象/);
  const invalidJSON = await fetch('/api/jobs', {method: 'POST', body: '{'});
  assert.equal(invalidJSON.status, 400);
  assert.deepEqual(await readState(), initial);

  // Cancelled probes cannot recover either unknown or unavailable targets, even after their deadline.
  for (const target of [unknown, unavailable]) {
    const probe = await start({action: 'probe', instance_id: target.id});
    clock += 699;
    assert.equal((await readJob(probe)).status, 'running');
    assert.deepEqual(await readState(), initial);
    await cancel(probe);
    assert.deepEqual(await readState(), initial);
  }
  const recovery = await start({action: 'probe', instance_id: unavailable.id});
  clock += 699;
  assert.equal((await readJob(recovery)).status, 'running');
  assert.deepEqual(await readState(), initial);
  clock++;
  const recovered = await readJob(recovery);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.result.simulated, true);
  assert.equal(recovered.result.instance, unavailable.id);
  assert.equal(recovered.result.tasks, true);
  assert.deepEqual(recovered.result.tools, tools);
  const afterRecovery = await readState();
  assert.equal(afterRecovery.instances.find(instance => instance.id === unavailable.id).status, 'ready');
  assert.equal(afterRecovery.instances.find(instance => instance.id === unknown.id).status, 'unknown');
  assert.equal(afterRecovery.instances.find(instance => instance.id === offline.id).status, 'offline');
  const finishedCancel = await fetch(`/api/jobs/${recovery.id}`, {method: 'DELETE'});
  assert.equal((await finishedCancel.json()).cancel_requested, false);
  assert.equal((await readJob(recovery)).status, 'succeeded');
  assert.deepEqual(await readState(), afterRecovery);

  // Attach updates the selected registered target only after success; cancellation leaves it untouched.
  const attachOperation = {action: 'attach_local', instance_id: unknown.id, ...scanned.processes[1]};
  const cancelledAttach = await start(attachOperation);
  clock += 699;
  assert.equal((await readJob(cancelledAttach)).result, null);
  assert.deepEqual(await readState(), afterRecovery);
  await cancel(cancelledAttach);
  assert.deepEqual(await readState(), afterRecovery);
  const attach = await start(attachOperation);
  assert.deepEqual(await readState(), afterRecovery);
  const attached = await finish(attach);
  assert.equal(attached.success, true);
  assert.equal(attached.instance, unknown.id);
  assert.equal(attached.pid, scanned.processes[1].pid);
  assert.equal(attached.identity, scanned.processes[1].identity);
  const afterAttach = await readState();
  assert.equal(afterAttach.instances.length, 4);
  const attachedTarget = afterAttach.instances.find(instance => instance.id === unknown.id);
  assert.equal(attachedTarget.status, 'ready');
  assert.match(attachedTarget.detail, /28120/);
  assert.deepEqual(afterAttach.instances.filter(instance => instance.id !== unknown.id), afterRecovery.instances.filter(instance => instance.id !== unknown.id));
  assert.deepEqual((await readJob(attach)).result, attached);
  assert.deepEqual(await readState(), afterAttach);

  // All six implemented tools return distinct, stable examples with no claimed live measurements.
  const results = new Map();
  for (const tool of tools) {
    const operation = {action: 'diagnose', instance_id: ready.id, tool,
      arguments: {classPattern: 'demo.OrderService', methodPattern: 'createOrder', express: '{params,returnObj,throwExp}'}};
    const result = await finish(await start(operation), ['trace', 'watch'].includes(tool) ? 3500 : 700);
    assert.equal(result.instance, ready.id);
    assert.equal(result.tool, tool);
    results.set(tool, result);
  }
  assert.equal(results.get('jvm').pid, 24080);
  assert.deepEqual(results.get('memory').heap, {used: null, committed: null, max: null});
  assert.ok(results.get('thread').threads.length > 0);
  assert.match(results.get('version').version, /mock/);
  assert.equal(results.get('trace').class, 'demo.OrderService');
  assert.equal(results.get('trace').method, 'createOrder');
  assert.ok(results.get('trace').calls.length > 0);
  assert.equal(results.get('trace').elapsed_ms, undefined);
  assert.equal(results.get('watch').sample.params[0].orderId, 'DEMO-1001');
  assert.equal(results.get('watch').sample.throwExp, null);
  const repeat = await finish(await start({action: 'diagnose', instance_id: ready.id, tool: 'jvm'}));
  assert.deepEqual(repeat, results.get('jvm'));
  const inventoryJvm = await finish(await start({action: 'diagnose', instance_id: unknown.id, tool: 'jvm'}));
  assert.equal(inventoryJvm.pid, attached.pid);
  assert.equal(inventoryJvm.process, attached.identity);
  for (const tool of ['trace', 'watch']) {
    const job = await start({action: 'diagnose', instance_id: ready.id, tool, arguments: {classPattern: 'demo.OrderService'}});
    clock += 700;
    assert.equal((await readJob(job)).status, 'running');
    await cancel(job);
  }
  assert.deepEqual(await readState(), afterAttach);

  // Unsupported routes/methods and foreign origins must throw, without delegating to native fetch.
  for (const input of [
    'https://untrusted.example/real-network',
    'https://untrusted.example/api/state',
    '//untrusted.example/api/state',
    'https://example.github.io.untrusted.example/api/state',
    'https://example.github.io@untrusted.example/api/state',
    'file://untrusted.example/api/state',
    'data:/api/state',
    'blob:https://untrusted.example/api/state',
    new URL('https://untrusted.example/api/state'),
    new Request('https://untrusted.example/api/state'),
    '/api/unknown', '/api/jobs', '/api/jobs/preview-1/extra'
  ]) await assert.rejects(() => fetch(input), /禁止真实网络请求/);
  if (new URL(href).protocol !== 'file:') {
    await assert.rejects(() => fetch('file:///api/state'), /禁止真实网络请求/);
    const foreignPort = new URL('/api/state', href);
    foreignPort.port = '9999';
    await assert.rejects(() => fetch(foreignPort.href), /禁止真实网络请求/);
  } else {
    await assert.rejects(() => fetch('file:///D:/api/state'), /禁止真实网络请求/);
  }
  await assert.rejects(() => fetch('https://untrusted.example/api/jobs', {method: 'POST', body: JSON.stringify(attachOperation)}), /禁止真实网络请求/);
  await assert.rejects(() => fetch('/api/state', {method: 'POST'}), /禁止真实网络请求/);
  await assert.rejects(() => fetch('/api/jobs', {method: 'GET'}), /禁止真实网络请求/);
  await assert.rejects(() => fetch(`/api/jobs/${attach.id}`, {method: 'PATCH'}), /禁止真实网络请求/);
  assert.equal((await fetch('/api/jobs/missing')).status, 404);
  assert.equal((await fetch('/api/jobs/missing', {method: 'DELETE'})).status, 404);
  assert.equal(nativeCalls, 0);
  assert.deepEqual(await readState(), afterAttach);
}
console.log('Static preview: file, HTTP and HTTPS origins; auto login; 4 targets; 6 simulated tools; scan/attach; offline rejection; cancellation; probe recovery; foreign-origin and unknown-request guards passed.');
