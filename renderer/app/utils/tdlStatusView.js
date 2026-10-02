/**
 * Settings → Bill Outstanding TDL card: one place that turns the main-process
 * health object into a UI state and every label/message shown for it.
 */

export const TDL_UI_STATE = Object.freeze({
  READY: "READY",
  OUTDATED: "OUTDATED",
  NOT_ACTIVE: "NOT_ACTIVE",
  TALLY_UNREACHABLE: "TALLY_UNREACHABLE",
  NOT_INSTALLED: "NOT_INSTALLED",
  NOT_LINKED: "NOT_LINKED",
  FOLDER_NOT_FOUND: "FOLDER_NOT_FOUND",
  NOT_REQUIRED: "NOT_REQUIRED",
  CHECKING: "CHECKING",
  ERROR: "ERROR",
});

const S = TDL_UI_STATE;

/** badge tone: success | warn | danger | default. messageTone: success | warn | danger. */
const VIEW = {
  [S.READY]: {
    badge: "Ready",
    tone: "success",
    inTally: "Active ✓",
    message: "The Bill Outstanding add-on is active in Tally. Sync when ready.",
    messageTone: "success",
  },
  [S.OUTDATED]: {
    badge: "Old version active",
    tone: "warn",
    inTally: "Active (old version)",
    message:
      "An older Bill Outstanding add-on is running in Tally. Bills sync while it returns rows; " +
      "when it returns none, the last successfully synced bills are kept. " +
      "Click Retry setup to restart Tally and load the new version.",
    messageTone: "warn",
  },
  [S.NOT_ACTIVE]: {
    badge: "Not active in Tally",
    tone: "warn",
    inTally: "Not active",
    message:
      "Tally has not confirmed the Bill Outstanding add-on. Sync will keep the last successfully " +
      "synced bills. Click Retry setup to restart Tally and load the add-on. " +
      "Normal Sync and Hard Sync never restart Tally.",
    messageTone: "warn",
  },
  [S.TALLY_UNREACHABLE]: {
    badge: "Tally not reachable",
    tone: "warn",
    inTally: "Not reachable",
    message:
      "Tally did not answer. Open Tally (or wait if it is busy), then click Check now. " +
      "Sync will keep the last successfully synced bills.",
    messageTone: "warn",
  },
  [S.NOT_INSTALLED]: {
    badge: "Needs setup",
    tone: "danger",
    inTally: "—",
    message: "The add-on file is not in the Tally folder. Click Retry setup to install it.",
    messageTone: "danger",
  },
  [S.NOT_LINKED]: {
    badge: "Needs setup",
    tone: "danger",
    inTally: "—",
    message: "tally.ini does not load the add-on yet. Click Retry setup to link it.",
    messageTone: "danger",
  },
  [S.FOLDER_NOT_FOUND]: {
    badge: "Needs setup",
    tone: "danger",
    inTally: "—",
    message: "Tally folder not found. Click Select Tally folder.",
    messageTone: "danger",
  },
  [S.NOT_REQUIRED]: {
    badge: "Not required",
    tone: "default",
    inTally: "N/A",
    message: null,
    messageTone: null,
  },
  [S.CHECKING]: {
    badge: "Checking…",
    tone: "default",
    inTally: "Checking…",
    message: null,
    messageTone: null,
  },
  [S.ERROR]: {
    badge: "Check failed",
    tone: "danger",
    inTally: "—",
    message: "Could not check the Bill Outstanding add-on.",
    messageTone: "danger",
  },
};

const ACTIVE_OLD = new Set(["ACTIVE_OUTDATED", "ACTIVE_LEGACY"]);
const UNREACHABLE = new Set(["TALLY_UNREACHABLE", "TALLY_TIMEOUT"]);

/**
 * Health object from `tally:tdl_health` / `tally:tdl_setup` → UI state.
 * Disk/ini problems win over runtime state; runtime state is READY only when
 * the health report confirmed the current add-on.
 */
export function deriveTdlUiState(health) {
  if (!health) return S.CHECKING;
  if (health.uiError) return S.ERROR;
  if (health.skipped) return S.NOT_REQUIRED;
  if (!health.tallyDir) {
    // IPC error fallback is `{ status: "blocked", missing: [err] }` without a folder-detect reason.
    return health.reason === "path_unknown" ? S.FOLDER_NOT_FOUND : S.ERROR;
  }
  if (!health.tdlPresent) return S.NOT_INSTALLED;
  if (!health.iniFound || !health.tdlListed || !health.userTdlYes || health.quotedOk === false) {
    return S.NOT_LINKED;
  }
  if (health.tdlStatus === "ACTIVE") return S.READY;
  if (ACTIVE_OLD.has(health.tdlStatus)) return S.OUTDATED;
  if (UNREACHABLE.has(health.tdlStatus)) return S.TALLY_UNREACHABLE;
  return S.NOT_ACTIVE;
}

function fileRow(health) {
  if (!health) return "—";
  if (health.skipped) return "N/A";
  return health.tdlPresent ? "Installed ✓" : "Missing";
}

function iniRow(health) {
  if (!health) return "—";
  if (health.skipped) return "N/A";
  if (!health.iniFound) return "Not found";
  if (!health.tdlListed || !health.userTdlYes) return "Not linked";
  return health.quotedOk === false ? "Needs quotes" : "Linked ✓";
}

/**
 * Everything the card renders. While busy the badge says Checking… but the rows
 * keep the last known values.
 */
export function tdlViewModel(health, { busy = false } = {}) {
  const state = deriveTdlUiState(health);
  const view = VIEW[state];
  const shown = busy ? VIEW[S.CHECKING] : view;
  return {
    state,
    badge: shown.badge,
    tone: shown.tone,
    rows: {
      file: fileRow(health),
      ini: iniRow(health),
      inTally: busy && state !== S.CHECKING ? VIEW[S.CHECKING].inTally : view.inTally,
    },
    message: busy
      ? null
      : state === S.ERROR
      ? health.uiError || health.missing?.[0] || view.message
      : view.message,
    messageTone: busy ? null : view.messageTone,
  };
}

/** Note under the card after Retry setup / Select Tally folder. Never reports success unless READY. */
export function setupResultNote(health) {
  const state = deriveTdlUiState(health);
  if (state === S.READY) {
    return {
      text: "Bill Outstanding setup completed successfully. The add-on is active in Tally.",
      tone: "success",
    };
  }
  const failedRestart = health?.activateResult && health.activateResult.status === false;
  if (failedRestart && health.activateResult.message) {
    return { text: health.activateResult.message, tone: "danger" };
  }
  if (state === S.OUTDATED) {
    return {
      text: "Setup finished but Tally is still running an older add-on. Close Tally fully, reopen it, then click Check now.",
      tone: "warn",
    };
  }
  if (state === S.NOT_ACTIVE || state === S.TALLY_UNREACHABLE) {
    return {
      text: "Bill Outstanding setup could not be verified. Tally has not confirmed the add-on. Keep Tally open and try Retry setup again.",
      tone: "danger",
    };
  }
  return {
    text: health?.applyResult?.hint || health?.applyResult?.message || VIEW[state].message || "Setup incomplete.",
    tone: "danger",
  };
}

/** Health stand-in when the IPC call itself failed. */
export function healthError(message) {
  return { uiError: message || VIEW[S.ERROR].message };
}
