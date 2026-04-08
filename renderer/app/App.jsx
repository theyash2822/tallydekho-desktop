import React, { useEffect, useRef, useState } from "react";

import TitleBar from "./views/components/TitleBar";
import Sidebar from "./views/components/Sidebar";
import Dashboard from "./views/dashboard/Dashboard";
import BackupRestore from "./views/backup/BackupRestore";
import Devices from "./views/devices/Devices";
import Settings from "./views/settings/Settings";
import Help from "./views/help/Help";
import { formatDateTime } from "./utils/datetime";
import { TallyContext } from "./utils/TallyContext";
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
    const updateOnlineStatus = async () => {
      updateState("isOnline", navigator.onLine);
      window.api.setPref("isOnline", navigator.onLine);
      if (isSyncingRef.current && !navigator.onLine) {
        stopSync("internet_is_offline");
      }
    };

    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);

    updateOnlineStatus();

    return () => {
      window.removeEventListener("online", updateOnlineStatus);
      window.removeEventListener("offline", updateOnlineStatus);
    };
  }, []);

  useEffect(() => {
    updateTallyStatus();

    const timer = setInterval(() => {
      updateTallyStatus();
    }, 5000);

    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let timer;

    if (pairingCodeGeneratedAt) {
      timer = setInterval(() => {
        const generatedAt = new Date(pairingCodeGeneratedAt);
        const currentDate = new Date();

        const differenceInMillis = currentDate - generatedAt;

        const differenceInMinutes = differenceInMillis / (1000 * 60);

        if (differenceInMinutes >= 10) {
          // if (!pairedDevice) {
          //   window.api.pairedDevice().then((response) => {
          //     if (response.status) {
          //       updateState("pairedDevice", response.data);
          //     }
          //   });
          // }
          setState((prev) => ({
            ...prev,
            pairingState: "hidden",
            pairingCode: null,
            pairingCodeGeneratedAt: null,
          }));
          clearInterval(timer);
        }
      }, 1000 * 60);
    }

    return () => {
      clearInterval(timer);
    };
  }, [pairingCodeGeneratedAt, pairedDevice]);

  useEffect(() => {
    if (isInitCompleted.current) {
      window.api.setPref("selectedCompanies", selectedCompanies);
      selectedCompaniesRef.current = selectedCompanies;
    }
  }, [selectedCompanies]);

  useEffect(() => {
    isSyncingRef.current = isSyncing;
  }, [isSyncing]);

  useEffect(() => {
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

      isInitCompleted.current = true;

      const pairedDevice = await window.api.pairedDevice();
      updateState("pairedDevice", pairedDevice.data);
    };

    init();
  }, []);

  useEffect(() => {
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
      } else if (key == "syncMessage" && value == "Data Synced") {
        resetSyncStates(true);
        openAlertModal("Data synced successfully");
      }
      updateState(key, value);
    });
    return () => listener && listener();
  }, []);

  useEffect(() => {
    const listener = window.tally.syncProgress(({ percent }) => {
      updateState("syncProgress", percent);
    });
    return () => listener && listener();
  }, []);

  useEffect(() => {
    const listener = window.tally.backupProgress(({ percent }) => {
      updateState("backupProgress", percent);
    });
    return () => listener && listener();
  }, []);

  useEffect(() => {
    const listener = window.tally.restoreProgress(({ percent }) => {
      updateState("restoreProgress", percent);
    });
    return () => listener && listener();
  }, []);

  const resetSyncStates = (isSuccess) => {
    if (isSuccess) {
      const date = new Date();
      window.api.setPref("lastSync", date);
      updateState("lastSync", date);
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
      // status: "connected",
      // last: new Date(Date.now() - 5 * 60 * 1000),
      // enabled: true,
      years: company.years,
      isCurrentCompany: company.isCurrentCompany,
      allYears: company.years,
      ledgersCount: company.ledgersCount,
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
    const { status, data } = await window.tally.startSync({
      companies: selectedCompanies,
      isHardSync: true,
    });
    if (data?.code == "tally_not_connected") {
      updateTallyStatus();
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
      style={{ background: '#FFFFFF', color: '#1A1A1A' }}
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
            border: '1px solid #E9E8E3',
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          <TitleBar />
          <div
            className="h-[calc(100%-2.25rem)] grid p-2"
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
