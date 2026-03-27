import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import Card from "../components/Card";
import { TallyContext } from "../../utils/TallyContext";
import { formatDate, formatDateTime } from "../../utils/datetime";
import StartRestoreModal from "../components/StartRestoreModal";
import Progress from "../components/Progress";
import { computeNextSync } from "../../controllers/scheduler";
import CustomSelect from "../components/CustomSelect";
// import ZipUpload from "./ZipUpload";

const options = [
  { value: "off", label: "OFF" },
  { value: "1day", label: "1 day" },
  { value: "7days", label: "7 days" },
  { value: "1month", label: "1 month" },
];

export default function BackupRestore() {
  const [localPath, setLocalPath] = useState(
    "C:/ProgramData/TallyDekho/Backups"
  );

  const [isConfirmationModalOpen, setIsConfirmationModalOpen] = useState(false);

  const backupPath = useRef(null);

  const {
    state: {
      isBackingUp,
      backupInterval,
      backupProgress,
      backupAndRestoreActivity,
      backups,
      isRestoring,
      restoreProgress,
      isSyncing,
      isTallyOnline,
      autoBackupStartedAt,
    },
    updateState,
  } = useContext(TallyContext);

  useEffect(() => {
    window.backup.getDir().then((r) => setLocalPath(r.dir));
  }, []);

  const selectPathHandle = async () => {
    const r = await window.backup.chooseDir();
    if (r?.dir) setLocalPath(r.dir);
    if (r?.error) console.log(r.error);
  };

  async function runBackup() {
    if (isBackingUp || isSyncing) return;

    await window.tally.startBackup();
  }

  const successConfirmationModal = async () => {
    const response = await window.api.closeByName("Tally.exe", {
      // timeoutMs: 2500,
      forceIfNoExit: true,
    });

    closeConfirmationModal();

    window.tally.startRestore(backupPath.current);
  };

  const closeConfirmationModal = () => {
    setIsConfirmationModalOpen(false);
  };

  const saveAutoBackupHandler = (value) => {
    // const value = event.target.value;
    const autoBackupStartedAt = Date.now();
    window.tally.saveAutoBackup({
      backupInterval: value,
      autoBackupStartedAt,
    });
    updateState("backupInterval", value);
    updateState("autoBackupStartedAt", autoBackupStartedAt);
  };

  const nextBackup = useMemo(() => {
    const days =
      {
        off: 0,
        "1day": 1,
        "7days": 7,
        "1month": 30,
      }[backupInterval] || 0;

    return days > 0
      ? computeNextSync({
          enabledAt: autoBackupStartedAt,
          intervalMs: days * 24 * 60 * 60 * 1000,
        })
      : null;
  }, [autoBackupStartedAt, backupInterval, isBackingUp]);

  return (
    <div className="space-y-3">
      <Card title="Backup Destinations">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div
            className="rounded-md border p-3"
            style={{ borderColor: "#D5D9E4" }}
          >
            <div className="font-medium mb-1">Local backup folder</div>
            <div className="text-slate-700 break-all truncate">
              {localPath || "Not set"}
            </div>
            {backups.length > 0 && (
              <div className="text-xs text-slate-500">
                Last backup:{" "}
                {formatDate(new Date(backups[backups.length - 1].date))}
              </div>
            )}
            <div className="mt-2 flex gap-2">
              <button
                className="px-2 py-1 rounded-md border text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
                style={{ borderColor: "#D5D9E4" }}
                onClick={selectPathHandle}
              >
                Change Path
              </button>
            </div>
          </div>
          <div
            className="rounded-md border p-3"
            style={{ borderColor: "#D5D9E4" }}
          >
            <div className="font-medium mb-1">Cloud backups</div>
            {/* <div className="text-xs text-slate-600">
              Organization: ACME Pvt. Ltd.
            </div> */}
            <div
              className="mt-2 rounded-md border"
              style={{ borderColor: "#D5D9E4" }}
            >
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 bg-slate-50">
                    <th className="py-1 px-2">Date/Time</th>
                    <th className="py-1 px-2">Size</th>
                    <th className="py-1 px-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {backups.slice(0, 2).map((backup, index) => (
                    <tr
                      key={index}
                      className="border-t"
                      style={{ borderColor: "#D5D9E4" }}
                    >
                      <td className="py-1 px-2 text-[12px]">
                        {formatDateTime(new Date(backup.date))}
                      </td>
                      <td className="py-1 px-2">{backup.size}</td>
                      <td className="py-1 px-2">
                        {/* <button className="underline text-slate-700">
                          Download
                        </button>{" "}
                        ·{" "} */}
                        <button
                          onClick={() => {
                            if (isRestoring || isSyncing) {
                              return;
                            }

                            if (isTallyOnline) {
                              setIsConfirmationModalOpen(true);
                              backupPath.current = backup.path;
                              return;
                            }
                            window.tally.startRestore(backup.path);
                          }}
                          className="underline text-slate-700"
                        >
                          Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {backups.length > 2 && (
              <div className="text-xs text-slate-500 mt-1">View all on Web</div>
            )}
          </div>
        </div>
      </Card>
      <Card title="Backup Scheduler">
        <div className="flex items-baseline gap-3 text-sm">
          <div>
            <div className="relative inline-block hidden">
              <label className="flex items-center gap-2">
                Backup schedule
                <select
                  value={backupInterval}
                  onChange={saveAutoBackupHandler}
                  className="ml-2 min-w-[140px] h-9 px-3 pr-8 bg-white rounded-md appearance-none outline-none border-transparent shadow-[inset_0_0_0_1px_#D5D9E4]"
                >
                  <option value="off">OFF</option>
                  <option value="1day">1 day</option>
                  <option value="7days">7 days</option>
                  <option value="1month">1 month</option>
                </select>
              </label>
              <svg
                className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path d="M5.5 7.5l4.5 4.5 4.5-4.5" />
              </svg>
            </div>
            <CustomSelect
              value={backupInterval}
              onChange={saveAutoBackupHandler}
              options={options}
              label="Backup schedule"
              buttonClasses="min-w-[140px]"
            />
            <div className="text-[13px] leading-tight text-slate-600 mt-2">
              {backupInterval != "off" ? (
                <span className="mr-3">
                  Next backup: {formatDateTime(nextBackup)}
                </span>
              ) : (
                ""
              )}
            </div>
          </div>
          <button
            onClick={runBackup}
            disabled={isBackingUp}
            className="px-3 py-1.5 rounded-md border text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
            style={{ borderColor: "#D5D9E4" }}
          >
            {isBackingUp ? "Backing up…" : "Run Backup Now"}
          </button>
        </div>
      </Card>
      <Card title="Recent backups & restores">
        {isRestoring && (
          <div>
            <span className="mr-2">Restore Progress: {restoreProgress}%</span>
            {/* <progress
              value={restoreProgress}
              max={100}
              style={{ width: 320 }}
            /> */}
            <Progress value={restoreProgress} />
          </div>
        )}
        {isBackingUp && (
          <div>
            <span className="mr-2">Backup Progress: {backupProgress}%</span>
            {/* <progress value={backupProgress} max={100} style={{ width: 320 }} /> */}
            <Progress value={backupProgress} />
          </div>
        )}
        <ul className="list-disc pl-5 text-sm space-y-1">
          {backupAndRestoreActivity.length === 0 ? (
            <li className="text-slate-500">No activity yet.</li>
          ) : (
            backupAndRestoreActivity
              .slice(0, 4)
              .map((activity, i) => (
                <li key={i}>{`${formatDateTime(new Date(activity.date))} — ${
                  activity.message
                }`}</li>
              ))
          )}
        </ul>
      </Card>
      {isConfirmationModalOpen && (
        <StartRestoreModal
          onClose={closeConfirmationModal}
          onConfirm={successConfirmationModal}
        />
      )}
    </div>
  );
}
