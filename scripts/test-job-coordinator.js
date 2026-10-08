const test = require("node:test");
const assert = require("node:assert/strict");
const { createCoordinator, CancelledError } = require("../util/jobCoordinator");

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

test("admission is synchronous: a second sync is rejected and the first keeps running", async () => {
  const c = createCoordinator();
  const gate = deferred();
  const first = c.run("sync", { trigger: "manual" }, async () => {
    await gate.promise;
    return { ok: true };
  });
  const second = await c.run("sync", { trigger: "scheduled" }, async () => assert.fail("must not run"));
  assert.equal(second.accepted, false);
  assert.equal(second.code, "JOB_ALREADY_RUNNING");
  assert.equal(c.isActive("sync"), true, "rejected start must not clear the running job");
  gate.resolve();
  const done = await first;
  assert.equal(done.accepted, true);
  assert.equal(done.job.state, "succeeded");
  assert.equal(c.isActive("sync"), false);
});

test("conflicting types are rejected; non-conflicting probes are not jobs at all", async () => {
  const c = createCoordinator();
  const gate = deferred();
  const backup = c.run("backup", {}, () => gate.promise);
  assert.equal(c.admit("sync").accepted, false);
  assert.equal(c.admit("restore").accepted, false);
  assert.equal(c.admit("hard_sync").code, "JOB_CONFLICT");
  gate.resolve();
  await backup;
  const sync = c.admit("sync");
  assert.equal(sync.accepted, true);
  assert.equal(c.admit("single_voucher").accepted, false);
  c.finish(sync.job, { state: "succeeded" });
});

test("only the owning job releases its slot", () => {
  const c = createCoordinator();
  const a = c.admit("sync");
  const stranger = { id: "not-a-job" };
  assert.equal(c.finish(stranger, { state: "failed" }), false);
  assert.equal(c.isActive("sync"), true);
  assert.equal(c.finish(a.job, { state: "succeeded" }), true);
  assert.equal(c.finish(a.job, { state: "failed" }), false, "double release is a no-op");
});

test("stop requests cancellation; the job stays active until its code observes it", async () => {
  const c = createCoordinator();
  const gate = deferred();
  let sawAbort = false;
  const running = c.run("sync", {}, async (job) => {
    job.signal.addEventListener("abort", () => (sawAbort = true));
    await gate.promise;
    job.throwIfCancelled();
    return "unreachable";
  });
  const res = c.requestCancel({ types: ["sync"], code: "manually_stopped" });
  assert.equal(res.ok, true);
  assert.equal(c.isActive("sync"), true, "cancel request does not release the slot");
  assert.equal(c.snapshot().active[0].state, "cancel_requested");
  assert.equal(sawAbort, true);
  gate.resolve();
  const done = await running;
  assert.equal(done.job.state, "cancelled");
  assert.equal(c.isActive("sync"), false);
});

test("cancel request with nothing running reports ok:false", () => {
  const c = createCoordinator();
  assert.equal(c.requestCancel({ types: ["sync"] }).ok, false);
});

test("job context is visible only inside the job; a probe outside sees none", async () => {
  const c = createCoordinator();
  const gate = deferred();
  let inside = null;
  const running = c.run("sync", {}, async (job) => {
    await Promise.resolve();
    inside = c.current();
    await gate.promise;
    return job.stopCode();
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(c.current(), null, "probe running outside the job has no job context");
  assert.ok(inside && inside.type === "sync");
  inside.recordSourceFailure("tally_timeout");
  gate.resolve();
  const done = await running;
  assert.equal(done.result, "tally_timeout");
});

test("errors inside a job release it as failed; CancelledError releases as cancelled", async () => {
  const c = createCoordinator();
  const failed = await c.run("backup", {}, async () => {
    throw new Error("boom");
  });
  assert.equal(failed.job.state, "failed");
  assert.equal(c.isActive("backup"), false);
  const cancelled = await c.run("backup", {}, async () => {
    throw new CancelledError("x");
  });
  assert.equal(cancelled.job.state, "cancelled");
});

test("policy refusal (e.g. outdated version) is a rejection that starts nothing", () => {
  const c = createCoordinator();
  const r = c.admit("sync", {
    policy: () => ({ code: "VERSION_BLOCKED", message: "Update required" }),
  });
  assert.equal(r.accepted, false);
  assert.equal(r.code, "VERSION_BLOCKED");
  assert.equal(c.isActive("sync"), false);
});

test("change events carry job state for the renderer", async () => {
  const c = createCoordinator();
  const seen = [];
  c.onChange((job) => seen.push(job.state));
  await c.run("sync", {}, async (job) => {
    job.setState("uploading");
    return { state: "partial", result: { companies: [] } };
  });
  assert.deepEqual(seen, ["preparing", "uploading", "partial"]);
});
