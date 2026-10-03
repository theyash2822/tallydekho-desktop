#!/usr/bin/env node
/**
 * Windows QA helper: print Tally's raw XML for the Bill Outstanding TDL and
 * what the desktop would decide. Read-only HTTP export requests; never starts,
 * stops or restarts Tally.
 *
 *   node scripts/tdl-probe.js [--port 9000] [--full] "Yash Ki Company" "Laveena" "Radhe Ram"
 *
 * Prints Global Health once, then per company (serially): Context reply, Bill
 * reply (first 3 BILLROWs unless --full) and the snapshot decision.
 */
const axios = require("axios");
const {
  healthRequestXml,
  contextRequestXml,
  classifyHealthResponse,
  classifyContextResponse,
  decodeTallyBody,
  CONTEXT_STATUS,
} = require("../util/tdlHealth");
const { billRequestXml, classifyBillResponse, decideBillSnapshot } = require("../util/billSnapshot");

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 9000;
const full = args.includes("--full");
const companies = args.filter((a, i) => !a.startsWith("--") && (portIdx < 0 || i !== portIdx + 1));

async function post(xml, timeout = 60000) {
  const res = await axios.post(`http://localhost:${port}`, xml, {
    headers: { "Content-Type": "text/xml" },
    responseType: "arraybuffer",
    timeout,
  });
  return decodeTallyBody(res.data);
}

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function currentFy(now = new Date()) {
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return { fromDate: `${y}0401`, toDate: `${y + 1}0331`, currentDate: ymd(now) };
}

/** First 3 BILLROWs, unless --full. */
function excerpt(text) {
  if (full) return text;
  const rows = text.match(/<BILLROW[\s>][\s\S]*?<\/BILLROW>/gi) || [];
  if (rows.length <= 3) return text;
  const head = text.slice(0, text.indexOf(rows[0]));
  return `${head}${rows.slice(0, 3).join("\n")}\n<!-- … ${rows.length - 3} more BILLROW … -->\n</ENVELOPE>`;
}

const bytes = (t) => Buffer.byteLength(String(t ?? ""), "utf8");
const FETCH_BILLS_AFTER = new Set([CONTEXT_STATUS.VERIFIED, CONTEXT_STATUS.REPORT_MISSING, CONTEXT_STATUS.OUTDATED]);

(async () => {
  console.log(`=== 1. Global Health (port ${port}) ===`);
  let health;
  try {
    const text = await post(healthRequestXml(), 15000);
    console.log(`bytes: ${bytes(text)}`);
    console.log(text.trim());
    health = classifyHealthResponse(text);
  } catch (e) {
    health = { status: "TALLY_UNREACHABLE", reason: e?.code || e?.message };
  }
  console.log("→ health:", JSON.stringify(health));

  const summary = [];
  for (const companyName of companies) {
    const period = { companyName, ...currentFy() };
    console.log(`\n=== Context: ${companyName} ===`);
    let context;
    try {
      const text = await post(contextRequestXml(period), 15000);
      console.log(`bytes: ${bytes(text)}`);
      console.log(text.trim());
      context = classifyContextResponse(text, companyName);
    } catch (e) {
      context = { status: CONTEXT_STATUS.ERROR, reason: e?.code || e?.message };
    }
    console.log("→ context:", JSON.stringify(context));

    let bill = { kind: "SKIPPED" };
    if (FETCH_BILLS_AFTER.has(context.status)) {
      console.log(`\n=== Bills: ${companyName} ===`);
      try {
        const text = await post(billRequestXml(period));
        console.log(`bytes: ${bytes(text)}`);
        console.log(excerpt(text).trim());
        bill = classifyBillResponse(text);
      } catch (e) {
        bill = { kind: "ERROR", reason: e?.code || e?.message };
      }
      console.log("→ bill:", JSON.stringify({ kind: bill.kind, rows: bill.rows?.length ?? 0, reason: bill.reason }));
    } else {
      console.log(`(bill request skipped: context ${context.status})`);
    }

    const d = decideBillSnapshot({ health, context, bill, requestedCompany: companyName });
    console.log("→ snapshot:", JSON.stringify({
      status: d.status,
      snapshotComplete: d.snapshotComplete,
      rowCount: d.rowCount,
      tdlStatus: d.tdlStatus,
      authority: d.authority || null,
      reason: d.reason || null,
    }));
    summary.push([companyName, context.status, d.status, String(d.snapshotComplete), String(d.rowCount),
      d.status === "SUCCESS" ? (d.rowCount > 0 ? "replace bills" : "clear bills") : "keep old bills"]);
  }

  if (summary.length) {
    const headers = ["Company", "Context", "Status", "Complete", "Rows", "Backend action"];
    const widths = headers.map((h, i) => Math.max(h.length, ...summary.map((r) => r[i].length)));
    const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join("   ");
    console.log(`\nHealth: ${health.status}${health.version ? ` ${health.version}` : ""}`);
    console.log(line(headers));
    console.log("-".repeat(widths.reduce((a, w) => a + w + 3, -3)));
    for (const r of summary) console.log(line(r));
  }
})();
