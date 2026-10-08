/**
 * Fiscal scope for one sync job, decided in main so headless, scheduled and socket-triggered runs
 * pick up a newly opened financial year without the window. Policy is the existing renderer rule
 * (renderer/app/utils/selectionMerge.js): keep the user's years and append only years that start
 * after every selected one. Deselected older years stay deselected; nothing is ever removed.
 */
const createFinancialYears = require("./createFinancialYears");

function withNewYears(selectedYears, allYears) {
  if (!Array.isArray(allYears) || !Array.isArray(selectedYears) || selectedYears.length === 0) return selectedYears;
  const selectedNames = new Set(selectedYears.map((y) => y.finYear));
  const maxEnd = selectedYears.reduce((max, y) => (y.end > max ? y.end : max), "");
  if (!maxEnd) return selectedYears;
  const fresh = allYears.filter((y) => !selectedNames.has(y.finYear) && y.begin > maxEnd);
  return fresh.length ? [...selectedYears, ...fresh] : selectedYears;
}

/** Companies.xml COMPANY nodes → guid → years Tally currently reports. Unusable entries are skipped. */
function yearsFromCompanyNodes(list) {
  const out = new Map();
  for (const c of list || []) {
    if (!c?.GUID || c.STARTINGFROM == null || c.ENDINGAT == null) continue;
    try {
      const years = createFinancialYears(String(c.STARTINGFROM), String(c.ENDINGAT));
      if (years.length) out.set(String(c.GUID), years);
    } catch (_) { /* malformed dates: leave this company's scope unchanged */ }
  }
  return out;
}

/**
 * @param {Array} companies     selection for this job
 * @param {Map|null} freshYears guid → years from Tally (null = discovery unavailable)
 * @returns {{ companies: Array, added: Array<{ guid: string, finYears: string[] }> }}
 *          `companies` are deep-frozen copies: the job's scope cannot change mid-run.
 */
function planFiscalScope(companies, freshYears) {
  const added = [];
  const planned = (companies || []).map((company) => {
    const fresh = freshYears?.get(String(company?.guid));
    const years = Array.isArray(company?.years) ? company.years : [];
    if (!fresh) return { ...company, years: [...years] };
    const next = withNewYears(years, fresh);
    if (next.length > years.length) {
      added.push({ guid: company.guid, finYears: next.slice(years.length).map((y) => y.finYear) });
    }
    return { ...company, years: [...next], allYears: fresh };
  });
  return { companies: planned.map(deepFreeze), added };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Stored selection with the planned years applied to matching companies; other fields untouched. */
function applyPlannedYears(stored, added, planned) {
  if (!added.length) return null;
  const byGuid = new Map(planned.map((c) => [String(c.guid), c]));
  const addedGuids = new Set(added.map((a) => String(a.guid)));
  return (stored || []).map((c) => {
    const p = byGuid.get(String(c?.guid));
    if (!p || !addedGuids.has(String(c.guid))) return c;
    return { ...c, years: p.years.map((y) => ({ ...y })), allYears: p.allYears.map((y) => ({ ...y })) };
  });
}

module.exports = { withNewYears, yearsFromCompanyNodes, planFiscalScope, applyPlannedYears };
