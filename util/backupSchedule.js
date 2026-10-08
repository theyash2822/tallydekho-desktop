/**
 * When is a scheduled backup due? (finding 15)
 *
 * The baseline is the last *verified* backup (a completed cloud backup), never the time the
 * schedule was enabled, so an overdue backup is attempted once and not on every launch.
 * A failed attempt backs off durably; a clock that moved backwards never makes a backup due.
 * Interval and retention are unchanged (product decision D-005).
 */
const INTERVAL_DAYS = { "1day": 1, "7days": 7, "1month": 30 };
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_BASE_MS = 15 * 60 * 1000;
const RETRY_MAX_MS = 24 * 60 * 60 * 1000;
// Task Scheduler fires at the configured time of day while the last success may have finished a
// little later; without this slack a daily backup would skip every other day.
const EARLY_SLACK_MS = 6 * 60 * 60 * 1000;
// A missed weekly/monthly backup is triggered at launch only once it is clearly overdue.
const MISSED_GRACE_MS = DAY_MS;
const MISSED_TRIGGER_COOLDOWN_MS = 60 * 60 * 1000;

const toMs = (v) => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Newest verified restore point the Desktop knows of (local record or cloud list). */
function lastVerifiedBackupAt(state) {
  let best = toMs(state.lastBackupSuccessAt);
  for (const b of Array.isArray(state.cloudBackups) ? state.cloudBackups : []) {
    const status = String(b?.status || "").toUpperCase();
    if (status && !["VERIFIED", "AVAILABLE", "COMPLETED", "READY"].includes(status)) continue;
    const at = toMs(b?.completedAt ?? b?.completed_at ?? b?.createdAt ?? b?.created_at);
    if (at && (!best || at > best)) best = at;
  }
  return best;
}

/**
 * @param {object} state store values: backupInterval, lastBackupSuccessAt, cloudBackups,
 *   autoBackupStartedAt, backupFailureCount, nextBackupRetryAt
 * @param {number} nowMs
 * @param {{ missed?: boolean }} [opts] missed = launch-time catch-up (needs a clear overdue margin)
 * @returns {{ due: boolean, reason: string, baseline?: number|null }}
 */
function backupDue(state, nowMs, { missed = false } = {}) {
  const days = INTERVAL_DAYS[state.backupInterval];
  if (!days) return { due: false, reason: "schedule_off" };
  const retryAt = toMs(state.nextBackupRetryAt);
  if (retryAt && retryAt > nowMs) return { due: false, reason: "backoff", retryAt };
  const verified = lastVerifiedBackupAt(state);
  // No verified backup yet: count from enablement (the old baseline) so the first one still runs.
  const baseline = verified || toMs(state.autoBackupStartedAt);
  if (!baseline) return { due: true, reason: "no_baseline", baseline: null };
  if (baseline > nowMs + 5 * 60 * 1000) return { due: false, reason: "clock_behind", baseline };
  const interval = days * DAY_MS;
  const threshold = missed
    ? baseline + interval + MISSED_GRACE_MS
    : baseline + interval - Math.min(EARLY_SLACK_MS, interval / 4);
  if (nowMs < threshold) return { due: false, reason: "not_due", baseline };
  if (missed) {
    const last = toMs(state.lastMissedBackupTriggerAt);
    if (last && last <= nowMs && nowMs - last < MISSED_TRIGGER_COOLDOWN_MS) {
      return { due: false, reason: "recently_triggered", baseline };
    }
  }
  return { due: true, reason: verified ? "interval_elapsed" : "interval_elapsed_since_enabled", baseline };
}

/** Store patch after an attempt. A failure is never recorded as a success. */
function outcomePatch(state, { ok, nowMs }) {
  if (ok) {
    return { lastBackupSuccessAt: nowMs, backupFailureCount: 0, nextBackupRetryAt: null };
  }
  const failures = Math.max(0, Number(state.backupFailureCount) || 0) + 1;
  const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 10));
  return { backupFailureCount: failures, nextBackupRetryAt: nowMs + wait };
}

const STATE_KEYS = [
  "backupInterval",
  "lastBackupSuccessAt",
  "cloudBackups",
  "autoBackupStartedAt",
  "backupFailureCount",
  "nextBackupRetryAt",
  "lastMissedBackupTriggerAt",
];

function readScheduleState(store) {
  return Object.fromEntries(STATE_KEYS.map((k) => [k, store.get(k)]));
}

module.exports = { backupDue, outcomePatch, lastVerifiedBackupAt, readScheduleState, INTERVAL_DAYS };
