/**
 * Non-destructive repair of config.json against util/schema.json.
 *
 * - A company entry that fails validation is quarantined (returned to the caller
 *   to be written beside the config), never silently dropped.
 * - Other invalid values are removed so their schema default applies.
 * - Nothing here deletes the config file or relaunches the app.
 */
const SELECTION_KEY = "selectedCompanies";
const QUARANTINABLE_ARRAYS = new Set([SELECTION_KEY, "backups", "backupAndRestoreActivity"]);

const decode = (pointer) =>
  pointer
    .slice(1)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/**
 * @param {object} input parsed config (not mutated)
 * @param {(cfg: object) => boolean & { errors?: object[] }} validate Ajv validate fn WITHOUT defaults
 * @param {(cfg: object) => void} applyDefaults Ajv validate fn WITH useDefaults
 */
function repairConfig(input, validate, applyDefaults) {
  const config = clone(input && typeof input === "object" && !Array.isArray(input) ? input : {});
  const quarantined = [];
  const removedKeys = [];
  const actions = [];

  for (let pass = 0; pass < 3; pass++) {
    if (validate(config)) break;
    const errors = validate.errors || [];
    const badItems = new Map();
    const badTopKeys = new Set();
    const unknownKeys = new Set();
    for (const e of errors) {
      if (e.keyword === "additionalProperties" && (e.instancePath || "") === "") {
        badTopKeys.add(e.params?.additionalProperty);
        unknownKeys.add(e.params?.additionalProperty);
        continue;
      }
      const parts = decode(e.instancePath || "");
      const top = parts[0];
      if (!top) continue;
      if (QUARANTINABLE_ARRAYS.has(top) && parts.length > 1 && /^[0-9]+$/.test(parts[1])) {
        if (!badItems.has(top)) badItems.set(top, new Set());
        badItems.get(top).add(Number(parts[1]));
      } else {
        badTopKeys.add(top);
      }
    }
    for (const [top, indices] of badItems) {
      const arr = config[top];
      if (!Array.isArray(arr)) continue;
      const keep = [];
      arr.forEach((item, i) => {
        if (indices.has(i)) quarantined.push({ key: top, index: i, item });
        else keep.push(item);
      });
      config[top] = keep;
      actions.push(`quarantined ${indices.size} invalid ${top} entr${indices.size === 1 ? "y" : "ies"}`);
    }
    for (const key of badTopKeys) {
      if (key && Object.prototype.hasOwnProperty.call(config, key)) {
        // Unknown keys are dropped as before (they may hold legacy secrets, so they are
        // not copied anywhere); a known key with a bad value is kept for inspection.
        if (!unknownKeys.has(key)) quarantined.push({ key, item: config[key] });
        delete config[key];
        removedKeys.push(key);
        actions.push(`reset '${key}' to default`);
      }
    }
    if (!badItems.size && !badTopKeys.size) break;
  }

  applyDefaults(config);
  const valid = validate(config);
  return {
    config,
    valid,
    changed: JSON.stringify(config) !== JSON.stringify(input),
    quarantined,
    removedKeys,
    actions,
    remainingErrors: valid ? [] : (validate.errors || []).map((e) => `${e.instancePath} ${e.message}`),
  };
}

module.exports = { repairConfig, SELECTION_KEY };
