#!/usr/bin/env node
/**
 * Guard: environment selection must be build-controlled and staging must never
 * reach production.
 *
 * Run: npm run verify:config
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  resolveAppEnv,
  resolveBackendEnvironment,
  PROD_BACKEND_URL,
  STAGING_BACKEND_URL,
  DEFAULT_DEV_BACKEND_URL,
} = require("../util/backendConfig");

const root = path.join(__dirname, "..");
const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

console.log("desktop backend configuration guard");

check("packaged default is production", () => {
  const r = resolveBackendEnvironment({}, null);
  assert.equal(r.appEnv, "production");
  assert.equal(r.url, PROD_BACKEND_URL);
  assert.equal(r.isDev, false);
});

check("a packaged production build ignores BACKEND_URL injection", () => {
  const r = resolveBackendEnvironment({ BACKEND_URL: "http://evil.example.com" }, null);
  assert.equal(r.url, PROD_BACKEND_URL);
});

check("ELECTRON_DEV selects the LAN backend", () => {
  const r = resolveBackendEnvironment({ ELECTRON_DEV: "1" }, null);
  assert.equal(r.appEnv, "development");
  assert.equal(r.url, DEFAULT_DEV_BACKEND_URL);
  assert.equal(r.isDev, true);
});

check("dev loopback override is rejected and reported", () => {
  const r = resolveBackendEnvironment(
    { ELECTRON_DEV: "1", BACKEND_URL: "http://localhost:3001" },
    null
  );
  assert.equal(r.url, DEFAULT_DEV_BACKEND_URL);
  assert.equal(r.warnings.length, 1);
});

check("baked staging stamp selects the staging backend", () => {
  const r = resolveBackendEnvironment({}, "staging");
  assert.equal(r.appEnv, "staging");
  assert.equal(r.url, STAGING_BACKEND_URL);
});

check("TD_BACKEND_ENV overrides the stamp for local use", () => {
  assert.equal(resolveAppEnv({ TD_BACKEND_ENV: "staging" }, null), "staging");
  assert.equal(resolveAppEnv({ TD_BACKEND_ENV: "production" }, "staging"), "production");
});

check("an invalid TD_BACKEND_ENV fails closed", () => {
  assert.throws(() => resolveAppEnv({ TD_BACKEND_ENV: "prod" }, null), /Invalid TD_BACKEND_ENV/);
});

check("staging refuses to be pointed at production", () => {
  assert.throws(
    () => resolveBackendEnvironment({ TD_BACKEND_ENV: "staging", BACKEND_URL: PROD_BACKEND_URL }, null),
    /pointed at the production backend/
  );
});

check("the production URL appears only in the central config module", () => {
  const offenders = [];
  const skipDirs = new Set(["node_modules", "dist_electron", "renderer", "xmls", ".git", "dist"]);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(path.join(dir, entry.name));
      } else if (/\.js$/.test(entry.name)) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full);
        if (rel === path.join("util", "backendConfig.js")) continue;
        if (rel.startsWith("scripts")) continue;
        const src = fs.readFileSync(full, "utf8");
        // Ignore the auto-update feed, which is separate infrastructure.
        const apiHits = src
          .split("\n")
          .filter((l) => l.includes("api.tallydekho.com") && !l.trim().startsWith("//"));
        if (apiHits.length) offenders.push(rel);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], `hardcoded backend URL outside central config: ${offenders.join(", ")}`);
});

check("td-env.json is not committed as production residue", () => {
  const file = path.join(root, "td-env.json");
  if (!fs.existsSync(file)) return;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.notEqual(
    parsed.appEnv,
    "production",
    "a production stamp file is meaningless — production is the default"
  );
});

check("non-production builds never self-update from the production feed", () => {
  const helper = fs.readFileSync(path.join(root, "util", "helper.js"), "utf8");
  const guard = helper
    .slice(helper.indexOf("async function checkForUpdates"))
    .slice(0, 400);
  assert.match(
    guard,
    /APP_ENV !== "production"[\s\S]{0,40}return/,
    "checkForUpdates must bail out for non-production builds"
  );

  const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
  const configure = main.slice(main.indexOf("function configureUpdater")).slice(0, 600);
  assert.match(
    configure,
    /APP_ENV !== "production"[\s\S]{0,80}return/,
    "configureUpdater must bail out for non-production builds"
  );
});

check("the update feed is documented as active infrastructure", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const publish = pkg.build?.publish?.[0]?.url || "";
  assert.ok(publish, "electron-builder publish feed must stay configured");
  // Named test.* for historical reasons but serves shipped production clients.
  assert.ok(
    !publish.includes("staging"),
    "the production update feed must not point at a staging host"
  );
});

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall backend configuration checks passed");
