import React, { useContext, useMemo, useState } from "react";
import Card from "../components/Card";
import Progress from "../components/Progress";
import PairingPanel from "./PairingPanel";
import HeaderBar from "./HeaderBar";
import Companies from "./Companies";
import { TallyContext } from "../../utils/TallyContext.js";
import { HardSyncModal } from "../components/HardSyncModal.jsx";

export default function Dashboard({ hardSync }) {
  const {
    updateTallyStatus,
    updateState,
    state: {
      isTallyOnline,
      isSyncing,
      syncProgress,
      isAutoSync,
      isOnline,
      syncMode,
      syncMessage,
    },
  } = useContext(TallyContext);

  const [isHardSyncModalOpen, setIsHardSyncModalOpen] = useState(false);

  const onManualSync = async (companies) => {
    const syncStatus = isSyncing;

    updateState("syncMode", "normal");

    if (syncStatus) {
      //stop
      await window.tally.stopSync("manually_stopped");
      updateState("isSyncing", false);
      // updateState("lastSync", null);
      updateState("syncProgress", 0);
    } else {
      //start

      updateState("isSyncing", true);
      updateState("syncMessage", "");
      const { status, data } = await window.tally.startSync({ companies });
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
    }
  };

  const onHardSync = () => {
    setIsHardSyncModalOpen(true);
  };

  const confirmHardSyncModal = () => {
    hardSync();
    closeHardSyncModal();
  };

  const closeHardSyncModal = () => {
    setIsHardSyncModalOpen(false);
  };

  const disableSyncButton = useMemo(() => {
    return ["Uploading Data", "Processing Data"].includes(syncMessage);
  }, [syncMessage]);

  return (
    <div className="space-y-3">
      <HeaderBar />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <PairingPanel />
        <Card title="Sync Progress">
          {isSyncing ? (
            <div className="space-y-2">
              <div className="text-xs text-slate-600">
                {syncMode === "hard"
                  ? "Hard Sync (deep refresh)"
                  : "Standard Sync"}
              </div>
              <div className="text-xs text-slate-600">{syncMessage}</div>
              <Progress value={syncProgress} />
              <div className="text-xs text-slate-500">
                Connect → Fetch → Upload → Confirm
              </div>
            </div>
          ) : (
            <div className="text-sm text-slate-600">
              Auto sync is {isAutoSync ? <b>ON</b> : <b>OFF</b>}. Use controls
              above to change.
            </div>
          )}
        </Card>
      </div>
      <Companies
        onManualSync={onManualSync}
        onHardSync={onHardSync}
        disableSyncButton={disableSyncButton}
      />
      {isHardSyncModalOpen && (
        <HardSyncModal
          onClose={closeHardSyncModal}
          onConfirm={confirmHardSyncModal}
        />
      )}
    </div>
  );
}
