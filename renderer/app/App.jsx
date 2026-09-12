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
    pairingCodeGeneratedAt: null,
    pairedDevice: null,
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

  const selectedCompaniesRef = useRef([]);
  const isSyncingRef = useRef(false);
  const isInitCompleted = useRef(false);

  const {
    active,
    isSyncing,
    selectedCompanies,
    pairingCodeGeneratedAt,
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
    // Pairing code is now permanent — no expiry timer needed
    return () => {};
  }, [pairingCodeGeneratedAt, pairedDevice]);

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

      // Load permanent pairing code from store
      const pairingCode = await window.api.getPref('pairingCode');
      if (pairingCode) updateState('pairingCode', pairingCode);

      const pairedDevice = await window.api.pairedDevice();
      updateState("pairedDevice", pairedDevice.data);
    };

    init();
  }, []);

  useEffect(() => {
    if (!window.api) return;
    const listener = window.api.listener(({ key, value }) => {
      if (key == "syncingCurrentStatus") {
        resetSyncStates(false);
        if (value.message == "Data Mismatch") {
          setIsHardSyncConfirmationModalOpen(true);
        } else if (CODE_ERROR_MESSAGE[value.code]) {
          setAlertModalData({
            isOpen: true,
            message: CODE_ERROR_MESSAGE[value.code],
            sendLogs: false,
          });
        } else if (value.code != "manually_stopped" && value.message) {
          setAlertModalData({
            isOpen: true,
            message:
              "Something went wrong while syncing. If this message persists, please contact the support team.",
            sendLogs: true,
          });
        }
      } else if (key == "syncMessage" && (value == "Data Synced" || value == "Sync Complete")) {
        resetSyncStates(true);
        openAlertModal("Data synced successfully");
      } else if (key == "unpairedAlert" && value === true) {
        resetSyncStates(false);
        openAlertModal("Workspace connection is no longer active.");
        updateState("workspace", null);
        return;
      } else if (key == "bindingRevoked") {
        updateState("pairedDevice", null);
        updateState("workspace", null);
        openAlertModal("Workspace connection is no longer active.");
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
    const t = setInterval(async () => {
      try {
        const r = await window.tally.hardSyncStatus(state.hardSyncRequestId);
        const st = r?.data?.requestStatus;
        if (st === "APPROVED") {
          updateState("hardSyncWaitMessage", "Approved by Workspace administrator. Starting full sync...");
          updateState("hardSyncRequestId", null);
          await window.tally.startSync({
            companies: selectedCompaniesRef.current,
            isHardSync: true,
          });
        } else if (st === "REJECTED") {
          updateState("hardSyncWaitMessage", "");
          updateState("hardSyncRequestId", null);
          openAlertModal("Hard Sync was rejected.");
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

      // Mark every synced company as isSynced: true
      updateState("selectedCompanies", (prev) =>
        (prev || []).map((c) => ({ ...c, isSynced: true, lastSyncedAt: date.toISOString() }))
      );
      // Persist updated companies with sync flags
      window.api.getPref("selectedCompanies").then((stored) => {
        const updated = (stored || []).map((c) => ({ ...c, isSynced: true, lastSyncedAt: date.toISOString() }));
        window.api.setPref("selectedCompanies", updated);
      });
    }
    updateState("syncMessage", "");
    window.api.setPref("isSyncing", false);
    updateState("isSyncing", false);
    updateState("syncProgress", 0);
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
      updateState("isTallyOnline", status);

      if (status) {
        fetchCompanies();
      } else if (isSyncingRef.current) {
        stopSync("tally_is_not_connected");
      }
    } catch (err) {
      updateState("isTallyOnline", false);
    }
  };

  const updatePort = (port) => {
    window.api.setPref("port", port);
    updateState("port", port);
    updateTallyStatus();
  };

  const fetchCompanies = async () => {
    const companies = await window.tally.companies();
    const data = companies.map((company) => ({
      id: company.guid,
      name: company.name,
      guid: company.guid,
      path: company.destination,
      years: company.years,
      isCurrentCompany: company.isCurrentCompany,
      allYears: company.years,
      ledgersCount: company.ledgersCount,
      // Preserve date fields needed for OpeningBalanceDiff.xml sync
      startingFrom: company.startingFrom,
      booksFrom: company.booksFrom,
    }));

    const ids = data.map((item) => item.id);
    const ledgersCount = data.reduce((acc, cv) => {
      acc[cv.id] = cv.ledgersCount;
      return acc;
    }, {});

    // let newSelectedCompanies = await window.api.getPref("selectedCompanies");
    let newSelectedCompanies = selectedCompaniesRef.current;

    let isCompanyRemoved = false;

    if (ids.length == 0) {
      newSelectedCompanies = [];
    } else if (newSelectedCompanies.length > 0) {
      newSelectedCompanies = newSelectedCompanies.filter((company) =>
        ids.includes(company.id)
      );
      newSelectedCompanies = newSelectedCompanies.map((company) => {
        company.ledgersCount = ledgersCount[company.id];

        // Always refresh allYears from latest Tally data so new FYs appear in the Edit Years modal
        const freshData = data.find(d => d.id === company.id);
        if (freshData) company.allYears = freshData.allYears;

        // Auto-add ONLY genuinely new FY years:
        // A year is "new" if its begin date is AFTER the end date of all currently selected years
        // This avoids adding old historical years the user deliberately excluded
        if (freshData?.allYears && (company.years || []).length > 0) {
          const selectedYears = company.years || [];
          const selectedFYNames = new Set(selectedYears.map(y => y.finYear));

          // Find the latest end date among currently selected years (YYYYMMDD format)
          const maxEnd = selectedYears.reduce((max, y) => y.end > max ? y.end : max, '');

          if (maxEnd) {
            const trulyNewYears = freshData.allYears.filter(y =>
              !selectedFYNames.has(y.finYear) && y.begin > maxEnd
            );
            if (trulyNewYears.length > 0) {
              console.log('[fetchCompanies] Auto-adding new FY years:', trulyNewYears.map(y => y.finYear));
              company.years = [...selectedYears, ...trulyNewYears];
            }
          }
        }

        return company;
      });

      isCompanyRemoved = true;
    }

    if (
      (isCompanyRemoved && newSelectedCompanies.length == 0) ||
      !isCompanyRemoved
    ) {
      newSelectedCompanies = data
        .filter((item) => item.isCurrentCompany)
        .map((item) => ({ ...item, years: item.years.slice(-2) }));
    }

    updateState("selectedCompanies", newSelectedCompanies);
    updateState("companies", data);

    // ── GUID change detection ─────────────────────────────────────────
    // If a previously-synced company GUID is no longer in the live Tally list,
    // the company was migrated/reinstalled. Suggest hard sync.
    const prevSynced = selectedCompaniesRef.current.filter(c => c.isSynced);
    const newIds = new Set(ids);
    const missingGuids = prevSynced.filter(c => !newIds.has(c.guid));
    if (missingGuids.length > 0) {
      const names = missingGuids.map(c => c.name).join(", ");
      openAlertModal(
        `Company GUID changed for: ${names}.\n\nThis usually means Tally was reinstalled or the company was recreated. ` +
        `Hard Sync is recommended to rebuild data safely.`
      );
    }
  };

  const stopSync = async (code) => {
    await window.tally.stopSync(code);
    updateState("isSyncing", false);
    // updateState("lastSync", null);
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
      updateState("isSyncing", false);
      updateState("hardSyncRequestId", data?.requestId || data?.data?.requestId);
      updateState("hardSyncWaitMessage", "Waiting for Owner/Admin approval");
      openAlertModal("Waiting for Owner/Admin approval. Approve Hard Sync in Web → Settings → Tally Sync.");
      return;
    }
    if (data?.code == "tally_not_connected" || code === "tally_not_connected") {
      updateTallyStatus();
    }
    if (code === "TALLY_DATA_MISMATCH") {
      updateState("isSyncing", false);
      openAlertModal(message || "This Tally data does not match the workspace.");
    }
    // if (status) {
    //   const date = new Date();
    //   window.api.setPref("lastSync", date);
    //   updateState("lastSync", date);
    // }

    // updateState("isSyncing", false);
    // updateState("syncProgress", 0);
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
          updatePort,
          openAlertModal,
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
