/**
 * Single source of truth for the Mac LAN backend URL.
 * When DHCP reassigns the Mac IP, update DEFAULT_DEV_BACKEND_URL here only.
 * Optional override: set BACKEND_URL or BASE_URL in .env (takes precedence).
 */
const DEFAULT_DEV_BACKEND_URL = "http://192.168.29.243:3001";
const PROD_BACKEND_URL = "https://api.tallydekho.com";

module.exports = { DEFAULT_DEV_BACKEND_URL, PROD_BACKEND_URL };
