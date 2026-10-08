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

// Resolved on first use: resolving throws where no PowerShell exists (non-Windows tests).
let psExe = null;
const PS_EXE = () => (psExe ||= resolvePowerShell()?.exe);
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

  await applyTaskSettings(taskName, tp);
  await run("schtasks", ["/Query", "/TN", fullTN, "/V", "/FO", "LIST"]);
  return fullTN;
}

/**
 * Settings for TallyDekho's own tasks. Never -WakeToRun (finding 20): a sleeping PC is not woken;
 * -StartWhenAvailable runs one missed occurrence after resume (Task Scheduler coalesces).
 * Bump TASK_SETTINGS_VERSION whenever this changes so installed tasks are reconciled once.
 */
const TASK_SETTINGS_VERSION = 2;
const OWNED_TASKS = ["TallyDekhoAutoSync", "TallyDekhoAutoBackup"];

function taskSettingsScript() {
  return `
param([string]$TaskName,[string]$TaskPath)
$ErrorActionPreference='Stop'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$settings.WakeToRun = $false
Set-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Settings $settings | Out-Null
# verify
$task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
if ($task.Settings.WakeToRun) { throw "WakeToRun still set" }
Write-Output "OK $($task.TaskPath)$($task.TaskName)"
`.trim();
}

/** Only the settings change; trigger, interval and action of the task are kept. */
async function applyTaskSettings(taskName, tp) {
  const inner = taskSettingsScript();

  const tmp = path.join(os.tmpdir(), `settask-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, inner, "utf8");
  try {
    await run(PS_EXE(), [
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
}

async function taskExists(fullTN) {
  try {
    await run("schtasks", ["/Query", "/TN", fullTN, "/FO", "LIST"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Once per settings version, re-apply the settings of TallyDekho's own installed tasks (removes
 * -WakeToRun from tasks created by older builds). Other scheduled tasks are never touched.
 * Idempotent: the version is stored only after every existing owned task was updated.
 */
async function reconcileOwnedTaskSettings(store, { platform = process.platform, exists = taskExists, apply = applyTaskSettings, log = () => {} } = {}) {
  if (platform !== "win32") return { action: "skipped", reason: "not_windows" };
  if (Number(store.get("scheduledTaskSettingsVersion") || 0) >= TASK_SETTINGS_VERSION) {
    return { action: "none", reason: "current" };
  }
  const updated = [];
  for (const name of OWNED_TASKS) {
    if (!(await exists(`\\${name}`))) continue;
    try {
      await apply(name, "\\");
      updated.push(name);
    } catch (err) {
      log(`[tasks] settings reconcile failed for ${name}: ${err.message}`);
      return { action: "failed", task: name, updated };
    }
  }
  store.set("scheduledTaskSettingsVersion", TASK_SETTINGS_VERSION);
  return { action: "reconciled", updated };
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
  reconcileOwnedTaskSettings,
  taskSettingsScript,
  TASK_SETTINGS_VERSION,
  OWNED_TASKS,
};
