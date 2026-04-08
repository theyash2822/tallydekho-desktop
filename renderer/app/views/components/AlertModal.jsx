const border = { borderColor: "#E9E8E3" };

const AlertModal = ({ onClose, message, sendLogs, onSendLogs }) => {
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
            <div className="font-semibold">Alert!</div>
            <button onClick={onClose} className="text-[#9A9A97]">
              ✕
            </button>
          </div>
          <div className="p-4 space-y-2 text-sm">
            <p>{message}</p>
            <div className="flex justify-end gap-2 pt-2">
              {sendLogs && (
                <button
                  className="px-3 py-1.5 rounded-md border"
                  style={border}
                  onClick={onSendLogs}
                >
                  Send Logs
                </button>
              )}
              <button
                className="px-3 py-1.5 rounded-md border"
                style={border}
                onClick={onClose}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AlertModal;
