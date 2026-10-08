/**
 * Per-company Bill Outstanding snapshot from Tally.
 *
 * Global health runs once per sync (Settings "Ready" comes from it). Each
 * company then gets, as one serialized unit, a Context request
 * (TDKBillOutstandingContext: ACTIVE, VERSION, COMPANY) and a Bill request.
 * A VERIFIED context proves add-on, version and company for that company, so
 * its bill answer is authoritative — including zero bills — even when global
 * health is unconfirmed. The backend replaces a company's bills only when
 * status is SUCCESS and snapshotComplete is true; every other status keeps the
 * previous bills.
 */
const { createTallyParser } = require("./tallyXmlParser");
const { xmlText, runCompanyExclusive } = require("./tallyQueue");
const { info } = require("./logger");
const {
  TDL_STATUS,
  CONTEXT_STATUS,
  checkTdlHealth,
  contextRequestXml,
  classifyContextResponse,
  classifyTransportError,
  looksLikeCompanyNotOpen,
  looksLikeMissingReport,
  normaliseCompany,
  isActiveHealth,
  isUnconfirmedHealth,
  postToTally,
} = require("./tdlHealth");

const BILL_REPORT_ID = "TDKBillOutstandingWorking";

const BILL_STATUS = Object.freeze({
  SUCCESS: "SUCCESS",
  TDL_NOT_LOADED: "TDL_NOT_LOADED",
  // Add-on without the context report returned no rows: zero bills and "not
  // answered for this company" look the same, so nothing can be concluded.
  LEGACY_EMPTY_AMBIGUOUS: "LEGACY_EMPTY_AMBIGUOUS",
  COMPANY_CONTEXT_MISMATCH: "COMPANY_CONTEXT_MISMATCH",
  // Context or rows did not prove the company (blank / empty / unreadable context, row without Company).
  COMPANY_UNVERIFIED: "COMPANY_UNVERIFIED",
  // Tally refused SVCURRENTCOMPANY ("Could not set 'SVCurrentCompany'").
  COMPANY_NOT_OPEN: "COMPANY_NOT_OPEN",
  TALLY_UNREACHABLE: "TALLY_UNREACHABLE",
  TALLY_TIMEOUT: "TALLY_TIMEOUT",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  PARSE_FAILED: "PARSE_FAILED",
  UNKNOWN: "UNKNOWN",
});

const parser = createTallyParser();

/**
 * Dr/Cr of an outstanding bill. Tally XML amounts are negative for Dr, but the
 * current TDL exports PendingAmount unsigned, so the sign is only trusted from
 * SignedPending. Then the TDL DrCr label, then the ledger's group.
 */
function billSideOf(r) {
  const signed = r.SignedPending ?? r.SIGNEDPENDING;
  if (signed != null && signed !== "") {
    const n = parseFloat(String(signed).replace(/,/g, "").replace("(-)", "-"));
    if (Number.isFinite(n) && Math.abs(n) >= 0.005) return n < 0 ? "Dr" : "Cr";
  }
  const label = String(r.DrCr ?? r.DRCR ?? "").trim().toLowerCase();
  if (label === "dr") return "Dr";
  if (label === "cr") return "Cr";
  const group = String(r.LedgerGroup ?? r.LEDGERGROUP ?? "").toLowerCase();
  if (group.includes("debtor")) return "Dr";
  if (group.includes("creditor")) return "Cr";
  return null;
}

/** BILLROW nested objects from TDKBillOutstandingWorking — not parallel field arrays. */
function rowsFromBillOutstandingEnvelope(envelope) {
  if (!envelope) return [];
  const raw = envelope.BILLROW ?? envelope.BillRow;
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      LedgerName: String(r.LedgerName ?? r.LEDGERNAME ?? ""),
      BillName: String(r.BillName ?? r.BILLNAME ?? ""),
      BillDate: r.BillDate ?? r.BILLDATE ?? null,
      DueDate: r.DueDate ?? r.DUEDATE ?? null,
      Amount: r.Amount ?? r.AMOUNT ?? 0,
      PendingAmount: r.PendingAmount ?? r.PENDINGAMOUNT ?? 0,
      DrCr: billSideOf(r) ?? r.DrCr ?? r.DRCR ?? null,
      BillType: r.BillType ?? r.BILLTYPE ?? billSideOf(r) ?? r.DrCr ?? r.DRCR ?? null,
      SignedPending: r.SignedPending ?? r.SIGNEDPENDING ?? null,
      LedgerGroup: String(r.LedgerGroup ?? r.LEDGERGROUP ?? ""),
      CreditPeriod: r.CreditPeriod ?? r.CREDITPERIOD ?? null,
      LedgerParent: String(r.LedgerParent ?? r.LEDGERPARENT ?? ""),
      VoucherGuid: r.VoucherGuid ?? r.VOUCHERGUID ?? null,
      AlterId: r.AlterId ?? r.ALTERID ?? 0,
    }));
}

function billRequestXml({ companyName, fromDate, toDate, currentDate }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>${BILL_REPORT_ID}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${xmlText(companyName)}</SVCURRENTCOMPANY>
        <SVCURRENTDATE TYPE="Date">${xmlText(currentDate)}</SVCURRENTDATE>
        <SVFROMDATE TYPE="Date">${xmlText(fromDate)}</SVFROMDATE>
        <SVTODATE TYPE="Date">${xmlText(toDate)}</SVTODATE>
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

const EMPTY_ENVELOPE = /^\s*(<\?xml[^>]*\?>)?\s*(<ENVELOPE\s*\/>|<ENVELOPE\s*>\s*<\/ENVELOPE\s*>)\s*$/i;

function textOf(value) {
  const v = value && typeof value === "object" ? value.value : value;
  return v == null ? "" : String(v).trim();
}

/** Case-insensitive field of a parsed BILLROW (Tally may re-case field tags). */
function fieldOf(row, name) {
  const key = Object.keys(row).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : row[key];
}

function rawRowsOf(envelope) {
  const raw = envelope?.BILLROW ?? envelope?.BillRow;
  if (raw == null) return [];
  return (Array.isArray(raw) ? raw : [raw]).filter((r) => r && typeof r === "object");
}

/**
 * Classify the bill report response. Pure.
 * kind: ROWS | EMPTY | COMPANY_NOT_OPEN | REPORT_MISSING | PARSE_FAILED | INVALID
 * rowCompanies: Company tag per row ("" when absent).
 */
function classifyBillResponse(text) {
  const body = String(text ?? "");
  if (!body.trim()) return { kind: "INVALID", reason: "empty_body" };

  const tagCount = (body.match(/<BILLROW[\s>]/gi) || []).length;
  if (tagCount > 0) {
    let envelope;
    try {
      const json = parser.parse(body);
      envelope = json.ENVELOPE || json.Envelope || {};
    } catch (e) {
      return { kind: "PARSE_FAILED", reason: e?.message || "parse_error", tagCount };
    }
    const raw = rawRowsOf(envelope);
    const rows = rowsFromBillOutstandingEnvelope(envelope);
    if (rows.length !== tagCount || raw.length !== tagCount) {
      return { kind: "PARSE_FAILED", reason: "row_count_mismatch", tagCount, parsed: rows.length };
    }
    return { kind: "ROWS", rows, rowCompanies: raw.map((r) => textOf(fieldOf(r, "COMPANY"))) };
  }

  if (looksLikeCompanyNotOpen(body)) return { kind: "COMPANY_NOT_OPEN" };
  if (looksLikeMissingReport(body)) return { kind: "REPORT_MISSING" };
  if (EMPTY_ENVELOPE.test(body)) return { kind: "EMPTY", rowCompanies: [] };
  return { kind: "INVALID", reason: "unexpected_shape" };
}

/**
 * Every row must name `requestedCompany`. Pure.
 * mismatch: some row names another company. unverified: some row has no company.
 */
function verifyRowCompanies(requestedCompany, rowCompanies) {
  const want = normaliseCompany(requestedCompany);
  const cos = (rowCompanies || []).map(normaliseCompany);
  const mismatch = cos.some((c) => c && c !== want);
  const unverified = !want || cos.some((c) => !c);
  return { mismatch, unverified, ok: cos.length > 0 && !mismatch && !unverified };
}

function failure(status, extra = {}) {
  return { status, snapshotComplete: false, rows: [], rowCount: 0, ...extra };
}

/** ACTIVE | UNCONFIRMED | LEGACY | DOWN — global health only decides whether Tally is worth asking. */
function healthClass(status) {
  if (isActiveHealth(status)) return "ACTIVE";
  if (isUnconfirmedHealth(status)) return "UNCONFIRMED";
  if (status === TDL_STATUS.HEALTH_MISSING) return "LEGACY";
  return "DOWN";
}

function transportFailure(errorStatus, extra) {
  return failure(errorStatus === TDL_STATUS.TALLY_TIMEOUT ? BILL_STATUS.TALLY_TIMEOUT : BILL_STATUS.TALLY_UNREACHABLE, extra);
}

/** Bill outcome that is not ROWS/EMPTY → failure (shared by modern and legacy paths). */
function billFailure(bill, tdlStatus) {
  switch (bill.kind) {
    case "COMPANY_NOT_OPEN":
      return failure(BILL_STATUS.COMPANY_NOT_OPEN, { tdlStatus, reason: "company_not_open" });
    case "REPORT_MISSING":
      return failure(BILL_STATUS.TDL_NOT_LOADED, { tdlStatus: TDL_STATUS.NOT_LOADED, reason: "bill_report_missing" });
    case "PARSE_FAILED":
      return failure(BILL_STATUS.PARSE_FAILED, { tdlStatus, reason: bill.reason });
    case "ERROR":
      return transportFailure(bill.errorStatus, { tdlStatus, reason: bill.reason });
    default:
      return failure(BILL_STATUS.INVALID_RESPONSE, { tdlStatus, reason: bill.reason || "unexpected_bill_response" });
  }
}

function rowsResult(bill, requestedCompany, tdlStatus, authority) {
  const id = verifyRowCompanies(requestedCompany, bill.rowCompanies);
  if (id.mismatch) {
    return failure(BILL_STATUS.COMPANY_CONTEXT_MISMATCH, { tdlStatus, reason: "row_from_another_company" });
  }
  if (!id.ok) return failure(BILL_STATUS.COMPANY_UNVERIFIED, { tdlStatus, reason: "row_without_company" });
  return { status: BILL_STATUS.SUCCESS, snapshotComplete: true, rows: bill.rows, rowCount: bill.rows.length, tdlStatus, authority };
}

/**
 * Decide one company's snapshot. Pure. Only SUCCESS (snapshotComplete) lets the
 * backend replace/clear bills; everything else preserves the previous snapshot.
 *
 * | Context                       | Bills                          | Result                        |
 * |-------------------------------|--------------------------------|-------------------------------|
 * | VERIFIED (YES + version + co) | >0, every row Company matches  | SUCCESS (replace)             |
 * | VERIFIED                      | 0                              | SUCCESS (clear, verified zero)|
 * | VERIFIED                      | any row other / no company     | MISMATCH / UNVERIFIED         |
 * | MISMATCH                      | not fetched                    | COMPANY_CONTEXT_MISMATCH      |
 * | BLANK / EMPTY / INVALID       | not fetched                    | COMPANY_UNVERIFIED            |
 * | COMPANY_NOT_OPEN              | not fetched                    | COMPANY_NOT_OPEN              |
 * | ERROR (transport)             | not fetched                    | TALLY_TIMEOUT / UNREACHABLE   |
 * | REPORT_MISSING / OUTDATED     | >0, every row Company matches  | SUCCESS (legacy, replace)     |
 * | REPORT_MISSING / OUTDATED     | 0                              | LEGACY_EMPTY_AMBIGUOUS        |
 * | any                           | not open / parse / transport   | matching failure              |
 *
 * tdlStatus carries the global health state (Settings), never the context
 * result: a VERIFIED context with unconfirmed health is SUCCESS with
 * tdlStatus HEALTH_UNCONFIRMED and authority CONTEXT.
 */
function decideBillSnapshot({ health, context, bill, requestedCompany = "" }) {
  const cls = healthClass(health.status);
  if (cls === "DOWN") {
    return failure(health.status === TDL_STATUS.TALLY_TIMEOUT ? BILL_STATUS.TALLY_TIMEOUT
      : health.status === TDL_STATUS.TALLY_UNREACHABLE ? BILL_STATUS.TALLY_UNREACHABLE
      : BILL_STATUS.UNKNOWN, { tdlStatus: health.status, reason: health.reason });
  }
  const healthTdl = cls === "UNCONFIRMED" ? TDL_STATUS.HEALTH_UNCONFIRMED : health.status;

  switch (context.status) {
    case CONTEXT_STATUS.VERIFIED: {
      if (bill.kind === "ROWS") return rowsResult(bill, requestedCompany, healthTdl, "CONTEXT");
      if (bill.kind === "EMPTY") {
        return { status: BILL_STATUS.SUCCESS, snapshotComplete: true, rows: [], rowCount: 0, tdlStatus: healthTdl, authority: "CONTEXT" };
      }
      return billFailure(bill, healthTdl);
    }
    case CONTEXT_STATUS.MISMATCH:
      return failure(BILL_STATUS.COMPANY_CONTEXT_MISMATCH, { tdlStatus: healthTdl, reason: context.reason });
    case CONTEXT_STATUS.COMPANY_NOT_OPEN:
      return failure(BILL_STATUS.COMPANY_NOT_OPEN, { tdlStatus: healthTdl, reason: "company_not_open" });
    case CONTEXT_STATUS.ERROR:
      return transportFailure(context.errorStatus, { tdlStatus: healthTdl, reason: context.reason });
    case CONTEXT_STATUS.REPORT_MISSING:
    case CONTEXT_STATUS.OUTDATED: {
      // No health report at all + rows → pre-1.1.0 add-on; otherwise keep the health state.
      const legacyTdl = cls === "LEGACY" ? TDL_STATUS.ACTIVE_LEGACY : healthTdl;
      if (bill.kind === "ROWS") return rowsResult(bill, requestedCompany, legacyTdl, "ROWS");
      if (bill.kind === "EMPTY") {
        return failure(BILL_STATUS.LEGACY_EMPTY_AMBIGUOUS, { tdlStatus: healthTdl, reason: "zero_bills_without_context" });
      }
      return billFailure(bill, healthTdl);
    }
    default:
      return failure(BILL_STATUS.COMPANY_UNVERIFIED, { tdlStatus: healthTdl, reason: context.reason || "context_unverified" });
  }
}

/** Context results after which the bill request is worth sending. */
const FETCH_BILLS_AFTER = new Set([CONTEXT_STATUS.VERIFIED, CONTEXT_STATUS.REPORT_MISSING, CONTEXT_STATUS.OUTDATED]);

async function fetchContext(request, companyName, post, timeout) {
  try {
    return classifyContextResponse(await post(request, { timeout }), companyName);
  } catch (err) {
    return {
      status: CONTEXT_STATUS.ERROR,
      errorStatus: classifyTransportError(err),
      reason: err?.code || err?.message || "request_failed",
    };
  }
}

async function fetchBillResponse(request, post, { timeout, attempts }) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return classifyBillResponse(await post(request, { timeout }));
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  return {
    kind: "ERROR",
    errorStatus: classifyTransportError(lastErr),
    reason: lastErr?.code || lastErr?.message || "request_failed",
  };
}

/**
 * One company: Context → Bills → decision, serialized against every other
 * company unit. Uses the sync run's single health result (`health`; checked
 * here only when the caller has none). Never throws, never restarts Tally.
 * @returns {Promise<{ companyGuid, companyName, status, snapshotComplete, rows, rowCount, tdlStatus, tdlVersion,
 *   healthStatus, healthVersion, contextStatus, contextCompany, contextVersion, authority?, reason?, durationMs }>}
 */
async function fetchCompanyBillSnapshot({
  companyName,
  companyGuid,
  fromDate,
  toDate,
  currentDate,
  health: runHealth = null,
  post,
  contextTimeout = 15000,
  billTimeout = 60000,
  billAttempts = 2,
}) {
  const started = Date.now();
  const base = { companyGuid, companyName };
  const send = post || postToTally;
  const period = { companyName, fromDate, toDate, currentDate };
  let result;
  let health = runHealth;
  let context = { status: null };
  try {
    if (!health) health = await checkTdlHealth(post ? { post } : {});
    if (healthClass(health.status) === "DOWN") {
      result = decideBillSnapshot({ health, context: { status: null }, bill: { kind: "SKIPPED" }, requestedCompany: companyName });
    } else {
      result = await runCompanyExclusive(async () => {
        context = await fetchContext(contextRequestXml(period), companyName, send, contextTimeout);
        info("[tdl] context", {
          company: companyName,
          status: context.status,
          version: context.version || null,
          contextCompany: context.company || null,
          reason: context.reason || null,
        });
        const bill = FETCH_BILLS_AFTER.has(context.status)
          ? await fetchBillResponse(billRequestXml(period), send, { timeout: billTimeout, attempts: billAttempts })
          : { kind: "SKIPPED" };
        return decideBillSnapshot({ health, context, bill, requestedCompany: companyName });
      });
    }
  } catch (err) {
    result = failure(BILL_STATUS.UNKNOWN, { tdlStatus: TDL_STATUS.UNKNOWN, reason: err?.message });
  }
  return {
    ...base,
    ...result,
    tdlVersion: context.version || health?.version || null,
    healthStatus: health?.status || null,
    healthVersion: health?.version || null,
    contextStatus: context.status,
    contextCompany: context.company || null,
    contextVersion: context.version || null,
    durationMs: Date.now() - started,
  };
}

/** What the backend needs to decide replace vs keep. Rows travel separately as BillOutstanding.xml records. */
function snapshotSummary(result) {
  return {
    companyGuid: result.companyGuid,
    status: result.status,
    snapshotComplete: result.status === BILL_STATUS.SUCCESS && result.snapshotComplete === true,
    rowCount: result.rowCount,
    tdlStatus: result.tdlStatus || null,
    tdlVersion: result.tdlVersion || null,
  };
}

module.exports = {
  BILL_REPORT_ID,
  BILL_STATUS,
  billSideOf,
  rowsFromBillOutstandingEnvelope,
  classifyBillResponse,
  verifyRowCompanies,
  decideBillSnapshot,
  fetchCompanyBillSnapshot,
  snapshotSummary,
  billRequestXml,
};
