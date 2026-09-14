/**
 * Dev/prod backend URL resolution.
 *
 * Typical setup: Backend on Mac, Desktop on Windows (LAN).
 * Dev fallback uses the Mac LAN IP. Override anytime via local `.env`:
 *   BACKEND_URL=http://192.168.29.xxx:3001
 * (`.env` is gitignored — never commit it.)
 *
 * Same-machine Mac Desktop only: set BACKEND_URL=http://127.0.0.1:3001 in `.env`.
 */
const DEFAULT_DEV_BACKEND_URL = "http://192.168.29.243:3001";
const PROD_BACKEND_URL = "https://api.tallydekho.com";

module.exports = { DEFAULT_DEV_BACKEND_URL, PROD_BACKEND_URL };
