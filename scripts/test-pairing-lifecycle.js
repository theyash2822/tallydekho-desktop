#!/usr/bin/env node
/**
 * Behavioral pairing lifecycle tests (no Electron).
 */
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  configure,
  start,
  stop,
  claimNow,
  revalidate,
  getStatus,
  isRunning,
  REFRESH_SKEW_MS,
  WORKSPACE_TAKEN,
  WORKSPACE_TAKEN_MESSAGE,
  __resetForTests,
} = require("../util/pairingLifecycle");
const {
  getPairingSession,
  setPairingSession,
  clearPairingSession,
} = require("../util/pairingSessionState");

function makeClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  const timers = [];
  let nextId = 1;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
      const due = timers.filter((t) => !t.cleared && t.fireAt <= now);
      for (const t of due) {
        t.cleared = true;
        t.fn();
      }
    },
    /** Move wall-clock without delivering timers — models a laptop sleep. */
    jump(ms) {
      now += ms;
    },
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.push({ id, fn, fireAt: now + ms, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const t = timers.find((x) => x.id === id);
      if (t) t.cleared = true;
    },
    pending() {
      return timers.filter((t) => !t.cleared).length;
    },
  };
}

function httpError(code, message = code, status = 409) {
  const err = new Error(message);
  err.code = code;
  err.response = { status, data: { code, message } };
  return err;
}

function harness({ getPairingCode, claim, getPairedDevice } = {}) {
  const clock = makeClock();
  const events = [];
  const calls = { pairing: 0, claim: 0, paired: 0 };
  const api = {
    async getPairingCode() {
      calls.pairing += 1;
      if (typeof getPairingCode === "function") return getPairingCode(calls.pairing);
      return {
        status: true,
        data: {
          code: `CODE${calls.pairing}`,
          pairingCode: `CODE${calls.pairing}`,
          sessionId: `sess-${calls.pairing}`,
          claimToken: `tok-${calls.pairing}`,
          expiresAt: new Date(clock.now() + 600_000).toISOString(),
        },
      };
    },
    async claim() {
      calls.claim += 1;
      if (typeof claim === "function") return claim(calls.claim);
      const err = new Error("Waiting");
      err.code = "PAIRING_SESSION_PENDING";
      err.response = { data: { code: "PAIRING_SESSION_PENDING" } };
      throw err;
    },
    async getPairedDevice() {
      calls.paired += 1;
      if (typeof getPairedDevice === "function") return getPairedDevice();
      return { name: "Owner", mobile: "9999999999" };
    },
  };
  configure({
    api,
    emit: (key, value) => events.push({ key, value, at: clock.now() }),
    log: () => {},
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, events, calls };
}

beforeEach(() => {
  __resetForTests();
  clearPairingSession();
});

afterEach(() => {
  __resetForTests();
  clearPairingSession();
});

test("mints a session and stores backend expiresAt", async () => {
  const { clock } = harness();
  await start("test");
  const session = getPairingSession();
  assert.equal(session.pairingCode, "CODE1");
  assert.equal(session.sessionId, "sess-1");
  assert.equal(session.claimToken, "tok-1");
  assert.equal(session.expiresAt, clock.now() + 600_000);
  assert.equal(getStatus().pairingCode, "CODE1");
});

test("schedules regeneration before expiresAt and replaces all four fields", async () => {
  const { clock, calls } = harness();
  await start("test");
  const firstExpiry = getPairingSession().expiresAt;
  clock.advance(firstExpiry - REFRESH_SKEW_MS - clock.now());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.pairing, 2);
  const session = getPairingSession();
  assert.equal(session.pairingCode, "CODE2");
  assert.equal(session.sessionId, "sess-2");
  assert.equal(session.claimToken, "tok-2");
});

test("a late generation-1 response cannot overwrite generation-2", async () => {
  let resolveFirst;
  const first = new Promise((r) => {
    resolveFirst = r;
  });
  const { clock } = harness({
    getPairingCode: (n) => {
      if (n === 1) {
        return first.then(() => ({
          status: true,
          data: {
            code: "OLD",
            pairingCode: "OLD",
            sessionId: "old-sess",
            claimToken: "old-tok",
            expiresAt: new Date(clock.now() + 600_000).toISOString(),
          },
        }));
      }
      return {
        status: true,
        data: {
          code: "NEW",
          pairingCode: "NEW",
          sessionId: "new-sess",
          claimToken: "new-tok",
          expiresAt: new Date(clock.now() + 600_000).toISOString(),
        },
      };
    },
  });
  const started = start("first");
  stop("supersede");
  await start("second");
  resolveFirst();
  await started.catch(() => {});
  assert.equal(getPairingSession().pairingCode, "NEW");
  assert.equal(getPairingSession().sessionId, "new-sess");
  assert.equal(getPairingSession().claimToken, "new-tok");
});

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

test("claim poll continues until expiresAt, not an attempt cap", async () => {
  const { calls } = harness();
  await start("test");
  for (let i = 0; i < 50; i++) {
    await claimNow("poll");
  }
  assert.ok(calls.claim >= 40);
  assert.equal(isRunning(), true);
  assert.equal(getPairingSession().pairingCode, "CODE1");
});

test("expired session during poll remints instead of asking to refresh", async () => {
  const { clock, events, calls } = harness();
  await start("test");
  setPairingSession({ expiresAt: new Date(clock.now() - 1).toISOString() });
  clock.advance(3_000);
  await flush();
  assert.ok(calls.pairing >= 2);
  assert.equal(
    events.some((e) => String(e.value || "").includes("Refresh")),
    false
  );
});

test("socket and poll share a claim single-flight", async () => {
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  const { clock, calls } = harness({
    claim: async (n) => {
      if (n === 1) {
        await held;
        return { connectionStatus: "RECONNECTING", workspace: { id: "w1" } };
      }
      return { connectionStatus: "RECONNECTING" };
    },
  });
  await start("test");
  const first = claimNow("poll");
  await flush();
  const socket = claimNow("socket");
  await flush();
  release();
  await first;
  await socket;
  await flush();
  assert.equal(calls.claim, 1);
});

test("sleep/wake remints once when the clock jumps past expiry", async () => {
  const { clock, calls } = harness();
  await start("test");
  clock.jump(700_000);
  await revalidate("power-resume");
  assert.equal(calls.pairing, 2);
  await revalidate("power-resume");
  assert.equal(calls.pairing, 2);
});

test("network recovery remints an expired session", async () => {
  const { clock, calls } = harness();
  await start("test");
  clock.jump(700_000);
  await revalidate("socket-reconnect");
  assert.equal(calls.pairing, 2);
  assert.ok(getPairingSession().pairingCode);
});

test("WORKSPACE_ALREADY_HAS_DESKTOP stops polling with a mapped message", async () => {
  const { events, calls } = harness({
    getPairingCode: () => {
      throw httpError(WORKSPACE_TAKEN, '{"raw":true}');
    },
  });
  await start("test");
  assert.equal(isRunning(), false);
  assert.equal(calls.pairing, 1);
  const err = events.find((e) => e.key === "pairingBackendError");
  assert.equal(err.value, WORKSPACE_TAKEN_MESSAGE);
  assert.equal(String(err.value).includes("{"), false);
});

test("claim 409 WORKSPACE_ALREADY_HAS_DESKTOP terminates the session", async () => {
  const { clock, events } = harness({
    claim: () => {
      throw httpError(WORKSPACE_TAKEN, "already taken");
    },
  });
  await start("test");
  await claimNow("poll");
  assert.equal(isRunning(), false);
  const errors = events.filter((e) => e.key === "pairingBackendError").map((e) => e.value);
  assert.ok(errors.includes(WORKSPACE_TAKEN_MESSAGE));
});
