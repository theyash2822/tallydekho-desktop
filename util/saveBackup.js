const { ipcMain } = require("electron");
const path = require("path");
const fse = require("fs-extra");
const { spawn } = require("child_process");
const { path7za } = require("7zip-bin");
const fs = require("fs");
const fsp = require("fs/promises");

const store = require("./store");
const getDeviceProfile = require("./deviceProfile");
const { info } = require("./logger");
const { prettyBytes } = require("./helper");

const sevenZipPath = path7za.replace("app.asar", "app.asar.unpacked");
const final7z = sevenZipPath.includes("app.asar.unpacked")
  ? sevenZipPath
  : path7za;

function createTallyBackupProgressSender(webContents) {
  return (percent) => {
    if (!webContents?.isDestroyed?.()) {
      webContents.send("tally:backup_progress", {
        percent: Math.max(100, Math.max(0, Math.round(percent))),
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
  const newActivity = store.get("backupAndRestoreActivity");

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

  let status;

  try {
    sendProgress(0);

    await ensureDir(backupFolder);

    await createZip({
      folderPaths: companies.map((company) => company.path),
      outZipPath: zipPath,
      password: deviceProfile.uniqueid,
      encryption: "zipcrypto",
      preserveFolderNames: true,
      onProgress: (p) => sendProgress(Math.min(70, Math.round(p * 0.7))),
    });

    const stat = await fsp.stat(zipPath);
    const size = prettyBytes(stat.size);

    sendProgress(100);

    const newBackups = store.get("backups");
    newBackups.unshift({
      date: new Date(),
      size,
      path: zipPath,
    });

    store.set("backups", newBackups);

    windowContent.send("window:listener", {
      key: "backups",
      value: newBackups,
    });

    status = true;

    return { status: true, data: zipPath, message: null };
  } catch (err) {
    status = false;
    info(`[backup error message:  ${err.message}]`);
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
