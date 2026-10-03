#!/usr/bin/env node
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  BILL_STATUS,
  fetchCompanyBillSnapshot,
  classifyBillResponse,
  snapshotSummary,
} = require("../util/billSnapshot");
const {
  TDL_STATUS,
  TDL_VERSION,
  checkTdlHealth,
  classifyHealthResponse,
  healthRequestXml,
} = require("../util/tdlHealth");

const ROOT = path.join(__dirname, "..");

const healthXml = (version = TDL_VERSION) =>
  `<ENVELOPE><TDKSTATUS><ACTIVE>YES</ACTIVE><VERSION>${version}</VERSION>` +
  `<REPORT>TDKBillOutstandingWorking</REPORT></TDKSTATUS></ENVELOPE>`;
const MISSING = `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER>` +
  `<BODY><DATA><LINEERROR>Could not find Report 'X'!</LINEERROR></DATA></BODY></ENVELOPE>`;
const EMPTY = "<ENVELOPE></ENVELOPE>";
const ctx = (company) => `<TDKCONTEXT><COMPANY>${company}</COMPANY></TDKCONTEXT>`;
/** BILLROW; `company` undefined → pre-1.1.1 row without a Company tag. */
const billRow = (ledger, bill, pending, company) =>
  `<BILLROW><LedgerName>${ledger}</LedgerName><BillName>${bill}</BillName><BillDate>2026-04-10</BillDate>` +
  `<DueDate></DueDate><CreditPeriod></CreditPeriod><Amount>${pending}</Amount><PendingAmount>${pending}</PendingAmount>` +
  `<DrCr>Dr</DrCr><LedgerParent>${ledger}</LedgerParent>` +
  (company === undefined ? "" : `<Company>${company}</Company>`) +
  `</BILLROW>`;
/** TDL 1.1.1 bill response: context line + rows. */
const bills = (company, ...rows) => `<ENVELOPE>${ctx(company)}${rows.join("")}</ENVELOPE>`;
/** Pre-1.1.1 bill response: rows only. */
const legacyBills = (...rows) => `<ENVELOPE>${rows.join("")}</ENVELOPE>`;

/** Fake Tally: health is global; bill answers are per SVCURRENTCOMPANY. Records every request. */
function fakeTally({ health, companies = {} }) {
  const calls = [];
  const post = async (xml) => {
    const report = /<ID>([^<]+)<\/ID>/.exec(xml)?.[1];
    const company = /<SVCURRENTCOMPANY>([^<]*)<\/SVCURRENTCOMPANY>/.exec(xml)?.[1] ?? null;
    calls.push({ report, company });
    const answer = report === "TDKBillOutstandingHealth" ? health : companies[company];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { post, calls };
}

const snap = (companyName, post, extra = {}) =>
  fetchCompanyBillSnapshot({
    companyName,
    companyGuid: `guid-${companyName}`,
    fromDate: "20260401",
    toDate: "20270331",
    currentDate: "20261001",
    post,
    billAttempts: 1,
    ...extra,
  });

const billCalls = (calls) => calls.filter((c) => c.report === "TDKBillOutstandingWorking");

// ── Health ACTIVE ───────────────────────────────────────────────────────────

test("ACTIVE + verified company + rows → SUCCESS (replace)", async () => {
  const { post } = fakeTally({
    health: healthXml(),
    companies: { "Yash Ki Company": bills("Yash Ki Company", billRow("L1", "B1", 100, "Yash Ki Company"), billRow("L2", "B2", 50, "Yash Ki Company")) },
  });
  const r = await snap("Yash Ki Company", post);
  assert.equal(r.status, BILL_STATUS.SUCCESS);
  assert.equal(r.snapshotComplete, true);
  assert.equal(r.rowCount, 2);
  assert.equal(r.rows[0].BillName, "B1");
  assert.equal(r.tdlStatus, TDL_STATUS.ACTIVE);
  assert.equal(r.contextCompany, "Yash Ki Company");
});

test("ACTIVE + TDKCONTEXT matches + zero rows → SUCCESS (verified zero clears)", async () => {
  const { post } = fakeTally({ health: healthXml(), companies: { Laveena: bills("Laveena") } });
  const r = await snap("Laveena", post);
  assert.equal(r.status, BILL_STATUS.SUCCESS);
  assert.equal(r.snapshotComplete, true);
  assert.equal(r.rowCount, 0);
});

test("ACTIVE + bare empty envelope (no company context) → COMPANY_UNVERIFIED, preserve", async () => {
  const { post } = fakeTally({ health: healthXml(), companies: { Laveena: EMPTY } });
  const r = await snap("Laveena", post);
  assert.equal(r.status, BILL_STATUS.COMPANY_UNVERIFIED);
  assert.equal(r.snapshotComplete, false);
});

test("TDKCONTEXT names another company → COMPANY_CONTEXT_MISMATCH, preserve", async () => {
  const { post } = fakeTally({ health: healthXml(), companies: { Laveena: bills("Yash Ki Company") } });
  const r = await snap("Laveena", post);
  assert.equal(r.status, BILL_STATUS.COMPANY_CONTEXT_MISMATCH);
  assert.equal(r.snapshotComplete, false);
});

test("any row from another company → COMPANY_CONTEXT_MISMATCH, preserve", async () => {
  const { post } = fakeTally({
    health: healthXml(),
    companies: { A: bills("A", billRow("L", "B1", 1, "A"), billRow("L", "B2", 2, "Other Co")) },
  });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.COMPANY_CONTEXT_MISMATCH);
  assert.equal(r.snapshotComplete, false);
});

test("company names compare case/space-insensitively", async () => {
  const { post } = fakeTally({ health: healthXml(), companies: { "Yash Ki Company": bills("yash  ki company") } });
  const r = await snap("Yash Ki Company", post);
  assert.equal(r.status, BILL_STATUS.SUCCESS);
});

test("outdated health version → ACTIVE_OUTDATED, verified bills still sync", async () => {
  const { post } = fakeTally({ health: healthXml("1.1.0"), companies: { A: bills("A") } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.SUCCESS);
  assert.equal(r.tdlStatus, TDL_STATUS.ACTIVE_OUTDATED);
});

// ── Health UNCONFIRMED (empty envelope / not active) ───────────────────────

test("UNCONFIRMED health still fetches bills; matching rows → SUCCESS, tdlStatus HEALTH_UNCONFIRMED", async () => {
  const { post, calls } = fakeTally({
    health: EMPTY,
    companies: { "Yash Ki Company": bills("Yash Ki Company", billRow("L", "B1", 5, "Yash Ki Company")) },
  });
  const r = await snap("Yash Ki Company", post);
  assert.equal(billCalls(calls).length, 1, "fallback bill fetch ran");
  assert.equal(r.status, BILL_STATUS.SUCCESS);
  assert.equal(r.snapshotComplete, true);
  assert.equal(r.tdlStatus, TDL_STATUS.HEALTH_UNCONFIRMED);
});

test("UNCONFIRMED health + zero rows → LEGACY_EMPTY_AMBIGUOUS, preserve", async () => {
  const { post } = fakeTally({ health: EMPTY, companies: { Laveena: bills("Laveena") } });
  const r = await snap("Laveena", post);
  assert.equal(r.status, BILL_STATUS.LEGACY_EMPTY_AMBIGUOUS);
  assert.equal(r.snapshotComplete, false);
  assert.equal(r.tdlStatus, TDL_STATUS.HEALTH_UNCONFIRMED);
});

test("UNCONFIRMED health + rows without company identity → COMPANY_UNVERIFIED, preserve", async () => {
  const { post } = fakeTally({ health: EMPTY, companies: { A: legacyBills(billRow("L", "B1", 5)) } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.COMPANY_UNVERIFIED);
  assert.equal(r.snapshotComplete, false);
});

test("UNCONFIRMED health + rows of another company → COMPANY_CONTEXT_MISMATCH", async () => {
  const { post } = fakeTally({ health: EMPTY, companies: { A: bills("B", billRow("L", "B1", 5, "B")) } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.COMPANY_CONTEXT_MISMATCH);
  assert.equal(r.snapshotComplete, false);
});

// ── Legacy add-on (no health report) ───────────────────────────────────────

test("legacy add-on (health report missing) + pre-1.1.1 rows → SUCCESS, ACTIVE_LEGACY", async () => {
  const { post } = fakeTally({ health: MISSING, companies: { A: legacyBills(billRow("L1", "B1", 10)) } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.SUCCESS);
  assert.equal(r.snapshotComplete, true);
  assert.equal(r.tdlStatus, TDL_STATUS.ACTIVE_LEGACY);
});

test("legacy add-on + empty envelope → ambiguous, preserve", async () => {
  const { post } = fakeTally({ health: MISSING, companies: { A: EMPTY } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.LEGACY_EMPTY_AMBIGUOUS);
  assert.equal(r.snapshotComplete, false);
  assert.equal(r.tdlStatus, TDL_STATUS.UNKNOWN);
});

test("no health report and no bill report → TDL_NOT_LOADED, preserve", async () => {
  const { post } = fakeTally({ health: MISSING, companies: { A: MISSING } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.TDL_NOT_LOADED);
  assert.equal(r.snapshotComplete, false);
  assert.equal(r.tdlStatus, TDL_STATUS.NOT_LOADED);
});

// ── Transport / shape failures ─────────────────────────────────────────────

test("Tally unreachable → TALLY_UNREACHABLE and the bill report is never requested", async () => {
  const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const { post, calls } = fakeTally({ health: err, companies: { A: bills("A", billRow("L", "B", 1, "A")) } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.TALLY_UNREACHABLE);
  assert.equal(r.snapshotComplete, false);
  assert.equal(billCalls(calls).length, 0);
});

test("bill request timeout → TALLY_TIMEOUT, preserve", async () => {
  const err = Object.assign(new Error("timeout of 60000ms exceeded"), { code: "ECONNABORTED" });
  const { post } = fakeTally({ health: healthXml(), companies: { A: err } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.TALLY_TIMEOUT);
  assert.equal(r.snapshotComplete, false);
});

test("unexpected bill response shape → INVALID_RESPONSE (never treated as zero bills)", async () => {
  const junk = "<ENVELOPE><HEADER><VERSION>1</VERSION></HEADER><BODY><DATA/></BODY></ENVELOPE>";
  const { post } = fakeTally({ health: healthXml(), companies: { A: junk } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.INVALID_RESPONSE);
  assert.equal(r.snapshotComplete, false);
});

test("BILLROW tags that do not all parse → PARSE_FAILED", () => {
  const r = classifyBillResponse(`<ENVELOPE>${ctx("A")}${billRow("L", "B", 1, "A")}<BILLROW></BILLROW></ENVELOPE>`);
  assert.equal(r.kind, "PARSE_FAILED");
  assert.equal(r.tagCount, 2);
});

test("classifyBillResponse reads TDKCONTEXT and per-row Company", () => {
  const r = classifyBillResponse(bills("Yash Ki Company", billRow("L", "B1", 1, "Yash Ki Company")));
  assert.equal(r.kind, "ROWS");
  assert.equal(r.contextCompany, "Yash Ki Company");
  assert.deepEqual(r.rowCompanies, ["Yash Ki Company"]);
  const zero = classifyBillResponse(bills("Laveena"));
  assert.equal(zero.kind, "EMPTY");
  assert.equal(zero.contextCompany, "Laveena");
});

// ── Health once per sync run ───────────────────────────────────────────────

test("one health check per sync run: 3 companies → 1 health request, 3 bill requests", async () => {
  const { post, calls } = fakeTally({
    health: healthXml(),
    companies: {
      "Yash Ki Company": bills("Yash Ki Company", billRow("L", "B1", 5, "Yash Ki Company")),
      "Radhe Ram": bills("Radhe Ram", billRow("L", "R1", 7, "Radhe Ram")),
      Laveena: bills("Laveena"),
    },
  });
  const health = await checkTdlHealth({ post });
  const results = {};
  for (const name of ["Yash Ki Company", "Radhe Ram", "Laveena"]) {
    results[name] = await snap(name, post, { health });
  }
  assert.equal(calls.filter((c) => c.report === "TDKBillOutstandingHealth").length, 1);
  assert.equal(billCalls(calls).length, 3);
  assert.deepEqual(Object.values(results).map((r) => r.status), ["SUCCESS", "SUCCESS", "SUCCESS"]);
  assert.deepEqual(Object.values(results).map((r) => r.rowCount), [1, 1, 0]);
});

test("company order has no effect on any company's result", async () => {
  const tally = {
    health: healthXml(),
    companies: {
      Zero: bills("Zero"),
      Many: bills("Many", billRow("L", "B1", 5, "Many"), billRow("L", "B2", 6, "Many")),
      Bare: EMPTY,
    },
  };
  const run = async (order) => {
    const { post } = fakeTally(tally);
    const health = await checkTdlHealth({ post });
    const out = {};
    for (const name of order) {
      const r = await snap(name, post, { health });
      out[name] = { status: r.status, complete: r.snapshotComplete, rows: r.rowCount };
    }
    return out;
  };
  const forward = await run(["Zero", "Many", "Bare"]);
  assert.deepEqual(forward, await run(["Bare", "Many", "Zero"]));
  assert.deepEqual(forward, await run(["Many", "Bare", "Zero"]));
  assert.deepEqual(forward.Zero, { status: "SUCCESS", complete: true, rows: 0 });
  assert.deepEqual(forward.Many, { status: "SUCCESS", complete: true, rows: 2 });
  assert.deepEqual(forward.Bare, { status: "COMPANY_UNVERIFIED", complete: false, rows: 0 });
});

// ── Health request / classification ────────────────────────────────────────

test("health request is company-independent (no SVCURRENTCOMPANY)", async () => {
  assert.doesNotMatch(healthRequestXml(), /SVCURRENTCOMPANY/);
  const { post, calls } = fakeTally({ health: healthXml() });
  await checkTdlHealth({ post });
  assert.equal(calls[0].company, null);
});

test("health classification", () => {
  const active = classifyHealthResponse(healthXml());
  assert.equal(active.status, TDL_STATUS.ACTIVE);
  assert.equal(active.version, "1.1.1");
  assert.equal(active.report, "TDKBillOutstandingWorking");

  const empty = classifyHealthResponse(EMPTY);
  assert.equal(empty.status, TDL_STATUS.HEALTH_UNCONFIRMED);
  assert.equal(empty.reason, "empty_envelope");
  assert.notEqual(empty.status, TDL_STATUS.ACTIVE);
  assert.notEqual(empty.status, TDL_STATUS.NOT_LOADED);

  assert.equal(
    classifyHealthResponse("<ENVELOPE><TDKSTATUS><ACTIVE>NO</ACTIVE></TDKSTATUS></ENVELOPE>").status,
    TDL_STATUS.HEALTH_UNCONFIRMED
  );
  assert.equal(classifyHealthResponse("").status, TDL_STATUS.INVALID_RESPONSE);
  assert.equal(classifyHealthResponse(MISSING).status, TDL_STATUS.HEALTH_MISSING);
});

test("health: TDKSTATUS is found with or without the ENVELOPE wrapper, any tag case", () => {
  const line = `<TDKSTATUS><ACTIVE>YES</ACTIVE><VERSION>${TDL_VERSION}</VERSION></TDKSTATUS>`;
  assert.equal(classifyHealthResponse(line).status, TDL_STATUS.ACTIVE);
  assert.equal(classifyHealthResponse(`<RESPONSE>${line}</RESPONSE>`).status, TDL_STATUS.ACTIVE);
  const lower = `<ENVELOPE><TDKSTATUS><Active> YES </Active><Version>${TDL_VERSION}</Version></TDKSTATUS></ENVELOPE>`;
  const r = classifyHealthResponse(lower);
  assert.equal(r.status, TDL_STATUS.ACTIVE);
  assert.equal(r.version, TDL_VERSION);
});

// ── TDL file ───────────────────────────────────────────────────────────────

const sectionOf = (tdl, header) => {
  const start = tdl.indexOf(header);
  if (start < 0) return "";
  const next = tdl.indexOf("\n[", start + header.length);
  return tdl.slice(start, next < 0 ? undefined : next);
};

test("TDL 1.1.1: one-row company-independent health; bill report carries company context", () => {
  for (const file of ["xmls/TDKBillOutstanding.tdl", "xmls/TDKBillOutstanding.alt-collection.tdl"]) {
    const tdl = fs.readFileSync(path.join(ROOT, file), "utf8");
    const version = /\[Field: TDKBOH Version\][\s\S]*?Set As\s*:\s*"([^"]+)"/.exec(tdl)?.[1];
    assert.equal(version, TDL_VERSION, file);
    assert.match(sectionOf(tdl, "[Part: TDKBOH Body]"), /Repeat\s*:\s*TDKBOH Line/, file);
    const healthSections = ["[Report: TDKBillOutstandingHealth]", "[Part: TDKBOH Body]", "[Line: TDKBOH Line]"]
      .map((h) => sectionOf(tdl, h)).join("\n");
    assert.doesNotMatch(healthSections, /SVCurrentCompany|TDKBOH Company/i, `${file}: health must not depend on company`);
    assert.match(sectionOf(tdl, "[Form: TDKBO Form]"), /Parts\s*:\s*TDKBO Context,\s*TDKBO Body/, file);
    assert.match(sectionOf(tdl, "[Line: TDKBO ContextLine]"), /XML Tag\s*:\s*TDKCONTEXT/, file);
    assert.match(sectionOf(tdl, "[Line: TDKBO Line]"), /TDKBO Company/, file);
  }
  const main = fs.readFileSync(path.join(ROOT, "xmls/TDKBillOutstanding.tdl"), "utf8");
  assert.match(sectionOf(main, "[Part: TDKBOH Body]"), /Set\s*:\s*1/);
  assert.match(sectionOf(main, "[Part: TDKBO Context]"), /Set\s*:\s*1/);
});

// ── Lifecycle guard ────────────────────────────────────────────────────────

test("no sync path can reach the Tally restart", () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
  for (const f of ["util/xml.js", "util/tdlHealth.js", "util/billSnapshot.js", "util/tdlFiles.js"]) {
    const src = read(f);
    assert.doesNotMatch(src, /require\(["']\.\/ensureBillOutstandingTdl["']\)/, `${f} imports the setup module`);
    assert.doesNotMatch(src, /taskkill|activateTdlByRestartingTally|child_process/, `${f} has process control`);
  }
  const users = ["main.js", "util/ipcRegistry.js", "util/xml.js", "util/socket.js", "util/backgroundRunner.js"]
    .filter((f) => fs.existsSync(path.join(ROOT, f)) && /ensureBillOutstandingTdl/.test(read(f)));
  assert.deepEqual(users, ["util/ipcRegistry.js"], "only Settings IPC may load the restart-capable module");
  const ipc = read("util/ipcRegistry.js");
  const setupHandlers = ipc.match(/ipcMain\.handle\("tally:tdl_[a-z_]+"/g) || [];
  assert.deepEqual(setupHandlers.sort(), [
    'ipcMain.handle("tally:tdl_health"',
    'ipcMain.handle("tally:tdl_select_path"',
    'ipcMain.handle("tally:tdl_setup"',
  ]);
});

test("summary sent to the backend: only SUCCESS is a complete snapshot; tdlStatus travels separately", () => {
  const ok = snapshotSummary({ companyGuid: "g", status: "SUCCESS", snapshotComplete: true, rowCount: 3, tdlStatus: "HEALTH_UNCONFIRMED" });
  assert.equal(ok.snapshotComplete, true);
  assert.equal(ok.tdlStatus, "HEALTH_UNCONFIRMED");
  assert.equal(snapshotSummary({ companyGuid: "g", status: "TDL_NOT_LOADED", snapshotComplete: true, rowCount: 0 }).snapshotComplete, false);
  assert.equal(snapshotSummary({ companyGuid: "g", status: "LEGACY_EMPTY_AMBIGUOUS", snapshotComplete: false, rowCount: 0 }).snapshotComplete, false);
});

// ── Config ─────────────────────────────────────────────────────────────────

test("config schema keeps tallyInstallPath (saved Tally folder survives restart)", () => {
  const Ajv = require("ajv");
  const schema = require("../util/schema.json");
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const errorsFor = (cfg) => (validate(cfg) ? [] : validate.errors);
  const additional = (errs) => errs.filter((e) => e.keyword === "additionalProperties").map((e) => e.params.additionalProperty);
  assert.ok(!additional(errorsFor({ tallyInstallPath: "C:\\Program Files\\TallyPrime (1)" })).includes("tallyInstallPath"));
  assert.ok(errorsFor({ tallyInstallPath: "" }).some((e) => e.instancePath === "/tallyInstallPath"));
});

test("BACKEND_URL equal to the default dev backend is not reported as stale", () => {
  const { resolveBackendEnvironment, DEFAULT_DEV_BACKEND_URL } = require("../util/backendConfig");
  const same = resolveBackendEnvironment({ TD_BACKEND_ENV: "development", BACKEND_URL: DEFAULT_DEV_BACKEND_URL }, null, false);
  assert.equal(same.url, DEFAULT_DEV_BACKEND_URL);
  assert.deepEqual(same.warnings, []);
  const loop = resolveBackendEnvironment({ TD_BACKEND_ENV: "development", BACKEND_URL: "http://localhost:3001" }, null, false);
  assert.equal(loop.url, DEFAULT_DEV_BACKEND_URL);
  assert.equal(loop.warnings.length, 1);
});
