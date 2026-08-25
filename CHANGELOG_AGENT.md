# CHANGELOG_AGENT.md — td-desktop

Format: Date | Task | Files Changed | Behavior Changed | Tested | Risks

---

## 2026-08-25 — Export CREDITLIMIT for OD / loan facilities

**Files:** `xmls/LedgerFull.xml`
**Behavior:** Adds `CREDITLIMIT` compute from `$CreditLimit` for backend `ledgers.credit_limit` ingest
**Test:** Sync after pull; OD ledgers with Tally credit limit should populate DB
**Risks:** Zero when Tally credit limit empty

---

## 2026-08-25 — Export bank A/c + IFSC from Tally ledger master

**Files:** `xmls/LedgerFull.xml`, `xmls/FullLedger.xml`
**Behavior:** Prefer `$BankAccountDetails[1].AccountNumber` / `IFSCCode` / `BankName` (matches TallyPrime Bank Account Details); FullLedger also exports BankBranch + BankHolder
**Test:** After deploy, run ledger sync; bank ledgers should carry A/c + IFSC into backend
**Risks:** Older Tally builds without BankAccountDetails fall back to `$BankDetails` / `$IFSCode`

---

## 2026-08-24 — Backend LAN IP → 192.168.29.241 + single config file

**Behavior:** LAN IP moved to `192.168.29.241:3001`; dev URL centralized in `util/backendConfig.js`
**Test:** Mac en0 = 192.168.29.241; backend health 200
**One-go IP updates:** edit `DEFAULT_DEV_BACKEND_URL` in `util/backendConfig.js` only

## 2026-08-11 — Backend LAN IP → 192.168.29.240 (WiFi reassign)
**Files:** `.env`, `util/helper.js`, docs
**Behavior:** LAN IP moved back to `192.168.29.240:3001` after DHCP change
**Test:** Mac en0 = 192.168.29.240; backend ping OK
**Risks:** DHCP may change again

---

## 2026-08-11 — Backend LAN IP → 192.168.29.180
**Files:** `.env`, `util/helper.js`, `API_USAGE.md`, `BLUEPRINT.md`, `KNOWN_ISSUES.md`
**Behavior:** Dev backend URL updated from `192.168.29.240` / docs `243` to current Mac LAN `192.168.29.180:3001`
**Test:** Backend ping on `.180`; old `.240` unreachable
**Risks:** If Mac DHCP IP changes again, update `.env` / helper fallback

---

## 2026-07-28 — Bill Outstanding activate: fix /TDL argv + /LOAD company
**Files:** `util/ensureBillOutstandingTdl.js`, `util/xml.js`
**Behavior:** Activate now uses `/TDL:TDKBillOutstanding.tdl` (no embedded quotes) via `cmd start`, plus `/LOAD:companyNumber` so probe can see BILLROW after restart. Retries live probe after activate.
**Test:** Close Tally company session → Settings Retry setup → Tally reopens with company → In Tally Active → Sync fills outstanding. No F1.
**Risks:** taskkill briefly closes Tally; wrong companyNumber skips /LOAD (open company manually then Check now).

---

## 2026-07-28 — Bill Outstanding: auto-activate TDL (no manual F1)
**Files:** `util/ensureBillOutstandingTdl.js`, `util/xml.js`, `util/ipcRegistry.js`, `main.js`, `renderer/app/views/settings/Settings.jsx`
**Behavior:** Quoted `TDL="…"` in tally.ini (fixes `TallyPrime (1)` paths). Live probe for `<BILLROW>`. If not loaded, Settings Retry / Sync restart Tally with official `/TDL:"path"` — no manual F1 load. Boot only installs files (no restart). Ready = live active, not just files on disk.
**Test:** Fresh Tally session without F1 load → Settings Retry or Sync → In Tally Active → Bill Outstanding rows sync. No HTTP Import.
**Risks:** Activate kills `tally.exe` briefly — save Tally work first. Port wait may timeout on slow PCs.

---

## 2026-07-28 — Settings: restart Tally tip when TDL Ready
**Files:** `renderer/app/views/settings/Settings.jsx`
**Behavior:** When Bill Outstanding TDL status is Ready, show amber note to restart Tally Prime then sync (install ≠ loaded). Setup success notes also say restart now.
**Test:** Settings → Ready badge → see restart tip; Retry setup success → green note mentions restart.
**Risks:** None — copy only. Superseded by auto-activate entry above.

---
**Files:** `util/ensureBillOutstandingTdl.js`, `util/ipcRegistry.js`, `preload.js`, `main.js`, `util/xml.js`, `renderer/app/views/settings/Settings.jsx`, `IPC_MAP.md`
**Behavior:** Detects Tally folder (saved → registry → process → common paths). Settings → Tally Connection shows TDL status + Check / Select folder / Retry. Auto-copy + ini link; guides user when auto fails (no silent fail). Path persisted in store.
**Test:** Settings → see TDL section; if Needs setup → Select Tally folder → Retry → Ready. Restart Tally after link. Sync still uses ensure on start.
**Risks:** Writing under Program Files may need Admin; user must pick correct folder if auto-detect fails.

---

## 2026-07-27 — Hard sync passes isHardSync to init-sync (rebuild)
**Files:** `util/xml.js`
**Behavior:** `initSync(companies, isHardSync)` sends `isHardSync` to `POST /desktop/init-sync`. Backend purges selected GUID tally data then desktop continues full fetch (existing alterIds=0 path). UI unchanged. Normal sync unchanged.
**Test:** Hard Sync one company → cloud voucher count drops then refills; second company not selected stays intact. Normal Sync still delta-only.
**Risks:** If Hard Sync fails after purge, cloud is empty until a successful sync completes — re-run Hard Sync.

---

## 2026-07-16 — FETCH IsOptional on Simplified + AllVoucher
**Files:** `xmls/SimplifiedVoucher.xml`, `xmls/AllVoucher.xml`
**Behavior:** Collection FETCH now includes `IsOptional` so `$IsOptional` exports 1/0 correctly. Without FETCH, Simplified always sent `isOptional:0` and backend falsely ran Optional→Regular.
**Test:** Pull desktop + restart; create optional Receipt → sync must keep Optional chip (not Regular + Orig. Optional).
**Risks:** Low — additive FETCH only.

---

## 2026-07-13 — tally:write: CREATED=0 is failure (stop false Posted)
**Files:** `util/xml.js`
**Behavior:** If Tally returns `CREATED=0` and `ALTERED=0` (often with `EXCEPTIONS>0` and no LINEERROR), treat as **failure**. Previously returned `status:true` → backend marked audit trail Posted while voucher never existed in Tally.
**Test:** Re-submit Payment after pull+restart desktop; failed import must show error, not Posted.
**Risks:** None — real creates still have CREATED≥1.

---

## 2026-07-13 — BillOutstanding TDL: safe BillDate format (YYYY-MM-DD)
**Files:** `xmls/TDKBillOutstanding.tdl`
**Behavior:** BillDate uses `$$PyrlYYYYMMDDFormat` (empty-safe). DueDate stays blank (no credit-period math — crash risk). Desktop copies updated TDL into TallyPrime folder on boot/sync.
**Test:** Restart Tally after pull → Hard Sync → `bill_outstanding.bill_date` should be non-null for most rows.

---

## 2026-07-13 — BillOutstanding Option B: minimal TDL + tally.ini inject + dated sync
**Files:** `xmls/TDKBillOutstanding.tdl` (NEW), `xmls/BillOutstanding.xml`, `util/ensureBillOutstandingTdl.js` (NEW), `util/xml.js`, `main.js`, `package.json` (+iconv-lite)
**Behavior:**
- Ships a **minimal** sync-safe TDL (no Gateway menu, no `$DSPAccName`, no due-date math, no Cleared/ledger filters).
- On boot + every sync start: copies TDL to `C:\Program Files\TallyPrime\` and ensures `tally.ini` has `User TDL Files=Yes` + `TDL=<path>` (silent, no dialog).
- `BillOutstanding.xml` is a thin export envelope for report `TDKBillOutstandingWorking`.
- Removed from date-less `masterXmls`; fetched once per company via `syncHelperWithDate` using latest selected FY window.
- `getData` decodes UTF-16 LE/BE BOM via iconv-lite; BILLROW nested rows mapped explicitly (not parallel-array normalize).
**Tested:** `node --check` on changed JS files. Device Hard Sync + DB count pending on Windows.
**Risks:** Writing under Program Files may fail without elevation (logged, non-fatal). Tally must reload TDL (restart Tally after first inject). Minimal TDL still uses `Type:Bill` — if Tally crashes, stop and revise TDL further.

---

## 2026-07-02 — Phase 2b: Targeted SingleVoucher.xml fetch for post-write sync
**Commit:** `d3d4a45`
**Files:** `util/xml.js`, `util/socket.js`
**Behavior:** Wires up SingleVoucher.xml TDL from Phase 2a. When backend emits `sync:request` with `tallyIds` + `companyGuid` + `companyName`, desktop now fetches ONLY those vouchers (via `SingleVoucher.xml` per MASTERID) and ships them through the existing `/ingest/init → /chunk (stream=vouchers) → /complete` pipeline — same processVouchers path that runs the Receipt reconciler + bill-alloc parser. Silent fallback to full sync on any failure (missing preconditions, company mismatch, Tally fetch fail, ingest fail, thrown exception). Auto/Manual/Hard sync paths untouched. `isSyncing` gate preserved.
**Tested:** QA subagent 🟢 GREEN — `node --check` both files, git diff scoped to 2 files, imports verified, backend contract match verified against `/ingest/chunk` + `/ingest/complete` in td-backend, three-exit fallback path traced.
**Risks:** None material. Minor cleanup deferred: dead `module.exports.postToTally = ...` at xml.js line 401 (now overwritten by object-literal exports at bottom).

---

## 2026-07-01 — Phase 2a: sync:request tallyIds payload + SingleVoucher.xml stub

**Task:** Foundation for targeted single-voucher post-write sync (avoids full daybook re-pull just to backfill one Tally voucher number).

**Files Changed:**
- `util/socket.js` — log `tallyIds` from `sync:request` payload (backend now sends MASTERIDs of freshly-written Sales+Receipt pair). Removed stale 1.5s `setTimeout` (dead workaround; `isSyncing` gate handles the race).
- `xmls/SingleVoucher.xml` — new TDL to fetch ONE voucher by MASTERID. Same field shape as Voucher.xml + ALLLEDGERENTRIES so backend can extract `bill_ref_name` / `bill_type` from `BILLALLOCATIONS.LIST`.

**Behavior Changed:**
- Post-write sync fires immediately (no 1.5s delay). Existing full-sync path unchanged.
- `tallyIds` payload is informational-only today — renderer-side handler wire-up is the follow-up (Phase 2b).

**Tested:**
- Node syntax check passed. No runtime path exercised yet (renderer handler not wired).

**Risks:**
- 🟡 If backend sends `tallyIds`, desktop still runs full sync (no regression). Once Phase 2b wires renderer handler, need to verify SingleVoucher.xml returns the same field shape.

**Commits:** `3c43f00`

---

## 2026-06-02 | Blueprint System Created
Files changed: AGENTS.md, BLUEPRINT.md, DESKTOP_MAP.md, TALLY_XML_MAP.md, IPC_MAP.md, SYNC_PIPELINE.md, API_USAGE.md, TASK_ROUTING.md, KNOWN_ISSUES.md, CHANGELOG_AGENT.md, .agentignore
Behavior changed: None (docs only)
Tested: N/A
Risks: None

---

## 2026-05-27 | IP Update to 192.168.29.243
Files changed: .env, util/helper.js
Behavior changed: Backend URL updated — desktop now connects to 192.168.29.243:3001
Tested: Manual sync test
Risks: IP may change again on WiFi reconnect

---

## 2026-04-29 | Socket Event Mismatch Fix
Files changed: util/socket.js (or util/xml.js — Needs verification on exact file)
Behavior changed: Desktop now emits correct event names matching backend expectations
Tested: Manual sync test
Risks: None

---

## 2026-04-13 | Desktop Crash Fixes
Files changed: main.js (window.api guard, quit handler)
Behavior changed: No more crash on dev mode quit; window.api no longer undefined
Tested: Manual
Risks: None

---

## 2026-04-13 | Double-require IPC Fix
Files changed: main.js (removed require of ipcRegistry.js)
Behavior changed: No more duplicate IPC handler crash
Tested: App launch + sync
Risks: None

---

_Add new entries at top._

## 2026-06-05 — Expiry Batch XML Fixes (Gaps 2, 3, 4)

### Files Changed
- `xmls/AllVoucher.xml`
- `xmls/StockItem.xml`

### Changes
**AllVoucher.xml — Batchallocations section (MyLine03):**
- Added `ActualQty` field (Fld09B) — physical stock qty at batch level
- Added `ExpiryPeriod` field (Fld10B) — text format like "31-Dec-2026"
- `ExpiryDate` and `ManufacturingDate` now use `$$PyrlYYYYMMDDFormat` → YYYY-MM-DD

**StockItem.xml:**
- Added `MAINTAININBATCHES` (Fld25) via `$IsBatchWise`
- Added `USEEXPIRYDATES` (Fld26) via `$IsExpDtMaint`

### Commit
`b4fbcd2` — pushed to `tallydekho-desktop`
