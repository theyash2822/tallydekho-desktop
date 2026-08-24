# BLUEPRINT.md — td-desktop (Electron)

## Stack
- Electron (main process: Node.js)
- Renderer: React + Vite + Tailwind (`renderer/`)
- Platform: Windows (primary), Mac (dev)
- Tally Prime: communicates via HTTP on localhost:9000 (XML requests)
- Backend: communicates via HTTP + Socket.io to Mac backend (LAN IP)

## Process Architecture
```
Main Process (main.js)
├── Window management
├── IPC handlers (ipcMain.handle)
├── Auto-updater
├── Store (electron-store)
└── util/ helpers

Preload (preload.js)
└── Exposes window.api, window.tally, window.backup to renderer

Renderer (renderer/)
├── React app (Vite)
└── Calls window.api.* / window.tally.* via preload bridge
```

## Entry Points
- `main.js` — Electron main process entry
- `preload.js` — Context bridge (exposes API to renderer)
- `renderer/main.jsx` — Renderer React entry
- `renderer/app/App.jsx` — React app root

## Backend Connection
- URL: `BACKEND_URL` env var (optional override) or `util/backendConfig.js` default
- Default: `http://192.168.29.241:3001` — edit `DEFAULT_DEV_BACKEND_URL` in `util/backendConfig.js` when Mac IP changes
- Socket.io: `util/socket.js` — connects to backend, handles sync events
- ⚠️ IP changes on WiFi reconnect — read from store/env, never hardcode

## Tally Connection
- Tally must be running on same Windows machine
- HTTP requests to `http://localhost:9000` (Tally Prime default port)
- XML request/response via `util/xml.js` and `util/tallyHelper.js`

## IPC Architecture
- Main process: `ipcMain.handle()` in main.js
- ⚠️ `util/ipcRegistry.js` is NOT required from main.js (double-require bug — duplicate handlers crash Electron)
- All IPC handlers live in main.js only
- Renderer access: `window.api.*`, `window.tally.*`, `window.backup.*`
- See: IPC_MAP.md

## XML Templates
- All Tally query/write XML templates in `xmls/`
- Read by `util/xml.js` + rendered via `util/tallyHelper.js`
- See: TALLY_XML_MAP.md

## Key Utilities
- `util/helper.js` — axiosInstance + Tally connectivity check + backend API helpers
- `util/xml.js` — XML template rendering + Tally HTTP calls + sync orchestration
- `util/tallyHelper.js` — Tally XML parser + data normalizer
- `util/store.js` — electron-store wrapper (persistent key-value)
- `util/socket.js` — Socket.io client to backend
- `util/logger.js` — File logger (logs to AppData)
- `util/ipcRegistry.js` — IPC definitions (NOT imported in main.js — reference only)
- `util/backgroundRunner.js` — Windows Task Scheduler integration (auto-sync)
- `util/saveBackup.js` / `restoreBackup.js` — Data backup/restore
- `util/backup.js` — Backup orchestration
- `util/deviceProfile.js` — Device identity generation
- `util/validateSchema.js` — Schema validation for sync payloads
- `util/schema.json` — JSON schema for validation

## Renderer Views
- `renderer/app/views/dashboard/` — main dashboard
- `renderer/app/views/devices/` — device/pairing management
- `renderer/app/views/settings/` — app settings
- `renderer/app/views/backup/` — backup UI
- `renderer/app/views/help/` — help screen
- `renderer/app/views/components/` — shared components

## Details
- IPC channels: IPC_MAP.md
- Tally XMLs: TALLY_XML_MAP.md
- Sync flow: SYNC_PIPELINE.md
- Task routing: TASK_ROUTING.md
