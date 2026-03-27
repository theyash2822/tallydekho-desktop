import React from "react";

const border = { borderColor: "#D5D9E4" };
const NAV = [
  { id: "dashboard", label: "Dashboard" },
  { id: "backup", label: "Backup & Restore" },
  { id: "devices", label: "Devices" },
  { id: "settings", label: "Settings" },
  { id: "help", label: "Help Center" },
];

export default function Sidebar({ active, updateState, forceUpdate }) {
  return (
    <aside className="w-48 h-full border-r flex flex-col" style={border}>
      <div className="p-3">
        <nav className="space-y-1">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => !forceUpdate && updateState("active", n.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-left ${
                active === n.id
                  ? "bg-emerald-50 text-emerald-900 border"
                  : `hover:bg-slate-50 ${
                      forceUpdate ? "cursor-not-allowed" : ""
                    }`
              }`}
              style={active === n.id ? border : {}}
            >
              <span className="text-sm">{n.label}</span>
            </button>
          ))}
        </nav>
      </div>
      <div className="px-3 pt-3 pb-4 mt-auto text-xs text-slate-600">
        <div className="rounded-md p-3 border text-center" style={border}>
          <b>© {new Date().getFullYear()} Tallydekho</b>
        </div>
      </div>
    </aside>
  );
}
