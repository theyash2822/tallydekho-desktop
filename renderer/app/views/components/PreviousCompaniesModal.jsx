const border = { borderColor: "#E9E8E3" };

const PreviousCompaniesModal = ({ companies = [], workspaceName, busy, onKeep, onClear }) => {
  const count = companies.length;
  return (
    <div className="fixed inset-0 z-50 pointer-events-none !m-0">
      <div className="absolute inset-0 bg-black/40 pointer-events-auto" />

      <div className="absolute inset-0 grid place-items-center">
        <div
          className="pointer-events-auto no-drag bg-white rounded-xl border w-[560px] max-h-[80vh] overflow-auto shadow-2xl"
          style={border}
        >
          <div className="flex items-center justify-between px-4 py-2 border-b" style={border}>
            <div className="font-semibold">Companies from previous workspace</div>
          </div>
          <div className="p-4 space-y-2 text-sm">
            <p>
              {count === 1 ? "This company was" : `These ${count} companies were`} selected for the
              workspace this Desktop was paired with before. Use{" "}
              {count === 1 ? "it" : "them"} for{" "}
              <span className="font-medium">{workspaceName || "this workspace"}</span>?
            </p>
            <ul className="list-disc pl-5 text-[#555]">
              {companies.map((c) => (
                <li key={c.guid || c.name}>{c.name || c.guid}</li>
              ))}
            </ul>
            <p className="text-[#9A9A97]">
              Their Tally data will sync into this workspace. Choose “Clear list” to pick companies
              again.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                className="px-3 py-1.5 rounded-md border disabled:opacity-50"
                style={border}
                onClick={onClear}
                disabled={busy}
              >
                Clear list
              </button>
              <button
                className="px-3 py-1.5 rounded-md border text-[#787774] hover:bg-[#F0EFE9] hover:text-[#1A1A1A] disabled:opacity-50"
                style={border}
                onClick={onKeep}
                disabled={busy}
              >
                Use these companies
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PreviousCompaniesModal;
