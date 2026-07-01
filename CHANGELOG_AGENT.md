# CHANGELOG_AGENT.md — td-desktop

Format: Date | Task | Files Changed | Behavior Changed | Tested | Risks

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
