const { ipcMain } = require("electron");

const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const fse = require("fs-extra");
const { spawn } = require("child_process");
const { path7za } = require("7zip-bin"); // 7z.exe

const http = require("http");
const https = require("https");
const { URL } = require("url");

const getDeviceProfile = require("./deviceProfile");
const store = require("./store");
const { info } = require("./logger");

const sevenZipPath = path7za.replace("app.asar", "app.asar.unpacked");
const final7z = sevenZipPath.includes("app.asar.unpacked")
  ? sevenZipPath
  : path7za;

function createTallyRestoreProgressSender(webContents) {
  return (percent) => {
    if (!webContents?.isDestroyed()) {
      webContents.send("tally:restore_progress", {
        percent: Math.max(100, Math.max(0, Math.round(percent))),
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
  const newActivity = store.get("backupAndRestoreActivity");
  const isRestoring = store.get("isRestoring");

  if (isRestoring) {
    return;
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

  info(`Restore [path]`, zipPath);

  const sendProgress = createTallyRestoreProgressSender(windowContent);

  const temporaryRoot = temporaryDirectory("tallydekho_restore");

  info(`Restore [Temp Root]`, temporaryRoot);

  const unzipDir = path.join(temporaryRoot, "unzipped");

  const deviceProfile = getDeviceProfile();

  let status;

  try {
    sendProgress(0);
    await ensureDir(temporaryRoot);

    // await downloadWithProgress(url, zipPath, sendProgress);

    await unzipWithPassword(
      zipPath,
      unzipDir,
      deviceProfile.uniqueid,
      sendProgress
    );

    await copyWithProgress(unzipDir, store.get("destination"), sendProgress);

    status = true;

    return { status: true, message: null };
  } catch (err) {
    status = false;
    info(`[restore error message:  ${err.message}]`);
    return { status: false, message: err.message };
  } finally {
    await rimrafSafe(temporaryRoot);
    sendProgress(100);

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

function registerRestoreBackup(windowContent) {
  ipcMain.handle("tally:restore_backup", async (event, args) => {
    return restoreBackup(windowContent, args);
  });
}

module.exports = registerRestoreBackup;
