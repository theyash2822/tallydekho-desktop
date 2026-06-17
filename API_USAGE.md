# API_USAGE.md — td-source/desktop

## Backend Communication
File: `util/helper.js` → `axiosInstance`
Base URL: `BACKEND_URL` env var or electron-store `backendUrl`
Default: `http://192.168.29.243:3001`

## Tally HTTP Interface
URL: `http://localhost:9000` (Tally Prime on same machine)
Method: POST, Content-Type: text/xml
Templates: `xmls/*.xml`

## Backend API Calls (via axiosInstance)
Most backend calls go through Socket.io events, but some use direct HTTP:

| Purpose | Method | Endpoint |
|---------|--------|----------|
| Ping backend | GET | /health |
| Get pairing code | GET | /app/pairing-code (Needs verification) |
| Get paired device | GET | /app/pairing-device (Needs verification) |
| Remove pairing | DELETE | /app/pairing (Needs verification) |
| Send logs | POST | /app/logs (Needs verification) |
| Get user profile | GET | /app/me (Needs verification) |
| Ingest chunk | POST | /ingest/chunk |

Note: Exact endpoint paths need verification against `util/helper.js` + `util/ipcRegistry.js`.

## Socket.io Events (Desktop → Backend)
| Event | Payload |
|-------|---------|
| sync:start | {deviceId, companyGuid, companies} |
| sync:data | {type, records[], companyGuid} |
| sync:complete | {deviceId, companyGuid, summary} |
| tally:write:result | {voucherId, tallyGuid, success, error?} |

## Socket.io Events (Backend → Desktop)
| Event | Action |
|-------|--------|
| tally:write | Create voucher in Tally (write XML) |
| pairing:confirmed | Update pairing state |
| logout | Force logout |

## Authentication
- Desktop uses device_id (from `util/deviceProfile.js`) not user JWT
- After pairing, backend associates device_id with user_id
- Some API calls may use user token (Needs verification)

## Store Keys (electron-store via util/store.js)
| Key | Purpose |
|-----|---------|
| destination | Tally data file path |
| appVersion | Current app version |
| backendUrl | Backend URL override |
| autoSync | Auto-sync config |
| autoBackup | Auto-backup config |
