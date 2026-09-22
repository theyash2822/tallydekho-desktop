/**
 * Pairing session lifecycle — the main process is the single authority.
 *
 * Owns: code, sessionId, claimToken, expiresAt, generation, refresh timer,
 * claim polling and the claim single-flight guard. The renderer receives
 * display-safe state only and never sees claimToken.
 *
 * Backend `expiresAt` is authoritative for session lifetime. Regeneration is
 * scheduled at `expiresAt - REFRESH_SKEW_MS`; a suspended timer (laptop sleep)
 * is caught by the resume/network hooks comparing wall-clock time to expiresAt.
 *
 * Every async step captures the generation it started in. A response from a
 * superseded generation is dropped, so a late reply can never overwrite a
 * newer session.
 *
 * All I/O and timers are injected through `configure()` so the lifecycle is
 * unit-testable without Electron.
 */
const {
  setPairingSession,
  getPairingSession,
  clearPairingSession,
  hasValidPairingSession,
} = require("./pairingSessionState");

const REFRESH_SKEW_MS = 30_000;
const CLAIM_POLL_INTERVAL_MS = 3_000;
const MIN_TIMER_DELAY_MS = 250;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
/** Only used when the backend omits expiresAt — never as an override. */
const FALLBACK_SESSION_TTL_MS = 10 * 60 * 1000;

const WORKSPACE_TAKEN = "WORKSPACE_ALREADY_HAS_DESKTOP";
const DEVICE_ALREADY_PAIRED = "DEVICE_ALREADY_PAIRED";

/** Session is gone — mint a replacement rather than showing an error. */
const DEAD_SESSION_CODES = new Set([
  "PAIRING_SESSION_EXPIRED",
  "PAIRING_SESSION_NOT_FOUND",
  "PAIRING_CODE_INVALID",
]);

/** Approval has not happened yet — keep waiting quietly. */
const PENDING_CLAIM_CODES = new Set([
  "PAIRING_SESSION_PENDING",
  "PAIRING_SESSION_NOT_READY",
  "PAIRING_NOT_APPROVED",
]);

const WORKSPACE_TAKEN_MESSAGE =
  "This workspace is already connected to another Desktop. Unpair that Desktop, or use Restore Existing Workspace to replace it.";
const OFFLINE_MESSAGE =
  "Backend unavailable — retrying automatically. The pairing code will appear once the connection is back.";

const noop = () => {};

const defaults = {
  api: null,
  emit: noop,
  log: noop,
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

let deps = { ...defaults };

let generation = 0;
let running = false;
let refreshTimer = null;
let claimTimer = null;
let claimInFlight = false;
let mintInFlight = false;
let backoffMs = BACKOFF_MIN_MS;
/** Set when the failure is not retryable (e.g. workspace already has a Desktop). */
let terminalCode = null;

function configure(overrides = {}) {
  deps = { ...defaults, ...overrides };
}

function errorCode(err) {
  return err?.response?.data?.code || err?.code || "";
}

function errorMessage(err) {
  return err?.response?.data?.message || err?.message || "";
}

function isOfflineError(err) {
  if (err?.response) return false;
  const text = String(err?.code || err?.message || "");
  return /ECONNABORTED|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ENETUNREACH|EAI_AGAIN|Network/i.test(
    text
  );
}

function clearRefreshTimer() {
  if (refreshTimer !== null) {
    deps.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function clearClaimTimer() {
  if (claimTimer !== null) {
    deps.clearTimeout(claimTimer);
    claimTimer = null;
  }
}

function clearTimers() {
  clearRefreshTimer();
  clearClaimTimer();
}

function emitCode(code) {
  deps.emit("pairingCode", code);
}

function emitError(message) {
  deps.emit("pairingBackendError", message || "");
}

/** Invalidate every in-flight generation and drop all timers. */
function invalidate() {
  generation += 1;
  clearTimers();
  claimInFlight = false;
  mintInFlight = false;
}

function stop(reason = "stop") {
  if (running || refreshTimer !== null || claimTimer !== null) {
    deps.log(`[pairing] lifecycle stop (${reason})`);
  }
  running = false;
  terminalCode = null;
  backoffMs = BACKOFF_MIN_MS;
  invalidate();
}

function enterTerminal(code, message) {
  terminalCode = code;
  running = false;
  invalidate();
  clearPairingSession();
  emitCode(null);
  emitError(message);
  deps.log(`[pairing] lifecycle halted: ${code}`);
}

function scheduleRefresh(expiresAt) {
  clearRefreshTimer();
  const gen = generation;
  const delay = Math.max(
    MIN_TIMER_DELAY_MS,
    expiresAt - REFRESH_SKEW_MS - deps.now()
  );
  refreshTimer = deps.setTimeout(() => {
    refreshTimer = null;
    if (gen !== generation || !running) return;
    mint("pre-expiry");
  }, delay);
}

function scheduleClaimPoll(delay = CLAIM_POLL_INTERVAL_MS) {
  clearClaimTimer();
  const gen = generation;
  claimTimer = deps.setTimeout(() => {
    claimTimer = null;
    if (gen !== generation || !running) return;
    claimTick(gen);
  }, delay);
}

function scheduleRetry() {
  clearRefreshTimer();
  const gen = generation;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  refreshTimer = deps.setTimeout(() => {
    refreshTimer = null;
    if (gen !== generation || !running) return;
    mint("retry");
  }, delay);
}

/**
 * Acquire a fresh pairing session. Each successful GET cancels the previous
 * PENDING session server-side, so the four fields are replaced atomically here.
 */
async function mint(reason) {
  if (!running || terminalCode || mintInFlight) return false;
  mintInFlight = true;
  const gen = generation;
  try {
    const response = await deps.api.getPairingCode();
    if (gen !== generation || !running) return false;

    const payload = response?.data || {};
    const code = payload.code || payload.pairingCode;

    if (response?.status === false || !code || !payload.sessionId) {
      const failureCode = response?.code || "PAIRING_SESSION_INCOMPLETE";
      if (failureCode === DEVICE_ALREADY_PAIRED) {
        await adoptPairedDevice("already-paired");
        return false;
      }
      if (failureCode === WORKSPACE_TAKEN) {
        enterTerminal(WORKSPACE_TAKEN, WORKSPACE_TAKEN_MESSAGE);
        return false;
      }
      emitError(response?.message || OFFLINE_MESSAGE);
      scheduleRetry();
      return false;
    }

    clearPairingSession();
    setPairingSession({
      pairingCode: code,
      sessionId: payload.sessionId,
      claimToken: payload.claimToken,
      expiresAt: payload.expiresAt,
    });

    const stored = getPairingSession();
    const expiresAt = stored.expiresAt || deps.now() + FALLBACK_SESSION_TTL_MS;

    backoffMs = BACKOFF_MIN_MS;
    emitError("");
    emitCode(code);
    deps.log(
      `[pairing] session ready (${reason}) sessionId=${payload.sessionId} expiresAt=${
        payload.expiresAt || "n/a"
      }`
    );

    scheduleRefresh(expiresAt);
    scheduleClaimPoll();
    return true;
  } catch (err) {
    if (gen !== generation || !running) return false;
    const code = errorCode(err);
    if (code === DEVICE_ALREADY_PAIRED) {
      await adoptPairedDevice("already-paired");
      return false;
    }
    if (code === WORKSPACE_TAKEN) {
      enterTerminal(WORKSPACE_TAKEN, WORKSPACE_TAKEN_MESSAGE);
      return false;
    }
    emitError(isOfflineError(err) ? OFFLINE_MESSAGE : errorMessage(err) || OFFLINE_MESSAGE);
    scheduleRetry();
    return false;
  } finally {
    if (gen === generation) mintInFlight = false;
  }
}

/** Single-flight claim shared by the poll and the socket approval wake-up. */
async function attemptClaim(gen, reason) {
  if (gen !== generation || !running || terminalCode) return false;
  if (claimInFlight) return false;
  if (!hasValidPairingSession(deps.now())) return false;

  claimInFlight = true;
  try {
    const data = await deps.api.claim();
    if (gen !== generation) return false;
    await onClaimed(data, reason);
    return true;
  } catch (err) {
    if (gen !== generation) return false;
    const code = errorCode(err);

    if (code === WORKSPACE_TAKEN) {
      enterTerminal(WORKSPACE_TAKEN, WORKSPACE_TAKEN_MESSAGE);
      return false;
    }
    if (code === DEVICE_ALREADY_PAIRED) {
      await adoptPairedDevice("already-paired");
      return false;
    }
    if (DEAD_SESSION_CODES.has(code)) {
      clearPairingSession();
      await mint("claim-session-dead");
      return false;
    }
    if (!PENDING_CLAIM_CODES.has(code)) {
      deps.log(`[pairing] claim failed (${reason}): ${code || errorMessage(err)}`);
    }
    return false;
  } finally {
    if (gen === generation) claimInFlight = false;
  }
}

async function onClaimed(data, reason) {
  deps.log(`[pairing] credential claimed (${reason})`);
  stop("claimed");
  emitCode(null);
  emitError("");
  if (data?.workspace) deps.emit("workspace", data.workspace);
  await publishPairedDevice();
  deps.emit("pairingClaimed", {
    connectionStatus: data?.connectionStatus || "RECONNECTING",
    at: deps.now(),
  });
}

async function publishPairedDevice() {
  try {
    const device = await deps.api.getPairedDevice();
    if (device) deps.emit("pairedDevice", device);
  } catch (err) {
    deps.log(`[pairing] paired-device lookup failed: ${errorMessage(err)}`);
  }
}

/** Backend says this Desktop is already paired — leave pairing mode cleanly. */
async function adoptPairedDevice(reason) {
  stop(reason);
  clearPairingSession();
  emitCode(null);
  emitError("");
  await publishPairedDevice();
}

async function claimTick(gen) {
  if (gen !== generation || !running) return;

  const session = getPairingSession();
  if (!session.sessionId) {
    await mint("poll-no-session");
    return;
  }

  // Wall-clock check: a timer suspended by sleep may not have fired on time.
  if (session.expiresAt && deps.now() >= session.expiresAt) {
    clearPairingSession();
    await mint("expired-during-poll");
    return;
  }

  await attemptClaim(gen, "poll");
  if (gen === generation && running) scheduleClaimPoll();
}

/** Recreate any timer that went missing without ever duplicating one. */
function ensureTimers() {
  const session = getPairingSession();
  if (!session.sessionId) return;
  const expiresAt = session.expiresAt || deps.now() + FALLBACK_SESSION_TTL_MS;
  if (refreshTimer === null && !mintInFlight) scheduleRefresh(expiresAt);
  if (claimTimer === null && !claimInFlight) scheduleClaimPoll();
}

/**
 * Re-evaluate the session against wall-clock time. Used by powerMonitor
 * resume, window focus and network-online transitions — a suspended timer
 * cannot be trusted to have fired.
 */
function revalidate(reason) {
  if (!running || terminalCode) return Promise.resolve(false);
  const session = getPairingSession();
  const expiresAt = session.expiresAt;
  const expiringSoon =
    !session.sessionId ||
    !expiresAt ||
    deps.now() >= expiresAt - REFRESH_SKEW_MS;

  if (expiringSoon) {
    clearTimers();
    backoffMs = BACKOFF_MIN_MS;
    return mint(reason);
  }
  ensureTimers();
  return Promise.resolve(false);
}

/**
 * Enter pairing mode. Safe to call repeatedly — an already-running lifecycle
 * revalidates instead of minting a duplicate session.
 */
function start(reason = "start") {
  if (running) return revalidate(reason);
  stop("restart");
  running = true;
  backoffMs = BACKOFF_MIN_MS;
  deps.log(`[pairing] lifecycle start (${reason})`);
  return mint(reason);
}

/** Socket `pairing_approved` wake-up — shares the claim single-flight guard. */
function claimNow(reason = "socket") {
  if (!running) return Promise.resolve(false);
  return attemptClaim(generation, reason);
}

function getStatus() {
  const session = getPairingSession();
  return {
    running,
    pairingCode: session.pairingCode || null,
    expiresAt: session.expiresAt || null,
    hasSession: !!session.sessionId,
    terminalCode,
  };
}

function __resetForTests() {
  stop("test-reset");
  clearPairingSession();
  deps = { ...defaults };
  generation = 0;
}

module.exports = {
  configure,
  start,
  stop,
  claimNow,
  revalidate,
  getStatus,
  isRunning: () => running,
  REFRESH_SKEW_MS,
  CLAIM_POLL_INTERVAL_MS,
  BACKOFF_MIN_MS,
  BACKOFF_MAX_MS,
  WORKSPACE_TAKEN,
  WORKSPACE_TAKEN_MESSAGE,
  __resetForTests,
};
