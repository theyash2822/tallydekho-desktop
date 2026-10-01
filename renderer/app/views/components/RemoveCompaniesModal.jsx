const border = { borderColor: "#E9E8E3" };

const RemoveCompaniesModal = ({ companies = [], paired, busy, errorMessage, onClose, onConfirm }) => {
  const count = companies.length;
  const title =
    count === 1 ? `Remove "${companies[0]?.name || "this company"}"?` : `Remove ${count} companies?`;
  const it = count === 1 ? "it" : "them";

  return (
    <div className="fixed inset-0 z-50 pointer-events-none !m-0">
      <div className="absolute inset-0 bg-black/40 pointer-events-auto" />

      <div className="absolute inset-0 grid place-items-center">
        <div
          className="pointer-events-auto no-drag bg-white rounded-xl border w-[560px] max-h-[80vh] overflow-auto shadow-2xl"
          style={border}
        >
          <div className="flex items-center justify-between px-4 py-2 border-b" style={border}>
            <div className="font-semibold">{title}</div>
            <button onClick={onClose} disabled={busy} className="text-[#9A9A97] disabled:opacity-50">
              ✕
            </button>
          </div>
          <div className="p-4 space-y-2 text-sm">
            {count > 1 && (
              <ul className="list-disc pl-5 text-[#555]">
                {companies.map((c) => (
                  <li key={c.guid || c.name}>{c.name || c.guid}</li>
                ))}
              </ul>
            )}
            {paired ? (
              <p>
                {count === 1 ? "It" : "They"} will disappear from the mobile app and web portal right
                away. Synced data is kept — add {it} again any time to bring {it} back.
              </p>
            ) : (
              <p>
                This Desktop is not paired, so {it} will only be removed here. The mobile app and web
                portal will catch up after you pair and sync.
              </p>
            )}
            {errorMessage && (
              <p className="text-[#C0392B] bg-[#FDECEA] rounded-md px-2 py-1.5">{errorMessage}</p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                className="px-3 py-1.5 rounded-md border disabled:opacity-50"
                style={border}
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1.5 rounded-md border text-[#787774] hover:bg-[#FDECEA] hover:text-[#C0392B] disabled:opacity-50"
                style={{ borderColor: "#EDBBB8" }}
                onClick={onConfirm}
                disabled={busy}
              >
                {busy ? "Removing…" : errorMessage ? "Try again" : "Remove"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RemoveCompaniesModal;
