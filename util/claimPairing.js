/**
 * HTTP credential claim after Owner/Admin approves pairing session.
 * WebSocket pairing_approved is wake-up only — this is the correctness path.
 */
const store = require("./store");
const { info, error } = require("./logger");
const { saveDeviceSecret, getDeviceSecret } = require("./deviceCredential");

async function claimAndAck(axiosInstance, { sessionId, claimToken } = {}) {
  const sid = sessionId || store.get("pairingSessionId");
  const token = claimToken || store.get("pairingClaimToken");
  if (!sid || !token) {
    throw new Error("Missing pairing sessionId/claimToken — refresh pairing code on Desktop");
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
  const deviceId = getDeviceProfile()?.deviceId || store.get("deviceId") || null;

  await axiosInstance
    .post(
      `/desktop/pairing-sessions/${sid}/ack`,
      { deviceId, deviceSecret: secret },
      { headers: deviceId ? { "device-id": deviceId } : {} }
    )
    .catch((e) => {
      // Secret is stored; ACK retry is safe via re-claim while CLAIM_PENDING_ACK
      error(e?.message, "pairing_ack");
    });

  if (data?.workspace) {
    store.set("workspace", data.workspace);
  }

  // Session consumed — clear claim material (do not clear pairingCode UI until unpaired)
  store.delete("pairingClaimToken");

  info(`[pairing] claimed credential for session ${sid}`);
  return data;
}

/** Poll claim until approved or timeout (socket miss recovery). */
async function pollClaimUntilReady(axiosInstance, { attempts = 30, intervalMs = 2000 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await claimAndAck(axiosInstance);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.response?.data?.message || e?.message || "");
      const code = e?.response?.data?.code || "";
      // Not approved yet — keep polling
      if (
        code === "PAIRING_SESSION_NOT_FOUND" ||
        /not approved/i.test(msg) ||
        e?.response?.status === 409
      ) {
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }
      // Expired / invalid — stop
      if (code === "PAIRING_SESSION_EXPIRED" || code === "PAIRING_CODE_INVALID") {
        throw e;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw lastErr || new Error("Timed out waiting to claim pairing credential");
}

module.exports = { claimAndAck, pollClaimUntilReady, getDeviceSecret };
