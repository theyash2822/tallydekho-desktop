import React, { useCallback, useContext, useEffect, useState } from "react";
import Card from "../components/Card";
import Badge from "../components/Badge";
import { TallyContext } from "../../utils/TallyContext";
import AppUpdate from "../components/AppUpdate";
import {
  tdlViewModel,
  setupResultNote,
  healthError,
} from "../../utils/tdlStatusView";

const TONE_COLOR = { success: "#2D7D46", warn: "#D97706", danger: "#C0392B" };

export default function Settings() {
  const {
    state: {
      isTallyOnline,
      version,
      port: defaultPort,
      isSyncing,
      appVersion,
      isVersionUpdateModalOpen,
      forceUpdate,
    },
    updatePort,
    updateState,
  } = useContext(TallyContext);

  const [port, setPort] = useState(defaultPort);
  const [saved, setSaved] = useState(false);
  const [tdlHealth, setTdlHealth] = useState(null);
  const [tdlBusy, setTdlBusy] = useState(false);
  const [tdlNote, setTdlNote] = useState(null);

  const refreshTdl = useCallback(async () => {
    if (!window.tally?.tdlHealth) {
      setTdlHealth(healthError("TDL health API unavailable — restart the app."));
      return;
    }
    setTdlBusy(true);
    setTdlNote(null);
    try {
      const h = await window.tally.tdlHealth();
      setTdlHealth(h);
    } catch (e) {
      setTdlHealth(healthError(e?.message || "Health check failed."));
    } finally {
      setTdlBusy(false);
    }
  }, []);

  useEffect(() => {
    refreshTdl();
  }, [refreshTdl]);

  useEffect(() => {
    if (saved) {
      const t = setTimeout(() => setSaved(false), 1200);
      return () => clearTimeout(t);
    }
  }, [saved]);

  const onRetrySetup = async () => {
    if (!window.tally?.tdlSetup || tdlBusy) return;
    setTdlBusy(true);
    setTdlNote(null);
    try {
      const h = await window.tally.tdlSetup();
      setTdlHealth(h);
      setTdlNote(setupResultNote(h));
    } catch (e) {
      setTdlNote({ text: e?.message || "Setup failed.", tone: "danger" });
    } finally {
      setTdlBusy(false);
    }
  };

  const onSelectFolder = async () => {
    if (!window.tally?.tdlSelectPath || tdlBusy) return;
    setTdlBusy(true);
    setTdlNote(null);
    try {
      const res = await window.tally.tdlSelectPath();
      if (res?.cancelled) {
        setTdlNote(null);
        return;
      }
      if (res?.health) {
        setTdlHealth(res.health);
        setTdlNote(setupResultNote(res.health));
      } else if (res?.message) {
        setTdlNote({ text: res.message, tone: "danger" });
      }
    } catch (e) {
      setTdlNote({ text: e?.message || "Folder select failed.", tone: "danger" });
    } finally {
      setTdlBusy(false);
    }
  };

  const tdlView = tdlViewModel(tdlHealth, { busy: tdlBusy });
  const missingList = tdlHealth?.missing?.length ? tdlHealth.missing : [];

  return (
    <div className="space-y-3">
      <Card title="Tally Connection">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <label className="flex items-center gap-2">
            Host
            <input
              readOnly
              value="localhost"
              className="ml-auto border rounded-md px-2 py-1 w-40 bg-[#F5F4EF]"
              style={{ borderColor: "#E9E8E3" }}
            />
          </label>
          <label className="flex items-center gap-2">
            Port
            <input
              value={port}
              onChange={(e) => setPort(Number(e.target.value || 0))}
              type="number"
              className="ml-auto border rounded-md px-2 py-1 w-28"
              style={{ borderColor: "#E9E8E3" }}
            />
          </label>
          <label className="flex items-center gap-2">
            Process
            <input
              readOnly
              value={isTallyOnline ? "Tally Prime running ✓" : "Not detected"}
              className="ml-auto border rounded-md px-2 py-1 w-52 bg-[#F5F4EF]"
              style={{ borderColor: "#E9E8E3" }}
            />
          </label>
          <label className="flex items-center gap-2">
            Version
            <input
              readOnly
              value={version}
              className="ml-auto border rounded-md px-2 py-1 w-40 bg-[#F5F4EF]"
              style={{ borderColor: "#E9E8E3" }}
            />
          </label>
        </div>
        <div className="flex items-center justify-end mt-3">
          <button
            onClick={() => {
              if (isSyncing || forceUpdate) {
                return;
              }
              setSaved(true);
              updatePort(port);
            }}
            className={`px-3 py-1.5 rounded-md border text-[#1A1A1A] hover:bg-[#F0EFE9] hover:text-[#1A1A1A] ${
              forceUpdate ? "cursor-not-allowed" : ""
            }`}
            style={{ borderColor: "#E9E8E3" }}
          >
            Save
          </button>
        </div>
        {saved && (
          <div className="text-xs text-[#2D7D46] mt-2">
            Saved and applied.
          </div>
        )}

        {/* Bill Outstanding TDL — same card, matching spacing */}
        <div
          className="mt-4 pt-4"
          style={{ borderTop: "1px solid #E9E8E3" }}
        >
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="text-sm font-semibold" style={{ color: "#1A1A1A" }}>
              Bill Outstanding TDL
            </div>
            <Badge label={tdlView.badge} tone={tdlView.tone} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <label className="flex items-center gap-2">
              Tally folder
              <input
                readOnly
                value={tdlHealth?.tallyDir || "Not detected"}
                title={tdlHealth?.tallyDir || ""}
                className="ml-auto border rounded-md px-2 py-1 w-52 bg-[#F5F4EF] truncate"
                style={{ borderColor: "#E9E8E3" }}
              />
            </label>
            <label className="flex items-center gap-2">
              TDL file
              <input
                readOnly
                value={tdlView.rows.file}
                className="ml-auto border rounded-md px-2 py-1 w-40 bg-[#F5F4EF]"
                style={{ borderColor: "#E9E8E3" }}
              />
            </label>
            <label className="flex items-center gap-2">
              tally.ini
              <input
                readOnly
                value={tdlView.rows.ini}
                className="ml-auto border rounded-md px-2 py-1 w-40 bg-[#F5F4EF]"
                style={{ borderColor: "#E9E8E3" }}
              />
            </label>
            <label className="flex items-center gap-2">
              In Tally
              <input
                readOnly
                value={tdlView.rows.inTally}
                className="ml-auto border rounded-md px-2 py-1 w-40 bg-[#F5F4EF]"
                style={{ borderColor: "#E9E8E3" }}
              />
            </label>
            <label className="flex items-center gap-2">
              Detected via
              <input
                readOnly
                value={tdlHealth?.detectSource || "—"}
                className="ml-auto border rounded-md px-2 py-1 w-40 bg-[#F5F4EF]"
                style={{ borderColor: "#E9E8E3" }}
              />
            </label>
          </div>

          {missingList.length > 0 && (
            <div className="mt-3 text-xs" style={{ color: "#C0392B" }}>
              Missing: {missingList.join(" · ")}
            </div>
          )}

          {tdlView.message && (
            <div
              className="mt-3 text-xs"
              style={{ color: TONE_COLOR[tdlView.messageTone] }}
            >
              {tdlView.message}
            </div>
          )}

          {tdlNote && !tdlBusy && (
            <div
              className="mt-2 text-xs"
              style={{ color: TONE_COLOR[tdlNote.tone] }}
            >
              {tdlNote.text}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 mt-3 flex-wrap">
            <button
              type="button"
              disabled={tdlBusy}
              onClick={refreshTdl}
              className="px-3 py-1.5 rounded-md border text-[#1A1A1A] hover:bg-[#F0EFE9] disabled:opacity-50"
              style={{ borderColor: "#E9E8E3" }}
            >
              Check now
            </button>
            <button
              type="button"
              disabled={tdlBusy}
              onClick={onSelectFolder}
              className="px-3 py-1.5 rounded-md border text-[#1A1A1A] hover:bg-[#F0EFE9] disabled:opacity-50"
              style={{ borderColor: "#E9E8E3" }}
            >
              Select Tally folder
            </button>
            <button
              type="button"
              disabled={tdlBusy}
              onClick={onRetrySetup}
              className="px-3 py-1.5 rounded-md border text-[#1A1A1A] hover:bg-[#F0EFE9] disabled:opacity-50"
              style={{ borderColor: "#E9E8E3" }}
            >
              Retry setup
            </button>
          </div>
        </div>
      </Card>
      <AppUpdate
        appVersion={appVersion}
        isVersionUpdateModalOpen={isVersionUpdateModalOpen}
        forceUpdate={forceUpdate}
        updateState={updateState}
      />
    </div>
  );
}
