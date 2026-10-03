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

/** @returns {{ ok: true, ids: string[] } | { ok: false, reason: string }} */
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
  return { ok: true, ids };
}

/**
 * @param {{ companyGuid: string, contextStatus?: string|null,
 *   years: Array<{ finYear: string, begin: string, end: string, check: ReturnType<typeof checkVoucherListResponse> }> }} input
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
    if (!y.check?.ok) return incomplete(`${y.finYear}:${y.check?.reason || "not_checked"}`);
    const from = isoDate(y.begin);
    const to = isoDate(y.end);
    if (!/^\d{4}-\d{4}$/.test(String(y.finYear)) || !from || !to) return incomplete(`${y.finYear}:bad_period`);
    total += y.check.ids.length;
    out.push({ finYear: y.finYear, from, to, ids: y.check.ids });
  }
  if (total > MAX_LIST_IDS) return incomplete("too_many_vouchers");
  return { companyGuid, complete: true, reason: null, years: out };
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
  MAX_LIST_IDS,
  checkVoucherListResponse,
  buildVoucherListSummary,
  voucherListLog,
};
