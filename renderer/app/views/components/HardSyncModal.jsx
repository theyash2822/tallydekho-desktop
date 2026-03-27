import React, { useState } from "react";

export function HardSyncModal({ onClose, onConfirm }) {
  const [text, setText] = useState("");

  const allow = text.trim().toUpperCase() === "HARD";

  return (
    <div className="fixed inset-0 bg-black/40 grid place-items-center !m-0">
      <div
        className="bg-white rounded-xl border w-[560px]"
        style={{ borderColor: "#D5D9E4" }}
      >
        <div
          className="flex items-center justify-between px-4 py-2 border-b"
          style={{ borderColor: "#D5D9E4" }}
        >
          <div className="font-semibold text-rose-700">
            Hard Sync (Critical)
          </div>
          <button onClick={onClose} className="text-slate-500">
            ✕
          </button>
        </div>
        <div className="p-4 space-y-3 text-sm">
          <p className="text-slate-700">
            This will perform a deep resynchronization. Use only if normal sync
            isn't updating data correctly.
          </p>
          <ul className="list-disc pl-5 text-slate-600">
            <li>May take longer than usual.</li>
            <li>Temporarily increases system load.</li>
          </ul>
          <label className="block mt-2">
            <div className="text-xs text-slate-500 mb-1">
              Type <b>HARD</b> to confirm
            </div>
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full border rounded-md px-2 py-1"
              style={{ borderColor: "#fca5a5", outline: "none" }}
            />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <button
              className="px-3 py-1.5 rounded-md border"
              style={{ borderColor: "#D5D9E4" }}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              disabled={!allow}
              onClick={onConfirm}
              className={`px-3 py-1.5 rounded-md border ${
                allow
                  ? "text-slate-700 hover:bg-rose-50 hover:text-rose-700 border-[#fca5a5]"
                  : "bg-[#F3F4F6] text-[#9CA3AF] cursor-not-allowed border-[#D5D9E4]"
              }`}
            >
              Start Hard Sync
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
