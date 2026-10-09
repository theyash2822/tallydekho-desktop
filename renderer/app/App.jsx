import React, { useEffect, useRef, useState } from "react";

import TitleBar from "./views/components/TitleBar";
import Sidebar from "./views/components/Sidebar";
import Dashboard from "./views/dashboard/Dashboard";
import BackupRestore from "./views/backup/BackupRestore";
import Devices from "./views/devices/Devices";
import Settings from "./views/settings/Settings";
import Help from "./views/help/Help";
import { formatDateTime } from "./utils/datetime";
import { TallyContext, deriveSyncState } from "./utils/TallyContext";
import AlertModal from "./views/components/AlertModal";
import SyncErrorModal from "./views/components/SyncErrorModal";
import { CODE_ERROR_MESSAGE } from "./utils/helper";
import VersionUpdateModal from "./views/components/VersionUpdateModal";
import ForceUpdateModal from "./views/components/ForceUpdateModal";
import PreviousCompaniesModal from "./views/components/PreviousCompaniesModal";
import { mergeDiscovery, activeSyncJob } from "./utils/selectionMerge";

export default function App() {
  const [state, setState] = useState({
    active: "dashboard",
    isTallyOnline: false,
    isOnline: false,
    companies: [],
    selectedCompanies: [],
    version: "",
    port: 9000,
    isSyncing: false,
    syncMode: "normal",
    syncProgress: 0,
    lastSync: null,
    isAutoSync: false,
    // nextSync: null,
    syncInterval: 10,
    autoSyncStartedAt: null,
    isBackingUp: false,
    backupInterval: "off",
    autoBackupStartedAt: null,
    backupProgress: 0,
    backupAndRestoreActivity: [],
    backups: [],
    cloudBackups: [],
    workspace: null,
    hardSyncRequestId: null,
    hardSyncWaitMessage: "",
    restoreCode: null,
    backupStage: "",
    restoreStage: "",
    isRestoring: false,
    restoreProgress: 0,
    appVersion: "1.0.0",
    pairingState: "hidden",
    pairingCode: null,
    pairingBackendError: "",
    pairedDevice: null,
    pairingClaimed: null,
    pendingFirstSyncAfterPair: false,
    isVersionUpdateModalOpen: false,
    syncMessage: "",
    isCloseConfirmationModalOpen: false,
    forceUpdate: false,
    isForceUpdateModalOpen: false,
    versionLevel: 0,       // 0=ok, 1=update available, 2=sync blocked, 3=force update
    versionMessage: "",
  });

  const [isHardSyncConfirmationModalOpen, setIsHardSyncConfirmationModalOpen] =
    useState(false);
  const [alertModalData, setAlertModalData] = useState({
    isOpen: false,
    message: null,
    sendLogs: false,
  });
  // { companies, workspaceName } while the previous workspace's selection awaits an answer.
  const [previousCompanies, setPreviousCompanies] = useState(null);
  const [resolvingPreviousCompanies, setResolvingPreviousCompanies] = useState(false);
  const previousCompaniesRef = useRef(null);
  useEffect(() => {
    previousCompaniesRef.current = previousCompanies;
  }, [previousCompanies]);

  const selectedCompaniesRef = useRef([]);
  // null until read from the store; true once Remove emptied the list on purpose.
  const selectionClearedByUserRef = useRef(null);
  const isSyncingRef = useRef(false);
  const isInitCompleted = useRef(false);
  const hardSyncContinueOnceRef = useRef(null);
  const hardSyncRequestIdRef = useRef(null);
  const lineageMismatchRef = useRef(null);
  const autoFirstSyncInFlightRef = useRef(false);
  const autoFirstSyncClaimTokenRef = useRef(null);
  /** Once first soft sync has been kicked for this bind, ignore late duplicate pairingClaimed. */
  const autoFirstSyncStartedForBindRef = useRef(null);
  /** "name|oldGuid|newGuid" pairs already alerted this session. */
  const identityAlertedRef = useRef(new Set());

  const {
    active,
    isSyncing,
    selectedCompanies,
    pairedDevice,
  } = state;

  useEffect(() => {
    // navigator.onLine is unreliable in Electron on Windows — don't blindly trust it.
    // Only use it as a hint to trigger the backend ping check sooner.
    const onNetworkChange = async () => {
      if (!window.api) return;
      try {
        const reachable = await window.api.pingBackend();
        updateState("isOnline", reachable);
        window.api?.setPref("isOnline", reachable);
        if (!reachable && isSyncingRef.current) stopSync("internet_is_offline");
      } catch {}
    };

    window.addEventListener("online",  onNetworkChange);
    window.addEventListener("offline", onNetworkChange);

    return () => {
      window.removeEventListener("online",  onNetworkChange);
      window.removeEventListener("offline", onNetworkChange);
    };
  }, []);

  useEffect(() => {
    updateTallyStatus();
    const timer = setInterval(() => updateTallyStatus(), 5000);
    return () => clearInterval(timer);
  }, []);

  // Backend connectivity check every 15s — requires 2 consecutive failures to mark offline
  // (prevents false "disconnected" flicker from a single slow ping)
  useEffect(() => {
    if (!window.api) return;
    let failCount = 0;
    const checkBackend = async () => {
      try {
        const reachable = await window.api.pingBackend();
        // Use backend ping as the source of truth — navigator.onLine is unreliable in Electron on Windows
        const current = reachable;
        if (current) {
          failCount = 0; // reset on success
          updateState("isOnline", true);
          window.api?.setPref("isOnline", true);
        } else {
          failCount++;
          if (failCount >= 2) {
            updateState("isOnline", false);
            window.api?.setPref("isOnline", false);
            if (isSyncingRef.current) stopSync("internet_is_offline");
          }
        }
      } catch {
        // pingBackend unavailable in dev without IPC — fall back to browser value
      }
    };
    checkBackend();
    const backendTimer = setInterval(checkBackend, 15_000);
    return () => clearInterval(backendTimer);
  }, []);

  useEffect(() => {
    if (isInitCompleted.current && window.api) {
      window.api.setPref("selectedCompanies", selectedCompanies);
      selectedCompaniesRef.current = selectedCompanies;
    }
  }, [selectedCompanies]);

  // Post-write sync: fires after a successful tally:write to pull Tally's auto-assigned
  // voucher number back into app_vouchers via ingestProcessor reconciliation.
  // Uses refs so the effect always sees current isSyncing / selectedCompanies without stale closures.
  useEffect(() => {
    if (!window.tally || !state.triggerPostWriteSync) return;
    if (isSyncingRef.current) return; // ongoing sync will pick it up
    const companies = selectedCompaniesRef.current;
    if (!companies?.length) return;
    window.tally.startSync({ companies, isHardSync: false });
  }, [state.triggerPostWriteSync]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    isSyncingRef.current = isSyncing;
  }, [isSyncing]);

  // isSyncing mirrors the main-process job coordinator; the renderer never sets it false itself.
  const applyJobSnapshot = (snapshot) => {
    const job = activeSyncJob(snapshot);
    isSyncingRef.current = !!job;
    updateState("isSyncing", !!job);
    updateState("syncJob", job);
    if (job) {
      updateState("syncMode", job.type === "hard_sync" ? "hard" : "normal");
      if (job.cancelRequested) updateState("syncMessage", "Stopping…");
    }
  };

  const refreshJobState = async () => {
    try {
      const snapshot = await window.tally?.currentJob?.();
      if (snapshot) applyJobSnapshot(snapshot);
    } catch (_) {}
  };

  useEffect(() => {
    if (!window.tally?.onJobChanged) return undefined;
    refreshJobState();
    const off = window.tally.onJobChanged((payload) => applyJobSnapshot(payload?.snapshot));
    return () => off && off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    hardSyncRequestIdRef.current = state.hardSyncRequestId;
  }, [state.hardSyncRequestId]);

  const continueHardSyncOnce = async (requestId) => {
    if (!requestId) return;
    const waitingId = hardSyncRequestIdRef.current;
    if (waitingId && String(waitingId) !== String(requestId)) return;
    if (hardSyncContinueOnceRef.current === requestId) return;
    if (isSyncingRef.current) return;
    hardSyncContinueOnceRef.current = requestId;
    updateState("hardSyncWaitMessage", "Approved by Workspace administrator. Starting full sync...");
    updateState("hardSyncRequestId", null);
    const mismatch = lineageMismatchRef.current;
    await window.tally.startSync({
      companies: selectedCompaniesRef.current,
      isHardSync: true,
      guidReplacement:
        mismatch?.reason === "guid_replacement_candidate"
          ? {
              operation: "GUID_REPLACEMENT",
              oldGuid: mismatch.missing?.[0] || null,
              newGuid: mismatch.extra?.[0] || null,
            }
          : undefined,
    });
  };

  useEffect(() => {
    // Guard: window.api/tally only exist inside Electron (preload.js).
    // In browser dev mode they are undefined — skip init gracefully.
    if (!window.api || !window.tally) {
      console.warn('[TallyDekho] Preload not available — running outside Electron?');
      return;
    }
    const init = async () => {
      const version = await window.tally.version();
      const isAutoSync = await window.api.getPref("isAutoSync");
      const syncInterval = await window.api.getPref("syncInterval");
      const selectedCompanies = await window.api.getPref("selectedCompanies");
      const lastSync = await window.api.getPref("lastSync");
      // const nextSync = await window.api.getPref("nextSync");
      const autoSyncStartedAt = await window.api.getPref("autoSyncStartedAt");
      const autoBackupStartedAt = await window.api.getPref(
        "autoBackupStartedAt"
      );

      const backupInterval = await window.api.getPref("backupInterval");
      const backupAndRestoreActivity = await window.api.getPref(
        "backupAndRestoreActivity"
      );
      const backups = await window.api.getPref("backups");
      const appVersion = await window.api.getPref("appVersion");
      const syncMode = await window.api.getPref("syncMode");
      const forceUpdate = await window.api.getPref("forceUpdate");
      const port = await window.api.getPref("port");
      if (Number.isInteger(port)) updateState("port", port);

      if (isAutoSync) {
        updateState("isAutoSync", isAutoSync);
        updateState("syncInterval", syncInterval);
        updateState("autoSyncStartedAt", autoSyncStartedAt);
      }

      if (lastSync) {
        updateState("lastSync", new Date(lastSync));
      }

      // if (nextSync) {
      //   updateState("nextSync", new Date(nextSync));
      // }

      updateState("version", version);
      updateState("selectedCompanies", selectedCompanies);

      updateState("backupInterval", backupInterval);
      updateState("backupAndRestoreActivity", backupAndRestoreActivity);
      updateState("backups", backups);
      updateState("autoBackupStartedAt", autoBackupStartedAt);
      updateState("appVersion", appVersion);
      updateState("syncMode", syncMode || "normal");

      if (forceUpdate) {
        updateState("isForceUpdateModalOpen", true);
        updateState("active", "settings");
      }

      // Version level: 2 = sync blocked, 3 = force update (already handled above)
      const versionLevel = await window.api.getPref("versionLevel") || 0;
      const versionMessage = await window.api.getPref("versionMessage") || "";
      updateState("versionLevel", versionLevel);
      updateState("versionMessage", versionMessage);

      isInitCompleted.current = true;

      // Pairing is owned by the main process: hydrate whatever session is
      // already live, then follow the pushes on `window:listener`.
      try {
        const snapshot = await window.api.pairingState?.();
        updateState("pairingCode", snapshot?.data?.pairingCode || null);
      } catch (_) {
        updateState("pairingCode", null);
      }

      // The startup binding check may have been pushed before this listener
      // existed; pull it now or Sync Now / Hard Sync stay disabled as "unpaired".
      try {
        const binding = await window.api.reconcilePairing?.();
        if (binding?.reachable) updateState("pairedDevice", binding.data || null);
      } catch (_) {}

      try {
        const pending = await window.api.pendingCompanySelection?.();
        if (pending?.pending) setPreviousCompanies({ companies: pending.companies, workspaceName: null });
      } catch (_) {}
    };

    init();
  }, []);

  useEffect(() => {
    if (!window.api) return;
    const listener = window.api.listener(({ key, value }) => {
      if (key == "syncingCurrentStatus") {
        resetSyncStates(false);
        if (value?.code === "partial_sync") markUploadedCompanies(value.companies);
        if (value.message == "Data Mismatch") {
          setIsHardSyncConfirmationModalOpen(true);
        } else if (value.code === "TALLY_DATA_MISMATCH") {
          lineageMismatchRef.current = value;
          updateState("lineageMismatch", value);
          setAlertModalData({
            isOpen: true,
            message:
              value.reason === "guid_replacement_candidate"
                ? "Company GUID changed. Owner/Admin must approve a GUID Replacement Hard Sync."
                : value.message ||
                  CODE_ERROR_MESSAGE.TALLY_DATA_MISMATCH ||
                  "This Tally data does not match the workspace. Use Restore Existing Workspace, or Reset Workspace for New Tally.",
            sendLogs: false,
          });
        } else if (CODE_ERROR_MESSAGE[value.code]) {
          setAlertModalData({
            isOpen: true,
            message: value.message || CODE_ERROR_MESSAGE[value.code],
            sendLogs: false,
          });
        } else if (value.code != "manually_stopped" && (value.message || value.code)) {
          setAlertModalData({
            isOpen: true,
            message:
              value.message ||
              (value.code ? `Sync failed (${value.code})` : null) ||
              "Something went wrong while syncing. If this message persists, please contact the support team.",
            sendLogs: true,
          });
        }
      } else if (key == "syncedCompanies") {
        markUploadedCompanies(value);
      } else if (key == "syncMessage" && (value == "Data Synced" || value == "Sync Complete")) {
        resetSyncStates(true);
        openAlertModal("Data synced successfully");
      } else if (key == "unpairedAlert" && value === true) {
        // Main clears the binding and mints the replacement session; the
        // renderer only drops the state tied to the old pairing.
        resetSyncStates(false);
        updateState("pairedDevice", null);
        updateState("workspace", null);
        updateState("pairingCode", null);
        updateState("pairingBackendError", "");
        updateState("pairingClaimed", null);
        updateState("pendingFirstSyncAfterPair", false);
        autoFirstSyncClaimTokenRef.current = null;
        autoFirstSyncInFlightRef.current = false;
        autoFirstSyncStartedForBindRef.current = null;
        openAlertModal("Workspace connection is no longer active.");
        return;
      } else if (key == "bindingRevoked") {
        updateState("pairedDevice", null);
        updateState("workspace", null);
        updateState("pairingCode", null);
        updateState("pairingClaimed", null);
        updateState("pendingFirstSyncAfterPair", false);
        autoFirstSyncClaimTokenRef.current = null;
        autoFirstSyncInFlightRef.current = false;
        autoFirstSyncStartedForBindRef.current = null;
        openAlertModal("Workspace connection is no longer active.");
        return;
      } else if (key == "companySelectionConfirm") {
        if (value?.companies?.length) setPreviousCompanies(value);
        return;
      } else if (key == "pairingClaimed" && value) {
        updateState("pairingClaimed", {
          ...(typeof value === "object" && value ? value : {}),
          connectionStatus: value?.connectionStatus || "RECONNECTING",
          at: value?.at || Date.now(),
        });
        return;
      } else if (key == "hardSyncApproved" && value) {
        const approvedId = value.requestId || value.data?.requestId || value.id;
        // Prefer socket approval path; poll uses the same continue-once gate.
        continueHardSyncOnce(approvedId);
        return;
      } else if (key == "hardSyncRejected") {
        updateState("hardSyncWaitMessage", "");
        updateState("hardSyncRequestId", null);
        hardSyncContinueOnceRef.current = null;
        setAlertModalData({ isOpen: true, message: "Hard Sync was rejected.", sendLogs: false });
        return;
      } else if (key == "restoreApproved") {
        updateState("restoreApproved", value);
        return;
      } else if (key == "restoreComplete") {
        if (value?.status) {
          openAlertModal("Restore complete. Run a sync after Tally opens.");
        } else if (value?.message && value.message !== "Restore already running") {
          openAlertModal(value.message);
        }
        return;
      } else if (key == "workspaceReset") {
        updateState("resetWaitMessage", "Workspace was reset. Pair again after new Tally setup, or restore a backup.");
        updateState("pairedDevice", null);
        updateState("workspace", null);
        updateState("selectedCompanies", []);
        updateState("pairingCode", null);
        updateState("pairingClaimed", null);
        updateState("pendingFirstSyncAfterPair", false);
        openAlertModal("Workspace was reset. This Desktop is unpaired. Local Tally files were not deleted.");
        return;
      }
      updateState(key, value);
    });
    return () => listener && listener();
  }, []);

  useEffect(() => {
    if (!window.tally) return;
    const listener = window.tally.syncProgress(({ percent }) => {
      updateState("syncProgress", percent);
    });
    return () => listener && listener();
  }, []);

  useEffect(() => {
    if (!window.tally) return;
    const listener = window.tally.backupProgress(({ percent, stage }) => {
      updateState("backupProgress", percent);
      if (stage) updateState("backupStage", stage);
    });
    return () => listener && listener();
  }, []);

  useEffect(() => {
    if (!window.tally) return;
    const listener = window.tally.restoreProgress(({ percent, stage }) => {
      updateState("restoreProgress", percent);
      if (stage) updateState("restoreStage", stage);
    });
    return () => listener && listener();
  }, []);

  useEffect(() => {
    if (!state.hardSyncRequestId || !window.tally?.hardSyncStatus) return;
    // Poll fallback when socket approval is missed. Shares continue-once gate with socket.
    const t = setInterval(async () => {
      try {
        const r = await window.tally.hardSyncStatus(state.hardSyncRequestId);
        const st = r?.data?.requestStatus;
        if (st === "APPROVED") {
          await continueHardSyncOnce(state.hardSyncRequestId);
        } else if (st === "REJECTED" || st === "EXPIRED") {
          updateState("hardSyncWaitMessage", "");
          updateState("hardSyncRequestId", null);
          hardSyncContinueOnceRef.current = null;
          openAlertModal(
            st === "EXPIRED"
              ? "Hard Sync request expired. Request approval again."
              : "Hard Sync was rejected."
          );
        }
      } catch (_) {}
    }, 4000);
    return () => clearInterval(t);
  }, [state.hardSyncRequestId]);

  const resetSyncStates = (isSuccess) => {
    if (isSuccess) {
      const date = new Date();
      window.api.setPref("lastSync", date);
      updateState("lastSync", date);
      // Per-company sync flags come from the "syncedCompanies" outcome list, not from here:
      // a company skipped or failed in this run keeps its older success time.
    }
    updateState("syncMessage", "");
    updateState("syncProgress", 0);
    refreshJobState();
  };

  /** Only the companies the server accepted in this run count as synced. */
  const markUploadedCompanies = (outcomes) => {
    const uploaded = new Set(
      (outcomes || []).filter((o) => o?.status === "uploaded").map((o) => o.guid)
    );
    if (!uploaded.size) return;
    const at = new Date().toISOString();
    const mark = (list) =>
      (list || []).map((c) =>
        uploaded.has(c.guid || c.id) ? { ...c, isSynced: true, lastSyncedAt: at } : c
      );
    selectedCompaniesRef.current = mark(selectedCompaniesRef.current);
    updateState("selectedCompanies", mark);
    window.api.getPref("selectedCompanies").then((stored) => window.api.setPref("selectedCompanies", mark(stored)));
  };

  const updateState = (key, value) => {
    // setState((prev) => ({ ...prev, [key]: value }));

    setState((prev) => {
      const nextForKey = typeof value === "function" ? value(prev[key]) : value;

      if (Object.is(nextForKey, prev[key])) return prev;

      return { ...prev, [key]: nextForKey };
    });
  };

  const updateTallyStatus = async () => {
    try {
      const status = await window.tally.connected();
      // null: a sync/backup/restore is using Tally, so there is no fresh observation.
      // A running job is never stopped from here; it fails on its own if Tally goes away.
      if (status === null || status === undefined) return;
      updateState("isTallyOnline", status);

      if (status) fetchCompanies();
    } catch (err) {
      updateState("isTallyOnline", false);
    }
  };

  const updatePort = async (port) => {
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      openAlertModal("Port must be a whole number between 1 and 65535.");
      return false;
    }
    const saved = await window.api.setPref("port", value);
    if (saved === false) {
      openAlertModal("Port could not be saved.");
      return false;
    }
    updateState("port", value);
    updateTallyStatus();
    return true;
  };

  // Ref and state change together, so the 5s Tally refresh (which reads the ref)
  // can't write the old list back over a removal before React re-renders.
  const removeSelectedCompanies = (guids) => {
    const drop = new Set(guids);
    const next = (selectedCompaniesRef.current || []).filter((c) => !drop.has(c.guid || c.id));
    if (next.length === 0) {
      selectionClearedByUserRef.current = true;
      window.api.setPref("selectionClearedByUser", true);
    }
    selectedCompaniesRef.current = next;
    updateState("selectedCompanies", next);
  };

  const markCompaniesAdded = () => {
    selectionClearedByUserRef.current = false;
    window.api.setPref("selectionClearedByUser", false);
  };

  const fetchCompanies = async () => {
    const discovery = await window.tally.companies();
    if (selectionClearedByUserRef.current === null) {
      const stored = !!(await window.api.getPref("selectionClearedByUser"));
      if (selectionClearedByUserRef.current === null) selectionClearedByUserRef.current = stored;
    }
    // No await from here until the selection is written back.
    const clearedByUser = selectionClearedByUserRef.current;
    const current = selectedCompaniesRef.current || [];
    const merged = mergeDiscovery({ selected: current, discovery, clearedByUser });

    // Tally unreachable / busy / unknown: never treat that as "companies removed".
    if (!merged.available) return current;

    if (clearedByUser && merged.selection.length > 0) markCompaniesAdded();
    if (merged.changed) {
      selectedCompaniesRef.current = merged.selection;
      updateState("selectedCompanies", merged.selection);
    }
    updateState("companies", merged.companies);

    const fresh = merged.identityConflicts.filter((c) => {
      const key = `${c.name}|${c.oldGuid}|${c.newGuid}`;
      if (identityAlertedRef.current.has(key)) return false;
      identityAlertedRef.current.add(key);
      return true;
    });
    if (fresh.length > 0) {
      const names = fresh.map((c) => c.name).join(", ");
      openAlertModal(
        `Company GUID changed for: ${names}.\n\nThis usually means Tally was reinstalled or the company was recreated. ` +
        `Hard Sync is recommended to rebuild data safely.`
      );
    }

    return merged.selection;
  };

  /**
   * After pair claim+ACK → RECONNECTING, Web/Mobile stay on Demo until first soft sync
   * flips CONNECTED. Auto-run soft sync for Desktop-selected companies + their FYs only
   * (never all Tally companies).
   */
  const startAutoFirstSyncAfterPair = async () => {
    if (!window.tally) return false;
    if (autoFirstSyncInFlightRef.current || isSyncingRef.current) return false;
    const bindKey =
      state.workspace?.id ||
      pairedDevice?.deviceId ||
      pairedDevice?.name ||
      "bound";
    if (autoFirstSyncStartedForBindRef.current === bindKey) return false;
    if (previousCompaniesRef.current) {
      updateState("pendingFirstSyncAfterPair", true);
      return false;
    }
    autoFirstSyncInFlightRef.current = true;
    try {
      let tallyStatus = false;
      try {
        tallyStatus = await window.tally.connected();
      } catch (_) {
        tallyStatus = false;
      }
      if (tallyStatus === null || tallyStatus === undefined) {
        // Another job is using Tally; try again once it finishes.
        updateState("pendingFirstSyncAfterPair", true);
        return false;
      }
      const tallyOk = !!tallyStatus;
      updateState("isTallyOnline", tallyOk);
      if (!tallyOk) {
        updateState("pendingFirstSyncAfterPair", true);
        openAlertModal(
          "Open Tally to finish connecting. First sync will start automatically when Tally is online."
        );
        return false;
      }

      let selection = selectedCompaniesRef.current || [];
      try {
        selection = (await fetchCompanies()) || selection;
      } catch (_) {
        // keep prior selection
      }

      const toSync = (selection || []).filter(
        (c) => c && (c.guid || c.id) && Array.isArray(c.years) && c.years.length > 0
      );
      if (!toSync.length) {
        updateState("pendingFirstSyncAfterPair", true);
        openAlertModal(
          "Select at least one company and FY on Desktop. First sync will start once a selection is ready."
        );
        return false;
      }

      autoFirstSyncStartedForBindRef.current = bindKey;
      updateState("pendingFirstSyncAfterPair", false);
      updateState("pairingClaimed", null);
      updateState("isSyncing", true);
      updateState("syncMode", "normal");
      updateState("syncMessage", "First sync after pairing…");
      updateState("syncProgress", 0);

      const { data, code } = await window.tally.startSync({
        companies: toSync,
        isHardSync: false,
      });
      if (data?.code === "tally_not_connected" || code === "tally_not_connected") {
        autoFirstSyncStartedForBindRef.current = null;
        refreshJobState();
        updateState("pendingFirstSyncAfterPair", true);
        await updateTallyStatus();
        return false;
      }
      if (code === "COMPANY_SELECTION_PENDING") {
        autoFirstSyncStartedForBindRef.current = null;
        refreshJobState();
        updateState("pendingFirstSyncAfterPair", true);
        return false;
      }
      return true;
    } catch (e) {
      autoFirstSyncStartedForBindRef.current = null;
      refreshJobState();
      updateState("pendingFirstSyncAfterPair", true);
      openAlertModal(
        e?.message ||
          "First sync after pairing could not start. Open Tally, confirm company/FY selection, then Sync."
      );
      return false;
    } finally {
      autoFirstSyncInFlightRef.current = false;
    }
  };

  // Claim/ACK succeeded → auto soft first sync (selected companies + FYs only).
  useEffect(() => {
    const claimed = state.pairingClaimed;
    if (!claimed) return undefined;
    const token = claimed.at || claimed.connectionStatus || "claimed";
    if (autoFirstSyncClaimTokenRef.current === token) return undefined;
    autoFirstSyncClaimTokenRef.current = token;
    startAutoFirstSyncAfterPair();
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.pairingClaimed]);

  // Retry when Tally comes online or selection appears after a deferred first sync.
  useEffect(() => {
    if (!state.pendingFirstSyncAfterPair) return undefined;
    if (!state.isTallyOnline) return undefined;
    const ready = (selectedCompanies || []).some(
      (c) => Array.isArray(c?.years) && c.years.length > 0
    );
    if (!ready) return undefined;
    const t = setTimeout(() => {
      startAutoFirstSyncAfterPair();
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.pendingFirstSyncAfterPair, state.isTallyOnline, selectedCompanies]);

  const stopSync = async (code) => {
    const result = await window.tally.stopSync(code);
    if (result?.ok) updateState("syncMessage", "Stopping…");
    refreshJobState();
  };

  const closeAlertSyncModal = () => {
    setAlertModalData({ isOpen: false, message: null, sendLogs: false });
  };

  const onSendLogsHandler = async () => {
    closeAlertSyncModal();
    const response = await window.api.sendLogs();
    // console.log(response);
  };

  const confirmHardSyncModal = async () => {
    updateState("active", "dashboard");
    closeHardSyncModal();

    if (!state.isTallyOnline || !state.isOnline) {
      return;
    }
    updateState("isSyncing", true);
    updateState("syncMessage", "");
    updateState("syncMode", "hard");
    const { status, data, code, message } = await window.tally.startSync({
      companies: selectedCompanies,
      isHardSync: true,
    });
    if (code === "HARD_SYNC_APPROVAL_REQUIRED" || data?.code === "HARD_SYNC_APPROVAL_REQUIRED") {
      refreshJobState();
      hardSyncContinueOnceRef.current = null;
      updateState("hardSyncRequestId", data?.requestId || data?.data?.requestId);
      updateState("hardSyncWaitMessage", "Waiting for Owner/Admin approval");
      openAlertModal("Waiting for Owner/Admin approval. Approve Hard Sync in Web → Settings → Tally Sync.");
      return;
    }
    if (code === "HARD_SYNC_IN_FLIGHT" || data?.code === "HARD_SYNC_IN_FLIGHT") {
      refreshJobState();
      openAlertModal(message || CODE_ERROR_MESSAGE.HARD_SYNC_IN_FLIGHT);
      return;
    }
    if (code === "HARD_SYNC_REJECTED" || code === "HARD_SYNC_EXPIRED") {
      refreshJobState();
      updateState("hardSyncRequestId", null);
      hardSyncContinueOnceRef.current = null;
      openAlertModal(message || CODE_ERROR_MESSAGE[code]);
      return;
    }
    if (data?.code == "tally_not_connected" || code === "tally_not_connected") {
      updateTallyStatus();
    }
    if (code === "TALLY_DATA_MISMATCH") {
      refreshJobState();
      openAlertModal(message || "This Tally data does not match the workspace.");
    }
    refreshJobState();
  };

  const closeHardSyncModal = () => {
    setIsHardSyncConfirmationModalOpen(false);
  };

  const openAlertModal = (message, sendLogs) => {
    setAlertModalData({
      isOpen: true,
      message,
      sendLogs,
    });
  };

  const resolvePreviousCompanies = async (keep) => {
    setResolvingPreviousCompanies(true);
    try {
      const result = await window.api.resolveCompanySelection(keep);
      updateState("selectedCompanies", Array.isArray(result?.companies) ? result.companies : []);
      setPreviousCompanies(null);
    } catch (_) {
      openAlertModal("Could not update the company list. Please try again.");
    } finally {
      setResolvingPreviousCompanies(false);
    }
  };

  const closeVersionUpdateModal = () => {
    updateState("isVersionUpdateModalOpen", false);
  };

  const confirmVersionUpdateModal = () => {
    updateState("active", "settings");
  };

  const confirmForceUpdateModal = () => {
    updateState("isForceUpdateModalOpen", false);
    updateState("forceUpdate", true);
  };

  return (
    <div
      className="w-full min-h-screen grid place-content-center text-[14px]"
      style={{ background: '#1A1A1A', color: '#1A1A1A' }}
    >
      {alertModalData.isOpen && (
        <AlertModal
          message={alertModalData.message}
          onClose={closeAlertSyncModal}
          sendLogs={alertModalData.sendLogs}
          onSendLogs={onSendLogsHandler}
        />
      )}
      {isHardSyncConfirmationModalOpen && (
        <SyncErrorModal
          onClose={closeHardSyncModal}
          onConfirm={confirmHardSyncModal}
        />
      )}
      {previousCompanies && (
        <PreviousCompaniesModal
          companies={previousCompanies.companies}
          workspaceName={previousCompanies.workspaceName || state.workspace?.name}
          busy={resolvingPreviousCompanies}
          onKeep={() => resolvePreviousCompanies(true)}
          onClear={() => resolvePreviousCompanies(false)}
        />
      )}
      {state.isVersionUpdateModalOpen && (
        <VersionUpdateModal
          onClose={closeVersionUpdateModal}
          onConfirm={confirmVersionUpdateModal}
        />
      )}
      {state.isForceUpdateModalOpen && (
        <ForceUpdateModal onConfirm={confirmForceUpdateModal} />
      )}
      <TallyContext.Provider
        value={{
          state,
          updateState,
          updateTallyStatus,
          fetchCompanies,
          removeSelectedCompanies,
          markCompaniesAdded,
          updatePort,
          openAlertModal,
          refreshJobState,
          syncState: deriveSyncState(state),
          versionLevel: state.versionLevel,
          versionMessage: state.versionMessage,
        }}
      >
        <div
          className="overflow-hidden"
          // style={{
          //   width: "100vw",
          //   height: "100vh",
          //   background: "#FEFEFE",
          // }}
          style={{
            width: 800,
            height: 500,
            background: '#FFFFFF',
            border: '1px solid #1A1A1A',
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          <TitleBar />
          <div
            className="h-[calc(100%-2.25rem)] grid"
            style={{ gridTemplateColumns: "12rem 1fr" }}
          >
            <Sidebar
              active={active}
              updateState={updateState}
              forceUpdate={state.forceUpdate}
            />
            <main className="p-4 overflow-auto" style={{ background: '#FFFFFF' }}>
              {active === "dashboard" && (
                <Dashboard hardSync={confirmHardSyncModal} />
              )}
              {active === "backup" && <BackupRestore />}
              {active === "devices" && <Devices />}
              {active === "settings" && <Settings />}
              {active === "help" && <Help />}
            </main>
          </div>
        </div>
      </TallyContext.Provider>
    </div>
  );
}
