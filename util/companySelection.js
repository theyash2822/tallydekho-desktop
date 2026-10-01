/**
 * Company selection, scoped to the workspace this Desktop is currently bound to.
 *
 * The selection survives restarts, temporary offline, backend reconnects and an
 * unpair (the user removes companies by hand). It must never flow into a
 * different workspace silently: after a re-pair to another workspace the list
 * is held back ("pending") until the user confirms it, and reads return [] so
 * nothing syncs in the meantime. Every read is checked against the workspace
 * that owned the selection when it was written.
 *
 * This is the only supported accessor — nothing else should touch the
 * `selectedCompanies` store key directly.
 */
let store = null;

function getStore() {
  if (!store) store = require("./store");
  return store;
}

let pairedCheck = null;

function isDevicePaired() {
  if (pairedCheck) return pairedCheck();
  try {
    return !!require("./deviceCredential").getDeviceSecret();
  } catch (_) {
    return false;
  }
}

function __setStoreForTests(next) {
  store = next;
}

function __setPairedCheckForTests(fn) {
  pairedCheck = fn;
}

const SELECTION_KEY = "selectedCompanies";
const SELECTION_OWNER_KEY = "selectedCompaniesWorkspaceId";
const BINDING_KEY = "boundWorkspaceId";

function normaliseId(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function getBoundWorkspaceId() {
  return normaliseId(getStore().get(BINDING_KEY));
}

function getSelectionOwner() {
  return normaliseId(getStore().get(SELECTION_OWNER_KEY));
}

function readRaw() {
  const value = getStore().get(SELECTION_KEY);
  return Array.isArray(value) ? value : [];
}

/** A selection owned by another workspace that the user has not yet confirmed. */
function isSelectionPending() {
  const bound = getBoundWorkspaceId();
  const owner = getSelectionOwner();
  return !!(bound && owner && owner !== bound && readRaw().length);
}

function getPendingSelection() {
  return isSelectionPending() ? readRaw() : [];
}

/**
 * Paired again but the workspace lookup has not landed yet: a list kept from
 * before the unpair cannot be attributed to this pairing, so it is not used.
 */
function isAwaitingBinding() {
  return !!(!getBoundWorkspaceId() && getSelectionOwner() && readRaw().length && isDevicePaired());
}

/** True while the stored list must not be used: pending answer or binding not yet known. */
function isSelectionOnHold() {
  return isSelectionPending() || isAwaitingBinding();
}

/**
 * Selection for the current binding. Returns an empty list while the stored
 * selection belongs to a different workspace. While unpaired it returns the
 * kept list (syncing is blocked separately when the device is not paired).
 */
function getSelectedCompanies() {
  const bound = getBoundWorkspaceId();
  const owner = getSelectionOwner();

  if (bound && owner && owner !== bound) return [];
  if (isAwaitingBinding()) return [];

  // A selection written before scoping existed has no owner. Adopt it for the
  // current binding rather than discarding a working setup.
  if (bound && !owner && readRaw().length) {
    getStore().set(SELECTION_OWNER_KEY, bound);
  }

  return readRaw();
}

function setSelectedCompanies(companies) {
  const list = Array.isArray(companies) ? companies : [];

  // While on hold only binding / resolvePendingSelection may change the list:
  // the renderer echoes [] back and its Tally refresh auto-selects the current
  // company, and neither is the user's answer.
  if (isSelectionOnHold()) return [];

  getStore().set(SELECTION_KEY, list);

  const bound = getBoundWorkspaceId();
  if (bound) {
    getStore().set(SELECTION_OWNER_KEY, bound);
  } else if (!list.length) {
    getStore().delete(SELECTION_OWNER_KEY);
  }
  // Unpaired with companies: keep the previous owner so a re-pair can tell
  // whether this is the same workspace.
  return list;
}

function clearSelectedCompanies() {
  getStore().set(SELECTION_KEY, []);
  getStore().delete(SELECTION_OWNER_KEY);
}

/**
 * Answer to the "use the previous workspace's companies here?" prompt.
 * keep=true hands the list to the current workspace; keep=false clears it.
 *
 * @returns {Array} the selection now active for the current workspace
 */
function resolvePendingSelection(keep) {
  if (!isSelectionPending()) return getSelectedCompanies();
  if (!keep) {
    clearSelectedCompanies();
    return [];
  }
  getStore().set(SELECTION_OWNER_KEY, getBoundWorkspaceId());
  return readRaw();
}

/**
 * Record the workspace resolved from the server-side device binding.
 * A selection owned by another workspace is kept but held back as pending.
 *
 * @returns {boolean} true when the selection now needs the user's confirmation
 */
function setBoundWorkspaceId(workspaceId) {
  const next = normaliseId(workspaceId);
  const current = getBoundWorkspaceId();

  if (next === current) return false;

  if (next === null) {
    getStore().delete(BINDING_KEY);
  } else {
    getStore().set(BINDING_KEY, next);
  }

  return isSelectionPending();
}

/**
 * Local tenant reset — used by an actual unpair or a revoked binding.
 * The company list and its owner stay; see setBoundWorkspaceId for re-pair.
 */
function clearWorkspaceBinding() {
  const s = getStore();
  s.delete(BINDING_KEY);
  s.delete("lastSync");
  s.delete("myLastSyncEpoch");
}

module.exports = {
  SELECTION_KEY,
  SELECTION_OWNER_KEY,
  BINDING_KEY,
  getSelectedCompanies,
  setSelectedCompanies,
  clearSelectedCompanies,
  isSelectionPending,
  isSelectionOnHold,
  getPendingSelection,
  resolvePendingSelection,
  getBoundWorkspaceId,
  isDevicePaired,
  setBoundWorkspaceId,
  clearWorkspaceBinding,
  __setStoreForTests,
  __setPairedCheckForTests,
};
