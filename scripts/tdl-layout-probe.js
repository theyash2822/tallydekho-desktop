#!/usr/bin/env node
/**
 * TEMPORARY diagnostic — delete together with the TDKProbe* block in
 * xmls/TDKBillOutstanding.tdl once company context is proven.
 *
 * Round 2: for each requested company, calls TDKProbeContext and
 * TDKProbeContextBills through HTTP Export / Data / SVEXPORTFORMAT XML with the
 * same static variables as the production bill request, and prints what
 * ##SVCurrentCompany returned. Read-only; never starts, stops or restarts Tally.
 *
 *   node scripts/tdl-layout-probe.js [--port 9000] [--full] "Yash Ki Company" "Laveena" "<closed company>"
 *
 * A deliberately nonexistent name is always added as the last case.
 */
const axios = require("axios");
const { XMLParser } = require("fast-xml-parser");
const { decodeTallyBody } = require("../util/tdlHealth");

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 9000;
const full = args.includes("--full");
const NONEXISTENT = "TDK Probe No Such Company";
const companies = [
  ...args.filter((a, i) => !a.startsWith("--") && (portIdx < 0 || i !== portIdx + 1)),
  NONEXISTENT,
];

const BILL_EXCERPT = 3;
const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function currentFy(now = new Date()) {
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return { fromDate: `${y}0401`, toDate: `${y + 1}0331`, currentDate: ymd(now) };
}

function requestXml(id, companyName) {
  const fy = currentFy();
  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>${esc(id)}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${esc(companyName)}</SVCURRENTCOMPANY>
        <SVCURRENTDATE TYPE="Date">${fy.currentDate}</SVCURRENTDATE>
        <SVFROMDATE TYPE="Date">${fy.fromDate}</SVFROMDATE>
        <SVTODATE TYPE="Date">${fy.toDate}</SVTODATE>
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

/** Case-insensitive child lookup (Tally may re-case field tags). */
function child(node, tag) {
  if (!node || typeof node !== "object") return undefined;
  const key = Object.keys(node).find((k) => k.toUpperCase() === tag);
  return key === undefined ? undefined : node[key];
}

function text(v) {
  if (Array.isArray(v)) v = v[0];
  if (v == null) return null;
  if (typeof v === "object") return String(v["#text"] ?? "");
  return String(v);
}

function summarize(raw) {
  if (/could not|LINEERROR/i.test(raw)) return { kind: "ERROR" };
  if (/^\s*(<\?xml[^>]*\?>)?\s*(<ENVELOPE\s*\/>|<ENVELOPE\s*>\s*<\/ENVELOPE\s*>)\s*$/i.test(raw)) return { kind: "EMPTY" };
  try {
    const env = child(parser.parse(raw), "ENVELOPE") || {};
    const probe = child(env, "PROBE");
    const p = Array.isArray(probe) ? probe[0] : probe;
    const bills = [].concat(child(env, "PROBEBILL") ?? []);
    return {
      kind: p ? "PRINTS" : "OTHER",
      probeLines: Array.isArray(probe) ? probe.length : p ? 1 : 0,
      currentCompany: p ? text(child(p, "CURRENTCOMPANY")) : null,
      companyObject: p ? text(child(p, "COMPANYOBJECT")) : null,
      billRows: bills.length,
      billCompanies: [...new Set(bills.map((b) => text(child(b, "COMPANY"))))],
    };
  } catch (e) {
    return { kind: "PARSE_FAILED", reason: e?.message };
  }
}

function excerpt(raw) {
  if (full) return raw;
  const rows = raw.match(/<PROBEBILL[\s>][\s\S]*?<\/PROBEBILL>/gi) || [];
  if (rows.length <= BILL_EXCERPT) return raw;
  const head = raw.slice(0, raw.indexOf(rows[0]));
  return `${head}${rows.slice(0, BILL_EXCERPT).join("\n")}\n<!-- … ${rows.length - BILL_EXCERPT} more PROBEBILL (use --full) … -->\n</ENVELOPE>`;
}

async function call(id, companyName) {
  console.log(`\n=== ${id}  requested: "${companyName}" ===`);
  try {
    const res = await axios.post(`http://localhost:${port}`, requestXml(id, companyName), {
      headers: { "Content-Type": "text/xml" },
      responseType: "arraybuffer",
      timeout: 60000,
    });
    const raw = decodeTallyBody(res.data);
    const s = summarize(raw);
    console.log(`request: OK (HTTP ${res.status})  bytes: ${Buffer.byteLength(raw, "utf8")}  result: ${s.kind}`);
    console.log(excerpt(raw).trim());
    return s;
  } catch (e) {
    const reason = e?.code || e?.message;
    console.log(`request: FAILED  ${reason}`);
    return { kind: `HTTP_FAILED (${reason})` };
  }
}

const show = (v) => (v == null ? "-" : v === "" ? '""' : v);

(async () => {
  console.log(`TDL company-context probe — http://localhost:${port}`);
  const rows = [];
  for (const name of companies) {
    const ctx = await call("TDKProbeContext", name);
    const cb = await call("TDKProbeContextBills", name);
    rows.push({ name, ctx, cb });
  }

  const table = rows.map(({ name, ctx, cb }) => [
    name,
    ctx.kind === "PRINTS" ? show(ctx.currentCompany) : ctx.kind,
    ctx.kind === "PRINTS" ? show(ctx.companyObject) : "-",
    cb.kind === "PRINTS" ? show(cb.currentCompany) : cb.kind,
    cb.kind === "PRINTS" ? String(cb.billRows) : "-",
    cb.kind === "PRINTS" ? (cb.billCompanies.map(show).join(", ") || "-") : "-",
  ]);
  const headers = ["Requested", "Context: CURRENTCOMPANY", "Context: COMPANYOBJECT", "Bills: CURRENTCOMPANY", "Bill rows", "Bill row COMPANY"];
  const widths = headers.map((h, i) => Math.max(h.length, ...table.map((r) => r[i].length)));
  const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join("   ");
  console.log(`\n${line(headers)}`);
  console.log("-".repeat(widths.reduce((a, w) => a + w + 3, -3)));
  for (const r of table) console.log(line(r));
})();
