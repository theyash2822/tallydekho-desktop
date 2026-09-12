const { ipcMain } = require("electron");
const { exec } = require("child_process");
const path = require("path");

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve((stdout || "").trim());
    });
  });
}

function normExeName(name) {
  if (!name) return "";
  const base = path.win32.basename(name);
  return base.toLowerCase().endsWith(".exe") ? base : `${base}.exe`;
}

async function findPidsByImage(imageNameExe) {
  const out = await run(
    `wmic process where "name='${imageNameExe}'" get ProcessId /value`
  );
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("ProcessId="))
    .map((l) => parseInt(l.split("=")[1], 10))
    .filter((n) => Number.isInteger(n));
}

async function closeTallyIfRunning(opts = {}) {
  const { forceIfNoExit = true, gracefulName = "Tally.exe" } = opts;
  if (process.platform !== "win32") {
    return { ok: true, skipped: true };
  }
  const imageNameExe = normExeName(gracefulName);
  const gracefulNameNoExt = imageNameExe.replace(/\.exe$/i, "");

  try {
    await run(
      `powershell -NoProfile -Command ` +
        `"Get-Process -Name '${gracefulNameNoExt}' -ErrorAction SilentlyContinue ` +
        `| ForEach-Object { if ($_.MainWindowHandle -ne 0) { $_.CloseMainWindow() | Out-Null } }"`
    );
    let pids = await findPidsByImage(imageNameExe);
    if (pids.length && forceIfNoExit) {
      await run(`taskkill /IM "${imageNameExe}" /T /F`);
    }
    const stillRunning = await findPidsByImage(imageNameExe);
    return {
      ok: stillRunning.length === 0,
      imageName: imageNameExe,
      stillRunningPids: stillRunning,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

ipcMain.handle("window:closeByName", async (_e, procName, opts = {}) => {
  return closeTallyIfRunning({ ...opts, gracefulName: procName || "Tally.exe" });
});

module.exports = { closeTallyIfRunning };
