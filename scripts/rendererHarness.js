// Mounts the real renderer App (bundled with esbuild) in jsdom with fake preload bridges.
// jsdom is not a desktop dependency: set TD_JSDOM_PATH or keep the web portal checkout
// beside this one (../td-web-portal/node_modules/jsdom).
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const jsdomPath = process.env.TD_JSDOM_PATH
  || [path.join(ROOT, "../td-web-portal/node_modules/jsdom"), path.join(ROOT, "node_modules/jsdom")].find((p) => fs.existsSync(p));
if (!jsdomPath) throw new Error("jsdom not found: set TD_JSDOM_PATH");
const { JSDOM } = require(jsdomPath);
const esbuild = require(path.join(ROOT, "renderer/node_modules/esbuild"));

let bundle = null;
function bundleApp() {
  if (bundle) return bundle;
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
  bundle = out.outputFiles[0].text;
  return bundle;
}

/**
 * @param {object} opts
 * @param {object} opts.tally  overrides for window.tally
 * @param {object} opts.api    overrides for window.api
 * @param {Array}  opts.calls  every bridge call name is pushed here
 * @param {(cb) => () => void} [opts.onJobChanged]
 * @param {number} [opts.speed] timers ≥1 s run this many times faster
 */
function mountApp({ tally = {}, api = {}, calls = [], onJobChanged = null, speed = 100 }) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/" });
  const w = dom.window;
  const errors = [];
  const realError = w.console.error.bind(w.console);
  w.console.error = (...a) => {
    const text = a.map(String).join(" ");
    if (/The above error occurred|Uncaught|TypeError|ReferenceError/.test(text)) errors.push(text.slice(0, 300));
    if (process.env.TD_RENDERER_DEBUG) realError(...a);
  };
  w.addEventListener("error", (e) => errors.push(String(e.error || e.message).slice(0, 300)));
  for (const name of ["setInterval", "setTimeout"]) {
    const real = w[name].bind(w);
    w[name] = (fn, ms = 0, ...a) => real(fn, ms >= 1000 ? ms / speed : ms, ...a);
  }
  const subscription = (name) => (cb) => {
    calls.push(name);
    if (name === "onJobChanged" && onJobChanged) return onJobChanged(cb);
    return () => {};
  };
  const bridge = (overrides) => new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== "string") return undefined;
      if (/^on[A-Z]|Progress$|^listener$/.test(prop)) return subscription(prop);
      return async () => { calls.push(prop); return undefined; };
    },
  });
  w.tally = bridge(tally);
  w.api = bridge(api);
  w.backup = bridge({});
  w.updater = bridge({});
  w.eval(bundleApp());
  w.__mountApp();
  return { dom, w, errors };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Click the first element whose text matches. */
function clickText(w, re) {
  const el = [...w.document.querySelectorAll("button, a, [role=button], div, span")].find((n) => re.test(n.textContent || "") && n.children.length === 0)
    || [...w.document.querySelectorAll("button")].find((n) => re.test(n.textContent || ""));
  if (!el) throw new Error(`no element with text ${re}`);
  el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  return el;
}

module.exports = { mountApp, wait, clickText, bundleApp };
