// P5: backup due logic (15), no-wake task settings + owned-task reconcile (20), Tally start without force-kill (18).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const storePath = require.resolve("../util/store");
require.cache[storePath] = {
  id: storePath,
  filename: storePath,
  loaded: true,
  exports: { get: () => undefined, set: () => {}, delete: () => {} },
};

const { backupDue, outcomePatch, lastVerifiedBackupAt } = require("../util/backupSchedule");
const runner = require("../util/backgroundRunner");
const tdl = require("../util/ensureBillOutstandingTdl");

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-01T10:00:00Z");

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), m };
}

test("overdue weekly backup: due once from the last verified backup, not from enablement time", () => {
  const state = { backupInterval: "7days", autoBackupStartedAt: T0 - 60 * DAY, lastBackupSuccessAt: T0 - 2 * DAY };
  assert.equal(backupDue(state, T0).due, false, "verified 2 days ago → not due although enabled 60 days ago");
  assert.equal(backupDue(state, T0 + 5 * DAY).due, true);
  // Launch-time catch-up needs a clear overdue margin and is triggered at most once an hour.
  assert.equal(backupDue(state, T0 + 5 * DAY, { missed: true }).due, false);
  const overdue = T0 + 7 * DAY;
  assert.equal(backupDue(state, overdue, { missed: true }).due, true);
  assert.equal(backupDue({ ...state, lastMissedBackupTriggerAt: overdue - 60_000 }, overdue, { missed: true }).reason, "recently_triggered");
});

test("cloud list counts as verified evidence; unverified entries do not", () => {
  const state = {
    backupInterval: "1day",
    cloudBackups: [
      { status: "VERIFIED", createdAt: new Date(T0 - 3 * 60 * 60 * 1000).toISOString() },
      { status: "FAILED", createdAt: new Date(T0).toISOString() },
    ],
  };
  assert.equal(lastVerifiedBackupAt(state), T0 - 3 * 60 * 60 * 1000);
  assert.equal(backupDue(state, T0).due, false);
});

test("daily task firing a little before 24h after the last success is still due (no skipped days)", () => {
  const state = { backupInterval: "1day", lastBackupSuccessAt: T0 + 5 * 60 * 1000 };
  assert.equal(backupDue(state, T0 + DAY).due, true);
});

test("backwards clock never makes a backup due; failure backs off and never records success", () => {
  const state = { backupInterval: "1day", lastBackupSuccessAt: T0 };
  assert.equal(backupDue(state, T0 - 3 * DAY).reason, "clock_behind");
  const f1 = outcomePatch({}, { ok: false, nowMs: T0 });
  assert.equal(f1.backupFailureCount, 1);
  assert.equal(f1.lastBackupSuccessAt, undefined);
  assert.equal(backupDue({ backupInterval: "1day", lastBackupSuccessAt: T0 - 2 * DAY, ...f1 }, T0 + 60_000).reason, "backoff");
  const f2 = outcomePatch(f1, { ok: false, nowMs: T0 });
  assert.ok(f2.nextBackupRetryAt - T0 > f1.nextBackupRetryAt - T0, "backoff grows");
  assert.deepEqual(outcomePatch(f2, { ok: true, nowMs: T0 }), { lastBackupSuccessAt: T0, backupFailureCount: 0, nextBackupRetryAt: null });
  assert.equal(backupDue({ backupInterval: "off" }, T0).reason, "schedule_off");
});

test("generated task settings never wake the PC", () => {
  const ps = runner.taskSettingsScript();
  assert.equal(/-WakeToRun/.test(ps), false);
  assert.match(ps, /\$settings\.WakeToRun = \$false/);
  assert.match(ps, /-StartWhenAvailable/);
  const src = fs.readFileSync(path.join(__dirname, "..", "util", "backgroundRunner.js"), "utf8");
  assert.equal(/New-ScheduledTaskSettingsSet[^\n]*-WakeToRun/.test(src), false);
});

test("owned-task reconcile: only TallyDekho tasks, once per version, retried after a failure", async () => {
  const applied = [];
  const store = memStore();
  const exists = async (tn) => tn === "\\TallyDekhoAutoBackup";
  const r1 = await runner.reconcileOwnedTaskSettings(store, { platform: "win32", exists, apply: async (n, p) => applied.push(`${p}${n}`) });
  assert.deepEqual(r1, { action: "reconciled", updated: ["TallyDekhoAutoBackup"] });
  assert.deepEqual(applied, ["\\TallyDekhoAutoBackup"]);
  assert.equal(store.get("scheduledTaskSettingsVersion"), runner.TASK_SETTINGS_VERSION);
  const r2 = await runner.reconcileOwnedTaskSettings(store, { platform: "win32", exists, apply: async () => assert.fail("not again") });
  assert.equal(r2.action, "none");

  const failing = memStore();
  const r3 = await runner.reconcileOwnedTaskSettings(failing, { platform: "win32", exists: async () => true, apply: async () => { throw new Error("denied"); } });
  assert.equal(r3.action, "failed");
  assert.equal(failing.get("scheduledTaskSettingsVersion"), undefined, "version kept so the next launch retries");
  assert.equal((await runner.reconcileOwnedTaskSettings(memStore(), { platform: "darwin" })).action, "skipped");
});

test("Setup never force-closes Tally; unsafe folder or running Tally → explicit refusal", () => {
  const base = { platform: "win32", tallyDir: "C:\\Program Files\\TallyPrime (1)", exeExists: true, tdlExists: true, running: false };
  assert.deepEqual(tdl.planTallyLaunch({ ...base, companyNumber: 10003 }), { ok: true, args: ["/LOAD:10003", "/TDL:TDKBillOutstanding.tdl"] });
  assert.equal(tdl.planTallyLaunch({ ...base, running: true }).code, "TALLY_CLOSE_REQUIRED");
  assert.equal(tdl.planTallyLaunch({ ...base, tallyDir: "C:\\Tally & co" }).code, "TALLY_PATH_UNSAFE");
  assert.deepEqual(tdl.planTallyLaunch({ ...base, companyNumber: "1 & calc" }).args, ["/TDL:TDKBillOutstanding.tdl"], "bad company number is not passed");
  const src = fs.readFileSync(path.join(__dirname, "..", "util", "ensureBillOutstandingTdl.js"), "utf8");
  assert.equal(/taskkill/.test(src), false);
});

test("after a start, selected companies that are not open are reported and stay selected", () => {
  const open = { names: new Map([["g1", "Acme"]]) };
  assert.deepEqual(tdl.companiesNotOpen([{ guid: "g1", name: "Acme" }, { guid: "g2", name: "Beta" }], open), ["Beta"]);
  assert.equal(tdl.companiesNotOpen([{ guid: "g1" }], null), null);
  const health = tdl.buildHealth({
    tallyDir: null,
    detectSource: "test",
    activateResult: { status: false, code: "TALLY_CLOSE_REQUIRED", message: "close" },
  });
  assert.ok(health);
});

test("Setup with Tally running shows the close-Tally instruction", async () => {
  tdl.__setDepsForTests({
    platform: () => "win32",
    fileExists: () => true,
    readIni: () => ({ found: true, userTdlYes: true, tdlListed: true, quotedOk: true }),
    detect: async () => ({ path: "C:\\TallyPrime", source: "test" }),
    apply: () => ({ status: true }),
    companyMeta: () => ({ companyName: "Demo", companyNumber: 1 }),
    wait: async () => {},
    liveStatus: async () => ({ tdlStatus: "NOT_LOADED" }),
    checkHealth: async () => ({ status: "NOT_LOADED" }),
    activate: async () => ({ status: false, code: "TALLY_CLOSE_REQUIRED", message: "Tally is open. Save your work and close Tally, then click Retry setup" }),
  });
  try {
    const h = await tdl.setupTdl(null, { allowRestart: true });
    assert.equal(h.reason, "tally_close_required");
    assert.match(h.message, /close Tally/);
  } finally {
    tdl.__setDepsForTests(null);
  }
});
