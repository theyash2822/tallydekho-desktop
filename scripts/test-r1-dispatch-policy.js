// R1 / D1 + D2: every real dispatcher applies the version policy and the cross-device
// conflict check. Real ipcRegistry + socket handlers + job coordinator; the sync engine
// (xml.js), backend client, dialogs and store are recorders.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const net = require("node:net");
const Module = require("node:module");

net.Socket.prototype.connect = function blocked() {
  throw Object.assign(new Error("outbound connections are blocked in this test"), { code: "NETWORK_GUARD" });
};

const ROOT = path.join(__dirname, "..");
const handlers = new Map();
const dialogs = [];
let dialogAnswer = 1; // Cancel
const electronStub = {
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
  app: { getPath: () => "/tmp", getVersion: () => "0.0.0-test", isPackaged: false },
  dialog: { showMessageBox: async (...args) => { dialogs.push(args.at(-1)); return { response: dialogAnswer }; } },
  BrowserWindow: class {},
  Notification: class { show() {} },
};
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "electron") return electronStub;
  return realLoad.call(this, request, ...rest);
};
const stub = (rel, exports) => {
  const file = require.resolve(path.join(ROOT, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

const mem = new Map();
stub("util/store", { get: (k) => mem.get(k), set: (k, v) => mem.set(k, v), delete: (k) => mem.delete(k), has: (k) => mem.has(k) });
stub("util/logger", { info: () => {}, error: () => {}, warn: () => {}, logPath: () => "/dev/null" });
stub("util/deviceCredential", { getDeviceSecret: () => "synthetic-secret", clearDeviceSecret: () => {}, saveDeviceSecret: () => {} });

const backend = [];
let conflictStatus = () => ({ data: { status: true, data: { lastSyncedAt: null, isMyDevice: true } } });
stub("util/helper", {
  isTallyOpen: async () => true,
  isOnlineHandler: async () => true,
  pollJobStatus: async () => ({ status: true }),
  checkForUpdates: () => {},
  axiosInstance: {
    get: async (url) => {
      backend.push(["GET", url]);
      if (url.startsWith("/desktop/company-sync-status")) return conflictStatus(url);
      return { data: { status: true, data: {} } };
    },
    post: async (url) => { backend.push(["POST", url]); return { data: { status: true, data: {} } }; },
  },
});

const engine = { syncs: 0, singleVoucher: 0 };
stub("util/xml.js", {
  getCompanyDestinations: async () => ({ A: "C:\\Tally\\Data\\10000\\" }),
  discoverCompanies: async () => ({ status: "ok", companies: [] }),
  syncTallyData: async () => { engine.syncs++; return { status: true, data: { uploadId: "u-1", companies: [] } }; },
  isSyncRunning: () => false,
  // Same one-liner as util/xml.js.
  stopTallySyncHandler: (code) => require(path.join(ROOT, "util/jobCoordinator")).coordinator.requestCancel({ types: ["sync", "hard_sync"], code: code || "manually_stopped" }),
  fetchAndIngestSingleVouchers: async () => { engine.singleVoucher++; return { status: true, count: 1 }; },
  postToTally: async () => { throw new Error("no Tally writes in this test"); },
});

const ipc = require(path.join(ROOT, "util/ipcRegistry.js"));
const { coordinator } = require(path.join(ROOT, "util/jobCoordinator"));
const registerSocket = require(path.join(ROOT, "util/socket.js"));

const fakeWindow = { webContents: { send: () => {}, isDestroyed: () => false } };
ipc.registerTallySync(fakeWindow);
const socketHandlers = new Map();
registerSocket(fakeWindow, { on: (ev, fn) => socketHandlers.set(ev, fn), emit: () => {}, connected: true, id: "s-1" });

const COMPANY = { guid: "g-1", id: "g-1", name: "Synthetic Co", years: [{ finYear: "2025-2026", begin: "20250401", end: "20260331" }] };
function reset({ versionLevel = 0 } = {}) {
  backend.length = 0; dialogs.length = 0; engine.syncs = 0; engine.singleVoucher = 0;
  mem.clear();
  mem.set("versionLevel", versionLevel);
  mem.set("isOnline", true);
  mem.set("selectedCompanies", [COMPANY]);
  conflictStatus = () => ({ data: { status: true, data: { lastSyncedAt: null, isMyDevice: true } } });
}
const startManual = () => handlers.get("tally:start_sync")({ sender: {} }, { companies: [COMPANY], isHardSync: false });

test("D1: a blocked build does no socket single-voucher work and no Tally/backend mutation", async () => {
  reset({ versionLevel: 2 });
  await socketHandlers.get("sync:request")({ reason: "voucher_written", tallyIds: ["101"], companyName: COMPANY.name, companyGuid: COMPANY.guid });
  assert.equal(engine.singleVoucher, 0, "no targeted fetch");
  assert.equal(engine.syncs, 0, "no fallback sync");
  assert.deepEqual(backend.filter(([m]) => m === "POST"), [], "nothing posted to the server");
  assert.equal(coordinator.snapshot().active.length, 0);
});

test("D1: the same build is refused for manual, scheduled and headless starts too", async () => {
  reset({ versionLevel: 2 });
  const manual = await startManual();
  assert.equal(manual?.status, false);
  const scheduled = await ipc.startAutoSync(() => fakeWindow);
  assert.equal(scheduled?.code, "version_blocked");
  await ipc.startAutoSyncHeadless(() => fakeWindow);
  assert.equal(engine.syncs, 0);
});

test("D1: an allowed build still runs the socket single-voucher fetch", async () => {
  reset();
  await socketHandlers.get("sync:request")({ reason: "voucher_written", tallyIds: ["101"], companyName: COMPANY.name, companyGuid: COMPANY.guid });
  assert.equal(engine.singleVoucher, 1);
});

test("D2: scheduled sync defers without a dialog when the conflict status cannot be read", async () => {
  reset();
  conflictStatus = () => { throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" }); };
  const r = await ipc.startAutoSync(() => fakeWindow);
  assert.equal(r.code, "conflict_status_unknown");
  assert.equal(engine.syncs, 0, "no sync started on an unknown conflict");
  assert.equal(dialogs.length, 0, "unattended work never shows a dialog");
  assert.equal(coordinator.snapshot().recent[0].state, "deferred");
});

test("D2: headless sync defers when another desktop synced more recently", async () => {
  reset();
  conflictStatus = () => ({ data: { status: true, data: { lastSyncedAt: Math.floor(Date.now() / 1000), isMyDevice: false } } });
  await ipc.startAutoSyncHeadless(() => null);
  assert.equal(engine.syncs, 0);
  assert.equal(dialogs.length, 0);
  assert.equal(coordinator.snapshot().recent[0].state, "deferred");
});

test("D2: interactive sync asks on an unknown status; Cancel starts nothing", async () => {
  reset();
  conflictStatus = () => { throw new Error("backend down"); };
  dialogAnswer = 1;
  const r = await startManual();
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /could not check/i);
  assert.equal(engine.syncs, 0);
  assert.equal(r.status, false);
});

test("D2: the conflict check covers every selected company, not only the first", async () => {
  reset();
  const second = { ...COMPANY, guid: "g-2", id: "g-2", name: "Second Co" };
  conflictStatus = (url) => ({
    data: { status: true, data: url.includes("g-2") ? { lastSyncedAt: Math.floor(Date.now() / 1000), isMyDevice: false } : { lastSyncedAt: null, isMyDevice: true } },
  });
  dialogAnswer = 1;
  await handlers.get("tally:start_sync")({ sender: {} }, { companies: [COMPANY, second], isHardSync: false });
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /Second Co/);
  assert.equal(engine.syncs, 0);
});

test("D2: a clear status runs the sync once in every mode", async () => {
  reset();
  await ipc.startAutoSync(() => fakeWindow);
  await ipc.startAutoSyncHeadless(() => null);
  dialogAnswer = 0;
  await startManual();
  assert.equal(engine.syncs, 3);
  assert.equal(dialogs.length, 0);
});

test("13: headless runs return outcomes that map to exit codes", async () => {
  const { headlessExitCode, EXIT } = require("../util/launchDispatcher");
  reset({ versionLevel: 2 });
  assert.equal(headlessExitCode(await ipc.startAutoSyncHeadless(() => null)), EXIT.refused, "blocked build");
  reset();
  conflictStatus = () => { throw new Error("backend down"); };
  assert.equal(headlessExitCode(await ipc.startAutoSyncHeadless(() => null)), EXIT.deferred, "unknown conflict");
  reset();
  assert.equal(headlessExitCode(await ipc.startAutoSyncHeadless(() => null)), EXIT.ok, "clean run");
  reset();
  const held = coordinator.admit("sync", { trigger: "manual" });
  assert.equal(headlessExitCode(await ipc.startAutoSyncHeadless(() => null)), EXIT.deferred, "another sync covers it");
  coordinator.finish?.(held.job, { state: "succeeded", result: null });
});

// R1 / 09: company removal goes through admission; a refused action leaves the running job alone.
test("09: company removal is refused while a sync or a restore runs, and that job is untouched", async () => {
  for (const type of ["sync", "restore"]) {
    reset();
    mem.set("boundWorkspaceId", "ws-1");
    const held = coordinator.admit(type, { trigger: "manual" });
    assert.equal(held.accepted, true);
    const r = await handlers.get("companies:remove")({ sender: {} }, ["g-1"]);
    assert.equal(r.ok, false);
    assert.equal(r.code, "JOB_CONFLICT", `${type} blocks removal`);
    assert.equal(r.activeJob?.id, held.job.id, "the refusal names the running job");
    assert.ok(!backend.some(([, url]) => url === "/desktop/companies/remove"), "nothing sent to the server");
    const active = coordinator.snapshot().active;
    assert.deepEqual(active.map((j) => [j.id, j.cancelRequested]), [[held.job.id, false]]);
    coordinator.finish(held.job, { state: "succeeded", result: null });
  }
});

test("09: a removal with no other job runs once and is recorded with its real outcome", async () => {
  reset();
  mem.set("boundWorkspaceId", "ws-1");
  const r = await handlers.get("companies:remove")({ sender: {} }, ["g-1"]);
  assert.equal(r.ok, true);
  assert.equal(backend.filter(([, url]) => url === "/desktop/companies/remove").length, 1);
  assert.equal(coordinator.snapshot().recent[0].type, "company_removal");
  assert.equal(coordinator.snapshot().recent[0].state, "succeeded");
});

// R1 / 12: health checks own their signals; Stop is an explicit, scoped request.
test("12: status probes never cancel a job; manual Stop cancels only the sync", async () => {
  reset();
  const backupJob = coordinator.admit("backup", { trigger: "manual" });
  // A backup reads files, not Tally, so the probe is a real observation; it still stops nothing.
  await handlers.get("tally:connected")({ sender: {} });
  assert.equal(backupJob.job.cancelRequested, false, "a probe during a backup stops nothing");
  coordinator.finish(backupJob.job, { state: "succeeded", result: null });

  const syncJob = coordinator.admit("sync", { trigger: "headless" });
  for (let i = 0; i < 5; i++) assert.equal(await handlers.get("tally:connected")({ sender: {} }), null);
  assert.equal(syncJob.job.cancelRequested, false);
  const stop = await handlers.get("tally:stop_sync")({ sender: {} }, "manually_stopped");
  assert.equal(stop.ok, true);
  assert.deepEqual(stop.jobs.map((j) => j.id), [syncJob.job.id]);
  assert.equal(syncJob.job.cancelCode, "manually_stopped");
  coordinator.finish(syncJob.job, { state: "cancelled", result: null });
});
