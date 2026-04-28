import { createContext } from "react";

/**
 * Sync state machine (as per CTO spec).
 * Derived from raw state — single source of truth for current phase.
 *
 * States:
 *   NOT_CONNECTED       - Tally offline or internet offline
 *   READY_TO_PAIR       - Tally + internet online, not paired
 *   PAIRING_PENDING     - Pairing code generated, waiting for mobile
 *   PAIRED_NOT_SYNCED   - Paired but no sync done yet
 *   SYNCING             - Sync in progress
 *   SYNCED              - Last sync completed successfully
 *   SYNC_FAILED         - Last sync failed
 *   UNPAIRED            - Was paired, now unpaired
 */
export function deriveSyncState(state) {
  const { isTallyOnline, isOnline, pairedDevice, isSyncing, lastSync,
          pairingState, selectedCompanies } = state;

  if (!isTallyOnline || !isOnline) return "NOT_CONNECTED";
  if (!pairedDevice) {
    if (pairingState === "generating" || pairingState === "revealed") return "PAIRING_PENDING";
    return "READY_TO_PAIR";
  }
  if (isSyncing) return "SYNCING";
  if (!lastSync) return "PAIRED_NOT_SYNCED";
  return "SYNCED";
}

export const TallyContext = createContext({
  state: {},
  updateState: function () {},
  updateTallyStatus: function () {},
  fetchCompanies: function () {},
  updatePort: function () {},
  syncState: "NOT_CONNECTED",
});
