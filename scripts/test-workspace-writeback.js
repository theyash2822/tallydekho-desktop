#!/usr/bin/env node
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  getSelectedCompanies,
  setSelectedCompanies,
  clearWorkspaceBinding,
  setBoundWorkspaceId,
  getBoundWorkspaceId,
  __setStoreForTests,
} = require("../util/companySelection");
const {
  processCompanyWriteback,
  reconcilePendingWriteback,
  companyGuidsFromSelection,
  __setDepsForTests,
  resetDepsForTests,
} = require("../util/writeback");
const { mapPairedDevice } = require("../util/pairingRuntime");
const { looksLikeZipArchive } = require("../util/backupArchive");
const {
  canRendererRead,
  canRendererWrite,
  RENDERER_FORBIDDEN_PREFS,
} = require("../util/storeAllowlist");

function memoryStore(initial = {}) {
  const data = { ...initial };
  return {
    get: (k) => data[k],
    set: (k, v) => {
      data[k] = v;
    },
    delete: (k) => {
      delete data[k];
    },
  };
}

beforeEach(() => {
  __setStoreForTests(memoryStore());
  resetDepsForTests();
});

afterEach(() => {
  __setStoreForTests(null);
  resetDepsForTests();
});

test("changing cached workspaceId does not keep another workspace's companies", () => {
  setBoundWorkspaceId("ws-a");
  setSelectedCompanies([{ guid: "X", name: "Acme" }]);
  assert.equal(getSelectedCompanies()[0].guid, "X");

  const dropped = setBoundWorkspaceId("ws-b");
  assert.equal(dropped, true);
  assert.deepEqual(getSelectedCompanies(), []);
  assert.equal(getBoundWorkspaceId(), "ws-b");
});

test("unpair clears tenant selection so re-pair cannot inherit it", () => {
  const backing = memoryStore({
    lastSync: "2026-01-01T00:00:00.000Z",
    myLastSyncEpoch: 1700000000,
  });
  __setStoreForTests(backing);
  setBoundWorkspaceId("ws-a");
  setSelectedCompanies([{ guid: "X", name: "Acme" }]);
  clearWorkspaceBinding();
  assert.equal(getBoundWorkspaceId(), null);
  assert.deepEqual(getSelectedCompanies(), []);
  assert.equal(backing.get("lastSync"), undefined);
  assert.equal(backing.get("myLastSyncEpoch"), undefined);

  setBoundWorkspaceId("ws-b");
  assert.deepEqual(getSelectedCompanies(), []);
});

test("temporary reconnect keeps selection for the same binding", () => {
  setBoundWorkspaceId("ws-a");
  setSelectedCompanies([{ guid: "X", name: "Acme" }]);
  const dropped = setBoundWorkspaceId("ws-a");
  assert.equal(dropped, false);
  assert.equal(getSelectedCompanies()[0].guid, "X");
});

test("same Tally GUID is only the local selection for the bound workspace", () => {
  setBoundWorkspaceId("ws-a");
  setSelectedCompanies([{ guid: "X", name: "A" }]);
  assert.deepEqual(companyGuidsFromSelection(), ["X"]);
  setBoundWorkspaceId("ws-b");
  assert.deepEqual(companyGuidsFromSelection(), []);
});

test("owner identity is display-only and null-safe", () => {
  const mapped = mapPairedDevice({
    USER_NAME: "Yash",
    MOBILE: "9876543210",
    LAST_SYNC_AT: "2026-09-19",
    IS_PAIRED: true,
  });
  assert.equal(mapped.name, "Yash");
  assert.equal(mapped.mobile, "9876543210");
  assert.equal(mapPairedDevice(null), null);
  const empty = mapPairedDevice({});
  assert.equal(empty.name, "Paired Account");
  assert.equal(empty.mobile, "");
});

test("writeback missed-socket reconcile claims, posts and acks once", async () => {
  setBoundWorkspaceId("ws-a");
  setSelectedCompanies([{ guid: "X", name: "Acme" }]);

  const posts = [];
  const axiosInstance = {
    post: async (url, body) => {
      posts.push({ url, body });
      if (url === "/tally/desktop/writeback/pending") {
        return { data: { data: { items: [{ outboxId: "ob-1" }, { outboxId: "ob-1" }] } } };
      }
      if (url.endsWith("/claim")) {
        return { data: { data: { claimed: true, xml: "<ENVELOPE/>" } } };
      }
      if (url.endsWith("/result")) {
        return { data: { status: true } };
      }
      return { data: {} };
    },
  };
  let postsToTally = 0;
  __setDepsForTests({
    axiosInstance,
    postToTally: async () => {
      postsToTally += 1;
      return { status: true, voucherNumber: "1", tallyId: "t1" };
    },
  });

  const totals = await reconcilePendingWriteback("startup");
  assert.equal(totals.claimed, 1);
  assert.equal(totals.posted, 1);
  assert.equal(postsToTally, 1);
  assert.equal(posts.filter((p) => p.url.endsWith("/claim")).length, 1);
  assert.equal(posts.filter((p) => p.url.endsWith("/result")).length, 1);
});

test("writeback does not use userId as tenant authority", async () => {
  setBoundWorkspaceId("ws-a");
  setSelectedCompanies([{ guid: "X", name: "Acme" }]);
  const posts = [];
  __setDepsForTests({
    axiosInstance: {
      post: async (url, body) => {
        posts.push({ url, body });
        if (url === "/tally/desktop/writeback/pending") {
          return { data: { data: { items: [] } } };
        }
        return { data: {} };
      },
    },
    postToTally: async () => ({ status: true }),
  });
  await processCompanyWriteback("X");
  const pending = posts.find((p) => p.url === "/tally/desktop/writeback/pending");
  assert.deepEqual(pending.body, { companyGuid: "X", limit: 10 });
  assert.equal("userId" in pending.body, false);
  assert.equal("user_id" in pending.body, false);
  assert.equal("ownerUserId" in pending.body, false);
});

test("renderer cannot read secrets or the workspace binding through store IPC", () => {
  for (const key of RENDERER_FORBIDDEN_PREFS) {
    assert.equal(canRendererRead(key), false, key);
    assert.equal(canRendererWrite(key), false, key);
  }
  assert.equal(canRendererRead("selectedCompanies"), true);
  assert.equal(canRendererWrite("selectedCompanies"), true);
  assert.equal(canRendererRead("boundWorkspaceId"), false);
});

const { applyRestoreWithSafety, RESTORE_ROLLBACK_FAILED } = require("../util/restoreCopy");
const {
  tryBeginCloudRestore,
  endCloudRestore,
  isCloudRestoreInFlight,
  __resetCloudRestoreForTests,
} = require("../util/restoreFlight");
const { restrictOwnerOnly, canRestrictPermissions } = require("../util/filePrivacy");

test("restore overwrite rolls dest back after a mid-copy failure", async () => {
  const dest = { value: "ORIGINAL" };
  const incoming = { value: "NEW" };
  const result = await applyRestoreWithSafety({
    dest: "dest",
    incoming: "incoming",
    exists: async (p) => p === "dest" || p === "dest.td-safety",
    copy: async (src, target) => {
      if (src === "incoming" && target === "dest") {
        dest.value = "PARTIAL";
        throw new Error("disk full");
      }
      if (src === "dest" && target === "dest.td-safety") {
        incoming.safety = dest.value;
        return;
      }
      if (src === "dest.td-safety" && target === "dest") {
        dest.value = incoming.safety;
      }
    },
    remove: async () => {},
  });
  assert.equal(result.status, false);
  assert.equal(result.rolledBack, true);
  assert.equal(dest.value, "ORIGINAL");
});

test("rollback failure preserves the safety copy", async () => {
  const result = await applyRestoreWithSafety({
    dest: "dest",
    incoming: "incoming",
    exists: async () => true,
    copy: async (src, target) => {
      if (src === "incoming") throw new Error("overwrite failed");
      if (src === "dest.td-safety" && target === "dest") throw new Error("rollback failed");
    },
    remove: async () => {
      throw new Error("must not delete safety");
    },
  });
  assert.equal(result.status, false);
  assert.equal(result.code, RESTORE_ROLLBACK_FAILED);
  assert.equal(result.recoveryPreserved, true);
  assert.equal(result.safetyPath, "dest.td-safety");
});

test("restore approval is single-flight", () => {
  __resetCloudRestoreForTests();
  assert.equal(tryBeginCloudRestore(), true);
  assert.equal(tryBeginCloudRestore(), false);
  assert.equal(isCloudRestoreInFlight(), true);
  endCloudRestore();
  assert.equal(tryBeginCloudRestore(), true);
  __resetCloudRestoreForTests();
});

test("invalid and truncated archives are rejected before restore", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "td-restore-"));
  const junk = path.join(dir, "junk.txt");
  const empty = path.join(dir, "empty.zip");
  const zip = path.join(dir, "ok.zip");
  fs.writeFileSync(junk, "not a zip");
  fs.writeFileSync(empty, "");
  fs.writeFileSync(zip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
  assert.equal(looksLikeZipArchive(junk), false);
  assert.equal(looksLikeZipArchive(empty), false);
  assert.equal(looksLikeZipArchive(zip), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
