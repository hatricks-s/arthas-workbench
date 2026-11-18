import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
    new URL("../ui-prototype/model.js", import.meta.url),
    "utf8",
);
const baseTime = Date.UTC(2026, 0, 15, 9);
const plain = (value) => JSON.parse(JSON.stringify(value));
const patterns = {
    classPattern: "demo.orders.OrderService",
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

const checks = [];
function check(name, body) {
    body();
    checks.push(name);
    console.log(`PASS ${name}`);
}

check(
    "deterministic seeds, complete identities, independent stores, and default clock",
    () => {
        const first = fixture();
        const second = fixture();
        const { store } = first;
        assert.deepEqual(plain(store.state), plain(second.store.state));
        assert.deepEqual(
            plain(first.window.WorkbenchDemo.createStore().state),
            plain(store.state),
        );
        for (const api of [
            "listPods",
            "startTask",
            "cancelTask",
            "tick",
            "disconnect",
            "replacePod",
            "setPolicy",
            "scanLocal",
            "connect",
            "startRun",
            "runSummary",
            "cancelRun",
        ])
            assert.equal(typeof store[api], "function");
        assert.deepEqual(
            plain(
                store.state.environments
                    .filter((item) => item.kind === "k8s")
                    .map((item) => [item.id, item.name]),
            ),
            [
                ["production", "生产环境"],
                ["staging", "预发环境"],
                ["development", "开发环境"],
            ],
        );
        for (const id of [
            "orders",
            "payments",
            "inventory",
            "gateway",
            "orders-lab",
        ])
            assert.ok(store.state.apps.some((item) => item.id === id));
        assert.ok(
            store.state.apps.every(
                (item) =>
                    item.name &&
                    item.description &&
                    item.owner &&
                    item.namespace &&
                    item.kind &&
                    item.javaVersion,
            ),
        );
        for (const [environment, count] of [
            ["production", 6],
            ["staging", 3],
            ["development", 2],
        ]) {
            assert.equal(store.listPods(environment, "orders").length, count);
            for (const app of [
                "payments",
                "inventory",
                "gateway",
                "orders-lab",
            ])
                assert.equal(store.listPods(environment, app).length, 2);
        }
        const production = store.listPods("production", "orders");
        assert.deepEqual(plain(production.map((pod) => pod.channel)), [
            "ready",
            "ready",
            "ready",
            "ready",
            "reconnecting",
            "discovered",
        ]);
        assert.deepEqual(
            [...new Set(production.map((pod) => pod.node))],
            ["worker-01", "worker-02", "worker-03"],
        );
        const locals = store.listPods("local", "local");
        assert.deepEqual(plain(locals.map((pod) => pod.channel)), [
            "ready",
            "discovered",
        ]);
        assert.notEqual(locals[0].pid, locals[1].pid);
        assert.ok(locals.every((pod) => pod.kind === "local"));
        for (const field of ["key", "podUid"])
            assert.equal(
                new Set(store.state.pods.map((pod) => pod[field])).size,
                store.state.pods.length,
            );
        const fields = [
            "key",
            "environment",
            "app",
            "kind",
            "name",
            "podUid",
            "generation",
            "node",
            "connector",
            "container",
            "pid",
            "channel",
            "managed",
            "restarts",
            "age",
            "retired",
            "namespace",
            "clusterId",
            "workloadName",
            "workloadKind",
            "containerCount",
            "containerId",
            "jvmIdentity",
            "readyContainers",
            "javaCandidate",
            "containers",
            "javaVersion",
        ];
        assert.ok(
            store.state.pods.every((pod) =>
                fields.every((field) => Object.hasOwn(pod, field)),
            ),
        );
        for (const task of store.state.tasks) {
            const run = store.state.runs.find((item) => item.id === task.runId);
            assert.ok(run.taskIds.includes(task.id));
            assert.ok(["web", "mcp"].includes(task.source));
            assert.equal(task.source, run.source);
            assert.equal(task.client, run.client);
            assert.strictEqual(task.parameters, run.parameters);
            assert.ok(run.targetSnapshots.includes(task.target));
        }
        const mcpRun = store.state.runs.find((run) => run.source === "mcp");
        assert.equal(mcpRun.tool, "thread");
        assert.equal(mcpRun.client, "IDE MCP 客户端");
        assert.equal(store.runSummary(mcpRun.id).status, "succeeded");
        const batch = mcpRun.taskIds.map((id) =>
            store.state.tasks.find((task) => task.id === id),
        );
        assert.equal(batch.length, 3);
        assert.equal(
            new Set(batch.map((task) => task.result.threads[0].cpu)).size,
            3,
        );
        assert.ok(
            batch.every(
                (task) =>
                    task.target.environment === "production" &&
                    task.target.app === "orders",
            ),
        );
        assert.ok(
            batch.every(
                (task) =>
                    task.createdAt <= task.startedAt &&
                    task.startedAt < task.finishedAt &&
                    task.finishedAt < baseTime,
            ),
        );
        const watch = store.state.tasks.find(
            (task) => task.status === "running",
        );
        assert.equal(watch.tool, "watch");
        assert.equal(watch.deadline, baseTime + 90000);
        assert.equal(
            store.state.tasks.find((task) => task.tool === "trace").result.trace
                .length,
            5,
        );
        assert.equal(
            store.state.tasks.find((task) => task.tool === "thread").target
                .environment,
            "staging",
        );
        first.advance(89999);
        assert.equal(watch.status, "running");
        first.advance(1);
        assert.equal(watch.status, "succeeded");
        assert.equal(production[4].channel, "reconnecting");
        assert.equal(
            second.store.state.tasks.find((task) => task.tool === "watch")
                .status,
            "running",
        );
    },
);

check(
    "same application in different environments stays isolated; exact immutable snapshots",
    () => {
        const { store, advance } = fixture();
        const production = store.listPods("production", "orders")[0];
        const staging = store.listPods("staging", "orders")[0];
        assert.equal(production.name, staging.name);
        assert.notEqual(production.key, staging.key);
        const args = { filter: { labels: ["original"] } };
        const task = store.startTask(production.key, "jvm", args);
        const captured = plain(task.target);
        assert.deepEqual(captured, {
            ...plain(production),
            environmentName: "生产环境",
            appName: "order-service",
        });
        assert.ok(Object.isFrozen(task.target));
        assert.ok(Object.isFrozen(task.parameters.filter.labels));
        assert.throws(() => {
            task.target.pid = 999;
        }, TypeError);
        args.filter.labels[0] = "changed";
        assert.equal(task.parameters.filter.labels[0], "original");
        const stagingBefore = plain(staging);
        store.disconnect(production.key);
        assert.deepEqual(plain(staging), stagingBefore);
        store.listPods("staging", "orders");
        store.listPods("development", "payments");
        assert.deepEqual(plain(task.target), captured);
        advance(3000);
        assert.equal(task.status, "running");
        advance(2000);
        assert.equal(task.status, "succeeded");
        assert.equal(task.result.jvm.application, "order-service");
        assert.deepEqual(plain(task.target), captured);
    },
);

check(
    "reconnect recovers only one generation, never resubmits, and explicit connect is idempotent",
    () => {
        const { store, advance } = fixture();
        const pods = store.listPods("production", "orders");
        const task = store.startTask(pods[0].key, "jvm");
        const beforeOthers = plain(
            store.state.pods.filter((pod) => pod.key !== pods[0].key),
        );
        const taskIds = plain(store.state.tasks.map((item) => item.id));
        store.disconnect(pods[0].key);
        advance(4999);
        assert.equal(pods[0].channel, "reconnecting");
        assert.equal(task.status, "running");
        advance(1);
        assert.equal(pods[0].channel, "ready");
        assert.equal(task.status, "succeeded");
        assert.deepEqual(
            plain(store.state.pods.filter((pod) => pod.key !== pods[0].key)),
            beforeOthers,
        );
        assert.deepEqual(
            plain(store.state.tasks.map((item) => item.id)),
            taskIds,
        );
        assert.equal(pods[4].channel, "reconnecting");
        assert.strictEqual(store.connect(pods[4].key), pods[4]);
        const eventCount = store.state.events.length;
        advance(1000);
        store.connect(pods[4].key);
        assert.equal(store.state.events.length, eventCount);
        advance(999);
        assert.equal(pods[4].channel, "reconnecting");
        advance(1);
        assert.equal(pods[4].channel, "ready");
        assert.deepEqual(
            plain(store.state.tasks.map((item) => item.id)),
            taskIds,
        );
        assert.equal(pods[5].channel, "discovered");
    },
);

check(
    "cancelled tasks stay cancelled; missed deadlines interrupt even on a late tick",
    () => {
        const { store, advance, elapse } = fixture();
        const [pod] = store.listPods("production", "orders");
        const cancelled = store.startTask(pod.key, "watch", patterns);
        assert.strictEqual(store.cancelTask(cancelled.id), cancelled);
        const cancelledSnapshot = plain(cancelled);
        store.disconnect(pod.key);
        advance(5000);
        const expired = store.startTask(pod.key, "jvm", { timeoutSeconds: 5 });
        elapse(1000);
        store.disconnect(pod.key);
        advance(5000);
        assert.equal(pod.channel, "ready");
        assert.equal(expired.status, "interrupted");
        assert.equal(expired.finishedAt, expired.deadline);
        assert.equal(expired.result, null);
        advance(120000);
        store.cancelTask(cancelled.id);
        store.cancelTask(expired.id);
        assert.deepEqual(plain(cancelled), cancelledSnapshot);
        assert.equal(expired.status, "interrupted");
        assert.equal(
            store.state.tasks.filter((task) => task.id === expired.id).length,
            1,
        );
    },
);

check(
    "same-name replacement retires identity, interrupts immediately, and never replays tasks",
    () => {
        const { store, advance } = fixture();
        const pod = store.listPods("production", "orders")[0];
        const historical = store.state.tasks.find(
            (task) => task.tool === "trace",
        );
        const historicalSnapshot = plain(historical);
        const task = store.startTask(pod.key, "trace", patterns);
        const snapshot = plain(task.target);
        store.disconnect(pod.key);
        const replacement = store.replacePod(pod.key);
        assert.equal(pod.retired, true);
        assert.equal(pod.channel, "retired");
        assert.equal(pod.managed, false);
        assert.equal(replacement.name, pod.name);
        assert.notEqual(replacement.key, pod.key);
        assert.notEqual(replacement.podUid, pod.podUid);
        assert.equal(replacement.generation, pod.generation + 1);
        assert.equal(replacement.channel, "discovered");
        assert.equal(task.status, "interrupted");
        assert.equal(task.finishedAt, baseTime);
        assert.equal(task.result, null);
        assert.deepEqual(plain(task.target), snapshot);
        assert.deepEqual(plain(historical), historicalSnapshot);
        assert.ok(!store.listPods("production", "orders").includes(pod));
        assert.equal(store.listPods("production", "orders").length, 6);
        const taskCount = store.state.tasks.length;
        advance(20000);
        assert.equal(replacement.channel, "discovered");
        assert.equal(pod.channel, "retired");
        store.connect(replacement.key);
        advance(2000);
        assert.equal(replacement.channel, "ready");
        assert.equal(task.status, "interrupted");
        assert.equal(store.state.tasks.length, taskCount);
        assert.throws(() => store.startTask(pod.key, "jvm"), /retired/);
        assert.throws(() => store.connect(pod.key), /retired/);
        assert.throws(() => store.replacePod(pod.key), /retired/);
    },
);

check(
    "all policy maintains current and future targets; selected preserves only current intent",
    () => {
        const { store, advance } = fixture();
        const others = plain(
            store.state.pods.filter(
                (pod) =>
                    pod.environment !== "production" || pod.app !== "orders",
            ),
        );
        assert.equal(store.setPolicy("production", "orders", "all"), "all");
        assert.ok(
            store.listPods("production", "orders").every((pod) => pod.managed),
        );
        advance(2000);
        assert.ok(
            store
                .listPods("production", "orders")
                .every((pod) => pod.channel === "ready"),
        );
        let replacement = store.replacePod(
            store.listPods("production", "orders")[0].key,
        );
        assert.equal(replacement.channel, "reconnecting");
        assert.equal(replacement.managed, true);
        const taskCount = store.state.tasks.length;
        advance(1999);
        assert.equal(replacement.channel, "reconnecting");
        advance(1);
        assert.equal(replacement.channel, "ready");
        assert.equal(store.state.tasks.length, taskCount);
        assert.deepEqual(
            plain(
                store.state.pods.filter(
                    (pod) =>
                        pod.environment !== "production" ||
                        pod.app !== "orders",
                ),
            ),
            others,
        );
        const beforeSelected = plain(store.listPods("production", "orders"));
        store.setPolicy("production", "orders", "selected");
        assert.deepEqual(
            plain(store.listPods("production", "orders")),
            beforeSelected,
        );
        replacement = store.replacePod(replacement.key);
        assert.equal(replacement.generation, 3);
        assert.equal(replacement.channel, "discovered");
        assert.equal(replacement.managed, false);
        advance(5000);
        assert.equal(replacement.channel, "discovered");
    },
);

check(
    "discover policy rejects active scope atomically and releases only idle matching channels",
    () => {
        const { store, advance } = fixture();
        const snapshot = plain(store.state);
        assert.throws(
            () => store.setPolicy("production", "orders", "discover"),
            /running tasks/,
        );
        assert.deepEqual(plain(store.state), snapshot);
        store.setPolicy("staging", "orders", "discover");
        assert.ok(
            store
                .listPods("staging", "orders")
                .every((pod) => !pod.managed && pod.channel === "discovered"),
        );
        const production = store.listPods("production", "orders");
        store.connect(production[5].key);
        store.cancelTask(
            store.state.tasks.find((task) => task.status === "running").id,
        );
        store.setPolicy("production", "orders", "discover");
        advance(10000);
        assert.ok(
            production.every(
                (pod) => !pod.managed && pod.channel === "discovered",
            ),
        );
        assert.equal(store.state.policies["production/orders"], "discover");
        store.connect(production[0].key);
        advance(2000);
        assert.equal(production[0].channel, "ready");
        assert.equal(production[0].managed, true);
        assert.equal(production[1].channel, "discovered");
    },
);

check(
    "local scans discover one stable JVM once and honor future all-policy intent",
    () => {
        const { store, advance } = fixture();
        const clusters = plain(
            store.state.pods.filter((pod) => pod.kind === "k8s"),
        );
        const scanned = store.scanLocal();
        assert.equal(scanned.length, 3);
        assert.equal(new Set(scanned.map((pod) => pod.pid)).size, 3);
        assert.equal(scanned[2].channel, "discovered");
        const state = plain(store.state);
        assert.deepEqual(plain(store.scanLocal()), plain(scanned));
        assert.deepEqual(plain(store.state), state);
        store.connect(scanned[2].key);
        advance(2000);
        assert.equal(scanned[2].channel, "ready");
        assert.deepEqual(
            plain(store.state.pods.filter((pod) => pod.kind === "k8s")),
            clusters,
        );
        const future = fixture();
        future.store.setPolicy("local", "local", "all");
        const locals = future.store.scanLocal();
        assert.equal(locals[2].channel, "reconnecting");
        future.advance(2000);
        assert.ok(
            locals.every((pod) => pod.managed && pod.channel === "ready"),
        );
    },
);

check(
    "tool validation rejects invalid input without mutations; each tool produces a simulated result",
    () => {
        const { store, advance } = fixture();
        const pods = store.listPods("production", "orders");
        const before = plain(store.state);
        const invalid = [
            ["missing", "jvm", {}, /unknown target/],
            [pods[4].key, "jvm", {}, /not ready/],
            [pods[5].key, "jvm", {}, /not ready/],
            [pods[0].key, "version", {}, /unsupported tool/],
            [pods[0].key, "__proto__", {}, /unsupported tool/],
            [pods[0].key, "jvm", null, /parameters/],
            [pods[0].key, "jvm", [], /parameters/],
            [pods[0].key, "trace", {}, /classPattern/],
            [pods[0].key, "watch", { classPattern: "demo.*" }, /methodPattern/],
            [
                pods[0].key,
                "trace",
                { ...patterns, methodPattern: " " },
                /methodPattern/,
            ],
            ...[4, 121, 5.5, "5", NaN, Infinity].map((timeoutSeconds) => [
                pods[0].key,
                "watch",
                { ...patterns, timeoutSeconds },
                /timeoutSeconds/,
            ]),
            ...[0, 11, 1.5, "2"].map((maxResults) => [
                pods[0].key,
                "trace",
                { ...patterns, maxResults },
                /maxResults/,
            ]),
        ];
        for (const [key, tool, args, error] of invalid)
            assert.throws(() => store.startTask(key, tool, args), error);
        assert.throws(
            () => store.setPolicy("missing", "orders", "all"),
            /unknown context/,
        );
        assert.throws(
            () => store.setPolicy("production", "orders", "invalid"),
            /unsupported policy/,
        );
        assert.throws(() => store.cancelTask("missing"), /unknown task/);
        assert.deepEqual(plain(store.state), before);
        for (const [tool, field] of [
            ["jvm", "jvm"],
            ["memory", "memory"],
            ["thread", "threads"],
            ["trace", "trace"],
            ["watch", "samples"],
            ["ognl", "value"],
            ["sc", "classes"],
            ["profiler", "frames"],
        ]) {
            const task = store.startTask(pods[0].key, tool, {
                ...patterns,
                expression: 'throw new Error("never evaluate")',
            });
            assert.equal(typeof task, "object");
            assert.equal(task.result, null);
            assert.equal(task.finishedAt, null);
            const duration = ["trace", "watch"].includes(tool)
                ? 12000
                : tool === "profiler"
                  ? 5000
                  : 3000;
            advance(duration - 1);
            assert.equal(task.status, "running");
            advance(1);
            assert.equal(task.status, "succeeded");
            assert.equal(task.finishedAt, task.createdAt + duration);
            assert.equal(task.result.simulated, true);
            assert.equal(task.result.tool, tool);
            assert.equal(typeof task.result.summary, "string");
            assert.ok(task.result.rows.length > 0);
            assert.ok(task.result[field]);
            const finished = plain(task);
            store.cancelTask(task.id);
            assert.deepEqual(plain(task), finished);
        }
        const capped = store.startTask(pods[0].key, "watch", {
            ...patterns,
            maxResults: 2,
            timeoutSeconds: 120,
        });
        advance(7999);
        assert.equal(capped.status, "running");
        advance(1);
        assert.equal(capped.status, "succeeded");
        assert.equal(capped.result.samples.length, 2);
        const timed = store.startTask(pods[0].key, "trace", {
            ...patterns,
            timeoutSeconds: 5,
        });
        advance(5000);
        assert.equal(timed.status, "succeeded");
        assert.equal(timed.finishedAt, timed.deadline);
    },
);

check(
    "retention caps preserve every running task and bound event history",
    () => {
        const { store, advance } = fixture();
        const pod = store.listPods("production", "orders")[0];
        const runningSeed = store.state.tasks.find(
            (task) => task.status === "running",
        );
        for (let index = 0; index < 120; index++) {
            const task = store.startTask(pod.key, "jvm");
            store.cancelTask(task.id);
        }
        assert.equal(store.state.tasks.length, 100);
        assert.ok(store.state.tasks.includes(runningSeed));
        for (let index = 0; index < 99; index++)
            store.startTask(pod.key, "jvm");
        assert.equal(store.state.tasks.length, 100);
        assert.ok(store.state.tasks.every((task) => task.status === "running"));
        const ids = plain(store.state.tasks.map((task) => task.id));
        assert.throws(() => store.startTask(pod.key, "jvm"), /task limit/);
        assert.deepEqual(plain(store.state.tasks.map((task) => task.id)), ids);
        assert.equal(store.state.events.length, 100);
        assert.equal(
            new Set(store.state.events.map((event) => event.id)).size,
            100,
        );
        for (const event of store.state.events) {
            for (const field of [
                "id",
                "at",
                "kind",
                "title",
                "detail",
                "targetKey",
                "environment",
                "app",
            ])
                assert.ok(Object.hasOwn(event, field));
            assert.ok(["info", "success", "warning"].includes(event.kind));
        }
        advance(3000);
        assert.equal(runningSeed.status, "running");
        store.startTask(pod.key, "jvm");
        assert.equal(store.state.tasks.length, 100);
        assert.ok(store.state.tasks.includes(runningSeed));
        assert.equal(store.state.events.length, 100);
    },
);

const children = (store, run) =>
    run.taskIds.map((id) => store.state.tasks.find((task) => task.id === id));

check(
    "environment inventories isolate same-name workloads and init containers are not targets",
    () => {
        const { store, advance } = fixture();
        for (const environment of store.state.environments) {
            const all = store.listPods(environment.id);
            assert.deepEqual(
                plain(all),
                plain(store.listPods(environment.id, "all")),
            );
            assert.deepEqual(
                plain(all),
                plain(
                    store.state.pods.filter(
                        (pod) =>
                            !pod.retired && pod.environment === environment.id,
                    ),
                ),
            );
            if (environment.kind === "k8s") {
                assert.ok(environment.clusterId);
                assert.ok(
                    all.every((pod) => pod.clusterId === environment.clusterId),
                );
            }
        }
        const primary = store.listPods("production", "orders")[0];
        const sandbox = store.listPods("production", "orders-lab")[0];
        assert.equal(primary.workloadName, sandbox.workloadName);
        assert.equal(primary.name, sandbox.name);
        assert.equal(primary.namespace, "commerce");
        assert.equal(sandbox.namespace, "sandbox");
        for (const field of ["key", "podUid", "containerId", "jvmIdentity"])
            assert.notEqual(primary[field], sandbox[field]);
        assert.equal(primary.containerCount, 2);
        assert.equal(primary.readyContainers, 1);
        assert.equal(
            primary.containers.filter((container) => container.javaCandidate)
                .length,
            1,
        );
        assert.ok(
            primary.containers.some(
                (container) =>
                    container.role === "init" &&
                    container.state === "completed" &&
                    !container.javaCandidate,
            ),
        );
        assert.equal(
            store.state.pods.filter((pod) => pod.podUid === primary.podUid)
                .length,
            1,
        );
        const run = store.startRun([primary.key, sandbox.key], "jvm");
        const [first, second] = children(store, run);
        assert.equal(first.target.namespace, "commerce");
        assert.equal(second.target.namespace, "sandbox");
        advance(3000);
        assert.equal(second.result.jvm.javaVersion, sandbox.javaVersion);
        assert.notEqual(
            first.result.jvm.javaVersion,
            second.result.jvm.javaVersion,
        );
    },
);

check(
    "local devices isolate identical PIDs, reject offline actions atomically, and scan independently",
    () => {
        const { store, advance } = fixture();
        const dev = store.state.environments.find(
            (item) => item.id === "local",
        );
        const build = store.state.environments.find(
            (item) => item.id === "local-build",
        );
        assert.equal(dev.kind, "local");
        assert.equal(dev.device, "dev-workstation");
        assert.equal(dev.online, true);
        assert.equal(build.device, "build-workstation");
        assert.equal(build.online, false);
        assert.equal(dev.cluster, null);
        assert.equal(build.cluster, null);
        const local = store.listPods(dev.id);
        const offline = store.listPods(build.id);
        assert.equal(local.length, 2);
        assert.equal(offline.length, 2);
        assert.equal(local[0].pid, offline[0].pid);
        assert.notEqual(local[0].key, offline[0].key);
        assert.notEqual(local[0].jvmIdentity, offline[0].jvmIdentity);
        const before = plain(store.state);
        for (const action of [
            () => store.connect(offline[0].key),
            () => store.disconnect(offline[0].key),
            () => store.scanLocal(build.id),
            () => store.startTask(offline[0].key, "jvm"),
            () =>
                store.startRun(
                    [offline[0].key],
                    "thread",
                    {},
                    { source: "mcp" },
                ),
            () => store.setPolicy(build.id, "local", "all"),
        ])
            assert.throws(action, /offline/);
        assert.throws(() => store.scanLocal("production"), /unknown local/);
        assert.deepEqual(plain(store.state), before);
        // A device becoming available is a fixture change, never a real device operation.
        build.online = true;
        const devScan = store.scanLocal();
        const buildScan = store.scanLocal(build.id);
        assert.equal(devScan.length, 3);
        assert.equal(buildScan.length, 3);
        assert.notEqual(devScan[2].key, buildScan[2].key);
        const scanned = plain(store.state);
        store.scanLocal();
        store.scanLocal(build.id);
        assert.deepEqual(plain(store.state), scanned);
        store.connect(buildScan[0].key);
        advance(2000);
        const task = store.startTask(buildScan[0].key, "jvm");
        assert.equal(task.target.device, "build-workstation");
        assert.equal(task.target.environment, "local-build");
        advance(3000);
        assert.equal(task.status, "succeeded");
    },
);

check(
    "batch concurrency, FIFO, immutable snapshots and shared parameters track one run",
    () => {
        const { store, advance } = fixture();
        const keys = store
            .listPods("production", "orders")
            .slice(0, 3)
            .map((pod) => pod.key);
        const parameters = { filter: { labels: ["captured"] } };
        const run = store.startRun(keys, "thread", parameters, {
            source: "mcp",
            title: "演示线程对比",
            concurrency: 2,
        });
        const tasks = children(store, run);
        assert.equal(run.source, "mcp");
        assert.equal(run.client, "IDE MCP 客户端");
        assert.equal(run.title, "演示线程对比");
        assert.equal(run.concurrency, 2);
        assert.ok(Object.isFrozen(run.targetSnapshots));
        assert.ok(Object.isFrozen(run.targetSnapshots[0].containers[0]));
        assert.ok(Object.isFrozen(run.parameters.filter.labels));
        assert.deepEqual(plain(tasks.map((task) => task.status)), [
            "running",
            "running",
            "queued",
        ]);
        for (let index = 0; index < tasks.length; index++) {
            assert.equal(tasks[index].runId, run.id);
            assert.strictEqual(tasks[index].target, run.targetSnapshots[index]);
            assert.strictEqual(tasks[index].parameters, run.parameters);
            assert.equal(tasks[index].createdAt, baseTime);
            assert.equal(tasks[index].source, run.source);
            assert.equal(tasks[index].client, run.client);
        }
        assert.equal(tasks[2].startedAt, null);
        assert.equal(tasks[2].deadline, null);
        parameters.filter.labels[0] = "changed";
        keys.reverse();
        assert.equal(run.parameters.filter.labels[0], "captured");
        assert.throws(() => {
            run.targetSnapshots[0].namespace = "other";
        }, TypeError);
        assert.throws(() => {
            run.targetSnapshots[0].containers[0].name = "other";
        }, TypeError);
        const beforeSummary = plain(store.state);
        assert.deepEqual(plain(store.runSummary(run.id)), {
            status: "running",
            total: 3,
            completed: 0,
            counts: {
                queued: 1,
                running: 2,
                succeeded: 0,
                cancelled: 0,
                interrupted: 0,
            },
        });
        assert.deepEqual(plain(store.state), beforeSummary);
        advance(2999);
        assert.equal(tasks[2].status, "queued");
        advance(1);
        assert.deepEqual(plain(tasks.map((task) => task.status)), [
            "succeeded",
            "succeeded",
            "running",
        ]);
        assert.equal(tasks[2].startedAt, baseTime + 3000);
        assert.equal(tasks[2].deadline, baseTime + 33000);
        assert.equal(store.runSummary(run.id).completed, 2);
        advance(3000);
        assert.equal(store.runSummary(run.id).status, "succeeded");
        assert.equal(
            new Set(tasks.map((task) => task.result.threads[0].cpu)).size,
            3,
        );
        // An independent run has its own concurrency budget; the 90s watch seed remains active.
        assert.equal(
            store.state.tasks.find((task) => task.tool === "watch").status,
            "running",
        );
        const single = store.startTask(keys[0], "jvm");
        assert.equal(
            store.state.runs.find((item) => item.id === single.runId)
                .taskIds[0],
            single.id,
        );
        assert.equal(single.source, "web");
    },
);

check(
    "queued tasks have no waiting deadline and start at promotion time even after a late tick",
    () => {
        const { store, advance } = fixture();
        const keys = store
            .listPods("production", "orders")
            .slice(0, 3)
            .map((pod) => pod.key);
        const run = store.startRun(
            keys,
            "jvm",
            { timeoutSeconds: 5 },
            { concurrency: 1 },
        );
        const tasks = children(store, run);
        advance(60000);
        assert.equal(tasks[0].status, "succeeded");
        assert.equal(tasks[0].finishedAt, baseTime + 3000);
        assert.equal(tasks[1].status, "running");
        assert.equal(tasks[1].startedAt, baseTime + 60000);
        assert.equal(tasks[1].deadline, baseTime + 65000);
        assert.equal(tasks[2].status, "queued");
        assert.equal(tasks[2].deadline, null);
        advance(3000);
        assert.equal(tasks[2].startedAt, baseTime + 63000);
        advance(3000);
        assert.equal(store.runSummary(run.id).status, "succeeded");
    },
);

check(
    "group cancellation preserves results and summaries distinguish all terminal outcomes",
    () => {
        const { store, advance } = fixture();
        const keys = store
            .listPods("production", "orders")
            .slice(0, 3)
            .map((pod) => pod.key);
        const partial = store.startRun(keys, "thread");
        const tasks = children(store, partial);
        advance(3000);
        const completed = plain(tasks.slice(0, 2));
        assert.strictEqual(store.cancelRun(partial.id), partial);
        assert.deepEqual(plain(tasks.slice(0, 2)), completed);
        assert.equal(tasks[2].status, "cancelled");
        assert.equal(store.runSummary(partial.id).status, "partial");
        assert.equal(store.runSummary(partial.id).completed, 3);
        const cancelled = store.startRun(keys, "thread");
        store.cancelRun(cancelled.id);
        assert.equal(store.runSummary(cancelled.id).status, "cancelled");
        assert.equal(children(store, cancelled)[2].startedAt, null);
        const stable = plain(children(store, cancelled));
        store.cancelRun(cancelled.id);
        advance(10000);
        assert.deepEqual(plain(children(store, cancelled)), stable);
        const interrupted = store.startRun(
            keys,
            "thread",
            {},
            { concurrency: 1 },
        );
        for (const key of keys) store.replacePod(key);
        assert.equal(store.runSummary(interrupted.id).status, "interrupted");
        assert.equal(store.runSummary(interrupted.id).counts.interrupted, 3);
        assert.throws(() => store.runSummary("missing"), /unknown run/);
        assert.throws(() => store.cancelRun("missing"), /unknown run/);
    },
);

check(
    "batch prevalidation rejects every invalid child, source, parameter and environment without mutation",
    () => {
        const { store } = fixture();
        const pods = store.listPods("production", "orders");
        const key = pods[0].key;
        const cyclic = {};
        cyclic.self = cyclic;
        const before = plain(store.state);
        const invalid = [
            [[], "jvm", {}, {}, /empty/],
            [null, "jvm", {}, {}, /empty/],
            [[key, key], "jvm", {}, {}, /duplicate/],
            [[key, "missing"], "jvm", {}, {}, /unknown target/],
            [[key, pods[5].key], "jvm", {}, {}, /not ready/],
            [
                [key, store.listPods("staging", "orders")[0].key],
                "jvm",
                {},
                {},
                /mixed environments/,
            ],
            [
                [key, store.listPods("local")[0].key],
                "jvm",
                {},
                {},
                /mixed environments/,
            ],
            [[key], "unknown", {}, {}, /unsupported tool/],
            [[key], "trace", {}, {}, /classPattern/],
            [[key], "jvm", cyclic, {}, /parameters/],
            [[key], "jvm", { value: Infinity }, {}, /parameters/],
            [[key], "jvm", { value: () => 1 }, {}, /parameters/],
            [[key], "jvm", {}, { source: "other" }, /unsupported source/],
            [[key], "jvm", {}, { source: null }, /unsupported source/],
            [[key], "jvm", {}, null, /options/],
            [[key], "jvm", {}, { title: " " }, /options/],
            [[key], "jvm", {}, { client: "" }, /options/],
            ...[0, 5, 1.5, "2", NaN].map((concurrency) => [
                [key],
                "jvm",
                {},
                { concurrency },
                /concurrency/,
            ]),
        ];
        for (const [keys, tool, parameters, options, error] of invalid) {
            assert.throws(
                () => store.startRun(keys, tool, parameters, options),
                error,
            );
            assert.deepEqual(plain(store.state), before);
        }
        const fresh = fixture().store;
        assert.equal(
            store.startRun([key], "jvm").id,
            fresh.startRun([key], "jvm").id,
        );
    },
);

check(
    "replacement interrupts queued targets immediately and exact identity is rechecked before promotion",
    () => {
        const { store, advance } = fixture();
        const pods = store.listPods("production", "orders").slice(0, 3);
        const run = store.startRun(
            pods.map((pod) => pod.key),
            "thread",
            {},
            { concurrency: 1 },
        );
        const tasks = children(store, run);
        const captured = plain(run.targetSnapshots);
        const replacement = store.replacePod(pods[1].key);
        assert.equal(tasks[1].status, "interrupted");
        assert.equal(tasks[1].startedAt, null);
        assert.notEqual(replacement.containerId, pods[1].containerId);
        assert.notEqual(replacement.jvmIdentity, pods[1].jvmIdentity);
        store.connect(replacement.key);
        advance(3000);
        assert.equal(tasks[0].status, "succeeded");
        assert.equal(tasks[2].status, "running");
        advance(3000);
        assert.equal(store.runSummary(run.id).status, "partial");
        assert.deepEqual(plain(run.targetSnapshots), captured);
        assert.ok(
            !store.state.tasks.some(
                (task) => task.target.key === replacement.key,
            ),
        );
        for (const field of [
            "namespace",
            "containerId",
            "jvmIdentity",
            "podUid",
            "pid",
            "clusterId",
        ]) {
            const next = fixture();
            const pair = next.store
                .listPods("production", "orders")
                .slice(0, 2);
            const queued = next.store.startRun(
                pair.map((pod) => pod.key),
                "jvm",
                {},
                { concurrency: 1 },
            );
            pair[1][field] = `changed-${field}`;
            next.advance(3000);
            const child = children(next.store, queued)[1];
            assert.equal(child.status, "interrupted", field);
            assert.equal(child.startedAt, null, field);
            assert.equal(child.result, null, field);
        }
    },
);

check(
    "discover rejects queued scope and workload policy never crosses same-name namespaces",
    () => {
        const { store, advance } = fixture();
        const primary = store.listPods("production", "orders");
        const sandbox = store.listPods("production", "orders-lab");
        const run = store.startRun(
            [primary[0].key, sandbox[0].key],
            "jvm",
            {},
            { concurrency: 1 },
        );
        assert.equal(children(store, run)[1].status, "queued");
        const before = plain(store.state);
        assert.throws(
            () => store.setPolicy("production", "orders-lab", "discover"),
            /running tasks/,
        );
        assert.deepEqual(plain(store.state), before);
        store.cancelRun(run.id);
        store.setPolicy("production", "orders-lab", "all");
        advance(2000);
        const mainReplacement = store.replacePod(primary[0].key);
        const labReplacement = store.replacePod(sandbox[0].key);
        assert.equal(mainReplacement.channel, "discovered");
        assert.equal(labReplacement.channel, "reconnecting");
        advance(2000);
        assert.equal(labReplacement.channel, "ready");
        assert.equal(mainReplacement.channel, "discovered");
    },
);

check(
    "retention evicts complete terminal runs and keeps completed siblings of active runs",
    () => {
        const { store, advance } = fixture();
        const keys = store
            .listPods("production", "orders")
            .slice(0, 3)
            .map((pod) => pod.key);
        const active = store.startRun(keys, "jvm", {}, { concurrency: 1 });
        advance(3000);
        const activeTasks = children(store, active);
        assert.equal(activeTasks[0].status, "succeeded");
        assert.equal(activeTasks[1].status, "running");
        assert.equal(activeTasks[2].status, "queued");
        for (let index = 0; index < 120; index++) {
            const run = store.startRun(keys.slice(0, 2), "thread");
            store.cancelRun(run.id);
        }
        assert.ok(store.state.runs.includes(active));
        assert.ok(
            activeTasks.every((task) => store.state.tasks.includes(task)),
        );
        assert.ok(store.state.tasks.length <= 100);
        assert.ok(store.state.runs.length <= 100);
        assert.ok(store.state.events.length <= 100);
        for (const run of store.state.runs) {
            assert.equal(
                children(store, run).length,
                run.targetSnapshots.length,
            );
            assert.ok(children(store, run).every(Boolean));
            assert.equal(store.runSummary(run.id).total, run.taskIds.length);
        }
        for (const task of store.state.tasks)
            assert.ok(
                store.state.runs.some(
                    (run) =>
                        run.id === task.runId && run.taskIds.includes(task.id),
                ),
            );
        // Fill with active one-target runs; any capacity failure must retain even the
        // remaining terminal groups instead of evicting them before discovering failure.
        while (
            store.state.tasks.filter((task) => {
                const run = store.state.runs.find(
                    (item) => item.id === task.runId,
                );
                return store.runSummary(run.id).status === "running";
            }).length < 99
        )
            store.startTask(keys[0], "jvm");
        const full = plain(store.state);
        assert.throws(() => store.startRun(keys, "thread"), /task limit/);
        assert.deepEqual(plain(store.state), full);
        assert.throws(
            () => store.startRun([keys[0], "missing"], "thread"),
            /unknown target/,
        );
        assert.deepEqual(plain(store.state), full);
    },
);

console.log(
    `Offline domain model: ${checks.length} focused checks passed (VM, fake clock, no I/O or timers).`,
);
