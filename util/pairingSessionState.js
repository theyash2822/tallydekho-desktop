/**
 * In-memory pairing session — temporary for this process only.
 * pairingCode + sessionId + claimToken + expiresAt are never persisted to
 * electron-store/config.json (restart must create a fresh session).
 */
let session = {
  pairingCode: null,
  sessionId: null,
  claimToken: null,
  expiresAt: null, // ms epoch when known
};

function setPairingSession({ pairingCode, sessionId, claimToken, expiresAt } = {}) {
  if (pairingCode != null) session.pairingCode = String(pairingCode);
  if (sessionId) session.sessionId = String(sessionId);
  if (claimToken) session.claimToken = String(claimToken);
  if (expiresAt != null) {
    if (typeof expiresAt === "string" && expiresAt.includes("T")) {
      const ms = Date.parse(expiresAt);
      session.expiresAt = Number.isFinite(ms) ? ms : null;
    } else {
      const n = Number(expiresAt);
      session.expiresAt = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : null;
    }
  }
}

function getPairingSession() {
  return {
    pairingCode: session.pairingCode,
    sessionId: session.sessionId,
    claimToken: session.claimToken,
    expiresAt: session.expiresAt,
  };
}

function clearClaimToken() {
  session.claimToken = null;
}

function clearPairingSession() {
  session = {
    pairingCode: null,
    sessionId: null,
    claimToken: null,
    expiresAt: null,
  };
}

function hasValidPairingSession(now = Date.now()) {
  if (!session.sessionId || !session.claimToken) return false;
  if (session.expiresAt && now > session.expiresAt) return false;
  return true;
}

module.exports = {
  setPairingSession,
  getPairingSession,
  clearClaimToken,
  clearPairingSession,
  hasValidPairingSession,
};
