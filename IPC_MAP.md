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
| api.getPref(key) | store:get | main.js | Allowlisted preference read |
| api.setPref(key, val) | store:set | main.js | Allowlisted preference write |
| api.listener(cb) | window:listener | main.js | Event listener setup |
| api.closeByName(name) | window:closeByName | main.js | Close named window |
| api.pairingState() | api:pairing_state | ipcRegistry.js | Display-safe pairing snapshot (no claimToken) |
| api.pairedDevice() | api:paired_device | ipcRegistry.js | Returns paired device info |
| api.removePairedDevice() | api:remove_paired_device | ipcRegistry.js | Unpairing |
| api.pingBackend() | backend:ping | main.js | Backend connectivity check |
| api.sendLogs() | api:send_logs | ipcRegistry.js | Send diagnostic logs |
| api.userProfile() | api:user_profile | ipcRegistry.js | Fetch display profile from backend |
| api.aiChat(payload) | api:ai_chat | ipcRegistry.js | AI chat relay |

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
| tally.restoreProgress(cb) | tally:restore_progress | Restore progress events |
| tally.saveAutoBackup(args) | tally:save_auto_backup | Auto-backup schedule |
| tally.hardSyncStatus(id) | tally:hard_sync_status | Poll Hard Sync approval |
| tally.backupList() | tally:backup_list | Latest 3 cloud backups |
| tally.restoreRequest() | tally:restore_request | New-PC restore code |
| tally.restoreStatus() | tally:restore_status | Poll restore approval |
| tally.restoreCloud() | tally:restore_cloud | Download + verify + restore |

## window.backup.* (Backup)
| Renderer Call | IPC Channel | Notes |
|---------------|-------------|-------|
| backup.chooseDir() | backup:chooseDir | Directory picker |
| backup.getDir() | backup:getDir | Get saved backup dir |

## Auto-Updater Events (main → renderer via window:listener)
| Event | Payload | Notes |
|-------|---------|-------|
| checking-for-update | — | Update check started |
| update-available | {info} | New version found |
| update-not-available | {info} | Already on latest |
| update-downloaded | {info} | Ready to install |
| download-progress | {percent, ...} | Download progress |

## Key Rules
- `util/ipcRegistry.js` is required once from `main.js` (do not require it twice)
- Pairing sessions are owned by the main process (`util/pairingLifecycle.js`)
- Renderer must only call via `window.api.*` / `window.tally.*` (contextBridge) — never ipcRenderer directly
- store:get / store:set are allowlisted; secrets and binding keys are not exposed
