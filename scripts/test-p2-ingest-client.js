// P2 desktop ingest-client contracts: finite deadlines, no blind re-send, sync-run lifecycle.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const xml = fs.readFileSync(path.join(root, "util/xml.js"), "utf8");
const helper = fs.readFileSync(path.join(root, "util/helper.js"), "utf8");

test("every backend request has a finite deadline", () => {
  assert.match(helper, /timeout:\s*60_000/);
  assert.match(xml, /const CHUNK_TIMEOUT_MS = 120_000;/);
  assert.match(xml, /const COMPLETE_TIMEOUT_MS = 10 \* 60_000;/);
  assert.match(xml, /"\/ingest\/chunk", body, \{ headers, signal: jobSignal\(\), timeout: CHUNK_TIMEOUT_MS \}/);
  assert.match(xml, /"\/ingest\/complete", \{ uploadId, \.\.\.extras \}, \{ timeout: COMPLETE_TIMEOUT_MS \}/);
});

test("a timed-out complete is reported as unknown, not re-sent", () => {
  const start = xml.indexOf('"/ingest/complete", { uploadId');
  const block = xml.slice(start, start + 1200);
  const timeoutCheck = block.indexOf('err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT"');
  assert.ok(timeoutCheck > 0);
  assert.ok(block.indexOf('code: "COMPLETE_OUTCOME_UNKNOWN"') > timeoutCheck);
  assert.ok(timeoutCheck < block.indexOf("setTimeout(r, 1500 * attempt)"), "unknown outcome returns before any retry");
});

test("deterministic chunk refusals are not retried", () => {
  for (const code of ["NDJSON_INVALID", "CHUNK_TOO_LARGE", "CHUNK_CONTENT_CONFLICT", "UPLOAD_OWNERSHIP_DENIED", "COMPANY_GUID_REQUIRED"]) {
    assert.ok(xml.includes(`"${code}"`), `${code} must be non-retryable`);
  }
  assert.match(xml, /!NON_RETRYABLE_CHUNK_CODES\.has\(code\) && e\?\.response\?\.status !== 401 && e\?\.response\?\.status !== 403/);
});

test("the sync run starts after init-sync and is kept alive until the sync ends", () => {
  const body = xml.slice(xml.indexOf("const syncTallyDataUnlocked"));
  const init = body.indexOf("await initSync(selectedCompanies, isHardSync)");
  const start = body.indexOf("'/ingest/sync-run/start'");
  assert.ok(init > 0 && start > init, "run must start after init-sync so a first-sync company has an ID");
  // R2 / S7: one run per company (behaviour: scripts/test-r1-company-isolation.js).
  assert.ok(body.indexOf("startSyncRunHeartbeat(syncRunIds)") > start);

  const wrapper = xml.slice(xml.indexOf("const syncTallyData = async"), xml.indexOf("const isSyncRunning"));
  assert.match(wrapper, /finally \{\s*stopSyncRunHeartbeat\(\);/);
  assert.match(xml, /'\/ingest\/sync-run\/heartbeat', \{ syncRunId \}/);
});

// R2 / S7: each company's own run now ends with that company's outcome (a run is no longer
// shared, so "partial" is reported per company as completed / failed).
test("each company's run is completed with that company's own outcome", () => {
  assert.match(xml, /o\.status === "uploaded"\s*\?\s*\{ syncRunId, status: 'completed', uploadId: o\.uploadId \}\s*:\s*\{ syncRunId, status: 'failed'/);
});
