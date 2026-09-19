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

async function restoreBackup(windowContent, zipPath) {
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

  try {
    sendProgress(5, "Verifying");
    await ensureDir(temporaryRoot);
    await restrictOwnerDir(temporaryRoot);

    try {
      const st = await fsp.stat(zipPath);
      const destStat = dest && fs.existsSync(dest) ? await fsp.statfs(dest).catch(() => null) : null;
      if (destStat && destStat.bavail * destStat.bsize < st.size + 80 * 1024 * 1024) {
        throw new Error("Not enough free disk space to restore");
      }
    } catch (e) {
      if (String(e.message).includes("Not enough")) throw e;
    }

    sendProgress(15, "Restoring");
    try {
      await unzipWithPassword(zipPath, unzipDir, null, sendProgress);
    } catch (_) {
      await unzipWithPassword(zipPath, unzipDir, deviceProfile.uniqueid, sendProgress);
    }

    if (!dest) throw new Error("Tally destination is not set. Connect Tally once so the data path is known.");

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

    return { status: true, message: null };
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

async function startCloudRestore(windowContent) {
  if (!tryBeginCloudRestore()) {
    return { status: false, message: "Restore already running" };
  }
  if (store.get("isRestoring")) {
    endCloudRestore();
    return { status: false, message: "Restore already running" };
  }
  try {
    const result = await runCloudRestore(windowContent);
    if (windowContent && !windowContent.isDestroyed?.()) {
      windowContent.send("window:listener", { key: "restoreComplete", value: result });
    }
    return result;
  } catch (err) {
    const result = { status: false, message: err.message };
    if (windowContent && !windowContent.isDestroyed?.()) {
      windowContent.send("window:listener", { key: "restoreComplete", value: result });
    }
    return result;
  } finally {
    endCloudRestore();
  }
}

async function runCloudRestore(windowContent) {
  const sendProgress = createTallyRestoreProgressSender(windowContent);
  sendProgress(2, "Waiting for approval");
  const statusRes = await axiosInstance.get("/desktop/restore/status");
  const data = statusRes.data?.data;
  if (!statusRes.data?.status || data?.status !== "APPROVED") {
    return {
      status: false,
      code: data?.status || "RESTORE_APPROVAL_REQUIRED",
      message: "Waiting for Owner/Admin approval",
      data,
    };
  }
  if (!data.download?.url || !data.backup?.sha256) {
    return { status: false, code: "RESTORE_SESSION_EXPIRED", message: "Restore download is not ready" };
  }

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
    await axiosInstance.post("/desktop/restore/complete", { ok: false }).catch(() => {});
    return { status: false, code: "BACKUP_SIZE_MISMATCH", message: "Backup size did not match" };
  }
  const hash = await sha256File(zipPath);
  if (hash !== data.backup.sha256) {
    await unlinkQuiet(zipPath);
    await axiosInstance.post("/desktop/restore/complete", { ok: false }).catch(() => {});
    return { status: false, code: "BACKUP_CHECKSUM_MISMATCH", message: "Backup checksum did not match" };
  }
  if (!looksLikeZipArchive(zipPath)) {
    await unlinkQuiet(zipPath);
    await axiosInstance.post("/desktop/restore/complete", { ok: false }).catch(() => {});
    return { status: false, code: "BACKUP_ARCHIVE_INVALID", message: "Backup file is not a valid archive" };
  }

  const restored = await restoreBackup(windowContent, zipPath);
  await unlinkQuiet(zipPath);
  if (!restored?.status) {
    await axiosInstance.post("/desktop/restore/complete", { ok: false }).catch(() => {});
    return restored;
  }

  sendProgress(96, "Validating Tally");
  const done = await axiosInstance.post("/desktop/restore/complete", { ok: true });
  if (done.data?.data?.deviceSecret) {
    // Replacement credential comes from the backend, not from the zip or a
    // cached workspaceId. Drop any leftover local tenant state first.
    const { clearWorkspaceBinding } = require("./companySelection");
    clearWorkspaceBinding();
    saveDeviceSecret(done.data.data.deviceSecret);
    await axiosInstance.post("/desktop/claim-credential").catch(() => {});
  }
  try {
    const { reconcileBinding } = require("./pairingRuntime");
    await reconcileBinding("cloud-restore");
  } catch (_) {}
  sendProgress(100, "Complete");
  return { status: true, message: null, data: done.data?.data };
}

function registerRestoreBackup(windowContent) {
  ipcMain.handle("tally:restore_request", async () => {
    const res = await axiosInstance.post("/desktop/restore/request");
    return res.data;
  });
  ipcMain.handle("tally:restore_status", async () => {
    const res = await axiosInstance.get("/desktop/restore/status");
    return res.data;
  });
  ipcMain.handle("tally:restore_cloud", async () => {
    return startCloudRestore(windowContent);
  });
}

module.exports = registerRestoreBackup;
module.exports.restoreBackup = restoreBackup;
module.exports.startCloudRestore = startCloudRestore;
