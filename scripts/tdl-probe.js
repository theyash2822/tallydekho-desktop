#!/usr/bin/env node
/**
 * Windows QA helper: print Tally's raw XML for the Bill Outstanding TDL.
 * Read-only HTTP export requests; never starts, stops or restarts Tally.
 *
 *   node scripts/tdl-probe.js [--port 9000] "Yash Ki Company" "Laveena"
 *
 * Prints the health reply, then each company's bill reply (TDKCONTEXT + first
 * rows; full reply with --full), and how the desktop would classify them.
 */
const axios = require("axios");
const { healthRequestXml, classifyHealthResponse, decodeTallyBody } = require("../util/tdlHealth");
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

/** Context + first 3 BILLROWs, unless --full. */
function excerpt(text) {
  if (full) return text;
  const rows = text.match(/<BILLROW[\s>][\s\S]*?<\/BILLROW>/gi) || [];
  if (rows.length <= 3) return text;
  const head = text.slice(0, text.indexOf(rows[0]));
  return `${head}${rows.slice(0, 3).join("\n")}\n<!-- … ${rows.length - 3} more BILLROW … -->\n</ENVELOPE>`;
}

(async () => {
  console.log(`=== Health (port ${port}) ===`);
  let health;
  try {
    const text = await post(healthRequestXml(), 15000);
    console.log(text.trim());
    health = classifyHealthResponse(text);
  } catch (e) {
    health = { status: "TALLY_UNREACHABLE", reason: e?.code || e?.message };
  }
  console.log("→ classified:", JSON.stringify(health));

  for (const companyName of companies) {
    console.log(`\n=== Bills: ${companyName} ===`);
    try {
      const text = await post(billRequestXml({ companyName, ...currentFy() }));
      console.log(excerpt(text).trim());
      const bill = classifyBillResponse(text);
      const decision = decideBillSnapshot(health, bill, companyName);
      console.log("→ bill:", JSON.stringify({ kind: bill.kind, contextCompany: bill.contextCompany ?? null, rows: bill.rows?.length ?? 0, reason: bill.reason }));
      console.log("→ snapshot:", JSON.stringify({ status: decision.status, snapshotComplete: decision.snapshotComplete, rowCount: decision.rowCount, tdlStatus: decision.tdlStatus, reason: decision.reason || null }));
    } catch (e) {
      console.log("→ request failed:", e?.code || e?.message);
    }
  }
})();
