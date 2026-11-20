import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  new URL("../ui-prototype/model.js", import.meta.url),
  "utf8",
);
const baseTime = Date.UTC(2026, 10, 18, 8, 0, 0);
const plain = (value) => JSON.parse(JSON.stringify(value));
const patterns = {
  classPattern: "sample.orders.OrderOrchestrator",
  methodPattern: "createOrder",
};

const forbidden = () => {
  throw new Error(
    "Offline model must not use network, storage, DOM, timers, or randomness",
  );
};

function fixture() {
  let clock = baseTime;
  const window = {};
  const sandbox = {
    window,
    Date: class extends Date {
      static now() {
        return clock;
      }
    },
  };
  for (const name of [
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "setTimeout",
    "setInterval",
    "requestAnimationFrame",
  ]) {
    sandbox[name] = window[name] = forbidden;
  }
  for (const name of [
    "document",
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "navigator",
  ]) {
    Object.defineProperty(sandbox, name, { get: forbidden });
    Object.defineProperty(window, name, { get: forbidden });
  }
  const context = vm.createContext(sandbox);
  vm.runInContext(
    'Math.random = () => { throw new Error("Random data is forbidden"); };',
    context,
  );
  vm.runInContext(source, context, { filename: "ui-prototype/model.js" });
  assert.equal(typeof window.WorkbenchDemo.createStore, "function");
  const store = window.WorkbenchDemo.createStore({ now: () => clock });
  return {
    store,
    window,
    advance(ms) {
      clock += ms;
      store.tick();
    },
    elapse(ms) {
      clock += ms;
    },
  };
}

let passed = 0;
function check(name, body) {
  body();
  passed++;
  console.log(`PASS ${name}`);
}

const children = (store, run) =>
  run.taskIds.map((id) => store.state.tasks.find((task) => task.id === id));

check("1. deterministic store, 5 environments (incl. Flink JRE) and non-PID1 container JVMs", () => {
  const first = fixture();
  const second = fixture();
  assert.deepEqual(plain(first.store.state), plain(second.store.state));
  const envIds = plain(first.store.state.environments.map((e) => e.id));
  assert.deepEqual(envIds, ["production", "staging", "flink", "local", "local-build"]);
  const prodOrders = first.store.listPods("production", "orders");
  assert.equal(prodOrders.length, 6);
  assert.ok(prodOrders.every((p) => p.pid === 8));
  assert.equal(first.store.listPods("flink", "flink-job").length, 3);
});

check("2. cross-namespace same-name workloads stay strictly isolated and init-image-tools excluded", () => {
  const { store } = fixture();
  const mainOrder = store.listPods("production", "orders")[0];
  const sandboxOrder = store.listPods("production", "orders-lab")[0];
  assert.equal(mainOrder.workloadName, sandboxOrder.workloadName);
  assert.notEqual(mainOrder.namespace, sandboxOrder.namespace);
  assert.notEqual(mainOrder.podUid, sandboxOrder.podUid);
  assert.ok(
    mainOrder.containers.some(
      (c) => c.name === "init-image-tools" && c.role === "init" && !c.javaCandidate,
    ),
  );
});

check("3. replica diff outlier detection highlights skewed replica in batch summary", () => {
  const { store } = fixture();
  const mcpRun = store.state.runs[0];
  const summary = store.runSummary(mcpRun.id);
  assert.equal(summary.status, "succeeded");
  assert.match(summary.verdict, /异常定位/);
  const tasks = children(store, mcpRun);
  assert.equal(tasks[0].result.anomalous, true);
  assert.equal(tasks[1].result.anomalous, false);
  assert.equal(tasks[2].result.anomalous, false);
});

check("4. autoMount seamlessly bootstraps unmounted target and promotes queued task", () => {
  const { store, advance } = fixture();
  const orders = store.listPods("production", "orders");
  const unmounted = orders[5];
  assert.equal(unmounted.channel, "discovered");

  assert.throws(() => store.startTask(unmounted.key, "thread"), /not ready/);

  const run = store.startRun(
    [orders[0].key, unmounted.key],
    "thread",
    {},
    { autoMount: true, concurrency: 2 },
  );
  const [tReady, tMount] = children(store, run);
  assert.equal(tReady.status, "running");
  assert.equal(tMount.status, "mounting");
  assert.equal(unmounted.channel, "reconnecting");
  assert.ok(store.mountProgress(unmounted.key));

  advance(1800);
  assert.equal(unmounted.channel, "ready");
  assert.equal(tMount.status, "running");

  advance(2500);
  assert.equal(tReady.status, "succeeded");
  assert.equal(tMount.status, "succeeded");
  assert.equal(store.runSummary(run.id).status, "succeeded");
});

check("5. Pod replacement during mounting or queueing interrupts immediately and never replays", () => {
  const { store, advance } = fixture();
  const orders = store.listPods("production", "orders");
  const target = orders[5];
  const run = store.startRun([target.key], "jvm", {}, { autoMount: true });
  const [task] = children(store, run);
  const originalSnap = plain(task.target);

  const replacement = store.replacePod(target.key);
  assert.notEqual(replacement.podUid, originalSnap.podUid);
  assert.equal(task.status, "interrupted");
  assert.equal(task.result, null);
  assert.deepEqual(plain(task.target), originalSnap);

  advance(10000);
  assert.equal(task.status, "interrupted");
  assert.ok(!store.state.tasks.some((t) => t.target.key === replacement.key));
});

check("6. bounded concurrency, independent child cancellation and partial run completion", () => {
  const { store, advance } = fixture();
  const keys = store.listPods("production", "orders").slice(0, 3).map((p) => p.key);
  const run = store.startRun(keys, "thread", {}, { concurrency: 2 });
  const tasks = children(store, run);
  assert.deepEqual(plain(tasks.map((t) => t.status)), ["running", "running", "queued"]);

  advance(2500);
  assert.deepEqual(plain(tasks.map((t) => t.status)), ["succeeded", "succeeded", "running"]);
  store.cancelRun(run.id);
  assert.equal(tasks[2].status, "cancelled");
  assert.equal(store.runSummary(run.id).status, "partial");
});

check("7. offline local device rejects actions atomically while online local hsperfdata scan is idempotent", () => {
  const { store } = fixture();
  const offlinePod = store.listPods("local-build")[0];
  const before = plain(store.state);
  assert.throws(() => store.scanLocal("local-build"), /offline/);
  assert.throws(() => store.startRun([offlinePod.key], "jvm", {}, { autoMount: true }), /offline/);
  assert.deepEqual(plain(store.state), before);

  const scanned = store.scanLocal("local");
  assert.equal(scanned.length, 3);
  assert.equal(store.scanLocal("local").length, 3);
});

check("8. all 8 diagnostic tools validate inputs strictly and produce structured evidence", () => {
  const { store, advance } = fixture();
  const pod = store.listPods("production", "orders")[0];
  assert.throws(() => store.startTask(pod.key, "trace", {}), /classPattern/);
  for (const tool of ["thread", "trace", "watch", "memory", "profiler", "jvm", "ognl", "sc"]) {
    const task = store.startTask(pod.key, tool, {
      ...patterns,
      expression: "@Spring@version",
    });
    advance(10000);
    assert.equal(task.status, "succeeded", tool);
    assert.ok(task.result.headlineMetric, tool);
  }
});

console.log(`Offline precision workbench model: ${passed} contract suites passed.`);
