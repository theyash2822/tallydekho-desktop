const border = { borderColor: "#D5D9E4" };

const ForceUpdateModal = ({ onConfirm }) => {
  const onClose = async () => {
    try {
      await window.api.close();
    } catch (err) {}
  };
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
            <div className="font-semibold">Update required</div>
          </div>
          <div className="p-4 space-y-2 text-sm">
            <p>Version is no longer supported.</p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                className="px-3 py-1.5 rounded-md border"
                style={border}
                onClick={onClose}
              >
                Quit
              </button>
              <button
                className="px-3 py-1.5 rounded-md border text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
                style={border}
                onClick={onConfirm}
              >
                Update Now
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ForceUpdateModal;
