/**
 * Bill Outstanding TDL setup + health check + live activation.
 *
 * Tally does NOT support loading TDL over HTTP Import (locked FORBIDDEN).
 * Solid path:
 *  1) Copy TDL + write tally.ini with quoted paths (required for "TallyPrime (1)")
 *  2) Probe live export for <BILLROW>
 *  3) If not loaded and allowRestart: restart Tally with /TDL:"path" (official CLI)
 *     so users never need F1 → manual TDL load.
 */
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const axios = require("axios");
const iconv = require("iconv-lite");
const { XMLParser } = require("fast-xml-parser");
const { info, error } = require("./logger");
const store = require("./store");
const getTallyVersionFromRegistry = require("./readTallyFromRegistry");

const TDL_FILENAME = "TDKBillOutstanding.tdl";
const INI_FILENAME = "tally.ini";
const STORE_KEY = "tallyInstallPath";
const REPORT_ID = "TDKBillOutstandingWorking";

const COMMON_PATHS = [
  "C:\\Program Files\\TallyPrime",
  "C:\\Program Files\\TallyPrime (1)",
  "C:\\Program Files\\TallyPrime (2)",
  "C:\\Program Files (x86)\\TallyPrime",
  "C:\\Program Files\\TallyPrime\\TallyPrime",
  "D:\\Program Files\\TallyPrime",
  "D:\\TallyPrime",
];

const parser = new XMLParser({
  ignoreAttributes: true,
  attributeNamePrefix: "",
  textNodeName: "value",
  parseTagValue: true,
  trimValues: true,
});

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

function buildHealth({ tallyDir, detectSource, applyResult, live = null, activateResult = null }) {
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
      liveLoaded: null,
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
      missing,
      applyResult: applyResult || null,
      activateResult,
    };
  }

  const destTdl = path.join(tallyDir, TDL_FILENAME);
  const iniPath = path.join(tallyDir, INI_FILENAME);
  const tdlPresent = fs.existsSync(destTdl);
  const ini = readIniState(iniPath, destTdl);

  if (!tdlPresent) missing.push(`${TDL_FILENAME} missing`);
  if (!ini.found) missing.push(`${INI_FILENAME} missing`);
  if (ini.found && !ini.userTdlYes) missing.push("User TDL is not Yes");
  if (ini.found && !ini.tdlListed) missing.push("TDL not linked in tally.ini");
  if (ini.found && ini.tdlListed && !ini.quotedOk) {
    missing.push("TDL path needs quotes (spaces/parentheses)");
  }
  if (live && live.checked && !live.loaded) {
    missing.push("TDL not active in running Tally");
  }

  let status = "ok";
  let level = "success";
  let message = "Bill Outstanding TDL is installed and active.";
  let reason = "ready";

  if (missing.length > 0) {
    status = "blocked";
    level = "danger";
    reason = !ini.found
      ? "ini_missing"
      : !tdlPresent
      ? "tdl_missing"
      : live && live.checked && !live.loaded
      ? "not_loaded_live"
      : "ini_not_linked";
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
    quotedOk: ini.quotedOk,
    liveLoaded: live?.checked ? !!live.loaded : null,
    liveBillRows: live?.billRows ?? null,
    destTdl,
    iniPath,
    missing,
    applyResult: applyResult || null,
    activateResult,
  };
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

function decodeTallyBody(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return iconv.decode(buf, "utf16-le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return iconv.decode(buf, "utf16-be");
  }
  return buf.toString("utf8");
}

function tallyHttpUrl() {
  const port = store.get("port") || 9000;
  return `http://localhost:${port}`;
}

/**
 * Live probe: does running Tally know report TDKBillOutstandingWorking?
 */
async function probeBillOutstandingLive(companyName) {
  const name = (companyName || "").trim() || " ";
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>${REPORT_ID}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${name}</SVCURRENTCOMPANY>
        <SVFROMDATE TYPE="Date">20260401</SVFROMDATE>
        <SVTODATE TYPE="Date">20270331</SVTODATE>
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>`;

  try {
    const response = await axios.post(tallyHttpUrl(), xml, {
      headers: { "Content-Type": "text/xml", Accept: "application/xml, text/xml, */*" },
      responseType: "arraybuffer",
      timeout: 20000,
    });
    const text = decodeTallyBody(response.data);
    const snippet = text.slice(0, 400).replace(/\s+/g, " ");
    const hasBillRow = /<BILLROW[\s>]/i.test(text);
    const hasLineError = /LINEERROR/i.test(text);
    const unknown =
      /unknown|does not exist|could not|not found/i.test(text) && !hasBillRow;

    let loaded = false;
    if (hasBillRow) loaded = true;
    else if (hasLineError || unknown) loaded = false;
    else {
      // Empty / envelope-only → treat as not loaded (matches prior junk HEADER/BODY case)
      try {
        const json = parser.parse(text);
        const env = json.ENVELOPE || json.Envelope || {};
        loaded = env.BILLROW != null || env.BillRow != null;
      } catch {
        loaded = false;
      }
    }

    const billRows = hasBillRow ? (text.match(/<BILLROW[\s>]/gi) || []).length : 0;
    info("[tdl] live probe", { loaded, billRows, hasLineError, snippet: snippet.slice(0, 180) });
    return { checked: true, loaded, billRows, hasLineError, snippet };
  } catch (e) {
    info("[tdl] live probe failed:", e?.message);
    return { checked: true, loaded: false, billRows: 0, error: e?.message };
  }
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
 * Official activation: restart Tally with /TDL so report loads without manual F1.
 *
 * Tally docs: argv is `/TDL:path` (or `/TDL:filename` if file is in Tally folder).
 * Do NOT embed extra quotes inside the argv — that breaks paths like "TallyPrime (1)".
 * Prefer filename-only since we copy TDKBillOutstanding.tdl into the Tally folder.
 * /LOAD:companyNumber reopens the company so the live probe can see BILLROW.
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

  // Filename-only: TDL lives in tallyDir (copied by applyTdlToDir)
  const args = [`/TDL:${TDL_FILENAME}`];
  if (companyNumber) {
    args.unshift(`/LOAD:${companyNumber}`);
  }

  info("[tdl] activating via Tally restart + /TDL", {
    exe,
    args,
    destTdl,
    companyNumber,
  });

  await execFileAsync("taskkill", ["/IM", "tally.exe", "/F"]);
  await new Promise((r) => setTimeout(r, 2500));

  try {
    // cmd `start` is the reliable way to launch a GUI Tally from Electron
    // start "" /D "dir" tally.exe /LOAD:n /TDL:file.tdl
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
      : "Tally restarted with Bill Outstanding TDL — open your company if probe still fails",
    args,
    companyNumber,
  };
}

function selectedCompanyMeta() {
  const c = store.get("selectedCompanies")?.[0] || {};
  return {
    companyName: c.name || "",
    companyNumber: c.companyNumber ?? c.COMPANYNUMBER ?? null,
  };
}

/**
 * @param {{ companyName?: string, companyNumber?: string|number, allowRestart?: boolean }} [opts]
 */
async function ensureBillOutstandingTdl(opts = {}) {
  const meta = selectedCompanyMeta();
  const companyName = opts.companyName || meta.companyName || "";
  const companyNumber = opts.companyNumber ?? meta.companyNumber;
  const allowRestart = !!opts.allowRestart;

  const detected = await detectTallyInstallPath();
  if (!detected.path) {
    const health = buildHealth({ tallyDir: null, detectSource: detected.source });
    info("[tdl] ensureBillOutstandingTdl", health);
    return health;
  }

  const applyResult = applyTdlToDir(detected.path);
  const destTdl = path.join(detected.path, TDL_FILENAME);

  let live = await probeBillOutstandingLive(companyName);
  let activateResult = null;

  if (!live.loaded && allowRestart && applyResult.status) {
    activateResult = await activateTdlByRestartingTally(detected.path, destTdl, {
      companyNumber,
    });
    if (activateResult.status) {
      // Retry probe a few times — company load is slow after /LOAD
      for (let i = 0; i < 4 && !live.loaded; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        live = await probeBillOutstandingLive(companyName);
      }
    }
  }

  const health = buildHealth({
    tallyDir: detected.path,
    detectSource: detected.source,
    applyResult,
    live,
    activateResult,
  });
  info("[tdl] ensureBillOutstandingTdl", {
    status: health.status,
    liveLoaded: health.liveLoaded,
    billRows: health.liveBillRows,
    allowRestart,
    activated: !!activateResult?.status,
    companyNumber: companyNumber || null,
    activateArgs: activateResult?.args || null,
  });
  return health;
}

async function getTdlHealth(opts = {}) {
  const meta = selectedCompanyMeta();
  const companyName = opts.companyName || meta.companyName || "";
  const detected = await detectTallyInstallPath();
  if (!detected.path) {
    return buildHealth({ tallyDir: null, detectSource: detected.source });
  }
  // Refresh quoted ini silently when checking health
  const applyResult = applyTdlToDir(detected.path);
  const live = await probeBillOutstandingLive(companyName);
  return buildHealth({
    tallyDir: detected.path,
    detectSource: detected.source,
    applyResult,
    live,
  });
}

async function setupTdl(optionalDir, opts = {}) {
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

  const meta = selectedCompanyMeta();
  return ensureBillOutstandingTdl({
    companyName: opts.companyName || meta.companyName || "",
    companyNumber: opts.companyNumber ?? meta.companyNumber,
    allowRestart: opts.allowRestart !== false,
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
  probeBillOutstandingLive,
  activateTdlByRestartingTally,
  TDL_FILENAME,
  STORE_KEY,
};
