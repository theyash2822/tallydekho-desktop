// R1 / 09: renderer job state comes from the coordinator only. A refused start (another
// job owns the slot) never shows this Desktop as syncing and reports the refusal.
const test = require("node:test");
const assert = require("node:assert/strict");
const { mountApp, wait } = require("./rendererHarness");

const year = { finYear: "2025-2026", begin: "20250401", end: "20260331" };
const company = { id: "g-1", guid: "g-1", name: "Synthetic Co", years: [year], allYears: [year], isCurrentCompany: true, path: "C:\\Tally\\1" };
const PREFS = { selectedCompanies: [company], backups: [], backupAndRestoreActivity: [], port: 9000 };

test("Sync Now refused by admission never shows 'Stop Syncing' and explains why", async (t) => {
  const starts = [];
  const app = mountApp({
    tally: {
      connected: async () => true,
      companies: async () => ({ status: "ok", observedAt: new Date().toISOString(), companies: [{ ...company, destination: "C:\\Tally\\1" }] }),
      currentJob: async () => ({ active: [{ id: "backup-1", type: "backup", state: "running" }], recent: [] }),
      startSync: async (args) => {
        starts.push(args);
        return { status: false, rejected: true, code: "JOB_CONFLICT", message: "A backup is in progress. Try again when it finishes." };
      },
    },
    api: {
      pingBackend: async () => true,
      getPref: async (k) => PREFS[k],
      setPref: async () => true,
      reconcilePairing: async () => ({ reachable: true, data: { name: "Owner", os: "Mobile", last: null } }),
    },
  });
  t.after(() => app.dom.window.close());
  const { w } = app;
  await wait(400);
  const button = [...w.document.querySelectorAll("button")].find((b) => /Sync Now/.test(b.textContent));
  assert.ok(button, "Sync Now is available");
  let showedStop = false;
  new w.MutationObserver(() => {
    if (/Stop Syncing/.test(w.document.body.textContent)) showedStop = true;
  }).observe(w.document.body, { childList: true, subtree: true, characterData: true });
  button.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await wait(200);
  assert.equal(starts.length, 1);
  assert.equal(showedStop, false, "the UI never claimed a sync was running");
  assert.match(w.document.body.textContent, /backup is in progress/i);
  assert.deepEqual(app.errors, []);
});
