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

ipcMain.handle("window:closeByName", async (_e, procName, opts = {}) => {
  const {
    // timeoutMs = 2500,
    forceIfNoExit = true,
    gracefulName = procName,
  } = opts;

  const imageNameExe = normExeName(procName);
  const gracefulNameNoExt = normExeName(gracefulName).replace(/\.exe$/i, "");

  try {
    await run(
      `powershell -NoProfile -Command ` +
        `"Get-Process -Name '${gracefulNameNoExt}' -ErrorAction SilentlyContinue ` +
        `| ForEach-Object { if ($_.MainWindowHandle -ne 0) { $_.CloseMainWindow() | Out-Null } }"`
    );

    // await new Promise((r) => setTimeout(r, timeoutMs));

    let pids = await findPidsByImage(imageNameExe);

    let killed = 0;
    if (pids.length && forceIfNoExit) {
      await run(`taskkill /IM "${imageNameExe}" /T /F`);
      pids = await findPidsByImage(imageNameExe);
      killed = pids.length ? 0 : 1;
    }

    const stillRunning = await findPidsByImage(imageNameExe);

    return {
      ok: true,
      imageName: imageNameExe,
      forced: forceIfNoExit,
      stillRunningPids: stillRunning,
      killedAtLeastOne: killed === 1 && stillRunning.length === 0,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
