const { app, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const store = require("./store");

const fsp = fs.promises;

const STORE_KEY = "backup.dir";

function defaultBackupDir() {
  return path.join(app.getPath("documents"), app.getName(), "Backups");
}

async function ensureDirWritable(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    // Write/remove a tiny probe to verify write access
    const probe = path.join(dir, ".write-test.tmp");
    await fsp.writeFile(probe, "ok");
    await fsp.rm(probe, { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

async function writeSentinel(dir, fileName = ".myapp_backup_target") {
  const file = path.join(dir, fileName);
  try {
    await fsp.writeFile(file, "do-not-delete");
  } catch (_) {}
}

ipcMain.handle("backup:chooseDir", async (e) => {
  const win = e.sender.getOwnerBrowserWindow();
  const opts = {
    title: "Select backup folder",
    buttonLabel: "Use this folder",
    properties: ["openDirectory", "createDirectory"],
  };

  const res = await dialog.showOpenDialog(win, opts);
  if (res.canceled || !res.filePaths?.length) return { canceled: true };

  const dir = res.filePaths[0];

  // Validate & persist
  const check = await ensureDirWritable(dir);
  if (!check.ok) {
    return { error: `Selected folder is not writable: ${check.error.message}` };
  }

  store.set(STORE_KEY, dir);

  await writeSentinel(dir);
  return { dir };
});

ipcMain.handle("backup:getDir", async () => {
  return { dir: store.get(STORE_KEY) || null };
});

ipcMain.handle("backup:run", async (_e, payload = {}) => {
  // 1) Resolve target folder
  let dir = store.get(STORE_KEY);
  if (!dir) {
    dir = defaultBackupDir();
    store.set(STORE_KEY, dir);
  }

  // 2) Ensure folder exists & writable; try to recreate if missing
  let check = await ensureDirWritable(dir);
  if (!check.ok) {
    // Try fallback
    const fb = defaultBackupDir();
    await fsp.mkdir(fb, { recursive: true }).catch(() => {});
    const fbCheck = await ensureDirWritable(fb);
    if (!fbCheck.ok) {
      return {
        error: "Backup directory not accessible. Please reselect in Settings.",
      };
    }
    dir = fb;
    store.set(STORE_KEY, dir);
  }

  await writeSentinel(dir);

  // 3) Perform a sample backup (atomic write: tmp → rename)
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `backup-${ts}.json`;
    const finalPath = path.join(dir, name);
    const tmpPath = finalPath + ".tmp";

    const data = JSON.stringify(
      { at: Date.now(), host: os.hostname(), payload },
      null,
      2
    );

    await fsp.writeFile(tmpPath, data);
    await fsp.rename(tmpPath, finalPath);

    return { ok: true, path: finalPath };
  } catch (error) {
    return { error: error.message };
  }
});

module.exports = { writeSentinel };
