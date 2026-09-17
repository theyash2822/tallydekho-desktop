/**
 * Dev/prod backend URL resolution.
 *
 * Typical setup: Backend on Mac, Desktop on Windows (LAN).
 * Dev default is hardcoded to the Mac LAN IP so Windows never hits its own localhost.
 *
 * Optional override via local `.env` BACKEND_URL — but loopback (127.0.0.1 / localhost)
 * is rejected in ELECTRON_DEV and remapped to this default.
 */
const DEFAULT_DEV_BACKEND_URL = "http://192.168.29.243:3001";
const PROD_BACKEND_URL = "https://api.tallydekho.com";

module.exports = { DEFAULT_DEV_BACKEND_URL, PROD_BACKEND_URL };
