#!/usr/bin/env node
/**
 * Owner-run Tally evidence capture (R3: findings 02, 07, 11). READ-ONLY: every request is an
 * Export built from this app's own xmls/ templates; anything else is refused before sending.
 * Run on the Windows PC with the disposable/test company open in TallyPrime. Raw responses are
 * written to the output folder for you to review and redact before sharing; the console shows
 * counts and timings only.
 *
 *   node scripts/tally-capture/capture.js bytes      --company "Name" --out C:\capture   (02)
 *   node scripts/tally-capture/capture.js core-list  --company "Name" --guid <companyGuid> --from 20250401 --to 20260331 --out C:\capture   (07)
 *   node scripts/tally-capture/capture.js partition  --company "Name" --from 20250401 --to 20250430 --out C:\capture   (11)
 *
 * Options: --port 9000 (Tally's XML port, default 9000).
 */
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..", "..");
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i > 0 && args[i + 1] ? args[i + 1] : def;
};
const port = Number(opt("port", "9000"));
const out = opt("out");
const company = opt("company");

const xmlText = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function template(file, vars) {
  let xml = fs.readFileSync(path.join(ROOT, "xmls", file), "utf8");
  if (!/<TALLYREQUEST>\s*Export\s*<\/TALLYREQUEST>/i.test(xml)) throw new Error(`${file} is not an Export request — refused`);
  for (const [k, v] of Object.entries(vars)) xml = xml.split(k).join(xmlText(v));
  if (vars.$$COMPANY_NAME) xml = xml.replace(/<SVCURRENTCOMPANY>[^<]*<\/SVCURRENTCOMPANY>/g, `<SVCURRENTCOMPANY>${xmlText(vars.$$COMPANY_NAME)}</SVCURRENTCOMPANY>`);
  return xml;
}

function post(body) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request({ host: "127.0.0.1", port, method: "POST", headers: { "Content-Type": "text/xml" }, timeout: 120_000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks), ms: Date.now() - started }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

function save(name, res) {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${name}.bin`), res.bytes);
  fs.writeFileSync(path.join(out, `${name}.meta.json`), JSON.stringify({ status: res.status, contentType: res.headers["content-type"] || null, bytes: res.bytes.length, ms: res.ms }, null, 2));
}

const countTag = (buf, tag) => (buf.toString("latin1").match(new RegExp(`<${tag}>`, "gi")) || []).length;

async function bytes() {
  // 02: raw response bytes and declared encoding for reports that carry names, addresses and text.
  for (const [name, file, vars] of [
    ["02-companies", "Companies.xml", {}],
    ["02-current-company", "CurrentCompany.xml", {}],
    ["02-ledgers", "LedgerFull.xml", { $$COMPANY_NAME: company, $$ALTER_ID: "0" }],
  ]) {
    const res = await post(template(file, vars));
    save(name, res);
    const head = res.bytes.subarray(0, 4).toString("hex");
    console.log(`${name}: ${res.bytes.length} bytes, first bytes ${head}, content-type ${res.headers["content-type"] || "-"}, ${res.ms} ms`);
  }
}

async function coreList() {
  // 07: the core voucher list for one FY via the built-in collection (no Bill Outstanding add-on).
  const guid = opt("guid");
  const res = await post(template("SimplifiedVoucher.xml", { $$COMPANY_NAME: company, $$COLLNAME: "Voucher", $$FROM_DATE: opt("from"), $$TO_DATE: opt("to") }));
  save("07-core-voucher-list", res);
  const text = res.bytes.toString("utf8");
  const guids = [...text.matchAll(/<GUID>([^<]*)<\/GUID>/gi)].map((m) => m[1].trim());
  const own = guid ? guids.filter((g) => g.startsWith(`${guid}-`)).length : null;
  console.log(`07: ${guids.length} vouchers listed, ${own ?? "?"} with this company's GUID prefix, LINEERROR: ${/LINEERROR/i.test(text)}, ${res.ms} ms`);
}

async function partition() {
  // 11: one day per request across the range — row counts, bytes and time per day.
  const from = opt("from");
  const to = opt("to");
  const day = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const rows = [];
  for (let d = day(from); ymd(d) <= to; d = new Date(d.getTime() + 86_400_000)) {
    const date = ymd(d);
    const res = await post(template("AllVoucher.xml", { $$COMPANY_NAME: company, $$ALTER_ID: "0", $$FROM_DATE: date, $$TO_DATE: date }));
    save(`11-allvoucher-${date}`, res);
    rows.push({ date, vouchers: countTag(res.bytes, "VOUCHER"), bytes: res.bytes.length, ms: res.ms });
    console.log(`11: ${date} ${rows.at(-1).vouchers} vouchers, ${res.bytes.length} bytes, ${res.ms} ms`);
  }
  fs.writeFileSync(path.join(out, "11-summary.json"), JSON.stringify(rows, null, 2));
}

(async () => {
  if (!out) throw new Error("--out <folder> is required");
  if (cmd !== "bytes" && !company) throw new Error("--company is required");
  if (cmd === "bytes") return bytes();
  if (cmd === "core-list") return coreList();
  if (cmd === "partition") return partition();
  throw new Error("command must be bytes, core-list or partition");
})().catch((err) => {
  console.error("capture failed:", err.message);
  process.exit(1);
});
