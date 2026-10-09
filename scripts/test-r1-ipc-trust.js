// R1 / 19: privileged IPC runs only for the app's own top-level page, and backup sources
// are confined to Tally data folders this process discovered.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const net = require("node:net");

net.Socket.prototype.connect = function blocked() {
  throw Object.assign(new Error("outbound connections are blocked in this test"), { code: "NETWORK_GUARD" });
};

const ROOT = path.join(__dirname, "..");
const { installIpcSenderCheck, safeOpenFileOptions } = require("../util/ipcTrust");
const { resolveBackupFolders, rootsFromDiscovery, mergeRoots } = require("../util/backupSources");

// ── real ipcRegistry handlers registered through the sender check ──────────────
const registered = new Map();
const fakeIpcMain = { handle: (ch, fn) => registered.set(ch, fn), on: (ch, fn) => registered.set(`on:${ch}`, fn) };
const APP_URL = "file:///C:/Program%20Files/TallyDekho/resources/app.asar/renderer/dist/index.html";
installIpcSenderCheck(fakeIpcMain, (url) => url === APP_URL, () => {}, { "renderer:recover": (u) => u.startsWith("data:text/html") });

const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "electron") return { ipcMain: fakeIpcMain, app: { getPath: () => os.tmpdir(), getVersion: () => "0.0.0" }, dialog: {}, BrowserWindow: class {} };
  return realLoad.call(this, request, ...rest);
};
const stub = (rel, exports) => {
  const file = require.resolve(path.join(ROOT, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
const mem = new Map();
stub("util/store", { get: (k) => mem.get(k), set: (k, v) => mem.set(k, v), delete: (k) => mem.delete(k) });
stub("util/logger", { info: () => {}, error: () => {}, warn: () => {}, logPath: () => "/dev/null" });
stub("util/helper", { isTallyOpen: async () => false, isOnlineHandler: async () => true, axiosInstance: { get: async () => ({}), post: async () => ({}) }, pollJobStatus: async () => ({}) });
const tdlSetupCalls = [];
stub("util/ensureBillOutstandingTdl", { setupTdl: async (dir) => { tdlSetupCalls.push(dir); return { status: "ok" }; }, getTdlHealth: async () => ({ status: "ok" }) });
require(path.join(ROOT, "util/ipcRegistry.js"));

const mainFrame = (url) => { const frame = { url, parent: null }; return { senderFrame: frame, sender: { mainFrame: frame } }; };
const subFrame = (url) => { const top = { url: APP_URL, parent: null }; return { senderFrame: { url, parent: top }, sender: { mainFrame: top } }; };

test("untrusted senders are refused before the handler runs", async () => {
  for (const event of [mainFrame("https://evil.example/"), subFrame(APP_URL), mainFrame("data:text/html,<p>x</p>"), { senderFrame: null }]) {
    tdlSetupCalls.length = 0;
    await assert.rejects(async () => registered.get("tally:tdl_setup")(event, "C:\\Windows\\System32"), { code: "IPC_UNTRUSTED_SENDER" });
    assert.deepEqual(tdlSetupCalls, [], "no TDL write was attempted");
  }
  await assert.rejects(async () => registered.get("companies:remove")(mainFrame("https://evil.example/"), ["g-1"]), { code: "IPC_UNTRUSTED_SENDER" });
});

test("the app page may call handlers, and TDL setup ignores a renderer-supplied folder", async () => {
  tdlSetupCalls.length = 0;
  await registered.get("tally:tdl_setup")(mainFrame(APP_URL), "C:\\Windows\\System32");
  assert.deepEqual(tdlSetupCalls, [null], "setup auto-detects; the renderer cannot choose where files go");
  assert.ok(await registered.get("job:current")(mainFrame(APP_URL)));
});

test("only renderer:recover accepts the data: status page", async () => {
  assert.equal(registered.has("renderer:recover"), false, "registered in main.js, not here");
  const fake = { handle: (ch, fn) => fake[ch] = fn, on: () => {} };
  installIpcSenderCheck(fake, (u) => u === APP_URL, () => {}, { "renderer:recover": (u) => u.startsWith("data:text/html") });
  fake.handle("renderer:recover", () => "ok");
  fake.handle("store:set", () => "ok");
  assert.equal(await fake["renderer:recover"](mainFrame("data:text/html;charset=utf-8,x")), "ok");
  await assert.rejects(async () => fake["store:set"](mainFrame("data:text/html;charset=utf-8,x")), { code: "IPC_UNTRUSTED_SENDER" });
});

test("file picker options are reduced to a plain open-file dialog", () => {
  const o = safeOpenFileOptions({ properties: ["openFile", "openDirectory", "multiSelections", "createDirectory"], filters: [{ name: "Images", extensions: ["png", "../../x"] }], defaultPath: "C:\\Windows" });
  assert.deepEqual(o.properties, ["openFile", "multiSelections"]);
  assert.deepEqual(o.filters, [{ name: "Images", extensions: ["png"] }]);
  assert.equal(o.defaultPath, undefined);
});

// ── backup sources ───────────────────────────────────────────────────────────
function tallyTree() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "td-bk-")));
  const data = path.join(base, "TallyPrime", "Data");
  fs.mkdirSync(path.join(data, "10000"), { recursive: true });
  fs.mkdirSync(path.join(data, "10001"), { recursive: true });
  fs.mkdirSync(path.join(base, "Private", "Documents"), { recursive: true });
  fs.symlinkSync(path.join(base, "Private", "Documents"), path.join(data, "10002"), "dir");
  return { base, data };
}

test("backup folders come from discovery, not from the stored selection", async () => {
  const { base, data } = tallyTree();
  const discovery = { status: "ok", companies: [{ guid: "g-1", destination: path.join(data, "10000") }] };
  const r = await resolveBackupFolders(
    [{ guid: "g-1", path: path.join(base, "Private", "Documents") }],
    { discovery }
  );
  assert.deepEqual(r.folders, [{ guid: "g-1", path: path.join(data, "10000") }], "the renderer-written path was not used");
});

test("arbitrary folders, traversal, links out of the data root and root substitution are refused", async () => {
  const { base, data } = tallyTree();
  const knownRoots = [data];
  const r = await resolveBackupFolders([
    { guid: "ok", path: path.join(data, "10001") },
    { guid: "arbitrary", path: path.join(base, "Private", "Documents") },
    { guid: "traversal", path: path.join(data, "10000", "..", "..", "..", "Private", "Documents") },
    { guid: "link", path: path.join(data, "10002") },
    { guid: "root", path: data },
    { guid: "missing", path: path.join(data, "99999") },
    { guid: "nul", path: `${data}\0/10000` },
  ], { knownRoots });
  assert.deepEqual(r.folders.map((f) => f.guid), ["ok"]);
  assert.deepEqual(Object.fromEntries(r.rejected.map((x) => [x.guid, x.reason])), {
    arbitrary: "folder_outside_tally_data",
    traversal: "folder_outside_tally_data",
    link: "folder_outside_tally_data",
    root: "folder_outside_tally_data",
    missing: "folder_not_found",
    nul: "folder_not_found",
  });
});

test("known data roots are remembered from discoveries, bounded and de-duplicated", () => {
  const roots = rootsFromDiscovery({ companies: [{ destination: "/t/Data/10000" }, { destination: "/t/Data/10001" }] });
  assert.deepEqual(mergeRoots(["/old"], roots), ["/t/Data", "/old"]);
  assert.equal(mergeRoots(Array.from({ length: 9 }, (_, i) => `/r${i}`), []).length, 5);
});
