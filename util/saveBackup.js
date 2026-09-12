const { ipcMain } = require("electron");
const path = require("path");
const fse = require("fs-extra");
const { spawn } = require("child_process");
const { path7za } = require("7zip-bin");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");

const store = require("./store");
const getDeviceProfile = require("./deviceProfile");
const { info } = require("./logger");
const { prettyBytes, axiosInstance } = require("./helper");
const { sha256File, uploadFile } = require("./workspaceCloud");
const { runTallyNativeBackup } = require("./tallyNativeBackup");

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
      if (code === 0 || code === 1) return resolve({ code, stdout, stderr });
      reject(new Error(`7z exit ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function testZip(zipPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(final7z, ["t", zipPath, "-y"], { windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(true);
      reject(new Error("Backup archive failed verification"));
    });
  });
}

async function uploadZipWithProgress({ zipPath, uploadUrl, fields }, send) {
  const got = (await import("got")).default;
  const FormData = (await import("form-data")).default;

  const form = new FormData();

  if (fields && typeof fields === "object") {
    for (const [k, v] of Object.entries(fields)) {
      form.append(k, String(v));
    }
  }

  const stat = await fsp.stat(zipPath);
  const fileStream = fs.createReadStream(zipPath);
  form.append("file", fileStream, {
    filename: path.basename(zipPath),
    contentType: "application/zip",
    knownLength: stat.size,
  });

  const request = got(uploadUrl, {
    method: "POST",
    body: form,
    headers: form.getHeaders(),
    throwHttpErrors: false,
  });

  request.on("uploadProgress", (p) => {
    const pct = 70 + (p.percent || 0) * 29;
    send(pct);
  });

  const res = await request; // await the response
  if (res.statusCode >= 200 && res.statusCode < 300) {
    send(99);
    return res.body;
  }
  throw new Error(`Upload failed: ${res.statusCode} ${res.body || ""}`);
}

async function startBackup(windowContent) {
  const companies = store.get("selectedCompanies");
  const backupFolder = store.get("backup.dir");
  const newActivity = store.get("backupAndRestoreActivity") || [];

  const deviceProfile = getDeviceProfile();

  info(`Backup [companies]`, companies);

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
    value: newActivity,
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
  const zipPath = path.join(backupFolder, `tallydekho-backup-${date}.zip`);

  if (store.get("isSyncing")) {
    store.set("isBackingUp", false);
    windowContent.send("window:listener", { key: "isBackingUp", value: false });
    return { status: false, data: null, message: "Cannot backup while sync is running" };
  }

  let status;
  let backupId = null;

  try {
    sendProgress(5, "Preparing");

    await ensureDir(backupFolder);

    sendProgress(10, "Backing up");
    const staging = path.join(os.tmpdir(), `tallydekho-backup-stage-${Date.now()}`);
    const foldersDir = path.join(staging, "company-folders");
    const nativeDir = path.join(staging, "tally-native");
    await ensureDir(foldersDir);
    for (const company of companies) {
      if (!company.path || !fs.existsSync(company.path)) continue;
      await fse.copy(company.path, path.join(foldersDir, path.basename(company.path)));
    }
    sendProgress(28, "Backing up");
    const native = await runTallyNativeBackup(companies, nativeDir).catch((err) => {
      info("[backup] tally-native skipped", err.message);
      return { ok: false, results: [{ message: err.message }] };
    });
    sendProgress(50, "Backing up");
    const zipSources = [foldersDir];
    if (native.ok) zipSources.push(nativeDir);
    await createZip({
      folderPaths: zipSources,
      outZipPath: zipPath,
      password: null,
      encryption: null,
      preserveFolderNames: true,
      onProgress: (p) => sendProgress(50 + Math.min(15, Math.round(p * 0.15)), "Backing up"),
    });
    await fse.remove(staging).catch(() => {});

    await testZip(zipPath);

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
        companyNumber: c.companyNumber || null,
      })),
      methods: native.ok ? ["tally-native", "folder-zip"] : ["folder-zip"],
    });
    const session = sessionRes.data?.data;
    if (!sessionRes.data?.status || !session?.upload?.url) {
      throw new Error(sessionRes.data?.message || "Backup upload was not authorized");
    }
    backupId = session.backupId;

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

    await fsp.unlink(zipPath).catch(() => {});

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
    info(`[backup error message:  ${err.message}]`);
    if (backupId) {
      await axiosInstance.post(`/desktop/backup/sessions/${backupId}/fail`).catch(() => {});
    }
    return { status: false, data: null, message: err.message };
  } finally {
    store.set("isBackingUp", false);
    windowContent.send("window:listener", {
      key: "isBackingUp",
      value: false,
    });
    newActivity.unshift({
      date: new Date(),
      message: `Backup ${status ? `completed ✓` : `failed X`}`,
    });
    windowContent.send("window:listener", {
      key: "backupAndRestoreActivity",
      value: newActivity,
    });
    store.set("backupAndRestoreActivity", newActivity);
  }
}

function registerBackup(windowContent) {
  ipcMain.handle("tally:start_backup", async (_e) => {
    return startBackup(windowContent);
  });
}

module.exports = { registerBackup, startBackup };
