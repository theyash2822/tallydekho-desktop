// R1 / S5: real logger entry points redact credentials and accounting content, keep error
// causes, stay bounded, and the activity history is capped without touching backup data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "td-log-"));
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "electron") return { app: { getPath: () => dir } };
  return realLoad.call(this, request, ...rest);
};
const logger = require("../util/logger");
const { boundActivity, MAX_ACTIVITY } = require("../util/activityHistory");
const logText = () => fs.readFileSync(path.join(dir, "logs", "info.log"), "utf8");

test("nested and circular errors keep message, code and cause; credentials are redacted", () => {
  const root = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9000"), { code: "ECONNREFUSED" });
  const outer = new Error("sync failed: Authorization: Bearer abcdefghijklmnop.qrstuvwxyz", { cause: root });
  const meta = { err: outer, headers: { authorization: "Bearer zzzzzzzzzzzzzzzz" }, deviceSecret: "s3cret-value" };
  meta.self = meta;
  logger.error("[sync] failed", meta);
  const line = logText().trim().split("\n").at(-1);
  assert.match(line, /sync failed/);
  assert.match(line, /"cause":\{"name":"Error","message":"connect ECONNREFUSED 127\.0\.0\.1:9000","code":"ECONNREFUSED"/);
  assert.match(line, /\[Circular\]/);
  assert.doesNotMatch(line, /abcdefghijklmnop|zzzzzzzzzzzzzzzz|s3cret-value/);
});

test("accounting payloads are logged by size only", () => {
  const xml = `<ENVELOPE>${"<VOUCHER><AMOUNT>123456.78</AMOUNT><PARTYNAME>Shah Traders</PARTYNAME></VOUCHER>".repeat(50)}</ENVELOPE>`;
  logger.info("[tally:write] job", { jobId: "j-1", xml, payload: { party: "Shah Traders", amount: 99 } });
  const line = logText().trim().split("\n").at(-1);
  assert.match(line, /"jobId":"j-1"/);
  assert.match(line, /"xml":"\[omitted \d+ chars\]"/);
  assert.match(line, /"payload":"\[omitted 2 keys\]"/);
  assert.doesNotMatch(line, /Shah Traders|123456\.78/);
});

test("a huge message or JWT inside free text stays bounded and redacted", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjEyMzQ1Njc4fQ.c2lnbmF0dXJlc2lnbmF0dXJl";
  logger.info(`token=${jwt} ${"x".repeat(50_000)}`);
  const line = logText().trim().split("\n").at(-1);
  assert.ok(line.length < 5_000, `line is ${line.length} chars`);
  assert.doesNotMatch(line, /eyJhbGciOiJIUzI1NiJ9\.eyJ/);
});

test("rotation keeps the live log bounded", () => {
  const file = path.join(dir, "logs", "info.log");
  fs.writeFileSync(file, "x".repeat(logger.MAX_FILE_BYTES + 10));
  logger.info("after rotation");
  assert.ok(fs.statSync(file).size < 1024);
  assert.ok(fs.existsSync(path.join(dir, "logs", "info.1.log")));
});

test("activity history is capped, newest first; other lists are untouched", () => {
  const list = Array.from({ length: MAX_ACTIVITY + 50 }, (_, i) => ({ date: i, message: `Backup ${i}` }));
  const bounded = boundActivity(list);
  assert.equal(bounded.length, MAX_ACTIVITY);
  assert.equal(bounded[0].message, "Backup 0");
  assert.equal(list.length, MAX_ACTIVITY + 50, "input not mutated");
  assert.deepEqual(boundActivity(undefined), []);
});
