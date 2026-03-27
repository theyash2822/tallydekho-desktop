import React from "react";

const border = { borderColor: "#D5D9E4" };

export default function Card({ title, right, children }) {
  return (
    <div className="rounded-xl border bg-white" style={border}>
      <div
        className="flex items-center justify-between px-4 py-2 border-b"
        style={border}
      >
        <div className="font-semibold text-slate-800">{title}</div>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}
