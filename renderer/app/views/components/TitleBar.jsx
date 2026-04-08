import React, { useContext, useEffect, useState } from "react";

import StopSyncModal from "./StopSyncModal";
import { TallyContext } from "../../utils/TallyContext";

export default function TitleBar() {
  const {
    state: { isSyncing, isCloseConfirmationModalOpen },
    updateState,
  } = useContext(TallyContext);

  const [isConfirmationModalOpen, setIsConfirmationModalOpen] = useState(false);

  useEffect(() => {
    if (isCloseConfirmationModalOpen) {
      updateState("isCloseConfirmationModalOpen", false);
      setIsConfirmationModalOpen(true);
    }
  }, [isCloseConfirmationModalOpen]);

  async function handleMinimize() {
    try {
      await window.api.minimize();
    } catch {
      // In development or testing, the API may not exist; swallow errors.
    }
  }

  async function handleClose() {
    if (isSyncing) {
      setIsConfirmationModalOpen(true);
      return;
    }
    try {
      await window.api.close();
    } catch {}
  }

  const successConfirmationModal = async () => {
    await window.tally.stopSync("manually_stopped");
    updateState("isSyncing", false);
    updateState("syncProgress", 0);

    await window.api.close();
    setIsConfirmationModalOpen(false);
  };

  const closeConfirmationModal = () => {
    setIsConfirmationModalOpen(false);
  };

  return (
    <div
      className="h-9 flex items-center justify-between px-3 select-none"
      style={{
        background: '#1A1A1A',
        WebkitAppRegion: "drag",
      }}
    >
      <div className="flex items-center gap-2 text-[#F5F4EF]/95">
        <div className="w-5 h-5 rounded-full bg-[#F5F4EF]/90" />
        <span className="font-semibold tracking-wide">TallyDekho Agent</span>
        {/* <span className="ml-2 text-xs bg-white/15 px-2 py-0.5 rounded-full">
          Preview
        </span> */}
      </div>
      <div
        className="flex items-center gap-1"
        style={{ WebkitAppRegion: "no-drag" }}
      >
        <button
          title="Minimize"
          onClick={handleMinimize}
          className="w-8 h-7 grid place-content-center rounded hover:bg-white/20 text-[#F5F4EF]"
        >
          —
        </button>
        <button
          title="Close"
          onClick={handleClose}
          className="w-8 h-7 grid place-content-center rounded hover:bg-white/20 text-[#F5F4EF]"
        >
          ✕
        </button>
      </div>

      {isConfirmationModalOpen && (
        <StopSyncModal
          onClose={closeConfirmationModal}
          onConfirm={successConfirmationModal}
        />
      )}
    </div>
  );
}
