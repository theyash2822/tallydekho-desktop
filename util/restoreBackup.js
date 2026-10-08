const { ipcMain } = require("electron");

const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const fse = require("fs-extra");
const { spawn } = require("child_process");
const { path7za } = require("7zip-bin"); // 7z.exe

const getDeviceProfile = require("./deviceProfile");
const store = require("./store");
const { info } = require("./logger");
const { axiosInstance } = require("./helper");
const { sha256File, downloadFile } = require("./workspaceCloud");
const { saveDeviceSecret } = require("./deviceCredential");
const { looksLikeZipArchive } = require("./backupArchive");
const { applyRestoreWithSafety, RESTORE_ROLLBACK_FAILED } = require("./restoreCopy");
const { restrictOwnerOnly, restrictOwnerDir, unlinkQuiet } = require("./filePrivacy");
const { tryBeginCloudRestore, endCloudRestore } = require("./restoreFlight");
const { parseSevenZipListing, inspectArchiveEntries, checkRestoredFolders } = require("./restoreGuards");
const { restoreHeaders, rememberRestoreRequest, sendRestoreAck, retryPendingRestoreAck } = require("./restoreAck");

const sevenZipPath = path7za.replace("app.asar", "app.asar.unpacked");
const final7z = sevenZipPath.includes("app.asar.unpacked")
  ? sevenZipPath
  : path7za;

function createTallyRestoreProgressSender(webContents) {
  return (percent, stage) => {
    if (!webContents?.isDestroyed()) {
      webContents.send("tally:restore_progress", {
        percent: Math.min(100, Math.max(0, Math.round(percent))),
        stage: stage || null,
      });
    }
  };
}

function temporaryDirectory(name) {
  return path.join(
    os.tmpdir(),
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

async function ensureDir(p) {
  await fse.ensureDir(p);
}

async function listFilesRec(dir) {
  const stack = [dir];
  const files = [];
  while (stack.length) {
    const cur = stack.pop();
    const entries = await fsp.readdir(cur, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) files.push(full);
    }
  }
  return files;
}

function unzipWithPassword(zipPath, outDir, password, sendProgress) {
  return new Promise((resolve, reject) => {
    const args = [
      "x",
      zipPath,
      `-o${outDir}`,
      "-y",
      ...(password ? [`-p${password}`] : []),
    ];

    const child = spawn(final7z, args, { windowsHide: true });

    child.stdout.on("data", (buf) => {
      const s = buf.toString();
      const m = s.match(/(\d+)%/);
      if (m) {
        const pct = 60 + Number(m[1]) * 0.2;
        sendProgress(pct);
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        sendProgress(60);
        resolve(outDir);
      } else {
        reject(new Error(`7z exited with code ${code}`));
      }
    });
  });
}

function listArchive(zipPath, password) {
  return new Promise((resolve, reject) => {
    const args = ["l", "-slt", zipPath, ...(password ? [`-p${password}`] : [])];
    const child = spawn(final7z, args, { windowsHide: true });
    let out = "";
    child.stdout.on("data", (buf) => {
      out += buf.toString();
    });
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(parseSevenZipListing(out));
      else reject(new Error(`7z list exited with code ${code}`));
    });
  });
}

async function topLevelFolders(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  if (entries.some((e) => !e.isDirectory())) {
    throw Object.assign(new Error("Backup archive has files outside company folders"), { code: "BACKUP_ARCHIVE_UNSAFE" });
  }
  return entries.map((e) => e.name).sort();
}

async function copyWithProgress(srcDir, destDir, sendProgress) {
  await ensureDir(destDir);
  const files = await listFilesRec(srcDir);

  let total = 0;
  for (const f of files) {
    const st = await fsp.stat(f);
    total += st.size;
  }

  let written = 0;
  for (let i = 0; i < files.length; i++) {
    const src = files[i];
    const rel = path.relative(srcDir, src);
    const dest = path.join(destDir, rel);
    await ensureDir(path.dirname(dest));

    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(src);
      const ws = fs.createWriteStream(dest);
      rs.on("data", (chunk) => {
        written += chunk.length;
        const pct = total ? written / total : i / files.length;
        sendProgress(80 + pct * 19);
      });
      rs.on("error", reject);
      ws.on("error", reject);
      ws.on("close", resolve);
      rs.pipe(ws);
    });
  }
  sendProgress(99);
}

async function rimrafSafe(p) {
  try {
    await fse.remove(p);
  } catch {}
}

async function tallyIsRunning() {
  if (process.platform !== "win32") return false;
  const { runningTallyExe } = require("./ensureBillOutstandingTdl");
  return !!(await runningTallyExe());
}

const TALLY_CLOSE_REQUIRED = {
  status: false,
  code: "TALLY_CLOSE_REQUIRED",
  message: "Close Tally on this PC, then start the restore again.",
};

async function restoreBackup(windowContent, zipPath, { manifest = null, isTallyRunning = tallyIsRunning } = {}) {
  const newActivity = store.get("backupAndRestoreActivity") || [];
  const isRestoring = store.get("isRestoring");

  if (isRestoring) {
    return { status: false, message: "Restore already running" };
  }

  if (!zipPath || !fs.existsSync(zipPath)) {
    return { status: false, message: "Backup archive not found" };
  }
  const zipStat = await fsp.stat(zipPath).catch(() => null);
  if (!zipStat || !zipStat.isFile() || zipStat.size < 22) {
    return { status: false, message: "Backup archive is empty or incomplete" };
  }
  if (!looksLikeZipArchive(zipPath)) {
    return { status: false, message: "Backup file is not a valid archive" };
  }

  newActivity.unshift({
    date: new Date(),
    message: "Restore started",
  });

  windowContent.send("window:listener", {
    key: "backupAndRestoreActivity",
    value: newActivity,
  });

  store.set("isRestoring", true);
  windowContent.send("window:listener", {
    key: "isRestoring",
    value: true,
  });

  info("Restore [archive] accepted after header/size check");

  const sendProgress = createTallyRestoreProgressSender(windowContent);

  const temporaryRoot = temporaryDirectory("tallydekho_restore");
  const unzipDir = path.join(temporaryRoot, "unzipped");

  const deviceProfile = getDeviceProfile();
  const dest = store.get("destination");

  let status;
  let restoredFolders = [];

  try {
    sendProgress(5, "Verifying");
    await ensureDir(temporaryRoot);
    await restrictOwnerDir(temporaryRoot);

    if (!dest) throw new Error("Tally destination is not set. Connect Tally once so the data path is known.");

    let entries;
    try {
      entries = await listArchive(zipPath, null);
    } catch (_) {
      entries = await listArchive(zipPath, deviceProfile.uniqueid);
    }
    // Extraction lands in the temp dir and then the Tally folder; the safety copy needs room too.
    const freeOf = async (p) => {
      const s = p && fs.existsSync(p) ? await fsp.statfs(p).catch(() => null) : null;
      return s ? s.bavail * s.bsize : null;
    };
    const freeTmp = await freeOf(os.tmpdir());
    const freeDest = await freeOf(dest);
    const free = [freeTmp, freeDest].filter((n) => n != null);
    const inspected = inspectArchiveEntries(entries, { freeBytes: free.length ? Math.min(...free) : null });
    if (!inspected.ok) throw Object.assign(new Error(inspected.message), { code: inspected.code });
    const preFolders = checkRestoredFolders(manifest, inspected.topFolders);
    if (!preFolders.ok) {
      throw Object.assign(new Error("Backup folders do not match the approved backup"), { code: preFolders.code });
    }

    sendProgress(15, "Restoring");
    try {
      await unzipWithPassword(zipPath, unzipDir, null, sendProgress);
    } catch (_) {
      await rimrafSafe(unzipDir);
      await unzipWithPassword(zipPath, unzipDir, deviceProfile.uniqueid, sendProgress);
    }

    restoredFolders = await topLevelFolders(unzipDir);
    const sameAsListing =
      restoredFolders.length === inspected.topFolders.length &&
      restoredFolders.every((f, i) => f === inspected.topFolders[i]);
    const postFolders = checkRestoredFolders(manifest, restoredFolders);
    if (!sameAsListing || !postFolders.ok) {
      throw Object.assign(new Error("Extracted folders do not match the approved backup"), { code: "TALLY_DATA_MISMATCH" });
    }

    if (await isTallyRunning()) {
      throw Object.assign(new Error(TALLY_CLOSE_REQUIRED.message), { code: TALLY_CLOSE_REQUIRED.code });
    }

    const applied = await applyRestoreWithSafety({
      dest,
      incoming: unzipDir,
      copy: (src, target) => copyWithProgress(src, target, sendProgress),
      exists: async (p) => fs.existsSync(p),
      remove: rimrafSafe,
    });

    if (!applied.status) {
      if (applied.code === RESTORE_ROLLBACK_FAILED) {
        info("[restore] rollback failed; recovery copy retained");
      }
      throw Object.assign(new Error(applied.message), { code: applied.code });
    }

    store.delete("lastSync");
    store.delete("myLastSyncEpoch");
    windowContent.send("window:listener", { key: "lastSync", value: null });

    status = true;

    return { status: true, message: null, restoredFolders };
  } catch (err) {
    status = false;
    info(`[restore] failed (${err.code || "RESTORE_FAILED"})`);
    return { status: false, code: err.code || "RESTORE_FAILED", message: err.message };
  } finally {
    await rimrafSafe(temporaryRoot);
    sendProgress(100, status ? "Complete" : null);

    store.set("isRestoring", false);
    windowContent.send("window:listener", {
      key: "isRestoring",
      value: false,
    });

    newActivity.unshift({
      date: new Date(),
      message: `Restore ${status ? `completed ✓` : `failed X`}`,
    });
    windowContent.send("window:listener", {
      key: "backupAndRestoreActivity",
      value: newActivity,
    });
    store.set("backupAndRestoreActivity", newActivity);

    info(`Restore [status]: ${status}`);
  }
}

async function confirmRestoreLocally(windowContent, backup) {
  const { dialog, BrowserWindow } = require("electron");
  const win = (windowContent && BrowserWindow.fromWebContents?.(windowContent)) || BrowserWindow.getFocusedWindow?.() || null;
  const when = backup?.createdAt ? ` from ${new Date(Number(backup.createdAt) * 1000).toLocaleString()}` : "";
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Restore now", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Restore Tally data",
    message: `Restore the approved backup${when} on this PC?`,
    detail: "The Tally data folder on this PC will be replaced. A safety copy is kept until the restore finishes. Close Tally before continuing.",
  });
  return response === 0;
}

async function startCloudRestore(windowContent, { confirm = confirmRestoreLocally } = {}) {
  if (!tryBeginCloudRestore()) {
    return { status: false, message: "Restore already running" };
  }
  if (store.get("isRestoring")) {
    endCloudRestore();
    return { status: false, message: "Restore already running" };
  }
  const { coordinator } = require("./jobCoordinator");
  const admission = coordinator.admit("restore", { trigger: "cloud" });
  if (!admission.accepted) {
    endCloudRestore();
    const result = { status: false, code: admission.code, message: admission.message };
    if (windowContent && !windowContent.isDestroyed?.()) {
      windowContent.send("window:listener", { key: "restoreComplete", value: result });
    }
    return result;
  }
  let result;
  try {
    const run = await coordinator.execute(admission.job, async () => {
      const r = await runCloudRestore(windowContent, { confirm });
      return { state: r?.status ? "succeeded" : "failed", result: r };
    });
    result = run.result && "status" in run.result
      ? run.result
      : { status: false, message: run.result?.message || "Restore failed" };
  } finally {
    endCloudRestore();
  }
  if (windowContent && !windowContent.isDestroyed?.()) {
    windowContent.send("window:listener", { key: "restoreComplete", value: result });
  }
  return result;
}

async function applyRestoredSecret(secret) {
  // Replacement credential comes from the backend, not from the zip or a
  // cached workspaceId. Drop any leftover local tenant state first.
  const { clearWorkspaceBinding } = require("./companySelection");
  clearWorkspaceBinding();
  saveDeviceSecret(secret);
  await axiosInstance.post("/desktop/claim-credential").catch(() => {});
}

async function finishRestoreBinding() {
  try {
    const { reconcileBinding } = require("./pairingRuntime");
    await reconcileBinding("cloud-restore");
  } catch (_) {}
}

async function reportRestoreFailure() {
  await axiosInstance
    .post("/desktop/restore/complete", { ok: false }, { headers: restoreHeaders(store) })
    .catch(() => {});
}

async function runCloudRestore(windowContent, { confirm = confirmRestoreLocally } = {}) {
  const sendProgress = createTallyRestoreProgressSender(windowContent);

  const retried = await retryPendingRestoreAck({ store, post: axiosInstance.post.bind(axiosInstance), applySecret: applyRestoredSecret });
  if (retried.status) {
    await finishRestoreBinding();
    sendProgress(100, "Complete");
    return { status: true, message: null, data: retried.data };
  }

  sendProgress(2, "Waiting for approval");
  const statusRes = await axiosInstance.get("/desktop/restore/status", { headers: restoreHeaders(store) });
  const data = statusRes.data?.data;
  if (!statusRes.data?.status || data?.status !== "APPROVED") {
    return {
      status: false,
      code: data?.status || "RESTORE_APPROVAL_REQUIRED",
      message: data?.status === "RESTORE_TOKEN_REQUIRED"
        ? "Request restore again on this PC"
        : "Waiting for Owner/Admin approval",
      data: data ? { status: data.status } : null,
    };
  }
  if (!data.download?.url || !data.backup?.sha256) {
    return { status: false, code: "RESTORE_SESSION_EXPIRED", message: "Restore download is not ready" };
  }

  if (!(await confirm(windowContent, data.backup))) {
    return { status: false, code: "RESTORE_CANCELLED", message: "Restore cancelled on this PC" };
  }
  if (await tallyIsRunning()) return { ...TALLY_CLOSE_REQUIRED };

  sendProgress(10, "Downloading");
  const zipPath = path.join(os.tmpdir(), `tallydekho-restore-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);
  await downloadFile(data.download.url, zipPath, (p) =>
    sendProgress(10 + Math.round((p || 0) * 30), "Downloading")
  );
  await restrictOwnerOnly(zipPath);

  sendProgress(42, "Verifying");
  const zipStat = await fsp.stat(zipPath).catch(() => null);
  if (data.backup.sizeBytes && zipStat && Number(data.backup.sizeBytes) !== zipStat.size) {
    await unlinkQuiet(zipPath);
    await reportRestoreFailure();
    return { status: false, code: "BACKUP_SIZE_MISMATCH", message: "Backup size did not match" };
  }
  const hash = await sha256File(zipPath);
  if (hash !== data.backup.sha256) {
    await unlinkQuiet(zipPath);
    await reportRestoreFailure();
    return { status: false, code: "BACKUP_CHECKSUM_MISMATCH", message: "Backup checksum did not match" };
  }
  if (!looksLikeZipArchive(zipPath)) {
    await unlinkQuiet(zipPath);
    await reportRestoreFailure();
    return { status: false, code: "BACKUP_ARCHIVE_INVALID", message: "Backup file is not a valid archive" };
  }

  const restored = await restoreBackup(windowContent, zipPath, { manifest: data.backup.manifest });
  await unlinkQuiet(zipPath);
  if (!restored?.status) {
    // Nothing was written; keep the approval so the user can close Tally and retry.
    if (restored?.code !== TALLY_CLOSE_REQUIRED.code) await reportRestoreFailure();
    return restored;
  }

  sendProgress(96, "Validating Tally");
  // GUID lineage is not sent: Tally still has the pre-restore companies loaded at this point.
  const ack = await sendRestoreAck({
    store,
    post: axiosInstance.post.bind(axiosInstance),
    ack: { restoredFolders: restored.restoredFolders || [], lineageGuids: [] },
    applySecret: applyRestoredSecret,
  });
  if (!ack.status) {
    return { status: false, code: ack.code, message: ack.message || "Restore finished locally; confirmation is pending", retry: !!ack.retry };
  }
  await finishRestoreBinding();
  sendProgress(100, "Complete");
  return { status: true, message: null, data: ack.data };
}

function registerRestoreBackup(windowContent) {
  ipcMain.handle("tally:restore_request", async () => {
    const res = await axiosInstance.post("/desktop/restore/request");
    const body = res.data;
    if (body?.data) body.data = rememberRestoreRequest(store, body.data);
    return body;
  });
  ipcMain.handle("tally:restore_status", async () => {
    const res = await axiosInstance.get("/desktop/restore/status", { headers: restoreHeaders(store) });
    const body = res.data;
    // Download URLs stay in the main process.
    if (body?.data) body.data = { status: body.data.status, restoreRequestId: body.data.restoreRequestId };
    return body;
  });
  ipcMain.handle("tally:restore_cloud", async () => {
    return startCloudRestore(windowContent);
  });
  if (store.get("pendingRestoreAck")) {
    setTimeout(() => {
      retryPendingRestoreAck({ store, post: axiosInstance.post.bind(axiosInstance), applySecret: applyRestoredSecret })
        .then((r) => (r.status ? finishRestoreBinding() : null))
        .catch(() => {});
    }, 15000).unref?.();
  }
}

module.exports = registerRestoreBackup;
module.exports.restoreBackup = restoreBackup;
module.exports.startCloudRestore = startCloudRestore;
