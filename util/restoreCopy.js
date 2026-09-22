/**
 * Safety-copy + overwrite + rollback for Tally destination restore.
 * Inject copy/exists/remove so the rollback contract is unit-testable.
 */
const RESTORE_ROLLBACK_FAILED = "RESTORE_ROLLBACK_FAILED";
const RESTORE_ROLLBACK_FAILED_MESSAGE =
  "CRITICAL: Restore failed and the previous Tally data could not be put back automatically. A recovery copy was kept.";

async function applyRestoreWithSafety({
  dest,
  incoming,
  copy,
  exists,
  remove,
}) {
  if (!dest) {
    return { status: false, code: "DEST_MISSING", message: "Tally destination is not set." };
  }
  if (!incoming) {
    return { status: false, code: "SOURCE_MISSING", message: "Restore source is missing." };
  }

  let safety = null;
  let destTouched = false;
  let keepSafety = false;

  try {
    if (await exists(dest)) {
      safety = `${dest}.td-safety`;
      await copy(dest, safety);
    }

    destTouched = true;
    await copy(incoming, dest);

    if (safety) await remove(safety);
    return { status: true, rolledBack: false, recoveryPreserved: false, safetyPath: null };
  } catch (err) {
    if (destTouched && safety && (await exists(safety))) {
      try {
        await copy(safety, dest);
        await remove(safety);
        return {
          status: false,
          code: "RESTORE_FAILED",
          message: err.message,
          rolledBack: true,
          recoveryPreserved: false,
          safetyPath: null,
        };
      } catch (rb) {
        keepSafety = true;
        return {
          status: false,
          code: RESTORE_ROLLBACK_FAILED,
          message: RESTORE_ROLLBACK_FAILED_MESSAGE,
          rolledBack: false,
          recoveryPreserved: true,
          safetyPath: safety,
          cause: rb.message,
        };
      }
    }
    return {
      status: false,
      code: "RESTORE_FAILED",
      message: err.message,
      rolledBack: false,
      recoveryPreserved: false,
      safetyPath: null,
    };
  } finally {
    if (safety && !keepSafety) {
      try {
        await remove(safety);
      } catch (_) {}
    }
  }
}

module.exports = {
  applyRestoreWithSafety,
  RESTORE_ROLLBACK_FAILED,
  RESTORE_ROLLBACK_FAILED_MESSAGE,
};
