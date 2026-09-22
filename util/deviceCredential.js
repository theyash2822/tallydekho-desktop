const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app, safeStorage } = require("electron");
const store = require("./store");
const { info } = require("./logger");

function secretPath() {
  return path.join(app.getPath("userData"), "device-secret.bin");
}

function fallbackEncPath() {
  return path.join(app.getPath("userData"), "device-secret.enc");
}

function fallbackKeyPath() {
  return path.join(app.getPath("userData"), "device-secret.key");
}

function readFallbackKey() {
  const keyFile = fallbackKeyPath();
  if (fs.existsSync(keyFile)) {
    const raw = fs.readFileSync(keyFile);
    if (raw.length === 32) return raw;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  return key;
}

function encryptFallback(secret) {
  const key = readFallbackKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(secret), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

function decryptFallback(buf) {
  if (!buf || buf.length < 29) return null;
  const key = readFallbackKey();
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function saveEncryptedFallback(secret) {
  fs.writeFileSync(fallbackEncPath(), encryptFallback(secret), { mode: 0o600 });
  // Never leave plaintext in electron-store.
  store.delete("deviceSecretEnc");
}

function saveDeviceSecret(secret) {
  if (!secret) return;
  try {
    if (safeStorage?.isEncryptionAvailable?.()) {
      fs.writeFileSync(secretPath(), safeStorage.encryptString(String(secret)));
      try {
        fs.unlinkSync(fallbackEncPath());
      } catch (_) {}
      store.delete("deviceSecretEnc");
      return;
    }
  } catch (err) {
    info("[credential] safeStorage write failed, using encrypted-file fallback");
  }
  try {
    saveEncryptedFallback(secret);
  } catch (err) {
    info("[credential] encrypted-file fallback failed:", err?.message);
  }
}

function getDeviceSecret() {
  try {
    if (fs.existsSync(secretPath()) && safeStorage?.isEncryptionAvailable?.()) {
      return safeStorage.decryptString(fs.readFileSync(secretPath()));
    }
  } catch (_) {}

  try {
    if (fs.existsSync(fallbackEncPath())) {
      return decryptFallback(fs.readFileSync(fallbackEncPath()));
    }
  } catch (_) {}

  // One-time migrate legacy plaintext electron-store secret → encrypted file, then purge.
  const legacy = store.get("deviceSecretEnc");
  if (legacy) {
    try {
      saveEncryptedFallback(String(legacy));
      store.delete("deviceSecretEnc");
      return String(legacy);
    } catch (_) {
      store.delete("deviceSecretEnc");
    }
  }
  return null;
}

function clearDeviceSecret() {
  try {
    fs.unlinkSync(secretPath());
  } catch (_) {}
  try {
    fs.unlinkSync(fallbackEncPath());
  } catch (_) {}
  try {
    fs.unlinkSync(fallbackKeyPath());
  } catch (_) {}
  store.delete("deviceSecretEnc");
}

module.exports = { saveDeviceSecret, getDeviceSecret, clearDeviceSecret };
