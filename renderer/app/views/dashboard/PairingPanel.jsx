import React, { useContext, useState } from "react";
import Card from "../components/Card";
import { TallyContext } from "../../utils/TallyContext.js";

export default function PairingPanel() {
  const {
    state: { pairingCode, pairedDevice, restoreCode },
    openAlertModal,
    updateState,
  } = useContext(TallyContext);

  const [masked, setMasked] = useState(true);

  const displayCode = pairingCode || "------";

  const startRestore = async () => {
    const res = await window.tally.restoreRequest();
    if (res?.status && res.data?.code) {
      updateState("restoreCode", res.data.code);
    } else {
      openAlertModal(res?.message || "Could not start restore request");
    }
  };

  const pollAndRestore = async () => {
    const st = await window.tally.restoreStatus();
    if (st?.data?.status === "APPROVED") {
      const done = await window.tally.restoreCloud();
      if (done?.status) openAlertModal("Restore complete. Run a sync after Tally opens.");
      else openAlertModal(done?.message || "Restore failed");
      return;
    }
    openAlertModal("Still waiting for Owner/Admin approval on Web or Mobile.");
  };

  return (
    <Card title="Pairing Code">
      <div className="space-y-3">
        {/* Code display — always shown, revealed on button click */}
        <div className="flex items-center gap-3">
          <div className="font-mono text-2xl tracking-widest select-all">
            {masked ? "••••••" : displayCode}
          </div>
          <button
            onClick={() => setMasked((v) => !v)}
            className="px-3 py-1.5 rounded-full border bg-[#F5F4EF] hover:bg-[#F0EFE9] text-[#787774]"
            style={{ borderColor: "#E9E8E3" }}
            disabled={!pairingCode}
          >
            {masked ? "Reveal code" : "Hide code"}
          </button>
        </div>

        <div className="text-xs text-[#9A9A97]">
          Enter this code in the mobile app or Web → Settings → Tally Sync.
        </div>
        {!pairedDevice && (
          <div className="pt-2 border-t space-y-2" style={{ borderColor: "#E9E8E3" }}>
            <div className="font-medium text-sm">Restore Existing Workspace</div>
            <p className="text-xs text-[#787774]">
              On a new PC, request restore. Owner/Admin approves the backup on Web or Mobile.
            </p>
            {restoreCode ? (
              <div className="space-y-2">
                <div className="font-mono text-xl tracking-widest">{restoreCode}</div>
                <button
                  onClick={pollAndRestore}
                  className="px-3 py-1.5 rounded-md border text-[#787774] hover:bg-[#F0EFE9]"
                  style={{ borderColor: "#E9E8E3" }}
                >
                  Check approval / restore
                </button>
              </div>
            ) : (
              <button
                onClick={startRestore}
                className="px-3 py-1.5 rounded-md border text-[#787774] hover:bg-[#F0EFE9]"
                style={{ borderColor: "#E9E8E3" }}
              >
                Request restore
              </button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
