const fs = require("fs");
const path = require("path");

const isDev = !!process.env.ELECTRON_DEV;

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function logPath(name = "info") {
  try {
    const { app } = require("electron");
    const dir = path.join(app.getPath("userData"), "logs");
    ensureDir(dir);
    return path.join(dir, `${name}.log`);
  } catch {
    // app not ready yet — fall back to temp dir
    const dir = path.join(require("os").tmpdir(), "TallyDekhoLogs");
    ensureDir(dir);
    return path.join(dir, `${name}.log`);
  }
}

function ts() {
  return new Date().toISOString();
}

const COLORS = {
  INFO:  "\x1b[36m",  // cyan
  ERROR: "\x1b[31m",  // red
  WARN:  "\x1b[33m",  // yellow
  RESET: "\x1b[0m",
};

function write(name, level, message, meta) {
  const line =
    `[${ts()}] [${level}] ${message}` +
    (meta ? ` ${JSON.stringify(meta)}` : "");

  // Always write to file
  try {
    fs.appendFileSync(logPath(name), line + "\n", "utf8");
  } catch (_) { /* don't crash on log write failure */ }

  // In dev mode: also print to terminal with color
  if (isDev) {
    const color = COLORS[level] || "";
    const out = level === "ERROR" ? process.stderr : process.stdout;
    out.write(`${color}[TallyDekho] [${level}] ${message}${COLORS.RESET}` +
      (meta ? ` ${JSON.stringify(meta)}` : "") + "\n");
  }
}

module.exports = {
  info:  (msg, meta, name) => write(name || "info",  "INFO",  msg, meta),
  error: (msg, meta, name) => write(name || "info",  "ERROR", msg, meta),
  warn:  (msg, meta, name) => write(name || "info",  "WARN",  msg, meta),
  logPath,
};
