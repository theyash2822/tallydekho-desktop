/**
 * Read-only Bill Outstanding TDL health check.
 *
 * Only talks to Tally over HTTP. This module must never close, kill, start or
 * restart Tally — sync depends on that guarantee. Restarting belongs to
 * Settings → Retry Setup (ensureBillOutstandingTdl.js).
 */
const axios = require("axios");
const iconv = require("iconv-lite");
const { XMLParser } = require("fast-xml-parser");
const { runTallyExclusive } = require("./tallyQueue");
const { info } = require("./logger");

/** Must match TDKBOH Version in xmls/TDKBillOutstanding.tdl. */
const TDL_VERSION = "1.1.2";
const HEALTH_REPORT_ID = "TDKBillOutstandingHealth";

const TDL_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  ACTIVE_OUTDATED: "ACTIVE_OUTDATED",
  // Health report missing but the bill report returned rows: pre-1.1.0 add-on.
  ACTIVE_LEGACY: "ACTIVE_LEGACY",
  // Health report missing; the bill report may or may not exist.
  HEALTH_MISSING: "HEALTH_MISSING",
  // Health report answered without a usable ACTIVE row (e.g. empty envelope).
  // Neither "loaded" nor "missing"; Settings never shows Ready for it.
  HEALTH_UNCONFIRMED: "HEALTH_UNCONFIRMED",
  NOT_LOADED: "NOT_LOADED",
  TALLY_UNREACHABLE: "TALLY_UNREACHABLE",
  TALLY_TIMEOUT: "TALLY_TIMEOUT",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  UNKNOWN: "UNKNOWN",
});

const parser = new XMLParser({
  ignoreAttributes: true,
  textNodeName: "value",
  parseTagValue: false,
  trimValues: true,
});

function decodeTallyBody(data) {
  if (typeof data === "string") return data;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return iconv.decode(buf, "utf16-le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return iconv.decode(buf, "utf16-be");
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString("utf8");
  }
  const sample = buf.slice(0, Math.min(120, buf.length));
  let nulls = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) nulls++;
  if (sample.length > 20 && nulls > sample.length / 4) return iconv.decode(buf, "utf16-le");
  return buf.toString("utf8");
}

function tallyUrl() {
  const port = require("./store").get("port") || 9000;
  return `http://localhost:${port}`;
}

/** POST one XML request to Tally. Resolves to decoded text; rejects on transport errors. */
async function postToTally(xml, { timeout = 20000 } = {}) {
  const response = await runTallyExclusive(() => axios.post(tallyUrl(), xml, {
    headers: { "Content-Type": "text/xml", Accept: "application/xml, text/xml, */*" },
    responseType: "arraybuffer",
    timeout,
  }));
  return decodeTallyBody(response.data);
}

function classifyTransportError(err) {
  const code = String(err?.code || "");
  const msg = String(err?.message || "");
  if (code === "ECONNABORTED" || code === "ETIMEDOUT" || /timeout/i.test(msg)) {
    return TDL_STATUS.TALLY_TIMEOUT;
  }
  return TDL_STATUS.TALLY_UNREACHABLE;
}

/** Tally's answer to an export for a report ID it does not know. */
function looksLikeMissingReport(text) {
  return (
    /LINEERROR/i.test(text) ||
    /could not find|does not exist|unknown request|unknown report|not found/i.test(text)
  );
}

function normaliseCompany(name) {
  return String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Company-independent: health only answers "is the add-on loaded?". Company identity comes from the bill report. */
function healthRequestXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>${HEALTH_REPORT_ID}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

const EMPTY_ENVELOPE = /^\s*(<\?xml[^>]*\?>)?\s*(<ENVELOPE\s*\/>|<ENVELOPE\s*>\s*<\/ENVELOPE\s*>)\s*$/i;

/** First node named `tag` (case-insensitive) anywhere in the parsed tree; Tally may or may not wrap it in ENVELOPE. */
function findTag(tree, tag) {
  if (!tree || typeof tree !== "object") return undefined;
  for (const [key, value] of Object.entries(tree)) {
    if (key.toUpperCase() === tag) return Array.isArray(value) ? value[0] : value;
  }
  for (const value of Object.values(tree)) {
    const found = findTag(Array.isArray(value) ? value[0] : value, tag);
    if (found !== undefined) return found;
  }
  return undefined;
}

function pick(node, key) {
  if (!node || typeof node !== "object") return "";
  const hit = Object.keys(node).find((k) => k.toUpperCase() === key);
  const v = hit ? node[hit] : "";
  return String((v && typeof v === "object" ? v.value : v) ?? "").trim();
}

/** Short one-line copy of Tally's reply for logs when the health check is not ACTIVE. */
function responseSample(text, max = 400) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Classify the health report response. Pure.
 * @returns {{ status: string, version?: string, company?: string, reason?: string }}
 */
function classifyHealthResponse(text) {
  const body = String(text ?? "");
  if (!body.trim()) return { status: TDL_STATUS.INVALID_RESPONSE, reason: "empty_body" };

  if (/<TDKSTATUS[\s>]/i.test(body)) {
    let node;
    try {
      node = findTag(parser.parse(body), "TDKSTATUS");
    } catch {
      return { status: TDL_STATUS.INVALID_RESPONSE, reason: "health_parse_failed" };
    }
    const active = pick(node, "ACTIVE").toUpperCase() === "YES";
    const version = pick(node, "VERSION");
    const report = pick(node, "REPORT");
    if (!active) return { status: TDL_STATUS.HEALTH_UNCONFIRMED, reason: "health_not_active", version, report };
    return {
      status: version === TDL_VERSION ? TDL_STATUS.ACTIVE : TDL_STATUS.ACTIVE_OUTDATED,
      version,
      report,
    };
  }

  if (looksLikeMissingReport(body)) return { status: TDL_STATUS.HEALTH_MISSING, reason: "health_report_missing" };
  // Known report ID, no row: not proof of either "loaded" or "missing" (TDL 1.1.0 did this).
  if (EMPTY_ENVELOPE.test(body)) return { status: TDL_STATUS.HEALTH_UNCONFIRMED, reason: "empty_envelope" };
  return { status: TDL_STATUS.INVALID_RESPONSE, reason: "unexpected_shape" };
}

let inFlight = null;

/**
 * Ask running Tally whether the Bill Outstanding TDL (with health report) is loaded.
 * Read-only: one HTTP export request, nothing else. Concurrent callers using the
 * real transport share one in-flight request.
 */
async function checkTdlHealth({ post, timeout = 15000 } = {}) {
  if (post) return runHealthCheck(post, timeout);
  if (inFlight) {
    info("[tdl] health deduped");
    return inFlight;
  }
  inFlight = runHealthCheck(postToTally, timeout);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function runHealthCheck(post, timeout) {
  const started = Date.now();
  try {
    const text = await post(healthRequestXml(), { timeout });
    const result = { ...classifyHealthResponse(text), durationMs: Date.now() - started };
    if (!isActiveHealth(result.status)) {
      result.sample = responseSample(text);
      info("[tdl] health reply not active", {
        status: result.status,
        reason: result.reason,
        bytes: String(text ?? "").length,
        sample: result.sample,
      });
    }
    return result;
  } catch (err) {
    return {
      status: classifyTransportError(err),
      reason: err?.code || err?.message || "request_failed",
      durationMs: Date.now() - started,
    };
  }
}

function isActiveHealth(status) {
  return status === TDL_STATUS.ACTIVE || status === TDL_STATUS.ACTIVE_OUTDATED;
}

/** Health could not confirm the add-on but Tally answered: the bill report may still be tried. */
function isUnconfirmedHealth(status) {
  return status === TDL_STATUS.HEALTH_UNCONFIRMED || status === TDL_STATUS.INVALID_RESPONSE;
}

module.exports = {
  TDL_VERSION,
  HEALTH_REPORT_ID,
  TDL_STATUS,
  checkTdlHealth,
  healthRequestXml,
  classifyHealthResponse,
  isUnconfirmedHealth,
  responseSample,
  classifyTransportError,
  looksLikeMissingReport,
  normaliseCompany,
  isActiveHealth,
  postToTally,
  decodeTallyBody,
};
