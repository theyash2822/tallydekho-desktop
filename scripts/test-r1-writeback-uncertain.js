// R1 / X9 (V-001): a Tally write whose reply is lost is never posted twice.
// Drives the real postToTally + axios against a fake Tally owned by this test.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");

// Only sockets to servers this file starts may connect (the owner's Tally,
// backend and cloud endpoints are unreachable from here).
const allowedPorts = new Set();
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guarded(...args) {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  const port = Number(typeof a === "object" ? a.port : a);
  if (!allowedPorts.has(port)) throw Object.assign(new Error(`blocked outbound ${port}`), { code: "NETWORK_GUARD" });
  return realConnect.apply(this, args);
};

let tallyPort = 0;
const storePath = require.resolve("../util/store");
require.cache[storePath] = {
  id: storePath,
  filename: storePath,
  loaded: true,
  exports: { get: (k) => (k === "port" ? tallyPort : undefined), set: () => {}, delete: () => {} },
};

// helper.js builds the Electron auto-updater at load; only its axios instance is used here.
const helperPath = require.resolve("../util/helper");
require.cache[helperPath] = {
  id: helperPath,
  filename: helperPath,
  loaded: true,
  exports: { axiosInstance: { post: async () => { throw new Error("backend not available in this test"); } } },
};

const xml = require("../util/xml");
const writeback = require("../util/writeback");
const { setSelectedCompanies } = require("../util/companySelection");

async function fakeTally(onRequest) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      seen.push(body);
      onRequest(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  allowedPorts.add(port);
  return { seen, port, close: () => new Promise((r) => server.close(r)) };
}

const ENTRY = "<ENVELOPE><BODY><DATA><TALLYMESSAGE><VOUCHER/></TALLYMESSAGE></DATA></BODY></ENVELOPE>";

test("reply dropped after Tally received the entry: one post, outcome unknown", async () => {
  // Tally imports, then the connection dies before any reply.
  const tally = await fakeTally((req) => req.socket.destroy());
  tallyPort = tally.port;
  const r = await xml.postToTally(ENTRY);
  assert.equal(tally.seen.length, 1, "the entry must reach Tally exactly once");
  assert.equal(r.status, false);
  assert.equal(r.outcomeUnknown, true);
  assert.equal(r.code, "TALLY_WRITE_OUTCOME_UNKNOWN");
  await tally.close();
});

test("timeout after send: no second post", async () => {
  let calls = 0;
  xml.__setTallyWritePostForTests(async () => {
    calls += 1;
    throw Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED" });
  });
  try {
    const r = await xml.postToTally(ENTRY);
    assert.equal(calls, 1);
    assert.equal(r.outcomeUnknown, true);
  } finally {
    xml.__setTallyWritePostForTests(null);
  }
});

test("connection refused: retried once, reported as not sent (safe to retry later)", async () => {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const closedPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  allowedPorts.add(closedPort);
  tallyPort = closedPort;
  const r = await xml.postToTally(ENTRY);
  assert.equal(r.status, false);
  assert.equal(r.notSent, true);
  assert.notEqual(r.outcomeUnknown, true);
});

test("Tally LINEERROR is a confirmed rejection, not unknown", async () => {
  const tally = await fakeTally((req, res) => {
    res.end("<RESPONSE><LINEERROR>Ledger 'X' does not exist</LINEERROR></RESPONSE>");
  });
  tallyPort = tally.port;
  const r = await xml.postToTally(ENTRY);
  assert.equal(r.status, false);
  assert.notEqual(r.outcomeUnknown, true);
  assert.match(r.message, /does not exist/);
  await tally.close();
});

function fakeBackend({ failResultTimes = 0 } = {}) {
  const calls = [];
  let resultFailures = 0;
  return {
    calls,
    post: async (url, body) => {
      calls.push({ url, body });
      if (url === "/tally/desktop/writeback/pending") return { data: { data: { items: [{ outboxId: "ob-9" }] } } };
      if (url.endsWith("/claim")) return { data: { data: { claimed: true, xml: ENTRY } } };
      if (url.endsWith("/result")) {
        if (resultFailures < failResultTimes) {
          resultFailures += 1;
          throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
        }
        return { data: { status: true } };
      }
      return { data: {} };
    },
  };
}

test("outbox writeback reports outcome_unknown to the backend, never a retryable failure", async () => {
  const tally = await fakeTally((req) => req.socket.destroy());
  tallyPort = tally.port;
  setSelectedCompanies([{ guid: "G1", name: "Synthetic" }]);
  const backend = fakeBackend();
  writeback.__setDepsForTests({ axiosInstance: backend });
  try {
    const totals = await writeback.processCompanyWriteback("G1");
    const results = backend.calls.filter((c) => c.url.endsWith("/result"));
    assert.equal(tally.seen.length, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].body.success, false);
    assert.equal(results[0].body.outcomeUnknown, true);
    assert.equal(results[0].body.errorCode, "OUTCOME_UNKNOWN");
    assert.equal(totals.unknown, 1);
    assert.equal(totals.failed, 0);
  } finally {
    writeback.resetDepsForTests();
    await tally.close();
  }
});

test("posted entry whose result report is lost is re-reported as posted, never as failed", async () => {
  const tally = await fakeTally((req, res) => {
    res.end("<RESPONSE><CREATED>1</CREATED><LASTVCHID>77</LASTVCHID></RESPONSE>");
  });
  tallyPort = tally.port;
  const backend = fakeBackend({ failResultTimes: 1 });
  writeback.__setDepsForTests({ axiosInstance: backend });
  try {
    await writeback.processCompanyWriteback("G1");
    const results = backend.calls.filter((c) => c.url.endsWith("/result"));
    assert.equal(tally.seen.length, 1);
    assert.equal(results.length, 2);
    for (const r of results) assert.equal(r.body.success, true, "a lost ack must not turn into a failure report");
  } finally {
    writeback.resetDepsForTests();
    await tally.close();
  }
});
