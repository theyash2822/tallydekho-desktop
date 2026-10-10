// Fiscal planner: a new FY is discovered (offered in Edit Years) but never selected automatically
// (owner rule DC-10, replacing the earlier auto-append behaviour); scope is frozen per job.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const createFinancialYears = require("../util/createFinancialYears");
const { withNewYears, yearsFromCompanyNodes, planFiscalScope } = require("../util/fiscalPlanner");

const GUID = "11111111-2222-3333-4444-555555555555";
const node = (startingFrom, endingAt, extra = {}) => ({ GUID, NAME: "Acme", STARTINGFROM: startingFrom, ENDINGAT: endingAt, ...extra });

test("31 March → 1 April: a headless run discovers the new April–March year but does not select it", () => {
  const before = createFinancialYears("20230401", "20260331");
  const selected = [{ guid: GUID, name: "Acme", years: before.slice(-2) }];
  const fresh = yearsFromCompanyNodes([node("20230401", "20260401")]);
  const { companies, added, discovered } = planFiscalScope(selected, fresh);
  assert.deepEqual(companies[0].years.map((y) => y.finYear), ["2024-2025", "2025-2026"]);
  assert.equal(companies[0].allYears.at(-1).finYear, "2026-2027", "offered as a choice");
  assert.deepEqual(added, []);
  assert.deepEqual(discovered, [{ guid: GUID, finYears: ["2026-2027"] }]);
});

test("31 December → 1 January: a Jan–Dec company's next calendar year is discovered with its own bounds", () => {
  const selected = [{ guid: GUID, years: createFinancialYears("20240101", "20251231") }];
  const fresh = yearsFromCompanyNodes([node("20240101", "20260101")]);
  const { companies } = planFiscalScope(selected, fresh);
  assert.equal(companies[0].years.at(-1).end, "20251231");
  const last = companies[0].allYears.at(-1);
  assert.equal(last.begin, "20260101");
  assert.equal(last.end, "20261231");
});

test("explicitly deselected older years stay deselected; nothing is removed", () => {
  const all = createFinancialYears("20200401", "20260331");
  const selected = [{ guid: GUID, years: [all[2], all[5]] }];
  const fresh = yearsFromCompanyNodes([node("20200401", "20260331")]);
  const { companies, added } = planFiscalScope(selected, fresh);
  assert.deepEqual(companies[0].years.map((y) => y.finYear), [all[2].finYear, all[5].finYear]);
  assert.deepEqual(added, []);
});

test("books beginning mid-year keep their own boundaries", () => {
  const years = createFinancialYears("20240915", "20250914");
  assert.equal(years[0].begin, "20240915");
  const selected = [{ guid: GUID, years }];
  const { companies } = planFiscalScope(selected, yearsFromCompanyNodes([node("20240915", "20250915")]));
  assert.equal(companies[0].allYears.at(-1).begin, "20250915");
  assert.equal(companies[0].years.length, years.length);
});

test("first voucher not yet posted (ENDINGAT unchanged) adds nothing and keeps history", () => {
  const years = createFinancialYears("20230401", "20260331");
  const { companies, added } = planFiscalScope([{ guid: GUID, years }], yearsFromCompanyNodes([node("20230401", "20260331")]));
  assert.equal(companies[0].years.length, years.length);
  assert.deepEqual(added, []);
});

test("unavailable or malformed discovery leaves the stored scope unchanged", () => {
  const years = createFinancialYears("20230401", "20250331");
  const selected = [{ guid: GUID, years }];
  assert.deepEqual(planFiscalScope(selected, null).companies[0].years, years);
  const malformed = yearsFromCompanyNodes([{ GUID, STARTINGFROM: "garbage", ENDINGAT: "20260331" }, { NAME: "no guid" }]);
  assert.deepEqual(planFiscalScope(selected, malformed).companies[0].years, years);
});

test("the planned scope is frozen for the job", () => {
  const { companies } = planFiscalScope([{ guid: GUID, years: createFinancialYears("20240401", "20250331") }], null);
  assert.ok(Object.isFrozen(companies[0]));
  assert.ok(Object.isFrozen(companies[0].years[0]));
  assert.throws(() => { "use strict"; companies[0].years.push({}); });
});

test("a sync never writes discovered years into the saved selection", () => {
  const xml = fs.readFileSync(path.join(__dirname, "../util/xml.js"), "utf8");
  const plan = xml.slice(xml.indexOf("const planJobScope"), xml.indexOf("const syncTallyDataUnlocked"));
  assert.doesNotMatch(plan, /setSelectedCompanies|applyPlannedYears/);
});

test("the renderer's Tally refresh keeps the selected years and only refreshes allYears", async () => {
  const src = fs.readFileSync(path.join(__dirname, "../renderer/app/utils/selectionMerge.js"), "utf8");
  const { mergeDiscovery } = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
  const all = createFinancialYears("20200401", "20270331");
  const selected = [{ id: GUID, guid: GUID, name: "Acme", years: all.slice(-3, -1) }];
  const r = mergeDiscovery({ selected, discovery: { status: "ok", companies: [{ guid: GUID, name: "Acme", years: all }] } });
  assert.deepEqual(r.selection[0].years.map((y) => y.finYear), all.slice(-3, -1).map((y) => y.finYear));
  assert.equal(r.selection[0].allYears.length, all.length);
});

test("every sync path plans its scope inside syncTallyData", () => {
  const xml = fs.readFileSync(path.join(__dirname, "../util/xml.js"), "utf8");
  assert.match(xml, /companies = planJobScope\(companies, open\);\n  const selectedCompanies = companies;/);
});

test("StockFYBalance rows carry explicit fiscal scope and role (S6)", () => {
  const xml = fs.readFileSync(path.join(__dirname, "../util/xml.js"), "utf8");
  assert.match(xml, /fiscal: stockBalanceFiscal\(year, "closing", fyEndStr\)/);
  assert.match(xml, /fiscal: stockBalanceFiscal\(year, "opening", prevDayStr\)/);
  assert.match(xml, /_FINANCIAL_YEAR: year\.finYear,\n  FY_BEGIN: year\.begin,\n  FY_END: year\.end,\n  BALANCE_DATE: balanceDate,\n  BALANCE_ROLE: role,/);
});
