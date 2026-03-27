const os = require("os");
const crypto = require("crypto");
const { app, screen } = require("electron");
const { machineIdSync } = require("node-machine-id");

function getDeviceId() {
  const raw = machineIdSync({ original: true });
  const hashed = crypto
    .createHmac("sha256", `${app.getName()}_v1`)
    .update(raw)
    .digest("hex");
  return hashed;
}

function getHost() {
  return os.hostname();
}

function getLocaleInfo() {
  const loc = Intl.DateTimeFormat().resolvedOptions();
  return {
    locale: loc.locale,
    tz: loc.timeZone,
    tzOffsetMin: new Date().getTimezoneOffset(),
  };
}

function getDisplayInfo() {
  try {
    const displays = screen.getAllDisplays().map((d) => ({
      id: d.id,
      size: { w: d.size.width, h: d.size.height },
      scale: d.scaleFactor,
      primary: d.bounds.x === 0 && d.bounds.y === 0,
    }));
    return { displays };
  } catch {
    return { displays: [] };
  }
}

function getDeviceProfile() {
  return {
    deviceId: getDeviceId(),
    uniqueid: getDeviceId().slice(0, 8),
    host: getHost(),
    // os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    app: {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
    },
    // cpu: { model: os.cpus()[0]?.model || "", cores: os.cpus().length },
    // ram: { total: os.totalmem() },
    // locale: getLocaleInfo(),
    display: getDisplayInfo(),
  };
}

module.exports = getDeviceProfile;
