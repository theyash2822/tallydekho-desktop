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

let tallyConnectStatus = false;

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
  ipcMain.handle(
    "tally:start_sync",
    async (event, { companies, isHardSync }) => {
      info("Foreground [sync]");

      const status = await isTallyConnected();

      info(`Foreground [tally status]: ${status}`);

      if (!status) {
        return { status: false, code: "tally_not_connected" };
      }

      store.set("isSyncing", true);
      store.set("syncMode", isHardSync ? "hard" : "normal");

      info(`Foreground [companies]`, companies);

      const syncStatus = await syncTallyData(
        windowContent,
        companies,
        isHardSync
      );

      info(`Foreground [sync status]: ${syncStatus.status}`);
      info(`Foreground [sync status data]:`, syncStatus.data);

      store.set("isSyncing", false);
      windowContent.send("window:listener", { key: "isSyncing", value: false });
      windowContent.send("window:listener", { key: "syncProgress", value: 0 });
      if (syncStatus.status) {
        windowContent.send("window:listener", { key: "syncMessage", value: "Sync Complete" });
        windowContent.send("window:listener", { key: "lastSync", value: new Date() });
      }

      if (!syncStatus.status) {
        windowContent.send("window:listener", {
          key: "syncingCurrentStatus",
          value: syncStatus.data,
        });
      }

      return syncStatus;
    }
  );
};

const startAutoSync = async (windowContent) => {
  // We can tell react to start manual sync also

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

    const companies = store.get("selectedCompanies");

    info(`Background [companies]`, companies);

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

    const companies = store.get("selectedCompanies");

    info(`Headless [companies]`, companies);

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

ipcMain.handle("api:pairing_code", async () => {
  let response;

  try {
    response = await axiosInstance.get("/desktop/pairing-code");
    response = response.data;
  } catch (err) {
    error(err?.message, "pairing_code");
    return { status: false };
  }

  return {
    status: true,
    data: response.data,
  };
});

ipcMain.handle("api:paired_device", async () => {
  let response;

  try {
    response = await axiosInstance.get("/desktop/pairing-device");
    response = response.data;
  } catch (err) {
    error(err?.message, "paired_device");
    return { status: false };
  }

  if (!response.data?.pairing) {
    return { status: true, data: null };
  }

  response = response.data.pairing;

  return {
    status: true,
    data: {
      name: `${response.MANUFACTURER} - ${response.MODEL}`,
      os: response.IS_ANDROID ? "Android" : "iOS",
      last: response.LAST_SYNC_AT,
    },
  };
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

  return {
    status: true,
  };
});

// Send attachment to project@tallydekho.com via backend
ipcMain.handle("api:ai_attachment", async (event, { filePath, fileName }) => {
  try {
    const fileData = fsSync.readFileSync(filePath).toString('base64');
    const ext = fileName.split('.').pop().toLowerCase();
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', pdf: 'application/pdf' };
    const fileType = mimeMap[ext] || 'application/octet-stream';
    const response = await axiosInstance.post('/app/ai/attachment', { fileName, fileData: `data:${fileType};base64,${fileData}`, fileType });
    return response.data?.status ? true : false;
  } catch (err) {
    error(err?.message, 'api:ai_attachment');
    return false;
  }
});

// AI Chat - proxies to backend /app/ai/chat
ipcMain.handle("api:ai_chat", async (event, { messages }) => {
  try {
    const response = await axiosInstance.post("/app/ai/chat", { messages });
    return response.data?.data?.reply || 'No response.';
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
