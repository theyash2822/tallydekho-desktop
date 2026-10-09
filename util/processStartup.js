/**
 * Settings load and task upkeep that run once per process, before either headless
 * or windowed work. Opening the window later (including inside a running headless
 * job) never repeats them.
 */
let started = null;

function runProcessStartup({
  store,
  validateSchema,
  isTaskExists,
  reconcileOwnedTaskSettings,
  appVersion,
  tmpdir,
  log = () => {},
}) {
  if (started) return started;

  if (!store.get("backup.dir")) store.set("backup.dir", tmpdir);
  store.set("appVersion", appVersion);
  const settings = validateSchema();

  const checks = [];
  if (store.get("isAutoSync")) {
    checks.push(isTaskExists("TallyDekhoAutoSync").then((exists) => {
      if (!exists) store.set("isAutoSync", false);
    }).catch(() => {}));
  }
  if (store.get("backupInterval") && store.get("backupInterval") != "off") {
    checks.push(isTaskExists("TallyDekhoAutoBackup").then((exists) => {
      if (!exists) store.set("backupInterval", "off");
    }).catch(() => {}));
  }

  // Tasks created by older builds woke the PC; re-apply our own task settings once per version.
  const tasks = reconcileOwnedTaskSettings(store, { log })
    .then((r) => { log("[tasks] settings reconcile", r); return r; })
    .catch((e) => { log("[tasks] settings reconcile skipped", e?.message); return null; });

  started = { settings, done: Promise.all(checks).then(() => tasks) };
  return started;
}

function resetProcessStartupForTests() {
  started = null;
}

module.exports = { runProcessStartup, resetProcessStartupForTests };
