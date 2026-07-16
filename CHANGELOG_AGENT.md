# CHANGELOG_AGENT.md — td-desktop

Format: Date | Task | Files Changed | Behavior Changed | Tested | Risks

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
