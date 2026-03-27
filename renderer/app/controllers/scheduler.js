// export function computeNextSync(lastSync, intervalMins) {
//   const base = lastSync ? lastSync.getTime() : Date.now();
//   return new Date(base + intervalMins * 60 * 1000);
// }

export function computeNextSync(params) {
  const { enabledAt, intervalMs } = params;
  const now = Date.now();

  // Helpers
  const floorToMinute = (ts) => {
    const d = new Date(ts);
    d.setSeconds(0, 0);
    return d.getTime();
  };
  const ceilToMinute = (ts) => {
    const d = new Date(ts);
    if (d.getSeconds() > 0 || d.getMilliseconds() > 0) {
      d.setMinutes(d.getMinutes() + 1);
    }
    d.setSeconds(0, 0);
    return d.getTime();
  };

  const anchor = floorToMinute(enabledAt);
  const current = ceilToMinute(now);

  // Clamp in case of clock skew
  const delta = Math.max(0, current - anchor);

  // How many full intervals have elapsed since anchor?
  const k = Math.ceil(delta / intervalMs);

  // Ensure next is always at least one interval after anchor
  const next = anchor + Math.max(k, 1) * intervalMs;

  return new Date(next);
}
