export const CODE_ERROR_MESSAGE = {
  no_company_selected: "Unable to sync because no company is selected.",
  internet_is_offline: "Unable to sync because the internet is not connected.",
  tally_is_not_connected: "Unable to sync because Tally is not connected.",
  tally_timeout:
    "Unable to sync because Tally did not respond in time (timeout).",
  DEVICE_CREDENTIAL_INVALID:
    "Device credential is invalid. Unpair and pair this Desktop again.",
  DEVICE_CREDENTIAL_REQUIRED:
    "Device credential is required. Unpair and pair this Desktop again.",
  DEVICE_NOT_PAIRED: "This Desktop is not paired to a workspace.",
  HARD_SYNC_APPROVAL_REQUIRED:
    "Waiting for Owner/Admin approval before Hard Sync can start.",
  HARD_SYNC_ALREADY_APPROVED:
    "Hard Sync was already approved. Starting if not already running.",
  HARD_SYNC_REJECTED: "Hard Sync was rejected by Owner/Admin.",
  HARD_SYNC_EXPIRED: "Hard Sync request expired. Request approval again.",
  HARD_SYNC_IN_FLIGHT: "A sync is already in progress on this Desktop.",
  TALLY_DATA_MISMATCH:
    "This Tally data does not match the workspace. Use Restore or Reset Workspace.",
  JOB_ALREADY_RUNNING: "A sync is already in progress on this Desktop.",
  JOB_CONFLICT:
    "Another operation (backup, restore or Tally restart) is running. Try again when it finishes.",
  version_blocked: "Sync is blocked until this Desktop app is updated.",
  partial_sync: "Some companies could not be uploaded. Synced companies are up to date; retry for the rest.",
};

/** Start/stop results that mean "not started" rather than "sync failed". */
export const isStartRejected = (result) => !!result?.rejected;

export const rejectionMessage = (result) =>
  result?.message || CODE_ERROR_MESSAGE[result?.code] || "Sync could not start right now.";
