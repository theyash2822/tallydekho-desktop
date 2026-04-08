import React, { useContext, useEffect, useState } from "react";
import Card from "../components/Card";
import { TallyContext } from "../../utils/TallyContext";
import AppUpdate from "../components/AppUpdate";

export default function Settings() {
  const {
    state: {
      isTallyOnline,
      version,
      port: defaultPort,
      isSyncing,
      appVersion,
      isVersionUpdateModalOpen,
      forceUpdate,
    },
    updatePort,
    updateState,
  } = useContext(TallyContext);

  const [port, setPort] = useState(defaultPort);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (saved) {
      const t = setTimeout(() => setSaved(false), 1200);
      return () => clearTimeout(t);
    }
  }, [saved]);

  return (
    <div className="space-y-3">
      <Card title="Tally Connection">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <label className="flex items-center gap-2">
            Host
            <input
              readOnly
              value="localhost"
              className="ml-auto border rounded-md px-2 py-1 w-40 bg-[#F5F4EF]"
              style={{ borderColor: "#E9E8E3" }}
            />
          </label>
          <label className="flex items-center gap-2">
            Port
            <input
              value={port}
              onChange={(e) => setPort(Number(e.target.value || 0))}
              type="number"
              className="ml-auto border rounded-md px-2 py-1 w-28"
              style={{ borderColor: "#E9E8E3" }}
            />
          </label>
          <label className="flex items-center gap-2">
            Process
            <input
              readOnly
              value={isTallyOnline ? "Tally Prime running ✓" : "Not detected"}
              className="ml-auto border rounded-md px-2 py-1 w-52 bg-[#F5F4EF]"
              style={{ borderColor: "#E9E8E3" }}
            />
          </label>
          <label className="flex items-center gap-2">
            Version
            <input
              readOnly
              value={version}
              className="ml-auto border rounded-md px-2 py-1 w-40 bg-[#F5F4EF]"
              style={{ borderColor: "#E9E8E3" }}
            />
          </label>
        </div>
        <div className="flex items-center justify-end mt-3">
          <button
            onClick={() => {
              if (isSyncing || forceUpdate) {
                return;
              }
              setSaved(true);
              updatePort(port);
            }}
            className={`px-3 py-1.5 rounded-md border text-[#1A1A1A] hover:bg-[#E8F5ED] hover:text-[#2D7D46] ${
              forceUpdate ? "cursor-not-allowed" : ""
            }`}
            style={{ borderColor: "#E9E8E3" }}
          >
            Save
          </button>
        </div>
        {saved && (
          <div className="text-xs text-[#2D7D46] mt-2">
            Saved and applied.
          </div>
        )}
      </Card>
      <AppUpdate
        appVersion={appVersion}
        isVersionUpdateModalOpen={isVersionUpdateModalOpen}
        forceUpdate={forceUpdate}
        updateState={updateState}
      />
    </div>
  );
}
