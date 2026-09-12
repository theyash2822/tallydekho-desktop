# IPC_MAP.md — td-source/desktop

IPC handlers defined in `main.js` (NOT ipcRegistry.js — that file is NOT required).
Renderer calls via contextBridge: `window.api.*`, `window.tally.*`, `window.backup.*`
Defined in `preload.js`.

## window.api.* (General App)
| Renderer Call | IPC Channel | Handler Location | Notes |
|---------------|-------------|------------------|-------|
| api.minimize() | window:minimize | main.js | Minimizes window |
| api.close() | window:close | main.js | Closes app |
| api.pickFiles(opts) | dialog:openFile | main.js | File picker dialog |
| api.openExternal() | openExternal | main.js | Opens external URL |
| api.getPref(key) | store:get | main.js | electron-store get |
| api.setPref(key, val) | store:set | main.js | electron-store set |
| api.listener(cb) | window:listener | main.js | Event listener setup |
| api.closeByName(name) | window:closeByName | main.js | Close named window |
| api.pairingCode() | api:pairing_code | ipcRegistry.js | Returns current pairing code |
| api.pairedDevice() | api:paired_device | ipcRegistry.js | Returns paired device info |
| api.removePairedDevice() | api:remove_paired_device | ipcRegistry.js | Unpairing |
| api.pingBackend() | backend:ping | main.js | Backend connectivity check |
| api.sendLogs() | api:send_logs | ipcRegistry.js | Send diagnostic logs |
| api.userProfile() | api:user_profile | ipcRegistry.js | Fetch user profile from backend |
| api.aiChat(payload) | api:ai_chat | ipcRegistry.js | AI chat relay |
| api.sendAttachment(p) | api:ai_attachment | ipcRegistry.js | AI attachment relay |

## window.tally.* (Tally Integration)
| Renderer Call | IPC Channel | Notes |
|---------------|-------------|-------|
| tally.version() | tally:version | Reads version from Windows registry |
| tally.connected() | tally:connected | Checks Tally HTTP on localhost:9000 |
| tally.companies() | tally:companies | Fetches company list from Tally |
| tally.tdlHealth() | tally:tdl_health | Bill Outstanding TDL health (disk + live probe) |
| tally.tdlSetup(dir?) | tally:tdl_setup | Copy TDL + quoted tally.ini; restart Tally with /TDL if not live |
| tally.tdlSelectPath() | tally:tdl_select_path | Folder dialog then setup+activate; returns {cancelled\|health} |
| tally.startSync(args) | tally:start_sync | Triggers full Tally sync |
| tally.syncProgress(cb) | tally:sync_progress | Event listener for sync progress |
| tally.stopSync(args) | tally:stop_sync | Stops ongoing sync |
| tally.saveAutoSync(args) | tally:save_auto_sync | Saves auto-sync schedule |
| tally.deleteAutoSync() | tally:delete_auto_sync | Removes auto-sync |
| tally.startBackup() | tally:start_backup | Triggers backup |
| tally.backupProgress(cb) | tally:backup_progress | Backup progress events |
| tally.startRestore(args) | tally:restore_backup | Triggers restore |
| tally.restoreProgress(cb) | tally:restore_progress | Restore progress events |
| tally.saveAutoBackup(args) | tally:save_auto_backup | Auto-backup schedule |
| tally.hardSyncStatus(id) | tally:hard_sync_status | Poll Hard Sync approval |
| tally.backupList() | tally:backup_list | Latest 3 cloud backups |
| tally.restoreRequest() | tally:restore_request | New-PC restore code |
| tally.restoreStatus() | tally:restore_status | Poll restore approval |
| tally.restoreCloud() | tally:restore_cloud | Download + verify + restore |
| tally.resetRequest() | tally:reset_request | Start Owner Reset for New Tally |
| tally.resetStatus() | tally:reset_status | Poll pending reset |

## window.backup.* (Backup)
| Renderer Call | IPC Channel | Notes |
|---------------|-------------|-------|
| backup.chooseDir() | backup:chooseDir | Directory picker |
| backup.getDir() | backup:getDir | Get saved backup dir |
| backup.runBackup(payload) | backup:run | Execute backup |

## Auto-Updater Events (main → renderer via window:listener)
| Event | Payload | Notes |
|-------|---------|-------|
| checking-for-update | — | Update check started |
| update-available | {info} | New version found |
| update-not-available | {info} | Already on latest |
| update-downloaded | {info} | Ready to install |
| download-progress | {percent, ...} | Download progress |

## Key Rules
- ⚠️ `util/ipcRegistry.js` is NOT required from `main.js` — it was causing double-require crashes
- All active IPC handlers are in `main.js` directly
- Never add a new `ipcMain.handle()` to ipcRegistry.js — add to main.js only
- Renderer must only call via `window.api.*` / `window.tally.*` (contextBridge) — never ipcRenderer directly
