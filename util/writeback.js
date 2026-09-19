/**
 * Tally writeback — claim, post, acknowledge.
 *
 * The backend `claim` is the exclusivity mechanism: a claimed entry is locked
 * to this device, and the result call releases it. Desktop adds no second
 * duplicate-prevention scheme; it simply never re-posts an entry it has
 * already acknowledged.
 *
 * Two entry points share one implementation:
 *   - `pending_tally_writeback_available` socket wake-up (event driven)
 *   - `reconcilePendingWriteback()` (startup / reconnect / network-online)
 *
 * The reconciliation pull exists because a wake-up emitted while Desktop was
 * offline is never redelivered.
 */
const { info, error } = require("./logger");
const { getSelectedCompanies } = require("./companySelection");

const DEFAULT_LIMIT = 10;

let axiosGetter = () => require("./helper").axiosInstance;
let postToTallyFn = null;

function __setDepsForTests(overrides = {}) {
  if (overrides.axiosInstance) axiosGetter = () => overrides.axiosInstance;
  if (overrides.postToTally) postToTallyFn = overrides.postToTally;
}

function resetDepsForTests() {
  axiosGetter = () => {
    throw new Error("writeback axios not injected");
  };
  postToTallyFn = null;
  inFlightCompanies.clear();
  reconcileInFlight = false;
}

/** Companies currently being drained, so the socket and the pull cannot overlap. */
const inFlightCompanies = new Set();
let reconcileInFlight = false;

function companyGuidsFromSelection() {
  const guids = [];
  for (const company of getSelectedCompanies()) {
    const guid = company?.guid || company?.id;
    if (guid && !guids.includes(guid)) guids.push(guid);
  }
  return guids;
}

/**
 * Drain pending writeback entries for one company.
 * @returns {Promise<{claimed:number, posted:number, failed:number}>}
 */
async function processCompanyWriteback(companyGuid, { limit = DEFAULT_LIMIT } = {}) {
  const result = { claimed: 0, posted: 0, failed: 0 };
  if (!companyGuid) return result;
  if (inFlightCompanies.has(companyGuid)) return result;

  inFlightCompanies.add(companyGuid);
  try {
    const axiosInstance = axiosGetter();
    const postToTally = postToTallyFn || require("./xml").postToTally;

    const pendingRes = await axiosInstance.post("/tally/desktop/writeback/pending", {
      companyGuid,
      limit,
    });
    const items = pendingRes.data?.data?.items || [];
    if (!items.length) return result;

    info(`[writeback] ${items.length} pending entries for company ${companyGuid}`);

    const handled = new Set();
    for (const item of items) {
      if (!item.outboxId || handled.has(item.outboxId)) continue;
      handled.add(item.outboxId);

      try {
        const claimRes = await axiosInstance.post(
          `/tally/desktop/writeback/${item.outboxId}/claim`,
          {}
        );
        const claimData = claimRes.data?.data;
        if (!claimData?.claimed || !claimData?.xml) {
          info(`[writeback] entry ${item.outboxId} not claimed by this device`);
          continue;
        }
        result.claimed += 1;

        const tallyResult = await postToTally(claimData.xml);
        const success = tallyResult?.status === true;

        await axiosInstance.post(`/tally/desktop/writeback/${item.outboxId}/result`, {
          success,
          tallyVoucherNumber: tallyResult?.voucherNumber || null,
          tallyVoucherGuid: tallyResult?.tallyId || null,
          tallyAlterId: tallyResult?.alterId || null,
          errorCode: success ? null : "TALLY_ERROR",
          errorMessage: success ? null : tallyResult?.message || "Tally posting failed",
        });

        if (success) result.posted += 1;
        else result.failed += 1;
        info(`[writeback] entry ${item.outboxId} → ${success ? "posted" : "failed"}`);
      } catch (entryErr) {
        result.failed += 1;
        error(entryErr?.message, `writeback.entry.${item.outboxId}`);
        // Report the failure so the backend releases its claim for a later retry.
        try {
          await axiosInstance.post(`/tally/desktop/writeback/${item.outboxId}/result`, {
            success: false,
            errorCode: "DESKTOP_ERROR",
            errorMessage: entryErr?.message,
          });
        } catch (_) {}
      }
    }
    return result;
  } catch (err) {
    error(err?.message, "writeback.company");
    return result;
  } finally {
    inFlightCompanies.delete(companyGuid);
  }
}

/**
 * Catch-up pull across the companies selected for the bound workspace.
 * Workspace scoping comes from the device credential on every request — the
 * companyGuid is only the external Tally identity.
 */
async function reconcilePendingWriteback(reason = "reconcile") {
  if (reconcileInFlight) return { skipped: true };
  const guids = companyGuidsFromSelection();
  if (!guids.length) return { skipped: true };

  reconcileInFlight = true;
  try {
    const totals = { claimed: 0, posted: 0, failed: 0 };
    for (const guid of guids) {
      const res = await processCompanyWriteback(guid);
      totals.claimed += res.claimed;
      totals.posted += res.posted;
      totals.failed += res.failed;
    }
    if (totals.claimed || totals.failed) {
      info(
        `[writeback] reconciliation (${reason}) claimed=${totals.claimed} posted=${totals.posted} failed=${totals.failed}`
      );
    }
    return totals;
  } finally {
    reconcileInFlight = false;
  }
}

module.exports = {
  processCompanyWriteback,
  reconcilePendingWriteback,
  companyGuidsFromSelection,
  __setDepsForTests,
  resetDepsForTests,
};
