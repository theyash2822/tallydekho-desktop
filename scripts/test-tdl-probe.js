#!/usr/bin/env node
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");

const {
  isBareEnvelope,
  probeBillOutstandingLive,
  probeBillOutstandingAny,
} = require("../util/ensureBillOutstandingTdl");

const BILLS = "<ENVELOPE><BILLROW><BILLNAME>TD1</BILLNAME></BILLROW><BILLROW><BILLNAME>TD2</BILLNAME></BILLROW></ENVELOPE>";
const EMPTY = "<ENVELOPE></ENVELOPE> ";
const UNKNOWN = "<ENVELOPE><LINEERROR>Could not find Report 'TDKBillOutstandingWorking'!</LINEERROR></ENVELOPE>";
const SHELL = "<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER><BODY><DATA></DATA></BODY></ENVELOPE>";

let realPost;
let replies;
let asked;

beforeEach(() => {
  realPost = axios.post;
  asked = [];
  axios.post = async (_url, xml) => {
    const company = (xml.match(/<SVCURRENTCOMPANY>([^<]*)<\/SVCURRENTCOMPANY>/) || [])[1];
    asked.push(company);
    return { data: Buffer.from(replies[company] ?? EMPTY, "utf8") };
  };
});

afterEach(() => {
  axios.post = realPost;
});

test("bare envelope is recognised; anything with content is not", () => {
  assert.equal(isBareEnvelope("<ENVELOPE></ENVELOPE>"), true);
  assert.equal(isBareEnvelope(' <?xml version="1.0"?>\r\n<ENVELOPE>\r\n</ENVELOPE> '), true);
  assert.equal(isBareEnvelope(UNKNOWN), false);
  assert.equal(isBareEnvelope(SHELL), false);
  assert.equal(isBareEnvelope(""), false);
});

test("company with no outstanding bills counts as loaded (was read as 'not loaded')", async () => {
  replies = { Laveena: EMPTY };
  const r = await probeBillOutstandingLive("Laveena");
  assert.equal(r.loaded, true);
  assert.equal(r.emptyReport, true);
  assert.equal(r.billRows, 0);
});

test("unknown report or HEADER/BODY shell is still 'not loaded'", async () => {
  replies = { A: UNKNOWN, B: SHELL };
  assert.equal((await probeBillOutstandingLive("A")).loaded, false);
  assert.equal((await probeBillOutstandingLive("B")).loaded, false);
});

test("bill rows count as loaded", async () => {
  replies = { Yash: BILLS };
  const r = await probeBillOutstandingLive("Yash");
  assert.equal(r.loaded, true);
  assert.equal(r.billRows, 2);
});

test("probes every selected company until one proves the report is live", async () => {
  replies = { Laveena: SHELL, "Yash Ki Company": BILLS, "Radhe Ram": BILLS };
  const r = await probeBillOutstandingAny(["Laveena", "Yash Ki Company", "Radhe Ram", "Laveena", ""]);
  assert.equal(r.loaded, true);
  assert.deepEqual(asked, ["Laveena", "Yash Ki Company"]);
});

test("sync never restarts Tally; only the Settings setup may", () => {
  const xmlSrc = fs.readFileSync(path.join(__dirname, "../util/xml.js"), "utf8");
  const call = xmlSrc.slice(xmlSrc.indexOf("await ensureBillOutstandingTdl({"), xmlSrc.indexOf("});", xmlSrc.indexOf("await ensureBillOutstandingTdl({")));
  assert.match(call, /allowRestart: false/);
  assert.doesNotMatch(xmlSrc, /allowRestart: true/);
  const ipcSrc = fs.readFileSync(path.join(__dirname, "../util/ipcRegistry.js"), "utf8");
  assert.match(ipcSrc, /setupTdl\([^)]*allowRestart: true/);
  const mainSrc = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  assert.match(mainSrc, /ensureBillOutstandingTdl\(\{ allowRestart: false \}\)/);
});
