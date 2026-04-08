const { execFile } = require("child_process");
const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const resolvePowerShell = require("./getPowershellExe");

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { windowsHide: true, ...opts },
      (err, stdout, stderr) => {
        if (err)
          return reject(
            Object.assign(err, {
              stdout: String(stdout || ""),
              stderr: String(stderr || ""),
            })
          );
        resolve(String(stdout || "").trim());
      }
    );
  });
}

// const PS_EXE = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
let PS_EXE;
try { PS_EXE = resolvePowerShell()?.exe; } catch (e) { PS_EXE = null; }
const psq = (s) => String(s ?? "").replace(/'/g, "''");

function normalizeTaskPath(p) {
  if (!p || p === "\\") return "\\";
  let s = String(p);
  if (!s.startsWith("\\")) s = "\\" + s;
  if (!s.endsWith("\\")) s = s + "\\";
  return s;
}

function buildTaskRunCommand(taskArg) {
  const exe = process.execPath;
  const isDev = process.defaultApp || /[\\/]electron(\.exe)?$/i.test(exe);

  if (isDev) {
    // Electron dev: must pass app root as first arg
    let appRoot;
    try {
      appRoot = app.getAppPath();
    } catch {
      appRoot = path.resolve(process.cwd());
    }
    return `"${exe}" "${appRoot}" --run-${taskArg}`;
  }
  // Packaged: call exe directly
  return `"${exe}" --run-${taskArg}`;
}

async function deleteTaskIfExists(taskName, taskFolder = "\\") {
  const fullTN = `${normalizeTaskPath(taskFolder)}${taskName}`;
  try {
    await run("schtasks", ["/Delete", "/TN", fullTN, "/F"]);
  } catch {
    // ignore if not found
  }
}

async function createTaskEveryMinuteCurrentUser(
  taskName,
  taskFolder,
  taskArg,
  minutes,
  days
) {
  const tp = normalizeTaskPath(taskFolder);
  const fullTN = `${tp}${taskName}`;
  const tr = buildTaskRunCommand(taskArg);

  await run("schtasks", [
    "/Create",
    "/TN",
    fullTN,
    "/SC",
    minutes ? "MINUTE" : "DAILY",
    "/MO",
    minutes ? minutes.toString() : days.toString(),
    "/TR",
    tr,
    "/F",
  ]);

  const inner = `
param([string]$TaskName,[string]$TaskPath)
$ErrorActionPreference='Stop'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun
Set-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Settings $settings | Out-Null
# verify
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
Write-Output "OK $($task.TaskPath)$($task.TaskName)"
`.trim();

  if (!PS_EXE) return; // PowerShell not available — skip task settings update
  const tmp = path.join(os.tmpdir(), `settask-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, inner, "utf8");
  try {
    await run(PS_EXE, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      tmp,
      "-TaskName",
      taskName,
      "-TaskPath",
      tp,
    ]);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }

  await run("schtasks", ["/Query", "/TN", fullTN, "/V", "/FO", "LIST"]);
  return fullTN;
}

async function recreateBackupTaskCurrentUser(
  taskName = "TallyDekhoBackup",
  taskFolder = "\\",
  taskArg = "backup",
  minutes = 0,
  days = 0
) {
  await deleteTaskIfExists(taskName, taskFolder);
  return await createTaskEveryMinuteCurrentUser(
    taskName,
    taskFolder,
    taskArg,
    minutes,
    days
  );
}

module.exports = {
  recreateBackupTaskCurrentUser,
  deleteTaskIfExists,
};
