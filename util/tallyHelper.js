function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function coerce(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string")
    return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function normalizeEnvelope(envelope, { map = {}, strictLengths = false } = {}) {
  const keys = Object.keys(envelope || {});
  if (keys.length === 0) return [];

  delete envelope.FLDBLANK;

  // 1) Normalize each field to an array
  const arraysByKey = {};
  for (const k of keys) arraysByKey[k] = asArray(envelope[k]);

  // 2) Determine row count: max length among arrays; if all scalars → 1
  const rowCount = Math.max(
    1,
    ...Object.values(arraysByKey).map((arr) => arr.length)
  );

  // 3) Optionally validate lengths
  if (strictLengths) {
    const lens = Object.fromEntries(
      keys.map((k) => [k, arraysByKey[k].length])
    );
    const multi = Object.values(lens).filter((n) => n > 1);
    if (multi.length && new Set(multi).size > 1) {
      throw new Error(`Inconsistent field lengths: ${JSON.stringify(lens)}`);
    }
  }

  // 4) Build rows; scalars (len 1) are reused across all rows
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const row = {};
    for (const k of keys) {
      const arr = arraysByKey[k];
      const raw =
        arr.length === 0
          ? null
          : arr.length === 1
          ? arr[0]
          : i < arr.length
          ? arr[i]
          : null;

      const value = map[k] ? map[k](raw) : coerce(raw);
      row[k] =
        typeof value == "string"
          ? value
              .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "")
              .replace(/&#[0-9]{1,2};/g, "")
              .trim()
          : value;
    }
    rows.push(row);
  }
  return rows;
}

module.exports = { normalizeEnvelope };
