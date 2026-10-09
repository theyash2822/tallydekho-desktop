/**
 * Tally's full voucher list per company and FY (SimplifiedVoucher.xml), checked strictly
 * enough that the backend may delete vouchers Tally no longer has.
 *
 * A company's list is "complete" only when its TDL Context was VERIFIED this sync and every
 * FY answer is a clean envelope whose voucher GUIDs all carry the company GUID prefix.
 * Anything else is sent as incomplete, and the backend deletes nothing for that company.
 */
const { CONTEXT_STATUS, looksLikeCompanyNotOpen } = require("./tdlHealth");

// Keeps the /ingest/complete body well under the backend's 10 MB JSON limit.
const MAX_LIST_IDS = 400_000;

const isoDate = (d) => {
  const s = String(d || "").replace(/-/g, "");
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
};

/** Highest AlterId in the list, or null if any value isn't a plain number. */
function maxListedAlterId(body) {
  let max = 0;
  for (const m of body.matchAll(/<ALTERID>([^<]*)<\/ALTERID>/gi)) {
    const s = m[1].trim().replace(/,/g, "");
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isSafeInteger(n)) return null;
    if (n > max) max = n;
  }
  return max;
}

/** @returns {{ ok: true, ids: string[], maxAlterId: number|null } | { ok: false, reason: string }} */
function checkVoucherListResponse(response, companyGuid) {
  if (!response?.status) return { ok: false, reason: "request_failed" };
  const text = String(response.data ?? "");
  if (looksLikeCompanyNotOpen(text)) return { ok: false, reason: "company_not_open" };
  if (/LINEERROR/i.test(text)) return { ok: false, reason: "tally_error" };

  const body = text.replace(/^\uFEFF/, "").replace(/^\s*<\?xml[^>]*\?>/i, "").trim();
  if (!/^<ENVELOPE>[\s\S]*<\/ENVELOPE>$/i.test(body)) return { ok: false, reason: "not_an_envelope" };

  const guids = [...body.matchAll(/<GUID>([^<]*)<\/GUID>/gi)].map((m) => m[1].trim());
  const alterIds = (body.match(/<ALTERID>/gi) || []).length;
  if (alterIds !== guids.length) return { ok: false, reason: "parse_failed" };

  const prefix = `${companyGuid}-`;
  const ids = [];
  for (const guid of guids) {
    const id = guid.startsWith(prefix) ? guid.slice(prefix.length) : "";
    if (!/^[A-Za-z0-9]+$/.test(id)) return { ok: false, reason: "foreign_voucher" };
    ids.push(id);
  }
  return { ok: true, ids, maxAlterId: maxListedAlterId(body) };
}

/**
 * Per-FY watermarks for the backend: the highest AlterId Tally listed for the FY before
 * the per-FY fetches ran. Only FYs whose list was clean and whose delta collections all
 * answered are included; `sent` lets the backend confirm every voucher row was saved.
 */
function buildVoucherWatermarks({ companyGuid, years, failedYears, sent }) {
  const out = [];
  for (const y of years || []) {
    if (y.trailing || !y.check?.ok || y.check.maxAlterId == null) continue;
    if (failedYears?.has(y.finYear)) continue;
    out.push({ finYear: y.finYear, alterId: y.check.maxAlterId });
  }
  return { companyGuid, years: out, sent };
}

/**
 * R3 / 07: the company context for the core voucher inventory, independent of the Bill
 * Outstanding add-on. The add-on's Context check is one proof; another is that this sync's own
 * rows for the company carried its GUID prefix while none of its requests failed (any foreign
 * GUID already fails the company). Without either, the list stays incomplete.
 */
function coreListContext(billContextStatus, { ownGuidSeen = false, sourceFailed = false } = {}) {
  if (billContextStatus === CONTEXT_STATUS.VERIFIED) return CONTEXT_STATUS.VERIFIED;
  if (ownGuidSeen && !sourceFailed) return CONTEXT_STATUS.VERIFIED;
  return billContextStatus || null;
}

/**
 * @param {{ companyGuid: string, contextStatus?: string|null,
 *   years: Array<{ finYear: string, begin: string, end: string, trailing?: boolean, check: ReturnType<typeof checkVoucherListResponse> }> }} input
 */
function buildVoucherListSummary({ companyGuid, contextStatus, years }) {
  const incomplete = (reason) => ({ companyGuid, complete: false, reason });
  if (contextStatus !== CONTEXT_STATUS.VERIFIED) {
    return incomplete(`context_${String(contextStatus || "missing").toLowerCase()}`);
  }
  if (!years?.length) return incomplete("no_years");

  const out = [];
  let total = 0;
  for (const y of years) {
    // A trailing (check-only) year that Tally did not answer cleanly is left unchecked, never treated as empty.
    if (y.trailing && !y.check?.ok) continue;
    if (!y.check?.ok) return incomplete(`${y.finYear}:${y.check?.reason || "not_checked"}`);
    const from = isoDate(y.begin);
    const to = isoDate(y.end);
    if (!/^\d{4}-\d{4}$/.test(String(y.finYear)) || !from || !to) return incomplete(`${y.finYear}:bad_period`);
    total += y.check.ids.length;
    out.push({ finYear: y.finYear, from, to, ids: y.check.ids });
  }
  if (!out.length) return incomplete("no_years");
  if (total > MAX_LIST_IDS) return incomplete("too_many_vouchers");
  return { companyGuid, complete: true, reason: null, years: out };
}

const ymd = (dt) => dt.toISOString().slice(0, 10).replace(/-/g, "");
const utc = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));

/**
 * Tally ends a company's period at its last voucher, so a year whose vouchers were all
 * deleted drops out of `years` and its stale vouchers would never be checked. Returns the
 * FY spans after the last synced year, through the FY after the one containing `today`;
 * they are fetched for the deletion check only, never ingested.
 */
function trailingCheckYears(years, today = new Date()) {
  const last = [...(years || [])].sort((a, b) => String(a.end).localeCompare(String(b.end))).pop();
  if (!last || !/^\d{8}$/.test(String(last.begin)) || !/^\d{8}$/.test(String(last.end))) return [];
  const limit = new Date(Date.UTC(today.getUTCFullYear() + 1, today.getUTCMonth(), today.getUTCDate()));
  const out = [];
  let begin = utc(String(last.begin));
  for (let i = 0; i < 10; i++) {
    begin = new Date(Date.UTC(begin.getUTCFullYear() + 1, begin.getUTCMonth(), begin.getUTCDate()));
    if (begin > limit) break;
    const end = new Date(Date.UTC(begin.getUTCFullYear() + 1, begin.getUTCMonth(), begin.getUTCDate() - 1));
    out.push({ finYear: `${begin.getUTCFullYear()}-${begin.getUTCFullYear() + 1}`, begin: ymd(begin), end: ymd(end) });
  }
  return out;
}

/** Counts only — never log the id lists. */
function voucherListLog(summary) {
  if (!summary) return null;
  return {
    companyGuid: summary.companyGuid,
    complete: summary.complete,
    reason: summary.reason,
    years: (summary.years || []).map((y) => ({ finYear: y.finYear, ids: y.ids.length })),
  };
}

module.exports = {
  coreListContext,
  MAX_LIST_IDS,
  checkVoucherListResponse,
  buildVoucherListSummary,
  buildVoucherWatermarks,
  trailingCheckYears,
  voucherListLog,
};
