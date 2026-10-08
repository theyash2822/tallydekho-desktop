const REGISTER_FAILED_MESSAGE =
  "Something went wrong. If this message persists, please contact the support team.";

/** A 2xx body is only a successful registration if the server says so. */
function checkRegisterResponse(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, reason: "empty response", message: REGISTER_FAILED_MESSAGE };
  }
  if (body.status !== true) {
    return { ok: false, reason: `status=${body.status}`, message: body.message || REGISTER_FAILED_MESSAGE };
  }
  if (body.data != null && typeof body.data !== "object") {
    return { ok: false, reason: "malformed data", message: REGISTER_FAILED_MESSAGE };
  }
  const level = body.data?.versionLevel;
  if (level != null && !(Number.isInteger(level) && level >= 0 && level <= 3)) {
    return { ok: false, reason: "invalid versionLevel", message: REGISTER_FAILED_MESSAGE };
  }
  return { ok: true };
}

/** ISO string for a server timestamp (ISO string, epoch ms or epoch seconds); null when absent/invalid. */
function toIsoDate(value) {
  if (value == null || value === "") return null;
  let d;
  if (typeof value === "number") d = new Date(value < 1e12 ? value * 1000 : value);
  else d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = { REGISTER_FAILED_MESSAGE, checkRegisterResponse, toIsoDate };
