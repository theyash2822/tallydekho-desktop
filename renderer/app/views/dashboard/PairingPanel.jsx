import React, { useContext, useRef, useState } from "react";
import Card from "../components/Card";
import { TallyContext } from "../../utils/TallyContext.js";

export default function PairingPanel() {
  const {
    state: { pairingCode, pairedDevice, restoreCode, pairingBackendError },
    openAlertModal,
    updateState,
  } = useContext(TallyContext);

  const [masked, setMasked] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const backoffRef = useRef(2000);

  const displayCode = pairingCode || "------";

  const refreshPairingCode = async () => {
    if (!window.api?.pairingCode) return;
    setRefreshing(true);
    try {
      const res = await window.api.pairingCode();
      const data = res?.data || {};
      const code = data.code || data.pairingCode;
      if (res?.status && code && data.sessionId) {
        updateState("pairingCode", code);
        updateState("pairingCodeGeneratedAt", Date.now());
        updateState("pairingBackendError", "");
        backoffRef.current = 2000;
      } else {
        const msg =
          res?.message ||
          "Backend unavailable — unable to generate pairing code.";
        updateState("pairingBackendError", msg);
        updateState("pairingCodeGeneratedAt", 0);
        openAlertModal(msg);
        // Controlled backoff for automatic retries (caller may re-invoke)
        await new Promise((r) => setTimeout(r, backoffRef.current));
        backoffRef.current = Math.min(backoffRef.current * 2, 30_000);
      }
    } catch (e) {
      const msg = e?.message || "Backend unavailable — unable to generate pairing code.";
      updateState("pairingBackendError", msg);
      updateState("pairingCodeGeneratedAt", 0);
      openAlertModal(msg);
    } finally {
      setRefreshing(false);
    }
  };

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
        {!!pairingBackendError && (
          <div className="text-xs text-[#C0392B] bg-[#FDECEA] rounded-md px-3 py-2">
            {pairingBackendError}
          </div>
        )}
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
          <button
            onClick={refreshPairingCode}
            className="px-3 py-1.5 rounded-full border bg-[#F5F4EF] hover:bg-[#F0EFE9] text-[#787774]"
            style={{ borderColor: "#E9E8E3" }}
            disabled={refreshing || !!pairedDevice}
          >
            {refreshing ? "Refreshing…" : "Refresh code"}
          </button>
        </div>

        <div className="text-xs text-[#9A9A97]">
          Enter this code in Web or Mobile → Settings → Tally Sync. Codes expire in about 10 minutes — use Refresh code if needed.
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
