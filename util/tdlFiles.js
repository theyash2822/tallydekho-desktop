/**
 * Bill Outstanding TDL files on disk: locate the Tally folder, copy the TDL and
 * link it in tally.ini. Never touches the Tally process — sync may call this.
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
  "C:\\Program Files\\TallyPrime (1)",
  "C:\\Program Files\\TallyPrime (2)",
  "C:\\Program Files (x86)\\TallyPrime",
  "C:\\Program Files\\TallyPrime\\TallyPrime",
  "D:\\Program Files\\TallyPrime",
  "D:\\TallyPrime",
];

function sourceTdlPath() {
  return path.join(__dirname, "..", "xmls", TDL_FILENAME);
}

function quoteIniPath(p) {
  const cleaned = String(p || "").replace(/^"+|"+$/g, "");
  return `"${cleaned}"`;
}

function looksLikeTallyDir(dir) {
  if (!dir || typeof dir !== "string") return false;
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
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

function readIniState(iniPath, destTdl) {
  if (!fs.existsSync(iniPath)) {
    return { found: false, userTdlYes: false, tdlListed: false, quotedOk: false, raw: null };
  }
  const raw = fs.readFileSync(iniPath, "utf8");
  const userTdlYes =
    /User\s*TDL\s*Files\s*=\s*Yes/i.test(raw) || /User\s*TDL\s*=\s*Yes/i.test(raw);
  const tdlListed =
    raw.toLowerCase().includes(TDL_FILENAME.toLowerCase()) ||
    (destTdl && raw.toLowerCase().includes(destTdl.toLowerCase()));
  const quotedOk = destTdl
    ? raw.includes(quoteIniPath(destTdl)) || !/[()]/.test(destTdl)
    : true;
  return { found: true, userTdlYes, tdlListed, quotedOk, raw };
}

/**
 * Apply TDL copy + quoted ini link into tallyDir.
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
  const quoted = quoteIniPath(destTdl);

  try {
    if (!fs.existsSync(srcTdl)) {
      error(`source TDL missing: ${srcTdl}`, "tdlFiles");
      return { status: false, message: "source TDL missing in app package" };
    }

    const same = fs.existsSync(destTdl) && fs.readFileSync(destTdl).equals(fs.readFileSync(srcTdl));
    if (!same) {
      fs.copyFileSync(srcTdl, destTdl);
      info(`[tdl] copied ${TDL_FILENAME} → ${destTdl}`);
    }

    if (!fs.existsSync(iniPath)) {
      error(`tally.ini not found: ${iniPath}`, "tdlFiles");
      return { status: false, message: "tally.ini not found in Tally folder", destTdl, iniPath };
    }

    let ini = fs.readFileSync(iniPath, "utf8");
    const original = ini;

    // Enable user TDLs (both key spellings used across Tally versions)
    if (/User\s*TDL\s*Files\s*=/i.test(ini)) {
      ini = ini.replace(/User\s*TDL\s*Files\s*=\s*\S*/i, "User TDL Files=Yes");
    } else {
      ini = ini.trimEnd() + "\r\nUser TDL Files=Yes\r\n";
    }
    // Separate "User TDL=Yes" key (must not match "User TDL Files=")
    if (/^\s*User\s*TDL\s*=/im.test(ini)) {
      ini = ini.replace(/^\s*User\s*TDL\s*=\s*\S*/gim, "User TDL=Yes");
    } else {
      ini = ini.trimEnd() + "\r\nUser TDL=Yes\r\n";
    }

    // Drop any existing lines that reference our TDL (quoted or not), then add one clean quoted line
    ini = ini
      .split(/\r?\n/)
      .filter((line) => !/^\s*TDL\s*=/i.test(line) || !line.toLowerCase().includes(TDL_FILENAME.toLowerCase()))
      .join("\r\n");

    ini = ini.trimEnd() + `\r\nTDL=${quoted}\r\n`;

    if (ini !== original) {
      fs.writeFileSync(iniPath, ini, "utf8");
      info(`[tdl] updated ${iniPath} with TDL=${quoted}`);
    } else {
      info(`[tdl] tally.ini already has quoted ${TDL_FILENAME}`);
    }

    store.set(STORE_KEY, tallyDir);
    return { status: true, destTdl, iniPath, tallyDir, quoted };
  } catch (e) {
    error(e?.message || String(e), "tdlFiles");
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

/** Detect the Tally folder and refresh the TDL file + ini link. */
async function installTdlFiles() {
  const detected = await detectTallyInstallPath();
  if (!detected.path) return { detected, applyResult: null };
  return { detected, applyResult: applyTdlToDir(detected.path) };
}

function setTallyInstallPath(dir) {
  if (looksLikeTallyDir(dir)) {
    store.set(STORE_KEY, dir);
    return { status: true, path: dir };
  }
  return { status: false, message: "Invalid Tally folder" };
}

module.exports = {
  TDL_FILENAME,
  INI_FILENAME,
  STORE_KEY,
  looksLikeTallyDir,
  detectTallyInstallPath,
  readIniState,
  applyTdlToDir,
  installTdlFiles,
  setTallyInstallPath,
};
