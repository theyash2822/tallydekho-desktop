// R1 / N4 (V-002): opening the window during a headless job joins that job.
// Real main-process IPC handlers + real job coordinator + the real renderer App
// (bundled with esbuild, mounted in jsdom with its timers sped up).
//
// jsdom is not a desktop dependency; set TD_JSDOM_PATH or keep the web portal
// checkout beside this one (../td-web-portal/node_modules/jsdom).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const Module = require("node:module");

net.Socket.prototype.connect = function blocked() {
  throw Object.assign(new Error("outbound connections are blocked in this test"), { code: "NETWORK_GUARD" });
};

const ROOT = path.join(__dirname, "..");
const jsdomPath = process.env.TD_JSDOM_PATH
  || [path.join(ROOT, "../td-web-portal/node_modules/jsdom"), path.join(ROOT, "node_modules/jsdom")].find((p) => fs.existsSync(p));
if (!jsdomPath) throw new Error("jsdom not found: set TD_JSDOM_PATH");
const { JSDOM } = require(jsdomPath);
const esbuild = require(path.join(ROOT, "renderer/node_modules/esbuild"));

// ── main process with Electron, the store, helper and logger replaced ──────────
const handlers = new Map();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "td-n4-"));
const electronStub = {
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: (ch) => handlers.delete(ch) },
  app: { getPath: () => userData, getVersion: () => "0.0.0-test", isPackaged: false },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
};
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "electron") return electronStub;
  return realLoad.call(this, request, ...rest);
};

const mem = new Map();
const stub = (rel, exports) => {
  const file = require.resolve(path.join(ROOT, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stub("util/store", { get: (k) => mem.get(k), set: (k, v) => mem.set(k, v), delete: (k) => mem.delete(k), has: (k) => mem.has(k) });
let tallyProbes = 0;
stub("util/helper", {
  isTallyOpen: async () => { tallyProbes++; return false; },
  isOnlineHandler: async () => true,
  axiosInstance: { get: async () => ({ data: {} }), post: async () => ({ data: {} }) },
  pollJobStatus: async () => ({}),
});
stub("util/logger", { info: () => {}, error: () => {}, warn: () => {}, logPath: () => path.join(userData, "log.txt") });

require(path.join(ROOT, "util/ipcRegistry.js"));
const { coordinator } = require(path.join(ROOT, "util/jobCoordinator"));
const invoke = (ch, ...args) => handlers.get(ch)({ sender: {} }, ...args);

// ── renderer ───────────────────────────────────────────────────────────────────
function bundleApp() {
  const out = esbuild.buildSync({
    stdin: {
      contents: `import React from "react"; import { createRoot } from "react-dom/client"; import App from "./app/App";
        window.__mountApp = () => createRoot(document.getElementById("root")).render(React.createElement(App));`,
      resolveDir: path.join(ROOT, "renderer"),
      loader: "jsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".js": "jsx", ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl", ".gif": "dataurl", ".webp": "dataurl", ".ico": "dataurl", ".css": "empty" },
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env": '{"MODE":"test","DEV":false,"PROD":true}' },
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

function mountRenderer(bridgeCalls) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/" });
  const w = dom.window;
  const realError = w.console.error.bind(w.console);
  w.console.error = (...a) => {
    const text = a.map(String).join(" ");
    if (/The above error occurred|Uncaught|TypeError|ReferenceError/.test(text)) renderErrors.push(text.slice(0, 300));
    realError(...a);
  };
  w.addEventListener("error", (e) => renderErrors.push(String(e.error || e.message).slice(0, 300)));
  // 100x faster: a 5 s Tally poll fires every 50 ms, the 15 s backend check every 150 ms.
  for (const name of ["setInterval", "setTimeout"]) {
    const real = w[name].bind(w);
    w[name] = (fn, ms = 0, ...a) => real(fn, ms >= 1000 ? ms / 100 : ms, ...a);
  }
  const subscription = (name) => (cb) => {
    bridgeCalls.push(name);
    if (name === "onJobChanged") return coordinator.onChange((job, snapshot) => cb({ job, snapshot }));
    return () => {};
  };
  const bridge = (overrides) => new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== "string") return undefined;
      if (/^on[A-Z]|Progress$|^listener$/.test(prop)) return subscription(prop);
      return async () => { bridgeCalls.push(prop); return undefined; };
    },
  });
  w.tally = bridge({
    connected: () => { bridgeCalls.push("connected"); return invoke("tally:connected"); },
    currentJob: () => invoke("job:current"),
    stopSync: (code) => { bridgeCalls.push(`stopSync:${code}`); return invoke("tally:stop_sync", code); },
  });
  w.api = bridge({
    pingBackend: async () => true,
    getPref: async (k) => mem.get(k),
    setPref: async (k, v) => { mem.set(k, v); return true; },
  });
  w.eval(bundleApp());
  w.__mountApp();
  return dom;
}

const renderErrors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("window opened during a headless sync joins the job: no stop, no Tally probe, same job", async (t) => {
  const year = { finYear: "2025-2026", begin: "20250401", end: "20260331" };
  mem.set("selectedCompanies", [{ id: "g-1", guid: "g-1", name: "Co", path: "C:\\Tally\\1", years: [year], allYears: [year], isCurrentCompany: true }]);
  const admitted = coordinator.admit("sync", { trigger: "scheduled" });
  assert.notEqual(admitted?.accepted, false, "headless job admitted");
  const jobId = coordinator.activeJob("sync")?.id || coordinator.snapshot().active[0]?.id;
  assert.ok(jobId, "a headless job is active before the window opens");

  const calls = [];
  const dom = mountRenderer(calls);
  t.after(() => dom.window.close());
  await wait(1200); // ~24 Tally polls and ~8 backend checks at normal speed

  assert.deepEqual(renderErrors, [], "the renderer mounted without errors");
  assert.ok(calls.filter((c) => c === "connected").length >= 10, "the Tally status poll ran repeatedly");
  const active = coordinator.snapshot().active;
  assert.equal(active.length, 1);
  assert.equal(active[0].id, jobId, "the same job is still the active one");
  assert.ok(!active[0].cancelRequested, "no cancellation was requested");
  assert.deepEqual(calls.filter((c) => c.startsWith("stopSync")), [], "the renderer sent no stop");
  assert.ok(calls.includes("onJobChanged"), "the renderer subscribed to the running job");
  assert.equal(tallyProbes, 0, "status polls did not add requests to Tally during the job");
  assert.equal(await invoke("tally:connected"), null, "status during a job is 'not observed', not a cached false");

  coordinator.finish?.(jobId, { state: "succeeded" });
});
