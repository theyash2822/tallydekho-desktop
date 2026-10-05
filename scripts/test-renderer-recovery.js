const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { RETRY_DELAYS_MS, createRendererRecovery, statusPageHtml, statusPageUrl } = require("../util/rendererRecovery");

function harness() {
  const calls = { load: 0, status: [], timers: [], cancelled: [] };
  const recovery = createRendererRecovery({
    load: () => calls.load++,
    showStatus: (s) => calls.status.push(s),
    schedule: (fn, ms) => {
      const t = { fn, ms };
      calls.timers.push(t);
      return t;
    },
    cancel: (t) => calls.cancelled.push(t),
  });
  const fire = () => calls.timers.at(-1).fn();
  return { recovery, calls, fire };
}

const APP = "file:///C:/TallyDekho/resources/app/renderer/dist/index.html";
const fail = (over = {}) => ({ code: -331, desc: "ERR_NETWORK_IO_SUSPENDED", url: APP, isMainFrame: true, ...over });

test("main-frame failure retries with backoff, then shows the failed page", () => {
  const { recovery, calls, fire } = harness();
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    assert.equal(recovery.onFailLoad(fail()), "retry");
    assert.equal(calls.timers[i].ms, RETRY_DELAYS_MS[i]);
    assert.equal(calls.status.at(-1).state, "retrying");
    assert.equal(calls.status.at(-1).attempt, i + 1);
    fire();
    assert.equal(calls.load, i + 1);
  }
  assert.equal(recovery.onFailLoad(fail()), "failed");
  assert.equal(calls.status.at(-1).state, "failed");
  assert.equal(calls.timers.length, RETRY_DELAYS_MS.length, "never retries forever");
});

test("aborted loads, sub-frames and the status page itself are ignored", () => {
  const { recovery, calls } = harness();
  assert.equal(recovery.onFailLoad(fail({ code: -3, desc: "ERR_ABORTED" })), "ignored");
  assert.equal(recovery.onFailLoad(fail({ isMainFrame: false })), "ignored");
  assert.equal(recovery.onFailLoad(fail({ url: "data:text/html;charset=utf-8,x" })), "ignored");
  assert.equal(calls.timers.length + calls.status.length + calls.load, 0);
  assert.equal(recovery.isBroken(), false);
});

test("Chromium's error-page finish after a failure is not a recovery (no endless retries)", () => {
  const { recovery, calls, fire } = harness();
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    recovery.onFailLoad(fail());
    recovery.onLoaded(APP);
    assert.equal(recovery.isBroken(), true);
    fire();
  }
  assert.equal(recovery.onFailLoad(fail()), "failed");
  recovery.retryNow("button");
  recovery.onLoaded(APP);
  assert.equal(recovery.isBroken(), false, "a real load after a retry recovers");
  assert.ok(calls.load > 0);
});

test("a second failure while a retry is pending does not stack timers", () => {
  const { recovery, calls } = harness();
  recovery.onFailLoad(fail());
  assert.equal(recovery.onFailLoad(fail()), "pending");
  assert.equal(calls.timers.length, 1);
});

test("successful load resets attempts; status-page loads do not count as recovery", () => {
  const { recovery, calls, fire } = harness();
  recovery.onFailLoad(fail());
  recovery.onLoaded("data:text/html;charset=utf-8,x");
  assert.equal(recovery.isBroken(), true);
  fire();
  recovery.onLoaded(APP);
  assert.equal(recovery.isBroken(), false);
  recovery.onFailLoad(fail());
  assert.equal(calls.timers.at(-1).ms, RETRY_DELAYS_MS[0], "backoff starts over");
});

test("wake / unlock / Reload retries immediately only when broken", () => {
  const { recovery, calls } = harness();
  assert.equal(recovery.retryNow("power-resume"), false);
  assert.equal(calls.load, 0);
  recovery.onFailLoad(fail());
  assert.equal(recovery.retryNow("power-resume"), true);
  assert.equal(calls.load, 1);
  assert.deepEqual(calls.cancelled, [calls.timers[0]]);
  // After exhausting retries, Reload still works and gives a fresh set of retries.
  const h = harness();
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    h.recovery.onFailLoad(fail());
    if (i < RETRY_DELAYS_MS.length) h.fire();
  }
  assert.equal(h.calls.status.at(-1).state, "failed");
  assert.equal(h.recovery.retryNow("button"), true);
  assert.equal(h.recovery.onFailLoad(fail()), "retry");
});

test("status page escapes text and wires Reload / Quit through the preload API", () => {
  const html = statusPageHtml({ state: "failed", code: -331, desc: "<script>x</script>" });
  assert.match(html, /couldn&#39;t open its screen/);
  assert.doesNotMatch(html, /<script>x/);
  assert.match(html, /recoverRenderer\('reload'\)/);
  assert.match(html, /recoverRenderer\('quit'\)/);
  assert.match(html, /-webkit-app-region:drag/, "frameless window stays movable");
  assert.match(statusPageHtml({ state: "retrying", attempt: 2, total: 3, code: -331, desc: "" }), /2 of 3/);
  assert.ok(statusPageUrl({ state: "failed" }).startsWith("data:text/html;charset=utf-8,"));
});

test("main.js and preload.js are wired to the recovery module", () => {
  const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "../preload.js"), "utf8");
  assert.doesNotMatch(main, /Failed to load renderer/);
  assert.match(main, /rendererRecovery\?\.onFailLoad\(\{ code, desc, url, isMainFrame \}\)/);
  assert.match(main, /"did-finish-load"[\s\S]{0,120}rendererRecovery\?\.onLoaded/);
  assert.match(main, /powerMonitor\.on\("resume"[\s\S]{0,120}rendererRecovery\?\.retryNow\("power-resume"\)/);
  assert.match(main, /powerMonitor\.on\("unlock-screen"/);
  assert.match(main, /ipcMain\.handle\("renderer:recover"[\s\S]{0,120}event\.sender !== mainWindow\.webContents/);
  assert.match(main, /store\.get\("isSyncing"\)[\s\S]{0,300}showMessageBox/);
  assert.match(preload, /recoverRenderer: \(action\) => ipcRenderer\.invoke\("renderer:recover", action\)/);
});
