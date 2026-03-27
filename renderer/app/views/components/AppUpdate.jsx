import { useEffect, useMemo, useState } from "react";
import Card from "./Card";

export default function AppUpdate({
  appVersion,
  isVersionUpdateModalOpen,
  updateState,
  forceUpdate,
}) {
  const [state, setState] = useState("idle"); // idle | checking | available | none | downloading | downloaded | error
  const [percent, setPercent] = useState(0);
  const [isDownloadStarted, setIsDownloadStarted] = useState(false);
  const [error, setError] = useState("");
  const [releaseNotes, setReleaseNotes] = useState("");

  useEffect(() => {
    if (isVersionUpdateModalOpen || forceUpdate) {
      window.updater.check().then((response) => {
        if (response.info?.isUpdateAvailable) {
          startDownload();
        }
      });
      updateState("isVersionUpdateModalOpen", false);
    }
  }, [isVersionUpdateModalOpen, forceUpdate]);

  useEffect(() => {
    const offStatus = window.updater.onStatus(({ state: s, info, error }) => {
      if (info?.releaseNotes) {
        setReleaseNotes(info.releaseNotes);
      } else {
        setReleaseNotes("");
      }
      setIsDownloadStarted(false);
      setState(s);
      if (s === "error") setError(error || "Unknown error");
      if (s === "downloaded") setPercent(100);
    });

    const offProgress = window.updater.onProgress(({ percent = 0 }) => {
      setPercent(Math.max(0, Math.min(100, Math.round(percent))));
      setState("downloading");
    });

    // window.updater.check();

    return () => {
      offStatus?.();
      offProgress?.();
    };
  }, []);

  const startDownload = () => {
    window.updater.download();
    setIsDownloadStarted(true);
  };

  const right = useMemo(() => {
    if (state === "checking") {
      return (
        <button
          className="px-3 py-1.5 rounded-md border text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
          style={{ borderColor: "#D5D9E4" }}
          disabled
        >
          Checking…
        </button>
      );
    }
    if (state === "available") {
      return (
        <button
          className="px-3 py-1.5 rounded-md border text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
          style={{ borderColor: "#D5D9E4" }}
          onClick={startDownload}
          disabled={isDownloadStarted}
        >
          {isDownloadStarted ? "Downloading…" : "Download update"}
        </button>
      );
    }
    if (state === "downloading") {
      return (
        <button
          className="px-3 py-1.5 rounded-md border text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
          style={{ borderColor: "#D5D9E4" }}
          disabled
        >
          Downloading… {percent}%
        </button>
      );
    }
    if (state === "downloaded") {
      return (
        <button
          className="px-3 py-1.5 rounded-md border text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
          style={{ borderColor: "#D5D9E4" }}
          onClick={window.updater.quitAndInstall}
        >
          Restart to update
        </button>
      );
    }
    if (state === "idle") {
      return (
        <button
          className="px-3 py-1.5 rounded-md border text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
          style={{ borderColor: "#D5D9E4" }}
          onClick={() => {
            setError("");
            setState("checking");
            window.updater.check().finally(() => {});
          }}
        >
          Check for updates
        </button>
      );
    }
    return <></>;
  }, [state, percent, isDownloadStarted]);

  return (
    <Card title="Updates & About" right={right}>
      <div className="text-xs text-slate-500">
        Version v{appVersion} · Windows Agent
      </div>

      {state === "available" && (
        <div className="mt-2 text-xs text-slate-500">
          A new version is available.
          {releaseNotes && (
            <>
              <div className="mt-1 font-semibold">What's new:</div>
              <ul className="list-disc pl-4 mt-1">
                {releaseNotes
                  .split("\n")
                  .map(
                    (line, i) =>
                      line.trim() && <li key={i}>{line.replace(/^- /, "")}</li>
                  )}
              </ul>
            </>
          )}
        </div>
      )}
      {/* {state === "downloading" && (
        <div className="mt-2 text-xs text-slate-500">
          Downloading… {percent}%
        </div>
      )} */}
      {state === "downloaded" && (
        <div className="mt-2 text-xs text-slate-500">
          Update ready. Click “Restart to update” to install.
        </div>
      )}
      {state === "none" && (
        <div className="mt-2 text-xs text-slate-500">You're up to date.</div>
      )}
      {/* {state === "error" && (
        <div className="mt-2 text-xs text-red-600">Update error: {error}</div>
      )} */}
    </Card>
  );
}
