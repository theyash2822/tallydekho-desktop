#!/usr/bin/env node
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  MAX_LIST_IDS,
  checkVoucherListResponse,
  buildVoucherListSummary,
  trailingCheckYears,
  voucherListLog,
} = require("../util/voucherList");
const { CONTEXT_STATUS } = require("../util/tdlHealth");

const CO = "2d96a00f-9865-4be5-b8c6-7b9ced59d5df";
const OTHER = "2272cb4f-b5d6-4555-bdb7-1bd747049dc5";

// SimplifiedVoucher.xml reply shape: flat repeated columns, tags upper-cased by Tally.
const list = (guids) =>
  `<ENVELOPE>${guids.map((g, i) => `<GUID>${g}</GUID><ALTERID>${i + 1}</ALTERID><F02>${i + 1}</F02><ISOPTIONAL>0</ISOPTIONAL><REFERENCE></REFERENCE>`).join("")}</ENVELOPE>`;
const ok = (data) => ({ status: true, data });
const year = (finYear, check) => ({ finYear, begin: `${finYear.slice(0, 4)}0401`, end: `${finYear.slice(5)}0331`, check });

test("clean list → ok with GUID suffixes", () => {
  const r = checkVoucherListResponse(ok(list([`${CO}-00000001`, `${CO}-0000000a`])), CO);
  assert.deepEqual(r, { ok: true, ids: ["00000001", "0000000a"] });
});

test("empty envelope is a real zero, with or without xml declaration and whitespace", () => {
  assert.deepEqual(checkVoucherListResponse(ok("<ENVELOPE></ENVELOPE>"), CO), { ok: true, ids: [] });
  assert.deepEqual(checkVoucherListResponse(ok("\uFEFF<?xml version='1.0'?>\r\n<ENVELOPE>\r\n</ENVELOPE>\r\n"), CO), { ok: true, ids: [] });
});

test("anything that is not a clean answer for this company is rejected", () => {
  const cases = [
    [{ status: false, data: null }, "request_failed"],
    [ok(`<ENVELOPE><BODY><DATA><LINEERROR>Could not set &apos;SVCurrentCompany&apos; to &apos;X&apos;</LINEERROR></DATA></BODY></ENVELOPE>`), "company_not_open"],
    [ok(`<ENVELOPE><BODY><DATA><LINEERROR>Something else</LINEERROR></DATA></BODY></ENVELOPE>`), "tally_error"],
    [ok(`<RESPONSE>Unknown Request</RESPONSE>`), "not_an_envelope"],
    [ok(""), "not_an_envelope"],
    [ok(`<ENVELOPE><GUID>${CO}-1</GUID></ENVELOPE>`), "parse_failed"],
    [ok(list([`${CO}-00000001`, `${OTHER}-00000002`])), "foreign_voucher"],
    [ok(list([`${CO}-`])), "foreign_voucher"],
    [ok(list([""])), "foreign_voucher"],
  ];
  for (const [response, reason] of cases) {
    assert.deepEqual(checkVoucherListResponse(response, CO), { ok: false, reason }, reason);
  }
});

test("summary is complete only with verified context and every FY clean", () => {
  const good = buildVoucherListSummary({
    companyGuid: CO,
    contextStatus: CONTEXT_STATUS.VERIFIED,
    years: [year("2023-2024", { ok: true, ids: ["1", "2"] }), year("2026-2027", { ok: true, ids: [] })],
  });
  assert.deepEqual(good, {
    companyGuid: CO,
    complete: true,
    reason: null,
    years: [
      { finYear: "2023-2024", from: "2023-04-01", to: "2024-03-31", ids: ["1", "2"] },
      { finYear: "2026-2027", from: "2026-04-01", to: "2027-03-31", ids: [] },
    ],
  });
});

test("summary is incomplete for every unsafe case", () => {
  const clean = [year("2026-2027", { ok: true, ids: ["1"] })];
  const s = (contextStatus, years) => buildVoucherListSummary({ companyGuid: CO, contextStatus, years });
  for (const status of ["REPORT_MISSING", "OUTDATED", "MISMATCH", "COMPANY_NOT_OPEN", "BLANK", "ERROR", null, undefined]) {
    const r = s(status, clean);
    assert.equal(r.complete, false, String(status));
    assert.equal(r.years, undefined);
  }
  assert.equal(s(CONTEXT_STATUS.VERIFIED, []).reason, "no_years");
  assert.equal(
    s(CONTEXT_STATUS.VERIFIED, [...clean, year("2025-2026", { ok: false, reason: "company_not_open" })]).reason,
    "2025-2026:company_not_open"
  );
  assert.equal(s(CONTEXT_STATUS.VERIFIED, [{ finYear: "2026-2027", begin: "bad", end: "20270331", check: { ok: true, ids: [] } }]).reason, "2026-2027:bad_period");
  const huge = { ok: true, ids: new Array(MAX_LIST_IDS + 1).fill("1") };
  assert.equal(s(CONTEXT_STATUS.VERIFIED, [year("2026-2027", huge)]).reason, "too_many_vouchers");
});

test("trailing check years cover FYs after the last synced one, through the FY after today's", () => {
  const today = new Date(Date.UTC(2026, 9, 5));
  assert.deepEqual(trailingCheckYears([year("2023-2024", null)], today).map((y) => [y.finYear, y.begin, y.end]), [
    ["2024-2025", "20240401", "20250331"],
    ["2025-2026", "20250401", "20260331"],
    ["2026-2027", "20260401", "20270331"],
    ["2027-2028", "20270401", "20280331"],
  ]);
  assert.deepEqual(trailingCheckYears([year("2025-2026", null), year("2026-2027", null)], today).map((y) => y.finYear), ["2027-2028"]);
  assert.deepEqual(trailingCheckYears([], today), []);
  assert.deepEqual(trailingCheckYears([{ finYear: "x", begin: "bad", end: "bad" }], today), []);
});

test("a trailing year Tally did not answer cleanly is skipped, not treated as empty", () => {
  const s = buildVoucherListSummary({
    companyGuid: CO,
    contextStatus: CONTEXT_STATUS.VERIFIED,
    years: [
      year("2023-2024", { ok: true, ids: ["1"] }),
      { ...year("2026-2027", { ok: true, ids: [] }), trailing: true },
      { ...year("2027-2028", { ok: false, reason: "tally_error" }), trailing: true },
    ],
  });
  assert.equal(s.complete, true);
  assert.deepEqual(s.years.map((y) => [y.finYear, y.ids.length]), [["2023-2024", 1], ["2026-2027", 0]]);
  const realFails = buildVoucherListSummary({
    companyGuid: CO,
    contextStatus: CONTEXT_STATUS.VERIFIED,
    years: [year("2023-2024", { ok: false, reason: "tally_error" }), { ...year("2026-2027", { ok: true, ids: [] }), trailing: true }],
  });
  assert.equal(realFails.complete, false);
  assert.equal(realFails.reason, "2023-2024:tally_error");
});

test("log view carries counts, never ids", () => {
  const summary = buildVoucherListSummary({
    companyGuid: CO,
    contextStatus: CONTEXT_STATUS.VERIFIED,
    years: [year("2026-2027", { ok: true, ids: ["00000001", "00000002"] })],
  });
  const view = voucherListLog(summary);
  assert.deepEqual(view.years, [{ finYear: "2026-2027", ids: 2 }]);
  assert.doesNotMatch(JSON.stringify(view), /00000001/);
});

test("sync sends the list per company and never logs raw ids", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "util", "xml.js"), "utf8");
  assert.match(src, /fetchVoucherList\(\{ companyName: name, companyGuid, year, yearId \}\)/);
  assert.match(src, /voucherLists: \[voucherLists\[c\.guid\]\]/);
  assert.match(src, /\.\.\.\(syncRunId \? \{ syncRunId \} : \{\}\)/);
  assert.match(src, /listChecks\.length === voucherListExpected\[companyGuid\]/);
  assert.match(src, /trailingCheckYears\(years\)/);
  assert.match(src, /\{ \.\.\.r, trailing: true \}\);\s*return \[\];/, "trailing years are never ingested");
  assert.match(src, /voucherLists\.map\(voucherListLog\)/);
  assert.doesNotMatch(src, /info\("\[sync\] ingest complete body", \{ uploadId, \.\.\.extras \}\)/);
});
