/**
 * Option B: silently copy TDKBillOutstanding.tdl into TallyPrime folder
 * and ensure tally.ini references it. No UI message.
 *
 * Path locked by Yash (2026-07-13): C:\Program Files\TallyPrime
 */
const fs = require("fs");
const path = require("path");
const { info, error } = require("./logger");

const TALLY_DIR = "C:\\Program Files\\TallyPrime";
const TDL_FILENAME = "TDKBillOutstanding.tdl";
const INI_FILENAME = "tally.ini";

function ensureBillOutstandingTdl() {
  if (process.platform !== "win32") {
    return { status: true, skipped: true, reason: "not_windows" };
  }

  const srcTdl = path.join(__dirname, "..", "xmls", TDL_FILENAME);
  const destTdl = path.join(TALLY_DIR, TDL_FILENAME);
  const iniPath = path.join(TALLY_DIR, INI_FILENAME);

  try {
    if (!fs.existsSync(srcTdl)) {
      error(`source TDL missing: ${srcTdl}`, "ensureBillOutstandingTdl");
      return { status: false, message: "source TDL missing" };
    }

    fs.copyFileSync(srcTdl, destTdl);
    info(`[tdl] copied ${TDL_FILENAME} → ${destTdl}`);

    if (!fs.existsSync(iniPath)) {
      error(`tally.ini not found: ${iniPath}`, "ensureBillOutstandingTdl");
      return { status: false, message: "tally.ini not found", destTdl };
    }

    let ini = fs.readFileSync(iniPath, "utf8");
    const original = ini;

    // Enable user TDL loading if the key exists or append it
    if (/User\s*TDL\s*Files\s*=/i.test(ini)) {
      ini = ini.replace(/User\s*TDL\s*Files\s*=\s*\S*/i, "User TDL Files=Yes");
    } else {
      ini = ini.trimEnd() + "\r\nUser TDL Files=Yes\r\n";
    }

    const alreadyListed =
      ini.toLowerCase().includes(TDL_FILENAME.toLowerCase()) ||
      ini.toLowerCase().includes(destTdl.toLowerCase());

    if (!alreadyListed) {
      // Prefer TDL= form (common in TallyPrime). Keep CRLF for Windows ini.
      ini = ini.trimEnd() + `\r\nTDL=${destTdl}\r\n`;
    }

    if (ini !== original) {
      fs.writeFileSync(iniPath, ini, "utf8");
      info(`[tdl] updated ${iniPath} with TDL=${destTdl}`);
    } else {
      info(`[tdl] tally.ini already references ${TDL_FILENAME}`);
    }

    return { status: true, destTdl, iniPath };
  } catch (e) {
    // Common on locked Program Files without elevation — log only, no dialog
    error(e?.message || String(e), "ensureBillOutstandingTdl");
    return { status: false, message: e?.message || String(e) };
  }
}

module.exports = { ensureBillOutstandingTdl, TALLY_DIR, TDL_FILENAME };
