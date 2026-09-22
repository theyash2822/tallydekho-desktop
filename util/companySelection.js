/**
 * Company selection, scoped to the workspace this Desktop is currently bound to.
 *
 * The selection legitimately survives restarts, temporary offline and backend
 * reconnects, but it must never carry over to a different workspace after an
 * unpair / re-pair / Desktop replacement. Every read is therefore checked
 * against the workspace that owned the selection when it was written.
 *
 * This is the only supported accessor — nothing else should touch the
 * `selectedCompanies` store key directly.
 */
let store = null;

function getStore() {
  if (!store) store = require("./store");
  return store;
}

function __setStoreForTests(next) {
  store = next;
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

/**
 * Selection for the current binding. Returns an empty list when the stored
 * selection belongs to a different workspace.
 */
function getSelectedCompanies() {
  const bound = getBoundWorkspaceId();
  const owner = getSelectionOwner();

  if (bound && owner && owner !== bound) return [];

  // A selection written before scoping existed has no owner. Adopt it for the
  // current binding rather than discarding a working setup.
  if (bound && !owner && readRaw().length) {
    getStore().set(SELECTION_OWNER_KEY, bound);
  }

  return readRaw();
}

function setSelectedCompanies(companies) {
  const list = Array.isArray(companies) ? companies : [];
  getStore().set(SELECTION_KEY, list);

  const bound = getBoundWorkspaceId();
  if (bound) {
    getStore().set(SELECTION_OWNER_KEY, bound);
  } else {
    getStore().delete(SELECTION_OWNER_KEY);
  }
  return list;
}

function clearSelectedCompanies() {
  getStore().set(SELECTION_KEY, []);
  getStore().delete(SELECTION_OWNER_KEY);
}

/**
 * Record the workspace resolved from the server-side device binding.
 * A change of workspace drops any selection owned by the previous one.
 *
 * @returns {boolean} true when the selection was dropped
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

  const owner = getSelectionOwner();
  if (owner && owner !== next) {
    clearSelectedCompanies();
    return true;
  }
  return false;
}

/** Full local tenant reset — used by an actual unpair or a revoked binding. */
function clearWorkspaceBinding() {
  const s = getStore();
  s.delete(BINDING_KEY);
  s.delete("lastSync");
  s.delete("myLastSyncEpoch");
  clearSelectedCompanies();
}

module.exports = {
  SELECTION_KEY,
  SELECTION_OWNER_KEY,
  BINDING_KEY,
  getSelectedCompanies,
  setSelectedCompanies,
  clearSelectedCompanies,
  getBoundWorkspaceId,
  setBoundWorkspaceId,
  clearWorkspaceBinding,
  __setStoreForTests,
};
