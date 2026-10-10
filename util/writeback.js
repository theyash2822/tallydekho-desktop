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
let hardSyncActiveFn = null;

function __setDepsForTests(overrides = {}) {
  if (overrides.axiosInstance) axiosGetter = () => overrides.axiosInstance;
  if (overrides.postToTally) postToTallyFn = overrides.postToTally;
  if (overrides.isHardSyncActive) hardSyncActiveFn = overrides.isHardSyncActive;
}

function resetDepsForTests() {
  axiosGetter = () => {
    throw new Error("writeback axios not injected");
  };
  postToTallyFn = null;
  hardSyncActiveFn = null;
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

function isHardSyncActive() {
  if (hardSyncActiveFn) return hardSyncActiveFn();
  try {
    return require("./jobCoordinator").coordinator.isActive(["hard_sync"]);
  } catch (_) {
    return false;
  }
}

/** What the backend is told about one Tally post. */
function resultReport(tallyResult) {
  const success = tallyResult?.status === true;
  if (success) {
    return {
      success: true,
      tallyVoucherNumber: tallyResult.voucherNumber || null,
      tallyId: tallyResult.tallyId || null,
    };
  }
  if (tallyResult?.outcomeUnknown) {
    return {
      success: false,
      outcomeUnknown: true,
      errorCode: "OUTCOME_UNKNOWN",
      errorMessage: tallyResult.message || "Tally did not confirm the entry",
    };
  }
  return {
    success: false,
    errorCode: tallyResult?.notSent ? "TALLY_UNREACHABLE" : "TALLY_ERROR",
    errorMessage: tallyResult?.message || "Tally posting failed",
  };
}

/**
 * Drain pending writeback entries for one company.
 * @returns {Promise<{claimed:number, posted:number, failed:number, unknown:number, held:number, unreported:number}>}
 */
async function processCompanyWriteback(companyGuid, { limit = DEFAULT_LIMIT } = {}) {
  const result = { claimed: 0, posted: 0, failed: 0, unknown: 0, held: 0, unreported: 0 };
  if (!companyGuid) return result;
  if (inFlightCompanies.has(companyGuid)) return result;
  if (isHardSyncActive()) {
    info(`[writeback] holding entries for ${companyGuid} while Hard Sync runs`);
    return result;
  }

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
      // A Hard Sync that starts mid-drain holds the rest without claiming them.
      if (isHardSyncActive()) {
        result.held += 1;
        continue;
      }

      let report = null;
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
        report = resultReport(tallyResult);
        await axiosInstance.post(`/tally/desktop/writeback/${item.outboxId}/result`, report);

        if (report.success) result.posted += 1;
        else if (report.outcomeUnknown) result.unknown += 1;
        else result.failed += 1;
        info(`[writeback] entry ${item.outboxId} → ${report.success ? "posted" : report.outcomeUnknown ? "outcome unknown" : "failed"}`);
      } catch (entryErr) {
        error(entryErr?.message, `writeback.entry.${item.outboxId}`);
        if (report) {
          // Tally already answered; only the report was lost. Send the same answer again,
          // never a failure that would let the entry be posted twice.
          result.unreported += 1;
          await axiosInstance
            .post(`/tally/desktop/writeback/${item.outboxId}/result`, report)
            .catch((e) => error(e?.message, `writeback.report.${item.outboxId}`));
          continue;
        }
        if (entryErr?.response?.status === 409) continue;
        result.failed += 1;
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
  resultReport,
  reconcilePendingWriteback,
  companyGuidsFromSelection,
  __setDepsForTests,
  resetDepsForTests,
};
