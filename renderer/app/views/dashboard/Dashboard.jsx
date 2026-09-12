import React, { useContext, useMemo, useState } from "react";
import Card from "../components/Card";
import Progress from "../components/Progress";
import PairingPanel from "./PairingPanel";
import HeaderBar from "./HeaderBar";
import Companies from "./Companies";
import { TallyContext } from "../../utils/TallyContext.js";
import { HardSyncModal } from "../components/HardSyncModal.jsx";
import LineageMismatchCard from "../components/LineageMismatchCard.jsx";
import { ResetWorkspaceModal } from "../components/ResetWorkspaceModal.jsx";

export default function Dashboard({ hardSync }) {
  const {
    updateTallyStatus,
    updateState,
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
      lineageMismatch,
    },
  } = useContext(TallyContext);

  const [isHardSyncModalOpen, setIsHardSyncModalOpen] = useState(false);
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);

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
      const { status, data, code, message } = await window.tally.startSync({ companies });
      if (data?.code == "tally_not_connected" || code === "tally_not_connected") {
        updateTallyStatus();
      }
      if (code === "TALLY_DATA_MISMATCH" || data?.code === "TALLY_DATA_MISMATCH") {
        updateState("isSyncing", false);
        updateState("lineageMismatch", data || {});
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

  const startRestore = async () => {
    const res = await window.tally.restoreRequest();
    if (res?.status && res.data?.code) {
      updateState("restoreCode", res.data.code);
      openAlertModal(
        `Restore code: ${res.data.code}. Owner/Admin must approve a backup on Web or Mobile.`
      );
    } else {
      openAlertModal(res?.message || "Could not start restore request");
    }
  };

  const requestReset = async () => {
    setIsResetModalOpen(false);
    const res = await window.tally.resetRequest();
    if (res?.status) {
      updateState(
        "resetWaitMessage",
        "Reset requested. Confirm on Web → Settings, then wait 24 hours. This Desktop will unpair when reset completes."
      );
      openAlertModal(
        "Reset requested. Owner must confirm on Web (phrase RESET WORKSPACE). Local Tally files are not deleted."
      );
    } else {
      openAlertModal(res?.message || "Could not request reset. Only the Workspace Owner can start Reset from this Desktop.");
    }
  };

  const disableSyncButton = useMemo(() => {
    return ["Uploading Data", "Processing Data"].includes(syncMessage);
  }, [syncMessage]);

  return (
    <div className="space-y-3">
      <HeaderBar />
      <LineageMismatchCard
        mismatch={lineageMismatch}
        onRestore={startRestore}
        onReset={() => setIsResetModalOpen(true)}
        onHardSync={onHardSync}
      />
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
      {isResetModalOpen && (
        <ResetWorkspaceModal
          onClose={() => setIsResetModalOpen(false)}
          onConfirm={requestReset}
        />
      )}
    </div>
  );
}
