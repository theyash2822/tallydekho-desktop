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
      style={{ background: '#1A1A1A', borderRight: 'none' }}
    >
      <div className="p-3">
        {/* Logo */}
        <div className="flex items-center gap-2 px-3 py-2.5 mb-2">
          <div
            className="w-6 h-6 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0"
            style={{ background: '#333333', color: '#FFFFFF' }}
          >T</div>
          <span className="text-sm font-semibold" style={{ color: '#FFFFFF' }}>TallyDekho</span>
        </div>
        <nav className="space-y-0.5">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => !forceUpdate && updateState("active", n.id)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors"
              style={{
                background: active === n.id ? '#333333' : 'transparent',
                color: active === n.id ? '#F5F4EF' : '#9A9A97',
                fontWeight: active === n.id ? 600 : 400,
                cursor: forceUpdate ? 'not-allowed' : 'pointer',
              }}
              onMouseEnter={e => {
                if (active !== n.id) {
                  e.currentTarget.style.background = '#2A2A2A';
                  e.currentTarget.style.color = '#FFFFFF';
                }
              }}
              onMouseLeave={e => {
                if (active !== n.id) {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = '#9A9A97';
                }
              }}
            >
              <span className="text-sm">{n.label}</span>
            </button>
          ))}
        </nav>
      </div>
      <div className="px-3 pt-3 pb-4 mt-auto">
        <div
          className="rounded-lg p-2.5 text-center text-xs"
          style={{ border: '1px solid #333333', color: '#787774' }}
        >
          © {new Date().getFullYear()} TallyDekho
        </div>
      </div>
    </aside>
  );
}
