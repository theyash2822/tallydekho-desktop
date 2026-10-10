/**
 * Server-confirmed company/year selection (TD-DESKTOP-CORE C1).
 *
 * While paired, the desktop's saved selection changes only through the backend's
 * ordered /desktop/selection operation: Add Companies, Edit Years and Remove send the
 * full desired list with the last confirmed revision, and the local list is written
 * only after the server accepts it. A request whose response was lost is kept as a
 * pending operation and re-sent with the same operationId, so the server returns its
 * original result instead of applying a different change.
 */
const crypto = require("crypto");

const REQUEST_TIMEOUT_MS = 15000;
const REVISION_KEY = "selectedCompaniesRevision";
const PENDING_KEY = "selectionPendingOperation";
const NETWORK_MESSAGE = "Couldn't reach the server. Your company list was not changed. Check your internet connection and try again.";
const TIMEOUT_MESSAGE = "The server took too long to answer. TallyDekho will confirm the change when the connection is back.";

let deps = null;
let inFlight = null;

function defaultDeps() {
  const selection = require("./companySelection");
  const store = require("./store");
  return {
    post: (url, body) => require("./helper.js").axiosInstance.post(url, body, { timeout: REQUEST_TIMEOUT_MS }),
    get: (url) => require("./helper.js").axiosInstance.get(url, { timeout: REQUEST_TIMEOUT_MS }),
    store,
    selection,
    isPaired: () => selection.isDevicePaired(),
    isHardSyncActive: () => require("./jobCoordinator").coordinator.isActive(["hard_sync"]),
    isSyncBusy: () =>
      require("./jobCoordinator").coordinator.isActive(["sync", "hard_sync"]) ||
      require("./xml.js").isSyncRunning(),
    newId: () => crypto.randomUUID(),
  };
}

function getDeps() {
  if (!deps) deps = defaultDeps();
  return deps;
}

function __setDepsForTests(next) {
  deps = next;
  inFlight = null;
}

const keyOf = (c) => String(c?.guid || c?.id || "");

function getConfirmedRevision() {
  const n = Number(getDeps().store.get(REVISION_KEY));
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** Paired and bound to a workspace: membership/year changes must go through the server. */
function isServerManaged() {
  const d = getDeps();
  return d.isPaired() && !!d.selection.getBoundWorkspaceId();
}

const yearOut = (y) => ({ finYear: y.finYear, begin: y.begin, end: y.end });

function toRequestCompanies(list) {
  return list.map((c) => ({
    guid: keyOf(c),
    name: c.name || null,
    years: (c.years || []).map(yearOut),
    allYears: (c.allYears || []).map(yearOut),
  }));
}

/** Membership plus selected years: the part of the selection only the server may change. */
function selectionShape(list) {
  return (list || [])
    .map((c) => `${keyOf(c)}:${(c.years || []).map((y) => y.finYear).sort().join(",")}`)
    .sort()
    .join("|");
}

/**
 * Renderer write of `selectedCompanies` while server-managed: metadata (names, sync
 * flags, availability, allYears) is accepted for companies already confirmed; adding,
 * dropping or re-selecting years is ignored here because it needs publishSelection.
 */
function mergeRendererSelection(value) {
  const d = getDeps();
  const incoming = Array.isArray(value) ? value : [];
  if (!isServerManaged()) return d.selection.setSelectedCompanies(incoming);
  const confirmed = d.selection.getSelectedCompanies();
  const byKey = new Map(incoming.map((c) => [keyOf(c), c]));
  const merged = confirmed.map((c) => {
    const r = byKey.get(keyOf(c));
    return r ? { ...r, id: c.id, guid: c.guid, years: c.years } : c;
  });
  d.selection.setSelectedCompanies(merged);
  return merged;
}

function classifyError(err) {
  if (!err?.response) {
    const timedOut = err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT";
    return { code: timedOut ? "TIMEOUT" : "NETWORK", message: timedOut ? TIMEOUT_MESSAGE : NETWORK_MESSAGE, uncertain: timedOut };
  }
  const data = err.response.data || {};
  return {
    code: data.code || `HTTP_${err.response.status}`,
    message: data.message || "Could not update the company selection. Try again.",
    data: data.data,
    uncertain: err.response.status >= 500,
  };
}

async function send(op) {
  const d = getDeps();
  const response = await d.post("/desktop/selection", op.body);
  const body = response?.data || {};
  if (!body.status) {
    const e = new Error(body.message || "Selection refused");
    e.response = { status: 400, data: body };
    throw e;
  }
  return body.data;
}

function commit(op, result) {
  const d = getDeps();
  d.selection.setSelectedCompanies(op.list);
  d.store.set(REVISION_KEY, Number(result.revision) || 0);
  d.store.delete(PENDING_KEY);
}

/**
 * Publish the full desired list. removalModes: { [guid]: 'deactivate' | 'complete' }.
 * Returns { ok, list, revision, removed } or { ok:false, code, message, pending }.
 */
async function publishSelection(nextList, { removalModes = {}, confirmEmpty = false } = {}) {
  const d = getDeps();
  const list = Array.isArray(nextList) ? nextList : [];
  if (!isServerManaged()) {
    if (d.isPaired()) {
      return { ok: false, code: "BINDING_PENDING", message: "Connecting to your workspace — try again in a moment." };
    }
    // Unpaired: a local list only; the server is told when this desktop is paired.
    return { ok: true, localOnly: true, list: d.selection.setSelectedCompanies(list) };
  }
  if (d.isHardSyncActive()) {
    return { ok: false, code: "HARD_SYNC_ACTIVE", message: "Company selection is locked while Hard Sync is running." };
  }
  if (d.isSyncBusy()) {
    return { ok: false, code: "SYNC_IN_PROGRESS", message: "Wait for the sync to finish before changing companies." };
  }
  if (inFlight) {
    return { ok: false, code: "SELECTION_IN_PROGRESS", message: "A company change is already being saved." };
  }
  const pending = d.store.get(PENDING_KEY);
  if (pending) {
    const settled = await reconcilePendingSelection();
    if (!settled.ok) return settled;
  }
  const op = {
    list,
    body: {
      operationId: d.newId(),
      baseRevision: getConfirmedRevision(),
      companies: toRequestCompanies(list),
      removalModes,
      confirmEmpty: confirmEmpty || list.length === 0,
    },
  };
  d.store.set(PENDING_KEY, op);
  inFlight = op;
  try {
    const result = await send(op);
    commit(op, result);
    return { ok: true, list, revision: result.revision, removed: result.removed || [] };
  } catch (err) {
    const e = classifyError(err);
    if (!e.uncertain) d.store.delete(PENDING_KEY);
    if (e.code === "SELECTION_STALE") {
      await refreshConfirmedRevision().catch(() => {});
      return { ok: false, code: e.code, message: "The company list changed on the server. It has been reloaded — please try again." };
    }
    return { ok: false, code: e.code, message: e.message, pending: e.uncertain };
  } finally {
    inFlight = null;
  }
}

/** Re-send a change whose answer was lost. Same operationId → the server's original result. */
async function reconcilePendingSelection() {
  const d = getDeps();
  const op = d.store.get(PENDING_KEY);
  if (!op?.body?.operationId) return { ok: true, none: true };
  if (!isServerManaged()) return { ok: false, code: "BINDING_PENDING", message: "Connecting to your workspace — try again in a moment." };
  try {
    const result = await send(op);
    commit(op, result);
    return { ok: true, reconciled: true, revision: result.revision };
  } catch (err) {
    const e = classifyError(err);
    if (!e.uncertain) {
      // Refused for good (stale base, conflict): the change never happened; drop it.
      d.store.delete(PENDING_KEY);
      if (e.code === "SELECTION_STALE") await refreshConfirmedRevision().catch(() => {});
      return { ok: false, code: e.code, message: "An earlier company change was not saved. Please make it again." };
    }
    return { ok: false, code: e.code, message: e.message, pending: true };
  }
}

/** Server's confirmed revision; local membership is kept (the server only ever narrows it). */
async function refreshConfirmedRevision() {
  const d = getDeps();
  const res = await d.get("/desktop/selection");
  const data = res?.data?.data;
  if (!data) return null;
  d.store.set(REVISION_KEY, Number(data.revision) || 0);
  const active = new Map((data.companies || []).map((c) => [c.guid, new Set(c.years || [])]));
  if (Number(data.revision) > 0) {
    const local = d.selection.getSelectedCompanies();
    const narrowed = local
      .filter((c) => active.has(keyOf(c)))
      .map((c) => ({ ...c, years: (c.years || []).filter((y) => active.get(keyOf(c)).has(y.finYear)) }))
      .filter((c) => c.years.length);
    if (selectionShape(narrowed) !== selectionShape(local)) d.selection.setSelectedCompanies(narrowed);
  }
  return data;
}

/**
 * Before a paired sync: settle a lost change and adopt the saved list once for a
 * workspace that has never confirmed one. Returns { ok, revision } or a refusal.
 */
async function ensureSelectionConfirmed() {
  const d = getDeps();
  if (!isServerManaged()) return { ok: true, revision: 0, unmanaged: true };
  const settled = await reconcilePendingSelection();
  if (!settled.ok) return settled;
  if (getConfirmedRevision() === 0) {
    const server = await refreshConfirmedRevision().catch(() => null);
    if (server && Number(server.revision) > 0) return { ok: true, revision: Number(server.revision) };
    const list = d.selection.getSelectedCompanies();
    if (!list.length) return { ok: true, revision: 0 };
    const op = {
      list,
      body: { operationId: d.newId(), baseRevision: 0, companies: toRequestCompanies(list), removalModes: {}, confirmEmpty: false },
    };
    d.store.set(PENDING_KEY, op);
    try {
      const result = await send(op);
      commit(op, result);
    } catch (err) {
      const e = classifyError(err);
      if (!e.uncertain) d.store.delete(PENDING_KEY);
      return { ok: false, code: e.code, message: e.message };
    }
  }
  return { ok: true, revision: getConfirmedRevision() };
}

module.exports = {
  REVISION_KEY,
  PENDING_KEY,
  publishSelection,
  reconcilePendingSelection,
  refreshConfirmedRevision,
  ensureSelectionConfirmed,
  mergeRendererSelection,
  getConfirmedRevision,
  isServerManaged,
  selectionShape,
  __setDepsForTests,
};
