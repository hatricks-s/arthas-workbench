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
        assert.deepEqual(
            Object.keys(store).sort(),
            [
                "state",
                "listPods",
                "startTask",
                "cancelTask",
                "tick",
                "disconnect",
                "replacePod",
                "setPolicy",
                "scanLocal",
                "connect",
            ].sort(),
        );
        assert.deepEqual(
            plain(store.state.environments.map((item) => [item.id, item.name])),
            [
                ["production", "生产环境"],
                ["staging", "预发环境"],
                ["development", "开发环境"],
            ],
        );
        assert.deepEqual(plain(store.state.apps.map((item) => item.id)), [
            "orders",
            "payments",
            "inventory",
            "gateway",
        ]);
        assert.ok(
            store.state.apps.every(
                (item) =>
                    item.name &&
                    item.description &&
                    item.owner &&
                    item.javaVersion === "21.0.5",
            ),
        );
        assert.equal(store.state.pods.length, 31);
        for (const [environment, count] of [
            ["production", 6],
            ["staging", 3],
            ["development", 2],
        ]) {
            assert.equal(store.listPods(environment, "orders").length, count);
            for (const app of ["payments", "inventory", "gateway"])
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
                31,
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
        ];
        assert.ok(
            store.state.pods.every((pod) =>
                fields.every((field) => Object.hasOwn(pod, field)),
            ),
        );
        assert.equal(store.state.tasks.length, 3);
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
            assert.deepEqual(
                Object.keys(event).sort(),
                [
                    "id",
                    "at",
                    "kind",
                    "title",
                    "detail",
                    "targetKey",
                    "environment",
                    "app",
                ].sort(),
            );
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

console.log(
    `Offline domain model: ${checks.length} focused checks passed (VM, fake clock, no I/O or timers).`,
);
