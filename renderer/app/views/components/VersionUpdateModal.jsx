const border = { borderColor: "#E9E8E3" };

const VersionUpdateModal = ({ onClose, onConfirm }) => {
  return (
    <div className="fixed inset-0 z-50 pointer-events-none !m-0">
      <div className="absolute inset-0 bg-black/40 pointer-events-auto" />

      <div className="absolute inset-0 grid place-items-center">
        <div
          className="pointer-events-auto no-drag bg-white rounded-xl border w-[560px] max-h-[80vh] overflow-auto shadow-2xl"
          style={border}
        >
          <div
            className="flex items-center justify-between px-4 py-2 border-b"
            style={border}
          >
            <div className="font-semibold">New Version Available</div>
            <button onClick={onClose} className="text-[#9A9A97]">
              ✕
            </button>
          </div>
          <div className="p-4 space-y-2 text-sm">
            <p>A newer version is available.</p>
            <p>
              It includes improvements and bug fixes to enhance your experience.
            </p>
            <p>Would you like to download and install the update now?</p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                className="px-3 py-1.5 rounded-md border"
                style={border}
                onClick={onClose}
              >
                Later
              </button>
              <button
                className="px-3 py-1.5 rounded-md border text-[#787774] hover:bg-[#F0EFE9] hover:text-[#1A1A1A]"
                style={border}
                onClick={onConfirm}
              >
                Update
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VersionUpdateModal;
