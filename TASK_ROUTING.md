# TASK_ROUTING.md — td-source/desktop

For each task type, read ONLY the listed files.

---

## Tally Connectivity Bug (app says "Tally not connected")
Read:
- AGENTS.md, BLUEPRINT.md
- util/helper.js (isTallyOpen, axiosInstance)
- util/ipcRegistry.js (tally:connected handler)

Do NOT read: renderer, xml.js, sync pipeline

---

## Sync Bug (sync starts but fails or incomplete)
Read:
- AGENTS.md, BLUEPRINT.md, SYNC_PIPELINE.md
- util/xml.js (syncTallyData)
- util/tallyHelper.js
- util/socket.js

Do NOT read: renderer, backup, pairing, main.js (unless IPC issue)

---

## XML Parsing Bug (wrong data after sync)
Read:
- AGENTS.md, BLUEPRINT.md, TALLY_XML_MAP.md
- util/tallyHelper.js
- util/xml.js
- xmls/<relevant-template>.xml

Do NOT read: renderer, IPC, backup, socket

---

## Pairing Bug (can't pair with mobile)
Read:
- AGENTS.md, BLUEPRINT.md, IPC_MAP.md
- util/pairingLifecycle.js, util/pairingRuntime.js, util/pairingSessionState.js
- util/ipcRegistry.js (api:pairing_state, api:paired_device, api:remove_paired_device)
- util/helper.js
- renderer/app/views/dashboard/PairingPanel.jsx
- renderer/app/views/devices/ (if UI issue)

Do NOT read: sync, backup, XML, tallyHelper

---

## Auto-Sync Bug (scheduled sync not working)
Read:
- AGENTS.md, BLUEPRINT.md
- util/backgroundRunner.js
- util/ipcRegistry.js (tally:save_auto_sync, tally:delete_auto_sync)
- renderer/app/controllers/scheduler.js

Do NOT read: tallyHelper, XML templates, socket, pairing

---

## Write-Back Bug (voucher created in app but not in Tally)
Read:
- AGENTS.md, BLUEPRINT.md, SYNC_PIPELINE.md, TALLY_XML_MAP.md
- util/socket.js (tally:write event handler)
- xmls/<relevant Create*.xml template>
- util/xml.js (write function)

Do NOT read: sync read flow, renderer, pairing

---

## Backup / Restore Bug
Read:
- AGENTS.md, BLUEPRINT.md
- util/saveBackup.js
- util/restoreBackup.js
- util/backup.js
- util/ipcRegistry.js (backup handlers)
- renderer/app/views/backup/

Do NOT read: sync, Tally XML, pairing

---

## Auto-Updater Bug
Read:
- AGENTS.md, BLUEPRINT.md
- main.js (autoUpdater section, lines ~300–360)

Do NOT read: util/, renderer, sync

---

## IPC Bug (renderer → main communication)
Read:
- AGENTS.md, BLUEPRINT.md, IPC_MAP.md
- preload.js
- main.js (relevant ipcMain.handle section)
- Relevant renderer view component

---

## Renderer / UI Bug (dashboard, settings, devices view)
Read:
- AGENTS.md, BLUEPRINT.md
- renderer/app/views/<relevant-folder>/
- renderer/app/utils/TallyContext.js (if state issue)
- renderer/app/models/index.js (if model issue)

Do NOT read: main process util/, XML, sync

---

## Backend IP / Connection Config Change
Read:
- AGENTS.md, BLUEPRINT.md
- util/helper.js
- util/store.js
- .env.example (structure only, never .env)

---

## Files to ALWAYS Ignore
- node_modules/
- dist_electron/
- renderer/dist/
- renderer/node_modules/
- build/
- .env
- *.log
- xmls/ (unless XML-specific task)
- Sibling repos (td-backend, td-web-portal, tallydekho-mobile-V4, td-website)
