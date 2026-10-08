const fs = require("fs");
const path = require("path");

const isDev = !!process.env.ELECTRON_DEV;

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const KEEP_ROTATED = 3;
const MAX_META_CHARS = 8 * 1024;
const MAX_DEPTH = 6;
const SECRET_KEY = /secret|token|password|passwd|authorization|cookie|otp|claim|api[-_]?key|private/i;

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

/**
 * JSON-safe copy of anything a caller passes as log meta: Errors keep name /
 * message / code / stack, axios errors keep only status and server code, secret-
 * looking keys are redacted, cycles and deep nesting are cut.
 */
function toLoggable(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  seen.add(value);

  if (value instanceof Error) {
    const out = { name: value.name, message: value.message };
    if (value.code) out.code = value.code;
    if (value.isAxiosError || value.response) {
      out.httpStatus = value.response?.status ?? null;
      out.serverCode = value.response?.data?.code ?? null;
      out.method = value.config?.method || null;
      out.url = value.config?.url || null;
    } else if (value.stack) {
      out.stack = String(value.stack).split("\n").slice(0, 8).join("\n");
    }
    return out;
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((v) => toLoggable(v, depth + 1, seen));
    if (value.length > 50) items.push(`[+${value.length - 50} more]`);
    return items;
  }

  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : toLoggable(value[key], depth + 1, seen);
  }
  return out;
}

function formatMeta(meta) {
  if (meta == null || meta === "") return "";
  let text;
  try {
    text = typeof meta === "string" ? meta : JSON.stringify(toLoggable(meta));
  } catch (_) {
    text = "[unserializable]";
  }
  if (text.length > MAX_META_CHARS) text = `${text.slice(0, MAX_META_CHARS)}…[${text.length - MAX_META_CHARS} chars cut]`;
  return ` ${text}`;
}

function formatMessage(message) {
  if (typeof message === "string") return message;
  try {
    return JSON.stringify(toLoggable(message));
  } catch (_) {
    return String(message);
  }
}

/** info.log → info.1.log → … → info.<KEEP_ROTATED>.log once the live file passes MAX_FILE_BYTES. */
function rotateIfNeeded(file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch (_) {
    return;
  }
  if (size < MAX_FILE_BYTES) return;
  const base = file.replace(/\.log$/, "");
  try {
    fs.rmSync(`${base}.${KEEP_ROTATED}.log`, { force: true });
    for (let i = KEEP_ROTATED - 1; i >= 1; i--) {
      if (fs.existsSync(`${base}.${i}.log`)) fs.renameSync(`${base}.${i}.log`, `${base}.${i + 1}.log`);
    }
    fs.renameSync(file, `${base}.1.log`);
  } catch (_) { /* rotation is best effort */ }
}

function write(name, level, message, meta) {
  const line = `[${ts()}] [${level}] ${formatMessage(message)}${formatMeta(meta)}`;

  try {
    const file = logPath(name);
    rotateIfNeeded(file);
    fs.appendFileSync(file, line + "\n", "utf8");
  } catch (_) { /* don't crash on log write failure */ }

  if (isDev) {
    const color = COLORS[level] || "";
    const out = level === "ERROR" ? process.stderr : process.stdout;
    out.write(`${color}[TallyDekho] ${line}${COLORS.RESET}\n`);
  }
}

const COLORS = {
  INFO:  "\x1b[36m",  // cyan
  ERROR: "\x1b[31m",  // red
  WARN:  "\x1b[33m",  // yellow
  RESET: "\x1b[0m",
};

module.exports = {
  info:  (msg, meta, name) => write(name || "info",  "INFO",  msg, meta),
  error: (msg, meta, name) => write(name || "info",  "ERROR", msg, meta),
  warn:  (msg, meta, name) => write(name || "info",  "WARN",  msg, meta),
  logPath,
  toLoggable,
  formatMeta,
  rotateIfNeeded,
  MAX_FILE_BYTES,
};
