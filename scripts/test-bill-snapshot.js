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
const { TDL_STATUS, TDL_VERSION, classifyHealthResponse } = require("../util/tdlHealth");

const ROOT = path.join(__dirname, "..");

const healthXml = (company, version = TDL_VERSION) =>
  `<ENVELOPE><TDKSTATUS><ACTIVE>YES</ACTIVE><VERSION>${version}</VERSION>` +
  `<REPORT>TDKBillOutstandingWorking</REPORT><COMPANY>${company}</COMPANY></TDKSTATUS></ENVELOPE>`;
const MISSING = `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER>` +
  `<BODY><DATA><LINEERROR>Could not find Report 'X'!</LINEERROR></DATA></BODY></ENVELOPE>`;
const EMPTY = "<ENVELOPE></ENVELOPE>";
const billRow = (ledger, bill, pending) =>
  `<BILLROW><LedgerName>${ledger}</LedgerName><BillName>${bill}</BillName><BillDate>2026-04-10</BillDate>` +
  `<DueDate></DueDate><CreditPeriod></CreditPeriod><Amount>${pending}</Amount><PendingAmount>${pending}</PendingAmount>` +
  `<DrCr>Dr</DrCr><LedgerParent>${ledger}</LedgerParent></BILLROW>`;
const bills = (...rows) => `<ENVELOPE>${rows.join("")}</ENVELOPE>`;

/** Fake Tally: answers by report ID and SVCURRENTCOMPANY, records every request. */
function fakeTally(byCompany) {
  const calls = [];
  const post = async (xml) => {
    const report = /<ID>([^<]+)<\/ID>/.exec(xml)?.[1];
    const company = /<SVCURRENTCOMPANY>([^<]*)<\/SVCURRENTCOMPANY>/.exec(xml)?.[1] || "";
    calls.push({ report, company });
    const entry = byCompany[company] || {};
    const answer = report === "TDKBillOutstandingHealth" ? entry.health : entry.bills;
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer();
    return answer;
  };
  return { post, calls };
}

const snap = (companyName, post) =>
  fetchCompanyBillSnapshot({
    companyName,
    companyGuid: `guid-${companyName}`,
    fromDate: "20260401",
    toDate: "20270331",
    currentDate: "20261001",
    post,
    billAttempts: 1,
  });

test("1. health ACTIVE + bill rows → SUCCESS with every row", async () => {
  const { post } = fakeTally({ A: { health: healthXml("A"), bills: bills(billRow("L1", "B1", 100), billRow("L2", "B2", 50)) } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.SUCCESS);
  assert.equal(r.snapshotComplete, true);
  assert.equal(r.rowCount, 2);
  assert.equal(r.rows[0].BillName, "B1");
  assert.equal(r.tdlStatus, TDL_STATUS.ACTIVE);
});

test("2. health ACTIVE + empty envelope → SUCCESS with zero rows (backend clears)", async () => {
  const { post } = fakeTally({ A: { health: healthXml("A"), bills: EMPTY } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.SUCCESS);
  assert.equal(r.snapshotComplete, true);
  assert.equal(r.rowCount, 0);
});

test("3. legacy add-on (no health report) + bill rows → SUCCESS, ACTIVE_LEGACY", async () => {
  const { post } = fakeTally({ A: { health: MISSING, bills: bills(billRow("L1", "B1", 10)) } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.SUCCESS);
  assert.equal(r.snapshotComplete, true);
  assert.equal(r.tdlStatus, TDL_STATUS.ACTIVE_LEGACY);
});

test("4. legacy add-on + empty envelope → ambiguous, keep previous bills", async () => {
  const { post } = fakeTally({ A: { health: MISSING, bills: EMPTY } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.LEGACY_EMPTY_AMBIGUOUS);
  assert.equal(r.snapshotComplete, false);
  assert.equal(r.tdlStatus, TDL_STATUS.UNKNOWN);
});

test("5. no health report and no bill report → TDL_NOT_LOADED, keep previous bills", async () => {
  const { post } = fakeTally({ A: { health: MISSING, bills: MISSING } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.TDL_NOT_LOADED);
  assert.equal(r.snapshotComplete, false);
  assert.equal(r.tdlStatus, TDL_STATUS.NOT_LOADED);
});

test("6. Tally unreachable → TALLY_UNREACHABLE and the bill report is never requested", async () => {
  const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const { post, calls } = fakeTally({ A: { health: err, bills: bills(billRow("L", "B", 1)) } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.TALLY_UNREACHABLE);
  assert.equal(r.snapshotComplete, false);
  assert.deepEqual(calls.map((c) => c.report), ["TDKBillOutstandingHealth"]);
});

test("7. bill request timeout → TALLY_TIMEOUT, keep previous bills", async () => {
  const err = Object.assign(new Error("timeout of 60000ms exceeded"), { code: "ECONNABORTED" });
  const { post } = fakeTally({ A: { health: healthXml("A"), bills: err } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.TALLY_TIMEOUT);
  assert.equal(r.snapshotComplete, false);
});

test("8. unexpected bill response shape → INVALID_RESPONSE (never treated as zero bills)", async () => {
  const junk = "<ENVELOPE><HEADER><VERSION>1</VERSION></HEADER><BODY><DATA/></BODY></ENVELOPE>";
  const { post } = fakeTally({ A: { health: healthXml("A"), bills: junk } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.INVALID_RESPONSE);
  assert.equal(r.snapshotComplete, false);
});

test("9. BILLROW tags that do not all parse → PARSE_FAILED", () => {
  const r = classifyBillResponse(`<ENVELOPE>${billRow("L", "B", 1)}<BILLROW></BILLROW></ENVELOPE>`);
  assert.equal(r.kind, "PARSE_FAILED");
  assert.equal(r.tagCount, 2);
});

test("10. Tally answered for a different company → COMPANY_CONTEXT_MISMATCH, bills not fetched", async () => {
  const { post, calls } = fakeTally({ A: { health: healthXml("Other Co"), bills: EMPTY } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.COMPANY_CONTEXT_MISMATCH);
  assert.equal(r.snapshotComplete, false);
  assert.equal(calls.filter((c) => c.report === "TDKBillOutstandingWorking").length, 0);
});

test("11. company order has no effect on any company's result", async () => {
  const tally = {
    Zero: { health: healthXml("Zero"), bills: EMPTY },
    Many: { health: healthXml("Many"), bills: bills(billRow("L", "B1", 5), billRow("L", "B2", 6)) },
    Legacy: { health: MISSING, bills: EMPTY },
  };
  const run = async (order) => {
    const { post } = fakeTally(tally);
    const out = {};
    for (const name of order) {
      const r = await snap(name, post);
      out[name] = { status: r.status, complete: r.snapshotComplete, rows: r.rowCount };
    }
    return out;
  };
  const forward = await run(["Zero", "Many", "Legacy"]);
  const reverse = await run(["Legacy", "Many", "Zero"]);
  const shuffled = await run(["Many", "Legacy", "Zero"]);
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward, shuffled);
  assert.deepEqual(forward.Zero, { status: "SUCCESS", complete: true, rows: 0 });
  assert.deepEqual(forward.Many, { status: "SUCCESS", complete: true, rows: 2 });
  assert.deepEqual(forward.Legacy, { status: "LEGACY_EMPTY_AMBIGUOUS", complete: false, rows: 0 });
});

test("12. no sync path can reach the Tally restart", () => {
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

test("outdated health report version → ACTIVE_OUTDATED but bills still sync", async () => {
  const { post } = fakeTally({ A: { health: healthXml("A", "1.0.9"), bills: EMPTY } });
  const r = await snap("A", post);
  assert.equal(r.status, BILL_STATUS.SUCCESS);
  assert.equal(r.tdlStatus, TDL_STATUS.ACTIVE_OUTDATED);
});

test("TDL file declares the health report at the version the desktop expects", () => {
  const tdl = fs.readFileSync(path.join(ROOT, "xmls/TDKBillOutstanding.tdl"), "utf8");
  assert.match(tdl, /\[Report: TDKBillOutstandingHealth\]/);
  assert.match(tdl, /\[Report: TDKBillOutstandingWorking\]/);
  const version = /\[Field: TDKBOH Version\][\s\S]*?Set As\s*:\s*"([^"]+)"/.exec(tdl)?.[1];
  assert.equal(version, TDL_VERSION);
});

test("health classification: blank body and inactive flag are never ACTIVE", () => {
  assert.equal(classifyHealthResponse("").status, TDL_STATUS.INVALID_RESPONSE);
  assert.equal(classifyHealthResponse(EMPTY).status, TDL_STATUS.INVALID_RESPONSE);
  assert.equal(
    classifyHealthResponse("<ENVELOPE><TDKSTATUS><ACTIVE>NO</ACTIVE></TDKSTATUS></ENVELOPE>").status,
    TDL_STATUS.INVALID_RESPONSE
  );
});

test("summary sent to the backend: only SUCCESS is a complete snapshot", () => {
  assert.equal(snapshotSummary({ companyGuid: "g", status: "SUCCESS", snapshotComplete: true, rowCount: 0 }).snapshotComplete, true);
  assert.equal(snapshotSummary({ companyGuid: "g", status: "TDL_NOT_LOADED", snapshotComplete: true, rowCount: 0 }).snapshotComplete, false);
});
