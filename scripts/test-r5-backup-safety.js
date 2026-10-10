// R5 / 15 + 18 + S3: real timestamp shapes, D-005 capture safety, tri-state process checks,
// and backup admission through the real entry point.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "electron") return { app: { getPath: () => "/tmp", getVersion: () => "0.0.0" }, ipcMain: { handle: () => {}, on: () => {} } };
  return realLoad.call(this, request, ...rest);
};
const stub = (rel, exports) => {
  const file = require.resolve(path.join(ROOT, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
const mem = new Map();
stub("util/store", { get: (k) => mem.get(k), set: (k, v) => mem.set(k, v), delete: (k) => mem.delete(k) });
stub("util/logger", { info: () => {}, error: () => {}, warn: () => {}, logPath: () => "/dev/null" });
stub("util/helper", { axiosInstance: { get: async () => ({}), post: async () => ({}) } });

const { toMs, backupDue } = require("../util/backupSchedule");
const { tallyProcessState } = require("../util/tallyProcess");
const { startBackup } = require("../util/saveBackup");
const { coordinator } = require("../util/jobCoordinator");
const tdl = require("../util/ensureBillOutstandingTdl");

test("15: backend epoch seconds (number or string), epoch ms and ISO all mean the same instant", () => {
  const at = Date.UTC(2026, 9, 1, 12, 0, 0);
  assert.equal(toMs(at / 1000), at);
  assert.equal(toMs(String(at / 1000)), at);
  assert.equal(toMs(at), at);
  assert.equal(toMs(new Date(at).toISOString()), at);
  for (const bad of [null, "", "not a date", 0, -5, "12abc"]) assert.equal(toMs(bad), null, String(bad));
});

test("15: a cloud backup the backend reports in epoch seconds counts as recent", () => {
  const now = Date.UTC(2026, 9, 9, 12, 0, 0);
  const state = { backupInterval: "7days", cloudBackups: [{ status: "VERIFIED", completed_at: Math.floor((now - 2 * 86_400_000) / 1000) }] };
  const verdict = backupDue(state, now);
  assert.equal(verdict.due, false, `two days after a verified backup a weekly backup is not due (${verdict.reason})`);
});

test("18: process state is running, closed or unknown — a failed query is never 'closed'", async () => {
  const exec = (out) => async () => ({ stdout: out });
  assert.deepEqual(await tallyProcessState({ platform: "win32", exec: exec("RUNNING|C:\\Tally\\tally.exe\r\n") }), { state: "running", path: "C:\\Tally\\tally.exe" });
  assert.deepEqual(await tallyProcessState({ platform: "win32", exec: exec("CLOSED|") }), { state: "closed" });
  assert.equal((await tallyProcessState({ platform: "win32", exec: exec("garbage") })).state, "unknown");
  assert.equal((await tallyProcessState({ platform: "win32", exec: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } })).state, "unknown");
});

test("18: setup does not launch Tally when its state is unknown or running", () => {
  const base = { platform: "win32", tallyDir: "C:\\TallyPrime", exeExists: true, tdlExists: true };
  assert.equal(tdl.planTallyLaunch({ ...base, running: "unknown" }).code, "TALLY_STATE_UNKNOWN");
  assert.equal(tdl.planTallyLaunch({ ...base, running: "running" }).code, "TALLY_CLOSE_REQUIRED");
  assert.equal(tdl.planTallyLaunch({ ...base, running: "closed" }).ok, true);
});

const win = { send: () => {}, isDestroyed: () => false };

test("D-005: a backup never starts while Tally is open or its state is unknown; scheduled runs defer", async () => {
  for (const [state, code] of [["running", "TALLY_RUNNING"], ["unknown", "TALLY_STATE_UNKNOWN"]]) {
    const manual = await startBackup(win, { trigger: "manual", tallyState: async () => ({ state }) });
    assert.deepEqual([manual.status, manual.code, manual.deferred], [false, code, false]);
    assert.match(manual.message, /Tally/);
    const scheduled = await startBackup(win, { trigger: "scheduled", tallyState: async () => ({ state }) });
    assert.deepEqual([scheduled.code, scheduled.deferred], [code, true]);
  }
  assert.equal(coordinator.snapshot().active.length, 0, "no backup job was admitted");
});

test("S3: with Tally closed, a backup is refused with a reason while a sync or another backup runs", async () => {
  const closed = async () => ({ state: "closed" });
  const sync = coordinator.admit("sync", { trigger: "manual" });
  const r1 = await startBackup(win, { trigger: "manual", tallyState: closed });
  assert.equal(r1.code, "JOB_CONFLICT");
  assert.match(r1.message, /sync/i);
  coordinator.finish(sync.job, { state: "succeeded", result: null });

  const backup = coordinator.admit("backup", { trigger: "scheduled" });
  const r2 = await startBackup(win, { trigger: "manual", tallyState: closed });
  assert.equal(r2.code, "JOB_ALREADY_RUNNING");
  assert.equal(coordinator.snapshot().active.length, 1, "the running backup kept its slot");
  coordinator.finish(backup.job, { state: "succeeded", result: null });
});
