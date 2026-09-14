/**
 * Dev/prod backend URL resolution.
 * LAN IPs must NOT be hardcoded here — set BACKEND_URL or BASE_URL in local .env.
 *
 * Dev fallback: local loopback only (same machine). For LAN Desktop ↔ Backend,
 * set BACKEND_URL in .env (never commit that file).
 */
const DEFAULT_DEV_BACKEND_URL = "http://127.0.0.1:3001";
const PROD_BACKEND_URL = "https://api.tallydekho.com";

module.exports = { DEFAULT_DEV_BACKEND_URL, PROD_BACKEND_URL };
