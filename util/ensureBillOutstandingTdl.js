/**
 * Bill Outstanding TDL — Settings health + Settings Setup / Retry Setup.
 *
 * Tally does NOT support loading TDL over HTTP Import (locked FORBIDDEN).
 *  1) Copy TDL + write tally.ini with quoted paths (tdlFiles.js)
 *  2) Read-only health report check (tdlHealth.js / billSnapshot.js)
 *  3) Retry Setup only: restart Tally with /TDL so the add-on loads without F1.
 *
 * Sync must never import this module: it is the only code allowed to restart Tally.
 */
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const axios = require("axios");
const { info } = require("./logger");
const store = require("./store");
const {
  TDL_FILENAME,
  INI_FILENAME,
  STORE_KEY,
  looksLikeTallyDir,
  detectTallyInstallPath,
  readIniState,
  applyTdlToDir,
  setTallyInstallPath,
} = require("./tdlFiles");
const { TDL_STATUS, TDL_VERSION, checkTdlHealth } = require("./tdlHealth");
const { fetchCompanyBillSnapshot } = require("./billSnapshot");

const LOADED_STATUSES = new Set([
  TDL_STATUS.ACTIVE,
  TDL_STATUS.ACTIVE_OUTDATED,
  TDL_STATUS.ACTIVE_LEGACY,
]);

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function currentFyRange(now = new Date()) {
  const startYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return { fromDate: `${startYear}0401`, toDate: `${startYear + 1}0331`, currentDate: ymd(now) };
}

/**
 * Read-only live status. With a company we also try the bill report, which is
 * how a legacy add-on (no health report) is recognised.
 */
async function liveTdlStatus(companyName) {
  if (!companyName) {
    const health = await checkTdlHealth("");
    const tdlStatus = health.status === TDL_STATUS.HEALTH_MISSING ? TDL_STATUS.UNKNOWN : health.status;
    return { checked: true, tdlStatus, version: health.version || null, billRows: null, reason: health.reason };
  }
  const snap = await fetchCompanyBillSnapshot({ companyName, ...currentFyRange() });
  return {
    checked: true,
    tdlStatus: snap.tdlStatus || TDL_STATUS.UNKNOWN,
    version: snap.tdlVersion,
    billRows: snap.status === "SUCCESS" ? snap.rowCount : null,
    billStatus: snap.status,
    reason: snap.reason,
  };
}

function liveMessage(tdlStatus) {
  switch (tdlStatus) {
    case TDL_STATUS.ACTIVE:
      return { level: "success", status: "ok", message: "Bill Outstanding TDL is installed and active." };
    case TDL_STATUS.ACTIVE_OUTDATED:
    case TDL_STATUS.ACTIVE_LEGACY:
      return {
        level: "warn",
        status: "ok",
        message: "An older Bill Outstanding TDL is active. Click Retry setup to upgrade it.",
      };
    case TDL_STATUS.NOT_LOADED:
      return { level: "danger", status: "blocked", message: "TDL not active in running Tally" };
    case TDL_STATUS.TALLY_UNREACHABLE:
    case TDL_STATUS.TALLY_TIMEOUT:
      return { level: "warn", status: "unknown", message: "Tally is not reachable — open Tally, then Check again." };
    default:
      return {
        level: "warn",
        status: "unknown",
        message: "Could not confirm the Bill Outstanding TDL. Click Retry setup to reinstall it.",
      };
  }
}

function buildHealth({ tallyDir, detectSource, applyResult, live = null, activateResult = null }) {
  const missing = [];
  if (deps.platform() !== "win32") {
    return {
      status: "ok",
      level: "ok",
      skipped: true,
      reason: "not_windows",
      message: "TDL setup applies on Windows only.",
      tallyDir: null,
      detectSource: null,
      tdlPresent: false,
      iniFound: false,
      userTdlYes: false,
      tdlListed: false,
      liveLoaded: null,
      tdlStatus: null,
      missing: [],
      applyResult: applyResult || null,
      activateResult,
    };
  }

  if (!tallyDir) {
    missing.push("Tally install folder not found");
    return {
      status: "blocked",
      level: "danger",
      skipped: false,
      reason: "path_unknown",
      message: "Select your Tally Prime folder so we can install the outstanding report.",
      tallyDir: null,
      detectSource,
      tdlPresent: false,
      iniFound: false,
      userTdlYes: false,
      tdlListed: false,
      liveLoaded: false,
      tdlStatus: null,
      missing,
      applyResult: applyResult || null,
      activateResult,
    };
  }

  const destTdl = path.join(tallyDir, TDL_FILENAME);
  const iniPath = path.join(tallyDir, INI_FILENAME);
  const tdlPresent = deps.fileExists(destTdl);
  const ini = deps.readIni(iniPath, destTdl);

  if (!tdlPresent) missing.push(`${TDL_FILENAME} missing`);
  if (!ini.found) missing.push(`${INI_FILENAME} missing`);
  if (ini.found && !ini.userTdlYes) missing.push("User TDL is not Yes");
  if (ini.found && !ini.tdlListed) missing.push("TDL not linked in tally.ini");
  if (ini.found && ini.tdlListed && !ini.quotedOk) {
    missing.push("TDL path needs quotes (spaces/parentheses)");
  }

  const tdlStatus = live?.tdlStatus || null;
  const liveLoaded = tdlStatus == null
    ? null
    : LOADED_STATUSES.has(tdlStatus)
    ? true
    : tdlStatus === TDL_STATUS.NOT_LOADED
    ? false
    : null;

  // `missing` lists disk/ini problems only; runtime state is reported via tdlStatus.
  let { status, level, message } = liveMessage(tdlStatus);
  let reason = tdlStatus ? tdlStatus.toLowerCase() : "ready";

  const fileProblem = missing[0];
  if (fileProblem) {
    status = "blocked";
    level = "danger";
    reason = !ini.found ? "ini_missing" : !tdlPresent ? "tdl_missing" : "ini_not_linked";
    message = fileProblem;
  }

  return {
    status,
    level,
    skipped: false,
    reason,
    message,
    tallyDir,
    detectSource,
    tdlPresent,
    iniFound: ini.found,
    userTdlYes: ini.userTdlYes,
    tdlListed: ini.tdlListed,
    quotedOk: ini.quotedOk,
    liveLoaded,
    liveBillRows: live?.billRows ?? null,
    tdlStatus,
    tdlVersion: live?.version || null,
    expectedTdlVersion: TDL_VERSION,
    destTdl,
    iniPath,
    missing,
    applyResult: applyResult || null,
    activateResult,
  };
}

function tallyHttpUrl() {
  const port = store.get("port") || 9000;
  return `http://localhost:${port}`;
}

function execFileAsync(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

async function waitForTallyPort(timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await axios.get(tallyHttpUrl(), { timeout: 1500 });
      return true;
    } catch {
      // Tally HTTP may not answer GET — try a tiny POST
      try {
        await axios.post(tallyHttpUrl(), "<ENVELOPE></ENVELOPE>", {
          headers: { "Content-Type": "text/xml" },
          timeout: 1500,
          validateStatus: () => true,
        });
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  return false;
}

/**
 * Settings Setup / Retry Setup only: restart Tally with /TDL so the report loads without manual F1.
 *
 * Tally docs: argv is `/TDL:path` (or `/TDL:filename` if file is in Tally folder).
 * Do NOT embed extra quotes inside the argv — that breaks paths like "TallyPrime (1)".
 * Prefer filename-only since we copy TDKBillOutstanding.tdl into the Tally folder.
 * /LOAD:companyNumber reopens the company after the restart.
 */
async function activateTdlByRestartingTally(tallyDir, destTdl, opts = {}) {
  if (process.platform !== "win32") {
    return { status: false, message: "Windows only" };
  }
  const exe = path.join(tallyDir, "tally.exe");
  if (!fs.existsSync(exe)) {
    return { status: false, message: `tally.exe not found in ${tallyDir}` };
  }
  if (!fs.existsSync(destTdl)) {
    return { status: false, message: "TDL file missing — run setup first" };
  }

  const companyNumber = opts.companyNumber != null && String(opts.companyNumber).trim() !== ""
    ? String(opts.companyNumber).trim()
    : null;

  const args = [`/TDL:${TDL_FILENAME}`];
  if (companyNumber) {
    args.unshift(`/LOAD:${companyNumber}`);
  }

  info("[tdl] setup: restarting Tally with /TDL", { exe, args, destTdl, companyNumber });

  await execFileAsync("taskkill", ["/IM", "tally.exe", "/F"]);
  await new Promise((r) => setTimeout(r, 2500));

  try {
    // cmd `start` is the reliable way to launch a GUI Tally from Electron
    const child = spawn(
      process.env.ComSpec || "cmd.exe",
      ["/c", "start", "", "/D", tallyDir, "tally.exe", ...args],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    child.unref();
  } catch (e) {
    return { status: false, message: e?.message || "Failed to start Tally" };
  }

  const up = await waitForTallyPort(90000);
  if (!up) {
    return {
      status: false,
      message: "Tally did not come back on port in time. Open Tally, then Retry.",
    };
  }

  // Company + TDL load needs more than Gateway HTTP up
  await new Promise((r) => setTimeout(r, companyNumber ? 10000 : 5000));
  return {
    status: true,
    message: companyNumber
      ? "Tally restarted with Bill Outstanding TDL + company loaded"
      : "Tally restarted with Bill Outstanding TDL — open your company if the check still fails",
    args,
    companyNumber,
  };
}

function selectedCompanyMeta() {
  const c = require("./companySelection").getSelectedCompanies()[0] || {};
  return {
    companyName: c.name || "",
    companyNumber: c.companyNumber ?? c.COMPANYNUMBER ?? null,
  };
}

const defaultDeps = {
  platform: () => process.platform,
  fileExists: (p) => fs.existsSync(p),
  readIni: readIniState,
  detect: detectTallyInstallPath,
  apply: applyTdlToDir,
  liveStatus: liveTdlStatus,
  checkHealth: checkTdlHealth,
  activate: activateTdlByRestartingTally,
  companyMeta: selectedCompanyMeta,
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};
let deps = defaultDeps;

/** Tests only: replace Tally/disk access. `null` restores the real implementation. */
function __setDepsForTests(overrides) {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

/** Settings → Check now / health card. Never restarts Tally (refreshes the files on disk only). */
async function getTdlHealth(opts = {}) {
  const companyName = opts.companyName || deps.companyMeta().companyName || "";
  const detected = await deps.detect();
  if (!detected.path) {
    return buildHealth({ tallyDir: null, detectSource: detected.source });
  }
  const applyResult = deps.apply(detected.path);
  const live = await deps.liveStatus(companyName);
  info("[tdl] health", {
    tdlStatus: live.tdlStatus,
    version: live.version,
    billRows: live.billRows,
    reason: live.reason || null,
  });
  return buildHealth({ tallyDir: detected.path, detectSource: detected.source, applyResult, live });
}

/** Settings → Setup / Retry Setup. The only flow allowed to restart Tally. */
async function setupTdl(optionalDir, opts = {}) {
  let tallyDir = optionalDir || null;
  let detectSource = "user";
  if (tallyDir) {
    if (!looksLikeTallyDir(tallyDir)) {
      return {
        ...buildHealth({ tallyDir: null, detectSource: "user" }),
        applyResult: { status: false, message: "Selected folder is not a valid Tally install" },
        message: "Selected folder is not a valid Tally install",
        status: "blocked",
        level: "danger",
      };
    }
    store.set(STORE_KEY, tallyDir);
  } else {
    const detected = await deps.detect();
    tallyDir = detected.path;
    detectSource = detected.source;
  }

  if (!tallyDir) {
    return buildHealth({ tallyDir: null, detectSource: "none" });
  }

  const meta = deps.companyMeta();
  const companyName = opts.companyName || meta.companyName || "";
  const companyNumber = opts.companyNumber ?? meta.companyNumber;
  const allowRestart = opts.allowRestart !== false;

  const applyResult = deps.apply(tallyDir);
  const destTdl = path.join(tallyDir, TDL_FILENAME);
  let live = await deps.liveStatus(companyName);
  let activateResult = null;

  if (live.tdlStatus === TDL_STATUS.TALLY_TIMEOUT) {
    // Tally is running but busy — force-closing it could lose an unsaved entry.
    activateResult = {
      status: false,
      message: "Tally is busy and did not answer. Finish or save your work in Tally, then Retry setup.",
    };
  } else if (live.tdlStatus !== TDL_STATUS.ACTIVE && allowRestart && applyResult.status) {
    activateResult = await deps.activate(tallyDir, destTdl, { companyNumber });
    if (activateResult.status) {
      for (let i = 0; i < 4; i++) {
        await deps.wait(3000);
        if ((await deps.checkHealth(companyName)).status === TDL_STATUS.ACTIVE) break;
      }
      live = await deps.liveStatus(companyName);
    }
  }

  const health = buildHealth({ tallyDir, detectSource, applyResult, live, activateResult });
  info("[tdl] setup", {
    tdlStatus: health.tdlStatus,
    version: health.tdlVersion,
    billRows: health.liveBillRows,
    reason: live.reason || null,
    allowRestart,
    restarted: !!activateResult?.status,
    companyNumber: companyNumber || null,
  });
  return health;
}

module.exports = {
  getTdlHealth,
  setupTdl,
  setTallyInstallPath,
  detectTallyInstallPath,
  applyTdlToDir,
  activateTdlByRestartingTally,
  buildHealth,
  TDL_FILENAME,
  STORE_KEY,
  __setDepsForTests,
};
