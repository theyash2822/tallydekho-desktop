/**
 * Restore token + completion acknowledgement. The token stays in the main
 * process; the acknowledgement is persisted before it is sent so a lost
 * response can be retried after the files are already in place.
 */

const ACK_RETRY_MAX_AGE_MS = 23 * 60 * 60 * 1000;

function restoreHeaders(store) {
  const token = store.get("restoreToken");
  return token ? { "x-restore-token": token } : {};
}

function rememberRestoreRequest(store, data) {
  if (data?.restoreToken) store.set("restoreToken", data.restoreToken);
  if (!data || typeof data !== "object") return data;
  const { restoreToken: _omit, ...rest } = data;
  return rest;
}

async function sendRestoreAck({ store, post, ack, applySecret, nowMs = Date.now() }) {
  const pending = { ...ack, token: ack.token || store.get("restoreToken"), at: ack.at || nowMs };
  if (!pending.token) return { status: false, code: "RESTORE_TOKEN_REQUIRED" };
  store.set("pendingRestoreAck", pending);
  let res;
  try {
    res = await post(
      "/desktop/restore/complete",
      { ok: true, restoredFolders: pending.restoredFolders || [], lineageGuids: pending.lineageGuids || [] },
      { headers: { "x-restore-token": pending.token } }
    );
  } catch (err) {
    const code = err?.response?.data?.code;
    if (code && code !== "RESTORE_SESSION_EXPIRED") {
      store.delete("pendingRestoreAck");
      store.delete("restoreToken");
      return { status: false, code, message: err?.response?.data?.message || err.message };
    }
    return { status: false, code: code || "RESTORE_ACK_PENDING", message: "Restore finished locally; confirmation will be retried", retry: true };
  }
  const data = res?.data?.data;
  if (!res?.data?.status || !data?.activated) {
    return { status: false, code: res?.data?.code || "RESTORE_ACK_PENDING", retry: true };
  }
  if (data.deviceSecret) await applySecret(data.deviceSecret);
  store.delete("pendingRestoreAck");
  store.delete("restoreToken");
  return { status: true, data };
}

async function retryPendingRestoreAck({ store, post, applySecret, nowMs = Date.now() }) {
  const pending = store.get("pendingRestoreAck");
  if (!pending?.token) return { status: false, code: "NONE" };
  if (nowMs - Number(pending.at || 0) > ACK_RETRY_MAX_AGE_MS) {
    store.delete("pendingRestoreAck");
    return { status: false, code: "RESTORE_ACK_EXPIRED" };
  }
  return sendRestoreAck({ store, post, ack: pending, applySecret, nowMs });
}

module.exports = {
  restoreHeaders,
  rememberRestoreRequest,
  sendRestoreAck,
  retryPendingRestoreAck,
  ACK_RETRY_MAX_AGE_MS,
};
