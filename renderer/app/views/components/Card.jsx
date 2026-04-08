import React from "react";

export default function Card({ title, right, children }) {
  return (
    <div
      className="rounded-xl"
      style={{ border: '1px solid #E9E8E3', background: '#FFFFFF' }}
    >
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: '1px solid #E9E8E3' }}
      >
        <div className="text-sm font-semibold" style={{ color: '#1A1A1A' }}>{title}</div>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}
