#!/usr/bin/env node
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { restrictOwnerOnly, canRestrictPermissions, OWNER_FILE } = require("../util/filePrivacy");
const { looksLikeZipArchive } = require("../util/backupArchive");

test("staging archive is owner-only on unix", async () => {
  if (!canRestrictPermissions()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "td-priv-"));
  const file = path.join(dir, "archive.zip");
  fs.writeFileSync(file, "x");
  await restrictOwnerOnly(file);
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, OWNER_FILE);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("preload no longer exposes a local-file restore API", () => {
  const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  assert.equal(preload.includes("startRestore"), false);
  assert.equal(preload.includes("tally:restore_backup"), false);
});

test("restoreBackup no longer registers a renderer restore_backup IPC", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "util", "restoreBackup.js"), "utf8");
  assert.equal(src.includes('ipcMain.handle("tally:restore_backup"'), false);
});

test("failed backup cleanup unlinks both partial and final names", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "util", "saveBackup.js"), "utf8");
  assert.match(src, /unlinkQuiet\(partialZip\)/);
  assert.match(src, /unlinkQuiet\(zipPath\)/);
  assert.match(src, /if \(code === 0\)/);
  assert.equal(/code === 0 \|\| code === 1/.test(src), false);
});

test("S3 upload authorization requests SSE-S3", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "td-backend", "src", "services", "objectStore.js"),
    "utf8"
  );
  assert.match(src, /ServerSideEncryption:\s*'AES256'/);
});

test("cloud restore verifies checksum before dest overwrite", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "util", "restoreBackup.js"), "utf8");
  const run = src.slice(src.indexOf("async function runCloudRestore"));
  const hashIdx = run.indexOf("BACKUP_CHECKSUM_MISMATCH");
  const destIdx = run.indexOf("restoreBackup(");
  assert.ok(hashIdx > 0 && destIdx > hashIdx);
});

test("non-zip bytes are rejected", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "td-bak-"));
  const junk = path.join(dir, "x.bin");
  fs.writeFileSync(junk, "nope");
  assert.equal(looksLikeZipArchive(junk), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
