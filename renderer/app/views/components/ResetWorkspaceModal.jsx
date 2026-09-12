import React, { useState } from "react";

export function ResetWorkspaceModal({ onClose, onConfirm }) {
  const [text, setText] = useState("");
  const allow = text.trim().toUpperCase() === "RESET WORKSPACE";

  return (
    <div className="fixed inset-0 bg-black/40 grid place-items-center !m-0 z-50">
      <div
        className="bg-white rounded-xl border w-[560px]"
        style={{ borderColor: "#E9E8E3" }}
      >
        <div
          className="flex items-center justify-between px-4 py-2 border-b"
          style={{ borderColor: "#E9E8E3" }}
        >
          <div className="font-semibold text-[#C0392B]">
            Reset Workspace for New Tally
          </div>
          <button onClick={onClose} className="text-[#9A9A97]">
            ✕
          </button>
        </div>
        <div className="p-4 space-y-3 text-sm">
          <p className="text-[#787774]">
            This starts a Workspace Reset so this Tally can become the new source.
            Cloud Tally data, backups, and the Desktop binding are cleared after Owner
            confirmation. Local Tally company files on this PC are not deleted.
          </p>
          <ul className="list-disc pl-5 text-[#787774]">
            <li>Owner confirms on Web (phrase + email), then a 24-hour wait.</li>
            <li>This Desktop unpairs when reset completes.</li>
            <li>Hard Sync is different — it rebuilds the same Tally, it does not reset.</li>
          </ul>
          <label className="block mt-2">
            <div className="text-xs text-[#9A9A97] mb-1">
              Type <b>RESET WORKSPACE</b> to confirm
            </div>
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full border rounded-md px-2 py-1"
              style={{ borderColor: "#EDBBB8", outline: "none" }}
            />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <button
              className="px-3 py-1.5 rounded-md border"
              style={{ borderColor: "#E9E8E3" }}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              disabled={!allow}
              onClick={onConfirm}
              className={`px-3 py-1.5 rounded-md border ${
                allow
                  ? "text-[#787774] hover:bg-[#FDECEA] hover:text-[#C0392B] border-[#EDBBB8]"
                  : "bg-[#F0EFE9] text-[#AEACA8] cursor-not-allowed border-[#E9E8E3]"
              }`}
            >
              Request reset
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
