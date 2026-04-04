const { execFile, exec } = require("child_process");
const { promisify } = require("util");
const axios = require("axios");
const http = require("http");
const https = require("https");
const { autoUpdater } = require("electron-updater");
const { app } = require("electron");
const path = require("path");

const { error, info } = require("./logger");
const getDeviceProfile = require("./deviceProfile");
const store = require("./store");

const execFileAsync = promisify(execFile);
const MS_PER_DAY = 86_400_000;

const isDev = !!process.env.ELECTRON_DEV;
const baseURL = process.env.BACKEND_URL ||
  (isDev ? "http://192.168.29.39:3001" : "https://api.tallydekho.com");
// In dev mode (npm run dev), automatically uses local backend
// In production build, uses https://api.tallydekho.com
// Override anytime with BACKEND_URL env var

const axiosInstance = axios.create({
  baseURL,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
  // timeout: timeoutMs,
  headers: {
    "device-id": getDeviceProfile().deviceId,
  },
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 }),
  transitional: { clarifyTimeoutError: true },
});

// axiosInstance.interceptors.request.use((cfg) => {
//   console.log("OUTGOING HEADERS:", cfg.headers);
//   return cfg;
// });

async function getVisibleApps() {
  const psScript = `
    Get-Process |
    Where-Object { $_.MainWindowTitle -ne "" } |
    Select-Object -ExpandProperty ProcessName
  `;

  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    psScript,
  ]);

  return stdout
    .trim()
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const isTallyOpen = async () => {
  try {
    const apps = await getVisibleApps();
    return apps.some((app) => app == "tally");
  } catch (err) {
    error(err?.message, "isTallyOpen");
    return false;
  }
};

const isOnlineHandler = async (timeoutMs = 5000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await axios.get("https://clients3.google.com/generate_204", {
      validateStatus: (s) => s >= 200 && s < 400,
      signal: controller.signal,
      timeout: timeoutMs,
      responseType: "text",
    });

    return res.status >= 200 && res.status < 400;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

function prettyBytes(b) {
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(b < 10 && i ? 2 : 0)} ${u[i]}`;
}

function diffDays(aMs, bMs, { timeZone = "UTC", signed = false } = {}) {
  const ymd = (ms) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(ms);
    const get = (t) => +parts.find((p) => p.type === t).value;
    return { y: get("year"), m: get("month"), d: get("day") };
  };

  const A = ymd(aMs);
  const B = ymd(bMs);

  const startA = Date.UTC(A.y, A.m - 1, A.d);
  const startB = Date.UTC(B.y, B.m - 1, B.d);

  const diff = Math.round((startB - startA) / MS_PER_DAY);
  return signed ? diff : Math.abs(diff);
}

function isTaskExists(taskName) {
  return new Promise((resolve) => {
    execFile(
      "schtasks",
      ["/Query", "/TN", taskName, "/FO", "LIST"],
      { windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve(true);
        resolve(false);
      }
    );
  });
}

function getDefaultMailClient() {
  return new Promise((resolve) => {
    exec(
      "reg query HKEY_CLASSES_ROOT\\mailto\\shell\\open\\command",
      (err, stdout) => {
        if (err) return resolve(null);
        const lower = stdout.toLowerCase();
        if (lower.includes("outlook")) return resolve("outlook");
        if (
          lower.includes("chrome") ||
          lower.includes("firefox") ||
          lower.includes("edge")
        )
          return resolve("gmail"); // rough heuristic
        resolve("default");
      }
    );
  });
}

async function registerDevice() {
  const deviceProfile = getDeviceProfile();

  let response;

  try {
    response = await axiosInstance.post("/desktop/register", {
      deviceId: deviceProfile.deviceId,
      host: deviceProfile.host,
      desktopVersion: deviceProfile.app.version,
    });

    response = response.data;
  } catch (err) {
    error(err?.message, "registerDevice");
    let message;
    const networkErrorCodes = [
      "ENOTFOUND",
      "ENETUNREACH",
      "ECONNREFUSED",
      "EAI_AGAIN",
      "ECONNRESET",
    ];

    if (err.code === "ECONNABORTED") {
      message = "Request timed out";
    } else if (networkErrorCodes.includes(err.code)) {
      message = "No internet connection or DNS error";
    } else {
      message =
        "Something went wrong. If this message persists, please contact the support team.";
    }

    return { status: false, message };
  }

  if (response.status) {
    store.set("lastSync", response.data.lastSync);
  }

  return { status: true, forceUpdate: response.data.forceUpdate };
}

async function checkForUpdates(mainWindow) {
  const update = await autoUpdater.checkForUpdates();
  if (update?.isUpdateAvailable) {
    const savedVersion = store.get("savedVersion");
    const version = update.updateInfo.version;

    if (savedVersion != version) {
      mainWindow.send("window:listener", {
        key: "isVersionUpdateModalOpen",
        value: true,
      });
    }

    store.set("savedVersion", version);
    return true;
  }
  return false;
}

function pollJobStatus({
  url,
  interval = 1000,
  maxInterval = 5000,
  timeout = 5 * 60 * 1000,
  maxAttempts = null,
  fetchOptions = {},
} = {}) {
  let attempts = 0;
  let currentInterval = interval;

  const start = Date.now();

  const sleep = (ms) =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve();
      }, ms);
    });

  const promise = new Promise(async (resolve, reject) => {
    try {
      while (true) {
        attempts += 1;
        const elapsed = Date.now() - start;
        if (timeout != null && elapsed > timeout) {
          return reject({
            status: false,
            message: `timeout after ${timeout}ms`,
          });
        }
        if (maxAttempts != null && attempts > maxAttempts) {
          return reject({
            status: false,
            message: `maxAttempts exceeded (${maxAttempts})`,
          });
        }

        let response;
        try {
          response = await axiosInstance(url, fetchOptions);
          response = response.data;
        } catch (err) {
          info("error", {
            message: err.message,
            code: err.code,
            errno: err.errno,
            address: err.address,
            port: err.port,
            responseStatus: err.response?.status,
            responseData: err.response?.data,
            configUrl: err.config?.baseURL + err.config?.url,
            headersSent: !!err.response,
          });
          return reject({
            status: false,
            message: err.response?.data?.message || err.message,
          });
        }

        info("Polling Status", response);

        if (response.status) {
          return resolve({
            status: response.data == "success",
            message: response.message,
            attempts,
          });
        }

        await sleep(currentInterval);
        currentInterval = Math.min(
          maxInterval,
          Math.ceil(currentInterval * 1.5)
        );
      }
    } catch (err) {
      reject({ status: false, message: err });
    }
  });

  return promise;
}

function assetPath(...segments) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...segments);
  } else {
    return path.join(app.getAppPath(), ...segments);
  }
}

module.exports = {
  isTallyOpen,
  isOnlineHandler,
  prettyBytes,
  diffDays,
  isTaskExists,
  getDefaultMailClient,
  registerDevice,
  axiosInstance,
  baseURL,
  pollJobStatus,
  checkForUpdates,
  assetPath,
};
