/**
 * Merge a company discovery result from Tally into the saved selection.
 *
 * The saved selection is user intent. Discovery only tells us which companies
 * are open right now, so:
 *  - a failed / unknown discovery changes nothing;
 *  - a selected company that is not open stays selected, marked unavailable;
 *  - the current Tally company is auto-selected only when nothing is selected
 *    and the user did not clear the list on purpose;
 *  - "GUID changed" is reported only on positive evidence: a missing synced
 *    company whose name now appears under a different GUID.
 */

const normName = (name) => String(name ?? "").trim().toLowerCase();

/** Discovery entry → the shape stored in the selection. */
export function toSelectionEntry(company) {
  return {
    id: company.guid,
    name: company.name,
    guid: company.guid,
    path: company.destination ?? null,
    years: company.years,
    isCurrentCompany: !!company.isCurrentCompany,
    allYears: company.years,
    ledgersCount: company.ledgersCount ?? null,
    // Preserve date fields needed for OpeningBalanceDiff.xml sync
    startingFrom: company.startingFrom,
    booksFrom: company.booksFrom,
    // Lets the TDL restart reopen the company (/LOAD) instead of Tally's default one
    companyNumber: company.companyNumber,
  };
}

/** Selected FYs plus any FY that starts after every selected one (a new year opened in Tally). */
function withNewYears(selectedYears, allYears) {
  if (!allYears || selectedYears.length === 0) return selectedYears;
  const selectedNames = new Set(selectedYears.map((y) => y.finYear));
  const maxEnd = selectedYears.reduce((max, y) => (y.end > max ? y.end : max), "");
  if (!maxEnd) return selectedYears;
  const fresh = allYears.filter((y) => !selectedNames.has(y.finYear) && y.begin > maxEnd);
  return fresh.length ? [...selectedYears, ...fresh] : selectedYears;
}

/**
 * @param {object} args
 * @param {Array} args.selected        current saved selection
 * @param {object} args.discovery      { status: "ok" | ..., companies, observedAt }
 * @param {boolean} args.clearedByUser user emptied the list on purpose
 * @returns {{ selection, companies, changed, available, identityConflicts, autoSelected }}
 */
export function mergeDiscovery({ selected = [], discovery, clearedByUser = false }) {
  const current = Array.isArray(selected) ? selected : [];
  const partial = discovery?.status === "partial";
  if (!discovery || (discovery.status !== "ok" && !partial) || !Array.isArray(discovery.companies)) {
    return {
      selection: current,
      companies: null,
      changed: false,
      available: false,
      identityConflicts: [],
      autoSelected: false,
    };
  }

  const observedAt = discovery.observedAt || new Date().toISOString();
  const data = discovery.companies.filter((c) => c && c.guid).map(toSelectionEntry);
  const byId = new Map(data.map((d) => [d.id, d]));

  let selection;
  let autoSelected = false;
  if (current.length > 0) {
    selection = current.map((company) => {
      const fresh = byId.get(company.id) || byId.get(company.guid);
      // A partial list is no evidence that an unlisted company is closed.
      if (!fresh) return partial ? company : { ...company, available: false };
      return {
        ...company,
        name: fresh.name,
        companyNumber: fresh.companyNumber,
        allYears: fresh.allYears,
        ledgersCount: fresh.ledgersCount ?? company.ledgersCount ?? null,
        path: fresh.path ?? company.path ?? null,
        years: withNewYears(company.years || [], fresh.allYears),
        available: true,
        lastSeenAt: observedAt,
      };
    });
  } else if (!clearedByUser) {
    selection = data
      .filter((item) => item.isCurrentCompany)
      .map((item) => ({ ...item, years: item.years.slice(-2), available: true, lastSeenAt: observedAt }));
    autoSelected = selection.length > 0;
  } else {
    selection = [];
  }

  const identityConflicts = [];
  for (const company of partial ? [] : current) {
    if (!company.isSynced || byId.has(company.id) || byId.has(company.guid)) continue;
    const sameName = data.find((d) => normName(d.name) === normName(company.name) && d.guid !== company.guid);
    if (sameName) {
      identityConflicts.push({ name: company.name, oldGuid: company.guid, newGuid: sameName.guid });
    }
  }

  return {
    selection,
    companies: data,
    changed: JSON.stringify(selection) !== JSON.stringify(current),
    available: true,
    identityConflicts,
    autoSelected,
  };
}

/** Running sync job (or null) from a coordinator snapshot. */
export function activeSyncJob(snapshot) {
  const active = snapshot?.active || [];
  return active.find((j) => j.type === "sync" || j.type === "hard_sync") || null;
}
