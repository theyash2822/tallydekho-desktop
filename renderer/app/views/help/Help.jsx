import React, { useRef, useState, useEffect } from "react";
import Card from "../components/Card";

const BOT_AVATAR = "TD";
const USER_AVATAR = "You";

const SUGGESTIONS = [
  "How do I pair my mobile with desktop?",
  "Entry is not going to Tally, what to do?",
  "How to enable Tally HTTP port?",
  "How does backup & restore work?",
  "What are optional entries?",
];

function Message({ msg }) {
  const isBot = msg.from === "bot";
  return (
    <div className={`flex gap-2 ${isBot ? "" : "flex-row-reverse"}`}>
      <div
        className={`w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-bold
          ${isBot ? "bg-[#1A1A1A] text-white" : "bg-[#E8E7E1] text-[#1A1A1A]"}`}
      >
        {isBot ? BOT_AVATAR : USER_AVATAR[0]}
      </div>
      <div
        className={`max-w-[75%] px-3 py-2 rounded-xl text-sm leading-relaxed whitespace-pre-wrap
          ${isBot
            ? "bg-white border text-[#1A1A1A]"
            : "bg-[#1A1A1A] text-white"}`}
        style={isBot ? { borderColor: "#E9E8E3" } : {}}
      >
        {msg.text}
        {msg.loading && (
          <span className="inline-flex gap-1 ml-1">
            <span className="w-1 h-1 rounded-full bg-[#AEACA8] animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1 h-1 rounded-full bg-[#AEACA8] animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1 h-1 rounded-full bg-[#AEACA8] animate-bounce" style={{ animationDelay: "300ms" }} />
          </span>
        )}
      </div>
    </div>
  );
}

export default function Help() {
  const [msgs, setMsgs] = useState([
    {
      from: "bot",
      text: "Hi! I'm the TallyDekho AI Assistant.\n\nI know everything about TallyDekho — pairing, data entry, sync, backup, Tally setup, and more.\n\nAsk me anything or pick a suggestion below.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  async function handleAttach() {
    try {
      const files = await window.api.pickFiles({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images & PDFs', extensions: ['jpg','jpeg','png','gif','pdf'] }] });
      if (!files || files.length === 0) return;
      const fs = window.require ? window.require('fs') : null;
      for (const filePath of files.slice(0, 5)) {
        const fileName = filePath.split(/[\/\\]/).pop();
        const loadingId = Date.now() + Math.random();
        setMsgs(m => [...m,
          { from: 'me', text: `(Attached: ${fileName})` },
          { from: 'bot', text: '', loading: true, id: loadingId },
        ]);
        try {
          await window.api.sendAttachment({ filePath, fileName });
          setMsgs(m => m.map(msg => msg.id === loadingId
            ? { from: 'bot', text: `Got it! Your attachment "${fileName}" has been forwarded to the TallyDekho team at project@tallydekho.com. We'll get back to you soon.` }
            : msg
          ));
        } catch {
          setMsgs(m => m.map(msg => msg.id === loadingId
            ? { from: 'bot', text: `Could not send "${fileName}". Please email it directly to project@tallydekho.com` }
            : msg
          ));
        }
      }
    } catch { /* ignore */ }
  }

  async function sendMessage(text) {
    const t = (text || input).trim();
    if (!t || loading) return;
    setInput("");

    const userMsg = { from: "me", text: t };
    const loadingMsg = { from: "bot", text: "", loading: true, id: Date.now() };

    setMsgs(m => [...m, userMsg, loadingMsg]);
    setLoading(true);

    try {
      const history = [...msgs, userMsg]
        .filter(m => !m.loading)
        .slice(-10)
        .map(m => ({ role: m.from === "me" ? "user" : "assistant", content: m.text }));

      const reply = await window.api.aiChat({ messages: history });

      setMsgs(m => m.map(msg =>
        msg.id === loadingMsg.id
          ? { from: "bot", text: reply || "Sorry, I could not get a response. Please try again." }
          : msg
      ));
    } catch (err) {
      setMsgs(m => m.map(msg =>
        msg.id === loadingMsg.id
          ? { from: "bot", text: "Could not connect to AI. Check that the backend server is running." }
          : msg
      ));
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="flex flex-col h-full" style={{ maxHeight: "calc(100vh - 120px)" }}>
      {/* Chat area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-3 p-3"
        style={{ minHeight: 0 }}
      >
        {msgs.map((m, i) => <Message key={m.id || i} msg={m} />)}
      </div>

      {/* Suggestions */}
      {msgs.length <= 2 && (
        <div className="px-3 pb-2 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s, i) => (
            <button
              key={i}
              onClick={() => sendMessage(s)}
              disabled={loading}
              className="text-xs px-2.5 py-1 rounded-full border text-[#787774] hover:bg-[#F0EFE9] hover:border-[#1A1A1A] transition-colors"
              style={{ borderColor: "#E9E8E3" }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input area */}
      <div className="border-t p-2" style={{ borderColor: "#E9E8E3" }}>
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ask anything about TallyDekho…"
            rows={2}
            disabled={loading}
            className="flex-1 border rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:border-[#1A1A1A]"
            style={{ borderColor: "#E9E8E3" }}
          />
          <button
            onClick={handleAttach}
            disabled={loading}
            className="px-3 py-2 rounded-xl text-sm border transition-colors hover:bg-[#F5F4EF]"
            style={{ borderColor: "#E9E8E3" }}
            title="Attach image or PDF — will be emailed to project@tallydekho.com"
          >
            📎
          </button>
          <button
            onClick={() => sendMessage()}
            disabled={loading || !input.trim()}
            className="px-4 py-2 rounded-xl text-sm font-medium text-white transition-colors"
            style={{
              background: loading || !input.trim() ? "#AEACA8" : "#1A1A1A",
              cursor: loading || !input.trim() ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "..." : "Send"}
          </button>
        </div>
        <div className="text-[11px] text-[#AEACA8] mt-1 text-right">
          Press Enter to send · Shift+Enter for new line
        </div>
      </div>
    </div>
  );
}
