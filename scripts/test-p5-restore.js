const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseSevenZipListing,
  inspectArchiveEntries,
  checkRestoredFolders,
} = require("../util/restoreGuards");
const { rememberRestoreRequest, restoreHeaders, sendRestoreAck, retryPendingRestoreAck } = require("../util/restoreAck");

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get: (k) => m.get(k),
    set: (k, v) => m.set(k, v),
    delete: (k) => m.delete(k),
    has: (k) => m.has(k),
  };
}

const LISTING = `
7-Zip (a) 23.01

Listing archive: x.zip

--
Path = x.zip
Type = zip

----------
Path = 10000
Folder = +
Size = 0

Path = 10000/Company.900
Folder = -
Size = 1024
Attributes = A -rw-r--r--

Path = 10000/Tran.900
Folder = -
Size = 4096
`;

test("7z listing parses and a normal company folder passes", () => {
  const entries = parseSevenZipListing(LISTING);
  assert.equal(entries.length, 3);
  const r = inspectArchiveEntries(entries, { freeBytes: 10 * 1024 * 1024 * 1024 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.topFolders, ["10000"]);
  assert.equal(r.totalBytes, 5120);
});

test("unsafe archives are refused before extraction", () => {
  const cases = [
    [{ path: "../evil/x", size: 1 }],
    [{ path: "10000/../../x", size: 1 }],
    [{ path: "/etc/passwd", size: 1 }],
    [{ path: "C:\\Windows\\x", size: 1 }],
    [{ path: "10000/link", size: 1, attributes: "lrwxrwxrwx" }],
    [{ path: "10000/link", size: 1, symlink: "/etc" }],
    [{ path: "loose.txt", size: 1, isDir: false }],
  ];
  for (const entries of cases) {
    const r = inspectArchiveEntries(entries);
    assert.equal(r.ok, false, JSON.stringify(entries));
    assert.equal(r.code, "BACKUP_ARCHIVE_UNSAFE");
  }
  assert.equal(inspectArchiveEntries([]).code, "BACKUP_ARCHIVE_EMPTY");
});

test("expanded size larger than free space is refused", () => {
  const r = inspectArchiveEntries([{ path: "10000/Tran.900", size: 5 * 1024 * 1024 * 1024 }], { freeBytes: 1024 * 1024 * 1024 });
  assert.equal(r.code, "RESTORE_DISK_SPACE");
});

test("restored folders must match the manifest folders exactly; legacy manifests skip", () => {
  const manifest = [{ guid: "g1", name: "Acme", folder: "10000" }, { guid: "g2", name: "Beta", folder: "10001" }];
  assert.equal(checkRestoredFolders(manifest, ["10000", "10001"]).ok, true);
  const missing = checkRestoredFolders(manifest, ["10000"]);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ["10001"]);
  const extra = checkRestoredFolders(manifest, ["10000", "10001", "10002"]);
  assert.deepEqual(extra.extra, ["10002"]);
  assert.deepEqual(checkRestoredFolders([{ guid: "g1", name: "Acme" }], ["anything"]), { ok: true, skipped: true });
  assert.equal(checkRestoredFolders(JSON.stringify(manifest), ["10000", "10001"]).ok, true);
});

test("restore token stays in the main process", () => {
  const store = memStore();
  const out = rememberRestoreRequest(store, { code: "AB12CD", restoreToken: "secret-token", expiresAt: 1 });
  assert.deepEqual(out, { code: "AB12CD", expiresAt: 1 });
  assert.equal(store.get("restoreToken"), "secret-token");
  assert.deepEqual(restoreHeaders(store), { "x-restore-token": "secret-token" });
});

test("a lost completion acknowledgement is persisted and retried once the server answers", async () => {
  const store = memStore({ restoreToken: "tok" });
  const calls = [];
  let online = false;
  const post = async (url, body, opts) => {
    calls.push({ url, body, headers: opts?.headers });
    if (!online) throw Object.assign(new Error("socket hang up"), { response: undefined });
    return { data: { status: true, data: { activated: true, deviceSecret: "new-secret", repeated: true } } };
  };
  const secrets = [];
  const applySecret = async (s) => secrets.push(s);

  const first = await sendRestoreAck({ store, post, ack: { restoredFolders: ["10000"] }, applySecret, nowMs: 1000 });
  assert.equal(first.status, false);
  assert.equal(first.retry, true);
  assert.equal(store.get("pendingRestoreAck").token, "tok");
  assert.deepEqual(calls[0].body, { ok: true, restoredFolders: ["10000"], lineageGuids: [] });
  assert.deepEqual(calls[0].headers, { "x-restore-token": "tok" });

  online = true;
  const again = await retryPendingRestoreAck({ store, post, applySecret, nowMs: 2000 });
  assert.equal(again.status, true);
  assert.deepEqual(secrets, ["new-secret"]);
  assert.equal(store.get("pendingRestoreAck"), undefined);
  assert.equal(store.get("restoreToken"), undefined);
});

test("a definite server rejection drops the pending acknowledgement; stale ones expire", async () => {
  const store = memStore({ restoreToken: "tok" });
  const post = async () => {
    throw Object.assign(new Error("409"), { response: { data: { code: "TALLY_DATA_MISMATCH", message: "mismatch" } } });
  };
  const r = await sendRestoreAck({ store, post, ack: { restoredFolders: ["10009"] }, applySecret: async () => {} });
  assert.equal(r.code, "TALLY_DATA_MISMATCH");
  assert.equal(store.get("pendingRestoreAck"), undefined);

  const old = memStore({ pendingRestoreAck: { token: "t", at: 0, restoredFolders: [] } });
  const expired = await retryPendingRestoreAck({ store: old, post, applySecret: async () => {}, nowMs: 24 * 60 * 60 * 1000 });
  assert.equal(expired.code, "RESTORE_ACK_EXPIRED");
  assert.equal(old.get("pendingRestoreAck"), undefined);
});
