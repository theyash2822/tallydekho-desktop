/**
 * Renderer preference IPC allowlist.
 *
 * Secrets, device credentials and the workspace binding stay in the main
 * process. Anything not listed here is refused by store:get / store:set.
 */
const RENDERER_READABLE_PREFS = new Set([
  "appVersion",
  "autoBackupStartedAt",
  "autoSyncStartedAt",
  "backupAndRestoreActivity",
  "backupInterval",
  "backups",
  "forceUpdate",
  "isAutoSync",
  "lastSync",
  "port",
  "selectedCompanies",
  "syncInterval",
  "syncMode",
  "versionLevel",
  "versionMessage",
]);

const RENDERER_WRITABLE_PREFS = new Set([
  "isOnline",
  "isSyncing",
  "lastSync",
  "port",
  "selectedCompanies",
]);

const RENDERER_FORBIDDEN_PREFS = [
  "deviceSecret",
  "deviceSecretEnc",
  "boundWorkspaceId",
  "selectedCompaniesWorkspaceId",
  "workspace",
  "pairingCode",
  "claimToken",
  "sessionId",
];

function canRendererRead(key) {
  return RENDERER_READABLE_PREFS.has(key);
}

function canRendererWrite(key) {
  return RENDERER_WRITABLE_PREFS.has(key);
}

module.exports = {
  RENDERER_READABLE_PREFS,
  RENDERER_WRITABLE_PREFS,
  RENDERER_FORBIDDEN_PREFS,
  canRendererRead,
  canRendererWrite,
};
