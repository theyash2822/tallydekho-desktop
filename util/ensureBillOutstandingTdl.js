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
 * Settings status comes from global health only (READY needs health ACTIVE).
 * When health has no report at all, the company snapshot tells a legacy add-on
 * (rows) from no add-on (bill report missing). A company proven by its context
 * report never turns Settings Ready on its own.
 */
function settingsTdlStatus(snap) {
  if (snap.healthStatus !== TDL_STATUS.HEALTH_MISSING) return snap.healthStatus || TDL_STATUS.UNKNOWN;
  if (snap.status === "SUCCESS" && snap.tdlStatus === TDL_STATUS.ACTIVE_LEGACY) return TDL_STATUS.ACTIVE_LEGACY;
  if (snap.tdlStatus === TDL_STATUS.NOT_LOADED) return TDL_STATUS.NOT_LOADED;
  return TDL_STATUS.UNKNOWN;
}

/** Read-only live status. With a company we also run that company's Context → Bills check. */
async function liveTdlStatus(companyName) {
  if (!companyName) {
    const health = await checkTdlHealth();
    const tdlStatus = health.status === TDL_STATUS.HEALTH_MISSING ? TDL_STATUS.UNKNOWN : health.status;
    return { checked: true, tdlStatus, version: health.version || null, billRows: null, reason: health.reason };
  }
  const snap = await fetchCompanyBillSnapshot({ companyName, ...currentFyRange() });
  return {
    checked: true,
    tdlStatus: settingsTdlStatus(snap),
    version: snap.healthVersion,
    billRows: snap.status === "SUCCESS" ? snap.rowCount : null,
    billStatus: snap.status,
    contextStatus: snap.contextStatus,
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
  } else if (activateResult?.code && activateResult.status === false) {
    // Setup did not start Tally (it was open, path unsafe, …): tell the user what to do.
    reason = activateResult.code.toLowerCase();
    message = activateResult.message;
  } else if (activateResult?.companiesNotOpen?.length) {
    message = `${message} Open these companies in Tally (they stay selected): ${activateResult.companiesNotOpen.join(", ")}`;
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

/** Full path of the running tally.exe (Windows), or null. Read-only. */
async function runningTallyExe() {
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-Process -Name tally -ErrorAction SilentlyContinue | Select-Object -First 1).Path",
    ]);
    const p = String(stdout || "").trim();
    return p || null;
  } catch {
    return null;
  }
}

// cmd.exe re-parses its command line, so a folder containing one of these could run something else.
const CMD_UNSAFE_RE = /["&|<>^%!\r\n]/;
const COMPANY_NUMBER_RE = /^\d{1,10}$/;

/**
 * Decide whether Setup may start Tally. TallyDekho never force-closes Tally (an unsaved entry or
 * other open companies would be lost); when Tally is running the user closes it and retries.
 * @returns {{ ok: true, args: string[] } | { ok: false, code: string, message: string }}
 */
function planTallyLaunch({ platform, tallyDir, exeExists, tdlExists, running, companyNumber }) {
  if (platform !== "win32") return { ok: false, code: "UNSUPPORTED_PLATFORM", message: "Windows only" };
  if (!tallyDir || CMD_UNSAFE_RE.test(tallyDir)) {
    return { ok: false, code: "TALLY_PATH_UNSAFE", message: "The Tally folder path has characters TallyDekho cannot pass safely. Open Tally yourself, then Retry setup." };
  }
  if (!exeExists) return { ok: false, code: "TALLY_EXE_MISSING", message: `tally.exe not found in ${tallyDir}` };
  if (!tdlExists) return { ok: false, code: "TDL_MISSING", message: "TDL file missing — run setup first" };
  // R5 / 18: an unconfirmed process state is not "closed" — never start a second Tally on a guess.
  if (running === "unknown") {
    return { ok: false, code: "TALLY_STATE_UNKNOWN", message: "TallyDekho could not confirm whether Tally is open. Close Tally if it is open, then click Retry setup." };
  }
  if (running === true || running === "running") {
    return {
      ok: false,
      code: "TALLY_CLOSE_REQUIRED",
      message: "Tally is open. Save your work and close Tally, then click Retry setup — TallyDekho will start Tally with the add-on.",
    };
  }
  const number = companyNumber != null ? String(companyNumber).trim() : "";
  const args = [`/TDL:${TDL_FILENAME}`];
  if (COMPANY_NUMBER_RE.test(number)) args.unshift(`/LOAD:${number}`);
  return { ok: true, args };
}

/** Selected companies that are not open in Tally after a restart (null = Tally could not be asked). */
function companiesNotOpen(expected, open) {
  if (!open?.names) return null;
  return (expected || []).filter((c) => c?.guid && !open.names.has(String(c.guid))).map((c) => c.name || c.guid);
}

/**
 * Settings Setup / Retry Setup only: start Tally with /TDL so the report loads without manual F1.
 *
 * Tally docs: argv is `/TDL:path` (or `/TDL:filename` if file is in Tally folder).
 * Do NOT embed extra quotes inside the argv — that breaks paths like "TallyPrime (1)".
 * Prefer filename-only since we copy TDKBillOutstanding.tdl into the Tally folder.
 * /LOAD:companyNumber opens one company (multiple /LOAD is not verified); the others are reported.
 */
async function activateTdlByRestartingTally(tallyDir, destTdl, opts = {}) {
  const exe = tallyDir ? path.join(tallyDir, "tally.exe") : null;
  const running = process.platform === "win32" ? (await require("./tallyProcess").tallyProcessState()).state : "closed";
  const plan = planTallyLaunch({
    platform: process.platform,
    tallyDir,
    exeExists: !!exe && fs.existsSync(exe),
    tdlExists: fs.existsSync(destTdl),
    running,
    companyNumber: opts.companyNumber,
  });
  if (!plan.ok) {
    info("[tdl] setup: Tally not started", { code: plan.code });
    return { status: false, code: plan.code, message: plan.message };
  }
  const args = plan.args;
  const companyNumber = args[0].startsWith("/LOAD:") ? args[0].slice(6) : null;

  info("[tdl] setup: starting Tally with /TDL", { exe, args, destTdl, companyNumber });

  try {
    // The validated tally.exe itself with an argument array — no shell re-parses anything.
    // Its folder is the working directory, which resolves the short /TDL:<filename>.
    const child = spawn(exe, args, { cwd: tallyDir, detached: true, stdio: "ignore", windowsHide: false, shell: false });
    child.on("error", (e) => info("[tdl] setup: Tally start failed", { message: e?.message }));
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

  // `start /D <tallyDir>` makes tallyDir the working directory, which is what
  // resolves the short /TDL:<filename>. Confirm the running exe is from that folder.
  const runningExe = await runningTallyExe();
  const exeMatches = runningExe ? path.resolve(runningExe).toLowerCase() === path.resolve(exe).toLowerCase() : null;
  info("[tdl] setup: launched", { expectedExe: exe, runningExe, cwd: tallyDir, exeMatches });

  // Company + TDL load needs more than Gateway HTTP up
  await new Promise((r) => setTimeout(r, companyNumber ? 10000 : 5000));
  return {
    status: true,
    runningExe,
    exeMatches,
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
  expectedCompanies: () => require("./companySelection").getSelectedCompanies(),
  openCompanies: async () => require("./xml").getOpenCompanies(),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};
let deps = defaultDeps;

/** Tests only: replace Tally/disk access. `null` restores the real implementation. */
function __setDepsForTests(overrides) {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

let healthInFlight = null;
let healthRequestSeq = 0;

/**
 * Settings → Check now / health card. Never restarts Tally (refreshes the files on disk only).
 * Overlapping callers (Settings remount, double click) share one Tally round-trip.
 */
async function getTdlHealth(opts = {}) {
  if (healthInFlight) {
    info("[tdl] health deduped", { caller: "settings" });
    return healthInFlight;
  }
  healthInFlight = runGetTdlHealth(opts);
  try {
    return await healthInFlight;
  } finally {
    healthInFlight = null;
  }
}

async function runGetTdlHealth(opts) {
  const companyName = opts.companyName || deps.companyMeta().companyName || "";
  const detected = await deps.detect();
  if (!detected.path) {
    return buildHealth({ tallyDir: null, detectSource: detected.source });
  }
  const applyResult = deps.apply(detected.path);
  const live = await deps.liveStatus(companyName);
  info("[tdl] health", {
    seq: ++healthRequestSeq,
    tdlStatus: live.tdlStatus,
    version: live.version,
    billRows: live.billRows,
    billStatus: live.billStatus || null,
    contextStatus: live.contextStatus || null,
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
        if ((await deps.checkHealth()).status === TDL_STATUS.ACTIVE) break;
      }
      live = await deps.liveStatus(companyName);
      let notOpen = null;
      try {
        notOpen = companiesNotOpen(deps.expectedCompanies(), await deps.openCompanies());
      } catch (_) {
        notOpen = null;
      }
      activateResult = { ...activateResult, companiesNotOpen: notOpen };
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
  planTallyLaunch,
  companiesNotOpen,
  runningTallyExe,
  buildHealth,
  settingsTdlStatus,
  TDL_FILENAME,
  STORE_KEY,
  __setDepsForTests,
};
