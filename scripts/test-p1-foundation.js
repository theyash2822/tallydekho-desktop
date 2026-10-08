const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { toLoggable, formatMeta, rotateIfNeeded, MAX_FILE_BYTES } = require("../util/logger");
const { checkRegisterResponse, toIsoDate } = require("../util/registerResponse");
const { toDiscoveredCompany, buildDiscovery } = require("../util/companyDiscovery");
const { canRendererRead, canRendererWrite } = require("../util/storeAllowlist");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

// ── S5 logger ────────────────────────────────────────────────────────────────

test("logger keeps Error fields and drops axios config/request bodies", () => {
  const err = new Error("boom");
  err.code = "ECONNRESET";
  assert.deepEqual(Object.keys(toLoggable(err)).sort(), ["code", "message", "name", "stack"]);

  const axiosErr = Object.assign(new Error("Request failed"), {
    isAxiosError: true,
    config: { method: "post", url: "/ingest/chunk", headers: { Authorization: "x" }, data: "payload" },
    response: { status: 401, data: { code: "DEVICE_CREDENTIAL_INVALID", detail: "y" } },
  });
  const out = toLoggable(axiosErr);
  assert.equal(out.httpStatus, 401);
  assert.equal(out.serverCode, "DEVICE_CREDENTIAL_INVALID");
  assert.equal(out.url, "/ingest/chunk");
  assert.ok(!JSON.stringify(out).includes("payload"));
  assert.ok(!("headers" in out));
});

test("logger redacts secret-looking keys, survives cycles and caps size", () => {
  const meta = { deviceSecret: "s", nested: { claimToken: "t", password: "p", ok: 1 }, apiKey: "k" };
  meta.self = meta;
  const out = toLoggable(meta);
  assert.equal(out.deviceSecret, "[REDACTED]");
  assert.equal(out.nested.claimToken, "[REDACTED]");
  assert.equal(out.nested.password, "[REDACTED]");
  assert.equal(out.apiKey, "[REDACTED]");
  assert.equal(out.nested.ok, 1);
  assert.equal(out.self, "[Circular]");

  assert.equal(formatMeta(undefined), "");
  assert.equal(formatMeta(null), "");
  assert.equal(formatMeta("plain"), " plain");
  const big = formatMeta({ blob: "x".repeat(20000) });
  assert.ok(big.length < 9000);
  assert.match(big, /chars cut/);
  assert.equal(toLoggable(Buffer.alloc(10)), "[Buffer 10 bytes]");
});

test("logger rotates a file past the size cap", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "td-log-"));
  try {
    const file = path.join(dir, "info.log");
    fs.writeFileSync(file, Buffer.alloc(MAX_FILE_BYTES + 1));
    rotateIfNeeded(file);
    assert.ok(!fs.existsSync(file));
    assert.ok(fs.existsSync(path.join(dir, "info.1.log")));
    fs.writeFileSync(file, "small");
    rotateIfNeeded(file);
    assert.ok(fs.existsSync(file), "small files are left alone");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── S4 registration response ─────────────────────────────────────────────────

test("registration success needs status === true and a sane versionLevel", () => {
  assert.equal(checkRegisterResponse(null).ok, false);
  assert.equal(checkRegisterResponse("<html>").ok, false);
  assert.equal(checkRegisterResponse({ status: false, message: "nope" }).ok, false);
  assert.equal(checkRegisterResponse({ status: "true" }).ok, false);
  assert.equal(checkRegisterResponse({ status: true, data: "x" }).ok, false);
  assert.equal(checkRegisterResponse({ status: true, data: { versionLevel: 9 } }).ok, false);
  assert.equal(checkRegisterResponse({ status: true, data: { versionLevel: 1.5 } }).ok, false);
  assert.equal(checkRegisterResponse({ status: true, data: { versionLevel: 2 } }).ok, true);
  assert.equal(checkRegisterResponse({ status: true }).ok, true);
});

test("server lastSync is normalised to ISO or ignored", () => {
  assert.equal(toIsoDate(null), null);
  assert.equal(toIsoDate(""), null);
  assert.equal(toIsoDate("not a date"), null);
  assert.equal(toIsoDate("2026-10-08T10:00:00.000Z"), "2026-10-08T10:00:00.000Z");
  assert.equal(toIsoDate(1791453600), new Date(1791453600 * 1000).toISOString());
  assert.equal(toIsoDate(1791453600000), new Date(1791453600000).toISOString());
});

// ── 05 / N2 company discovery ────────────────────────────────────────────────

const rawCompany = (guid, name, extra = {}) => ({
  GUID: guid,
  NAME: name,
  STARTINGFROM: 20230401,
  ENDINGAT: 20250331,
  BOOKSFROM: 20230401,
  COMPANYNUMBER: 10001,
  DESTINATION: "C:/Tally/Data",
  ...extra,
});

test("discovery skips entries without identity or dates instead of failing all", () => {
  const result = buildDiscovery(
    [rawCompany("g1", "A"), { NAME: "No guid", STARTINGFROM: 20230401, ENDINGAT: 20240331 }, rawCompany("g2", "B", { ENDINGAT: undefined })],
    "g1",
    { observedAt: "2026-10-08T00:00:00.000Z", ledgerCountFor: (g) => (g === "g1" ? 42 : null) }
  );
  assert.equal(result.status, "ok");
  assert.equal(result.companies.length, 1);
  assert.equal(result.skipped, 2);
  const [a] = result.companies;
  assert.equal(a.guid, "g1");
  assert.equal(a.isCurrentCompany, true);
  assert.equal(a.ledgersCount, 42);
  assert.deepEqual(a.years.map((y) => y.finYear), ["2023-2024", "2024-2025"]);
});

test("numeric GUIDs from the XML parser become strings", () => {
  const c = toDiscoveredCompany(rawCompany(12345, "N"), "12345");
  assert.equal(c.guid, "12345");
  assert.equal(c.isCurrentCompany, true);
  assert.equal(c.ledgersCount, null);
});

test("xml.js discovery is typed and the poll no longer exports ledgers inline", () => {
  const src = read("util/xml.js");
  assert.match(src, /status: "unavailable", reason: "tally_request_failed"/);
  assert.match(src, /refreshLedgerCounts\(result\.companies\)\.catch/);
  assert.match(src, /coordinator\.isActive\(\["sync", "hard_sync", "restore", "tally_restart"\]\)\) return;/);
  assert.doesNotMatch(src, /stopTallySyncCode/);
});

// ── 04 / 12 sync ownership and cancellation ─────────────────────────────────

test("renderer may read but not write isSyncing", () => {
  assert.equal(canRendererRead("isSyncing"), false);
  assert.equal(canRendererWrite("isSyncing"), false);
  assert.equal(canRendererWrite("port"), true);
});

test("upload cancellation never aborts /ingest/complete", () => {
  const src = read("util/xml.js");
  const complete = src.slice(src.indexOf('"/ingest/complete"') - 400, src.indexOf('"/ingest/complete"') + 400);
  assert.doesNotMatch(complete, /signal/);
  assert.match(src, /stopTallySyncHandler[\s\S]{0,400}coordinator\.requestCancel\(\{ types: \["sync", "hard_sync"\]/);
});

test("renderer never forces isSyncing false; it mirrors job events", () => {
  for (const file of [
    "renderer/app/App.jsx",
    "renderer/app/views/dashboard/Dashboard.jsx",
    "renderer/app/views/components/TitleBar.jsx",
  ]) {
    const src = read(file);
    assert.doesNotMatch(src, /updateState\("isSyncing", false\)/, file);
    assert.doesNotMatch(src, /setPref\("isSyncing"/, file);
  }
  const app = read("renderer/app/App.jsx");
  assert.match(app, /window\.tally\.onJobChanged/);
  assert.match(app, /mergeDiscovery\(/);
  assert.doesNotMatch(app, /companies\.map\(\(company\) => \(\{/);
});

test("socket events request cancellation instead of clearing the flag", () => {
  const src = read("util/socket.js");
  assert.doesNotMatch(src, /store\.set\("isSyncing", false\)/);
  assert.match(src, /coordinator\.requestCancel\(\{[^}]*code: "unpaired"/);
  assert.match(src, /coordinator\.requestCancel\(\{[^}]*code: "binding_revoked"/);
});

// ── 13 / 14 / 16 / 19 / S1 / S2 main process ───────────────────────────────

test("no import-time backup IIFE; missed backup runs only from interactive start", () => {
  const ipc = read("util/ipcRegistry.js");
  assert.doesNotMatch(ipc, /^\(async \(\) =>/m);
  assert.match(ipc, /const startMissedBackupIfDue = /);
  const main = read("main.js");
  assert.match(main, /function startInteractive\(\)[\s\S]{0,2500}startMissedBackupIfDue\(\)/);
});

test("headless registration failure exits without a modal", () => {
  const main = read("main.js");
  const i = main.indexOf("if (!response.status) {");
  const headless = main.indexOf("if (isHeadless && !uiRequested)", i);
  const dialogAt = main.indexOf("dialog.showMessageBoxSync", i);
  assert.ok(headless > i && headless < dialogAt, "headless check comes before the dialog");
  assert.match(main.slice(headless, dialogAt), /app\.quit\(\);\s*return;/);
});

test("second instance routes by intent and never runs jobs before ready", () => {
  const main = read("main.js");
  assert.match(main, /const secondInstanceIntent = /);
  assert.match(main, /if \(!appReady\) \{\s*info\(`Background \[\$\{intent\} skipped\]/);
  assert.match(main, /if \(!interactiveStarted\) app\.quit\(\);/);
});

test("closeSoftware is gone from main, preload and disk", () => {
  assert.doesNotMatch(read("main.js"), /closeSoftware/);
  assert.doesNotMatch(read("preload.js"), /closeByName/);
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "util/closeSoftware.js")));
});

test("port writes are validated in main", () => {
  const main = read("main.js");
  assert.match(main, /if \(!Number\.isInteger\(port\) \|\| port < 1 \|\| port > 65535\)/);
});

test("updater failures and refusals reach the renderer", () => {
  const main = read("main.js");
  assert.match(main, /notify\("updater:status", \{ state: "error", error: refusal \}\)/);
  const ui = read("renderer/app/views/components/AppUpdate.jsx");
  assert.match(ui, /state === "error" \? "Retry" : "Check for updates"/);
  assert.match(ui, /Update check failed/);
});
