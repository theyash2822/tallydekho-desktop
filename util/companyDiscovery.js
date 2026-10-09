const createFinancialYears = require("./createFinancialYears");

/**
 * Parse one Companies.xml entry; null when Tally sent no usable identity or dates.
 * `ledgerCountFor(guid)` supplies the cached display-only ledger count (or null).
 */
const toDiscoveredCompany = (company, currentGuid, ledgerCountFor = () => null) => {
  if (!company?.GUID || company.STARTINGFROM == null || company.ENDINGAT == null) return null;
  const guid = String(company.GUID);
  return {
    name: company.NAME,
    guid,
    startingFrom: company.STARTINGFROM,
    booksFrom: company.BOOKSFROM,
    website: company.WEBSITE,
    email: company.EMAIL,
    phoneNumber: company.PHONENUMBER,
    mobileNumber: company.MOBILENO,
    address: [
      company._ADDRESS1 ?? "",
      company._ADDRESS2 ?? "",
      company._ADDRESS3 ?? "",
      company._ADDRESS4 ?? "",
      company._ADDRESS5 ?? "",
    ],
    pincode: company.PINCODE,
    state: company.STATENAME,
    country: company.COUNTRYNAME,
    gstNumber: "",
    incomeTaxNumber: company.INCOMETAXNUMBER,
    companyNumber: company.COMPANYNUMBER,
    destination: company.DESTINATION,
    isSynced: false,
    years: createFinancialYears(
      company.STARTINGFROM.toString(),
      company.ENDINGAT.toString()
    ),
    isCurrentCompany: currentGuid != null && guid == String(currentGuid),
    ledgersCount: ledgerCountFor(guid) ?? null,
  };
};

/**
 * Companies.xml COLLECTION.COMPANY node(s) → typed discovery result.
 * "ok": every open company was read (possibly none). "partial": some entries had no
 * usable identity or dates, so a company missing from the list may still be open.
 */
const buildDiscovery = (list, currentGuid, { observedAt, ledgerCountFor } = {}) => {
  const companies = [];
  let skipped = 0;
  for (const raw of list) {
    let parsed = null;
    try {
      parsed = toDiscoveredCompany(raw, currentGuid, ledgerCountFor);
    } catch (_) { /* bad dates */ }
    if (parsed) companies.push(parsed);
    else skipped++;
  }
  return { status: skipped ? "partial" : "ok", observedAt: observedAt || new Date().toISOString(), companies, skipped };
};

/**
 * Raw Companies.xml text + parser → typed discovery. Tally errors and replies that are
 * not a company collection are "unavailable": they say nothing about which companies are open.
 */
const discoveryFromResponse = (text, parse, currentGuid, opts = {}) => {
  const observedAt = opts.observedAt || new Date().toISOString();
  const unavailable = (reason) => ({ status: "unavailable", reason, observedAt, companies: [] });
  if (typeof text !== "string" || !text.trim()) return unavailable("empty_response");
  if (/<LINEERROR>/i.test(text)) return unavailable("tally_error");
  let envelope;
  try {
    envelope = parse(text)?.ENVELOPE;
  } catch (_) {
    return unavailable("parse_failed");
  }
  if (!envelope || typeof envelope !== "object") return unavailable("parse_failed");
  const node = envelope?.BODY?.DATA?.COLLECTION?.COMPANY ?? [];
  const list = Array.isArray(node) ? node : [node].filter(Boolean);
  return buildDiscovery(list, currentGuid, { ...opts, observedAt });
};

module.exports = { toDiscoveredCompany, buildDiscovery, discoveryFromResponse };
