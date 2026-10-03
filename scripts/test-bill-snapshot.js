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
  CONTEXT_STATUS,
  checkTdlHealth,
  classifyHealthResponse,
  classifyContextResponse,
  healthRequestXml,
  contextRequestXml,
} = require("../util/tdlHealth");
const { settingsTdlStatus } = require("../util/ensureBillOutstandingTdl");

const ROOT = path.join(__dirname, "..");

// Reply shapes as seen from TallyPrime 7.0 (field tags may come back re-cased).
const healthXml = (version = TDL_VERSION) =>
  `<ENVELOPE><TDKSTATUS><Active>YES</Active><Version>${version}</Version>` +
  `<REPORT>TDKBillOutstandingWorking</REPORT></TDKSTATUS></ENVELOPE>`;
const contextXml = (company, { version = TDL_VERSION, active = "YES" } = {}) =>
  `<ENVELOPE><TDKCONTEXT><Active>${active}</Active><Version>${version}</Version>` +
  `<Company>${company}</Company></TDKCONTEXT></ENVELOPE>`;
const lineError = (msg) =>
  `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER>` +
  `<BODY><DATA><LINEERROR>${msg}</LINEERROR></DATA></BODY></ENVELOPE>`;
const MISSING = lineError("Could not find Report 'X'!");
const notOpen = (company) => lineError(`Could not set &apos;SVCurrentCompany&apos; to &apos;${company}&apos;`);
const EMPTY = "<ENVELOPE></ENVELOPE>";
/** BILLROW; `company` undefined → row without a Company tag. */
const billRow = (ledger, bill, pending, company) =>
  `<BILLROW><LedgerName>${ledger}</LedgerName><BillName>${bill}</BillName><BillDate>2026-04-10</BillDate>` +
  `<DueDate></DueDate><CreditPeriod></CreditPeriod><Amount>${pending}</Amount><PendingAmount>${pending}</PendingAmount>` +
  `<DrCr>Dr</DrCr><LedgerParent>${ledger}</LedgerParent>` +
  (company === undefined ? "" : `<Company>${company}</Company>`) +
  `</BILLROW>`;
const bills = (...rows) => `<ENVELOPE>${rows.join("")}</ENVELOPE>`;

/**
 * Fake Tally: health is global; context and bill answers are per SVCURRENTCOMPANY.
 * companies[name] = { context, bills }. Records every request in order.
 */
function fakeTally({ health, companies = {}, delayMs = 0 }) {
  const calls = [];
  const post = async (xml) => {
    const report = /<ID>([^<]+)<\/ID>/.exec(xml)?.[1];
    const company = /<SVCURRENTCOMPANY>([^<]*)<\/SVCURRENTCOMPANY>/.exec(xml)?.[1] ?? null;
    calls.push({ report, company });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const c = companies[company] || {};
    const answer = report === "TDKBillOutstandingHealth" ? health
      : report === "TDKBillOutstandingContext" ? c.context
      : c.bills;
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

const reportsOf = (calls) => calls.map((c) => `${c.report.replace("TDKBillOutstanding", "")}:${c.company ?? "-"}`);
const billCalls = (calls) => calls.filter((c) => c.report === "TDKBillOutstandingWorking");

const YASH = "Yash Ki Company";

// ── Modern add-on: context VERIFIED ────────────────────────────────────────

test("context verified + >0 rows, every row Company matches → SUCCESS (replace)", async () => {
  const { post, calls } = fakeTally({
    health: healthXml(),
    companies: { [YASH]: { context: contextXml(YASH), bills: bills(billRow("L1", "B1", 100, YASH), billRow("L2", "B2", 50, YASH)) } },
  });
  const r = await snap(YASH, post);
  assert.equal(r.status, BILL_STATUS.SUCCESS);
  assert.equal(r.snapshotComplete, true);
  assert.equal(r.rowCount, 2);
  assert.equal(r.rows[0].BillName, "B1");
  assert.equal(r.tdlStatus, TDL_STATUS.ACTIVE);
  assert.equal(r.authority, "CONTEXT");
  assert.equal(r.contextStatus, CONTEXT_STATUS.VERIFIED);
  assert.equal(r.contextCompany, YASH);
  assert.deepEqual(reportsOf(calls), ["Health:-", `Context:${YASH}`, `Working:${YASH}`]);
});

test("context verified + 0 rows → SUCCESS, snapshotComplete (verified zero clears old bills)", async () => {
  const { post } = fakeTally({ health: healthXml(), companies: { Laveena: { context: contextXml("Laveena"), bills: EMPTY } } });
  const r = await snap("Laveena", post);
  assert.equal(r.status, BILL_STATUS.SUCCESS);
  assert.equal(r.snapshotComplete, true);
  assert.equal(r.rowCount, 0);
  assert.equal(r.authority, "CONTEXT");
  assert.equal(snapshotSummary(r).snapshotComplete, true);
});

test("one mismatched row invalidates the whole snapshot (no partial accept)", async () => {
  const { post } = fakeTally({
    health: healthXml(),
    companies: { A: { context: contextXml("A"), bills: bills(billRow("L", "B1", 1, "A"), billRow("L", "B2", 2, "Other Co")) } },
  });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.COMPANY_CONTEXT_MISMATCH);
  assert.equal(r.snapshotComplete, false);
  assert.equal(r.rowCount, 0);
  assert.deepEqual(r.rows, []);
});

test("a row without a Company tag invalidates the snapshot → COMPANY_UNVERIFIED", async () => {
  const { post } = fakeTally({
    health: healthXml(),
    companies: { A: { context: contextXml("A"), bills: bills(billRow("L", "B1", 1, "A"), billRow("L", "B2", 2)) } },
  });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.COMPANY_UNVERIFIED);
  assert.equal(r.snapshotComplete, false);
});

test("company names compare case/space-insensitively", async () => {
  const { post } = fakeTally({
    health: healthXml(),
    companies: { [YASH]: { context: contextXml("yash  ki company"), bills: bills(billRow("L", "B", 1, "YASH KI COMPANY")) } },
  });
  const r = await snap(YASH, post);
  assert.equal(r.status, BILL_STATUS.SUCCESS);
});

// ── Context not verified → preserve, bills never requested ─────────────────

for (const [label, context, expected] of [
  ["context names another company", contextXml(YASH), BILL_STATUS.COMPANY_CONTEXT_MISMATCH],
  ["context company blank", contextXml(""), BILL_STATUS.COMPANY_UNVERIFIED],
  ["context ACTIVE not YES", contextXml("Laveena", { active: "NO" }), BILL_STATUS.COMPANY_UNVERIFIED],
  ["context empty envelope", EMPTY, BILL_STATUS.COMPANY_UNVERIFIED],
  ["context unexpected shape", "<ENVELOPE><X/></ENVELOPE>", BILL_STATUS.COMPANY_UNVERIFIED],
  ["Could not set SVCurrentCompany (company closed)", notOpen("Laveena"), BILL_STATUS.COMPANY_NOT_OPEN],
]) {
  test(`${label} → ${expected}, preserve, bill request skipped`, async () => {
    const { post, calls } = fakeTally({ health: healthXml(), companies: { Laveena: { context, bills: EMPTY } } });
    const r = await snap("Laveena", post);
    assert.equal(r.status, expected);
    assert.equal(r.snapshotComplete, false);
    assert.equal(billCalls(calls).length, 0);
    assert.equal(snapshotSummary(r).snapshotComplete, false);
  });
}

test("context request timeout → TALLY_TIMEOUT, preserve", async () => {
  const err = Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED" });
  const { post, calls } = fakeTally({ health: healthXml(), companies: { A: { context: err, bills: EMPTY } } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.TALLY_TIMEOUT);
  assert.equal(r.snapshotComplete, false);
  assert.equal(billCalls(calls).length, 0);
});

test("company closed between Context and Bills → COMPANY_NOT_OPEN, preserve", async () => {
  const { post } = fakeTally({ health: healthXml(), companies: { A: { context: contextXml("A"), bills: notOpen("A") } } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.COMPANY_NOT_OPEN);
  assert.equal(r.snapshotComplete, false);
});

test("bill parser failure → PARSE_FAILED, preserve", async () => {
  const { post } = fakeTally({
    health: healthXml(),
    companies: { A: { context: contextXml("A"), bills: bills(billRow("L", "B", 1, "A"), "<BILLROW></BILLROW>") } },
  });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.PARSE_FAILED);
  assert.equal(r.snapshotComplete, false);
});

test("bill request timeout → TALLY_TIMEOUT, preserve", async () => {
  const err = Object.assign(new Error("timeout of 60000ms exceeded"), { code: "ECONNABORTED" });
  const { post } = fakeTally({ health: healthXml(), companies: { A: { context: contextXml("A"), bills: err } } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.TALLY_TIMEOUT);
  assert.equal(r.snapshotComplete, false);
});

test("unexpected bill shape → INVALID_RESPONSE (never treated as zero bills)", async () => {
  const junk = "<ENVELOPE><HEADER><VERSION>1</VERSION></HEADER><BODY><DATA/></BODY></ENVELOPE>";
  const { post } = fakeTally({ health: healthXml(), companies: { A: { context: contextXml("A"), bills: junk } } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.INVALID_RESPONSE);
  assert.equal(r.snapshotComplete, false);
});

// ── Context is snapshot authority; Settings follows global health ──────────

test("health unconfirmed + context verified + 0 rows → SUCCESS (authority CONTEXT), Settings not Ready", async () => {
  const { post } = fakeTally({ health: EMPTY, companies: { Laveena: { context: contextXml("Laveena"), bills: EMPTY } } });
  const r = await snap("Laveena", post);
  assert.equal(r.status, BILL_STATUS.SUCCESS);
  assert.equal(r.snapshotComplete, true);
  assert.equal(r.authority, "CONTEXT");
  assert.equal(r.tdlStatus, TDL_STATUS.HEALTH_UNCONFIRMED, "tdlStatus keeps the health state");
  assert.equal(settingsTdlStatus(r), TDL_STATUS.HEALTH_UNCONFIRMED);
  assert.notEqual(settingsTdlStatus(r), TDL_STATUS.ACTIVE);
});

test("Settings status: ACTIVE only from global health", async () => {
  const ok = await snap("A", fakeTally({ health: healthXml(), companies: { A: { context: contextXml("A"), bills: EMPTY } } }).post);
  assert.equal(settingsTdlStatus(ok), TDL_STATUS.ACTIVE);
  const old = await snap("A", fakeTally({ health: healthXml("1.1.0"), companies: { A: { context: contextXml("A"), bills: EMPTY } } }).post);
  assert.equal(settingsTdlStatus(old), TDL_STATUS.ACTIVE_OUTDATED);
  const legacy = await snap("A", fakeTally({ health: MISSING, companies: { A: { context: MISSING, bills: bills(billRow("L", "B", 1, "A")) } } }).post);
  assert.equal(settingsTdlStatus(legacy), TDL_STATUS.ACTIVE_LEGACY);
  const none = await snap("A", fakeTally({ health: MISSING, companies: { A: { context: MISSING, bills: MISSING } } }).post);
  assert.equal(settingsTdlStatus(none), TDL_STATUS.NOT_LOADED);
});

// ── Legacy add-on (no context report) / outdated context ───────────────────

test("legacy (context report missing) + rows with matching company → SUCCESS, ACTIVE_LEGACY", async () => {
  const { post } = fakeTally({ health: MISSING, companies: { A: { context: MISSING, bills: bills(billRow("L1", "B1", 10, "A")) } } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.SUCCESS);
  assert.equal(r.snapshotComplete, true);
  assert.equal(r.tdlStatus, TDL_STATUS.ACTIVE_LEGACY);
  assert.equal(r.authority, "ROWS");
});

test("legacy + 0 rows → LEGACY_EMPTY_AMBIGUOUS, preserve", async () => {
  const { post } = fakeTally({ health: MISSING, companies: { A: { context: MISSING, bills: EMPTY } } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.LEGACY_EMPTY_AMBIGUOUS);
  assert.equal(r.snapshotComplete, false);
});

test("legacy + rows without company → COMPANY_UNVERIFIED; another company → MISMATCH", async () => {
  const noCo = await snap("A", fakeTally({ health: MISSING, companies: { A: { context: MISSING, bills: bills(billRow("L", "B", 1)) } } }).post);
  assert.equal(noCo.status, BILL_STATUS.COMPANY_UNVERIFIED);
  const other = await snap("A", fakeTally({ health: MISSING, companies: { A: { context: MISSING, bills: bills(billRow("L", "B", 1, "B")) } } }).post);
  assert.equal(other.status, BILL_STATUS.COMPANY_CONTEXT_MISMATCH);
});

test("no add-on at all (context and bill reports missing) → TDL_NOT_LOADED, preserve", async () => {
  const { post } = fakeTally({ health: MISSING, companies: { A: { context: MISSING, bills: MISSING } } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.TDL_NOT_LOADED);
  assert.equal(r.snapshotComplete, false);
  assert.equal(r.tdlStatus, TDL_STATUS.NOT_LOADED);
});

test("context from another add-on version: rows follow legacy rule, zero is ambiguous", async () => {
  const rows = await snap("A", fakeTally({ health: EMPTY, companies: { A: { context: contextXml("A", { version: "9.9.9" }), bills: bills(billRow("L", "B", 1, "A")) } } }).post);
  assert.equal(rows.status, BILL_STATUS.SUCCESS);
  assert.equal(rows.tdlStatus, TDL_STATUS.HEALTH_UNCONFIRMED, "tdlStatus keeps the health state");
  const oldHealth = await snap("A", fakeTally({ health: healthXml("1.1.2"), companies: { A: { context: MISSING, bills: bills(billRow("L", "B", 1, "A")) } } }).post);
  assert.equal(oldHealth.status, BILL_STATUS.SUCCESS);
  assert.equal(oldHealth.tdlStatus, TDL_STATUS.ACTIVE_OUTDATED);
  const zero = await snap("A", fakeTally({ health: EMPTY, companies: { A: { context: contextXml("A", { version: "9.9.9" }), bills: EMPTY } } }).post);
  assert.equal(zero.status, BILL_STATUS.LEGACY_EMPTY_AMBIGUOUS);
  assert.equal(zero.snapshotComplete, false);
});

test("Tally unreachable at health → nothing per-company is requested", async () => {
  const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const { post, calls } = fakeTally({ health: err, companies: { A: { context: contextXml("A"), bills: EMPTY } } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.TALLY_UNREACHABLE);
  assert.equal(r.snapshotComplete, false);
  assert.deepEqual(reportsOf(calls), ["Health:-"]);
});

// ── Order and serialization ────────────────────────────────────────────────

test("sync run: health once, then Context → Bills per company in order", async () => {
  const { post, calls } = fakeTally({
    health: healthXml(),
    companies: {
      [YASH]: { context: contextXml(YASH), bills: bills(billRow("L", "B1", 5, YASH)) },
      Laveena: { context: contextXml("Laveena"), bills: EMPTY },
      "Radhe Ram": { context: notOpen("Radhe Ram"), bills: EMPTY },
    },
  });
  const health = await checkTdlHealth({ post });
  const results = {};
  for (const name of [YASH, "Laveena", "Radhe Ram"]) results[name] = await snap(name, post, { health });
  assert.deepEqual(reportsOf(calls), [
    "Health:-",
    `Context:${YASH}`, `Working:${YASH}`,
    "Context:Laveena", "Working:Laveena",
    "Context:Radhe Ram",
  ]);
  assert.deepEqual(Object.values(results).map((r) => [r.status, r.snapshotComplete, r.rowCount]), [
    ["SUCCESS", true, 1],
    ["SUCCESS", true, 0],
    ["COMPANY_NOT_OPEN", false, 0],
  ]);
});

test("concurrent snapshots (sync + Settings) never interleave one company's Context and Bills", async () => {
  const { post, calls } = fakeTally({
    delayMs: 5,
    health: healthXml(),
    companies: {
      A: { context: contextXml("A"), bills: bills(billRow("L", "B", 1, "A")) },
      B: { context: contextXml("B"), bills: EMPTY },
    },
  });
  const health = await checkTdlHealth({ post });
  calls.length = 0;
  const [a, b] = await Promise.all([snap("A", post, { health }), snap("B", post, { health })]);
  assert.deepEqual(reportsOf(calls), ["Context:A", "Working:A", "Context:B", "Working:B"]);
  assert.equal(a.status, "SUCCESS");
  assert.equal(b.status, "SUCCESS");
});

test("company order has no effect on any company's result", async () => {
  const tally = {
    health: healthXml(),
    companies: {
      Zero: { context: contextXml("Zero"), bills: EMPTY },
      Many: { context: contextXml("Many"), bills: bills(billRow("L", "B1", 5, "Many"), billRow("L", "B2", 6, "Many")) },
      Closed: { context: notOpen("Closed"), bills: EMPTY },
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
  const forward = await run(["Zero", "Many", "Closed"]);
  assert.deepEqual(forward, await run(["Closed", "Many", "Zero"]));
  assert.deepEqual(forward.Zero, { status: "SUCCESS", complete: true, rows: 0 });
  assert.deepEqual(forward.Many, { status: "SUCCESS", complete: true, rows: 2 });
  assert.deepEqual(forward.Closed, { status: "COMPANY_NOT_OPEN", complete: false, rows: 0 });
});

// ── Requests / classifiers ─────────────────────────────────────────────────

test("health request has no company; context request carries company and period like the bill request", () => {
  assert.doesNotMatch(healthRequestXml(), /SVCURRENTCOMPANY/);
  const ctx = contextRequestXml({ companyName: "Shah & Sons", fromDate: "20260401", toDate: "20270331", currentDate: "20261001" });
  assert.match(ctx, /<ID>TDKBillOutstandingContext<\/ID>/);
  assert.match(ctx, /<TALLYREQUEST>Export<\/TALLYREQUEST>/);
  assert.match(ctx, /<TYPE>Data<\/TYPE>/);
  assert.match(ctx, /<SVCURRENTCOMPANY>Shah &amp; Sons<\/SVCURRENTCOMPANY>/);
  assert.match(ctx, /<SVFROMDATE TYPE="Date">20260401<\/SVFROMDATE>/);
});

test("health classification (1.1.3, re-cased tags, empty, missing)", () => {
  const active = classifyHealthResponse(healthXml());
  assert.equal(active.status, TDL_STATUS.ACTIVE);
  assert.equal(active.version, "1.1.3");
  assert.equal(active.report, "TDKBillOutstandingWorking");
  assert.equal(classifyHealthResponse(healthXml("1.1.2")).status, TDL_STATUS.ACTIVE_OUTDATED);
  const empty = classifyHealthResponse(EMPTY);
  assert.equal(empty.status, TDL_STATUS.HEALTH_UNCONFIRMED);
  assert.equal(empty.reason, "empty_envelope");
  assert.equal(classifyHealthResponse("<ENVELOPE><TDKSTATUS><ACTIVE>NO</ACTIVE></TDKSTATUS></ENVELOPE>").status, TDL_STATUS.HEALTH_UNCONFIRMED);
  assert.equal(classifyHealthResponse("").status, TDL_STATUS.INVALID_RESPONSE);
  assert.equal(classifyHealthResponse(MISSING).status, TDL_STATUS.HEALTH_MISSING);
});

test("context classification", () => {
  const ok = classifyContextResponse(contextXml("Laveena"), "Laveena");
  assert.deepEqual([ok.status, ok.active, ok.version, ok.company], [CONTEXT_STATUS.VERIFIED, true, TDL_VERSION, "Laveena"]);
  const upper = "<ENVELOPE><TDKCONTEXT><ACTIVE>YES</ACTIVE><VERSION>1.1.3</VERSION><COMPANY>Laveena</COMPANY></TDKCONTEXT></ENVELOPE>";
  assert.equal(classifyContextResponse(upper, "laveena").status, CONTEXT_STATUS.VERIFIED);
  assert.equal(classifyContextResponse(contextXml("Laveena"), YASH).status, CONTEXT_STATUS.MISMATCH);
  assert.equal(classifyContextResponse(contextXml("Laveena"), "").status, CONTEXT_STATUS.MISMATCH);
  assert.equal(classifyContextResponse(contextXml("Laveena", { version: "1.1.2" }), "Laveena").status, CONTEXT_STATUS.OUTDATED);
  assert.equal(classifyContextResponse(notOpen("Radhe Ram"), "Radhe Ram").status, CONTEXT_STATUS.COMPANY_NOT_OPEN);
  assert.equal(classifyContextResponse(lineError("Could not set 'SVCurrentCompany' to 'X'"), "X").status, CONTEXT_STATUS.COMPANY_NOT_OPEN);
  assert.equal(classifyContextResponse(MISSING, "A").status, CONTEXT_STATUS.REPORT_MISSING);
  assert.equal(classifyContextResponse(EMPTY, "A").status, CONTEXT_STATUS.EMPTY);
  assert.equal(classifyContextResponse("", "A").status, CONTEXT_STATUS.INVALID);
});

test("bill classification: rows with Company, empty, not open, missing, parse failure", () => {
  const r = classifyBillResponse(bills(billRow("L", "B1", 1, YASH)));
  assert.equal(r.kind, "ROWS");
  assert.deepEqual(r.rowCompanies, [YASH]);
  assert.equal(classifyBillResponse(EMPTY).kind, "EMPTY");
  assert.equal(classifyBillResponse(notOpen("X")).kind, "COMPANY_NOT_OPEN");
  assert.equal(classifyBillResponse(MISSING).kind, "REPORT_MISSING");
  const bad = classifyBillResponse(bills(billRow("L", "B", 1, "A"), "<BILLROW></BILLROW>"));
  assert.equal(bad.kind, "PARSE_FAILED");
  assert.equal(bad.tagCount, 2);
});

// ── TDL file ───────────────────────────────────────────────────────────────

const sectionOf = (tdl, header) => {
  const start = tdl.indexOf(header);
  if (start < 0) return "";
  const next = tdl.indexOf("\n[", start + header.length);
  return tdl.slice(start, next < 0 ? undefined : next);
};

const productionTdl = () => {
  const tdl = fs.readFileSync(path.join(ROOT, "xmls/TDKBillOutstanding.tdl"), "utf8");
  const probe = tdl.indexOf(";; ===== TEMPORARY DIAGNOSTIC PROBES — BEGIN");
  return probe < 0 ? tdl : tdl.slice(0, probe);
};

test("TDL 1.1.3: health and context are one fixed scrolling line each; bill report has one scrolling part", () => {
  const tdl = productionTdl();
  for (const field of ["TDKBOH Version", "TDKBOC Version"]) {
    const v = new RegExp(`\\[Field: ${field}\\][\\s\\S]*?Set As\\s*:\\s*"([^"]+)"`).exec(tdl)?.[1];
    assert.equal(v, TDL_VERSION, field);
  }

  const healthPart = sectionOf(tdl, "[Part: TDKBOH Body]");
  assert.match(healthPart, /Lines\s*:\s*TDKBOH Line\s*$/m);
  assert.match(healthPart, /Scroll\s*:\s*Vertical/);
  assert.doesNotMatch(healthPart, /Repeat/);
  const healthSections = ["[Report: TDKBillOutstandingHealth]", "[Part: TDKBOH Body]", "[Line: TDKBOH Line]"]
    .map((h) => sectionOf(tdl, h)).join("\n");
  assert.doesNotMatch(healthSections, /SVCurrentCompany/i, "health must not depend on company");
  assert.match(sectionOf(tdl, "[Line: TDKBOH Line]"), /XML Tag\s*:\s*TDKSTATUS/);

  assert.match(sectionOf(tdl, "[Report: TDKBillOutstandingContext]"), /Form\s*:\s*TDKBOC Form/);
  const ctxPart = sectionOf(tdl, "[Part: TDKBOC Body]");
  assert.match(ctxPart, /Lines\s*:\s*TDKBOC Line\s*$/m);
  assert.match(ctxPart, /Scroll\s*:\s*Vertical/);
  assert.doesNotMatch(ctxPart, /Repeat/);
  const ctxLine = sectionOf(tdl, "[Line: TDKBOC Line]");
  assert.match(ctxLine, /Fields\s*:\s*TDKBOC Active,\s*TDKBOC Version,\s*TDKBOC Company/);
  assert.match(ctxLine, /XML Tag\s*:\s*TDKCONTEXT/);
  assert.match(sectionOf(tdl, "[Field: TDKBOC Active]"), /Set As\s*:\s*"YES"/);
  assert.match(sectionOf(tdl, "[Field: TDKBOC Company]"), /Set As\s*:\s*\$Name:Company:##SVCurrentCompany/);

  assert.match(sectionOf(tdl, "[Form: TDKBO Form]"), /Parts\s*:\s*TDKBO Body\s*$/m);
  const billPart = sectionOf(tdl, "[Part: TDKBO Body]");
  assert.match(billPart, /Lines\s*:\s*TDKBO Line\s*$/m);
  assert.match(billPart, /Repeat\s*:\s*TDKBO Line\s*:\s*TDKBO Bills/);
  assert.match(billPart, /Scroll\s*:\s*Vertical/);
  assert.match(sectionOf(tdl, "[Line: TDKBO Line]"), /TDKBO Company/);

  // HTTP export prints only scrolling parts, and drops a fixed line that shares a part with a repeated one.
  for (const m of tdl.matchAll(/^\[Part:\s*([^\]]+)\]/gm)) {
    const part = sectionOf(tdl, m[0]);
    assert.match(part, /Scroll\s*:\s*Vertical/, `${m[1]} must scroll`);
    const lines = /Lines\s*:\s*(.+)$/m.exec(part)[1].split(",");
    assert.equal(lines.length, 1, `${m[1]} must have exactly one line`);
  }
  assert.doesNotMatch(tdl, /^\s*Set\s*:\s*\d/m);
  assert.doesNotMatch(tdl, /TDKBO Context|LoadedCompanies|CurrentCompany\]|IsRequestedCompany/);

  const full = fs.readFileSync(path.join(ROOT, "xmls/TDKBillOutstanding.tdl"), "utf8");
  const defined = new Set([...full.matchAll(/^\[(?:Part|Line|Field|Collection):\s*([^\]]+)\]/gm)].map((m) => m[1].trim()));
  for (const m of full.matchAll(/^\s*(?:Parts|Lines|Fields)\s*:\s*(.+)$/gm)) {
    for (const name of m[1].split(",").map((s) => s.trim())) assert.ok(defined.has(name), `undefined: ${name}`);
  }
  for (const m of full.matchAll(/^\s*Repeat\s*:\s*([^:]+?)\s*:\s*(.+?)\s*$/gm)) {
    assert.ok(defined.has(m[1]), `undefined line: ${m[1]}`);
    assert.ok(defined.has(m[2]), `undefined collection: ${m[2]}`);
  }
});

test("temporary TDKProbe block is isolated and unused by the app", () => {
  const tdl = fs.readFileSync(path.join(ROOT, "xmls/TDKBillOutstanding.tdl"), "utf8");
  const begin = tdl.indexOf(";; ===== TEMPORARY DIAGNOSTIC PROBES — BEGIN");
  const end = tdl.indexOf(";; ===== TEMPORARY DIAGNOSTIC PROBES — END");
  if (begin < 0 && end < 0) return;
  assert.ok(begin >= 0 && end > begin, "probe block must have BEGIN and END markers");
  const outside = tdl.slice(0, begin) + tdl.slice(end);
  assert.doesNotMatch(outside, /TDKProbe/, "probe objects must live inside the marked block");
  for (const f of ["main.js", "util/xml.js", "util/tdlHealth.js", "util/billSnapshot.js", "util/ensureBillOutstandingTdl.js"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), "utf8"), /TDKProbe/, `${f} must not call probe reports`);
  }
});

// ── Lifecycle guard ────────────────────────────────────────────────────────

test("no sync path can reach the Tally restart", () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
  for (const f of ["util/xml.js", "util/tdlHealth.js", "util/billSnapshot.js", "util/tdlFiles.js", "util/tallyQueue.js"]) {
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
  const ok = snapshotSummary({ companyGuid: "g", status: "SUCCESS", snapshotComplete: true, rowCount: 3, tdlStatus: "HEALTH_UNCONFIRMED", authority: "CONTEXT" });
  assert.deepEqual(Object.keys(ok).sort(), ["companyGuid", "rowCount", "snapshotComplete", "status", "tdlStatus", "tdlVersion"]);
  assert.equal(ok.snapshotComplete, true);
  assert.equal(ok.tdlStatus, "HEALTH_UNCONFIRMED");
  assert.equal(snapshotSummary({ companyGuid: "g", status: "TDL_NOT_LOADED", snapshotComplete: true, rowCount: 0 }).snapshotComplete, false);
  assert.equal(snapshotSummary({ companyGuid: "g", status: "COMPANY_NOT_OPEN", snapshotComplete: false, rowCount: 0 }).snapshotComplete, false);
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
