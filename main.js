// Load .env from app root (not process cwd — electronmon/IDE launches vary)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  dialog,
  shell,
  nativeImage,
  powerMonitor,
} = require("electron");
const os = require("os");
const path = require("path");
const { autoUpdater } = require("electron-updater");
const log = require("electron-log");
const ioClient = require("socket.io-client");

const store = require("./util/store");

const { error, info, logPath } = require("./util/logger");
const {
  registerTallySync,
  startAutoSync,
  startAutoSyncHeadless,
  startAutoBackupHeadless,
  startAutoBackup,
} = require("./util/ipcRegistry");
const { registerBackup } = require("./util/saveBackup");
const registerRestoreBackup = require("./util/restoreBackup");
const {
  isTaskExists,
  getDefaultMailClient,
  registerDevice,
  baseURL,
  APP_ENV,
  checkForUpdates,
  assetPath,
} = require("./util/helper");
const validateSchema = require("./util/validateSchema");
const {
  getSelectedCompanies,
  setSelectedCompanies,
} = require("./util/companySelection");
const {
  initPairingRuntime,
  reconcileBinding,
  handleResume,
} = require("./util/pairingRuntime");
const { reconcilePendingWriteback } = require("./util/writeback");

// Note: ipcRegistry already required above via destructuring — do NOT require again
// require("./util/ipcRegistry"); // REMOVED: double-require crashes Electron (duplicate IPC handlers)
require("./util/backup");
require("./util/closeSoftware");

let mainWindow;
let allowQuit = false;
let quittingByWatcherOrSignal = false;

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
  return;
}

const isHeadlessSync = process.argv.includes("--run-sync");
const isHeadlessBackup = process.argv.includes("--run-backup");
const isHeadless = isHeadlessSync || isHeadlessBackup;

const isDev = !!process.env.ELECTRON_DEV;

const template = [
  {
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
      {
        label: "Toggle Developer Tools",
        accelerator: "F12",
        click: (menuItem, browserWindow) => {
          if (browserWindow) browserWindow.webContents.toggleDevTools();
        },
      },
    ],
  },
];

function configureUpdater() {
  if (!app.isPackaged) {
    info("[updater] skip in dev");
    return;
  }

  // The baked publish feed only ever carries production artifacts, so a staging
  // build must not self-update — it would silently become the production client.
  if (APP_ENV !== "production") {
    info(`[updater] skip in ${APP_ENV} build`);
    return;
  }

  // Set your feed URL EARLY so updater never looks for app-update.yml
  // autoUpdater.setFeedURL({
  //   provider: "generic",
  //   url: "https://test.tallydekho.com/tallydekho/",
  // });

  log.transports.file.level = "debug";
  autoUpdater.logger = log;

  autoUpdater.autoDownload = false;
  // autoUpdater.allowPrerelease = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.disableDifferentialDownload = false;
}

configureUpdater();

/** Renderer origins this app is ever allowed to load. */
function isTrustedRendererUrl(target) {
  try {
    const parsed = new URL(target);
    if (parsed.protocol === "file:") {
      return parsed.pathname.endsWith("/renderer/dist/index.html");
    }
    // Vite dev server, development builds only.
    return (
      isDev &&
      parsed.protocol === "http:" &&
      parsed.hostname === "localhost" &&
      parsed.port === "5173"
    );
  } catch (_) {
    return false;
  }
}

/**
 * Deny navigation and window creation by default. External links are opened
 * through the explicit `openExternal` IPC, never by renderer-supplied URLs.
 */
function applyNavigationPolicy(window) {
  const contents = window.webContents;

  contents.setWindowOpenHandler(({ url }) => {
    info(`[security] blocked window.open → ${url}`);
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    info(`[security] blocked navigation → ${url}`);
  });

  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
    info("[security] blocked webview attach");
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 500,
    // start
    resizable: false,
    frame: false,
    // end
    show: false,
    movable: true,
    // thickFrame: false,
    // transparent: true,
    maximizable: false, // prevents double-click maximize
    fullscreenable: false, // optional: blocks F11/fullscreen
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      // preload.js only pulls contextBridge/ipcRenderer, both available to a
      // sandboxed preload, so the renderer runs with OS sandboxing on.
      sandbox: true,
      zoomFactor: 1.0,
    },
  });

  applyNavigationPolicy(mainWindow);

  // A staging installer looks identical to production; label it so a tester
  // never mistakes which backend they are writing to.
  if (APP_ENV !== "production") {
    mainWindow.setTitle(`TallyDekho — ${APP_ENV.toUpperCase()}`);
  }

  registerTallySync(mainWindow);
  registerBackup(mainWindow);
  registerRestoreBackup(mainWindow);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    // if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_e, ec, desc, _url, isMainFrame) => {
      console.error("did-fail-load", ec, desc);
      if (isMainFrame && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(
          `data:text/html;charset=utf-8,` +
            encodeURIComponent(
              `<h3>Failed to load renderer</h3><pre>${ec} ${desc}</pre>`
            )
        );
        mainWindow.show();
      }
    }
  );

  // store.clear();

  // if (!store.get("port")) {
  //   store.set("port", 9000);
  // }

  // if (!store.get("selectedCompanies")) {
  //   store.set("selectedCompanies", []);
  // }

  if (!store.get("backup.dir")) {
    store.set("backup.dir", os.tmpdir());
  }

  store.set("appVersion", app.getVersion());

  // if (!store.get("backups")) {
  //   store.set("backups", []);
  // }

  // if (!store.get("backupAndRestoreActivity")) {
  //   store.set("backupAndRestoreActivity", []);
  // }

  // if (!store.get("backupInterval")) {
  //   store.set("backupInterval", "off");
  // }

  validateSchema();

  if (store.get("isAutoSync")) {
    isTaskExists("TallyDekhoAutoSync").then((response) => {
      if (!response) {
        store.set("isAutoSync", false);
      }
    });
  }

  if (store.get("backupInterval") && store.get("backupInterval") != "off") {
    isTaskExists("TallyDekhoAutoBackup").then((response) => {
      if (!response) {
        store.set("backupInterval", "off");
      }
    });
  }

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "renderer/dist/index.html"));

    checkForUpdates(mainWindow);
  }

  // Block devtools shortcuts
  // mainWindow.webContents.on("before-input-event", (event, input) => {
  //   if (
  //     (input.key.toLowerCase() === "i" && input.control && input.shift) ||
  //     input.key === "F12"
  //   ) {
  //     event.preventDefault();
  //   }
  // });

  mainWindow.on("close", async (e) => {
    if (quittingByWatcherOrSignal || allowQuit) {
      return;
    }

    const isSyncing = store.get("isSyncing");
    if (isSyncing) {
      mainWindow.send("window:listener", {
        key: "isCloseConfirmationModalOpen",
        value: true,
      });
      e.preventDefault();
    }
  });
}

ipcMain.handle("window:minimize", async () => {
  mainWindow?.minimize();
});

ipcMain.handle("window:close", () => {
  allowQuit = true;
  mainWindow?.close();
});

ipcMain.handle("dialog:openFile", async (_event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options);
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("openExternal", async (_event) => {
  const email = "support@tallydekho.com";
  const subject = "Support Request";
  const body = "Hi Support Team,";

  // const client = await getDefaultMailClient();

  const mailtoUrl = `mailto:${email}?subject=${encodeURIComponent(
    subject
  )}&body=${encodeURIComponent(body)}`;

  const gmailLink = `https://mail.google.com/mail/?view=cm&fs=1&to=${email}&su=${encodeURIComponent(
    subject
  )}&body=${encodeURIComponent(body)}`;

  const outlookLink = `https://outlook.live.com/mail/0/deeplink/compose?to=${email}&subject=${encodeURIComponent(
    subject
  )}&body=${encodeURIComponent(body)}`;

  // let url = mailtoUrl;
  // if (client === "gmail") url = gmailLink;
  // else if (client === "outlook") url = outlookLink;

  return shell.openExternal(gmailLink);
});

// Ping backend to check real connectivity (not just browser online status)
ipcMain.handle("backend:ping", async () => {
  const { axiosInstance } = require("./util/helper");
  try {
    await axiosInstance.get("/health", { timeout: 10000 }); // 10s timeout — avoids false offline on slow connections
    return true;
  } catch {
    return false;
  }
});

const {
  canRendererRead,
  canRendererWrite,
} = require("./util/storeAllowlist");

ipcMain.handle("store:get", (_event, key) => {
  if (!canRendererRead(key)) {
    error(`blocked renderer read of '${key}'`, "store:get");
    return undefined;
  }
  // Selection is workspace-scoped; never hand back another workspace's list.
  if (key === "selectedCompanies") return getSelectedCompanies();
  return store.get(key);
});

ipcMain.handle("store:set", (_event, key, value) => {
  if (!canRendererWrite(key)) {
    error(`blocked renderer write of '${key}'`, "store:set");
    return false;
  }
  if (key === "selectedCompanies") {
    setSelectedCompanies(value);
    return true;
  }
  const previousOnline = key === "isOnline" ? store.get("isOnline") : null;
  store.set(key, value);
  // Offline → online is a pairing/writeback recovery edge. Socket reconnect
  // covers most cases; this catches a restored network before the socket is up.
  if (key === "isOnline" && value && !previousOnline) {
    handleResume("network-online");
    reconcileBinding("network-online").then((result) => {
      if (result.paired) reconcilePendingWriteback("network-online");
    });
    require("./util/helper").axiosInstance.post("/desktop/heartbeat").catch(() => {});
  }
  return true;
});

ipcMain.handle("updater:check", async () => {
  if (!app.isPackaged || APP_ENV !== "production") {
    return { ok: false, error: "Updates are only available on the production Desktop." };
  }
  try {
    info("[updater:check] called");
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, info: r };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle("updater:download", async () => {
  if (!app.isPackaged || APP_ENV !== "production") {
    return { ok: false, error: "Updates are only available on the production Desktop." };
  }
  try {
    info("[updater:download] called");
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle(
  "updater:quitAndInstall",
  () => autoUpdater.quitAndInstall(false, true)
  // setImmediate(() =>
  //   autoUpdater.quitAndInstall(true /* isSilent */, true /* isForceRunAfter */)
  // )
);

function notify(ch, payload) {
  mainWindow?.webContents.send(ch, payload);
}

autoUpdater.on("checking-for-update", () =>
  notify("updater:status", { state: "checking" })
);

autoUpdater.on("update-available", (info) =>
  notify("updater:status", { state: "available", info })
);

autoUpdater.on("update-not-available", (info) =>
  notify("updater:status", { state: "none", info })
);

autoUpdater.on("error", (err) => {
  log.error("[updater] error:", err);
  notify("updater:status", { state: "error", error: err?.message });
});

autoUpdater.on("download-progress", (p) =>
  notify("updater:progress", { percent: p.percent || 0 })
);

autoUpdater.on("update-downloaded", (info) => {
  notify("updater:status", { state: "downloaded", info });
  // dialog
  //   .showMessageBox(mainWindow, {
  //     type: "question",
  //     buttons: ["Restart now", "Later"],
  //     defaultId: 0,
  //     cancelId: 1,
  //     message: "Update downloaded",
  //     detail: "Restart to install the latest version?",
  //   })
  //   .then(({ response }) => {
  //     if (response === 0) autoUpdater.quitAndInstall(false, true);
  //   });
});

app.on("second-instance", async (_event, argv) => {
  // if (mainWindow) {
  //   if (mainWindow.isMinimized()) {
  //     mainWindow.restore();
  //     mainWindow.focus();
  //   }
  // }

  // If the scheduler launches a second instance while UI is open:

  info("Background [started]");

  if (argv.includes("--run-sync")) {
    info("Background [sync]");

    await startAutoSync(mainWindow);
  } else if (argv.includes("--run-backup")) {
    info("Background [backup]");
    await startAutoBackup(mainWindow);
  }
});

// Global crash logging + auto-email to project@tallydekho.com
// Throttled: max one email per unique error message per day
const _sentErrors = new Map();

async function autoSendCrashLogs(label, details) {
  error(label, details);

  // Throttle: skip if same error sent in last 24h
  const key = String(details?.message || details?.reason || label).slice(0, 120);
  const lastSent = _sentErrors.get(key) || 0;
  if (Date.now() - lastSent < 24 * 60 * 60 * 1000) return;
  _sentErrors.set(key, Date.now());

  try {
    const fs = require("fs");
    const { logPath } = require("./util/logger");
    const infoFile = logPath("info");
    const FormData = require("form-data");
    const { axiosInstance } = require("./util/helper");
    const form = new FormData();
    if (fs.existsSync(infoFile)) form.append("file", fs.createReadStream(infoFile));
    await axiosInstance.post("/desktop/logs", form);
  } catch (_) { /* silent — never crash the crash handler */ }
}

process.on("uncaughtException", (err) => {
  autoSendCrashLogs("uncaughtException", { message: err.message, stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
  autoSendCrashLogs("unhandledRejection", { reason: String(reason) });
});

app.whenReady().then(async () => {
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  store.set("forceUpdate", false);
  const response = await registerDevice();

  // Option B: path-aware TDL install on boot (no Tally restart — sync/Settings Retry activate if needed)
  try {
    const { ensureBillOutstandingTdl } = require("./util/ensureBillOutstandingTdl");
    const tdlResult = await ensureBillOutstandingTdl({ allowRestart: false });
    info("[tdl] boot ensureBillOutstandingTdl", {
      status: tdlResult?.status,
      liveLoaded: tdlResult?.liveLoaded,
      message: tdlResult?.message,
    });
  } catch (e) {
    info("[tdl] boot ensure failed (non-fatal):", e?.message);
  }

  if (!response.status) {
    if (isDev) {
      // In dev mode: log warning and fall through to createWindow() at the bottom
      // Backend may not be running yet or URL may be wrong — don't block development
      info(`[dev] registerDevice failed: ${response.message} — continuing anyway`);
    } else {
      // In production: show retry/quit dialog
      const icon = nativeImage.createFromPath(assetPath("build", "icon.png"));
      const choice = dialog.showMessageBoxSync({
        type: "warning",
        buttons: ["Retry", "Quit"],
        defaultId: 0,
        cancelId: 1,
        title: "Alert!",
        message: response.message,
        noLink: true,
        icon,
      });

      if (choice === 0) {
        const response2 = await registerDevice();
        if (!response2.status) { app.quit(); return; }
      } else {
        app.quit();
        return;
      }
    }
  }

  if (response.status) {
    if (response.forceUpdate) {
      store.set("forceUpdate", true);
    }

    // Version compatibility: level 2 = sync blocked, level 3 = force update
    const vLevel = response.versionLevel || 0;
    store.set("versionLevel", vLevel);
    store.set("versionMessage", response.versionMessage || "");

    if (vLevel === 3) {
      // Force update — block everything
      store.set("forceUpdate", true);
    } else if (vLevel === 2) {
      // Sync blocked — app works, but sync is disabled. Renderer handles this via versionLevel.
      info(`[version] Sync blocked: ${response.versionMessage}`);
    } else if (vLevel === 1) {
      // Non-blocking update available — just log, renderer shows banner
      info(`[version] Update available: ${response.versionMessage}`);
    }
  }

  if (isHeadless) {
    try {
      // If no instance was running, this one is primary—do headless backup and exit (used by Task Scheduler)
      //   run backup and exit
      info("Headless [started]");
      if (isHeadlessSync) {
        info("Headless [sync]");
        await startAutoSyncHeadless();
      } else if (isHeadlessBackup) {
        info("Headless [backup]");
        await startAutoBackupHeadless();
      }
    } catch (err) {
      error("Headless [error]", err);
    } finally {
      app.quit();
    }
    return;
  }

  info(`App Started`);

  createWindow();

  // if (app.isPackaged) {
  //   setTimeout(() => {
  //     autoUpdater.checkForUpdates().catch((err) => {
  //       info("[updater] first check failed:", err?.message);
  //     });
  //   }, 3000);
  // }

  const socket = ioClient(baseURL, {
    // Polling first — Electron websocket-only often times out on LAN/VPN; upgrade when possible
    transports: ["polling", "websocket"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    autoConnect: true,
    timeout: 20000,
    pingInterval: 25000, // default 25000 ms
    pingTimeout: 60000, // increase from default ~ 5000-20000 to 60s
  });
  info(`[socket] connecting to ${baseURL}`);

  require("./util/socket")(mainWindow, socket);

  // Main process owns the pairing session lifecycle; the renderer only displays it.
  initPairingRuntime(mainWindow);
  reconcileBinding("startup").then((result) => {
    if (result.paired) reconcilePendingWriteback("startup");
  });

  // ── Heartbeat: keep last_seen fresh so mobile can detect desktop online status
  // Lightweight — just updates a timestamp in DB. A heartbeat failure never
  // clears pairing; only an authoritative backend response can do that.
  const { axiosInstance } = require("./util/helper");
  const sendHeartbeat = async () => {
    try {
      await axiosInstance.post("/desktop/heartbeat");
    } catch (_) { /* silently ignore — will retry next tick */ }
  };

  sendHeartbeat();
  const heartbeatInterval = setInterval(sendHeartbeat, 2 * 60 * 1000);

  // Suspended timers cannot be trusted to have fired: on wake, re-check the
  // pairing session against wall-clock time and refresh presence immediately.
  powerMonitor.on("resume", () => {
    info("[power] resume");
    sendHeartbeat();
    handleResume("power-resume");
    reconcileBinding("power-resume").then((result) => {
      if (result.paired) reconcilePendingWriteback("power-resume");
    });
  });

  // Clear on quit
  app.once("before-quit", () => clearInterval(heartbeatInterval));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// process.on("exit", (code) => console.log("process exit", code));
// app.on("quit", (_e, code) => console.log("app quit", code));

app.on("before-quit", () => {
  quittingByWatcherOrSignal = true;
  store.set("isSyncing", false);
  store.set("isRestoring", false);
  store.set("isBackingUp", false);
});

process.on("uncaughtException", (e) => {
  info("UNCAUGHT [error]", e);
});
process.on("unhandledRejection", (e) => {
  info("UNHANDLED [error]", e);
});

// process.on("SIGINT", () => {
//   console.log("SIGINT");
// });
// process.on("SIGTERM", () => {
//   console.log("SIGTERM");
// });
