import React from "react";
import Card from "./Card";

export default function LineageMismatchCard({
  mismatch,
  onRestore,
  onReset,
  onHardSync,
}) {
  if (!mismatch) return null;
  const guidSwap = mismatch.reason === "guid_replacement_candidate";

  return (
    <Card title="Tally does not match this Workspace">
      <div className="space-y-2 text-sm">
        <p className="text-[#787774]">
          {guidSwap
            ? "Company GUID changed. Owner/Admin can approve a GUID Replacement Hard Sync, or restore the workspace backup."
            : "This Tally data is not the dataset bound to this Workspace. Do not overwrite the cloud. Owner options:"}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            onClick={onRestore}
            className="px-3 py-1.5 rounded-md border text-[#787774] hover:bg-[#F0EFE9]"
            style={{ borderColor: "#E9E8E3" }}
          >
            Restore Existing Workspace
          </button>
          {guidSwap ? (
            <button
              onClick={onHardSync}
              className="px-3 py-1.5 rounded-md border text-[#787774] hover:bg-[#F0EFE9]"
              style={{ borderColor: "#E9E8E3" }}
            >
              GUID Replacement Hard Sync
            </button>
          ) : (
            <button
              onClick={onReset}
              className="px-3 py-1.5 rounded-md border text-[#C0392B] hover:bg-[#FDECEA]"
              style={{ borderColor: "#EDBBB8" }}
            >
              Reset Workspace for New Tally
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
