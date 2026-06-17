# SYNC_PIPELINE.md — td-desktop

## Overview
Desktop app acts as the bridge between Tally Prime (local) and TallyDekho backend (cloud).

## Sync Flow

### Step 1: Tally Connectivity Check
- Renderer calls `window.tally.connected()`
- Main process → `util/ipcRegistry.js` → `isTallyOpen()` in `util/helper.js`
- HTTP GET to `http://localhost:9000` (Tally's HTTP server port)
- Also checks `getCompanyDestinations()` — Tally must have a company open

### Step 2: Get Companies
- `window.tally.companies()` → `tally:companies` IPC
- Main process calls `getCompanies()` in `util/xml.js`
- Sends `xmls/Companies.xml` to Tally → parses response → returns list

### Step 3: Start Sync
- User triggers sync or auto-sync fires
- `window.tally.startSync({companyGuid, ...})` → `tally:start_sync`
- Main process calls `syncTallyData()` in `util/xml.js`

### Step 4: XML Requests to Tally
`syncTallyData()` sends XML templates in sequence:
1. `LedgerOpeningBalance.xml` — opening balances
2. `AllVoucher.xml` — all vouchers (paginated)
3. `StockItem.xml` / `StockTransaction.xml` — stock data
4. `Godown.xml` — warehouses
5. `Unit.xml` — units
6. `Group.xml` — groups
7. `GSTDetails.xml` — GST data
8. (and more — see xml.js for full sequence)

### Step 5: Parse + Upload
- `util/tallyHelper.js` parses each XML response
- Data normalized (uppercase keys, qty parsing, Dr/Cr handling)
- Batched and sent to backend via Socket.io: `sync:data` event
- Or via HTTP chunk upload to `/ingest/chunk`

### Step 6: Sync Progress Events
- Main process emits `tally:sync_progress` to renderer
- Renderer updates progress UI via `window.tally.syncProgress(cb)`

### Step 7: Sync Complete
- Main emits `sync:complete` to backend socket
- Backend processes final batch, sends `synced` event to mobile/web clients

## Auto-Sync
- Managed via Windows Task Scheduler (`util/backgroundRunner.js`)
- `tally:save_auto_sync` → creates scheduled task
- `tally:delete_auto_sync` → removes scheduled task

## Write-Back Flow (App → Tally)
1. Mobile/web creates voucher → write_queue in backend DB
2. Backend socket emits `tally:write` event to desktop
3. Desktop receives via `util/socket.js`
4. Desktop sends appropriate Create*.xml to Tally
5. Tally responds with GUID
6. Desktop emits `tally:write:result` back to backend
7. Backend updates write_queue status

## Key Files for Sync Tasks
- Main sync logic: `util/xml.js` — `syncTallyData()`
- XML parser: `util/tallyHelper.js`
- Tally connectivity: `util/helper.js` — `isTallyOpen()`
- Socket connection: `util/socket.js`
- IPC entry: `main.js` + `util/ipcRegistry.js` (tally:* handlers)
