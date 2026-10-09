const { ipcMain } = require("electron");
const { boundActivity } = require("./activityHistory");
const path = require("path");
const fse = require("fs-extra");
const { spawn } = require("child_process");
const { path7za } = require("7zip-bin");
const fsp = require("fs/promises");

const store = require("./store");
const getDeviceProfile = require("./deviceProfile");
const { info } = require("./logger");
const { prettyBytes, axiosInstance } = require("./helper");
const { sha256File, uploadFile } = require("./workspaceCloud");
const { getSelectedCompanies } = require("./companySelection");
const { restrictOwnerOnly, restrictOwnerDir, unlinkQuiet } = require("./filePrivacy");

const sevenZipPath = path7za.replace("app.asar", "app.asar.unpacked");
const final7z = sevenZipPath.includes("app.asar.unpacked")
  ? sevenZipPath
  : path7za;

function createTallyBackupProgressSender(webContents) {
  return (percent, stage) => {
    if (!webContents?.isDestroyed?.()) {
      webContents.send("tally:backup_progress", {
        percent: Math.min(100, Math.max(0, Math.round(percent))),
        stage: stage || null,
      });
    }
  };
}

async function ensureDir(p) {
  await fse.ensureDir(p);
}

function normalizeWin(p) {
  return path.resolve(p);
}

function getCommonParent(paths) {
  if (!paths.length) return null;
  const split = paths.map((p) => normalizeWin(p).split(path.sep));
  const minLen = Math.min(...split.map((a) => a.length));
  const common = [];
  for (let i = 0; i < minLen; i++) {
    const seg = split[0][i];
    if (split.every((a) => a[i] === seg)) common.push(seg);
    else break;
  }
  return common.length ? common.join(path.sep) : null;
}

function createZip({
  folderPaths,
  outZipPath,
  password,
  encryption,
  preserveFolderNames,
  onProgress,
}) {
  const abs = [...new Set(folderPaths.map(normalizeWin))];

  const cwd = getCommonParent(abs) || path.dirname(abs[0]);
  //   const rels = abs.map((p) => path.relative(cwd, p));

  //   const sources = rels.map((r) =>
  //     preserveFolderNames ? r : path.join(r, "*")
  //   );

  const encFlags = password
    ? encryption === "aes256"
      ? ["-mem=AES256", `-p${password}`]
      : ["-mem=ZipCrypto", `-p${password}`]
    : [];

  const args = [
    "a",
    "-tzip",
    outZipPath,
    ...abs,
    "-r",
    "-mx=5",
    "-y",
    "-bb1",
    ...encFlags,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(final7z, args, { windowsHide: true, cwd });

    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => {
      const s = b.toString();
      stdout += s;
      const m = s.match(/(\d+)%/);
      if (m && onProgress) onProgress(Number(m[1]));
    });
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ code, stdout, stderr });
      reject(new Error(`7z exit ${code}\n${stdout}\n${stderr}`));
    });
  });
}

/**
 * Every backup trigger (button, scheduled task, headless) is admitted by the job
 * coordinator first, so a backup never overlaps a sync, restore or another backup.
 */
async function startBackup(windowContent, { trigger = "manual" } = {}) {
  const { coordinator } = require("./jobCoordinator");
  const run = await coordinator.run("backup", { trigger }, () => runBackup(windowContent));
  if (!run.accepted) {
    info(`[backup] not started: ${run.code}`);
    return { status: false, data: null, code: run.code, message: run.message };
  }
  return run.result && "status" in run.result
    ? run.result
    : { status: false, data: null, message: run.result?.message || "Backup failed" };
}

async function runBackup(windowContent) {
  const companies = getSelectedCompanies();
  const backupFolder = store.get("backup.dir");
  const newActivity = store.get("backupAndRestoreActivity") || [];

  const deviceProfile = getDeviceProfile();

  info(
    `Backup [companies]: ${companies.length} selected [${companies
      .map((c) => c?.guid || c?.id || "?")
      .join(", ")}]`
  );

  if (companies.length == 0) {
    return { status: false, data: null, message: "No company is selected" };
  }

  store.set("isBackingUp", true);
  windowContent.send("window:listener", {
    key: "isBackingUp",
    value: true,
  });

  //   newActivity.unshift(new Date().toLocaleString() + " — Backup started");
  newActivity.unshift({
    date: new Date(),
    message: "Backup started",
  });
  windowContent.send("window:listener", {
    key: "backupAndRestoreActivity",
    value: boundActivity(newActivity),
  });

  const options = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  };

  const date = new Intl.DateTimeFormat("en-GB", options)
    .format(Date.now())
    .replaceAll(", ", "_")
    .replaceAll(":", "-")
    .replaceAll("/", "-");

  const sendProgress = createTallyBackupProgressSender(windowContent);
  const nonce = Math.random().toString(16).slice(2, 10);
  const zipPath = path.join(backupFolder, `tallydekho-backup-${date}-${nonce}.zip`);
  const partialZip = `${zipPath}.partial`;

  if (store.get("isSyncing")) {
    store.set("isBackingUp", false);
    windowContent.send("window:listener", { key: "isBackingUp", value: false });
    return { status: false, data: null, message: "Cannot backup while sync is running" };
  }

  let status;
  let backupSessionId = null;

  try {
    sendProgress(5, "Preparing");

    await ensureDir(backupFolder);
    await restrictOwnerDir(backupFolder);

    sendProgress(10, "Backing up");
    await unlinkQuiet(partialZip);
    try {
      await createZip({
        folderPaths: companies.map((company) => company.path),
        outZipPath: partialZip,
        password: null,
        encryption: null,
        preserveFolderNames: true,
        onProgress: (p) => sendProgress(10 + Math.min(50, Math.round(p * 0.5)), "Backing up"),
      });
      await restrictOwnerOnly(partialZip);
      await fsp.rename(partialZip, zipPath);
      await restrictOwnerOnly(zipPath);
    } catch (zipErr) {
      await unlinkQuiet(partialZip);
      await unlinkQuiet(zipPath);
      throw zipErr;
    }

    const stat = await fsp.stat(zipPath);
    const size = prettyBytes(stat.size);
    const sha256 = await sha256File(zipPath);

    sendProgress(65, "Uploading");
    const sessionRes = await axiosInstance.post("/desktop/backup/sessions", {
      sizeBytes: stat.size,
      sha256,
      desktopVersion: deviceProfile.app?.version,
      tallyVersion: store.get("tallyVersion") || null,
      companyManifest: companies.map((c) => ({
        guid: c.guid || c.id,
        name: c.name,
        folder: c.path ? path.basename(c.path) : null,
      })),
    });
    const session = sessionRes.data?.data;
    if (!sessionRes.data?.status || !session?.upload?.url) {
      throw new Error(sessionRes.data?.message || "Backup upload was not authorized");
    }
    backupSessionId = session.backupId;

    await uploadFile(
      session.upload.url,
      zipPath,
      session.upload.headers || {},
      (pct) => sendProgress(65 + Math.round((pct || 0) * 25), "Uploading")
    );

    sendProgress(92, "Verifying");
    const completeRes = await axiosInstance.post(
      `/desktop/backup/sessions/${session.backupId}/complete`,
      { sizeBytes: stat.size, sha256 }
    );
    if (!completeRes.data?.status) {
      throw new Error(completeRes.data?.message || "Backup verify failed");
    }

    await unlinkQuiet(zipPath);

    sendProgress(100, "Available");

    const listRes = await axiosInstance.get("/desktop/backup/list").catch(() => null);
    const cloudBackups = listRes?.data?.data || [];
    store.set("cloudBackups", cloudBackups);
    windowContent.send("window:listener", {
      key: "cloudBackups",
      value: cloudBackups,
    });

    status = true;

    return { status: true, data: session.backupId, message: null, size };
  } catch (err) {
    status = false;
    await unlinkQuiet(partialZip);
    await unlinkQuiet(zipPath);
    if (backupSessionId) {
      await axiosInstance.post(`/desktop/backup/sessions/${backupSessionId}/fail`).catch(() => {});
    }
    info(`[backup] failed (${err.message})`);
    return { status: false, data: null, message: err.message };
  } finally {
    try {
      const { outcomePatch, readScheduleState } = require("./backupSchedule");
      const patch = outcomePatch(readScheduleState(store), { ok: status === true, nowMs: Date.now() });
      for (const [k, v] of Object.entries(patch)) store.set(k, v);
    } catch (e) {
      info(`[backup] schedule state not updated (${e.message})`);
    }
    store.set("isBackingUp", false);
    windowContent.send("window:listener", {
      key: "isBackingUp",
      value: false,
    });
    newActivity.unshift({
      date: new Date(),
      message: `Backup ${status ? `completed ✓` : `failed X`}`,
    });
    const activity = boundActivity(newActivity);
    windowContent.send("window:listener", {
      key: "backupAndRestoreActivity",
      value: activity,
    });
    store.set("backupAndRestoreActivity", activity);
  }
}

function registerBackup(windowContent) {
  ipcMain.handle("tally:start_backup", async (_e) => {
    return startBackup(windowContent);
  });
}

module.exports = { registerBackup, startBackup };
