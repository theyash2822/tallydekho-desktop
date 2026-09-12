import React, { useContext, useEffect, useState } from "react";
import Card from "../components/Card";
import { TallyContext } from "../../utils/TallyContext";
import RemovePairedDeviceModal from "../components/RemovePairedDeviceModal";
import { ResetWorkspaceModal } from "../components/ResetWorkspaceModal";
import LineageMismatchCard from "../components/LineageMismatchCard";

export default function Devices() {
  const [isRemoveDeviceModalOpen, setIsRemoveDeviceModalOpen] = useState(false);
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);
  const [userProfile, setUserProfile] = useState(null);

  const {
    state: {
      pairedDevice,
      lastSync,
      workspace,
      lineageMismatch,
      restoreCode,
      resetWaitMessage,
    },
    updateState,
    openAlertModal,
  } = useContext(TallyContext);

  useEffect(() => {
    window.api?.userProfile?.().then(res => {
      if (res?.status && res?.data) {
        setUserProfile(res.data);
        if (res.data.workspace) updateState("workspace", res.data.workspace);
      }
    }).catch(() => {});
  }, []);

  const closeRemoveDeviceModal = () => {
    setIsRemoveDeviceModalOpen(false);
  };

  const removeDeviceHandler = async () => {
    const response = await window.api.removePairedDevice();
    closeRemoveDeviceModal();
    if (response.status) {
      updateState("pairedDevice", null);
      setUserProfile(null);
    } else {
      openAlertModal(
        "Something went wrong while removing paired device. If this message persists, please contact the support team.",
        true
      );
    }
  };

  const startRestore = async () => {
    const res = await window.tally.restoreRequest();
    if (res?.status && res.data?.code) {
      updateState("restoreCode", res.data.code);
      openAlertModal(
        `Restore code: ${res.data.code}. Owner/Admin must approve a backup on Web or Mobile, then use Check approval / restore on Dashboard.`
      );
    } else {
      openAlertModal(res?.message || "Could not start restore request");
    }
  };

  const requestReset = async () => {
    setIsResetModalOpen(false);
    const res = await window.tally.resetRequest();
    if (res?.status) {
      const hours = res.data?.hours || 24;
      updateState(
        "resetWaitMessage",
        `Reset requested. Confirm on Web → Settings (type RESET WORKSPACE), then wait ${hours} hours. This Desktop will unpair when reset completes. Local Tally files stay.`
      );
      openAlertModal(
        `Reset requested. Owner must confirm on Web (phrase RESET WORKSPACE + emails). After the ${hours}-hour wait, this Desktop unpairs. Local Tally files are not deleted.`
      );
    } else {
      openAlertModal(
        res?.message ||
          "Could not request reset. Only the Workspace Owner can start Reset from this Desktop."
      );
    }
  };

  const wsName = userProfile?.workspace?.name || workspace?.name || pairedDevice?.name;
  const connected = !!(pairedDevice || userProfile?.workspace);

  return (
    <div className="space-y-3">
      <LineageMismatchCard
        mismatch={lineageMismatch}
        onRestore={startRestore}
        onReset={() => setIsResetModalOpen(true)}
        onHardSync={() => updateState("active", "dashboard")}
      />

      <Card title="Connected Workspace">
        <div
          className="relative overflow-hidden rounded-xl border p-3"
          style={{
            borderColor: "#E9E8E3",
            background: "#FFFFFF",
          }}
        >
          {connected ? (
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <div className="inline-flex items-center gap-2">
                  <span
                    className="px-2 py-0.5 rounded-full border bg-[#F5F4EF] text-[#2D7D46]"
                    style={{ borderColor: "#E9E8E3" }}
                  >
                    Workspace
                  </span>
                  <span className="text-xs text-[#9A9A97]">•</span>
                  <span className="text-xs text-[#787774]">
                    {pairedDevice?.os || "Desktop"}
                  </span>
                </div>
                <div className="text-xl font-semibold tracking-wide">
                  {wsName || "Workspace"}
                </div>
                <div className="text-xs text-[#9A9A97]">
                  Status: {userProfile?.workspace?.tallyConnection || workspace?.tallyConnection || "Connected"}
                </div>
                <div className="text-xs text-[#9A9A97]">
                  Last sync: {lastSync ? new Date(lastSync).toLocaleString() : (pairedDevice?.last || "never")}
                </div>
                {userProfile?.lastCloudBackupAt && (
                  <div className="text-xs text-[#9A9A97]">
                    Last cloud backup: {new Date(Number(userProfile.lastCloudBackupAt) * 1000).toLocaleString()}
                  </div>
                )}
                {(userProfile?.tallyCompanies || []).length > 0 && (
                  <div className="text-xs text-[#9A9A97]">
                    Tally Companies:{" "}
                    {userProfile.tallyCompanies.map((c) => c.name || c.guid).join(", ")}
                  </div>
                )}
                {resetWaitMessage && (
                  <div className="text-xs text-[#C0392B] pt-1">{resetWaitMessage}</div>
                )}
                {restoreCode && (
                  <div className="text-xs text-[#787774] pt-1">
                    Restore code: <span className="font-mono tracking-widest">{restoreCode}</span>
                  </div>
                )}
              </div>
              <div>
                <div className="flex justify-end">
                  <div
                    className="text-xs font-semibold rounded-full border px-2 py-0.5"
                    style={{ borderColor: "#E9E8E3", width: "fit-content" }}
                  >
                    CONNECTED
                  </div>
                </div>
                <div className="mt-3 flex flex-col gap-2 items-end">
                  <button
                    className="px-3 py-1.5 rounded-md border text-[#787774] hover:bg-[#F0EFE9] text-sm"
                    style={{ borderColor: "#E9E8E3" }}
                    onClick={startRestore}
                  >
                    Restore Existing Workspace
                  </button>
                  <button
                    className="px-3 py-1.5 rounded-md border text-[#C0392B] hover:bg-[#FDECEA] text-sm"
                    style={{ borderColor: "#EDBBB8" }}
                    onClick={() => setIsResetModalOpen(true)}
                  >
                    Reset Workspace for New Tally
                  </button>
                  <button
                    className="px-3 py-1.5 rounded-md border text-[#787774] hover:bg-[#FDECEA] hover:text-[#C0392B] text-sm"
                    style={{ borderColor: "#EDBBB8" }}
                    onClick={() => setIsRemoveDeviceModalOpen(true)}
                  >
                    Unpair Device
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-sm text-[#787774]">
                Not paired. Enter the pairing code on Dashboard, or restore an existing workspace onto this PC.
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="px-3 py-1.5 rounded-md border text-[#787774] hover:bg-[#F0EFE9] text-sm"
                  style={{ borderColor: "#E9E8E3" }}
                  onClick={startRestore}
                >
                  Restore Existing Workspace
                </button>
              </div>
              {restoreCode && (
                <div className="text-xs text-[#787774]">
                  Restore code: <span className="font-mono tracking-widest">{restoreCode}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
      <Card title="Profile (read-only)">
        <div
          className="relative overflow-hidden rounded-xl border p-3"
          style={{
            borderColor: "#E9E8E3",
            background: "#FFFFFF",
          }}
        >
          <div className="flex items-center gap-2 mb-3 text-sm">
            <span
              className="px-2 py-0.5 rounded-full border bg-[#F5F4EF] text-[#2D7D46]"
              style={{ borderColor: "#E9E8E3" }}
            >
              {userProfile?.name || 'User'}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <div className="flex flex-col">
              <span className="text-xs text-[#9A9A97] mb-1">Name</span>
              <input
                readOnly
                value={userProfile?.name || 'Not set'}
                className="border rounded-md px-2 py-1 w-full bg-white"
                style={{ borderColor: "#E9E8E3" }}
              />
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-[#9A9A97] mb-1">Email</span>
              <input
                readOnly
                value={userProfile?.email || 'Not set'}
                className="border rounded-md px-2 py-1 w-full bg-white"
                style={{ borderColor: "#E9E8E3" }}
              />
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-[#9A9A97] mb-1">Mobile</span>
              <input
                readOnly
                value={userProfile?.mobile ? `+91 ${userProfile.mobile}` : 'Not set'}
                className="border rounded-md px-2 py-1 w-full bg-white"
                style={{ borderColor: "#E9E8E3" }}
              />
            </div>
          </div>
          <div className="flex items-center justify-between mt-3">
            <div className="text-xs text-[#9A9A97]">Edited on mobile app only.</div>
            {(pairedDevice || userProfile) && (
              <button
                onClick={() => setIsRemoveDeviceModalOpen(true)}
                className="px-3 py-1.5 rounded-md border text-sm font-medium text-[#C0392B] hover:bg-[#FDECEA] transition-colors"
                style={{ borderColor: "#EDBBB8" }}
              >
                Unpair Device
              </button>
            )}
          </div>
        </div>
      </Card>

      {isRemoveDeviceModalOpen && (
        <RemovePairedDeviceModal
          device={pairedDevice?.name || 'this device'}
          onClose={closeRemoveDeviceModal}
          onConfirm={removeDeviceHandler}
        />
      )}
      {isResetModalOpen && (
        <ResetWorkspaceModal
          onClose={() => setIsResetModalOpen(false)}
          onConfirm={requestReset}
        />
      )}
    </div>
  );
}
