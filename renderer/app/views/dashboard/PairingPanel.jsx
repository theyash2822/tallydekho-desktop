import React, { useContext, useEffect, useMemo, useState } from "react";
import Card from "../components/Card";
import Progress from "../components/Progress";
import { TallyContext } from "../../utils/TallyContext.js";

export default function PairingPanel() {
  const {
    state: { pairingState, pairingCode },
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

  return (
    <Card title="Pairing">
      <div className="space-y-3">
        {pairingState === "hidden" && (
          <button
            onClick={generateCode}
            className="px-3 py-1.5 rounded-full border bg-slate-50 hover:bg-slate-100 text-slate-700"
            style={{ borderColor: "#D5D9E4" }}
          >
            Generate code
          </button>
        )}
        {pairingState === "generating" && (
          <div className="space-y-2">
            <div className="text-sm text-slate-600">
              Generating secure code…
            </div>
            <Progress value={66} />
          </div>
        )}
        {pairingState === "revealed" && (
          <div className="flex items-center gap-3">
            <div className="font-mono text-2xl tracking-widest select-all">
              {masked ? "••••" : pairingCode}
            </div>
            <button
              onClick={() => setMasked((v) => !v)}
              className="px-3 py-1.5 rounded-full border bg-slate-50 hover:bg-slate-100 text-slate-700"
              style={{ borderColor: "#D5D9E4" }}
            >
              {masked ? "Reveal code" : "Hide code"}
            </button>
          </div>
        )}
        <div className="text-xs text-slate-500">
          Enter this code in the mobile app → Settings → Account Pairing.
        </div>
      </div>
    </Card>
  );
}
