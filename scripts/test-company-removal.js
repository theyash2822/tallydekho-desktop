#!/usr/bin/env node
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  removeCompanies,
  normaliseGuids,
  isRemovalInFlight,
  __setDepsForTests,
} = require("../util/companyRemoval");
const { canRendererRead, canRendererWrite } = require("../util/storeAllowlist");

let calls;
let dropped;
let paired;
let bound;
let syncBusy;
let respond;
let selected;

// The paired path publishes the remaining list through util/selectionSync (tested in
// test-selection-sync.js); here `publish` stands in for it.
beforeEach(() => {
  calls = [];
  dropped = [];
  paired = true;
  bound = "ws-1";
  syncBusy = false;
  selected = [{ guid: "A", years: [] }, { guid: "B", years: [] }, { guid: "C", years: [] }];
  respond = async () => ({ ok: true, list: [], removed: [] });
  __setDepsForTests({
    publish: (list, opts) => {
      calls.push({ list: list.map((c) => c.guid), opts });
      return respond(list, opts);
    },
    getSelected: () => selected,
    isPaired: () => paired,
    getBoundWorkspaceId: () => bound,
    isSyncBusy: () => syncBusy,
    dropFromSelection: (guids) => dropped.push(guids),
  });
});

afterEach(() => __setDepsForTests(null));

test("paired: publishes the remaining list with the chosen mode; nothing dropped locally first", async () => {
  const result = await removeCompanies(["A", "A", " B ", "Z"], "complete");
  assert.deepEqual(calls, [{ list: ["C"], opts: { removalModes: { A: "complete", B: "complete", Z: "complete" }, confirmEmpty: false } }]);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "complete");
  assert.deepEqual(result.removed, ["A", "B"]);
  assert.deepEqual(result.notFound, ["Z"]);
  assert.deepEqual(dropped, [], "the confirmed list is written by selectionSync, not by a local drop");
});

test("default mode is Deactivate; removing the last company confirms the empty list", async () => {
  selected = [{ guid: "A", years: [] }];
  await removeCompanies(["A"]);
  assert.deepEqual(calls[0].opts, { removalModes: { A: "deactivate" }, confirmEmpty: true });
  assert.deepEqual(calls[0].list, []);
});

test("unpaired: removes locally without calling the backend", async () => {
  paired = false;
  assert.deepEqual(await removeCompanies(["A"]), { ok: true, localOnly: true, removed: ["A"], notFound: [] });
  assert.equal(calls.length, 0);
  assert.deepEqual(dropped, [["A"]]);
});

test("paired but workspace not bound yet: refused, list untouched", async () => {
  bound = null;
  const result = await removeCompanies(["A"]);
  assert.equal(result.ok, false);
  assert.equal(result.code, "BINDING_PENDING");
  assert.equal(calls.length, 0);
  assert.equal(dropped.length, 0);
});

test("sync running: refused before any call", async () => {
  syncBusy = true;
  const result = await removeCompanies(["A"]);
  assert.equal(result.code, "SYNC_IN_PROGRESS");
  assert.equal(calls.length, 0);
  assert.equal(dropped.length, 0);
});

test("a sync is busy from admission on: start_sync claims the slot before its first await", () => {
  const src = fs.readFileSync(path.join(__dirname, "../util/ipcRegistry.js"), "utf8");
  const start = src.slice(src.indexOf('"tally:start_sync"'), src.indexOf("if (!admission.accepted)", src.indexOf('"tally:start_sync"')));
  assert.match(start, /coordinator\.admit\(/);
  assert.doesNotMatch(start, /await /, "no await between the handler start and admission");
  const removal = fs.readFileSync(path.join(__dirname, "../util/companyRemoval.js"), "utf8");
  assert.match(removal, /coordinator\.isActive\(\["sync", "hard_sync"\]\)/);
});

test("in-flight flag blocks a second removal and is cleared afterwards", async () => {
  let release;
  respond = () =>
    new Promise((resolve) => {
      release = () => resolve({ ok: true, list: [], removed: [] });
    });
  const first = removeCompanies(["A"]);
  assert.equal(isRemovalInFlight(), true);
  assert.equal((await removeCompanies(["B"])).code, "REMOVAL_IN_PROGRESS");
  release();
  assert.equal((await first).ok, true);
  assert.equal(isRemovalInFlight(), false);
});

test("server unreachable, slow or refusing: the refusal and its message pass through, list untouched", async () => {
  respond = async () => ({ ok: false, code: "NETWORK", message: "Couldn't reach the server." });
  let result = await removeCompanies(["A"]);
  assert.deepEqual(result, { ok: false, code: "NETWORK", message: "Couldn't reach the server.", pending: false });
  respond = async () => ({ ok: false, code: "TIMEOUT", message: "will confirm", pending: true });
  result = await removeCompanies(["A"]);
  assert.equal(result.pending, true);
  respond = async () => ({ ok: false, code: "DEVICE_NOT_ACTIVE", message: "Only the paired desktop can change the company selection" });
  assert.equal((await removeCompanies(["A"])).code, "DEVICE_NOT_ACTIVE");
  assert.equal(dropped.length, 0);
  assert.equal(isRemovalInFlight(), false);
});

test("nothing to remove: refused before any call", async () => {
  assert.equal((await removeCompanies([])).ok, false);
  assert.equal((await removeCompanies(undefined)).ok, false);
  assert.deepEqual(normaliseGuids(["", 3, null, "X"]), ["X"]);
  assert.equal(calls.length, 0);
});

test("renderer may read and write the 'cleared by user' flag", () => {
  assert.equal(canRendererRead("selectionClearedByUser"), true);
  assert.equal(canRendererWrite("selectionClearedByUser"), true);
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "../util/schema.json"), "utf8"));
  assert.deepEqual(schema.properties.selectionClearedByUser, { type: "boolean", default: false });
});

test("syncs refuse to start while a removal is in flight", () => {
  const src = fs.readFileSync(path.join(__dirname, "../util/ipcRegistry.js"), "utf8");
  const start = src.slice(src.indexOf('"tally:start_sync"'), src.indexOf("coordinator.admit(", src.indexOf('"tally:start_sync"')));
  assert.match(start, /isRemovalInFlight\(\)/);
  const auto = src.slice(src.indexOf("const startAutoSync"), src.indexOf("coordinator.admit(", src.indexOf("const startAutoSync")));
  assert.match(auto, /isRemovalInFlight\(\)/);
});

test("Remove goes through the warning and the backend; empty list stays empty", () => {
  const companiesSrc = fs.readFileSync(path.join(__dirname, "../renderer/app/views/dashboard/Companies.jsx"), "utf8");
  const appSrc = fs.readFileSync(path.join(__dirname, "../renderer/app/App.jsx"), "utf8");
  const remove = companiesSrc.slice(companiesSrc.indexOf("const removeCompanyHandler"), companiesSrc.indexOf("const closeRemoveConfirm"));
  assert.doesNotMatch(remove, /updateState\("selectedCompanies"|removeSelectedCompanies\(/, "Remove must not drop companies before confirming");
  const confirm = companiesSrc.slice(companiesSrc.indexOf("const confirmRemoveHandler"));
  assert.ok(confirm.indexOf("isSyncing") < confirm.indexOf("window.api.removeCompanies(guids, mode)"), "sync re-checked on confirm");
  assert.ok(
    confirm.indexOf("window.api.removeCompanies") < confirm.indexOf("removeSelectedCompanies("),
    "backend must be told before the local list changes"
  );
  const removeFn = appSrc.slice(appSrc.indexOf("const removeSelectedCompanies"), appSrc.indexOf("const markCompaniesAdded"));
  assert.ok(removeFn.indexOf("selectedCompaniesRef.current = next") < removeFn.indexOf('updateState("selectedCompanies"'));
  assert.match(appSrc, /mergeDiscovery\(\{ selected: current, discovery, clearedByUser \}\)/);
  const mergeSrc = fs.readFileSync(path.join(__dirname, "../renderer/app/utils/selectionMerge.js"), "utf8");
  assert.match(mergeSrc, /\} else if \(!clearedByUser\) \{/, "auto-select must respect the cleared flag");
  const resetBlock = appSrc.slice(appSrc.indexOf('key == "workspaceReset"'), appSrc.indexOf("return;", appSrc.indexOf('key == "workspaceReset"')));
  assert.match(resetBlock, /selectionClearedByUserRef\.current = true/, "a reset must not lead to auto-selection");
});
