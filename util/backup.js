const { dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const store = require("./store");

const fsp = fs.promises;

const STORE_KEY = "backup.dir";

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

module.exports = { writeSentinel };
