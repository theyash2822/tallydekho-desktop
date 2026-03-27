import React, { useRef, useState } from "react";
import Card from "../components/Card";

export default function Help() {
  const [msgs, setMsgs] = useState([
    {
      from: "bot",
      text: "Hi! How can I help? You can attach up to 5 files (PDF/PNG/JPG), max 5 MB each.",
    },
  ]);
  const boxRef = useRef(null);

  async function send() {
    const t = boxRef.current?.value?.trim();
    if (!t) return;
    setMsgs((m) => [
      ...m,
      { from: "me", text: t },
      {
        from: "bot",
        text: "Thanks! A support agent will review your details.",
      },
    ]);
    if (boxRef.current) boxRef.current.value = "";
  }

  async function handleAttach() {
    try {
      const files = await window.api.pickFiles({
        properties: ["openFile", "multiSelections"],
      });
      if (!files || files.length === 0) return;
      const names = files.map((f) => f.split(/[/\\]/).pop()).join(", ");
      setMsgs((m) => [
        ...m,
        {
          from: "me",
          text: `(Attached ${files.length} file${
            files.length > 1 ? "s" : ""
          }: ${names})`,
        },
      ]);
    } catch {
      // ignore
    }
  }

  async function emailSupport() {
    try {
      await window.api.openExternal();
    } catch {
      /* no-op */
    }
  }

  return (
    <div className="grid grid-rows-[1fr_auto] h-full">
      <div className="space-y-2 overflow-auto p-1">
        {msgs.map((m, i) => (
          <div
            key={i}
            className={`max-w-[70%] px-3 py-2 rounded-lg border ${
              m.from === "me" ? "ml-auto bg-emerald-50" : "bg-white"
            }`}
            style={{ borderColor: "#D5D9E4" }}
          >
            <div className="text-xs text-slate-500 mb-0.5">
              {m.from === "me" ? "You" : "Assistant"}
            </div>
            <div className="text-sm">{m.text}</div>
          </div>
        ))}
      </div>
      <div className="border-t p-2" style={{ borderColor: "#D5D9E4" }}>
        <div className="flex items-center gap-2 mb-1">
          <textarea
            ref={boxRef}
            placeholder="Type your question…"
            className="flex-1 border rounded-md px-2 py-1 text-sm"
            style={{ borderColor: "#D5D9E4" }}
          />
          <button
            onClick={handleAttach}
            className="px-3 py-1.5 rounded-md border"
            style={{ borderColor: "#D5D9E4" }}
          >
            Attach
          </button>
          <button
            onClick={send}
            className="px-3 py-1.5 rounded-md border text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
            style={{ borderColor: "#D5D9E4" }}
          >
            Send
          </button>
        </div>
        <div className="mt-2 text-xs hidden">
          <div className="font-semibold mb-1">FAQ</div>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <b>How to backup:</b> choose a local path, set a schedule, or
              click “Backup Now”.
            </li>
            <li>
              <b>How to pair:</b> Install the mobile app → Settings → Account
              Pairing → enter your 6-digit code.
            </li>
          </ul>
        </div>
        <div className="text-xs text-slate-600 flex items-center justify-end mt-2">
          {/* <button
            onClick={hardSync}
            className="px-2 py-1 rounded-md border bg-emerald-50 text-emerald-700 hover:bg-emerald-100 mr-2"
            style={{ borderColor: "#D5D9E4" }}
          >
            Hard Sync
          </button> */}
          <button
            onClick={emailSupport}
            // className="px-2 py-1 rounded-md border font-semibold"
            className="px-2 py-1 rounded-md border font-semibold"
            style={{ borderColor: "#D5D9E4" }}
          >
            Email Support
          </button>
        </div>
      </div>
    </div>
  );
}
