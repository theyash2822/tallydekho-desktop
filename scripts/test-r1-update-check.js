// R1 / S2: the UI settles on every outcome, but at most one real update check runs.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createUpdateChecker, checkWithTimeout, TIMEOUT_MESSAGE } = require("../util/updateCheck");

function fakeUpdater() {
  const pending = [];
  let calls = 0;
  return {
    check: () => { calls++; return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    calls: () => calls,
    settle: (value) => pending.shift().resolve(value),
    fail: (err) => pending.shift().reject(err),
  };
}

test("a check that never answers settles the UI but is not run again while it is in flight", async () => {
  const up = fakeUpdater();
  const checker = createUpdateChecker({ check: up.check });
  const first = await checkWithTimeout(checker, 20);
  assert.deepEqual([first.ok, first.timedOut, first.stillRunning, first.error], [false, true, true, TIMEOUT_MESSAGE]);
  const retry = await checkWithTimeout(checker, 20);
  assert.equal(retry.ok, false);
  assert.equal(up.calls(), 1, "a retry joined the running check instead of starting another");
  assert.equal(retry.generation, first.generation);

  up.settle({ isUpdateAvailable: true, updateInfo: { version: "9.9.9" } });
  await new Promise((r) => setImmediate(r));
  assert.equal(checker.isRunning(), false, "the late result releases the slot");
  const next = checkWithTimeout(checker, 200);
  assert.equal(up.calls(), 2, "after it settles a new check may start");
  up.settle(null);
  const r = await next;
  assert.deepEqual([r.ok, r.info, r.generation > first.generation], [true, null, true]);
});

test("double requests share one check and both see its result", async () => {
  const up = fakeUpdater();
  const checker = createUpdateChecker({ check: up.check });
  const a = checkWithTimeout(checker, 200);
  const b = checkWithTimeout(checker, 200);
  up.settle({ isUpdateAvailable: false });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(up.calls(), 1);
  assert.deepEqual([ra.ok, rb.ok, ra.generation === rb.generation], [true, true, true]);
});

test("an updater error settles the UI and allows a retry", async () => {
  const up = fakeUpdater();
  const checker = createUpdateChecker({ check: up.check });
  const p = checkWithTimeout(checker, 200);
  up.fail(new Error("feed unreachable"));
  const r = await p;
  assert.deepEqual([r.ok, r.timedOut, r.stillRunning, r.error], [false, false, false, "feed unreachable"]);
  const again = checkWithTimeout(checker, 200);
  assert.equal(up.calls(), 2);
  up.settle({ isUpdateAvailable: true });
  assert.equal((await again).ok, true);
});
