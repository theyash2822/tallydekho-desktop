/**
 * Per-company Bill Outstanding snapshot from Tally.
 *
 * Health is global (one check per sync run, company-independent); each company
 * then gets its own bill fetch, so one company's result never depends on
 * another's. Company identity comes from the bill response itself: a
 * TDKCONTEXT line (present even with zero bills) and a Company tag per row.
 * The backend replaces a company's bills only when status is SUCCESS and
 * snapshotComplete is true; every other status keeps the previous bills.
 */
const { XMLParser } = require("fast-xml-parser");
const { xmlText } = require("./tallyQueue");
const { info } = require("./logger");
const {
  TDL_STATUS,
  checkTdlHealth,
  classifyTransportError,
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
  // Legacy add-on (no health report) returned no rows: zero bills and a missing
  // report look the same, so nothing can be concluded.
  LEGACY_EMPTY_AMBIGUOUS: "LEGACY_EMPTY_AMBIGUOUS",
  COMPANY_CONTEXT_MISMATCH: "COMPANY_CONTEXT_MISMATCH",
  // Response did not prove which company it came from (no matching TDKCONTEXT / row Company).
  COMPANY_UNVERIFIED: "COMPANY_UNVERIFIED",
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

function firstNode(value) {
  return Array.isArray(value) ? value[0] : value;
}

function textOf(value) {
  const v = value && typeof value === "object" ? value.value : value;
  return v == null ? "" : String(v).trim();
}

function rawRowsOf(envelope) {
  const raw = envelope?.BILLROW ?? envelope?.BillRow;
  if (raw == null) return [];
  return (Array.isArray(raw) ? raw : [raw]).filter((r) => r && typeof r === "object");
}

/**
 * Classify the bill report response. Pure.
 * kind: ROWS | EMPTY | REPORT_MISSING | PARSE_FAILED | INVALID
 * contextCompany: TDKCONTEXT/COMPANY (null when absent); rowCompanies: Company tag per row ("" when absent).
 */
function classifyBillResponse(text) {
  const body = String(text ?? "");
  if (!body.trim()) return { kind: "INVALID", reason: "empty_body" };

  const tagCount = (body.match(/<BILLROW[\s>]/gi) || []).length;
  const hasContext = /<TDKCONTEXT[\s>]/i.test(body);

  if (tagCount > 0 || hasContext) {
    let envelope;
    try {
      const json = parser.parse(body);
      envelope = json.ENVELOPE || json.Envelope || {};
    } catch (e) {
      return { kind: "PARSE_FAILED", reason: e?.message || "parse_error", tagCount };
    }
    const ctx = firstNode(envelope.TDKCONTEXT ?? envelope.TdkContext);
    const contextCompany = ctx ? textOf(ctx.COMPANY ?? ctx.Company) || null : null;
    if (tagCount === 0) return { kind: "EMPTY", contextCompany, rowCompanies: [] };

    const raw = rawRowsOf(envelope);
    const rows = rowsFromBillOutstandingEnvelope(envelope);
    if (rows.length !== tagCount || raw.length !== tagCount) {
      return { kind: "PARSE_FAILED", reason: "row_count_mismatch", tagCount, parsed: rows.length };
    }
    const rowCompanies = raw.map((r) => textOf(r.Company ?? r.COMPANY));
    return { kind: "ROWS", rows, contextCompany, rowCompanies };
  }

  if (looksLikeMissingReport(body)) return { kind: "REPORT_MISSING" };
  // Bare envelope: zero bills only if the company can still be proven (it cannot here — no TDKCONTEXT).
  if (EMPTY_ENVELOPE.test(body)) return { kind: "EMPTY", contextCompany: null, rowCompanies: [] };
  return { kind: "INVALID", reason: "unexpected_shape" };
}

/**
 * Does the bill response prove it came from `requestedCompany`? Pure.
 * mismatch: TDKCONTEXT or any row names another company.
 * verified: no mismatch and (TDKCONTEXT matches, or every row carries the matching company).
 * noCompanyInfo: pre-1.1.1 add-on shape (no TDKCONTEXT, no row Company tags).
 */
function verifyBillCompany(requestedCompany, bill) {
  const want = normaliseCompany(requestedCompany);
  const ctx = bill.contextCompany ? normaliseCompany(bill.contextCompany) : "";
  const rowCos = (bill.rowCompanies || []).map(normaliseCompany);
  const mismatch = (!!ctx && ctx !== want) || rowCos.some((c) => c && c !== want);
  const contextMatch = !!want && ctx === want;
  const rowsMatch = !!want && rowCos.length > 0 && rowCos.every((c) => c === want);
  return {
    mismatch,
    contextMatch,
    verified: !mismatch && (contextMatch || rowsMatch),
    noCompanyInfo: !ctx && rowCos.every((c) => !c),
  };
}

function failure(status, extra = {}) {
  return { status, snapshotComplete: false, rows: [], rowCount: 0, ...extra };
}

/** ACTIVE | UNCONFIRMED | LEGACY | DOWN — how far the health result lets the bill report be trusted. */
function healthClass(status) {
  if (isActiveHealth(status)) return "ACTIVE";
  if (isUnconfirmedHealth(status)) return "UNCONFIRMED";
  if (status === TDL_STATUS.HEALTH_MISSING) return "LEGACY";
  return "DOWN";
}

/**
 * Decide the snapshot result from the health check, the bill response and the
 * requested company. Pure. Only SUCCESS (snapshotComplete) lets the backend
 * replace/clear bills; everything else preserves the previous snapshot.
 *
 * | Health      | Bills                         | Result                                   |
 * |-------------|-------------------------------|------------------------------------------|
 * | ACTIVE      | >0, company verified          | SUCCESS (replace)                        |
 * | ACTIVE      | 0, TDKCONTEXT matches         | SUCCESS (clear)                          |
 * | ACTIVE      | 0 / rows, company not proven  | COMPANY_UNVERIFIED                       |
 * | UNCONFIRMED | >0, company verified          | SUCCESS, tdlStatus HEALTH_UNCONFIRMED    |
 * | UNCONFIRMED | 0                             | LEGACY_EMPTY_AMBIGUOUS                   |
 * | LEGACY      | >0, verified or no company tags (pre-1.1.1 add-on) | SUCCESS, ACTIVE_LEGACY |
 * | LEGACY      | 0                             | LEGACY_EMPTY_AMBIGUOUS                   |
 * | any         | another company named         | COMPANY_CONTEXT_MISMATCH                 |
 * | DOWN        | not fetched                   | TALLY_TIMEOUT / TALLY_UNREACHABLE / ...  |
 */
function decideBillSnapshot(health, bill, requestedCompany = "") {
  const cls = healthClass(health.status);
  if (cls === "DOWN") {
    return failure(health.status === TDL_STATUS.TALLY_TIMEOUT ? BILL_STATUS.TALLY_TIMEOUT
      : health.status === TDL_STATUS.TALLY_UNREACHABLE ? BILL_STATUS.TALLY_UNREACHABLE
      : BILL_STATUS.UNKNOWN, { tdlStatus: health.status, reason: health.reason });
  }

  const tdlStatus = cls === "ACTIVE" ? health.status
    : cls === "UNCONFIRMED" ? TDL_STATUS.HEALTH_UNCONFIRMED
    : TDL_STATUS.ACTIVE_LEGACY;
  const unprovenTdl = cls === "LEGACY" ? TDL_STATUS.UNKNOWN : tdlStatus;
  const contextCompany = bill.contextCompany ?? null;

  switch (bill.kind) {
    case "ROWS":
    case "EMPTY": {
      const id = verifyBillCompany(requestedCompany, bill);
      if (id.mismatch) {
        return failure(BILL_STATUS.COMPANY_CONTEXT_MISMATCH, {
          tdlStatus: unprovenTdl,
          contextCompany,
          reason: "tally_answered_for_another_company",
        });
      }
      if (bill.kind === "ROWS") {
        const legacyShape = cls === "LEGACY" && id.noCompanyInfo;
        if (id.verified || legacyShape) {
          return {
            status: BILL_STATUS.SUCCESS,
            snapshotComplete: true,
            rows: bill.rows,
            rowCount: bill.rows.length,
            tdlStatus,
            contextCompany,
          };
        }
        return failure(BILL_STATUS.COMPANY_UNVERIFIED, {
          tdlStatus: unprovenTdl,
          contextCompany,
          reason: "rows_without_matching_company",
        });
      }
      if (cls !== "ACTIVE") {
        return failure(BILL_STATUS.LEGACY_EMPTY_AMBIGUOUS, {
          tdlStatus: cls === "UNCONFIRMED" ? TDL_STATUS.HEALTH_UNCONFIRMED : TDL_STATUS.UNKNOWN,
          contextCompany,
        });
      }
      if (id.contextMatch) {
        return { status: BILL_STATUS.SUCCESS, snapshotComplete: true, rows: [], rowCount: 0, tdlStatus, contextCompany };
      }
      return failure(BILL_STATUS.COMPANY_UNVERIFIED, {
        tdlStatus,
        contextCompany,
        reason: "zero_bills_without_company_context",
      });
    }
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
 * Bill fetch for one company, using the sync run's single health result
 * (`health`; checked here only when the caller has none). Never throws, never
 * restarts Tally.
 * @returns {Promise<{ companyGuid, companyName, status, snapshotComplete, rows, rowCount, tdlStatus, tdlVersion, contextCompany?, reason?, durationMs }>}
 */
async function fetchCompanyBillSnapshot({
  companyName,
  companyGuid,
  fromDate,
  toDate,
  currentDate,
  health: runHealth = null,
  post,
  billTimeout = 60000,
  billAttempts = 2,
}) {
  const started = Date.now();
  const base = { companyGuid, companyName };
  let result;
  let health = runHealth;
  try {
    if (!health) health = await checkTdlHealth(post ? { post } : {});
    const cls = healthClass(health.status);
    if (cls === "DOWN") {
      result = decideBillSnapshot(health, { kind: "SKIPPED" }, companyName);
    } else {
      if (cls !== "ACTIVE") {
        info("[tdl] bill fallback", { company: companyName, healthStatus: health.status, reason: health.reason || null });
      }
      const bill = await fetchBillResponse(
        billRequestXml({ companyName, fromDate, toDate, currentDate }),
        post || postToTally,
        { timeout: billTimeout, attempts: billAttempts }
      );
      result = decideBillSnapshot(health, bill, companyName);
      if (cls !== "ACTIVE") {
        info("[tdl] bill fallback result", {
          company: companyName,
          status: result.status,
          rows: result.rowCount,
          contextCompany: result.contextCompany ?? null,
        });
      }
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
  verifyBillCompany,
  decideBillSnapshot,
  fetchCompanyBillSnapshot,
  snapshotSummary,
  billRequestXml,
};
