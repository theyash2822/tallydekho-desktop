/**
 * Backend environment resolution — single source of truth for the Desktop app.
 *
 * Three environments, selected at BUILD time (not by the end user):
 *
 *   production   packaged default → https://api.tallydekho.com
 *   staging      `npm run build:staging` bakes td-env.json → staging backend
 *   development  ELECTRON_DEV=1, LAN backend (Backend on Mac, Desktop on Windows)
 *
 * A packaged PRODUCTION build deliberately ignores BACKEND_URL: an installed
 * client must not be redirectable to an arbitrary host by a stray environment
 * variable or a planted .env file.
 *
 * Typical setup: Dev default is hardcoded to the Mac LAN IP so Windows never
 * hits its own localhost. Loopback overrides are rejected in ELECTRON_DEV.
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_DEV_BACKEND_URL = "http://192.168.29.243:3001";
const PROD_BACKEND_URL = "https://api.tallydekho.com";
const STAGING_BACKEND_URL = "https://staging-api.tallydekho.com";

const APP_ENVS = ["production", "staging", "development"];

/** Known-dead / invalid hosts for Windows Desktop → Mac backend. */
const DEAD_BACKEND_HOSTS = new Set([
  "192.168.29.241",
  "192.168.29.240",
  "192.168.29.180",
  "127.0.0.1",
  "localhost",
]);

/** Written by `npm run build:staging`; absent in normal production builds. */
const BUILD_ENV_FILE = path.join(__dirname, "..", "td-env.json");

function readBuildEnv(file = BUILD_ENV_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const value = String(parsed.appEnv || "").trim().toLowerCase();
    return APP_ENVS.includes(value) ? value : null;
  } catch (_) {
    return null;
  }
}

/**
 * Environment identity. TD_BACKEND_ENV is honoured for local/CI use; the baked
 * build stamp is what a packaged staging installer relies on.
 */
function resolveAppEnv(env = process.env, buildEnv = readBuildEnv()) {
  const explicit = String(env.TD_BACKEND_ENV || "").trim().toLowerCase();
  if (explicit) {
    if (!APP_ENVS.includes(explicit)) {
      throw new Error(
        `Invalid TD_BACKEND_ENV "${env.TD_BACKEND_ENV}". Expected one of: ${APP_ENVS.join(", ")}`
      );
    }
    return explicit;
  }
  if (buildEnv) return buildEnv;
  return env.ELECTRON_DEV ? "development" : "production";
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return "";
  }
}

/**
 * @returns {{ appEnv: string, url: string, isDev: boolean, warnings: string[] }}
 */
function resolveBackendEnvironment(env = process.env, buildEnv = readBuildEnv()) {
  const appEnv = resolveAppEnv(env, buildEnv);
  const warnings = [];

  if (appEnv === "production") {
    return { appEnv, url: PROD_BACKEND_URL, isDev: false, warnings };
  }

  if (appEnv === "staging") {
    const override = String(env.BACKEND_URL || "").trim().replace(/\/+$/, "");
    const url = override || STAGING_BACKEND_URL;
    if (hostOf(url) === hostOf(PROD_BACKEND_URL)) {
      throw new Error(
        `TD_BACKEND_ENV=staging is pointed at the production backend (${url}). ` +
          "A staging build must never write to production."
      );
    }
    return { appEnv, url, isDev: false, warnings };
  }

  // development — LAN backend, loopback rejected
  let url = env.BACKEND_URL || env.BASE_URL || DEFAULT_DEV_BACKEND_URL;
  try {
    const parsed = new URL(url);
    if (DEAD_BACKEND_HOSTS.has(parsed.hostname)) {
      warnings.push(
        `BACKEND_URL ${url} is loopback/stale — Windows Desktop cannot reach Mac backend there. ` +
          `Using hardcoded ${DEFAULT_DEV_BACKEND_URL}`
      );
      url = DEFAULT_DEV_BACKEND_URL;
    }
  } catch (_) {
    url = DEFAULT_DEV_BACKEND_URL;
  }
  return { appEnv, url, isDev: true, warnings };
}

module.exports = {
  APP_ENVS,
  DEFAULT_DEV_BACKEND_URL,
  PROD_BACKEND_URL,
  STAGING_BACKEND_URL,
  DEAD_BACKEND_HOSTS,
  readBuildEnv,
  resolveAppEnv,
  resolveBackendEnvironment,
};
