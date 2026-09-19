const fsp = require("fs/promises");

const OWNER_FILE = 0o600;
const OWNER_DIR = 0o700;

function canRestrictPermissions() {
  return process.platform !== "win32";
}

async function restrictOwnerOnly(filePath) {
  if (!filePath || !canRestrictPermissions()) return;
  try {
    await fsp.chmod(filePath, OWNER_FILE);
  } catch (_) {}
}

async function restrictOwnerDir(dirPath) {
  if (!dirPath || !canRestrictPermissions()) return;
  try {
    await fsp.chmod(dirPath, OWNER_DIR);
  } catch (_) {}
}

async function unlinkQuiet(filePath) {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch (_) {}
}

module.exports = {
  OWNER_FILE,
  OWNER_DIR,
  canRestrictPermissions,
  restrictOwnerOnly,
  restrictOwnerDir,
  unlinkQuiet,
};
