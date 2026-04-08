import React from "react";

const NAV = [
  { id: "dashboard", label: "Dashboard" },
  { id: "backup", label: "Backup & Restore" },
  { id: "devices", label: "Devices" },
  { id: "settings", label: "Settings" },
  { id: "help", label: "Help Center" },
];

export default function Sidebar({ active, updateState, forceUpdate }) {
  return (
    <aside
      className="w-48 h-full flex flex-col"
      style={{ borderRight: '1px solid #E9E8E3', background: '#F5F4EF' }}
    >
      <div className="p-3">
        {/* Logo */}
        <div className="flex items-center gap-2 px-3 py-2 mb-3">
          <div
            className="w-6 h-6 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
            style={{ background: '#1A1A1A' }}
          >T</div>
          <span className="text-sm font-semibold" style={{ color: '#1A1A1A' }}>TallyDekho</span>
        </div>
        <nav className="space-y-0.5">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => !forceUpdate && updateState("active", n.id)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors"
              style={{
                background: active === n.id ? '#E8E7E1' : 'transparent',
                color: active === n.id ? '#1A1A1A' : '#787774',
                fontWeight: active === n.id ? 600 : 400,
                cursor: forceUpdate ? 'not-allowed' : 'pointer',
              }}
              onMouseEnter={e => { if (active !== n.id) e.currentTarget.style.background = '#F0EFE9'; e.currentTarget.style.color = '#1A1A1A'; }}
              onMouseLeave={e => { if (active !== n.id) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#787774'; } }}
            >
              <span className="text-sm">{n.label}</span>
            </button>
          ))}
        </nav>
      </div>
      <div className="px-3 pt-3 pb-4 mt-auto">
        <div
          className="rounded-lg p-2.5 text-center text-xs"
          style={{ border: '1px solid #E9E8E3', color: '#AEACA8', background: '#FFFFFF' }}
        >
          © {new Date().getFullYear()} TallyDekho
        </div>
      </div>
    </aside>
  );
}
