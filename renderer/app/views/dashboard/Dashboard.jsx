import React, { useContext, useMemo, useState } from "react";
import Card from "../components/Card";
import Progress from "../components/Progress";
import PairingPanel from "./PairingPanel";
import HeaderBar from "./HeaderBar";
import Companies from "./Companies";
import { TallyContext } from "../../utils/TallyContext.js";
import { HardSyncModal } from "../components/HardSyncModal.jsx";
import { isStartRejected, rejectionMessage } from "../../utils/helper";

export default function Dashboard({ hardSync }) {
  const {
    updateTallyStatus,
    updateState,
    refreshJobState,
    openAlertModal,
    state: {
      isTallyOnline,
      isSyncing,
      syncProgress,
      isAutoSync,
      isOnline,
      syncMode,
      syncMessage,
      hardSyncWaitMessage,
      pairedDevice,
    },
  } = useContext(TallyContext);

  const [isHardSyncModalOpen, setIsHardSyncModalOpen] = useState(false);

  const onManualSync = async (companies) => {
    const syncStatus = isSyncing;

    updateState("syncMode", "normal");

    if (syncStatus) {
      // Stop is a request; the job releases itself at a safe point and the job event clears isSyncing.
      const result = await window.tally.stopSync("manually_stopped");
      if (result?.ok) updateState("syncMessage", "Stopping…");
      refreshJobState();
    } else {
      updateState("isSyncing", true);
      updateState("syncMessage", "");
      const result = await window.tally.startSync({ companies });
      if (result?.data?.code == "tally_not_connected") {
        updateTallyStatus();
      }
      if (isStartRejected(result)) openAlertModal(rejectionMessage(result));
      refreshJobState();
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

  // An unpaired Desktop has no workspace to sync into — the backend rejects it
  // with DEVICE_NOT_PAIRED, so the controls must not invite the attempt.
  const disableSyncButton = useMemo(() => {
    if (!pairedDevice) return true;
    return ["Uploading Data", "Processing Data"].includes(syncMessage);
  }, [syncMessage, pairedDevice]);

  return (
    <div className="space-y-3">
      <HeaderBar />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <PairingPanel />
        <Card title="Sync Progress">
          {hardSyncWaitMessage ? (
            <div className="text-sm text-[#787774] mb-2">{hardSyncWaitMessage}</div>
          ) : null}
          {isSyncing ? (
            <div className="space-y-2">
              <div className="text-xs text-[#787774]">
                {syncMode === "hard"
                  ? "Hard Sync (deep refresh)"
                  : "Standard Sync"}
              </div>
              <div className="text-xs text-[#787774]">{syncMessage}</div>
              <Progress value={syncProgress} />
              <div className="text-xs text-[#9A9A97]">
                Connect → Fetch → Upload → Confirm
              </div>
            </div>
          ) : (
            <div className="text-sm text-[#787774]">
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
