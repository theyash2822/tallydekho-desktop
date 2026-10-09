// R1 / N3 + 13: launch intents are parsed explicitly, queued during startup instead of
// dropped, and a headless run exits with a code that says what happened.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseLaunchIntents, headlessExitCode, createLaunchDispatcher, EXIT } = require("../util/launchDispatcher");

const EXE = "C:\\Program Files\\TallyDekho\\TallyDekho.exe";

test("plain launch opens the window; Chromium switches and paths are not intents", () => {
  assert.deepEqual(parseLaunchIntents([EXE]), { intents: ["open_ui"], rejected: [] });
  assert.deepEqual(parseLaunchIntents([EXE, "--allow-file-access-from-files", "--original-process-start-time=1"]).intents, ["open_ui"]);
  assert.deepEqual(parseLaunchIntents(undefined).intents, ["open_ui"]);
  assert.deepEqual(parseLaunchIntents([EXE, 42, null]).intents, ["open_ui"]);
});

test("known flags become their intents (both kept, duplicates merged); unknown --run-* is rejected", () => {
  assert.deepEqual(parseLaunchIntents([EXE, "--run-sync"]).intents, ["scheduled_sync"]);
  assert.deepEqual(parseLaunchIntents([EXE, "--run-sync", "--run-backup", "--run-sync"]).intents, ["scheduled_sync", "scheduled_backup"]);
  assert.deepEqual(parseLaunchIntents([EXE, "--run-restore"]), { intents: [], rejected: ["--run-restore"] });
  assert.deepEqual(parseLaunchIntents([EXE, "--run-backup", "--run-wipe"]), { intents: ["scheduled_backup"], rejected: ["--run-wipe"] });
});

function harness({ ready = false } = {}) {
  const calls = [];
  let isReady = ready;
  let interactive = false;
  const d = createLaunchDispatcher({
    isReady: () => isReady,
    isInteractive: () => interactive,
    startInteractive: () => { interactive = true; calls.push("startInteractive"); },
    showWindow: () => calls.push("showWindow"),
    requestUi: () => calls.push("requestUi"),
    runSync: async () => calls.push("sync"),
    runBackup: async () => calls.push("backup"),
  });
  return { d, calls, setReady: () => { isReady = true; } };
}

test("triggers that arrive during startup are queued once each, then run after startup", async () => {
  const { d, calls, setReady } = harness();
  await d.onSecondInstance([EXE, "--run-sync"]);
  await d.onSecondInstance([EXE, "--run-sync"]);
  await d.onSecondInstance([EXE, "--run-backup"]);
  await d.onSecondInstance([EXE]);
  assert.deepEqual(calls, ["requestUi"], "nothing runs before startup finishes");
  assert.deepEqual(d.pendingIntents(), ["scheduled_sync", "scheduled_backup"]);
  setReady();
  assert.deepEqual(await d.drain(), ["scheduled_sync", "scheduled_backup"]);
  assert.deepEqual(calls, ["requestUi", "sync", "backup"]);
  assert.deepEqual(await d.drain(), [], "a drained trigger never runs twice");
});

test("after startup: UI open starts or focuses the window; an unknown flag does nothing", async () => {
  const { d, calls } = harness({ ready: true });
  await d.onSecondInstance([EXE]);
  await d.onSecondInstance([EXE]);
  await d.onSecondInstance([EXE, "--run-unknown"]);
  await d.onSecondInstance([EXE, "--run-sync"]);
  assert.deepEqual(calls, ["startInteractive", "showWindow", "sync"]);
});

test("headless exit codes are truthful", () => {
  assert.equal(headlessExitCode({ state: "succeeded" }), EXIT.ok);
  assert.equal(headlessExitCode({ state: "not_due" }), EXIT.ok);
  assert.equal(headlessExitCode({ state: "failed" }), EXIT.failed);
  assert.equal(headlessExitCode({ state: "partial" }), EXIT.failed);
  assert.equal(headlessExitCode({ state: "cancelled" }), EXIT.failed);
  assert.equal(headlessExitCode({ state: "rejected" }), EXIT.refused);
  assert.equal(headlessExitCode({ state: "deferred" }), EXIT.deferred);
});
