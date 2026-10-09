// R1 / 04 + N4: one versioned, recoverable settings load per process, before
// headless or windowed work. Real validateSchema against config files in a temp dir.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const loggerPath = require.resolve(path.join(ROOT, "util/logger"));
require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: { info: () => {}, error: () => {} } };

const validateSchema = require(path.join(ROOT, "util/validateSchema"));
const { runProcessStartup, resetProcessStartupForTests } = require(path.join(ROOT, "util/processStartup"));

const year = (y) => ({ finYear: `${y}-${y + 1}`, begin: `${y}0401`, end: `${y + 1}0331` });
const company = (guid) => ({
  id: guid, guid, name: "Shah & Sons", path: "C:\\TallyPrime\\Data\\10000",
  years: [year(2024), year(2025)], allYears: [year(2024), year(2025)], isCurrentCompany: true,
});
// What a pre-upgrade install has on disk (no configSchemaVersion yet).
const preUpgrade = () => ({
  backup: { dir: "C:\\Temp" },
  port: 9123,
  selectedCompanies: [company("g-1"), company("g-2")],
  cloudBackups: [{ id: "b-1", created_at: 1760000000, size: 1024 }],
  deviceSecretEnc: "legacy-not-yet-migrated",
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "td-settings-"));
const cfgPath = (dir) => path.join(dir, "config.json");
const readCfg = (dir) => JSON.parse(fs.readFileSync(cfgPath(dir), "utf8"));
const files = (dir, prefix) => fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
const writeCfg = (dir, cfg) => fs.writeFileSync(cfgPath(dir), JSON.stringify(cfg, null, "\t"));

test("upgrade keeps cloud backups, port, company/year choices and the legacy secret; one backup", () => {
  const dir = tmp();
  writeCfg(dir, preUpgrade());
  const r = validateSchema({ dir });
  assert.equal(r.upgraded, true);
  const cfg = readCfg(dir);
  assert.equal(cfg.port, 9123);
  assert.deepEqual(cfg.selectedCompanies.map((c) => c.guid), ["g-1", "g-2"]);
  assert.deepEqual(cfg.selectedCompanies[0].years, [year(2024), year(2025)]);
  assert.deepEqual(cfg.cloudBackups, preUpgrade().cloudBackups, "cloudBackups survives startup");
  assert.equal(cfg.deviceSecretEnc, "legacy-not-yet-migrated", "credential migration input is not dropped");
  assert.equal(cfg.configSchemaVersion, validateSchema.CONFIG_SCHEMA_VERSION);
  assert.equal(files(dir, "config.json.bak-").length, 1, "one pre-upgrade backup");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, files(dir, "config.json.bak-")[0]), "utf8")), preUpgrade());
});

test("a no-op restart neither rewrites the config nor creates a backup", () => {
  const dir = tmp();
  writeCfg(dir, preUpgrade());
  validateSchema({ dir });
  const before = fs.readFileSync(cfgPath(dir), "utf8");
  const mtime = fs.statSync(cfgPath(dir)).mtimeMs;
  for (let i = 0; i < 3; i++) {
    const r = validateSchema({ dir });
    assert.equal(r.written, false);
    assert.equal(r.upgraded, false);
  }
  assert.equal(fs.readFileSync(cfgPath(dir), "utf8"), before);
  assert.equal(fs.statSync(cfgPath(dir)).mtimeMs, mtime);
  assert.equal(files(dir, "config.json.bak-").length, 1);
});

test("one invalid company is quarantined with its original content; the rest is kept", () => {
  const dir = tmp();
  const cfg = { ...preUpgrade(), configSchemaVersion: validateSchema.CONFIG_SCHEMA_VERSION };
  cfg.selectedCompanies = [company("g-1"), { id: "", name: 42 }, company("g-3")];
  writeCfg(dir, cfg);
  validateSchema({ dir });
  assert.deepEqual(readCfg(dir).selectedCompanies.map((c) => c.guid), ["g-1", "g-3"]);
  const q = files(dir, "config.quarantine-");
  assert.equal(q.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, q[0]), "utf8"))[0].item, { id: "", name: 42 });
  assert.equal(files(dir, "config.json.bak-").length, 1, "a real repair is backed up");
});

test("an interrupted write leaves the previous config intact and the next start completes", () => {
  const dir = tmp();
  writeCfg(dir, preUpgrade());
  const original = fs.readFileSync(cfgPath(dir), "utf8");
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error("power cut"), { code: "EIO" }); };
  try {
    const r = validateSchema({ dir });
    assert.equal(r.failed, true);
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(fs.readFileSync(cfgPath(dir), "utf8"), original, "config.json was not truncated");
  validateSchema({ dir });
  assert.deepEqual(readCfg(dir).cloudBackups, preUpgrade().cloudBackups);
});

test("pruning never cycles out the oldest (pre-upgrade) backup", () => {
  const dir = tmp();
  const oldest = "config.json.bak-2026-01-01T00-00-00-000Z";
  fs.writeFileSync(path.join(dir, oldest), "{}");
  for (let d = 2; d <= 7; d++) fs.writeFileSync(path.join(dir, `config.json.bak-2026-01-0${d}T00-00-00-000Z`), "{}");
  const cfg = { ...preUpgrade(), configSchemaVersion: validateSchema.CONFIG_SCHEMA_VERSION, port: "bad" };
  writeCfg(dir, cfg);
  validateSchema({ dir });
  const left = files(dir, "config.json.bak-");
  assert.equal(left.length, 5);
  assert.equal(left[0], oldest);
});

test("startup work runs once per process: a window opened later repeats none of it", async () => {
  resetProcessStartupForTests();
  const mem = new Map([["isAutoSync", true], ["backupInterval", "7days"]]);
  const store = { get: (k) => mem.get(k), set: (k, v) => mem.set(k, v) };
  const calls = { validate: 0, exists: 0, reconcile: 0 };
  const deps = {
    store,
    validateSchema: () => { calls.validate++; return {}; },
    isTaskExists: async () => { calls.exists++; return true; },
    reconcileOwnedTaskSettings: async () => { calls.reconcile++; return { action: "applied" }; },
    appVersion: "9.9.9",
    tmpdir: "/tmp",
  };
  const first = runProcessStartup(deps); // headless launch
  await first.done;
  const second = runProcessStartup(deps); // the user opens the window during the job
  await second.done;
  assert.equal(second, first);
  assert.deepEqual(calls, { validate: 1, exists: 2, reconcile: 1 });
  assert.equal(mem.get("appVersion"), "9.9.9");
});

test("main.js wiring (structural): settings load precedes registration; createWindow has no startup work", () => {
  const main = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  const ready = main.slice(main.indexOf("app.whenReady()"));
  assert.ok(ready.indexOf("runProcessStartup(") > -1 && ready.indexOf("runProcessStartup(") < ready.indexOf("registerDevice("));
  const cw = main.slice(main.indexOf("async function createWindow()"), main.indexOf("loadRenderer(mainWindow);"));
  for (const s of ["validateSchema(", "reconcileOwnedTaskSettings", "isTaskExists(", "startMissedBackupIfDue("]) {
    assert.ok(!cw.includes(s), `createWindow must not run ${s}`);
  }
  assert.match(main, /if \(!isHeadless\) startMissedBackupIfDue\(\);/);
});
