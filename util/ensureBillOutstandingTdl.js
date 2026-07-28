/**
 * Bill Outstanding TDL setup + health check.
 * Auto-detects Tally install path; persists user override in store.
 * Never silently fail for Settings UX — returns structured status.
 */
const fs = require("fs");
const path = require("path");
const { info, error } = require("./logger");
const store = require("./store");
const getTallyVersionFromRegistry = require("./readTallyFromRegistry");

const TDL_FILENAME = "TDKBillOutstanding.tdl";
const INI_FILENAME = "tally.ini";
const STORE_KEY = "tallyInstallPath";

const COMMON_PATHS = [
  "C:\\Program Files\\TallyPrime",
  "C:\\Program Files (x86)\\TallyPrime",
  "C:\\Program Files\\TallyPrime\\TallyPrime",
  "D:\\Program Files\\TallyPrime",
  "D:\\TallyPrime",
];

function sourceTdlPath() {
  return path.join(__dirname, "..", "xmls", TDL_FILENAME);
}

function looksLikeTallyDir(dir) {
  if (!dir || typeof dir !== "string") return false;
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    // Accept if tally.exe or tally.ini exists nearby
    const exe = path.join(dir, "tally.exe");
    const ini = path.join(dir, INI_FILENAME);
    return fs.existsSync(exe) || fs.existsSync(ini);
  } catch {
    return false;
  }
}

function dirFromExe(exePath) {
  if (!exePath) return null;
  try {
    return path.dirname(exePath);
  } catch {
    return null;
  }
}

async function detectTallyInstallPath() {
  const saved = store.get(STORE_KEY);
  if (looksLikeTallyDir(saved)) {
    return { path: saved, source: "saved" };
  }

  try {
    const infoReg = await getTallyVersionFromRegistry();
    if (infoReg?.installLocation && looksLikeTallyDir(infoReg.installLocation)) {
      return { path: infoReg.installLocation.replace(/\\+$/, ""), source: "registry" };
    }
    if (infoReg?.exePath) {
      const d = dirFromExe(infoReg.exePath);
      if (looksLikeTallyDir(d)) return { path: d, source: "process" };
    }
  } catch (e) {
    info("[tdl] registry/process detect failed:", e?.message);
  }

  for (const p of COMMON_PATHS) {
    if (looksLikeTallyDir(p)) return { path: p, source: "common" };
  }

  return { path: null, source: "none" };
}

function readIniState(iniPath) {
  if (!fs.existsSync(iniPath)) {
    return { found: false, userTdlYes: false, tdlListed: false, raw: null };
  }
  const raw = fs.readFileSync(iniPath, "utf8");
  const userTdlYes = /User\s*TDL\s*Files\s*=\s*Yes/i.test(raw);
  const tdlListed =
    raw.toLowerCase().includes(TDL_FILENAME.toLowerCase());
  return { found: true, userTdlYes, tdlListed, raw };
}

function buildHealth({ tallyDir, detectSource, applyResult }) {
  const missing = [];
  const platform = process.platform;
  if (platform !== "win32") {
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
      missing: [],
      applyResult: applyResult || null,
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
      missing,
      applyResult: applyResult || null,
    };
  }

  const destTdl = path.join(tallyDir, TDL_FILENAME);
  const iniPath = path.join(tallyDir, INI_FILENAME);
  const tdlPresent = fs.existsSync(destTdl);
  const ini = readIniState(iniPath);

  if (!tdlPresent) missing.push(`${TDL_FILENAME} missing`);
  if (!ini.found) missing.push(`${INI_FILENAME} missing`);
  if (ini.found && !ini.userTdlYes) missing.push("User TDL Files is not Yes");
  if (ini.found && !ini.tdlListed) missing.push("TDL not linked in tally.ini");

  let status = "ok";
  let level = "success";
  let message = "Bill Outstanding TDL is installed and linked.";
  let reason = "ready";

  if (missing.length > 0) {
    status = "blocked";
    level = "danger";
    reason = !ini.found ? "ini_missing" : !tdlPresent ? "tdl_missing" : "ini_not_linked";
    message = missing[0];
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
    destTdl,
    iniPath,
    missing,
    applyResult: applyResult || null,
  };
}

/**
 * Apply TDL copy + ini link into tallyDir.
 */
function applyTdlToDir(tallyDir) {
  if (process.platform !== "win32") {
    return { status: true, skipped: true, reason: "not_windows" };
  }
  if (!looksLikeTallyDir(tallyDir)) {
    return { status: false, message: "Selected folder is not a valid Tally install", tallyDir };
  }

  const srcTdl = sourceTdlPath();
  const destTdl = path.join(tallyDir, TDL_FILENAME);
  const iniPath = path.join(tallyDir, INI_FILENAME);

  try {
    if (!fs.existsSync(srcTdl)) {
      error(`source TDL missing: ${srcTdl}`, "ensureBillOutstandingTdl");
      return { status: false, message: "source TDL missing in app package" };
    }

    fs.copyFileSync(srcTdl, destTdl);
    info(`[tdl] copied ${TDL_FILENAME} → ${destTdl}`);

    if (!fs.existsSync(iniPath)) {
      error(`tally.ini not found: ${iniPath}`, "ensureBillOutstandingTdl");
      return { status: false, message: "tally.ini not found in Tally folder", destTdl, iniPath };
    }

    let ini = fs.readFileSync(iniPath, "utf8");
    const original = ini;

    if (/User\s*TDL\s*Files\s*=/i.test(ini)) {
      ini = ini.replace(/User\s*TDL\s*Files\s*=\s*\S*/i, "User TDL Files=Yes");
    } else {
      ini = ini.trimEnd() + "\r\nUser TDL Files=Yes\r\n";
    }

    const alreadyListed =
      ini.toLowerCase().includes(TDL_FILENAME.toLowerCase()) ||
      ini.toLowerCase().includes(destTdl.toLowerCase());

    if (!alreadyListed) {
      ini = ini.trimEnd() + `\r\nTDL=${destTdl}\r\n`;
    }

    if (ini !== original) {
      fs.writeFileSync(iniPath, ini, "utf8");
      info(`[tdl] updated ${iniPath} with TDL=${destTdl}`);
    } else {
      info(`[tdl] tally.ini already references ${TDL_FILENAME}`);
    }

    store.set(STORE_KEY, tallyDir);
    return { status: true, destTdl, iniPath, tallyDir };
  } catch (e) {
    error(e?.message || String(e), "ensureBillOutstandingTdl");
    return {
      status: false,
      message: e?.message || String(e),
      hint: /EPERM|EACCES|access/i.test(e?.message || "")
        ? "Run TallyDekho as Administrator, then Retry setup."
        : null,
      tallyDir,
    };
  }
}

/**
 * Boot / sync helper — detect path, try apply, return health.
 */
async function ensureBillOutstandingTdl() {
  const detected = await detectTallyInstallPath();
  if (!detected.path) {
    const health = buildHealth({ tallyDir: null, detectSource: detected.source });
    info("[tdl] ensureBillOutstandingTdl", health);
    return health;
  }

  const applyResult = applyTdlToDir(detected.path);
  const health = buildHealth({
    tallyDir: detected.path,
    detectSource: detected.source,
    applyResult,
  });
  info("[tdl] ensureBillOutstandingTdl", health);
  return health;
}

async function getTdlHealth() {
  const detected = await detectTallyInstallPath();
  return buildHealth({
    tallyDir: detected.path,
    detectSource: detected.source,
  });
}

async function setupTdl(optionalDir) {
  let tallyDir = optionalDir || null;
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
    const detected = await detectTallyInstallPath();
    tallyDir = detected.path;
  }

  if (!tallyDir) {
    return buildHealth({ tallyDir: null, detectSource: "none" });
  }

  const applyResult = applyTdlToDir(tallyDir);
  return buildHealth({
    tallyDir,
    detectSource: optionalDir ? "user" : "auto",
    applyResult,
  });
}

function setTallyInstallPath(dir) {
  if (looksLikeTallyDir(dir)) {
    store.set(STORE_KEY, dir);
    return { status: true, path: dir };
  }
  return { status: false, message: "Invalid Tally folder" };
}

module.exports = {
  ensureBillOutstandingTdl,
  getTdlHealth,
  setupTdl,
  setTallyInstallPath,
  detectTallyInstallPath,
  applyTdlToDir,
  TDL_FILENAME,
  STORE_KEY,
};
