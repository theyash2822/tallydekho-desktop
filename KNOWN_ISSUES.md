# KNOWN_ISSUES.md — td-source/desktop

## Fixed Issues (for reference)

### Double-require IPC Crash (Fixed)
- Root cause: ipcRegistry.js was required from main.js — caused duplicate ipcMain.handle registrations → Electron crash
- Fix: removed `require("./util/ipcRegistry")` from main.js (line 42, now commented out)
- Rule: ALL active IPC handlers live in main.js ONLY

### Dev Mode Quit Crash (Fixed Apr 13)
- Desktop was crashing on quit in dev mode
- Fix: app.on('before-quit') + process handlers improved

### window.api Undefined (Fixed Apr 13)
- Renderer was calling window.api before preload loaded
- Fix: added proper initialization guards

### Sync "Data Synced" vs "Sync Complete" event mismatch (Fixed Apr 29)
- Desktop was emitting wrong socket event name
- Fix: standardized event names across desktop + backend

## Active / Open Issues

### IP Changes on WiFi Reconnect (Open)
- Backend IP changes when Mac reconnects to WiFi
- **Single update point:** `util/backendConfig.js` → `DEFAULT_DEV_BACKEND_URL`
- Current confirmed IP: 192.168.29.241 (as of Aug 24, 2026)
- Optional `.env` `BACKEND_URL` overrides backendConfig if set
- Fix: set static DHCP on router — NOT YET DONE
- Check current Mac IP: `ifconfig | grep "inet "`

### ipcRegistry.js Status (Partially Open)
- File exists but NOT imported in main.js
- Some handlers defined there may be duplicated in main.js
- Needs audit: which handlers in ipcRegistry.js are truly active vs stale?
- Rule: when adding new IPC handler, add to main.js ONLY

### Windows-Only Features
- `util/readTallyFromRegistry.js` — Windows registry access (won't work on Mac)
- `util/backgroundRunner.js` — Windows Task Scheduler (won't work on Mac)
- `util/getPowershellExe.js` — PowerShell path (Windows only)
- Testing on Mac: registry + scheduler features will return errors/not-found

### Tally Port
- Tally Prime default: localhost:9000
- If user changed Tally HTTP port → sync will fail
- No UI to configure alternate Tally port (Needs verification)

## Architecture Notes
- Desktop version: 1.0.42 (from dist_electron/latest-mac.yml)
- Auto-updater: electron-updater, checks on app launch
- Renderer is a separate Vite app in renderer/ with its own node_modules
- When building: renderer must be built first, then Electron packaged
