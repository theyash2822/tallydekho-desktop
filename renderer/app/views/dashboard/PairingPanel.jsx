import React, { useContext, useState } from "react";
import Card from "../components/Card";
import { TallyContext } from "../../utils/TallyContext.js";

export default function PairingPanel() {
  const {
    state: { pairingCode },
    openAlertModal,
  } = useContext(TallyContext);

  const [masked, setMasked] = useState(true);

  // If no code yet (still loading from register), show placeholder
  const displayCode = pairingCode || "------";

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
          Enter this code in the mobile app → Settings → Tally Prime Sync.
        </div>
      </div>
    </Card>
  );
}
