const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const schema = require("../util/schema.json");
const { repairConfig } = require("../util/settingsMigration");

const compile = (useDefaults) => {
  const ajv = new Ajv({ allErrors: true, useDefaults, coerceTypes: false, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
};
// main.js sets backup.dir before validating, so every real config has it.
const repair = (cfg) => repairConfig({ backup: { dir: "C:\\Temp" }, ...cfg }, compile(false), compile(true));

const year = (y) => ({ finYear: `${y}-${y + 1}`, begin: `${y}0401`, end: `${y + 1}0331` });
// Exactly what App.jsx fetchCompanies writes for a selected company.
const rendererCompany = (guid, extra = {}) => ({
  id: guid,
  name: "Shah & Sons",
  guid,
  path: "C:\\TallyPrime\\Data\\10000",
  years: [year(2024), year(2025)],
  isCurrentCompany: true,
  allYears: [year(2024), year(2025)],
  ledgersCount: 12,
  startingFrom: 20240401,
  booksFrom: "20240401",
  companyNumber: 10000,
  isSynced: true,
  lastSyncedAt: "2026-10-08T10:00:00.000Z",
  ...extra,
});

test("the company shape the renderer writes is valid (no silent removal on restart)", () => {
  const cfg = { selectedCompanies: [rendererCompany("g-1"), rendererCompany("g-2", { available: false, ledgersCount: null, path: null })] };
  const r = repair(cfg);
  assert.equal(r.valid, true, r.remainingErrors.join("; "));
  assert.equal(r.config.selectedCompanies.length, 2);
  assert.equal(r.quarantined.length, 0);
});

test("one bad company is quarantined; the others and FY selections are preserved", () => {
  const cfg = { port: 9000, selectedCompanies: [rendererCompany("g-1"), { id: "", name: "x" }, rendererCompany("g-3")] };
  const r = repair(cfg);
  assert.equal(r.valid, true);
  assert.deepEqual(r.config.selectedCompanies.map((c) => c.guid), ["g-1", "g-3"]);
  assert.deepEqual(r.config.selectedCompanies[0].years, [year(2024), year(2025)]);
  assert.equal(r.quarantined.length, 1);
  assert.equal(r.quarantined[0].key, "selectedCompanies");
  assert.equal(r.quarantined[0].index, 1);
});

test("an invalid scalar is reset to its default and kept in quarantine; input is not mutated", () => {
  const cfg = { port: "abc", syncInterval: 15 };
  const before = JSON.stringify(cfg);
  const r = repair(cfg);
  assert.equal(r.config.port, 9000);
  assert.equal(r.config.syncInterval, 15, "valid preferences survive");
  assert.deepEqual(r.quarantined, [{ key: "port", item: "abc" }]);
  assert.equal(JSON.stringify(cfg), before);
});

test("unknown top-level keys are dropped as before but never copied to quarantine", () => {
  const r = repair({ deviceSecretEnc: "legacy-secret", port: 9100 });
  assert.equal(r.config.deviceSecretEnc, undefined);
  assert.equal(r.config.port, 9100);
  assert.equal(JSON.stringify(r.quarantined).includes("legacy-secret"), false);
});

test("validateSchema never deletes config.json or relaunches", () => {
  const src = fs.readFileSync(path.join(__dirname, "../util/validateSchema.js"), "utf8");
  assert.doesNotMatch(src, /unlinkSync\(configPath\)/);
  assert.doesNotMatch(src, /app\.relaunch\(/);
  assert.doesNotMatch(src, /app\.exit\(/);
  assert.match(src, /config\.json\.bak-/);
});
