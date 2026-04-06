import React, { useContext, useEffect, useState } from "react";
import Card from "../components/Card";
import Deployer from "./Deployer";
import { TallyContext } from "../../utils/TallyContext";
import RemovePairedDeviceModal from "../components/RemovePairedDeviceModal";

export default function Devices() {
  const [isRemoveDeviceModalOpen, setIsRemoveDeviceModalOpen] = useState(false);
  const [userProfile, setUserProfile] = useState(null);

  const {
    state: { pairedDevice, pairingCodeGeneratedAt },
    updateState,
    openAlertModal,
  } = useContext(TallyContext);

  useEffect(() => {
    window.api?.userProfile?.().then(res => {
      if (res?.status && res?.data) setUserProfile(res.data);
    }).catch(() => {});
  }, []);

  // useEffect(() => {
  //   if (pairingCodeGeneratedAt && !pairedDevice) {
  //     const generatedAt = new Date(pairingCodeGeneratedAt);
  //     const currentDate = new Date();

  //     const differenceInMillis = currentDate - generatedAt;

  //     const differenceInMinutes = differenceInMillis / (1000 * 60);

  //     if (differenceInMinutes < 10) {
  //       window.api
  //         .pairedDevice()
  //         .then((response) => {
  //           if (response.status) {
  //             updateState("pairedDevice", response.data);
  //           }
  //         })
  //         .catch();
  //     }
  //   }
  // }, [pairingCodeGeneratedAt]);

  const closeRemoveDeviceModal = () => {
    setIsRemoveDeviceModalOpen(false);
  };

  const removeDeviceHandler = async () => {
    const response = await window.api.removePairedDevice();
    closeRemoveDeviceModal();
    if (response.status) {
      updateState("pairedDevice", null);
    } else {
      openAlertModal(
        "Something went wrong while removing paired device. If this message persists, please contact the support team.",
        true
      );
    }
  };

  return (
    <div className="space-y-3">
      {pairedDevice && (
        <Card title="Paired Device">
          <div
            className="relative overflow-hidden rounded-xl border p-3"
            style={{
              borderColor: "#D5D9E4",
              background: "linear-gradient(135deg, #f8fafc, #eef2f7)",
            }}
          >
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <div className="inline-flex items-center gap-2">
                  <span
                    className="px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-800"
                    style={{ borderColor: "#D5D9E4" }}
                  >
                    Device
                  </span>
                  <span className="text-xs text-slate-500">•</span>
                  <span className="text-xs text-slate-600">
                    OS {pairedDevice.os}
                  </span>
                </div>
                <div className="text-xl font-semibold tracking-wide">
                  {pairedDevice.name}
                </div>
                <div className="text-xs text-slate-500">
                  Last sync: {pairedDevice.last ? pairedDevice.last : "never"}
                </div>
              </div>
              <div>
                <div className="flex justify-end">
                  <div
                    className="text-xs font-semibold rounded-full border px-2 py-0.5"
                    style={{ borderColor: "#D5D9E4", width: "fit-content" }}
                  >
                    PAIRED
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  {/* <button
                    className="px-3 py-1.5 rounded-md border text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
                    style={{ borderColor: "#D5D9E4" }}
                  >
                    Block
                  </button> */}
                  <button
                    className="px-3 py-1.5 rounded-md border text-slate-700 hover:bg-rose-50 hover:text-rose-700"
                    style={{ borderColor: "#fca5a5" }}
                    onClick={() => setIsRemoveDeviceModalOpen(true)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}
      <Card title="Profile (read-only)">
        <div
          className="relative overflow-hidden rounded-xl border p-3"
          style={{
            borderColor: "#D5D9E4",
            background: "linear-gradient(135deg, #f8fafc, #eef2f7)",
          }}
        >
          <div className="flex items-center gap-2 mb-3 text-sm">
            <span
              className="px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-800"
              style={{ borderColor: "#D5D9E4" }}
            >
              {userProfile?.name || 'User'}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <div className="flex flex-col">
              <span className="text-xs text-slate-500 mb-1">Name</span>
              <input
                readOnly
                value={userProfile?.name || 'Not set'}
                className="border rounded-md px-2 py-1 w-full bg-white"
                style={{ borderColor: "#D5D9E4" }}
              />
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-slate-500 mb-1">Email</span>
              <input
                readOnly
                value={userProfile?.email || 'Not set'}
                className="border rounded-md px-2 py-1 w-full bg-white"
                style={{ borderColor: "#D5D9E4" }}
              />
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-slate-500 mb-1">Mobile</span>
              <input
                readOnly
                value={userProfile?.mobile ? `+91 ${userProfile.mobile}` : 'Not set'}
                className="border rounded-md px-2 py-1 w-full bg-white"
                style={{ borderColor: "#D5D9E4" }}
              />
            </div>
          </div>
          <div className="text-xs text-slate-500 mt-2">
            Edited on mobile app only.
          </div>
        </div>
      </Card>

      {/* <Deployer /> */}
      {isRemoveDeviceModalOpen && (
        <RemovePairedDeviceModal
          device={pairedDevice.name}
          onClose={closeRemoveDeviceModal}
          onConfirm={removeDeviceHandler}
        />
      )}
    </div>
  );
}
