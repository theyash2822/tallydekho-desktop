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
const { runTallyExclusive, xmlText } = require("./tallyQueue");

/** Must match TDKBOH Version in xmls/TDKBillOutstanding.tdl. */
const TDL_VERSION = "1.1.0";
const HEALTH_REPORT_ID = "TDKBillOutstandingHealth";

const TDL_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  ACTIVE_OUTDATED: "ACTIVE_OUTDATED",
  // Health report missing but the bill report returned rows: pre-1.1.0 add-on.
  ACTIVE_LEGACY: "ACTIVE_LEGACY",
  // Health report missing; the bill report may or may not exist.
  HEALTH_MISSING: "HEALTH_MISSING",
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

function healthRequestXml(companyName) {
  const company = String(companyName || "").trim();
  const sv = company ? `\n        <SVCURRENTCOMPANY>${xmlText(company)}</SVCURRENTCOMPANY>` : "";
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
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${sv}
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>`;
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
      const env = parser.parse(body)?.ENVELOPE || {};
      node = Array.isArray(env.TDKSTATUS) ? env.TDKSTATUS[0] : env.TDKSTATUS;
    } catch {
      return { status: TDL_STATUS.INVALID_RESPONSE, reason: "health_parse_failed" };
    }
    const active = String(node?.ACTIVE ?? "").trim().toUpperCase() === "YES";
    const version = String(node?.VERSION ?? "").trim();
    const company = String(node?.COMPANY ?? "").trim();
    if (!active) return { status: TDL_STATUS.INVALID_RESPONSE, reason: "health_not_active", version, company };
    return {
      status: version === TDL_VERSION ? TDL_STATUS.ACTIVE : TDL_STATUS.ACTIVE_OUTDATED,
      version,
      company,
    };
  }

  if (looksLikeMissingReport(body)) return { status: TDL_STATUS.HEALTH_MISSING, reason: "health_report_missing" };
  return { status: TDL_STATUS.INVALID_RESPONSE, reason: "unexpected_shape" };
}

/**
 * Ask running Tally whether the Bill Outstanding TDL (with health report) is loaded.
 * Read-only: one HTTP export request, nothing else.
 */
async function checkTdlHealth(companyName, { post = postToTally, timeout = 15000 } = {}) {
  const started = Date.now();
  try {
    const text = await post(healthRequestXml(companyName), { timeout });
    return { ...classifyHealthResponse(text), durationMs: Date.now() - started };
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

module.exports = {
  TDL_VERSION,
  HEALTH_REPORT_ID,
  TDL_STATUS,
  checkTdlHealth,
  classifyHealthResponse,
  classifyTransportError,
  looksLikeMissingReport,
  normaliseCompany,
  isActiveHealth,
  postToTally,
  decodeTallyBody,
};
