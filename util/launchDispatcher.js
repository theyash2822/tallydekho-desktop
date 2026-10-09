/**
 * Launch intents for the primary instance: the first launch's own flags and every
 * second launch (Task Scheduler or the user opening the app again).
 */
const KNOWN_FLAGS = { "--run-sync": "scheduled_sync", "--run-backup": "scheduled_backup" };

/**
 * argv → { intents, rejected }. Only our own `--run-*` flags are intents; an unknown one
 * is rejected rather than read as "open the window". Anything else (the executable path,
 * Chromium switches) is ignored, so a plain launch opens the window.
 */
function parseLaunchIntents(argv) {
  const args = Array.isArray(argv) ? argv.filter((a) => typeof a === "string") : [];
  const intents = [];
  const rejected = [];
  for (const arg of args) {
    const flag = arg.split("=")[0];
    if (KNOWN_FLAGS[flag]) {
      if (!intents.includes(KNOWN_FLAGS[flag])) intents.push(KNOWN_FLAGS[flag]);
    } else if (flag.startsWith("--run-")) {
      rejected.push(flag);
    }
  }
  if (!intents.length && !rejected.length) intents.push("open_ui");
  return { intents, rejected };
}

/**
 * Process exit code for a headless run, so Task Scheduler's "Last Run Result" is truthful.
 * 0 completed or nothing due · 1 failed or partial · 2 refused (policy / not paired) · 3 deferred.
 */
const EXIT = { ok: 0, failed: 1, refused: 2, deferred: 3 };
function headlessExitCode(outcome) {
  if (!outcome || outcome.state === "succeeded" || outcome.state === "not_due") return EXIT.ok;
  if (outcome.state === "deferred") return EXIT.deferred;
  if (outcome.state === "rejected") return EXIT.refused;
  return EXIT.failed;
}

/**
 * Second-launch dispatcher. Before startup finishes, scheduled intents are queued
 * (one of each kind) instead of dropped; the coordinator decides whether they run.
 */
function createLaunchDispatcher({ isReady, isInteractive, startInteractive, showWindow, requestUi, runSync, runBackup, log = () => {} }) {
  const pending = new Set();

  const dispatch = async (intent) => {
    if (intent === "scheduled_sync") return runSync();
    if (intent === "scheduled_backup") return runBackup();
    return undefined;
  };

  return {
    async onSecondInstance(argv) {
      const { intents, rejected } = parseLaunchIntents(argv);
      if (rejected.length) log("Second instance [rejected flags]", rejected);
      for (const intent of intents) {
        log(`Second instance [intent]: ${intent}`);
        if (intent === "open_ui") {
          if (!isReady()) requestUi();
          else if (!isInteractive()) startInteractive();
          else showWindow();
          continue;
        }
        if (!isReady()) {
          pending.add(intent);
          log(`Background [${intent} queued]: still starting up`);
          continue;
        }
        await dispatch(intent);
      }
    },
    /** Run what arrived during startup, once each. */
    async drain() {
      const queued = [...pending];
      pending.clear();
      for (const intent of queued) await dispatch(intent);
      return queued;
    },
    pendingIntents: () => [...pending],
  };
}

module.exports = { parseLaunchIntents, headlessExitCode, createLaunchDispatcher, EXIT };
