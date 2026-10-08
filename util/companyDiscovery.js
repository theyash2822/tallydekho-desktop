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

/** Companies.xml COLLECTION.COMPANY node(s) → typed discovery result. */
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
  return { status: "ok", observedAt: observedAt || new Date().toISOString(), companies, skipped };
};

module.exports = { toDiscoveredCompany, buildDiscovery };
