const { ipcMain } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs").promises;
const FormData = require("form-data");
const fsSync = require("fs");

const {
  isTallyOpen,
  isOnlineHandler,
  axiosInstance,
  pollJobStatus,
} = require("./helper.js");
const {
  getCompanyDestinations,
  discoverCompanies,
  syncTallyData,
  isSyncRunning,
  stopTallySyncHandler,
} = require("./xml.js");
const { coordinator } = require("./jobCoordinator");
const getTallyVersionFromRegistry = require("./readTallyFromRegistry.js");
const {
  recreateBackupTaskCurrentUser,
  deleteTaskIfExists,
  createTaskEveryMinuteCurrentUser,
} = require("./backgroundRunner.js");
const store = require("./store.js");
const { info, error, logPath } = require("./logger.js");
const { startBackup } = require("./saveBackup.js");
const { getSelectedCompanies } = require("./companySelection.js");
const { getDeviceSecret } = require("./deviceCredential.js");

let tallyConnectStatus = false;
let lastDiscovery = null;

const SYNC_TYPES = ["sync", "hard_sync"];
// While these run, Tally is busy with the job's own requests (or being replaced):
// status polls answer from the last result instead of queueing more requests.
const TALLY_BUSY_TYPES = ["sync", "hard_sync", "restore", "tally_restart"];
const tallyBusy = () => coordinator.isActive(TALLY_BUSY_TYPES) || isSyncRunning();

/**
 * true/false from a real probe, or null while a Tally-busy job runs: the renderer
 * polls every 5 s and must not add requests between the job's own, and a cached
 * answer from before the job (or none at all in a headless launch) is not evidence
 * about Tally now.
 */
const tallyConnectedStatus = async () => {
  if (tallyBusy()) return null;
  tallyConnectStatus = await probeTally();
  return tallyConnectStatus;
};

// store.isSyncing mirrors the coordinator for code that only reads the store
// (window close prompt, older call sites). The coordinator is the authority.
coordinator.onChange(() => {
  const active = coordinator.isActive(SYNC_TYPES);
  if (store.get("isSyncing") !== active) store.set("isSyncing", active);
});

const { versionPolicy } = require("./syncPolicy");

/** Send to a window or webContents that may be missing (headless) or already destroyed. */
const sendTo = (target, channel, payload) => {
  try {
    const wc = target?.webContents || target;
    if (wc && typeof wc.send === "function" && !(wc.isDestroyed?.())) wc.send(channel, payload);
  } catch (_) { /* window gone */ }
};

const SYNC_CANCEL_CODES = new Set(["manually_stopped", "cancelled", "cancelled_by_user", "unpaired", "binding_revoked", "internet_is_offline", "tally_is_not_connected"]);

/** Terminal job state for a sync result. */
const syncJobState = (syncStatus) => {
  if (syncStatus?.status) return "succeeded";
  if (syncStatus?.partial) return "partial";
  const code = syncStatus?.code || syncStatus?.data?.code;
  if (SYNC_CANCEL_CODES.has(code)) return "cancelled";
  return "failed";
};

/** Tell the renderer how a finished sync ended. Called only after the job released. */
const reportSyncResult = (target, syncStatus) => {
  sendTo(target, "window:listener", { key: "syncProgress", value: 0 });
  if (syncStatus?.status) {
    const date = new Date();
    store.set("lastSync", date.toISOString());
    store.set("myLastSyncEpoch", Math.floor(Date.now() / 1000));
    sendTo(target, "window:listener", { key: "lastSync", value: date });
    // Before "Sync Complete": only these companies may be marked synced.
    sendTo(target, "window:listener", { key: "syncedCompanies", value: syncStatus.data?.companies || [] });
    sendTo(target, "window:listener", { key: "syncMessage", value: "Sync Complete" });
  } else if (syncStatus) {
    sendTo(target, "window:listener", {
      key: "syncingCurrentStatus",
      value: syncStatus.data || { code: syncStatus.code, message: syncStatus.message },
    });
  }
};

/** Coalesce overlapping probes (5 s poll, auto sync, manual start) into one Tally request. */
let probeInFlight = null;
const probeTally = () => {
  if (!probeInFlight) {
    probeInFlight = isTallyConnected().finally(() => {
      probeInFlight = null;
    });
  }
  return probeInFlight;
};

/**
 * A device with no stored credential cannot be paired, so background work is
 * skipped without a round trip. The backend remains the final authority.
 */
const isDevicePaired = () => !!getDeviceSecret();

/** Log company identity only — never addresses, contacts or GST numbers. */
const describeCompanies = (companies = []) =>
  `${companies.length} selected [${companies
    .map((c) => c?.guid || c?.id || "?")
    .join(", ")}]`;

const isTallyConnected = async () => {
  const status = await isTallyOpen();

  if (status) {
    const destination = await getCompanyDestinations();
    // console.dir(destination, {
    //   depth: null,
    //   colors: true,
    //   maxArrayLength: null,
    // });

    if (Object.keys(destination).length == 0) {
      return false;
    }
    const firstDestination = Object.values(destination)[0];
    const split = firstDestination.split("\\");
    split.pop();
    store.set("destination", split.join("\\\\"));
    return true;
  }
  return false;
};

ipcMain.handle("tally:version", async () => {
  let version;

  try {
    version = await getTallyVersionFromRegistry();
  } catch (err) {
    return "Not Found";
  }

  if (version.error) {
    return "Not Found";
  }

  return version.registryKey || `${version.product} ${version.displayVersion}`;
});

ipcMain.handle("tally:tdl_health", async () => {
  try {
    const { getTdlHealth } = require("./ensureBillOutstandingTdl");
    return await getTdlHealth();
  } catch (e) {
    error(e?.message || String(e), "tally:tdl_health");
    return {
      status: "blocked",
      level: "danger",
      message: e?.message || "TDL health check failed",
      missing: [e?.message || "unknown error"],
    };
  }
});

/** Setup may start Tally, so it never overlaps a sync, backup, restore or voucher refresh. */
async function runTdlSetup(dir) {
  const { setupTdl } = require("./ensureBillOutstandingTdl");
  const { coordinator } = require("./jobCoordinator");
  const run = await coordinator.run("tally_restart", { trigger: "manual" }, () => setupTdl(dir, { allowRestart: true }));
  if (!run.accepted) {
    return { status: "blocked", level: "warn", reason: "job_conflict", message: run.message, missing: [] };
  }
  if (run.error) throw run.error;
  return run.result;
}

ipcMain.handle("tally:tdl_setup", async () => {
  try {
    // Retry setup is the only place Tally may be started (official /TDL load, no manual F1).
    // A folder is only ever chosen in this process (tally:tdl_select_path), never passed in.
    return await runTdlSetup(null);
  } catch (e) {
    error(e?.message || String(e), "tally:tdl_setup");
    return {
      status: "blocked",
      level: "danger",
      message: e?.message || "TDL setup failed",
      missing: [e?.message || "unknown error"],
    };
  }
});

ipcMain.handle("tally:tdl_select_path", async () => {
  try {
    const { dialog } = require("electron");
    const { BrowserWindow } = require("electron");
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      title: "Select Tally Prime folder",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return { status: false, cancelled: true };
    }
    const health = await runTdlSetup(result.filePaths[0]);
    return { status: true, health };
  } catch (e) {
    error(e?.message || String(e), "tally:tdl_select_path");
    return { status: false, message: e?.message || String(e) };
  }
});

ipcMain.handle("tally:connected", () => tallyConnectedStatus());

/**
 * Typed discovery: { status: "ok" | "partial" | "unavailable", companies, observedAt, cached? }.
 * "ok" is evidence of which companies are open; "partial" only of the companies it
 * lists. The renderer keeps its selection unchanged for anything else.
 */
let discoveryInFlight = null;
ipcMain.handle("tally:companies", async (_event, opts = {}) => {
  const ledgerCountsFor = Array.isArray(opts?.ledgerCountsFor) ? opts.ledgerCountsFor.filter((g) => typeof g === "string").slice(0, 50) : null;
  if (!tallyConnectStatus) {
    return { status: "unavailable", reason: "tally_not_connected", companies: [], observedAt: new Date().toISOString() };
  }

  if (tallyBusy()) {
    return lastDiscovery
      ? { ...lastDiscovery, cached: true }
      : { status: "unavailable", reason: "tally_busy", companies: [], observedAt: new Date().toISOString() };
  }

  // A user-requested refresh (with counts) is not merged into a background poll.
  if (ledgerCountsFor?.length) {
    const result = await discoverCompanies({ ledgerCountsFor }).catch((err) => {
      error(err?.message, "tally:companies");
      return { status: "unavailable", reason: "discovery_failed", companies: [], observedAt: new Date().toISOString() };
    });
    if (result.status === "ok" || result.status === "partial") lastDiscovery = result;
    return result;
  }
  if (!discoveryInFlight) {
    discoveryInFlight = discoverCompanies()
      .catch((err) => {
        error(err?.message, "tally:companies");
        return { status: "unavailable", reason: "discovery_failed", companies: [], observedAt: new Date().toISOString() };
      })
      .finally(() => {
        discoveryInFlight = null;
      });
  }
  const result = await discoveryInFlight;
  if (result.status === "ok" || result.status === "partial") lastDiscovery = result;
  return result;
});

/** Current and recent jobs, for renderer hydration (a job may have started before the window). */
ipcMain.handle("job:current", () => coordinator.snapshot());

/** Stop = cancellation request. The job keeps its slot until it reaches a safe point. */
ipcMain.handle("tally:stop_sync", async (event, code) => {
  const result = stopTallySyncHandler(code);
  return { ok: !!result?.ok, jobs: result?.jobs || [] };
});

ipcMain.handle(
  "tally:save_auto_sync",
  async (event, { syncInterval, autoSyncStartedAt }) => {
    store.set("isAutoSync", true);
    store.set("syncInterval", Number(syncInterval));
    store.set("autoSyncStartedAt", Number(autoSyncStartedAt));
    try {
      await recreateBackupTaskCurrentUser(
        "TallyDekhoAutoSync",
        "\\",
        "sync",
        syncInterval
      );
    } catch (err) {}
  }
);

ipcMain.handle("tally:delete_auto_sync", async (event) => {
  store.set("isAutoSync", false);
  try {
    await deleteTaskIfExists("TallyDekhoAutoSync", "\\");
  } catch (err) {}
});

const CONFLICT_DIALOG_TIMEOUT_MS = 60_000;
const CONFLICT_STATUS_TIMEOUT_MS = 10_000;

/**
 * Did another Desktop sync any of these companies more recently than this one?
 * "unknown" when the server could not be asked: that is never read as "no conflict".
 */
const crossDeviceConflict = async (job, companies) => {
  const myLastSyncEpoch = store.get("myLastSyncEpoch") || 0;
  for (const company of companies || []) {
    const companyGuid = company?.guid || company?.id;
    if (!companyGuid) continue;
    let syncInfo;
    try {
      syncInfo = await axiosInstance.get(
        `/desktop/company-sync-status?companyGuid=${encodeURIComponent(companyGuid)}`,
        { timeout: CONFLICT_STATUS_TIMEOUT_MS, signal: job.signal }
      );
    } catch (err) {
      info("[sync] conflict status unknown", { companyGuid, message: err?.message });
      return { state: "unknown", company };
    }
    const data = syncInfo?.data?.data;
    if (!syncInfo?.data?.status || !data) return { state: "unknown", company };
    const { lastSyncedAt, isMyDevice } = data;
    if (lastSyncedAt && !isMyDevice && lastSyncedAt > myLastSyncEpoch + 60) return { state: "conflict", company };
  }
  return { state: "clear" };
};

/**
 * Interactive runs ask (without blocking the main process); no answer within a minute
 * (or a Stop) counts as Cancel. Returns true when the user chose to continue.
 */
const confirmCrossDeviceSync = async (job, windowContent, companies) => {
  const verdict = await crossDeviceConflict(job, companies);
  if (verdict.state === "clear") return true;
  if (job.isCancelled()) return false;
  const name = verdict.company?.name || verdict.company?.guid || "this company";
  const message = verdict.state === "conflict"
    ? `A different desktop synced "${name}" more recently.\n\nSyncing now may overwrite newer data. Proceed?`
    : `TallyDekho could not check whether another desktop synced "${name}" recently.\n\nSyncing now may overwrite newer data. Proceed?`;

  const { dialog, BrowserWindow } = require("electron");
  const parent = windowContent instanceof BrowserWindow ? windowContent : null;
  const signal = AbortSignal.any([job.signal, AbortSignal.timeout(CONFLICT_DIALOG_TIMEOUT_MS)]);
  job.setState("awaiting_confirmation");
  try {
    const options = {
      type: "question",
      buttons: ["Force Sync Anyway", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: verdict.state === "conflict" ? "Another device synced recently" : "Could not check other devices",
      message,
      signal,
    };
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    return response === 0 && !signal.aborted;
  } catch (_) {
    return false;
  } finally {
    job.setState("preparing");
  }
};

/** Unattended runs never ask: a conflict or an unknown status defers the run. */
const unattendedConflictDeferral = async (job, companies, target) => {
  const verdict = await crossDeviceConflict(job, companies);
  if (verdict.state === "clear") return null;
  const code = verdict.state === "conflict" ? "conflict_deferred" : "conflict_status_unknown";
  info(`Background [sync deferred]: ${code}`, { company: verdict.company?.guid || null });
  sendTo(target, "window:listener", {
    key: "syncMessage",
    value: verdict.state === "conflict"
      ? "Scheduled sync paused: another desktop synced more recently. Run Sync Now to continue."
      : "Scheduled sync paused: could not check other desktops. It will try again next time.",
  });
  return { state: "deferred", result: { status: false, code } };
};

/** Everything a manual / post-pair / post-write sync does once it owns the sync slot. */
const runForegroundSync = async (job, windowContent, { companies, isHardSync }) => {
  if (!isDevicePaired()) {
    return { status: false, code: "DEVICE_NOT_PAIRED", message: "This Desktop is not paired to a workspace." };
  }

  const status = await probeTally();
  info(`Foreground [tally status]: ${status}`);
  if (!status) return { status: false, code: "tally_not_connected" };

  if (!isHardSync && companies?.length > 0) {
    const proceed = await confirmCrossDeviceSync(job, windowContent, companies);
    if (!proceed) return { status: false, code: "cancelled_by_user" };
  }
  if (job.isCancelled()) return { status: false, code: job.stopCode() };

  if (isHardSync) {
    try {
      const reqRes = await axiosInstance.post("/desktop/hard-sync/request", {
        operation: "REBUILD",
        companies: (companies || []).map((c) => ({ guid: c.guid || c.id, name: c.name })),
      });
      const hs = reqRes.data?.data;
      if (!reqRes.data?.status) {
        return { status: false, code: reqRes.data?.code, message: reqRes.data?.message };
      }
      if (hs.requestStatus === "PENDING") {
        return {
          status: false,
          code: "HARD_SYNC_APPROVAL_REQUIRED",
          message: "Waiting for Owner/Admin approval",
          data: { requestId: hs.requestId },
        };
      }
      if (hs.requestStatus === "REJECTED") {
        return {
          status: false,
          code: "HARD_SYNC_REJECTED",
          message: "Hard Sync was rejected by Owner/Admin.",
          data: { requestId: hs.requestId },
        };
      }
      if (hs.requestStatus === "EXPIRED") {
        return {
          status: false,
          code: "HARD_SYNC_EXPIRED",
          message: "Hard Sync request expired. Request approval again.",
          data: { requestId: hs.requestId },
        };
      }
      // APPROVED / alreadyApproved: continue; the coordinator already rejects concurrent starts.
    } catch (err) {
      const body = err?.response?.data;
      return {
        status: false,
        code: body?.code || "HARD_SYNC_APPROVAL_REQUIRED",
        message: body?.message || err.message,
      };
    }
  }
  if (job.isCancelled()) return { status: false, code: job.stopCode() };

  store.set("syncMode", isHardSync ? "hard" : "normal");
  job.setState("running");
  info(`Foreground [companies]: ${describeCompanies(companies)}`);

  const syncStatus = await syncTallyData(windowContent, companies, isHardSync);
  info(`Foreground [sync status]: ${syncStatus.status}`);
  info(`Foreground [sync status data]:`, syncStatus.data);

  return {
    ...syncStatus,
    code: syncStatus.code || syncStatus.data?.code,
    message: syncStatus.message || syncStatus.data?.message,
    ran: true,
  };
};

const registerTallySync = (windowContent) => {
  ipcMain.handle(
    "tally:start_sync",
    async (event, { companies, isHardSync } = {}) => {
      info("Foreground [sync]");

      if (require("./companyRemoval").isRemovalInFlight()) {
        return {
          status: false,
          code: "COMPANY_REMOVAL_IN_PROGRESS",
          message: "A company is being removed. Try syncing again in a moment.",
        };
      }
      // Renderer-supplied companies: refuse while a kept list is not yet confirmed for this workspace.
      if (require("./companySelection").isSelectionOnHold()) {
        return {
          status: false,
          code: "COMPANY_SELECTION_PENDING",
          message: "Confirm the company list for this workspace first.",
        };
      }

      // Synchronous admission: a second start is refused here and never touches the running job.
      const admission = coordinator.admit(isHardSync ? "hard_sync" : "sync", {
        trigger: "manual",
        scope: { companies: (companies || []).map((c) => c?.guid || c?.id) },
        policy: versionPolicy,
      });
      if (!admission.accepted) {
        info(`Foreground [sync rejected]: ${admission.code}`);
        const busy = admission.code === "JOB_ALREADY_RUNNING" || admission.code === "JOB_CONFLICT";
        return {
          status: false,
          rejected: true,
          code: busy ? "HARD_SYNC_IN_FLIGHT" : admission.code,
          message: admission.message,
          activeJob: admission.activeJob,
        };
      }

      const run = await coordinator.execute(admission.job, async (job) => {
        const result = await runForegroundSync(job, windowContent, { companies, isHardSync });
        return { state: result.ran ? syncJobState(result) : result.status ? "succeeded" : "failed", result };
      });
      const result = run.result?.status !== undefined
        ? run.result
        : { status: false, code: run.result?.code || "JOB_FAILED", message: run.result?.message };
      // Reported only after the slot is released, so "Sync Complete" can never race a new start.
      if (result.ran) reportSyncResult(windowContent, result);
      const { ran, ...response } = result;
      return { ...response, jobId: run.job?.id };
    }
  );
};

/**
 * A progress target that follows whichever window is open now, so a UI opened
 * while a scheduled/headless job runs still sees its progress.
 */
const liveTarget = (getWindow) => ({
  isDestroyed: () => {
    const win = typeof getWindow === "function" ? getWindow() : null;
    return !win || win.isDestroyed();
  },
  send: (channel, payload) => sendTo(typeof getWindow === "function" ? getWindow() : null, channel, payload),
});

/** Scheduled task fired while the UI instance is running (second-instance --run-sync). */
const startAutoSync = async (getWindow) => {
  if (!isDevicePaired()) {
    info("Background [sync skipped]: device not paired");
    return { status: false, code: "DEVICE_NOT_PAIRED" };
  }
  if (require("./companyRemoval").isRemovalInFlight()) {
    info("Background [sync skipped]: company removal in progress");
    return { status: false, code: "COMPANY_REMOVAL_IN_PROGRESS" };
  }

  // Admission before any probe: a busy Desktop does not add requests to Tally's queue.
  const admission = coordinator.admit("sync", { trigger: "scheduled", policy: versionPolicy });
  if (!admission.accepted) {
    info(`Background [sync skipped]: ${admission.code}`);
    return { status: false, code: admission.code };
  }

  const target = liveTarget(getWindow);
  const run = await coordinator.execute(admission.job, async (job) => {
    const status = await probeTally();
    const isOnline = store.get("isOnline");
    info(`Background [tally status]: ${status}`);
    info(`Background [online status]: ${isOnline}`);
    if (!status || !isOnline) {
      return { state: "failed", result: { status: false, code: status ? "offline" : "tally_not_connected" } };
    }
    const companies = getSelectedCompanies();
    info(`Background [companies]: ${describeCompanies(companies)}`);
    const deferral = await unattendedConflictDeferral(job, companies, target);
    if (deferral) return deferral;
    job.setState("running");
    const syncStatus = await syncTallyData(target, companies);
    info(`Background [sync status]: ${syncStatus.status}`);
    info(`Background [sync status data]:`, syncStatus.data);
    return { state: syncJobState(syncStatus), result: { ...syncStatus, ran: true } };
  });

  if (run.result?.ran) reportSyncResult(target, run.result);
  return run.result;
};

const startAutoSyncHeadless = async (getWindow) => {
  if (!isDevicePaired()) {
    info("Headless [sync skipped]: device not paired");
    return { state: "rejected", code: "DEVICE_NOT_PAIRED" };
  }

  const admission = coordinator.admit("sync", { trigger: "headless", policy: versionPolicy });
  if (!admission.accepted) {
    info(`Headless [sync skipped]: ${admission.code}`);
    // Another job already runs (it covers this trigger) → deferred; a policy refusal → rejected.
    const busy = admission.code === "JOB_ALREADY_RUNNING" || admission.code === "JOB_CONFLICT";
    return { state: busy ? "deferred" : "rejected", code: admission.code };
  }

  const run = await coordinator.execute(admission.job, async (job) => {
    const status = await probeTally();
    info(`Headless [tally status]: ${status}`);
    if (!status) return { state: "failed", result: { code: "tally_not_connected" } };

    const isOnline = await isOnlineHandler();
    info(`Headless [online status]: ${isOnline}`);
    if (!isOnline) return { state: "failed", result: { code: "offline" } };

    const companies = getSelectedCompanies();
    info(`Headless [companies]: ${describeCompanies(companies)}`);
    const deferral = await unattendedConflictDeferral(job, companies, liveTarget(getWindow));
    if (deferral) return deferral;

    job.setState("running");
    const syncStatus = await syncTallyData(liveTarget(getWindow), companies);

    info(`Headless [sync status]: ${syncStatus.status}`);
    info(`Headless [sync status data]:`, syncStatus.data);

    if (syncStatus.status) {
      job.setState("verifying");
      try {
        const { status, attempts, message } = await pollJobStatus({
          url: `/ingest/status/${syncStatus.data.uploadId}`,
          fetchOptions: {
            method: "GET",
          },
        });
        if (status) store.set("lastSync", new Date().toISOString());
        info(
          `Status: ${status} | Upload Id: ${syncStatus.data.uploadId} | Attempts: ${attempts} | Message: ${message}`
        );
      } catch (err) {
        info("Polling failed:", err.message);
      } finally {
        store.set("uploadId", "none");
      }
    }
    return { state: syncJobState(syncStatus), result: syncStatus };
  });

  return { state: run.job?.state || "failed", code: run.result?.code || run.result?.data?.code || null };
};

ipcMain.handle(
  "tally:save_auto_backup",
  async (event, { backupInterval, autoBackupStartedAt }) => {
    store.set("backupInterval", backupInterval);

    const days =
      {
        off: 0,
        "1day": 1,
        "7days": 7,
        "1month": 30,
      }[backupInterval] || 0;

    if (days > 0) {
      store.set("autoBackupStartedAt", autoBackupStartedAt);

      try {
        await recreateBackupTaskCurrentUser(
          "TallyDekhoAutoBackup",
          "\\",
          "backup",
          0,
          days
        );
      } catch (err) {}
    } else {
      await deleteTaskIfExists("TallyDekhoAutoBackup", "\\");
    }
  }
);

/** Scheduled/headless triggers run only when a backup is actually due (no churn on repeats). */
const scheduledBackupDue = (trigger) => {
  const { backupDue, readScheduleState } = require("./backupSchedule");
  const verdict = backupDue(readScheduleState(store), Date.now());
  if (!verdict.due) info(`Background [${trigger} backup skipped: ${verdict.reason}]`);
  return verdict.due;
};

const startAutoBackup = async (getWindow) => {
  if (!scheduledBackupDue("scheduled")) {
    return { status: false, data: null, code: "BACKUP_NOT_DUE", message: "Backup not due" };
  }
  // Admission (inside startBackup) refuses while a sync, restore or backup is running.
  const response = await startBackup(liveTarget(getWindow), { trigger: "scheduled" });

  info(
    `Background [backup status: ${response.status} | code: ${response.code || "-"} | message:  ${response.message}]`
  );
  return response;
};

const startAutoBackupHeadless = async (getWindow) => {
  const isOnline = await isOnlineHandler();

  info(`Headless [online status]: ${isOnline}`);

  if (!isOnline) {
    return { state: "deferred", code: "offline" };
  }
  if (!scheduledBackupDue("headless")) return { state: "not_due" };

  const response = await startBackup(liveTarget(getWindow), { trigger: "headless" });

  info(
    `Headless [backup status: ${response.status} | code: ${response.code || "-"} | message:  ${response.message}]`
  );

  if (response.status) return { state: "succeeded" };
  const busy = response.code === "JOB_ALREADY_RUNNING" || response.code === "JOB_CONFLICT";
  return { state: busy ? "deferred" : "failed", code: response.code || null };
};

/**
 * Asks Task Scheduler to run a missed weekly/monthly backup. Called explicitly by
 * the interactive primary instance only — requiring this module has no side effects.
 */
const startMissedBackupIfDue = () => {
  const backupInterval = store.get("backupInterval");
  if (["7days", "1month"].includes(backupInterval)) {
    const { backupDue, readScheduleState } = require("./backupSchedule");
    const now = Date.now();
    const verdict = backupDue(readScheduleState(store), now, { missed: true });

    if (verdict.due) {
      store.set("lastMissedBackupTriggerAt", now);
      info(`Background [missed backup started: ${verdict.reason}]`);
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Start-ScheduledTask -TaskName 'TallyDekhoAutoBackup'",
        ],
        { windowsHide: true },
        () => {}
      );
    }
  }
};

/**
 * Read-only snapshot for renderer hydration on mount. The main process owns
 * the pairing session; the renderer never triggers a mint and never sees the
 * claim token.
 */
ipcMain.handle("api:pairing_state", async () => {
  const { getStatus } = require("./pairingLifecycle");
  const status = getStatus();
  return {
    status: true,
    data: {
      pairingCode: status.pairingCode,
      expiresAt: status.expiresAt,
      running: status.running,
    },
  };
});

// The startup reconcile can finish before the renderer registers its listener
// (cold boot), so the renderer re-runs it once it is listening.
ipcMain.handle("pairing:reconcile", async () => {
  try {
    const { reconcileBinding } = require("./pairingRuntime");
    const result = await reconcileBinding("renderer-ready");
    return { status: true, reachable: result.reachable, data: result.paired };
  } catch (err) {
    error(err?.message, "pairing:reconcile");
    return { status: false, reachable: false, data: null };
  }
});

// Companies selected for a previous workspace, held back after re-pairing to a
// different one until the user answers the prompt.
ipcMain.handle("companySelection:pending", () => {
  const { getPendingSelection } = require("./companySelection");
  const companies = getPendingSelection();
  return { pending: companies.length > 0, companies };
});

ipcMain.handle("companySelection:resolve", (_event, keep) => {
  const { resolvePendingSelection } = require("./companySelection");
  const companies = resolvePendingSelection(keep === true);
  info(`[pairing] previous company selection ${keep === true ? "kept" : "cleared"} for this workspace`);
  return { companies };
});

ipcMain.handle("companies:remove", async (_event, guids) => {
  const { removeCompanies } = require("./companyRemoval");
  const result = await removeCompanies(guids);
  if (result.ok) {
    info(`[companies] removed ${result.removed.length} company(ies)${result.localOnly ? " locally (unpaired)" : " from workspace"}`);
  } else {
    error(`${result.code}: ${result.message}`, "companies:remove");
  }
  return result;
});

ipcMain.handle("api:paired_device", async () => {
  try {
    const response = await axiosInstance.get("/desktop/pairing-device");
    const { mapPairedDevice } = require("./pairingRuntime");
    return { status: true, data: mapPairedDevice(response.data?.data?.pairing) };
  } catch (err) {
    error(err?.message, "paired_device");
    return { status: false };
  }
});

ipcMain.handle("api:remove_paired_device", async () => {
  let response;

  try {
    response = await axiosInstance.delete("/desktop/paired-device");
    response = response.data;
  } catch (err) {
    error(err?.message, "remove_paired_device");
    return { status: false };
  }

  const { clearDeviceSecret } = require("./deviceCredential");
  clearDeviceSecret();
  try {
    require("./pairingSessionState").clearPairingSession();
    store.delete("workspace");
  } catch (_) {}

  // Actual unpair: drop the workspace binding (the company selection stays for
  // the user to keep or remove), then start a fresh pairing session.
  await require("./pairingRuntime").handleUnpaired("unpair");

  return {
    status: true,
  };
});

// AI Chat — canonical POST /api/ai/help (legacy /app/ai/chat never existed on server)
ipcMain.handle("api:ai_chat", async (event, { messages }) => {
  try {
    const history = Array.isArray(messages) ? messages.slice(0, -1) : [];
    const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
    const message = last?.content || last?.text || '';
    const response = await axiosInstance.post("/api/ai/help", { message, history });
    return response.data?.data?.reply || response.data?.reply || response.data?.data?.answer || 'No response.';
  } catch (err) {
    error(err?.message, "api:ai_chat");
    return 'Could not connect to AI assistant. Make sure the backend is running.';
  }
});

// Fetch real user profile from backend via device-id (no token needed)
ipcMain.handle("api:user_profile", async () => {
  try {
    const response = await axiosInstance.get("/desktop/me");
    return { status: true, data: response.data?.data || null };
  } catch (err) {
    error(err?.message, "api:user_profile");
    return { status: false };
  }
});

ipcMain.handle("tally:hard_sync_status", async (_e, requestId) => {
  const response = await axiosInstance.get("/desktop/hard-sync/status", { params: { requestId } });
  return response.data;
});

ipcMain.handle("tally:backup_list", async () => {
  const response = await axiosInstance.get("/desktop/backup/list");
  return response.data;
});

ipcMain.handle("api:send_logs", async () => {
  const infoFile = logPath("info");

  const form = new FormData();
  form.append("file", fsSync.createReadStream(infoFile));

  // const headers = form.getHeaders();

  let response;

  try {
    response = await axiosInstance.post("/desktop/logs", form);

    await fs.truncate(infoFile, 0);
  } catch (err) {
    error("send_logs", { message: err?.message, data: err.response?.data });
    return { status: false };
  }

  return { status: true };
});

// (() => {
//   const path = require("path");
//   const fs = require("fs");

//   let yaml = "";

//   yaml += "provider: generic\n";
//   yaml += "url: your_site/update/windows_64\n";
//   yaml += "useMultipleRangeRequest: false\n";
//   yaml += "channel: latest\n";
//   yaml += "updaterCacheDirName: " + app.getName();

//   let update_file = [path.join(process.resourcesPath, "app-update.yml"), yaml];
//   let dev_update_file = [
//     path.join(process.resourcesPath, "dev-app-update.yml"),
//     yaml,
//   ];
//   let chechFiles = [update_file, dev_update_file];

//   for (let file of chechFiles) {
//     if (!fs.existsSync(file[0])) {
//       fs.writeFileSync(file[0], file[1], () => {});
//     }
//   }
// })();

module.exports = {
  registerTallySync,
  startAutoSync,
  startAutoSyncHeadless,
  startAutoBackup,
  startAutoBackupHeadless,
  startMissedBackupIfDue,
};
