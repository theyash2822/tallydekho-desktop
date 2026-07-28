import React, { useCallback, useContext, useEffect, useState } from "react";
import Card from "../components/Card";
import Badge from "../components/Badge";
import { TallyContext } from "../../utils/TallyContext";
import AppUpdate from "../components/AppUpdate";

function statusTone(level) {
  if (level === "success" || level === "ok") return "success";
  if (level === "warn") return "warn";
  if (level === "danger") return "danger";
  return "default";
}

function statusLabel(health) {
  if (!health) return "Checking…";
  if (health.skipped) return "Not required";
  if (health.status === "ok" && health.liveLoaded === true) return "Ready";
  if (health.status === "ok" && health.liveLoaded === false) return "Installed";
  if (health.status === "ok") return "Ready";
  return "Needs setup";
}

function noteAfterSetup(h) {
  if (h?.status === "ok" && h?.liveLoaded) {
    if (h?.activateResult?.status) {
      return "Activated — Tally was restarted with the TDL. Sync when ready (no manual load).";
    }
    return "Active in Tally — no manual TDL load needed. Sync when ready.";
  }
  if (h?.activateResult && !h.activateResult.status) {
    return h.activateResult.message || "Could not restart Tally — open Tally, then Retry setup.";
  }
  return h?.applyResult?.hint || h?.message || "Setup incomplete — select Tally folder.";
}

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
  const [tdlNote, setTdlNote] = useState("");

  const refreshTdl = useCallback(async () => {
    if (!window.tally?.tdlHealth) {
      setTdlHealth({
        status: "blocked",
        level: "danger",
        message: "TDL health API unavailable — restart the app",
        missing: ["API unavailable"],
      });
      return;
    }
    setTdlBusy(true);
    setTdlNote("");
    try {
      const h = await window.tally.tdlHealth();
      setTdlHealth(h);
    } catch (e) {
      setTdlHealth({
        status: "blocked",
        level: "danger",
        message: e?.message || "Health check failed",
        missing: [e?.message || "unknown"],
      });
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
    setTdlNote("");
    try {
      const h = await window.tally.tdlSetup();
      setTdlHealth(h);
      setTdlNote(noteAfterSetup(h));
    } catch (e) {
      setTdlNote(e?.message || "Setup failed");
    } finally {
      setTdlBusy(false);
    }
  };

  const onSelectFolder = async () => {
    if (!window.tally?.tdlSelectPath || tdlBusy) return;
    setTdlBusy(true);
    setTdlNote("");
    try {
      const res = await window.tally.tdlSelectPath();
      if (res?.cancelled) {
        setTdlNote("");
        return;
      }
      if (res?.health) {
        setTdlHealth(res.health);
        setTdlNote(noteAfterSetup(res.health));
      } else if (res?.message) {
        setTdlNote(res.message);
      }
    } catch (e) {
      setTdlNote(e?.message || "Folder select failed");
    } finally {
      setTdlBusy(false);
    }
  };

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
            <Badge
              label={tdlBusy ? "Checking…" : statusLabel(tdlHealth)}
              tone={tdlBusy ? "default" : statusTone(tdlHealth?.level || tdlHealth?.status)}
            />
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
                value={
                  tdlHealth?.skipped
                    ? "N/A"
                    : tdlHealth?.tdlPresent
                    ? "Installed ✓"
                    : "Missing"
                }
                className="ml-auto border rounded-md px-2 py-1 w-40 bg-[#F5F4EF]"
                style={{ borderColor: "#E9E8E3" }}
              />
            </label>
            <label className="flex items-center gap-2">
              tally.ini
              <input
                readOnly
                value={
                  tdlHealth?.skipped
                    ? "N/A"
                    : !tdlHealth?.iniFound
                    ? "Not found"
                    : tdlHealth?.tdlListed && tdlHealth?.userTdlYes
                    ? "Linked ✓"
                    : "Not linked"
                }
                className="ml-auto border rounded-md px-2 py-1 w-40 bg-[#F5F4EF]"
                style={{ borderColor: "#E9E8E3" }}
              />
            </label>
            <label className="flex items-center gap-2">
              In Tally
              <input
                readOnly
                value={
                  tdlHealth?.skipped
                    ? "N/A"
                    : tdlHealth?.liveLoaded === true
                    ? `Active ✓${
                        tdlHealth?.liveBillRows != null
                          ? ` (${tdlHealth.liveBillRows} bills)`
                          : ""
                      }`
                    : tdlHealth?.liveLoaded === false
                    ? "Not loaded"
                    : "—"
                }
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

          {tdlHealth?.status === "ok" &&
            tdlHealth?.liveLoaded === true &&
            !tdlHealth?.skipped && (
              <div className="mt-3 text-xs" style={{ color: "#2D7D46" }}>
                Bill Outstanding is active — no manual TDL load needed. Sync
                when ready.
              </div>
            )}

          {tdlHealth?.liveLoaded === false && !tdlHealth?.skipped && (
            <div className="mt-3 text-xs" style={{ color: "#D97706" }}>
              Files are on disk but Tally has not loaded the report yet. Click{" "}
              <span className="font-semibold">Retry setup</span> — the app will
              restart Tally with the TDL (no F1 manual load).
            </div>
          )}

          {tdlNote && (
            <div
              className="mt-2 text-xs"
              style={{
                color:
                  tdlHealth?.status === "ok" && tdlHealth?.liveLoaded
                    ? "#2D7D46"
                    : "#D97706",
              }}
            >
              {tdlNote}
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
