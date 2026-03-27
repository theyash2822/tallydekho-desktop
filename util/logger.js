const { app } = require("electron");
const fs = require("fs");
const path = require("path");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function logPath(name = "info") {
  const dir = path.join(app.getPath("userData"), "logs");
  ensureDir(dir);
  return path.join(dir, `${name}.log`);
}

function ts() {
  return new Date().toISOString();
}

function write(name, level, message, meta) {
  const line =
    `[${ts()}] [${level}] ${message}` +
    (meta ? ` ${JSON.stringify(meta)}` : "");
  fs.appendFileSync(logPath(name), line + "\n", "utf8");
}

module.exports = {
  info: (msg, meta, name) => write(name, "INFO", msg, meta),
  error: (msg, meta, name) => write(name, "ERROR", msg, meta),
  logPath,
};
