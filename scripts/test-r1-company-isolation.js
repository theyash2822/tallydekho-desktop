// R1 / S8 + N2 (V-022): a company-scoped Tally failure skips only that company; an
// endpoint-wide outage stops the run; only uploaded companies count as synced.
// Real syncTallyData + getData against a fake Tally HTTP server; the backend client
// is a recorder. The Tally install folder, store and logger are replaced.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const allowedPorts = new Set();
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guarded(...args) {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  const port = Number(typeof a === "object" ? a.port : a);
  if (!allowedPorts.has(port)) throw Object.assign(new Error(`blocked outbound ${port}`), { code: "NETWORK_GUARD" });
  return realConnect.apply(this, args);
};

const ROOT = path.join(__dirname, "..");
const stub = (rel, exports) => {
  const file = require.resolve(path.join(ROOT, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
const mem = new Map();
stub("util/store", { get: (k) => mem.get(k), set: (k, v) => mem.set(k, v), delete: (k) => mem.delete(k), has: (k) => mem.has(k) });
stub("util/logger", { info: () => {}, error: () => {}, warn: () => {}, logPath: () => "/dev/null" });
stub("util/tdlFiles", { installTdlFiles: async () => ({ detected: null, applyResult: null }) });

const backendCalls = [];
let uploadSeq = 0;
let onBackend = null;
const reply = (data) => ({ data });
stub("util/helper", {
  axiosInstance: {
    get: async (url) => { backendCalls.push(["GET", url]); return reply({ status: true, data: {} }); },
    post: async (url, body, opts) => {
      const companyGuid = opts?.headers?.["Company-Guid"] || body?.companyGuid || null;
      backendCalls.push(["POST", url, companyGuid]);
      if (onBackend) await onBackend(url);
      if (url === "/desktop/init-sync") {
        const alterIds = {}; const yearIds = {};
        for (const c of body.companies) {
          alterIds[c.guid] = { master: 0, voucher: { "2025-2026": 0 } };
          yearIds[c.guid] = { "2025-2026": `${c.guid}-fy` };
        }
        return reply({ status: true, data: { alterIds, yearIds } });
      }
      if (url === "/ingest/sync-run/start") return reply({ status: true, data: { syncRunId: "run-1" } });
      if (url === "/ingest/init") return reply({ status: true, data: { uploadId: `up-${++uploadSeq}` } });
      return reply({ status: true, data: {} });
    },
  },
});

const xml = require(path.join(ROOT, "util/xml.js"));
const { coordinator } = require(path.join(ROOT, "util/jobCoordinator"));

const COMPANIES = [
  { guid: "aaaaaaaa-0000-0000-0000-00000000000a", name: "Alpha" },
  { guid: "bbbbbbbb-0000-0000-0000-00000000000b", name: "Bravo" },
  { guid: "cccccccc-0000-0000-0000-00000000000c", name: "Charlie" },
];
const companiesXml = (list) => `<ENVELOPE><BODY><DATA><COLLECTION>${list.map((c) =>
  `<COMPANY><NAME>${c.name}</NAME><GUID>${c.guid}</GUID><STARTINGFROM>20250401</STARTINGFROM><ENDINGAT>20260331</ENDINGAT></COMPANY>`).join("")}</COLLECTION></DATA></BODY></ENVELOPE>`;

async function fakeTally(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const company = /<SVCURRENTCOMPANY>([^<]*)<\/SVCURRENTCOMPANY>/.exec(body)?.[1] || null;
      seen.push(company);
      handler({ body, company, req, res });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  allowedPorts.add(server.address().port);
  mem.set("port", server.address().port);
  return { seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

const selected = () => COMPANIES.map((c) => ({
  ...c, id: c.guid, years: [{ finYear: "2025-2026", begin: "20250401", end: "20260331" }],
  allYears: [{ finYear: "2025-2026", begin: "20250401", end: "20260331" }],
}));
const fakeWindow = { send: () => {}, isDestroyed: () => false, webContents: { send: () => {}, isDestroyed: () => false } };
const runSync = (companies) => coordinator.run("sync", { trigger: "manual" }, () => xml.syncTallyData(fakeWindow, companies, false));
const uploadsFor = () => backendCalls.filter(([, url]) => url === "/ingest/complete").length;
const chunkCompanies = () => [...new Set(backendCalls.filter(([, url]) => url === "/ingest/chunk").map(([, , g]) => g))];

test("company B's Tally error skips only B; A and C upload; outcomes are per company", async () => {
  backendCalls.length = 0;
  mem.set("selectedCompanies", selected());
  const tally = await fakeTally(({ body, company, res }) => {
    res.setHeader("Content-Type", "text/xml");
    if (/Companies|CompanyList|<TYPE>Company<\/TYPE>/i.test(body) && !company) return res.end(companiesXml(COMPANIES));
    if (company === "Bravo") return res.end("<RESPONSE><LINEERROR>Could not set SVCurrentCompany</LINEERROR></RESPONSE>");
    return res.end("<ENVELOPE></ENVELOPE>");
  });
  try {
    const run = await runSync(selected());
    const out = run.result;
    const byGuid = Object.fromEntries((out.data.companies || []).map((o) => [o.name, o]));
    assert.equal(byGuid.Alpha.status, "uploaded");
    assert.equal(byGuid.Charlie.status, "uploaded");
    assert.equal(byGuid.Bravo.status, "failed");
    assert.equal(byGuid.Bravo.code, "tally_source_failed");
    assert.equal(out.code, "partial_sync");
    assert.equal(uploadsFor(), 2, "exactly two companies were completed on the server");
    assert.ok(!chunkCompanies().includes(COMPANIES[1].guid), "nothing of Bravo was uploaded");
    assert.ok(tally.seen.includes("Alpha") && tally.seen.includes("Charlie"), "healthy companies were still extracted");
  } finally {
    await tally.close();
  }
});

test("Tally unreachable for every request stops the run before any upload", async () => {
  backendCalls.length = 0;
  let calls = 0;
  const tally = await fakeTally(({ body, company, req, res }) => {
    calls += 1;
    if (/Companies|CompanyList|<TYPE>Company<\/TYPE>/i.test(body) && !company && calls === 1) {
      res.setHeader("Content-Type", "text/xml");
      return res.end(companiesXml(COMPANIES));
    }
    req.socket.destroy();
  });
  try {
    const run = await runSync(selected());
    const out = run.result;
    assert.equal(out.status, false);
    assert.equal(uploadsFor(), 0, "no company is completed during an endpoint-wide outage");
    assert.ok(!backendCalls.some(([, url]) => url === "/ingest/chunk"), "no chunk was sent");
  } finally {
    await tally.close();
  }
});

test("a company not open in Tally is reported as skipped, not synced", async () => {
  backendCalls.length = 0;
  const open = [COMPANIES[0], COMPANIES[2]];
  const tally = await fakeTally(({ body, company, res }) => {
    res.setHeader("Content-Type", "text/xml");
    if (/Companies|CompanyList|<TYPE>Company<\/TYPE>/i.test(body) && !company) return res.end(companiesXml(open));
    return res.end("<ENVELOPE></ENVELOPE>");
  });
  try {
    const run = await runSync(selected());
    const out = run.result;
    assert.equal(out.status, true, "a closed company does not fail the run");
    const byName = Object.fromEntries(out.data.companies.map((o) => [o.name, o.status]));
    assert.deepEqual(byName, { Alpha: "uploaded", Bravo: "skipped", Charlie: "uploaded" });
    assert.equal(uploadsFor(), 2);
  } finally {
    await tally.close();
  }
});

// R1 / 14 (V-021): Stop at a real orchestration seam prevents every later side effect.
test("Stop during company discovery: no init-sync, no run, no upload", async () => {
  backendCalls.length = 0;
  const tally = await fakeTally(({ body, company, res }) => {
    res.setHeader("Content-Type", "text/xml");
    if (/Companies|CompanyList|<TYPE>Company<\/TYPE>/i.test(body) && !company) {
      coordinator.requestCancel({ types: ["sync"], code: "manually_stopped" });
      return setTimeout(() => res.end(companiesXml(COMPANIES)), 20);
    }
    return res.end("<ENVELOPE></ENVELOPE>");
  });
  try {
    const run = await runSync(selected());
    assert.equal(run.result.status, false);
    assert.equal(run.result.code, "manually_stopped");
    assert.deepEqual(backendCalls, [], "nothing reached the server");
  } finally {
    await tally.close();
  }
});

test("Stop while init-sync is in flight: no sync run, no extraction upload", async () => {
  backendCalls.length = 0;
  const tally = await fakeTally(({ body, company, res }) => {
    res.setHeader("Content-Type", "text/xml");
    if (/Companies|CompanyList|<TYPE>Company<\/TYPE>/i.test(body) && !company) return res.end(companiesXml(COMPANIES));
    return res.end("<ENVELOPE></ENVELOPE>");
  });
  onBackend = async (url) => {
    if (url === "/desktop/init-sync") coordinator.requestCancel({ types: ["sync"], code: "manually_stopped" });
  };
  try {
    const run = await runSync(selected());
    assert.equal(run.result.status, false);
    const urls = backendCalls.map(([, url]) => url);
    assert.deepEqual(urls, ["/desktop/init-sync"], "only the request already in flight was made");
    assert.ok(!coordinator.snapshot().active.length, "the job released itself");
  } finally {
    onBackend = null;
    await tally.close();
  }
});

// R1 / 16: status discovery never exports ledger collections; counts only on request, scoped.
test("discovery exports no ledgers on a poll; an explicit refresh asks only for the chosen company", async () => {
  const ledgerExports = [];
  const tally = await fakeTally(({ body, company, res }) => {
    res.setHeader("Content-Type", "text/xml");
    if (/MyReportLedgerTable/.test(body) && company) {
      ledgerExports.push(company);
      return res.end("<ENVELOPE></ENVELOPE>");
    }
    if (/<TYPE>Company<\/TYPE>/i.test(body) && !company) return res.end(companiesXml(COMPANIES));
    return res.end("<ENVELOPE></ENVELOPE>");
  });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await xml.discoverCompanies()).status, "ok");
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(ledgerExports, [], "polling never exports ledger collections");
    await xml.discoverCompanies({ ledgerCountsFor: [COMPANIES[1].guid] });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(ledgerExports, ["Bravo"], "only the requested company");
  } finally {
    await tally.close();
  }
});
