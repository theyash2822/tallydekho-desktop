#!/usr/bin/env node
/**
 * Delivery outcomes: a write that may have reached Tally is never posted twice,
 * a Hard Sync holds work without claiming it, and a lost acknowledgement is
 * re-reported with the same answer.
 */
const { test, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

const memory = {};
function stub(rel, exports) {
  const file = require.resolve(path.join("..", "util", rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
stub("store", {
  get: (k) => memory[k],
  set: (k, v) => { memory[k] = v; },
  delete: (k) => { delete memory[k]; },
});
stub("logger", { info() {}, error() {}, warn() {} });
stub("helper", { axiosInstance: { post: async () => ({ data: {} }) } });

const { postToTally } = require("../util/xml");
const {
  processCompanyWriteback,
  resultReport,
  __setDepsForTests,
  resetDepsForTests,
} = require("../util/writeback");

beforeEach(() => resetDepsForTests());
afterEach(() => resetDepsForTests());

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("a dropped connection after the request was sent is outcome-unknown and not retried", async () => {
  let received = 0;
  const server = await listen((req) => {
    received += 1;
    req.socket.destroy();
  });
  memory.port = server.address().port;
  const result = await postToTally("<ENVELOPE/>");
  server.close();
  assert.equal(received, 1, "Tally must see the write exactly once");
  assert.equal(result.status, false);
  assert.equal(result.outcomeUnknown, true);
});

test("a refused connection never reached Tally and is reported as not sent", async () => {
  const server = await listen(() => {});
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  memory.port = port;
  const result = await postToTally("<ENVELOPE/>");
  assert.equal(result.status, false);
  assert.equal(result.notSent, true);
  assert.notEqual(result.outcomeUnknown, true);
});

test("an accepted import without a voucher number is still a success", async () => {
  const server = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      res.end("<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><LASTVCHID>4521</LASTVCHID></RESPONSE>");
    });
  });
  memory.port = server.address().port;
  const result = await postToTally("<ENVELOPE/>");
  server.close();
  assert.equal(result.status, true);
  assert.equal(result.voucherNumber, null);
  const report = resultReport(result);
  assert.deepEqual(report, { success: true, tallyVoucherNumber: null, tallyId: "4521" });
  assert.equal("tallyAlterId" in report, false, "an import id is not an ALTERID");
});

function outbox({ resultFails = 0 } = {}) {
  const calls = [];
  let failuresLeft = resultFails;
  return {
    calls,
    axiosInstance: {
      post: async (url, body) => {
        calls.push({ url, body });
        if (url.endsWith("/pending")) return { data: { data: { items: [{ outboxId: 7 }] } } };
        if (url.endsWith("/claim")) return { data: { data: { claimed: true, xml: "<ENVELOPE/>" } } };
        if (url.endsWith("/result")) {
          if (failuresLeft > 0) {
            failuresLeft -= 1;
            throw new Error("socket hang up");
          }
          return { data: { status: true } };
        }
        return { data: {} };
      },
    },
  };
}

test("outcome unknown from Tally is reported as such, not as a retryable failure", async () => {
  const o = outbox();
  let tallyPosts = 0;
  __setDepsForTests({
    axiosInstance: o.axiosInstance,
    postToTally: async () => { tallyPosts += 1; return { status: false, outcomeUnknown: true, message: "x" }; },
    isHardSyncActive: () => false,
  });
  const r = await processCompanyWriteback("G1");
  assert.equal(tallyPosts, 1);
  assert.equal(r.unknown, 1);
  const report = o.calls.find((c) => c.url.endsWith("/result")).body;
  assert.equal(report.outcomeUnknown, true);
  assert.equal(report.success, false);
});

test("a lost success acknowledgement is re-sent as success, never as a failure", async () => {
  const o = outbox({ resultFails: 1 });
  let tallyPosts = 0;
  __setDepsForTests({
    axiosInstance: o.axiosInstance,
    postToTally: async () => { tallyPosts += 1; return { status: true, voucherNumber: "S/1", tallyId: "88" }; },
    isHardSyncActive: () => false,
  });
  const r = await processCompanyWriteback("G1");
  assert.equal(tallyPosts, 1);
  assert.equal(r.unreported, 1);
  const reports = o.calls.filter((c) => c.url.endsWith("/result")).map((c) => c.body);
  assert.equal(reports.length, 2);
  for (const body of reports) assert.equal(body.success, true);
});

test("a Hard Sync holds queued entries without claiming them", async () => {
  const o = outbox();
  let tallyPosts = 0;
  __setDepsForTests({
    axiosInstance: o.axiosInstance,
    postToTally: async () => { tallyPosts += 1; return { status: true }; },
    isHardSyncActive: () => true,
  });
  await processCompanyWriteback("G1");
  assert.equal(tallyPosts, 0);
  assert.equal(o.calls.length, 0, "nothing is pulled or claimed while held");
});

after(() => {
  for (const k of Object.keys(memory)) delete memory[k];
});
