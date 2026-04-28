import React, { useContext, useEffect, useMemo, useState } from "react";
import Badge from "../components/Badge";
import { formatDateTime } from "../../utils/datetime.js";
import { TallyContext } from "../../utils/TallyContext.js";
import { computeNextSync } from "../../controllers/scheduler.js";
import CustomSelect from "../components/CustomSelect.jsx";

const options = [
  { value: 10, label: "10 min" },
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
  { value: 60, label: "60 min" },
];

export default function HeaderBar() {
  const [now, setNow] = useState(Date.now());

  const {
    state: {
      isTallyOnline,
      isOnline,
      isAutoSync,
      syncInterval,
      lastSync,
      // nextSync,
      autoSyncStartedAt,
    },
    updateState,
    versionLevel,
    versionMessage,
  } = useContext(TallyContext);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  const autoSyncHandler = (event) => {
    updateState("isAutoSync", event.target.checked);

    if (event.target.checked) {
      saveAutoSyncHandler(syncInterval);
    } else {
      window.tally.deleteAutoSync();
    }
  };

  const updateAutoSyncHandler = (value) => {
    // const value = event.target.value
    updateState("syncInterval", Number(value));
    saveAutoSyncHandler(value);
  };

  const saveAutoSyncHandler = (syncInterval) => {
    const autoSyncStartedAt = Date.now();
    window.tally.saveAutoSync({
      syncInterval,
      autoSyncStartedAt,
    });
    // const nextSync = computeNextSync({
    //   lastSyncAt: null,
    //   enabledAt: autoSyncStartedAt,
    //   intervalMs: syncInterval * 60 * 1000,
    // });
    updateState("isAutoSync", true);
    // updateState("nextSync", nextSync);
    updateState("autoSyncStartedAt", autoSyncStartedAt);
    // window.api.setPref("nextSync", nextSync);
  };

  const nextSync = useMemo(
    () =>
      computeNextSync({
        enabledAt: autoSyncStartedAt,
        // lastSyncAt: lastSync,
        intervalMs: syncInterval * 60 * 1000,
        now,
      }),
    [autoSyncStartedAt, syncInterval, now, lastSync]
  );

  return (
    <div className="mb-2">
      {/* Version compatibility banner */}
      {versionLevel >= 1 && versionMessage && (
        <div className={`mb-2 px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-2 ${
          versionLevel >= 2
            ? 'bg-[#FDECEA] text-[#C0392B] border border-[#EDBBB8]'
            : 'bg-[#FFFBEB] text-[#D97706] border border-[#FDE68A]'
        }`}>
          <span>{versionLevel >= 2 ? '⚠️ Sync blocked —' : 'ℹ️'} {versionMessage}</span>
          <button
            className="ml-auto underline"
            onClick={() => updateState('active', 'settings')}
          >Update now</button>
        </div>
      )}
      <div className="flex items-baseline justify-between">
        <div className="flex items-center gap-2 text-[#787774]">
          <Badge
            tone={isTallyOnline ? "success" : "danger"}
            label={`Tally: ${isTallyOnline ? "Connected" : "Not detected"}`}
          />
          <Badge
            tone={isOnline ? "success" : "danger"}
            label={`Internet: ${isOnline ? "Online" : "Offline"}`}
          />
        </div>
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-3 flex-wrap justify-end">
            <label className="text-sm flex items-center gap-2">
              Auto Sync{" "}
              <input
                type="checkbox" className="accent-[#1A1A1A]"
                checked={isAutoSync}
                // onChange={(e) => updateState("isAutoSync", e.target.checked)}
                onChange={autoSyncHandler}
              />
            </label>
            <div className="relative inline-block hidden">
              <label className="text-sm flex items-center gap-2">
                Interval
                <select
                  disabled={!isAutoSync}
                  value={syncInterval}
                  // onChange={(e) =>
                  //   updateState("syncInterval", Number(e.target.value))
                  // }
                  onChange={updateAutoSyncHandler}
                  className="min-w-[110px] h-9 px-3 pr-8 bg-white rounded-md appearance-none outline-none border-transparent shadow-[inset_0_0_0_1px_#E9E8E3]"
                >
                  <option value={10}>10 min</option>
                  <option value={15}>15 min</option>
                  <option value={30}>30 min</option>
                  <option value={60}>60 min</option>
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
              value={syncInterval}
              onChange={updateAutoSyncHandler}
              options={options}
              label="Interval"
              disabled={!isAutoSync}
              buttonClasses="min-w-[110px]"
            />
          </div>
          <div className="text-[12px] leading-tight text-[#787774] mt-0.5">
            {isAutoSync && (
              <>
                {nextSync ? (
                  <span className="mr-3">
                    Next sync: {formatDateTime(nextSync)}
                  </span>
                ) : (
                  ""
                )}
              </>
            )}
            {!isAutoSync && lastSync && (
              <span className="text-[#9A9A97]">
                Last sync: {formatDateTime(lastSync)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
