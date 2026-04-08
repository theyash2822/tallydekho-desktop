import React, { useContext, useEffect, useMemo, useState } from "react";
import Card from "../components/Card";
import Progress from "../components/Progress";
import { TallyContext } from "../../utils/TallyContext.js";

export default function PairingPanel() {
  const {
    state: { pairingState, pairingCode, pairedDevice },
    updateState,
    openAlertModal,
  } = useContext(TallyContext);

  const [masked, setMasked] = useState(true);

  const generateCode = async () => {
    updateState("pairingState", "generating");

    const startTime = new Date().getTime();
    const response = await window.api.pairingCode();
    const endTime = new Date().getTime();
    if (response.status) {
      if (!response.data) {
        updateState("pairingState", "hidden");
        openAlertModal("Sync at least one company to generate a pairing code.");
        return;
      }
      const timeTaken = endTime - startTime;
      setTimeout(() => {
        updateState("pairingState", "revealed");
        updateState("pairingCode", response.data.code);
        updateState("pairingCodeGeneratedAt", response.data.generatedAt);
      }, 1000 - timeTaken);
    } else {
      updateState("pairingState", "hidden");
      openAlertModal(
        "Something went wrong while generating pairing code. If this message persists, please contact the support team.",
        true
      );
    }
  };

  // If already paired, show paired status instead of code generator
  if (pairedDevice) {
    return (
      <Card title="Pairing">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#2D7D46] inline-block"></span>
          <span className="text-sm text-[#2D7D46] font-medium">Paired with {pairedDevice.name || 'mobile device'}</span>
        </div>
        <div className="text-xs text-[#9A9A97] mt-1">Go to Devices tab to manage pairing.</div>
      </Card>
    );
  }

  return (
    <Card title="Pairing">
      <div className="space-y-3">
        {pairingState === "hidden" && (
          <button
            onClick={generateCode}
            className="px-3 py-1.5 rounded-full border bg-[#F5F4EF] hover:bg-[#F0EFE9] text-[#787774]"
            style={{ borderColor: "#E9E8E3" }}
          >
            Generate code
          </button>
        )}
        {pairingState === "generating" && (
          <div className="space-y-2">
            <div className="text-sm text-[#787774]">
              Generating secure code…
            </div>
            <Progress value={66} />
          </div>
        )}
        {pairingState === "revealed" && (
          <div className="flex items-center gap-3">
            <div className="font-mono text-2xl tracking-widest select-all">
              {masked ? "••••••" : pairingCode}
            </div>
            <button
              onClick={() => setMasked((v) => !v)}
              className="px-3 py-1.5 rounded-full border bg-[#F5F4EF] hover:bg-[#F0EFE9] text-[#787774]"
              style={{ borderColor: "#E9E8E3" }}
            >
              {masked ? "Reveal code" : "Hide code"}
            </button>
          </div>
        )}
        <div className="text-xs text-[#9A9A97]">
          Enter this code in the mobile app → Settings → Account Pairing.
        </div>
      </div>
    </Card>
  );
}
