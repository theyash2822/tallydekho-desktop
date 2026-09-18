#!/usr/bin/env node
/**
 * Bakes the target environment into the packaged Desktop build.
 *
 * A packaged app has no shell environment, so the environment cannot come from
 * TD_BACKEND_ENV at launch — it is written here and read by util/backendConfig.js.
 *
 *   node scripts/set-build-env.js staging
 *   node scripts/set-build-env.js production   (removes the stamp)
 */
const fs = require("fs");
const path = require("path");
const { APP_ENVS } = require("../util/backendConfig");

const target = String(process.argv[2] || "").trim().toLowerCase();
if (!APP_ENVS.includes(target)) {
  console.error(`Usage: node scripts/set-build-env.js <${APP_ENVS.join("|")}>`);
  process.exit(1);
}

const file = path.join(__dirname, "..", "td-env.json");

if (target === "production") {
  // Production is the default; no stamp means no way to mis-stamp a release.
  if (fs.existsSync(file)) fs.unlinkSync(file);
  console.log("build env: production (stamp removed)");
} else {
  fs.writeFileSync(file, `${JSON.stringify({ appEnv: target }, null, 2)}\n`);
  console.log(`build env: ${target} → ${path.relative(process.cwd(), file)}`);
}
