#!/usr/bin/env node
// C1 desktop: server-confirmed selection publishing (util/selectionSync.js).
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const sync = require("../util/selectionSync");

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, JSON.parse(JSON.stringify(v))), delete: (k) => m.delete(k), m };
}

let store;
let saved;
let posts;
let respond;
let paired;
let bound;
let hardSync;
let syncBusy;
let ids;

const A = { id: "A", guid: "A", name: "Alpha", years: [{ finYear: "2025-2026", begin: "20250401", end: "20260331" }], allYears: [] };
const B = { id: "B", guid: "B", name: "Beta", years: [{ finYear: "2025-2026", begin: "20250401", end: "20260331" }], allYears: [] };

beforeEach(() => {
  store = memStore();
  saved = [A, B];
  posts = [];
  paired = true;
  bound = "ws-1";
  hardSync = false;
  syncBusy = false;
  ids = 0;
  respond = async (body) => ({ data: { status: true, data: { revision: body.baseRevision + 1, removed: [] } } });
  sync.__setDepsForTests({
    post: async (url, body) => {
      posts.push({ url, body: JSON.parse(JSON.stringify(body)) });
      return respond(body);
    },
    get: async () => ({ data: { status: true, data: { revision: 7, companies: [{ guid: "A", years: ["2025-2026"] }] } } }),
    store,
    selection: {
      getSelectedCompanies: () => saved,
      setSelectedCompanies: (l) => { saved = l; return l; },
      getBoundWorkspaceId: () => bound,
    },
    isPaired: () => paired,
    isHardSyncActive: () => hardSync,
    isSyncBusy: () => syncBusy,
    newId: () => `op-${++ids}`,
  });
});

afterEach(() => sync.__setDepsForTests(null));

test("paired: the list is written only after the server confirms, with the revision it returned", async () => {
  const r = await sync.publishSelection([A]);
  assert.equal(r.ok, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/desktop/selection");
  assert.equal(posts[0].body.baseRevision, 0);
  assert.deepEqual(posts[0].body.companies.map((c) => c.guid), ["A"]);
  assert.deepEqual(saved.map((c) => c.guid), ["A"]);
  assert.equal(sync.getConfirmedRevision(), 1);
  assert.equal(store.get(sync.PENDING_KEY), undefined);
});

test("server refuses or is unreachable: the saved list stays as it was", async () => {
  respond = async () => { throw Object.assign(new Error("x"), { response: { status: 409, data: { code: "HARD_SYNC_ACTIVE", message: "frozen" } } }); };
  let r = await sync.publishSelection([A]);
  assert.equal(r.ok, false);
  assert.deepEqual(saved.map((c) => c.guid), ["A", "B"]);
  assert.equal(store.get(sync.PENDING_KEY), undefined, "a definite refusal leaves nothing pending");

  respond = async () => { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); };
  r = await sync.publishSelection([A]);
  assert.equal(r.code, "NETWORK");
  assert.deepEqual(saved.map((c) => c.guid), ["A", "B"]);
});

test("lost response: the same operation is re-sent and the server's original result is adopted", async () => {
  respond = async () => { throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" }); };
  const r = await sync.publishSelection([A]);
  assert.equal(r.pending, true);
  assert.deepEqual(saved.map((c) => c.guid), ["A", "B"], "unconfirmed change not applied locally");
  const pending = store.get(sync.PENDING_KEY);
  assert.equal(pending.body.operationId, "op-1");

  respond = async (body) => ({ data: { status: true, data: { revision: 1, replayed: true, removed: [] }, echo: body } });
  const settled = await sync.reconcilePendingSelection();
  assert.equal(settled.ok, true);
  assert.equal(posts.at(-1).body.operationId, "op-1", "same operationId, never a different destructive request");
  assert.deepEqual(saved.map((c) => c.guid), ["A"]);
  assert.equal(sync.getConfirmedRevision(), 1);
  assert.equal(store.get(sync.PENDING_KEY), undefined);
});

test("stale revision: refused, revision reloaded, nothing applied", async () => {
  respond = async () => { throw Object.assign(new Error("x"), { response: { status: 409, data: { code: "SELECTION_STALE", data: { currentRevision: 7 } } } }); };
  const r = await sync.publishSelection([A, B]);
  assert.equal(r.code, "SELECTION_STALE");
  assert.equal(sync.getConfirmedRevision(), 7);
  assert.deepEqual(saved.map((c) => c.guid), ["A"], "local list narrowed to the server's confirmed scope");
});

test("frozen during hard sync and refused during a sync — before any request", async () => {
  hardSync = true;
  assert.equal((await sync.publishSelection([A])).code, "HARD_SYNC_ACTIVE");
  hardSync = false;
  syncBusy = true;
  assert.equal((await sync.publishSelection([A])).code, "SYNC_IN_PROGRESS");
  assert.equal(posts.length, 0);
});

test("renderer writes cannot add, drop or re-year companies while paired; metadata is kept", () => {
  saved = [A];
  const echoed = sync.mergeRendererSelection([{ ...A, name: "Alpha renamed", isSynced: true, years: [] }, B]);
  assert.deepEqual(echoed.map((c) => c.guid), ["A"]);
  assert.equal(echoed[0].name, "Alpha renamed");
  assert.equal(echoed[0].isSynced, true);
  assert.deepEqual(echoed[0].years, A.years);
  assert.deepEqual(sync.mergeRendererSelection([]).map((c) => c.guid), ["A"], "an empty echo is not a removal");

  paired = false;
  assert.deepEqual(sync.mergeRendererSelection([B]).map((c) => c.guid), ["B"], "unpaired edits stay local");
});

test("first paired sync adopts the saved list once; an existing server revision narrows instead", async () => {
  const fresh = await sync.ensureSelectionConfirmed();
  assert.equal(fresh.ok, true);
  assert.equal(fresh.revision, 7, "server already had revision 7: adopt it, do not overwrite");
  assert.deepEqual(saved.map((c) => c.guid), ["A"]);
  assert.equal(posts.length, 0);
});

test("an empty selection is only sent with explicit confirmation", async () => {
  await sync.publishSelection([]);
  assert.equal(posts[0].body.confirmEmpty, true);
  assert.deepEqual(saved, []);
});
