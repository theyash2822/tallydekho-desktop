/**
 * Desktop "Remove company": Deactivate (copied data kept 30 days) or Completely Remove
 * (copied data deleted now). While paired the removal is one confirmed selection change
 * on the server (util/selectionSync.js), so mobile/web lose access at once and a sync
 * planned earlier cannot bring the company back. The local list changes only after the
 * server confirms; if it cannot be reached the company stays. Unpaired: local only.
 */
let deps = null;
let inFlight = false;

function getDeps() {
  if (deps) return deps;
  const selection = require("./companySelection");
  const selectionSync = require("./selectionSync");
  return {
    isPaired: () => selection.isDevicePaired(),
    getBoundWorkspaceId: () => selection.getBoundWorkspaceId(),
    // A sync is admitted synchronously, before its first await, so there is no
    // "starting but not yet running" window to cover separately.
    isSyncBusy: () =>
      require("./jobCoordinator").coordinator.isActive(["sync", "hard_sync"]) ||
      require("./xml.js").isSyncRunning(),
    getSelected: () => selection.getSelectedCompanies(),
    dropFromSelection: (guids) => {
      const drop = new Set(guids);
      selection.setSelectedCompanies(
        selection.getSelectedCompanies().filter((c) => !drop.has(c?.guid || c?.id))
      );
    },
    publish: (list, opts) => selectionSync.publishSelection(list, opts),
  };
}

function __setDepsForTests(next) {
  deps = next;
  inFlight = false;
}

function isRemovalInFlight() {
  return inFlight;
}

function normaliseGuids(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((g) => typeof g === "string").map((g) => g.trim()).filter(Boolean))];
}

async function removeCompanies(rawGuids, mode = "deactivate") {
  const guids = normaliseGuids(rawGuids);
  if (!guids.length) {
    return { ok: false, code: "INVALID_GUIDS", message: "No company selected to remove." };
  }
  const removalMode = mode === "complete" ? "complete" : "deactivate";

  const d = getDeps();
  if (inFlight) {
    return { ok: false, code: "REMOVAL_IN_PROGRESS", message: "A removal is already in progress." };
  }
  if (d.isSyncBusy()) {
    return { ok: false, code: "SYNC_IN_PROGRESS", message: "Wait for the sync to finish before removing a company." };
  }
  if (!d.isPaired()) {
    d.dropFromSelection(guids);
    return { ok: true, localOnly: true, removed: guids, notFound: [] };
  }
  // Paired but the workspace lookup after a re-pair has not landed: the list is on
  // hold and would be re-sent once bound, bringing the company back.
  if (!d.getBoundWorkspaceId()) {
    return { ok: false, code: "BINDING_PENDING", message: "Connecting to your workspace — try again in a moment." };
  }

  inFlight = true;
  try {
    const current = d.getSelected();
    const drop = new Set(guids);
    const present = current.filter((c) => drop.has(c?.guid || c?.id)).map((c) => c.guid || c.id);
    const presentSet = new Set(present);
    const next = current.filter((c) => !drop.has(c?.guid || c?.id));
    const removalModes = Object.fromEntries(guids.map((g) => [g, removalMode]));
    const result = await d.publish(next, { removalModes, confirmEmpty: next.length === 0 });
    if (!result.ok) {
      return { ok: false, code: result.code || "REMOVE_FAILED", message: result.message || "Could not remove the company. Try again.", pending: !!result.pending };
    }
    return {
      ok: true,
      localOnly: false,
      mode: removalMode,
      removed: present,
      notFound: guids.filter((g) => !presentSet.has(g)),
      removals: result.removed || [],
    };
  } finally {
    inFlight = false;
  }
}

module.exports = { removeCompanies, normaliseGuids, isRemovalInFlight, __setDepsForTests };
