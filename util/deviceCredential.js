const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");
const store = require("./store");
const { info } = require("./logger");

function secretPath() {
  return path.join(app.getPath("userData"), "device-secret.bin");
}

function saveDeviceSecret(secret) {
  if (!secret) return;
  try {
    if (safeStorage?.isEncryptionAvailable?.()) {
      fs.writeFileSync(secretPath(), safeStorage.encryptString(String(secret)));
      store.delete("deviceSecretEnc");
      return;
    }
  } catch (err) {
    info("[credential] safeStorage write failed, using fallback");
  }
  store.set("deviceSecretEnc", String(secret));
}

function getDeviceSecret() {
  try {
    if (fs.existsSync(secretPath()) && safeStorage?.isEncryptionAvailable?.()) {
      return safeStorage.decryptString(fs.readFileSync(secretPath()));
    }
  } catch (_) {}
  return store.get("deviceSecretEnc") || null;
}

function clearDeviceSecret() {
  try {
    fs.unlinkSync(secretPath());
  } catch (_) {}
  store.delete("deviceSecretEnc");
}

module.exports = { saveDeviceSecret, getDeviceSecret, clearDeviceSecret };
