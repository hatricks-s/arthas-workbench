import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const adapter = readFileSync(new URL('../docs/preview/mock.js', import.meta.url), 'utf8');
for (const href of ['file:///C:/checkout/docs/preview/index.html', 'https://example.github.io/arthas-workbench/preview/']) {
  let clock = 0;
  const sandbox = {window: {}, document: {addEventListener() {}}, location: {href}, URL, Response,
    Date: class extends Date {static now() {return clock;}}};
  vm.runInNewContext(adapter, sandbox);
  const fetch = sandbox.window.fetch;
  const state = await (await fetch('/api/state')).json();
  assert.equal(state.instances.length, 2);
  assert.equal(state.instances[0].kind, 'local');
  assert.equal(state.instances[1].kind, 'k8s');
  const created = await (await fetch('/api/jobs', {method: 'POST', body: JSON.stringify({
    action: 'diagnose', instance_id: state.instances[0].id, tool: 'jvm'})})).json();
  const jobPath = `/api/jobs/${created.id}`;
  assert.equal((await (await fetch(jobPath)).json()).status, 'running');
  clock = 1000;
  const completed = await (await fetch(jobPath)).json();
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result.simulated, true);
  await fetch(jobPath, {method: 'DELETE'});
  assert.equal((await (await fetch(jobPath)).json()).status, 'cancelled');
  await assert.rejects(() => fetch('https://untrusted.example/real-network'), /禁止真实网络请求/);
}
console.log('Static preview: file and hosted origins, simulated jobs, cancellation, and network guard passed.');
