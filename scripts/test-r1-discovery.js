// R1 / 05: typed discovery outcomes; only complete evidence marks a company closed.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");
const { XMLParser } = require("fast-xml-parser");
const { discoveryFromResponse } = require("../util/companyDiscovery");

const parser = new XMLParser();
const parse = (t) => parser.parse(t);
const loadMerge = () => import(pathToFileURL(path.join(__dirname, "../renderer/app/utils/selectionMerge.js")).href);

const company = (guid, name, extra = "") =>
  `<COMPANY><NAME>${name}</NAME><GUID>${guid}</GUID><STARTINGFROM>20240401</STARTINGFROM><ENDINGAT>20260331</ENDINGAT>${extra}</COMPANY>`;
const envelope = (inner) => `<ENVELOPE><BODY><DATA><COLLECTION>${inner}</COLLECTION></DATA></BODY></ENVELOPE>`;
const saved = (guid, name) => ({ id: guid, guid, name, years: [], isSynced: true, available: true });

test("complete, empty, partial, LINEERROR and non-XML replies are distinct outcomes", () => {
  assert.equal(discoveryFromResponse(envelope(company("g-1", "A") + company("g-2", "B")), parse).status, "ok");
  const empty = discoveryFromResponse(envelope(""), parse);
  assert.deepEqual([empty.status, empty.companies.length], ["ok", 0]);
  const partial = discoveryFromResponse(envelope(company("g-1", "A") + "<COMPANY><NAME>B</NAME><GUID>g-2</GUID></COMPANY>"), parse);
  assert.deepEqual([partial.status, partial.companies.map((c) => c.guid), partial.skipped], ["partial", ["g-1"], 1]);
  assert.deepEqual(
    [discoveryFromResponse("<RESPONSE><LINEERROR>Could not find Report</LINEERROR></RESPONSE>", parse).status,
      discoveryFromResponse("<RESPONSE><LINEERROR>Could not find Report</LINEERROR></RESPONSE>", parse).reason],
    ["unavailable", "tally_error"],
  );
  assert.equal(discoveryFromResponse("Server busy", parse).status, "unavailable");
  assert.equal(discoveryFromResponse("", parse).reason, "empty_response");
});

test("a partial list updates the companies it lists and leaves the others as they were", async () => {
  const { mergeDiscovery } = await loadMerge();
  const discovery = discoveryFromResponse(envelope(company("g-1", "A") + "<COMPANY><NAME>B</NAME><GUID>g-2</GUID></COMPANY>"), parse);
  const r = mergeDiscovery({ selected: [saved("g-1", "A"), saved("g-2", "B")], discovery });
  assert.equal(r.available, true);
  assert.deepEqual(r.selection.map((c) => [c.guid, c.available]), [["g-1", true], ["g-2", true]]);
  assert.deepEqual(r.identityConflicts, [], "no GUID alert from incomplete evidence");
});

test("Tally errors and unreadable replies leave the selection untouched and raise no alert", async () => {
  const { mergeDiscovery } = await loadMerge();
  const selected = [saved("g-1", "A"), saved("g-2", "B")];
  for (const text of ["<RESPONSE><LINEERROR>x</LINEERROR></RESPONSE>", "not xml", ""]) {
    const r = mergeDiscovery({ selected, discovery: discoveryFromResponse(text, parse) });
    assert.equal(r.available, false);
    assert.equal(r.changed, false);
    assert.equal(r.selection, selected);
    assert.deepEqual(r.identityConflicts, []);
  }
});

test("a company closed in Tally stays selected (marked unavailable) on complete evidence", async () => {
  const { mergeDiscovery } = await loadMerge();
  const r = mergeDiscovery({ selected: [saved("g-1", "A"), saved("g-2", "B")], discovery: discoveryFromResponse(envelope(company("g-1", "A")), parse) });
  assert.deepEqual(r.selection.map((c) => [c.guid, c.available]), [["g-1", true], ["g-2", false]]);
});
