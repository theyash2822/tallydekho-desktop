const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const load = () =>
  import(pathToFileURL(path.join(__dirname, "../renderer/app/utils/selectionMerge.js")).href);

const fy = (y) => ({ finYear: `${y}-${y + 1}`, begin: `${y}0401`, end: `${y + 1}0331` });
const found = (guid, name, years, extra = {}) => ({
  guid,
  name,
  years,
  destination: "D",
  isCurrentCompany: false,
  ledgersCount: null,
  ...extra,
});
const ok = (companies) => ({ status: "ok", observedAt: "2026-10-08T00:00:00.000Z", companies });

test("an unavailable or malformed discovery leaves the selection untouched", async () => {
  const { mergeDiscovery } = await load();
  const selected = [{ id: "g1", guid: "g1", name: "A", years: [fy(2024)], isSynced: true }];
  for (const discovery of [undefined, { status: "unavailable", companies: [] }, { status: "ok" }]) {
    const r = mergeDiscovery({ selected, discovery });
    assert.equal(r.available, false);
    assert.equal(r.changed, false);
    assert.equal(r.selection, selected);
    assert.deepEqual(r.identityConflicts, []);
  }
});

test("a selected company that is not open stays selected and is marked unavailable", async () => {
  const { mergeDiscovery } = await load();
  const selected = [
    { id: "g1", guid: "g1", name: "A", years: [fy(2024)] },
    { id: "g2", guid: "g2", name: "B", years: [fy(2024)] },
  ];
  const r = mergeDiscovery({ selected, discovery: ok([found("g1", "A", [fy(2024)])]) });
  assert.equal(r.selection.length, 2);
  assert.equal(r.selection[0].available, true);
  assert.equal(r.selection[0].lastSeenAt, "2026-10-08T00:00:00.000Z");
  assert.equal(r.selection[1].available, false);
  assert.deepEqual(r.selection[1].years, [fy(2024)], "FY choice preserved");
});

test("Tally open with no companies marks everything unavailable, removes nothing", async () => {
  const { mergeDiscovery } = await load();
  const selected = [{ id: "g1", guid: "g1", name: "A", years: [fy(2024)] }];
  const r = mergeDiscovery({ selected, discovery: ok([]) });
  assert.equal(r.selection.length, 1);
  assert.equal(r.selection[0].available, false);
});

test("FY selection is kept and only later years are auto-added", async () => {
  const { mergeDiscovery } = await load();
  const selected = [{ id: "g1", guid: "g1", name: "A", years: [fy(2023)] }];
  const r = mergeDiscovery({ selected, discovery: ok([found("g1", "A renamed", [fy(2022), fy(2023), fy(2024)])]) });
  assert.deepEqual(r.selection[0].years.map((y) => y.finYear), ["2023-2024", "2024-2025"]);
  assert.equal(r.selection[0].name, "A renamed");
  assert.equal(r.selection[0].allYears.length, 3);
});

test("auto-select only when empty and not cleared by the user", async () => {
  const { mergeDiscovery } = await load();
  const list = [found("g1", "A", [fy(2022), fy(2023), fy(2024)], { isCurrentCompany: true }), found("g2", "B", [fy(2024)])];
  const auto = mergeDiscovery({ selected: [], discovery: ok(list) });
  assert.equal(auto.autoSelected, true);
  assert.deepEqual(auto.selection.map((c) => c.guid), ["g1"]);
  assert.equal(auto.selection[0].years.length, 2);

  const cleared = mergeDiscovery({ selected: [], discovery: ok(list), clearedByUser: true });
  assert.deepEqual(cleared.selection, []);
  assert.equal(cleared.autoSelected, false);
});

test("GUID-change alert needs a same-name company under a new GUID", async () => {
  const { mergeDiscovery } = await load();
  const selected = [
    { id: "old", guid: "old", name: "Acme Ltd", years: [fy(2024)], isSynced: true },
    { id: "gone", guid: "gone", name: "Closed Co", years: [fy(2024)], isSynced: true },
    { id: "unsynced", guid: "unsynced", name: "Fresh", years: [fy(2024)] },
  ];
  const r = mergeDiscovery({
    selected,
    discovery: ok([found("new", " acme ltd ", [fy(2024)]), found("x", "Fresh", [fy(2024)])]),
  });
  assert.deepEqual(r.identityConflicts, [{ name: "Acme Ltd", oldGuid: "old", newGuid: "new" }]);
});

test("activeSyncJob picks sync or hard_sync only", async () => {
  const { activeSyncJob } = await load();
  assert.equal(activeSyncJob(undefined), null);
  assert.equal(activeSyncJob({ active: [{ type: "backup" }] }), null);
  assert.equal(activeSyncJob({ active: [{ type: "backup" }, { type: "hard_sync", id: "j" }] }).id, "j");
});
