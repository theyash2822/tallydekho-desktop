// R1 / S1: Settings never saves the placeholder port before the stored one is read, and
// shows "Saved" only when the save actually succeeded. Real App + Settings in jsdom.
const test = require("node:test");
const assert = require("node:assert/strict");
const { mountApp, wait, clickText } = require("./rendererHarness");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const DEFAULT_PREFS = { selectedCompanies: [], backups: [], backupAndRestoreActivity: [], cloudBackups: [] };

function settingsHarness({ setPrefResult = true } = {}) {
  const portRead = deferred();
  const writes = [];
  const app = mountApp({
    tally: { connected: async () => false, currentJob: async () => ({ active: [], recent: [] }) },
    api: {
      pingBackend: async () => true,
      getPref: (k) => (k === "port" ? portRead.promise : Promise.resolve(DEFAULT_PREFS[k])),
      setPref: async (k, v) => { writes.push([k, v]); return k === "port" ? setPrefResult : true; },
    },
  });
  return { ...app, portRead, writes };
}

/** Remembers whether the success notice was ever shown (it hides itself after 1.2 s). */
function watchSavedNotice(w) {
  const seen = { saved: false };
  new w.MutationObserver(() => {
    if (/Saved and applied/.test(w.document.body.textContent)) seen.saved = true;
  }).observe(w.document.body, { childList: true, subtree: true, characterData: true });
  return seen;
}

const portInput = (w) => [...w.document.querySelectorAll("input[type=number]")][0];
const saveButton = (w) => [...w.document.querySelectorAll("button")].find((b) => /^\s*Save\s*$/.test(b.textContent));

test("Save before the stored port is read does nothing; afterwards the stored 9001 is kept", async (t) => {
  const { dom, w, errors, portRead, writes } = settingsHarness();
  t.after(() => dom.window.close());
  await wait(50);
  clickText(w, /^Settings$/);
  await wait(50);
  assert.equal(portInput(w).disabled, true, "port field waits for the stored value");
  saveButton(w).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await wait(50);
  assert.deepEqual(writes.filter(([k]) => k === "port"), [], "no placeholder 9000 was written");

  portRead.resolve(9001);
  await wait(80);
  assert.equal(portInput(w).value, "9001");
  const notice = watchSavedNotice(w);
  saveButton(w).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await wait(80);
  assert.deepEqual(writes.filter(([k]) => k === "port"), [["port", 9001]]);
  assert.equal(notice.saved, true, "success shown after the save succeeded");
  assert.deepEqual(errors, []);
});

test("a failed save shows no success notice", async (t) => {
  const { dom, w, portRead } = settingsHarness({ setPrefResult: false });
  t.after(() => dom.window.close());
  portRead.resolve(9001);
  await wait(50);
  clickText(w, /^Settings$/);
  await wait(50);
  const notice = watchSavedNotice(w);
  saveButton(w).dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await wait(80);
  assert.equal(notice.saved, false, "no success notice for a failed save");
});

// R1 / 16: the Tally status poll is completion-driven: never two checks at once, and it
// backs off while Tally does not answer.
test("slow status checks never overlap; offline polling backs off", async (t) => {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const companiesCalls = [];
  const app = mountApp({
    tally: {
      connected: async () => {
        calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 120)); // slower than the 50 ms (sped-up 5 s) interval
        inFlight--;
        return false;
      },
      companies: async (opts) => { companiesCalls.push(opts); return { status: "ok", companies: [] }; },
      currentJob: async () => ({ active: [], recent: [] }),
    },
    api: { pingBackend: async () => true, getPref: async (k) => DEFAULT_PREFS[k], setPref: async () => true },
  });
  t.after(() => app.dom.window.close());
  await wait(1500);
  assert.equal(maxInFlight, 1, "one status check at a time");
  assert.ok(calls <= 8, `offline polling backed off (${calls} checks in 1.5 s)`);
  assert.ok(companiesCalls.every((o) => !o?.ledgerCountsFor), "polls never ask for ledger counts");
});
