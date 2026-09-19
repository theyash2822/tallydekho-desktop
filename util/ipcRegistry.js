const { ipcMain } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs").promises;
const FormData = require("form-data");
const fsSync = require("fs");

const {
  isTallyOpen,
  isOnlineHandler,
  diffDays,
  axiosInstance,
  pollJobStatus,
} = require("./helper.js");
const {
  getCompanyDestinations,
  getCompanies,
  syncTallyData,
  stopTallySyncHandler,
} = require("./xml.js");
const getTallyVersionFromRegistry = require("./readTallyFromRegistry.js");
const {
  recreateBackupTaskCurrentUser,
  deleteTaskIfExists,
  createTaskEveryMinuteCurrentUser,
} = require("./backgroundRunner.js");
const store = require("./store.js");
const { info, error, logPath } = require("./logger.js");
const { startBackup } = require("./saveBackup.js");
const { getSelectedCompanies } = require("./companySelection.js");
const { getDeviceSecret } = require("./deviceCredential.js");

let tallyConnectStatus = false;

/**
 * A device with no stored credential cannot be paired, so background work is
 * skipped without a round trip. The backend remains the final authority.
 */
const isDevicePaired = () => !!getDeviceSecret();

/** Log company identity only — never addresses, contacts or GST numbers. */
const describeCompanies = (companies = []) =>
  `${companies.length} selected [${companies
    .map((c) => c?.guid || c?.id || "?")
    .join(", ")}]`;

const isTallyConnected = async () => {
  const status = await isTallyOpen();

  if (status) {
    const destination = await getCompanyDestinations();
    // console.dir(destination, {
    //   depth: null,
    //   colors: true,
    //   maxArrayLength: null,
    // });

    if (Object.keys(destination).length == 0) {
      return false;
    }
    const firstDestination = Object.values(destination)[0];
    const split = firstDestination.split("\\");
    split.pop();
    store.set("destination", split.join("\\\\"));
    return true;
  }
  return false;
};

ipcMain.handle("tally:version", async () => {
  let version;

  try {
    version = await getTallyVersionFromRegistry();
  } catch (err) {
    return "Not Found";
  }

  if (version.error) {
    return "Not Found";
  }

  return version.registryKey || `${version.product} ${version.displayVersion}`;
});

ipcMain.handle("tally:tdl_health", async () => {
  try {
    const { getTdlHealth } = require("./ensureBillOutstandingTdl");
    return await getTdlHealth();
  } catch (e) {
    error(e?.message || String(e), "tally:tdl_health");
    return {
      status: "blocked",
      level: "danger",
      message: e?.message || "TDL health check failed",
      missing: [e?.message || "unknown error"],
    };
  }
});

ipcMain.handle("tally:tdl_setup", async (_event, optionalDir) => {
  try {
    const { setupTdl } = require("./ensureBillOutstandingTdl");
    // allowRestart: activate via official /TDL restart if live probe fails (no manual F1)
    return await setupTdl(optionalDir || null, { allowRestart: true });
  } catch (e) {
    error(e?.message || String(e), "tally:tdl_setup");
    return {
      status: "blocked",
      level: "danger",
      message: e?.message || "TDL setup failed",
      missing: [e?.message || "unknown error"],
    };
  }
});

ipcMain.handle("tally:tdl_select_path", async () => {
  try {
    const { dialog } = require("electron");
    const { BrowserWindow } = require("electron");
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      title: "Select Tally Prime folder",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return { status: false, cancelled: true };
    }
    const { setupTdl } = require("./ensureBillOutstandingTdl");
    const health = await setupTdl(result.filePaths[0], { allowRestart: true });
    return { status: true, health };
  } catch (e) {
    error(e?.message || String(e), "tally:tdl_select_path");
    return { status: false, message: e?.message || String(e) };
  }
});

ipcMain.handle("tally:connected", async () => {
  const status = await isTallyConnected();

  tallyConnectStatus = status;

  return status;
});

ipcMain.handle("tally:companies", async () => {
  // const status = await isTallyConnected();

  // if (!status) {
  //   return [];
  // }

  if (!tallyConnectStatus) {
    return [];
  }

  const companies = await getCompanies();
  return companies;
});

ipcMain.handle("tally:stop_sync", async (event, code) => {
  stopTallySyncHandler(code);
  store.set("isSyncing", false);
});

ipcMain.handle(
  "tally:save_auto_sync",
  async (event, { syncInterval, autoSyncStartedAt }) => {
    store.set("isAutoSync", true);
    store.set("syncInterval", Number(syncInterval));
    store.set("autoSyncStartedAt", Number(autoSyncStartedAt));
    try {
      await recreateBackupTaskCurrentUser(
        "TallyDekhoAutoSync",
        "\\",
        "sync",
        syncInterval
      );
    } catch (err) {}
  }
);

ipcMain.handle("tally:delete_auto_sync", async (event) => {
  store.set("isAutoSync", false);
  try {
    await deleteTaskIfExists("TallyDekhoAutoSync", "\\");
  } catch (err) {}
});

const registerTallySync = (windowContent) => {
  let syncStartInFlight = false;

  ipcMain.handle(
    "tally:start_sync",
    async (event, { companies, isHardSync }) => {
      info("Foreground [sync]");

      // Single-flight: reject a second start while one sync (or start sequence) is active.
      if (store.get("isSyncing") || syncStartInFlight) {
        return {
          status: false,
          code: "HARD_SYNC_IN_FLIGHT",
          message: "A sync is already in progress on this Desktop.",
        };
      }
      syncStartInFlight = true;

      try {
      if (!isDevicePaired()) {
        return {
          status: false,
          code: "DEVICE_NOT_PAIRED",
          message: "This Desktop is not paired to a workspace.",
        };
      }

      const status = await isTallyConnected();

      info(`Foreground [tally status]: ${status}`);

      if (!status) {
        return { status: false, code: "tally_not_connected" };
      }

      // Version check: block sync if versionLevel >= 2
      const versionLevel = store.get("versionLevel") || 0;
      if (versionLevel >= 2) {
        return { status: false, code: "version_blocked", message: store.get("versionMessage") || "Update required to sync" };
      }

      // Multi-device conflict check: if another device synced this company more recently, warn
      // Uses /desktop/company-sync-status (desktopAuth — device-id only, no JWT required)
      if (!isHardSync && companies?.length > 0) {
        try {
          const firstCompany = companies[0];
          const companyGuid = firstCompany?.guid || firstCompany?.id;
          if (companyGuid) {
            const syncInfo = await axiosInstance
              .get(`/desktop/company-sync-status?companyGuid=${encodeURIComponent(companyGuid)}`)
              .catch(() => null);

            const { lastSyncedAt, isMyDevice } = syncInfo?.data?.data || {};
            const myLastSyncEpoch = store.get('myLastSyncEpoch') || 0;

            // If server shows a sync from a DIFFERENT device more recent than our last sync
            if (lastSyncedAt && !isMyDevice && lastSyncedAt > myLastSyncEpoch + 60) {
              const { dialog } = require('electron');
              const choice = dialog.showMessageBoxSync({
                type: 'question',
                buttons: ['Force Sync Anyway', 'Cancel'],
                defaultId: 1,
                title: 'Another device synced recently',
                message: `A different desktop synced "${firstCompany?.name || companyGuid}" more recently.\n\nSyncing now may overwrite newer data. Proceed?`,
              });
              if (choice === 1) {
                return { status: false, code: 'cancelled_by_user' };
              }
            }
          }
        } catch (_) { /* non-critical — never block sync due to this check */ }
      }

      if (isHardSync) {
        try {
          const reqRes = await axiosInstance.post("/desktop/hard-sync/request", {
            operation: "REBUILD",
            companies: (companies || []).map((c) => ({ guid: c.guid || c.id, name: c.name })),
          });
          const hs = reqRes.data?.data;
          if (!reqRes.data?.status) {
            return { status: false, code: reqRes.data?.code, message: reqRes.data?.message };
          }
          if (hs.requestStatus === "PENDING") {
            return {
              status: false,
              code: "HARD_SYNC_APPROVAL_REQUIRED",
              message: "Waiting for Owner/Admin approval",
              data: { requestId: hs.requestId },
            };
          }
          if (hs.requestStatus === "REJECTED") {
            return {
              status: false,
              code: "HARD_SYNC_REJECTED",
              message: "Hard Sync was rejected by Owner/Admin.",
              data: { requestId: hs.requestId },
            };
          }
          if (hs.requestStatus === "EXPIRED") {
            return {
              status: false,
              code: "HARD_SYNC_EXPIRED",
              message: "Hard Sync request expired. Request approval again.",
              data: { requestId: hs.requestId },
            };
          }
          // APPROVED / alreadyApproved: continue once under the in-flight gate.
          // alreadyApproved is not free re-entry — gate rejects concurrent starts.
        } catch (err) {
          const body = err?.response?.data;
          return {
            status: false,
            code: body?.code || "HARD_SYNC_APPROVAL_REQUIRED",
            message: body?.message || err.message,
          };
        }
      }

      // Claim the in-flight slot before awaiting sync work.
      store.set("isSyncing", true);
      store.set("syncMode", isHardSync ? "hard" : "normal");

      info(`Foreground [companies]: ${describeCompanies(companies)}`);

      let syncStatus;
      try {
        syncStatus = await syncTallyData(
          windowContent,
          companies,
          isHardSync
        );
      } finally {
        store.set("isSyncing", false);
      }

      info(`Foreground [sync status]: ${syncStatus.status}`);
      info(`Foreground [sync status data]:`, syncStatus.data);

      windowContent.send("window:listener", { key: "isSyncing", value: false });
      windowContent.send("window:listener", { key: "syncProgress", value: 0 });
      if (syncStatus.status) {
        windowContent.send("window:listener", { key: "syncMessage", value: "Sync Complete" });
        windowContent.send("window:listener", { key: "lastSync", value: new Date() });
        // Update epoch so next conflict check knows when we last synced
        store.set('myLastSyncEpoch', Math.floor(Date.now() / 1000));
      }

      if (!syncStatus.status) {
        windowContent.send("window:listener", {
          key: "syncingCurrentStatus",
          value: syncStatus.data,
        });
      }

      return {
        ...syncStatus,
        code: syncStatus.code || syncStatus.data?.code,
        message: syncStatus.message || syncStatus.data?.message,
      };
      } finally {
        syncStartInFlight = false;
      }
    }
  );
};

const startAutoSync = async (windowContent) => {
  // We can tell react to start manual sync also

  if (!isDevicePaired()) {
    info("Background [sync skipped]: device not paired");
    return;
  }

  const status = await isTallyConnected();
  const isOnline = store.get("isOnline");
  const isSyncing = store.get("isSyncing");

  info(`Background [tally status]: ${status}`);
  info(`Background [online status]: ${isOnline}`);
  info(`Background [sync status before starting]: ${isSyncing}`);

  if (status && isOnline && !isSyncing) {
    windowContent.send("window:listener", {
      key: "isSyncing",
      value: true,
    });
    store.set("isSyncing", true);

    const companies = getSelectedCompanies();

    info(`Background [companies]: ${describeCompanies(companies)}`);

    const syncStatus = await syncTallyData(windowContent, companies);

    info(`Background [sync status]: ${syncStatus.status}`);
    info(`Background [sync status data]:`, syncStatus.data);

    store.set("isSyncing", false);
    windowContent.send("window:listener", { key: "isSyncing", value: false });
    windowContent.send("window:listener", { key: "syncProgress", value: 0 });
    if (syncStatus.status) {
      const date = new Date();
      store.set("lastSync", date);
      windowContent.send("window:listener", { key: "lastSync", value: date });
      windowContent.send("window:listener", { key: "syncMessage", value: "Sync Complete" });
    }

    if (!syncStatus.status) {
      windowContent.send("window:listener", {
        key: "syncingCurrentStatus",
        value: syncStatus.data,
      });
    }
  }
};

const startAutoSyncHeadless = async () => {
  if (!isDevicePaired()) {
    info("Headless [sync skipped]: device not paired");
    return;
  }

  const status = await isTallyConnected();

  info(`Headless [tally status]: ${status}`);

  if (status) {
    const isOnline = await isOnlineHandler();

    info(`Headless [online status]: ${isOnline}`);

    if (!isOnline) {
      // const nextSync = new Date(
      //   Date.now() + store.get("syncInterval") * 60 * 1000
      // );
      // store.set("nextSync", nextSync);
      return;
    }

    const companies = getSelectedCompanies();

    info(`Headless [companies]: ${describeCompanies(companies)}`);

    const syncStatus = await syncTallyData(
      { isDestroyed: () => true },
      companies
    );

    info(`Headless [sync status]: ${syncStatus.status}`);
    info(`Headless [sync status data]:`, syncStatus.data);

    // if (syncStatus.status) {
    //   const date = new Date();
    //   store.set("lastSync", date);
    // }

    if (syncStatus.status) {
      const promise = pollJobStatus({
        url: `/ingest/status/${syncStatus.data.uploadId}`,
        fetchOptions: {
          method: "GET",
        },
      });

      try {
        const { status, attempts, message } = await promise;
        if (status) {
          const date = new Date();
          store.set("lastSync", date);
        }
        info(
          `Status: ${status} | Upload Id: ${syncStatus.data.uploadId} | Attempts: ${attempts} | Message: ${message}`
        );
      } catch (err) {
        info("Polling failed:", err.message);
      } finally {
        store.set("uploadId", "none");
      }
    }
  }

  return true;
};

ipcMain.handle(
  "tally:save_auto_backup",
  async (event, { backupInterval, autoBackupStartedAt }) => {
    store.set("backupInterval", backupInterval);

    const days =
      {
        off: 0,
        "1day": 1,
        "7days": 7,
        "1month": 30,
      }[backupInterval] || 0;

    if (days > 0) {
      store.set("autoBackupStartedAt", autoBackupStartedAt);

      try {
        await recreateBackupTaskCurrentUser(
          "TallyDekhoAutoBackup",
          "\\",
          "backup",
          0,
          days
        );
      } catch (err) {}
    } else {
      await deleteTaskIfExists("TallyDekhoAutoBackup", "\\");
    }
  }
);

const startAutoBackup = async (windowContent) => {
  const isBackingUp = store.get("isBackingUp");

  info(`Background [backup status before starting]: ${isBackingUp}`);

  if (isBackingUp) {
    return;
  }

  const response = await startBackup(windowContent);

  info(
    `Background [backup status: ${response.status} | message:  ${response.message}]`
  );
};

const startAutoBackupHeadless = async () => {
  const isOnline = await isOnlineHandler();

  info(`Headless [online status]: ${isOnline}`);

  if (!isOnline) {
    return;
  }

  const response = await startBackup({
    isDestroyed: () => true,
    send: () => {},
  });

  info(
    `Headless [backup status: ${response.status} | message:  ${response.message}]`
  );

  return true;
};

(async () => {
  const backupInterval = store.get("backupInterval");
  if (["7days", "1month"].includes(backupInterval)) {
    const daysDifference = diffDays(
      Date.now(),
      store.get("autoBackupStartedAt")
    );

    if (
      (backupInterval == "7days" && daysDifference > 8) ||
      (backupInterval == "1month" && daysDifference > 31)
    ) {
      info(`Background [missed backup started]`);
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Start-ScheduledTask -TaskName 'TallyDekhoAutoBackup'",
        ],
        { windowsHide: true },
        () => {}
      );
    }
  }
})();

/**
 * Read-only snapshot for renderer hydration on mount. The main process owns
 * the pairing session; the renderer never triggers a mint and never sees the
 * claim token.
 */
ipcMain.handle("api:pairing_state", async () => {
  const { getStatus } = require("./pairingLifecycle");
  const status = getStatus();
  return {
    status: true,
    data: {
      pairingCode: status.pairingCode,
      expiresAt: status.expiresAt,
      running: status.running,
    },
  };
});

ipcMain.handle("api:paired_device", async () => {
  try {
    const response = await axiosInstance.get("/desktop/pairing-device");
    const { mapPairedDevice } = require("./pairingRuntime");
    return { status: true, data: mapPairedDevice(response.data?.data?.pairing) };
  } catch (err) {
    error(err?.message, "paired_device");
    return { status: false };
  }
});

ipcMain.handle("api:remove_paired_device", async () => {
  let response;

  try {
    response = await axiosInstance.delete("/desktop/paired-device");
    response = response.data;
  } catch (err) {
    error(err?.message, "remove_paired_device");
    return { status: false };
  }

  const { clearDeviceSecret } = require("./deviceCredential");
  clearDeviceSecret();
  try {
    require("./pairingSessionState").clearPairingSession();
    store.delete("workspace");
  } catch (_) {}

  // Actual unpair: drop the workspace binding and its company selection, then
  // start a fresh pairing session automatically.
  await require("./pairingRuntime").handleUnpaired("unpair");

  return {
    status: true,
  };
});

// AI Chat — canonical POST /api/ai/help (legacy /app/ai/chat never existed on server)
ipcMain.handle("api:ai_chat", async (event, { messages }) => {
  try {
    const history = Array.isArray(messages) ? messages.slice(0, -1) : [];
    const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
    const message = last?.content || last?.text || '';
    const response = await axiosInstance.post("/api/ai/help", { message, history });
    return response.data?.data?.reply || response.data?.reply || response.data?.data?.answer || 'No response.';
  } catch (err) {
    error(err?.message, "api:ai_chat");
    return 'Could not connect to AI assistant. Make sure the backend is running.';
  }
});

// Fetch real user profile from backend via device-id (no token needed)
ipcMain.handle("api:user_profile", async () => {
  try {
    const response = await axiosInstance.get("/desktop/me");
    return { status: true, data: response.data?.data || null };
  } catch (err) {
    error(err?.message, "api:user_profile");
    return { status: false };
  }
});

ipcMain.handle("tally:hard_sync_status", async (_e, requestId) => {
  const response = await axiosInstance.get("/desktop/hard-sync/status", { params: { requestId } });
  return response.data;
});

ipcMain.handle("tally:backup_list", async () => {
  const response = await axiosInstance.get("/desktop/backup/list");
  return response.data;
});

ipcMain.handle("api:send_logs", async () => {
  const infoFile = logPath("info");

  const form = new FormData();
  form.append("file", fsSync.createReadStream(infoFile));

  // const headers = form.getHeaders();

  let response;

  try {
    response = await axiosInstance.post("/desktop/logs", form);

    await fs.truncate(infoFile, 0);
  } catch (err) {
    error("send_logs", { message: err?.message, data: err.response?.data });
    return { status: false };
  }

  return { status: true };
});

// (() => {
//   const path = require("path");
//   const fs = require("fs");

//   let yaml = "";

//   yaml += "provider: generic\n";
//   yaml += "url: your_site/update/windows_64\n";
//   yaml += "useMultipleRangeRequest: false\n";
//   yaml += "channel: latest\n";
//   yaml += "updaterCacheDirName: " + app.getName();

//   let update_file = [path.join(process.resourcesPath, "app-update.yml"), yaml];
//   let dev_update_file = [
//     path.join(process.resourcesPath, "dev-app-update.yml"),
//     yaml,
//   ];
//   let chechFiles = [update_file, dev_update_file];

//   for (let file of chechFiles) {
//     if (!fs.existsSync(file[0])) {
//       fs.writeFileSync(file[0], file[1], () => {});
//     }
//   }
// })();

module.exports = {
  registerTallySync,
  startAutoSync,
  startAutoSyncHeadless,
  startAutoBackup,
  startAutoBackupHeadless,
};
