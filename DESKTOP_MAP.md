# DESKTOP_MAP.md — td-source/desktop

## Root Files
| File | Purpose |
|------|---------|
| main.js | Electron main process. Window creation, IPC handlers, auto-updater |
| preload.js | Context bridge — exposes window.api, window.tally, window.backup |
| package.json | Electron + build config |
| .env | Backend URL, API keys |

## util/ (Main Process Helpers)
| File | Purpose |
|------|---------|
| helper.js | axiosInstance (backend HTTP), isTallyOpen(), isOnlineHandler(), pollJobStatus() |
| xml.js | getCompanies(), syncTallyData(), stopTallySyncHandler(), getCompanyDestinations() |
| tallyHelper.js | XML parser, data normalizer, Tally XML → JS object conversion |
| socket.js | Socket.io client — connects to backend, emits sync events |
| store.js | electron-store wrapper — get/set persistent preferences |
| logger.js | File logger — info(), error(), logPath() |
| ipcRegistry.js | IPC handler definitions (NOT required in main.js — reference only) |
| backgroundRunner.js | Windows Task Scheduler — auto-sync scheduling |
| saveBackup.js | Save Tally data backup |
| restoreBackup.js | Restore from backup |
| backup.js | Backup orchestration |
| deviceProfile.js | Device fingerprint generation |
| validateSchema.js | JSON schema validation for sync payloads |
| schema.json | JSON schema file |
| createFinancialYears.js | Financial year creation helper |
| readTallyFromRegistry.js | Reads Tally Prime version from Windows registry |
| closeSoftware.js | Graceful app close handler |
| getPowershellExe.js | PowerShell exe path resolver (Windows) |
| datetime.js | Date/time utilities |

## xmls/ (Tally XML Templates — READ-only data templates)
See TALLY_XML_MAP.md for full list.

## renderer/ (React Frontend)
### renderer/app/
| File/Folder | Purpose |
|-------------|---------|
| App.jsx | React app root — routing + state |
| views/dashboard/ | Main dashboard view |
| views/devices/ | Device pairing + management |
| views/settings/ | App settings UI |
| views/backup/ | Backup + restore UI |
| views/help/ | Help screen |
| views/components/ | Shared UI components |

### renderer/app/models/
| File | Purpose |
|------|---------|
| index.js | Data models / state management for renderer |

### renderer/app/controllers/
| File | Purpose |
|------|---------|
| pairing.js | Pairing flow controller |
| scheduler.js | Scheduler UI controller |

### renderer/app/utils/
| File | Purpose |
|------|---------|
| TallyContext.js | Tally state context for renderer |
| helper.js | Renderer-side helpers |
| datetime.js | Date formatting |

## Build Output
- `dist_electron/` — Electron build output (ignore in agent tasks)
- `renderer/dist/` — Vite renderer build (ignore in agent tasks)
- `build/` — Build assets |
