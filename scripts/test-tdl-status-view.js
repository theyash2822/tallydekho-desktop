/* Settings → Bill Outstanding TDL: UI state mapping + Check now / Retry setup restart rules. */
const { test, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const storePath = require.resolve("../util/store");
require.cache[storePath] = {
  id: storePath,
  filename: storePath,
  loaded: true,
  exports: { get: () => undefined, set: () => {}, delete: () => {} },
};

const tdl = require("../util/ensureBillOutstandingTdl");

let view;
const viewReady = import(
  path.join(__dirname, "../renderer/app/utils/tdlStatusView.js")
).then((m) => {
  view = m;
});

const TALLY_DIR = "C:\\TallyPrime";
const INI_OK = { found: true, userTdlYes: true, tdlListed: true, quotedOk: true };

function installedLinked(overrides = {}) {
  return {
    skipped: false,
    tallyDir: TALLY_DIR,
    tdlPresent: true,
    iniFound: true,
    userTdlYes: true,
    tdlListed: true,
    quotedOk: true,
    tdlStatus: null,
    missing: [],
    ...overrides,
  };
}

/** Fake Tally: `liveSeq` statuses are returned in order by liveStatus/checkHealth. */
function fakeTally({ liveSeq, activateOk = true }) {
  const calls = { activate: 0, live: 0, check: 0 };
  let i = 0;
  const next = () => liveSeq[Math.min(i++, liveSeq.length - 1)];
  tdl.__setDepsForTests({
    platform: () => "win32",
    fileExists: () => true,
    readIni: () => INI_OK,
    detect: async () => ({ path: TALLY_DIR, source: "test" }),
    apply: () => ({ status: true }),
    companyMeta: () => ({ companyName: "Demo", companyNumber: 1 }),
    wait: async () => {},
    liveStatus: async () => {
      calls.live++;
      return { tdlStatus: next(), billRows: 0, version: "1.1.0" };
    },
    checkHealth: async () => {
      calls.check++;
      return { status: next() };
    },
    activate: async () => {
      calls.activate++;
      return activateOk
        ? { status: true, message: "Tally restarted" }
        : { status: false, message: "Could not restart Tally — open Tally, then Retry setup." };
    },
  });
  return calls;
}

beforeEach(async () => {
  await viewReady;
  tdl.__setDepsForTests(null);
});
after(() => tdl.__setDepsForTests(null));

test("installed + linked + not confirmed → Not active in Tally (not Needs setup)", () => {
  for (const tdlStatus of [null, "UNKNOWN", "NOT_LOADED", "HEALTH_MISSING", "INVALID_RESPONSE"]) {
    const vm = view.tdlViewModel(installedLinked({ tdlStatus }));
    assert.equal(vm.state, view.TDL_UI_STATE.NOT_ACTIVE, String(tdlStatus));
    assert.equal(vm.badge, "Not active in Tally");
    assert.notEqual(vm.badge, "Needs setup");
    assert.equal(vm.rows.file, "Installed ✓");
    assert.equal(vm.rows.ini, "Linked ✓");
    assert.equal(vm.rows.inTally, "Not active");
    assert.match(vm.message, /Tally has not confirmed the Bill Outstanding add-on/);
    assert.match(vm.message, /Normal Sync and Hard Sync never restart Tally/);
  }
});

test("active health check → Ready / Active ✓", () => {
  const vm = view.tdlViewModel(installedLinked({ tdlStatus: "ACTIVE" }));
  assert.equal(vm.state, view.TDL_UI_STATE.READY);
  assert.equal(vm.badge, "Ready");
  assert.equal(vm.tone, "success");
  assert.equal(vm.rows.inTally, "Active ✓");
});

test("mapping: disk/ini problems → Needs setup; others map to their own state", () => {
  const S = view.TDL_UI_STATE;
  const d = view.deriveTdlUiState;
  assert.equal(d(null), S.CHECKING);
  assert.equal(d(view.healthError("boom")), S.ERROR);
  assert.equal(d({ skipped: true }), S.NOT_REQUIRED);
  assert.equal(d(installedLinked({ tallyDir: null })), S.FOLDER_NOT_FOUND);
  assert.equal(d(installedLinked({ tdlPresent: false, tdlStatus: "ACTIVE" })), S.NOT_INSTALLED);
  assert.equal(d(installedLinked({ tdlListed: false })), S.NOT_LINKED);
  assert.equal(d(installedLinked({ userTdlYes: false })), S.NOT_LINKED);
  assert.equal(d(installedLinked({ quotedOk: false })), S.NOT_LINKED);
  assert.equal(d(installedLinked({ tdlStatus: "ACTIVE_LEGACY" })), S.OUTDATED);
  assert.equal(d(installedLinked({ tdlStatus: "ACTIVE_OUTDATED" })), S.OUTDATED);
  assert.equal(d(installedLinked({ tdlStatus: "TALLY_TIMEOUT" })), S.TALLY_UNREACHABLE);
  for (const s of [S.NOT_INSTALLED, S.NOT_LINKED, S.FOLDER_NOT_FOUND]) {
    const h = s === S.NOT_INSTALLED
      ? installedLinked({ tdlPresent: false })
      : s === S.NOT_LINKED
      ? installedLinked({ tdlListed: false })
      : installedLinked({ tallyDir: null });
    assert.equal(view.tdlViewModel(h).badge, "Needs setup");
  }
  const busy = view.tdlViewModel(installedLinked({ tdlStatus: "ACTIVE" }), { busy: true });
  assert.equal(busy.badge, "Checking…");
  assert.equal(busy.rows.file, "Installed ✓");
  assert.equal(view.tdlViewModel(view.healthError("boom")).message, "boom");
});

test("Check now (getTdlHealth) never restarts Tally", async () => {
  const calls = fakeTally({ liveSeq: ["NOT_LOADED"] });
  const h = await tdl.getTdlHealth();
  assert.equal(calls.activate, 0);
  assert.equal(h.activateResult, null);
  assert.deepEqual(h.missing, []);
  assert.equal(view.deriveTdlUiState(h), view.TDL_UI_STATE.NOT_ACTIVE);
});

test("Retry setup restarts Tally when not active, re-checks health, and reaches Ready", async () => {
  const calls = fakeTally({ liveSeq: ["NOT_LOADED", "ACTIVE"] });
  const h = await tdl.setupTdl();
  assert.equal(calls.activate, 1);
  assert.ok(calls.check >= 1, "health re-checked after restart");
  assert.equal(h.tdlStatus, "ACTIVE");
  assert.equal(view.tdlViewModel(h).badge, "Ready");
  assert.equal(view.setupResultNote(h).tone, "success");
});

test("Retry setup does not restart Tally when already active", async () => {
  const calls = fakeTally({ liveSeq: ["ACTIVE"] });
  await tdl.setupTdl();
  assert.equal(calls.activate, 0);
});

test("failed Retry setup (still not confirmed after restart) does not show Ready", async () => {
  fakeTally({ liveSeq: ["NOT_LOADED"] });
  const h = await tdl.setupTdl();
  const vm = view.tdlViewModel(h);
  assert.equal(vm.state, view.TDL_UI_STATE.NOT_ACTIVE);
  assert.equal(vm.badge, "Not active in Tally");
  assert.equal(vm.rows.inTally, "Not active");
  const note = view.setupResultNote(h);
  assert.equal(note.tone, "danger");
  assert.doesNotMatch(note.text, /success/i);
});

test("failed restart surfaces the restart error and never shows Ready", async () => {
  fakeTally({ liveSeq: ["NOT_LOADED"], activateOk: false });
  const h = await tdl.setupTdl();
  assert.notEqual(view.deriveTdlUiState(h), view.TDL_UI_STATE.READY);
  const note = view.setupResultNote(h);
  assert.equal(note.tone, "danger");
  assert.match(note.text, /Could not restart Tally/);
});
