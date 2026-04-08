const border = { borderColor: "#E9E8E3" };

const StartRestoreModal = ({ onClose, onConfirm }) => {
  return (
    <div className="fixed inset-0 bg-black/30 grid place-items-center !m-0">
      <div
        className="bg-white rounded-xl border w-[560px] overflow-auto"
        style={border}
      >
        <div
          className="flex items-center justify-between px-4 py-2 border-b"
          style={border}
        >
          <div className="font-semibold">Are you sure?</div>
          <button onClick={onClose} className="text-[#9A9A97]">
            ✕
          </button>
        </div>
        <div className="p-4 space-y-2 text-sm">
          <p>
            Tally will be closed to restore the backup. Are you sure you want to{" "}
            <span className="font-medium">close Tally?</span>
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <button
              className="px-3 py-1.5 rounded-md border"
              style={border}
              onClick={onClose}
            >
              No
            </button>
            <button
              className="px-3 py-1.5 rounded-md border text-[#787774] hover:bg-[#E8F5ED] hover:text-[#2D7D46]"
              style={border}
              onClick={onConfirm}
            >
              Yes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StartRestoreModal;
