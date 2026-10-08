# CHANGELOG_AGENT.md — td-desktop

Format: Date | Task | Files Changed | Behavior Changed | Tested | Risks

---

2026-10-08 | P5 backup, restore, restart, power (TD-FIX-2026-10-08, branch `8-10-2026`) | util/backupSchedule.js (new), util/saveBackup.js, util/ipcRegistry.js, util/schema.json, util/backgroundRunner.js, main.js, util/ensureBillOutstandingTdl.js, util/xml.js, util/restoreBackup.js, util/restoreGuards.js (new), util/restoreAck.js (new), package.json, scripts/test-p5-*.js | 15: scheduled/missed backup keyed on last verified backup, with backoff, early slack, missed-run cooldown; backward clock never triggers. 18: TallyDekho never kills Tally; setup refuses while Tally runs, unsafe path, missing exe/TDL; `/LOAD` digits only; health lists companies not reopened; restart runs under the job coordinator. 20: owned scheduled tasks re-applied once without WakeToRun. 17/N1/N5: restore needs local confirmation, refuses while Tally runs, inspects the archive listing (absolute/.. paths, links, loose files, expanded size vs free temp/destination space) before extraction, checks extracted folders against the manifest before writing, sends `restoredFolders` with the restore token, persists and retries the acknowledgement. Backup manifest records each company folder; a failed upload calls the fail endpoint. | `npm test` 207/207 | Windows Task Scheduler, Tally process detection, file locks, 7-Zip listing format untested (D-002). Tally detection fails open if PowerShell errors. No restore journal or sibling-folder swap (17 partial).

2026-10-08 | P4 hard sync (TD-FIX-2026-10-08, branch `8-10-2026`) | util/xml.js (comment only) | None on desktop: backend no longer purges at init-sync; it publishes after a verified upload with a complete voucher list. A refused hard-sync start shows the backend message (existing path). | desktop `npm test` unchanged | Hard sync on Windows/Tally untested (D-002)

## 2026-10-08 — P3 lossless Tally text, deterministic decoding, fiscal planner, stock FY scope (branch `8-10-2026`, TD-FIX-2026-10-08)

- Files: `util/tallyXmlParser.js`, `util/tallyDecode.js`, `util/fiscalPlanner.js` (new); `util/xml.js`, `util/billSnapshot.js`, `util/tdlHealth.js`, `util/tallyHelper.js`; tests `scripts/test-p3-lossless.js`, `scripts/test-p3-fiscal.js`; `package.json`.
- Behaviour (01/02): one parser factory. Values stay exact text (`04021010`, `0012`, `12.10`, `2E5`, `0x1A`, long ids, phones). `&#13;&#10;`, `&#8377;` are decoded once by the parser; an escaped literal `&amp;#13;` stays the text `&#13;`; only control markers (e.g. `&#4;`) are stripped, tab/CR/LF kept. Decoding: BOM, then the NUL position of the first code unit for BOM-less UTF-16, then strict UTF-8, then a supported declared encoding; anything else fails with `TALLY_ENCODING_UNSUPPORTED` (no retry, no U+FFFD).
- Behaviour (08): every sync (window, scheduled, headless, socket) plans its fiscal scope in main from the same Companies.xml read: selected years kept, later years Tally now reports appended (renderer rule), deselections untouched, scope frozen for the job and persisted to the selection.
- Behaviour (S6): StockFYBalance rows carry `_FINANCIAL_YEAR` = the FY's own label plus `FY_BEGIN`, `FY_END`, `BALANCE_DATE`, `BALANCE_ROLE`.
- Verified (03): ledger opening and StockFYBalance exports are always full (`alterId: 0`); `2d6eded` is on this branch.
- Tested: `npm test` 191/191. Not tested: real Tally byte responses (UTF-16 without BOM, Hindi company), ENDINGAT behaviour before the first voucher of a new FY (Windows gate, D-002).
- Risks: a new FY appears only once Tally's ENDINGAT reaches it; a Tally that answers in an undeclared non-UTF encoding now fails visibly.

---

## 2026-10-08 — P2 ingest client deadlines and sync-run lifecycle (branch `8-10-2026`, TD-FIX-2026-10-08)

- Files: `util/helper.js`, `util/xml.js`, `scripts/test-p2-ingest-client.js`, `package.json`.
- Behaviour: axios default timeout 60 s; chunk 120 s; complete and init-sync 10 min. A timed-out `/ingest/complete` returns `COMPLETE_OUTCOME_UNKNOWN` and is not re-sent. `NDJSON_INVALID`, `CHUNK_TOO_LARGE`, `CHUNK_CONTENT_CONFLICT`, `UPLOAD_OWNERSHIP_DENIED`, `COMPANY_GUID_REQUIRED`, 401, 403 are not retried. The sync run starts after init-sync (first-sync companies get a run ID), heartbeats every 60 s until the sync ends, and a partly uploaded sync reports `partial`.
- Tested: `npm test` pass (incl. new 5/5). Not tested: Windows/Tally network loss and long extraction.
- Risks: a very slow backend complete (>10 min) now shows "outcome unknown" instead of waiting forever.

---

## 2026-10-08 — P1 desktop state & operation ownership (branch `8-10-2026`, TD-FIX-2026-10-08)

- `util/jobCoordinator.js` (new): one owner for sync / hard sync / single voucher / backup / restore. Synchronous admission with a conflict matrix, job-local cancel (AbortController + AsyncLocalStorage), owner-only release, `job:changed` events. `isSyncing` is mirrored from it; renderer can no longer write it.
- Stop is a cancel request ("Stopping…"); sync checks at masters / voucher lists / each FY / before upload. Upload init+chunks get the job signal, `/ingest/complete` never aborted. Per-company upload outcomes; partial upload → `partial_sync`.
- `tally:companies` returns a typed discovery. Unknown result never changes the selection; missing companies stay selected as "Not open in Tally". GUID-change alert only on same-name/new-GUID evidence. Ledger counts cached, refreshed in background.
- Config validator repairs instead of deleting: backup + quarantine files, no relaunch. Schema accepts the company shape the renderer writes.
- Headless registration failure exits without a modal; import-time missed-backup run removed; second launch routed by intent; UI can open during a headless job. Async cross-device dialog with timeout.
- Port validated and hydrated; updater shows errors with Retry; registration response validated; logger redacts / caps / rotates; `closeSoftware` IPC removed.
- Tested: new `test-job-coordinator`, `test-settings-migration`, `test-p1-foundation`, `test-selection-merge`; `npm test` 166/166; renderer vite build ok. Windows/Tally behaviour not yet verified (INTEGRATION_PENDING).
- Risk: renderer and main must ship together (internal IPC shape changed).

## 2026-10-05 — Normal sync downloads only what changed (branch `tdl`)

- **Before:** every manual/auto sync re-downloaded the entire current FY (backend date-format bug gave a start point of 0).
- `util/voucherList.js`: `maxListedAlterId`, `buildVoucherWatermarks` — per FY the highest AlterId in the voucher list, only for years whose list check was clean and whose delta requests all succeeded (trailing years skipped).
- `util/xml.js`: init-sync sends `watermarkSync: true`; uploads carry `voucherWatermarks` + sent AllVoucher/StockTransaction counts. Delta requests mark their FY failed on request failure, `LINEERROR`, company-not-open text, or a row with another company's GUID. If Tally's highest listed AlterId is below what the backend holds (Tally restored from backup) all voucher start points reset to 0. LedgerOpeningBalance and StockItemFull always fetched in full (opening balances change without the ledger's AlterId changing).
- `util/uploadChunks.js` (`planChunks`): upload chunks cut only between vouchers for StockTransaction/LedgerTransaction. The backend replaces those rows per voucher in each chunk, so a voucher split across two chunks lost its first part (old bug, self-healing only while the whole FY was re-sent every sync).
- Tested: `scripts/test-voucher-list.js`, `scripts/test-upload-chunks.js`; `npm test` 127/127.
- Needs the matching backend. First sync after updating is a one-time full fetch; afterwards only changed vouchers.

## 2026-10-05 — Main window recovers when its page fails to load (branch `tdl`)

- Problem: a failed load (e.g. `-331 ERR_NETWORK_IO_SUSPENDED` after Windows slept mid-load) replaced the window with a raw "Failed to load renderer" page that never recovered and wasn't logged to file.
- `util/rendererRecovery.js` (new): main-frame failures (not -3 aborts, sub-frames or the status page) retry after 2s / 5s / 10s with a "Reconnecting…" page, then show a TallyDekho page with Reload / Quit and the error code. Wake and screen unlock retry immediately. Chromium's error-page finish is not counted as recovery (found in a real Electron run — it caused endless retries).
- `main.js`: `loadRenderer()`, recovery wiring, `renderer:recover` IPC (sender-checked; Quit confirms natively if a sync is running), resume / unlock-screen hooks; failures now go to `info.log` with a timestamp. `preload.js`: `api.recoverRenderer`.
- Tested: `npm test` 119/119 (new `scripts/test-renderer-recovery.js`); real Electron run: fail → 2 retries → failed page → Reload button → real page loaded. Only the window's page reloads; sync / backup untouched.

## 2026-10-05 — Deleted-voucher check also covers years Tally dropped (branch `tdl`)

- Found in a real sync: Tally ends a company's period at its last voucher, so deleting every voucher of a year removed that year from `years` and its stale vouchers were never checked (Laveena 2026-27).
- `util/voucherList.js`: `trailingCheckYears(years)` — FY spans after the last synced year through the FY after today's (max 10). A trailing year Tally didn't answer cleanly is skipped, never treated as empty; no checked years → incomplete.
- `util/xml.js`: SimplifiedVoucher fetched for trailing years as a check only (rows discarded); the summary waits for all real + trailing checks.
- Tested: `npm test` 111/111; rolled-back backend run with Laveena's real data deletes exactly the one stale 2026-27 voucher. Risk: a few extra small Tally requests per company.

## 2026-10-05 — Dev backend moved to the Mac's new LAN IP (branch `tdl`)

- Mac DHCP address changed `192.168.29.240` → `.242`; `.240` / `.241` no longer answer. `util/backendConfig.js` dev default is now `http://192.168.29.242:3001`; `.241` joins the stale-host list, so a Windows `.env` still saying `.240` / `.241` falls back to `.242` with a warning. `.env.example` updated.
- Tested: resolution for `.240`, `.241` and no `BACKEND_URL` → `.242`; desktop 109/109.

## 2026-10-03 — Deleted-voucher list sent with sync; diagnostic probes removed (branch `tdl`)

- Probes removed after Windows QA of 1.1.3 passed: `TEMPORARY DIAGNOSTIC PROBES` block in `xmls/TDKBillOutstanding.tdl` (version stays 1.1.3), `scripts/tdl-layout-probe.js`, isolation test (now asserts they are gone).
- New `util/voucherList.js`: `checkVoucherListResponse` (request ok, clean `<ENVELOPE>`, no LINEERROR / "Could not set SVCurrentCompany", GUID count == ALTERID count, every GUID prefixed `<companyGuid>-`), `buildVoucherListSummary` (complete only with this sync's Context VERIFIED and every FY clean; ≤400k ids), `voucherListLog` (counts only).
- `util/xml.js`: SimplifiedVoucher per company/FY through `fetchVoucherList` (same stub rows as before + the check); per company after the bill snapshot builds the summary, logs `[sync] voucher_list`, and sends `voucherLists` + `syncRunId` on `/ingest/complete`. The complete-body log no longer prints id lists.
- Tested: new `scripts/test-voucher-list.js` (7, in `npm test`); desktop 109/109.

## 2026-10-03 — TDL 1.1.3: separate Context report, Context → Bills per company, verified zero clears (branch `tdl`)

- Probe evidence (Windows, TallyPrime 7.0): round 2 — `##SVCurrentCompany` / `$Name:Company:##SVCurrentCompany` in a fixed scrolling line return the requested company (Yash → Yash, Laveena → Laveena); a real closed company (Radhe Ram) and a nonexistent name both give `LINEERROR Could not set 'SVCurrentCompany'`; a fixed line in the same part as repeated bill lines is dropped.
- `xmls/TDKBillOutstanding.tdl` 1.1.3: Health = one fixed `TDKSTATUS` line (ACTIVE/VERSION/REPORT) in a `Scroll : Vertical` part, no company. New `TDKBillOutstandingContext` = one fixed `TDKCONTEXT` line (ACTIVE, VERSION, COMPANY = `$Name:Company:##SVCurrentCompany`) in a scrolling part. Bill report: single scrolling part, dead context part and Company collections removed. Probe block still present (removed after Windows QA).
- `util/tdlHealth.js`: `TDL_VERSION` 1.1.3; `CONTEXT_STATUS`, `contextRequestXml`, `classifyContextResponse` (VERIFIED / OUTDATED / MISMATCH / BLANK / COMPANY_NOT_OPEN / REPORT_MISSING / EMPTY / INVALID / ERROR), `looksLikeCompanyNotOpen` (checked before generic LINEERROR).
- `util/tallyQueue.js`: `runCompanyExclusive` — separate chain so one company's Context → Bills cannot interleave with another unit (sync vs Settings); per-request `runTallyExclusive` unchanged.
- `util/billSnapshot.js`: `fetchCompanyBillSnapshot` runs Context then Bills inside `runCompanyExclusive`; bills skipped unless context VERIFIED / REPORT_MISSING / OUTDATED. `decideBillSnapshot({ health, context, bill, requestedCompany })`: VERIFIED + rows all matching → SUCCESS replace; VERIFIED + 0 → SUCCESS clear (authority CONTEXT, even with unconfirmed health); any row mismatch → `COMPANY_CONTEXT_MISMATCH`, row without company → `COMPANY_UNVERIFIED` (whole snapshot rejected); context mismatch / blank / empty / error → preserve; new `COMPANY_NOT_OPEN`; legacy (no context report) rows with matching company → SUCCESS `ACTIVE_LEGACY`, 0 → `LEGACY_EMPTY_AMBIGUOUS`. Legacy rows without a Company tag are no longer accepted. `tdlStatus` = global health state (`ACTIVE_LEGACY` only when the health report is missing too); result adds `healthStatus`, `contextStatus`, `contextCompany`, `authority`. Backend summary keys unchanged.
- `util/ensureBillOutstandingTdl.js`: `settingsTdlStatus` — Settings status from global health only (Ready needs health ACTIVE); health log adds `billStatus` / `contextStatus`. `util/xml.js`: `[sync] bill_snapshot` log adds `contextStatus`, `contextCompany`, `authority`.
- `scripts/tdl-probe.js`: prints raw Health, then per company raw Context + Bills, decision, and a summary table.
- Tests rewritten for the decision table, request order, lock, Settings separation and 1.1.3 file shape. Desktop 102/102.
- Lifecycle unchanged: Sync / Hard Sync / Check now never restart Tally; only Retry setup.

## 2026-10-03 — TEMPORARY probe round 2: company context in a scrolling line (branch `tdl`, diagnosis only)

- Round 1 result (Windows, TallyPrime 7.0, HTTP Export/Data): Fixed/Company/Bill + `Scroll : Vertical` → PRINTS (1 / 2 / 2,008); all three without scroll → EMPTY; identical plain vs company request. `Scroll : Vertical` alone decides export. Unfiltered Company collection lists every open company regardless of SVCURRENTCOMPANY. Tally re-cases field tags (`TYPE` → `Type`).
- `xmls/TDKBillOutstanding.tdl`: round-1 probes replaced by `TDKProbeContext` (one fixed scrolling line: ACTIVE, VERSION, CURRENTCOMPANY = `##SVCurrentCompany`, COMPANYOBJECT = `$Name:Company:##SVCurrentCompany`) and `TDKProbeContextBills` (same line + bill lines repeated over `TDKBO Bills` in one scrolling part — candidate final syntax). Production reports unchanged (still 1.1.2).
- `scripts/tdl-layout-probe.js` rewritten: per requested company (plus a nonexistent name) calls both probes with the production bill static variables, prints full raw XML and a requested-vs-returned table.
- Desktop 95/95. Removal after diagnosis unchanged: marked TDL block, `scripts/tdl-layout-probe.js`, isolation test.

## 2026-10-03 — TEMPORARY TDL export-layout probe (branch `tdl`, diagnosis only)

- Windows test of 1.1.2: still `<ENVELOPE></ENVELOPE>` for health and no `TDKCONTEXT`; Yash 2,008 BILLROWs with matching Company → SUCCESS; Laveena preserved. Only lines repeated over `TDKBO Bills` inside the `Scroll : Vertical` part print.
- `xmls/TDKBillOutstanding.tdl`: appended a block between `TEMPORARY DIAGNOSTIC PROBES — BEGIN/END` markers with six reports `TDKProbe{Fixed,Bill,Company}{Scroll,NoScroll}` — identical except data source (none / `TDKBO Bills` / `TDKBO LoadedCompanies`) and `Scroll : Vertical`. No Report-level Variable. Production reports, version (1.1.2) and app behavior unchanged.
- `scripts/tdl-layout-probe.js` (temporary): calls each probe and the two production reports via HTTP Export/Data/XML, plain and with the production bill static variables; prints ID, request OK/FAILED, bytes, raw reply, and a PRINTS/EMPTY matrix.
- Test: probe objects live only inside the marked block and no app file references `TDKProbe`. Desktop 95/95.
- Removal after diagnosis: delete the marked TDL block, `scripts/tdl-layout-probe.js`, and the isolation test.

## 2026-10-03 — TDL 1.1.2: health and company context repeat over Company collections (branch `tdl`)

- Windows test of 1.1.1 on TallyPrime 7.0: after a clean Retry setup (`exeMatches: true`, cwd = install dir) health was still `<ENVELOPE></ENVELOPE>` and Laveena's bill reply had no `TDKCONTEXT`, so `Repeat` + `Set : 1` prints nothing over HTTP export. Safety rules held: Yash `COMPANY_UNVERIFIED` / `TDL_NOT_LOADED`, Laveena `LEGACY_EMPTY_AMBIGUOUS`, nothing cleared.
- `xmls/TDKBillOutstanding.tdl` 1.1.2: former fallback is now the installed file. Health repeats over `TDKBO LoadedCompanies` (`Type : Company`, one `TDKSTATUS` per loaded company); context repeats over `TDKBO CurrentCompany` (filter `$Name = ##SVCurrentCompany`, prints the company's real `$Name`). No `Set :` lines. `xmls/TDKBillOutstanding.alt-collection.tdl` removed.
- `util/tdlHealth.js`: `TDL_VERSION` 1.1.2.
- Tests: TDL file test rewritten for the collection form (all Part/Line/Field/Collection references defined, no `Set :`), health classification accepts multiple `TDKSTATUS` rows. Desktop 94/94.
- Risks: still unverified on real Tally; no company loaded → no health row → `HEALTH_UNCONFIRMED` (expected). Next: Windows Retry setup + `scripts/tdl-probe.js`.

## 2026-10-03 — TDL 1.1.1: one-row global health, company-verified bill snapshot, fallback bill fetch (branch `tdl`)

- Cause (Windows log): TDL 1.1.0 health report returned `<ENVELOPE></ENVELOPE>` — its line was static, so Tally printed nothing; the desktop then skipped bills entirely.
- `xmls/TDKBillOutstanding.tdl` 1.1.1: health line uses `Repeat` + `Set : 1`, no company field. Bill report adds a `TDKCONTEXT/COMPANY` line (`Repeat` + `Set : 1`, `##SVCurrentCompany`, printed even with zero bills) and a `Company` tag on every `BILLROW`. Fallback `xmls/TDKBillOutstanding.alt-collection.tdl` (repeats over Company collections) — not installed unless swapped in.
- `util/tdlHealth.js`: `TDL_VERSION` 1.1.1; request has no `SVCURRENTCOMPANY`; empty envelope / ACTIVE≠YES → new `HEALTH_UNCONFIRMED` (never ACTIVE, never NOT_LOADED); concurrent callers share one in-flight request (`[tdl] health deduped`). `checkTdlHealth({ post })` signature.
- `util/billSnapshot.js`: company identity from the bill response (`verifyBillCompany`). Decision: ACTIVE + verified rows → SUCCESS; ACTIVE + 0 + matching TDKCONTEXT → SUCCESS (clear); ACTIVE without proven company → `COMPANY_UNVERIFIED`; UNCONFIRMED + matching rows → SUCCESS with `tdlStatus: HEALTH_UNCONFIRMED`; UNCONFIRMED + 0 → `LEGACY_EMPTY_AMBIGUOUS`; legacy (no health report) + pre-1.1.1 rows → SUCCESS `ACTIVE_LEGACY`; any other company named → `COMPANY_CONTEXT_MISMATCH`. Logs `[tdl] bill fallback` / `[tdl] bill fallback result`. Backend contract unchanged.
- `util/xml.js`: one health check per sync run (`[tdl] sync health`), passed to every company's snapshot.
- Settings: `UNVERIFIED_SYNCING` state (badge "Not active in Tally", "Bill data is syncing, but add-on health could not be verified…"); `getTdlHealth` dedupes overlapping calls and logs `seq`; Settings skips a check while one is running. No render loop found for the ~25 calls (Settings checks once per open + once per Check now); `seq` will show the pattern on the next test.
- Retry setup: logs `[tdl] setup: launched` with the running tally.exe path vs expected (`start /D <tallyDir>` sets the working directory for the short `/TDL:` filename). Short filename kept.
- `util/schema.json`: `tallyInstallPath` (non-empty string) so the saved folder is no longer stripped at boot. `util/backendConfig.js`: no stale warning when BACKEND_URL equals the default dev backend.
- New `scripts/tdl-probe.js` (Windows QA): prints raw health + per-company bill XML and the desktop's classification. Read-only.
- Tested: `npm test` 94/94 (bill snapshot suite rewritten: 29); backend `bill-snapshot.test.js` 19/19 (unchanged). Real TallyPrime not yet verified.

---

## 2026-10-02 — TDL health check: log Tally's reply; find TDKSTATUS anywhere (branch `tdl`)

- Windows test: after Retry setup restarted Tally, every health check returned `INVALID_RESPONSE` with no detail, so Settings stayed "Not active in Tally" for every company.
- `util/tdlHealth.js`: when the result is not ACTIVE, logs `[tdl] health reply not active` with status, reason, byte count and the first 400 chars of Tally's reply. TDKSTATUS and its ACTIVE / VERSION / COMPANY tags are now found anywhere in the reply and in any tag case (before: only `ENVELOPE > TDKSTATUS`, exact case).
- `util/ensureBillOutstandingTdl.js`: `[tdl] health` / `[tdl] setup` logs include `reason`.
- Tested: `npm test` 79/79 (new case: TDKSTATUS without ENVELOPE / mixed-case tags → ACTIVE).

---

## 2026-10-01 — Settings TDL card: "Not active in Tally" instead of "Needs setup" (branch `tdl`)

- Bug: file installed + tally.ini linked + runtime not confirmed showed the badge **Needs setup** (old `statusLabel` fell through on any non-"ok" status) plus a red "Missing: TDL not active in running Tally".
- New `renderer/app/utils/tdlStatusView.js` — the only mapping from health → UI state (`READY`, `OUTDATED`, `NOT_ACTIVE`, `TALLY_UNREACHABLE`, `NOT_INSTALLED`, `NOT_LINKED`, `FOLDER_NOT_FOUND`, `NOT_REQUIRED`, `CHECKING`, `ERROR`) and its badge / row / message text; `setupResultNote` reports success only when the state is `READY`.
- `Settings.jsx`: badge, rows, helper message and post-setup note all come from the view model; old `statusLabel` / `statusTone` / `noteAfterSetup` and three hand-written banners removed. Buttons unchanged (Check now = read-only `tdlHealth`; Retry setup / Select Tally folder = `setupTdl`, which may restart Tally then re-checks health).
- `util/ensureBillOutstandingTdl.js`: `missing` lists disk/ini problems only; `__setDepsForTests` seam (platform, files, detect, apply, live status, health, activate). No flow change.
- QA YELLOW follow-ups: an IPC failure (`{status:"blocked", missing:[err]}`, no `path_unknown` reason) now maps to `ERROR` showing the error instead of "Tally folder not found"; tally.ini row shows "Needs quotes" when the path needs quoting.
- Tested: new `scripts/test-tdl-status-view.js` (8: not-confirmed → Not active in Tally, ACTIVE → Ready, Check now never restarts, Retry setup restarts + re-checks, no restart when already active, failed retry / failed restart never Ready); `npm test` 78/78; JSX compiles.

---

## 2026-10-01 — Bill Outstanding: sync never restarts Tally; per-company snapshot (branch `tdl`)

- **Cause of the Tally crash:** sync probed the bill report for the first selected company only; a company with no bills returns a bare `<ENVELOPE></ENVELOPE>`, which read as "TDL not loaded", so sync ran `taskkill tally.exe` + restart. Zero bills and failure were also the same `[]`, so stale bills were never cleared.
- TDL 1.1.0 (`xmls/TDKBillOutstanding.tdl`): new report `TDKBillOutstandingHealth` — always one `TDKSTATUS` line (`ACTIVE=YES`, `VERSION`, `REPORT`, `COMPANY=##SVCurrentCompany`). Bill report unchanged.
- New `util/tdlFiles.js` (folder detect, copy TDL, tally.ini link — no process control), `util/tdlHealth.js` (read-only health check, HTTP only), `util/billSnapshot.js` (per-company health + bill fetch → `SUCCESS` (rows or 0) / `TDL_NOT_LOADED` / `LEGACY_EMPTY_AMBIGUOUS` / `COMPANY_CONTEXT_MISMATCH` / `TALLY_UNREACHABLE` / `TALLY_TIMEOUT` / `INVALID_RESPONSE` / `PARSE_FAILED`). A bare envelope counts as zero bills only after the health report proved the TDL is loaded; every BILLROW tag must parse.
- Legacy add-on (no health report): rows → SUCCESS, `ACTIVE_LEGACY`; empty → ambiguous, bills kept; Settings suggests Retry setup.
- `util/xml.js`: sync only refreshes the TDL files; the restart path is gone. Each company gets its own snapshot (order-independent); only SUCCESS rows are uploaded. Chunks carry `Bill-Snapshot-Mode: staged`; `/ingest/complete` carries `billSnapshots: [{ companyGuid, status, snapshotComplete, rowCount, tdlStatus, tdlVersion }]`. Progress line names companies whose bills were kept.
- `util/ensureBillOutstandingTdl.js` is Settings-only (health card, Setup / Retry setup) and is the only module that can restart Tally; Retry setup restarts when the live status is not `ACTIVE` at the current version. Boot (`main.js`) installs files + logs a read-only health check.
- Settings card: "In Tally" shows Active / Active (old version) / Not loaded / Tally not reachable / Not confirmed, with Retry setup hints.
- Tested: new `scripts/test-bill-snapshot.js` (16, incl. order independence and "no sync path can reach the restart"); `npm test` 70/70; Settings.jsx compiles. Windows device QA pending (TDL 1.1.0 syntax has not run in real Tally yet).

---

## 2026-10-01 — Remove company asks first and updates mobile/web straight away

- Remove (row button and the multi-select bar) opens `RemoveCompaniesModal` (Cancel / Remove). Remove calls IPC `companies:remove` → `util/companyRemoval.js` → backend `POST /desktop/companies/remove` (15 s timeout); the main process drops the companies from the stored selection only after the backend confirms, then the renderer updates. Server unreachable / error / timeout → the company stays and the modal shows the message with "Try again". Unpaired (no device secret) → local only; the modal says so. Paired but workspace binding not loaded yet → refused ("Connecting to your workspace").
- Removal and sync exclude each other: removal is refused while `isSyncing` / a sync runs (checked when the warning opens, on confirm, and in main); `tally:start_sync` and the scheduled auto-sync refuse while a removal is in flight (`isRemovalInFlight`) — a sync carrying the company would reactivate it on the server.
- New pref `selectionClearedByUser` (schema + renderer allowlist), mirrored in a renderer ref: set when Remove empties the list, so the 5 s Tally refresh no longer re-selects the open company; cleared when companies are added again. `removeSelectedCompanies` updates `selectedCompaniesRef` and state together so the refresh can't write the old list back.
- `preload.js` `removeCompanies`; `companySelection.isDevicePaired` exported.
- Not changed: removed GUIDs stay in the backend lineage, so removing a synced company and adding a never-synced one in its place can still trip the "GUID changed" check (pre-existing). Live write-back wake-ups don't check the selection (pre-existing).
- Tested: `npm test` 54/54 (new `scripts/test-company-removal.js`, 12); renderer `vite build` ok. QA YELLOW → sync-during-warning, refresh race, binding-pending, guid||id, sync-starting window fixed; re-QA otherwise clean. Device test still needed.

---

## 2026-10-01 — Unpair keeps the selected companies; re-pair to another workspace asks first

- Before: every unpair (Desktop button, mobile/web unpair event, revoked binding) emptied the company selection, so a re-pair to the same workspace needed the companies picked again.
- `util/companySelection.js`: `clearWorkspaceBinding` drops the binding, `lastSync`, `myLastSyncEpoch` but keeps the list and its owning workspace. Re-pair to the same workspace keeps the list silently. Re-pair to a different workspace marks it pending (`isSelectionPending`): reads return [] so nothing syncs, the renderer's echo of [] is ignored, and `resolvePendingSelection(keep)` either hands the list to the new workspace or clears it. Every renderer write is ignored while pending (the Tally refresh auto-selects the current company, which is not the user's answer). Editing the list while unpaired keeps the owner; removing all of it clears it.
- `util/pairingRuntime.js`: unpair / no-binding emit the kept list; a pending list emits `companySelectionConfirm`. The claim now binds the workspace (`/desktop/me`, falling back to the claim's `workspace`) before `pairingClaimed`, otherwise the kept list read as current while unbound and synced into the new workspace.
- If the binding lookup has not landed after a re-pair (device secret present, no `boundWorkspaceId`, list has an owner), the kept list is on hold too (`isSelectionOnHold`): reads return [], writes are ignored; `syncWorkspaceBinding` always re-emits `selectedCompanies` once bound.
- `tally:start_sync` refuses with `COMPANY_SELECTION_PENDING` while on hold (renderer-supplied companies); the auto first sync after pair waits for the answer.
- IPC `companySelection:pending` / `companySelection:resolve` (`preload.js` `pendingCompanySelection` / `resolveCompanySelection`, `IPC_MAP.md`). Renderer `PreviousCompaniesModal` ("Use these companies" / "Clear list"), also re-checked at startup.
- Unchanged: syncing while unpaired stays blocked (`isDevicePaired`); Workspace Reset still clears the list.
- Tested: `npm test` 42/42 (12 selection tests new/rewritten); renderer `vite build` ok. QA found the unbound-after-claim leak and the Tally auto-select overwrite; both fixed. Device test still needed.

---

## 2026-10-01 — Dev backend IP 192.168.29.241 → .240

- The Mac's LAN IP changed, so the desktop showed "internet offline". `DEFAULT_DEV_BACKEND_URL` in `util/backendConfig.js`, `.env.example` and the docs now point at `http://192.168.29.240:3001`. A local `.env` `BACKEND_URL` still overrides it; production builds are unaffected.
- Tested: `scripts/verify-backend-config.js` passes; `/health` on .240 returns ok.

---

## 2026-09-30 — Multi-company sync: upload per company, one Tally request at a time

- **Upload per company** (`util/xml.js`): each selected company gets its own `/ingest` upload with a `Company-Guid` header on every chunk and `companyGuid` on `/ingest/complete`. Before, all companies went in one upload and the backend filed each 10k chunk under its first record's company.
- **Tally request queue** (`util/tallyQueue.js`): `getData`, `postToTally` and the TDL probe run one at a time, so parallel master fetches, the 5 s poll and write-backs can't be answered in another company's context.
- **Company names XML-escaped** in `SVCURRENTCOMPANY` and placeholder values (function replacers, no `$&` expansion).
- **Open-company check** before sync: only companies open in Tally are synced, under their current Tally name. Hard sync refuses (`company_not_open`) if any selected company is closed, since the backend purges before refetching. `/desktop/init-sync` still gets the full selection (QA fix: it marks companies missing from the list inactive, which would hide a skipped company from web/mobile).
- **Single sync lock** inside `syncTallyData` (`sync_in_progress`); foreground/auto start also check it. `tally:connected` / `tally:companies` answer from cache during a sync.
- Renderer keeps `companyNumber` (and refreshes name) on selected companies so the TDL restart can `/LOAD` the company.
- Tested: `npm test` 32 pass (new `scripts/test-tally-queue.js`). Not run against a live Tally.
- Risks: master fetch is now sequential (slower first phase); a company open under a different GUID is skipped.

---

## 2026-09-30 — Bill Outstanding pinned to today's date; placeholders in XML comments

**Cause (live):** Tally computes outstanding bills as of its own "current date" (F2). On the user's Tally it was 31-Mar-24, so Hard Sync saved 2,137 bills as of that date (none after it) → AR/AP for FY 2026-27 empty. Machine date was 30-Sep-26.
**Also:** `getData` does `xml.replace(key, value)` — first occurrence only. Placeholder names inside XML comments were replaced in the comment and never in the real tag: `BillOutstanding.xml` (FROM/TO dates), `SingleVoucher.xml` (master id filter), `StockFYBalance.xml` (FROM/TO dates).
**Files:** `util/xml.js` (`localYmd`, `$$CURRENT_DATE` in `syncHelperWithDate`), `xmls/BillOutstanding.xml` (`SVCURRENTDATE`), comment wording in the three XMLs.
**Tested:** filled `BillOutstanding.xml` exactly as `getData` does and sent it to live Tally with its current date forced to 31-Mar-24 → 2,008 bills up to 2026-09-30 incl. today's test bills (was 2,137 up to 2024-03-31).
**Risks:** `StockFYBalance` and `SingleVoucher` now actually receive their dates / master id — intended, but those syncs behave differently from before.

## 2026-09-30 — Bill Outstanding TDL exports credit period (raw Tally capture)

**Capture (live, read-only, Yash Ki Company, 2,008 bills):** `BILLCREDITPERIOD` is a "Due Date" value whose text is what the user typed ("15 Days", "120 Days"; blank if none — a typed due date is stored as a day count). Its `JD` is the bill date, not the due date. A party ledger's default credit period is copied onto new bills. `$$IsDr:$ClosingBalance` matched the raw sign (negative = Dr) on 2,008/2,008 bills; a formatted `$ClosingBalance` field loses the sign, so no SignedPending field.
**Files:** `xmls/TDKBillOutstanding.tdl` — new field `CreditPeriod` = `$BillCreditPeriod` (plain text, no date math in Tally). `util/xml.js` already passes it through; the backend computes due date = bill date + days.
**Tested:** the same field via an inline read-only report against live Tally — clean output for all bills, Tally stable.
**Risks:** Tally loads the TDL at startup — restart Tally once after the desktop copies the new file. With two companies open, a request for one company was briefly refused and one run mixed data from both; sync with one company open.

## 2026-09-30 — Sync Now / Hard Sync disabled after a reboot (startup race)

**Cause:** `main.js` runs `reconcileBinding("startup")` right after `createWindow()`. The backend answers in milliseconds and `emit("pairedDevice", …)` fires before the renderer has mounted its `window:listener`, so the message is dropped. The renderer never pulled pairing itself (init only hydrated `pairingCode`), so `pairedDevice` stayed `null` → `disableSyncButton` true → both buttons disabled. The only other re-emit (offline→online edge in `store:set isOnline`) never fired because `isOnline=true` was persisted from the previous session. Warm restarts usually won the race, cold boots lose it.
**Also:** `before-quit` doesn't run on reboot/power cut, so a persisted `isSyncing=true` made `tally:start_sync` reject with "A sync is already in progress".
**Fix:**
- New IPC `pairing:reconcile` (`api.reconcilePairing()`); `App.jsx` init calls it after its listener exists and sets `pairedDevice` from the result.
- `main.js` interactive startup resets `isSyncing` / `isRestoring` / `isBackingUp` to false (single-instance lock ⇒ nothing else is syncing) and `isOnline` to false so the first successful ping re-runs the pairing check when the network came up late.
**Tested:** `node --check`; `npm test` 29/29; `verify-backend-config.js` pass; renderer build OK. Backend logs confirm the Windows Desktop gets `pairing-device` 200 with a pairing on startup.

---

## 2026-09-30 — Dev backend LAN IP → 192.168.29.241

- Mac en0 is now `192.168.29.241`; `DEFAULT_DEV_BACKEND_URL` → `http://192.168.29.241:3001` and `.241` removed from `DEAD_BACKEND_HOSTS` (it was forcing dev back to the unreachable `.243`). Docs + `.env.example` updated.
- Tested: `http://192.168.29.241:3001/health` 200; `verify-backend-config.js` all pass; `npm test` 29/29.
- Packaged production builds are unaffected (always `https://api.tallydekho.com`).

---

## 2026-09-29 — Production readiness (update feed guard, logs, bill fields)

- `package.json` publish feed → `https://update-feed-not-configured.invalid/tallydekho/` placeholder; real URL at go-live. `isUpdateFeedConfigured()` makes `checkForUpdates` and the `updater:check` / `updater:download` IPC handlers skip while it's the placeholder; the check is wrapped in try/catch. **Shipped clients still poll `test.tallydekho.com` (baked `app-update.yml`) — keep that server up.**
- electron-log file level `info` in packaged builds; `[sync] data` logs counts only, not the full per-company / per-FY state.
- `build/` no longer git-ignored (licence tracked). Windows icons `icon.ico`, `icon2.ico`, `icon.png` are not on this machine — add from the Windows build box / new 1024 icon.
- Deleted dead `renderer/app/views/devices/Deployer.jsx` (held a Tally password — still in git history, rotate it).
- `util/xml.js` bill rows: `billSideOf` (SignedPending sign → DrCr label → LedgerGroup), pass-through `SignedPending`, `LedgerGroup`, `CreditPeriod` for when the TDL exports them. TDL unchanged until the raw capture session.
- Tested: `npm run verify:config` all pass (new check for the feed guard); `node --check` on touched files.

---

## 2026-09-19 — Snapshot branch `19-09-2026-final-code`

Pushed local `cursor` tip as `19-09-2026-final-code`. No billing-authority
code on Desktop this pass. LAN backend remains `http://192.168.29.243:3001`.

---

## 2026-09-19 — Desktop production remediation (pairing lifecycle + tenant)

**Branch:** `cursor` (local only — not pushed)
**Files:** `util/pairingLifecycle.js`, `util/pairingRuntime.js`, `util/companySelection.js`, `util/writeback.js`, `util/backendConfig.js`, `main.js`, `preload.js`, `util/ipcRegistry.js`, `util/socket.js`, `renderer/app/App.jsx`, `renderer/app/views/dashboard/PairingPanel.jsx`, `scripts/test-*.js`

**Behavior:**
- Main process owns pairing sessions (`expiresAt` authority, pre-expiry remint, generation guard, claim single-flight).
- Refresh-code workaround removed. Sleep/wake and network restore remint expired sessions.
- Unpair clears workspace-scoped `selectedCompanies`, lastSync and myLastSyncEpoch.
- Sync/Hard Sync disabled while unpaired.
- store IPC allowlisted. Unpackaged `electron .` fails closed instead of targeting production.
- Writeback reconciliation pull on startup/reconnect in addition to the socket wake-up.
- Cloud restore binds from the new backend credential and drops leftover local tenant state.
- Restore dest copy rolls back from the safety snapshot on failure; lastSync/epoch cleared after a successful file restore.
- `restore_approved` starts the same single-flight cloud restore as the PairingPanel button.
- Backup zip is written to `*.partial` then renamed; 7z exit 1 is no longer treated as success.
- Failed backup deletes partial and final staging files. Unix staging is chmod 600/700.
- Restore dest overwrite rolls back from a safety copy; rollback failure keeps the recovery copy and returns CRITICAL.
- Cloud restore checks size + SHA-256 + zip header before dest overwrite.
- Dead local-restore modal, ZipUpload, StartRestoreModal, `tally.startRestore` / `tally:restore_backup` removed.
- S3 upload PutObject now requests SSE-S3 AES256 (backend objectStore, storage configure only).

**Test:** `npm test` (config guards + node:test behavioral suite)

**Risks:** sandbox:true needs a real packaged/dev Electron smoke; backup/restore still needs real Tally + Owner approval for workspace replace.

---

## 2026-09-18 — Staging build path + auto-update safety

**Branch:** `cursor`
**Files:** `util/backendConfig.js`, `util/helper.js`, `main.js`, `package.json`, `scripts/set-build-env.js`, `scripts/verify-backend-config.js`

**Behavior:**
- Backend selection centralised in `resolveBackendEnvironment()`: `production`
  (default), `staging`, `development`, chosen via `TD_BACKEND_ENV` or a baked
  `td-env.json`. No arbitrary URL textbox is exposed in production.
- `npm run build:staging` bakes `{appEnv:"staging"}`; staging window title reads
  `TallyDekho — STAGING` so a tester cannot confuse it with production.
- A staging build refuses to resolve to `api.tallydekho.com`; invalid
  `TD_BACKEND_ENV` fails closed.
- **Auto-update disabled for non-production builds.** The electron-builder
  publish feed (`test.tallydekho.com/tallydekho/`) carries production artifacts
  only, and `autoUpdater.setFeedURL` is commented out so that baked config is the
  live feed. Without this guard a packaged staging build would poll it, offer an
  "update", and silently replace itself with the production client pointed at the
  production API mid-test. Gated in `checkForUpdates` (`util/helper.js`, the
  single choke point for all three call sites) and `configureUpdater` (`main.js`).

**Note:** the `test.tallydekho.com` feed is **active infrastructure** serving
shipped clients despite the misleading name. Do not delete it.

**Test:** `npm run verify:config` — 12 checks PASS, including the two new
update-feed guards.

**Risks:** no packaged staging build has been produced or installed yet; the
guards are verified by static assertion, not by running an installed staging app.

---

## 2026-09-17 — Pairing-code 409 while already paired

**Branch:** `cursor`
**Files:** `renderer/app/App.jsx`, `renderer/app/views/dashboard/PairingPanel.jsx`, `util/ipcRegistry.js`
**Behavior:** Startup / Refresh no longer request a pairing session when Desktop is already paired (was showing raw HTTP 409).
**Test:** Restart paired Desktop → no red 409; companies/pairing UI reflects paired state

---

## 2026-09-17 — Auto first soft sync after pair claim (selected cos + FY only)

**Branch:** `cursor`
**Files:** `renderer/app/App.jsx`
**Behavior:** On claim/ACK (`pairingClaimed`), Desktop confirms Tally online, refreshes company list, then auto soft-syncs **only** `selectedCompanies` with their selected FY years (never all Tally companies). If Tally is closed or selection empty, sets `pendingFirstSyncAfterPair` and retries when ready. Web/Mobile leave Demo when `init-sync` → CONNECTED (unchanged).
**Test:** Pair → no Sync tap → status becomes CONNECTED; Demo clears on Web/Mobile
**Risks:** Needs Desktop restart; empty selection still needs user to pick company/FY once

---

## 2026-09-17 — Stale pairing code after unpair / CLAIMED session

**Branch:** `cursor`
**Files:** `renderer/app/App.jsx`, `renderer/app/views/dashboard/PairingPanel.jsx`
**Behavior:** On `unpairedAlert`, clear displayed code and auto-fetch a fresh `/desktop/pairing-code` session. PairingPanel auto-refreshes once when unpaired so CLAIMED leftovers (e.g. 207185) are not shown.
**Test:** QA YELLOW; after unpair UI must not keep old digits
**Risks:** Needs Desktop restart/rebuild to pick up renderer changes

---

## 2026-09-17 — Force Mac LAN .243; reject Windows loopback BACKEND_URL

**Branch:** `cursor`
**Files:** `util/backendConfig.js`, `util/helper.js`, `.env.example`
**Behavior:** Dev hardcoded `http://192.168.29.243:3001`. If `.env` still has `127.0.0.1`/`localhost`, remap to `.243` (fixes Windows `xhr poll error`).
**Test:** Backend health 200 on `.243`; Windows must pull + restart Desktop
**Risks:** Mac DHCP off `.243` requires updating `DEFAULT_DEV_BACKEND_URL`

---

**Branch:** `cursor`
**Files:** `util/backendConfig.js`, `.env.example`, `API_USAGE.md`, `BLUEPRINT.md`, `KNOWN_ISSUES.md`
**Behavior:** Dev default is `http://192.168.29.243:3001` so Windows Desktop reaches Mac backend (loopback was ECONNREFUSED on Windows).
**Test:** Mac `*:3001` health 200 on `.243`; Windows must pull + restart Desktop
**Risks:** If Mac DHCP moves off `.243`, update `backendConfig.js` or Windows `.env`

---

## 2026-09-14 — Block dead .241 backend host; socket polling fallback

**Branch:** `cursor`
**Files:** `util/helper.js`, `main.js`, `util/socket.js`
**Behavior:**
- If `BACKEND_URL` still points at known-dead hosts (e.g. `192.168.29.241`), force loopback `http://127.0.0.1:3001` and log an error
- Socket.io client uses `polling` + `websocket` (was websocket-only)
- `connect_error` logs include `baseURL` for diagnosis
**Test:** node probe — `.241` timeout; `127.0.0.1` / `.243` connect ok
**Risks:** LAN Desktop on another PC must set `.env` to this Mac’s current IP (not loopback)

---

**Branch:** `cursor`
**Files:** `main.js`, `util/helper.js`, `KNOWN_ISSUES.md`, `BLUEPRINT.md`, `API_USAGE.md`
**Behavior:**
- `dotenv` loads from Desktop app root (`__dirname`), not process cwd — so `BACKEND_URL` in `.env` always applies
- Startup logs `Backend baseURL=…` (no secrets) for connectivity diagnosis
- Docs no longer advertise dead LAN IP `192.168.29.241`; loopback default + local `.env` for LAN
**Test:** After restart, Desktop log shows `baseURL=http://127.0.0.1:3001`; `/desktop/pairing-code` returns sessionId+claimToken
**Risks:** Packaged prod still uses `api.tallydekho.com` unless env override

---

## 2026-09-14 — Pairing session hygiene + env-driven backend URL

**Branch:** `cursor`
**Files:** `util/backendConfig.js`, `util/pairingSessionState.js`, `util/claimPairing.js`, `util/ipcRegistry.js`, `util/helper.js`, `util/socket.js`, `main.js`, `preload.js`, `renderer/app/App.jsx`, `PairingPanel.jsx`, `.gitignore`, `.env.example`
**Behavior:**
- Backend URL: loopback default only; LAN via local `.env` (`BACKEND_URL`) — `.env` untracked
- pairingCode/sessionId/claimToken are temporary in-memory; restart always fetches a fresh session
- Claim distinguishes PENDING vs EXPIRED/NOT_FOUND; no claimToken in logs (hasClaimToken only)
- claimToken never sent to renderer IPC
**Test:** HTTP Desktop E2E: session → PENDING claim → Owner approve → HTTP claim+ACK → RECONNECTING → CONNECTED
**Risks:** Requires Backend `PAIRING_SESSION_PENDING` code for quiet poll

---

## 2026-09-14 — Phase C pairing claim/ACK on cursor

**Branch:** `cursor`
**Files:** `util/claimPairing.js`, `util/socket.js`, `util/ipcRegistry.js`, `util/deviceCredential.js`, `preload.js`, `renderer/app/App.jsx`, `renderer/app/views/dashboard/PairingPanel.jsx`
**Behavior:**
- Short-lived pairing session: store `sessionId` + `claimToken` from `/desktop/pairing-code`
- `pairing_approved` wake-up → HTTP claim + ACK (secret not dependent on socket alone)
- App polls claim while unpaired; PairingPanel Refresh code; poll recovery updates UI
- Legacy `pairing_confirmed` still accepted when backend uses immediate-secret bridge
- Credential hygiene: safeStorage + AES-GCM fallback (no plaintext electron-store)
**Test:** Refresh code on Desktop → approve from Web/Mobile → Desktop claims → first sync → CONNECTED
**Risks:** Backend must run Phase B/C pairing service (claim/ack). Old permanent-code backend will not return claimToken.

---

## 2026-09-14 — Wave 3 Desktop credential hygiene (ported to cursor)

**Files:** `util/deviceCredential.js`, sync error unmask, Hard Sync single-flight
**Behavior:** Device secret OS/encrypted storage; sync errors show real codes; HS single-flight + continue-once
**Test:** Pair → secret not plaintext; unpair clears secret
**Risks:** Live Electron QA still needed for GREEN

---

## 2026-09-12 — Workspace binding + cloud backup/restore

**Files:** deviceCredential.js, workspaceCloud.js, saveBackup.js, restoreBackup.js, helper.js, socket.js, ipcRegistry.js, preload.js, Devices.jsx, BackupRestore.jsx, PairingPanel.jsx, Dashboard.jsx, App.jsx, Sidebar.jsx, IPC_MAP.md
**Behavior:** Device secret in OS secure storage; Connected Workspace UI; Hard Sync waits for Owner/Admin when multi-member; cloud backup upload (no machine-ID zip password); restore request/code on unpaired desktop; progress stages fixed (0–100). Tally XML/TDL unchanged.
**Test:** Pair from Web; Run Backup Now; restore code on a second desktop; Hard Sync still auto-runs for single-user workspaces.
**Risks:** Cloud list empty until backend is updated and a backup completes. S3 optional (`AWS_S3_BACKUP_BUCKET`); local object store used otherwise.

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
