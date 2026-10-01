/**
 * Desktop "Remove company": tell the backend first so the company disappears
 * from mobile/web right away, and only then drop it from the local selection.
 * If the backend can't be reached the removal is refused, so the desktop and
 * mobile never disagree. While unpaired there is no workspace to update, so
 * the removal is local only.
 *
 * Removal and sync exclude each other: a sync carrying the company would
 * reactivate it on the server (init-sync marks every company it sends active).
 */
const REQUEST_TIMEOUT_MS = 15000;
const NETWORK_MESSAGE = "Couldn't reach the server. Check your internet connection and try again.";
const TIMEOUT_MESSAGE = "The server took too long to answer. The company may already be hidden on mobile — try again.";

let deps = null;
let inFlight = false;
// tally:start_sync awaits Tally / the backend before it sets isSyncing.
let syncStarting = false;

function setSyncStarting(value) {
  syncStarting = !!value;
}

function getDeps() {
  if (deps) return deps;
  const selection = require("./companySelection");
  return {
    post: (url, body) => require("./helper.js").axiosInstance.post(url, body, { timeout: REQUEST_TIMEOUT_MS }),
    isPaired: () => selection.isDevicePaired(),
    getBoundWorkspaceId: () => selection.getBoundWorkspaceId(),
    isSyncBusy: () => !!require("./store").get("isSyncing") || require("./xml.js").isSyncRunning(),
    dropFromSelection: (guids) => {
      const drop = new Set(guids);
      selection.setSelectedCompanies(
        selection.getSelectedCompanies().filter((c) => !drop.has(c?.guid || c?.id))
      );
    },
  };
}

function __setDepsForTests(next) {
  deps = next;
  inFlight = false;
  syncStarting = false;
}

function isRemovalInFlight() {
  return inFlight;
}

function normaliseGuids(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((g) => typeof g === "string").map((g) => g.trim()).filter(Boolean))];
}

async function removeCompanies(rawGuids) {
  const guids = normaliseGuids(rawGuids);
  if (!guids.length) {
    return { ok: false, code: "INVALID_GUIDS", message: "No company selected to remove." };
  }

  const d = getDeps();
  if (inFlight) {
    return { ok: false, code: "REMOVAL_IN_PROGRESS", message: "A removal is already in progress." };
  }
  if (syncStarting || d.isSyncBusy()) {
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
    const response = await d.post("/desktop/companies/remove", { guids });
    const body = response?.data || {};
    if (!body.status) {
      return { ok: false, code: body.code || "REMOVE_FAILED", message: body.message || "Could not remove the company. Try again." };
    }
    // Before the in-flight flag clears, so a sync can never start with the old list.
    d.dropFromSelection(guids);
    return {
      ok: true,
      localOnly: false,
      removed: body.data?.removed || [],
      notFound: body.data?.notFound || [],
    };
  } catch (err) {
    if (!err?.response) {
      const timedOut = err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT";
      return { ok: false, code: timedOut ? "TIMEOUT" : "NETWORK", message: timedOut ? TIMEOUT_MESSAGE : NETWORK_MESSAGE };
    }
    const data = err.response.data || {};
    return {
      ok: false,
      code: data.code || `HTTP_${err.response.status}`,
      message: data.message || "Could not remove the company. Try again.",
    };
  } finally {
    inFlight = false;
  }
}

module.exports = { removeCompanies, normaliseGuids, isRemovalInFlight, setSyncStarting, __setDepsForTests };
