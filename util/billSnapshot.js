/**
 * Per-company Bill Outstanding snapshot from Tally.
 *
 * Every company gets its own health check + bill fetch, so the result for one
 * company never depends on another company or on the selection order. The
 * backend replaces a company's bills only when status is SUCCESS and
 * snapshotComplete is true; every other status keeps the previous bills.
 */
const { XMLParser } = require("fast-xml-parser");
const { xmlText } = require("./tallyQueue");
const {
  TDL_STATUS,
  checkTdlHealth,
  classifyTransportError,
  looksLikeMissingReport,
  normaliseCompany,
  isActiveHealth,
  postToTally,
} = require("./tdlHealth");

const BILL_REPORT_ID = "TDKBillOutstandingWorking";

const BILL_STATUS = Object.freeze({
  SUCCESS: "SUCCESS",
  TDL_NOT_LOADED: "TDL_NOT_LOADED",
  // Legacy add-on (no health report) returned no rows: zero bills and a missing
  // report look the same, so nothing can be concluded.
  LEGACY_EMPTY_AMBIGUOUS: "LEGACY_EMPTY_AMBIGUOUS",
  COMPANY_CONTEXT_MISMATCH: "COMPANY_CONTEXT_MISMATCH",
  TALLY_UNREACHABLE: "TALLY_UNREACHABLE",
  TALLY_TIMEOUT: "TALLY_TIMEOUT",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  PARSE_FAILED: "PARSE_FAILED",
  UNKNOWN: "UNKNOWN",
});

const parser = new XMLParser({
  ignoreAttributes: true,
  attributeNamePrefix: "",
  textNodeName: "value",
  parseTagValue: true,
  trimValues: true,
});

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

/**
 * Classify the bill report response. Pure.
 * kind: ROWS | EMPTY | REPORT_MISSING | PARSE_FAILED | INVALID
 */
function classifyBillResponse(text) {
  const body = String(text ?? "");
  if (!body.trim()) return { kind: "INVALID", reason: "empty_body" };

  const tagCount = (body.match(/<BILLROW[\s>]/gi) || []).length;
  if (tagCount > 0) {
    let rows;
    try {
      const json = parser.parse(body);
      rows = rowsFromBillOutstandingEnvelope(json.ENVELOPE || json.Envelope || {});
    } catch (e) {
      return { kind: "PARSE_FAILED", reason: e?.message || "parse_error", tagCount };
    }
    if (rows.length !== tagCount) {
      return { kind: "PARSE_FAILED", reason: "row_count_mismatch", tagCount, parsed: rows.length };
    }
    return { kind: "ROWS", rows };
  }

  if (looksLikeMissingReport(body)) return { kind: "REPORT_MISSING" };
  // A bare envelope is "zero bills" only when the health report already proved the TDL is loaded.
  if (EMPTY_ENVELOPE.test(body)) return { kind: "EMPTY" };
  return { kind: "INVALID", reason: "unexpected_shape" };
}

function failure(status, extra = {}) {
  return { status, snapshotComplete: false, rows: [], rowCount: 0, ...extra };
}

/**
 * Decide the snapshot result from the health check and the bill response. Pure.
 * @param {{ status: string, version?: string }} health
 * @param {{ kind: string, rows?: object[], errorStatus?: string, reason?: string }} bill
 */
function decideBillSnapshot(health, bill) {
  const legacy = health.status === TDL_STATUS.HEALTH_MISSING;
  if (!isActiveHealth(health.status) && !legacy) {
    return failure(health.status === TDL_STATUS.TALLY_TIMEOUT ? BILL_STATUS.TALLY_TIMEOUT
      : health.status === TDL_STATUS.TALLY_UNREACHABLE ? BILL_STATUS.TALLY_UNREACHABLE
      : health.status === TDL_STATUS.INVALID_RESPONSE ? BILL_STATUS.INVALID_RESPONSE
      : BILL_STATUS.UNKNOWN, { tdlStatus: health.status, reason: health.reason });
  }

  const tdlStatus = legacy ? TDL_STATUS.ACTIVE_LEGACY : health.status;
  const unprovenTdl = legacy ? TDL_STATUS.UNKNOWN : health.status;
  switch (bill.kind) {
    case "ROWS":
      return {
        status: BILL_STATUS.SUCCESS,
        snapshotComplete: true,
        rows: bill.rows,
        rowCount: bill.rows.length,
        tdlStatus,
      };
    case "EMPTY":
      if (legacy) {
        return failure(BILL_STATUS.LEGACY_EMPTY_AMBIGUOUS, { tdlStatus: TDL_STATUS.UNKNOWN });
      }
      return { status: BILL_STATUS.SUCCESS, snapshotComplete: true, rows: [], rowCount: 0, tdlStatus };
    case "REPORT_MISSING":
      return failure(BILL_STATUS.TDL_NOT_LOADED, { tdlStatus: TDL_STATUS.NOT_LOADED });
    case "PARSE_FAILED":
      return failure(BILL_STATUS.PARSE_FAILED, { tdlStatus: unprovenTdl, reason: bill.reason });
    case "ERROR":
      return failure(bill.errorStatus === TDL_STATUS.TALLY_TIMEOUT
        ? BILL_STATUS.TALLY_TIMEOUT
        : BILL_STATUS.TALLY_UNREACHABLE, { tdlStatus: unprovenTdl, reason: bill.reason });
    default:
      return failure(BILL_STATUS.INVALID_RESPONSE, { tdlStatus: unprovenTdl, reason: bill.reason });
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
 * Health check + bill fetch for one company. Never throws, never restarts Tally.
 * @returns {Promise<{ companyGuid, companyName, status, snapshotComplete, rows, rowCount, tdlStatus, tdlVersion, reason?, durationMs }>}
 */
async function fetchCompanyBillSnapshot({
  companyName,
  companyGuid,
  fromDate,
  toDate,
  currentDate,
  post = postToTally,
  billTimeout = 60000,
  billAttempts = 2,
}) {
  const started = Date.now();
  const base = { companyGuid, companyName };
  let result;
  let health;
  try {
    health = await checkTdlHealth(companyName, { post });
    if (
      isActiveHealth(health.status) &&
      health.company &&
      normaliseCompany(health.company) !== normaliseCompany(companyName)
    ) {
      result = failure(BILL_STATUS.COMPANY_CONTEXT_MISMATCH, {
        tdlStatus: health.status,
        reason: "tally_answered_for_another_company",
      });
    } else if (isActiveHealth(health.status) || health.status === TDL_STATUS.HEALTH_MISSING) {
      const bill = await fetchBillResponse(
        billRequestXml({ companyName, fromDate, toDate, currentDate }),
        post,
        { timeout: billTimeout, attempts: billAttempts }
      );
      result = decideBillSnapshot(health, bill);
    } else {
      result = decideBillSnapshot(health, { kind: "SKIPPED" });
    }
  } catch (err) {
    result = failure(BILL_STATUS.UNKNOWN, { tdlStatus: TDL_STATUS.UNKNOWN, reason: err?.message });
  }
  return {
    ...base,
    ...result,
    tdlVersion: health?.version || null,
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
  decideBillSnapshot,
  fetchCompanyBillSnapshot,
  snapshotSummary,
  billRequestXml,
};
