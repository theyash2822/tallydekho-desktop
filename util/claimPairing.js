/**
 * HTTP credential claim after Owner/Admin approves pairing session.
 * WebSocket pairing_approved is wake-up only — this is the correctness path.
 */
const { info, error } = require("./logger");
const { saveDeviceSecret, getDeviceSecret } = require("./deviceCredential");
const {
  getPairingSession,
  clearClaimToken,
  clearPairingSession,
  hasValidPairingSession,
} = require("./pairingSessionState");

const MISSING_SESSION = "PAIRING_SESSION_NOT_READY";

function claimErrorCode(e) {
  return e?.response?.data?.code || e?.code || "";
}

async function claimAndAck(axiosInstance, { sessionId, claimToken } = {}) {
  const mem = getPairingSession();
  const sid = sessionId || mem.sessionId;
  const token = claimToken || mem.claimToken;
  if (!sid || !token) {
    const err = new Error("Pairing session not ready — refresh pairing code");
    err.code = MISSING_SESSION;
    throw err;
  }

  const claimRes = await axiosInstance.post(`/desktop/pairing-sessions/${sid}/claim`, {
    claimToken: token,
  });
  const data = claimRes.data?.data || claimRes.data;
  const secret = data?.deviceSecret;
  if (!secret) {
    throw new Error(claimRes.data?.message || "No device secret in claim response");
  }

  saveDeviceSecret(secret);

  const getDeviceProfile = require("./deviceProfile");
  const deviceId = getDeviceProfile()?.deviceId || null;

  await axiosInstance
    .post(
      `/desktop/pairing-sessions/${sid}/ack`,
      { deviceId, deviceSecret: secret },
      { headers: deviceId ? { "device-id": deviceId } : {} }
    )
    .catch((e) => {
      error(e?.message, "pairing_ack");
    });

  // Session consumed — clear all temporary pairing material
  clearPairingSession();

  // Log session id only — never claimToken / device_secret
  info(`[pairing] claimed credential for session ${sid}`);
  return data;
}

/** Poll claim until approved or timeout (socket miss recovery). */
async function pollClaimUntilReady(axiosInstance, { attempts = 30, intervalMs = 2000 } = {}) {
  if (!hasValidPairingSession()) {
    const err = new Error("Pairing session not ready — refresh pairing code");
    err.code = MISSING_SESSION;
    throw err;
  }
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await claimAndAck(axiosInstance);
    } catch (e) {
      lastErr = e;
      if (e?.code === MISSING_SESSION) throw e;
      const msg = String(e?.response?.data?.message || e?.message || "");
      const code = claimErrorCode(e);
      // Pending / not approved yet — keep waiting
      if (
        code === "PAIRING_SESSION_PENDING" ||
        code === "PAIRING_NOT_APPROVED" ||
        /not approved/i.test(msg) ||
        (e?.response?.status === 409 && code !== "PAIRING_SESSION_ALREADY_APPROVED")
      ) {
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }
      // Expired / missing / invalid — regenerate session (do not keep polling)
      if (
        code === "PAIRING_SESSION_EXPIRED" ||
        code === "PAIRING_SESSION_NOT_FOUND" ||
        code === "PAIRING_CODE_INVALID"
      ) {
        clearPairingSession();
        throw e;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw lastErr || new Error("Timed out waiting to claim pairing credential");
}

module.exports = { claimAndAck, pollClaimUntilReady, getDeviceSecret, MISSING_SESSION };
