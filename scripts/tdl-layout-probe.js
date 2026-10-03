#!/usr/bin/env node
/**
 * TEMPORARY diagnostic — delete together with the TDKProbe* block in
 * xmls/TDKBillOutstanding.tdl once the export rule is known.
 *
 * Calls each TDKProbe* report through HTTP Export / Data / SVEXPORTFORMAT XML
 * (the production mechanism) and prints a PRINTS / EMPTY matrix. Read-only;
 * never starts, stops or restarts Tally.
 *
 *   node scripts/tdl-layout-probe.js [--port 9000] [--full] ["Yash Ki Company"]
 *
 * Without a company name only the plain request (like the production health
 * request) is sent. With a name, each probe is also sent with SVCURRENTCOMPANY
 * and the FY dates, exactly like the production bill request.
 */
const axios = require("axios");
const { decodeTallyBody } = require("../util/tdlHealth");

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 9000;
const full = args.includes("--full");
const company = args.filter((a, i) => !a.startsWith("--") && (portIdx < 0 || i !== portIdx + 1))[0] || null;

const PROBES = [
  { id: "TDKProbeFixedNoScroll", label: "Fixed + no scroll" },
  { id: "TDKProbeFixedScroll", label: "Fixed + scroll" },
  { id: "TDKProbeCompanyNoScroll", label: "Company + no scroll" },
  { id: "TDKProbeCompanyScroll", label: "Company + scroll" },
  { id: "TDKProbeBillScroll", label: "Bill collection + scroll" },
  { id: "TDKProbeBillNoScroll", label: "Bill collection + no scroll" },
];
const CONTROLS = [
  { id: "TDKBillOutstandingHealth", label: "CONTROL production health", tag: "TDKSTATUS" },
  { id: "TDKBillOutstandingWorking", label: "CONTROL production bills", tag: "BILLROW" },
];

const RAW_LIMIT = 4000;

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
  const companyVars = companyName
    ? `
        <SVCURRENTCOMPANY>${esc(companyName)}</SVCURRENTCOMPANY>
        <SVCURRENTDATE TYPE="Date">${fy.currentDate}</SVCURRENTDATE>
        <SVFROMDATE TYPE="Date">${fy.fromDate}</SVFROMDATE>
        <SVTODATE TYPE="Date">${fy.toDate}</SVTODATE>`
    : "";
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
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${companyVars}
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

function classify(text, tag) {
  const rows = (text.match(new RegExp(`<${tag}[\\s>]`, "gi")) || []).length;
  if (rows > 0) return { result: "PRINTS", rows };
  if (/could not find|LINEERROR/i.test(text)) return { result: "REPORT_MISSING", rows: 0 };
  if (/^\s*(<\?xml[^>]*\?>)?\s*(<ENVELOPE\s*\/>|<ENVELOPE\s*>\s*<\/ENVELOPE\s*>)\s*$/i.test(text)) return { result: "EMPTY", rows: 0 };
  return { result: "OTHER", rows: 0 };
}

function excerpt(text, tag) {
  if (full || Buffer.byteLength(text, "utf8") <= RAW_LIMIT) return text;
  const rows = text.match(new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, "gi")) || [];
  if (rows.length <= 3) return `${text.slice(0, RAW_LIMIT)}\n<!-- … truncated, use --full … -->`;
  const head = text.slice(0, text.indexOf(rows[0]));
  return `${head}${rows.slice(0, 3).join("\n")}\n<!-- … ${rows.length - 3} more ${tag} (use --full) … -->\n</ENVELOPE>`;
}

async function call(probe, companyName) {
  const tag = probe.tag || "PROBE";
  const mode = companyName ? `company "${companyName}"` : "plain";
  console.log(`\n=== ${probe.id}  [${mode}] ===`);
  try {
    const res = await axios.post(`http://localhost:${port}`, requestXml(probe.id, companyName), {
      headers: { "Content-Type": "text/xml" },
      responseType: "arraybuffer",
      timeout: 60000,
    });
    const text = decodeTallyBody(res.data);
    const bytes = Buffer.byteLength(text, "utf8");
    const out = classify(text, tag);
    console.log(`request: OK (HTTP ${res.status})  bytes: ${bytes}  result: ${out.result}${out.rows ? ` (${out.rows} ${tag})` : ""}`);
    console.log(excerpt(text, tag).trim());
    return out;
  } catch (e) {
    const reason = e?.code || e?.message;
    console.log(`request: FAILED  ${reason}`);
    return { result: `HTTP_FAILED (${reason})`, rows: 0 };
  }
}

function cell(out) {
  return out.rows ? `${out.result} (${out.rows})` : out.result;
}

(async () => {
  console.log(`TDL layout probe — http://localhost:${port}  company: ${company ?? "(none)"}`);
  const modes = company ? [null, company] : [null];
  const results = [];
  for (const probe of [...PROBES, ...CONTROLS]) {
    const row = { label: probe.label, cells: [] };
    for (const m of modes) row.cells.push(cell(await call(probe, m)));
    results.push(row);
  }

  const headers = ["Probe", "Plain request", ...(company ? [`With company "${company}"`] : [])];
  const widths = headers.map((h, i) => Math.max(h.length, ...results.map((r) => (i === 0 ? r.label : r.cells[i - 1]).length)));
  const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join("   ");
  console.log(`\n${line(headers)}`);
  console.log("-".repeat(widths.reduce((a, w) => a + w + 3, -3)));
  for (const r of results) console.log(line([r.label, ...r.cells]));
})();
