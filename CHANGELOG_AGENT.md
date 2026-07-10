# CHANGELOG_AGENT.md — td-desktop

Format: Date | Task | Files Changed | Behavior Changed | Tested | Risks

---

## 2026-07-10 — BillOutstanding TDL V8: pivot from REPORT to COLLECTION export path
**Commit:** `0731473`
**Files:** `xmls/BillOutstanding.xml`
**Behavior:** V7 device-verified failing — `bill_outstanding` DB still 0 rows, zero `processBillOutstanding` log lines in backend, BillOutstanding.xml records never reached `/ingest/*`. Root cause deeper than V7 assumed: **V4→V7 all used REPORT-based export** (`<HEADER><TYPE>Data</TYPE>` + `REPORT/FORM/PART/LINE/FIELD` scaffolding). Every working master XML (`LedgerFull`, `GroupMaster`, `UnitFull`, `VoucherTypeFull`, `StockGroupFull`) uses **COLLECTION-based export** (`<HEADER><TYPE>Collection</TYPE>` + a single `<COLLECTION>` block with `<Compute>` fields). V8 rewrites BillOutstanding.xml in that COLLECTION-based pattern: `TYPE=Collection`, `ID=TDKPendingBills`, one `<COLLECTION NAME="TDKPendingBills">` with `<TYPE>Bill</TYPE>`, `<FETCH>` list, native `<FILTER>TDKBillIsPending</FILTER>`, and eight `<Compute>` output fields matching the V3 DSL response shape exactly. `<SYSTEM TYPE="Formulae">` filter formula unchanged from V6/V7. No FORM / PART / LINE / FIELD blocks. Backend + parser (`normalizeEnvelope`, `processBillOutstanding`) unchanged.
**Tested:** `xmllint --noout` clean. Awaiting Windows device verification: `git pull` on desktop → restart app → hard sync → `SELECT COUNT(*) FROM bill_outstanding;` should be non-zero (V3 reference produced 2167 rows).
**Risks:** If V8 also returns empty, Tally is likely rejecting `<TYPE>Bill</TYPE>` collection without extra DSL scaffolding (System:Variable, Menu items). Fallback plan C: iterate `<TYPE>Ledger</TYPE>` and drill into `$BillAllocations` sub-collection (pattern used by GSTDetails.xml with `$$GSTTaxableValue`).

---

## 2026-07-10 — BillOutstanding TDL V7: forensic fix for empty `bill_outstanding` table
**Commit:** `d23aa8d`
**Files:** `xmls/BillOutstanding.xml`
**Behavior:** V4→V6 iterations all left `bill_outstanding` table empty across every install (Tally rejected the report). Forensic diff of V6 against 20+ working production XMLs (GSTDetails, FullLedger, Master, VoucherType, etc.) surfaced two root causes: (1) `<SVEXPORTFORMAT>$$SysName:XMLFormat</SVEXPORTFORMAT>` is a DSL-only alias that embedded TDL can't resolve — replaced with literal `XML (Data Interchange)` (the pattern every working XML uses); (2) `<XMLTAG>ENVELOPE</XMLTAG>` on FORM and `<XMLTAG>BILLROW</XMLTAG>` on LINE — no working XML uses FORM/LINE XMLTAGs. Removed both. Tally's default response shape (parallel field arrays under `<ENVELOPE>`) is exactly what `normalizeEnvelope` in `util/tallyHelper.js` already parses. Collection block (Type: Bill, FETCH list, FILTER: TDKBillIsPending) and SYSTEM Formulae unchanged from V6.
**Tested:** `xmllint --noout` clean. Awaiting Windows device verification: `git pull` on desktop → restart app → sync → `SELECT COUNT(*) FROM bill_outstanding;` should be non-zero.
**Risks:** If Tally still rejects V7, fallback plan B: iterate `Type: Ledger` and drill into `$BillAllocations` sub-collection (the pattern GSTDetails uses for `$$GSTTaxableValue`).

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

## 2026-07-09 — BillOutstanding.xml TDL rewrite

**Problem:** `bill_outstanding` table was silently empty across all installs — `syncHelper` never replaces `$$FROM_DATE`/`$$TO_DATE` placeholders (only `$$COMPANY_NAME` + `$$ALTER_ID`), so Tally received literal `$$FROM_DATE` and rejected the request. Compounded by structurally broken TDL (used `BillAllocations` as an undefined collection name inside REPEAT).

**Fix (`xmls/BillOutstanding.xml`):**
- Removed unused `SVFROMDATE`/`SVTODATE` static variables (bill-wise outstanding is as-of-today, no date range needed).
- Rewritten TDL structure pattern-matched to user-supplied working Aai Gee `Ledger Outstandings` XML export:
  - Outer collection `TDKLedgerBillsCollection` walks Ledger with `<FETCH>BillAllocations</FETCH>` and filter `IsSundryDebtorOrCreditor`.
  - Middle collection `TDKBillOutstandingCollection` uses `<SOURCE COLLECTION>` + `<WALK>BillAllocations` to descend into per-bill rows.
  - Filter `NOT IsZero:$ClosingBalance` skips cleared bills.
- Fields emitted (match `processBillOutstanding` ingestion parser exactly):
  `LedgerName` (`$..Name` — ledger context via double-dot), `BillName` (`$Name`), `BillDate`, `DueDate` (derived from `$BillDate + $BillCreditPeriod`), `Amount`, `PendingAmount` (`$ClosingBalance` sign-flipped for Dr), `BillType`, `AlterId`, `VoucherGuid` (`$..Guid` — ledger's guid).

**User action:** `git pull` on desktop repo, restart desktop app, run Hard Sync. `bill_outstanding` table should populate.
