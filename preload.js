const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  close: () => ipcRenderer.invoke("window:close"),
  pickFiles: (options) => ipcRenderer.invoke("dialog:openFile", options ?? {}),
  openExternal: () => ipcRenderer.invoke("openExternal"),
  getPref: (key) => ipcRenderer.invoke("store:get", key),
  setPref: (key, value) => ipcRenderer.invoke("store:set", key, value),
  listener: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("window:listener", handler);
    return () => ipcRenderer.removeListener("window:listener", handler);
  },
  closeByName: (name, opts) =>
    ipcRenderer.invoke("window:closeByName", name, opts),
  pairingCode: () => ipcRenderer.invoke("api:pairing_code"),
  pairedDevice: () => ipcRenderer.invoke("api:paired_device"),
  removePairedDevice: () => ipcRenderer.invoke("api:remove_paired_device"),
  pingBackend: () => ipcRenderer.invoke("backend:ping"),
  sendLogs: () => ipcRenderer.invoke("api:send_logs"),
  userProfile: () => ipcRenderer.invoke("api:user_profile"),
  aiChat: (payload) => ipcRenderer.invoke("api:ai_chat", payload),
  sendAttachment: (payload) => ipcRenderer.invoke("api:ai_attachment", payload),
});

contextBridge.exposeInMainWorld("tally", {
  version: () => ipcRenderer.invoke("tally:version"),
  connected: () => ipcRenderer.invoke("tally:connected"),
  companies: () => ipcRenderer.invoke("tally:companies"),
  startSync: (args) => ipcRenderer.invoke("tally:start_sync", args),
  syncProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("tally:sync_progress", handler);
    return () => ipcRenderer.removeListener("tally:sync_progress", handler);
  },
  stopSync: (args) => ipcRenderer.invoke("tally:stop_sync", args),
  saveAutoSync: (args) => ipcRenderer.invoke("tally:save_auto_sync", args),
  deleteAutoSync: () => ipcRenderer.invoke("tally:delete_auto_sync"),
  startBackup: () => ipcRenderer.invoke("tally:start_backup"),
  backupProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("tally:backup_progress", handler);
    return () => ipcRenderer.removeListener("tally:backup_progress", handler);
  },
  startRestore: (args) => ipcRenderer.invoke("tally:restore_backup", args),
  restoreProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("tally:restore_progress", handler);
    return () => ipcRenderer.removeListener("tally:restore_progress", handler);
  },
  saveAutoBackup: (args) => ipcRenderer.invoke("tally:save_auto_backup", args),
});

contextBridge.exposeInMainWorld("backup", {
  chooseDir: () => ipcRenderer.invoke("backup:chooseDir"),
  getDir: () => ipcRenderer.invoke("backup:getDir"),
  runBackup: (payload) => ipcRenderer.invoke("backup:run", payload),
});

contextBridge.exposeInMainWorld("updater", {
  check: () => ipcRenderer.invoke("updater:check"),
  download: () => ipcRenderer.invoke("updater:download"),
  quitAndInstall: () => ipcRenderer.invoke("updater:quitAndInstall"),
  onStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("updater:status", handler);
    return () => ipcRenderer.removeListener("updater:status", handler);
  },
  onProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("updater:progress", handler);
    return () => ipcRenderer.removeListener("updater:progress", handler);
  },
});
