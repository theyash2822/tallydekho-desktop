/**
 * One update check at a time. electron-updater's check cannot be cancelled, so a UI
 * timeout only settles the UI: the real check stays in flight, later requests join it,
 * and its events carry a generation so a stale result never overwrites a newer one.
 */
function createUpdateChecker({ check }) {
  let inFlight = null;
  let generation = 0;
  return {
    /** Start the underlying check, or join the one already running. */
    start() {
      if (!inFlight) {
        const gen = ++generation;
        let started;
        try {
          started = Promise.resolve(check());
        } catch (err) {
          started = Promise.reject(err);
        }
        const promise = started.finally(() => {
          if (inFlight?.gen === gen) inFlight = null;
        });
        inFlight = { gen, promise };
      }
      return inFlight;
    },
    isRunning: () => !!inFlight,
    generation: () => generation,
  };
}

const TIMEOUT_MESSAGE = "The update server did not answer. Try again later.";

/** UI-facing check: settles within timeoutMs; never starts a second underlying check. */
async function checkWithTimeout(checker, timeoutMs) {
  const { gen, promise } = checker.start();
  let timer;
  try {
    const info = await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(TIMEOUT_MESSAGE), { code: "UPDATE_CHECK_TIMEOUT" })), timeoutMs);
      }),
    ]);
    return { ok: true, generation: gen, info };
  } catch (e) {
    return {
      ok: false,
      generation: gen,
      error: e?.message || String(e),
      timedOut: e?.code === "UPDATE_CHECK_TIMEOUT",
      stillRunning: checker.isRunning(),
    };
  } finally {
    clearTimeout(timer);
  }
}

let shared = null;
/** The process-wide checker around electron-updater (startup check and Settings share it). */
function sharedUpdateChecker() {
  if (!shared) shared = createUpdateChecker({ check: () => require("electron-updater").autoUpdater.checkForUpdates() });
  return shared;
}

module.exports = { createUpdateChecker, checkWithTimeout, sharedUpdateChecker, TIMEOUT_MESSAGE };
