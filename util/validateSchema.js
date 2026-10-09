const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const fs = require("fs");
const path = require("path");

const schema = require("./schema.json");
const { info, error } = require("./logger.js");
const { repairConfig } = require("./settingsMigration");

const MAX_BACKUPS = 5;
// Bump when schema.json gains a migration that should be backed up before it applies.
const CONFIG_SCHEMA_VERSION = 2;

function compile(useDefaults) {
  const ajv = new Ajv({ allErrors: true, useDefaults, coerceTypes: false, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

/**
 * Keep the oldest file with the given prefix (the pre-upgrade copy) plus the newest
 * MAX_BACKUPS - 1, so routine repairs never cycle the original out.
 */
function pruneSiblings(dir, prefix) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
    if (files.length <= MAX_BACKUPS) return;
    const keep = new Set([files[0], ...files.slice(-(MAX_BACKUPS - 1))]);
    for (const f of files) if (!keep.has(f)) fs.unlinkSync(path.join(dir, f));
  } catch (_) { /* best effort */ }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Write via a temp file + rename so an interrupted write never leaves a truncated config. */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* already gone */ }
    throw err;
  }
}

/**
 * Validate config.json, apply defaults and repair invalid values without losing
 * user data: the original file is copied aside before a real repair or version
 * upgrade, and invalid entries are written to a quarantine file. A config that is
 * already valid and current is not rewritten. Never deletes the config and never
 * relaunches the app.
 */
function validateSchema({ dir } = {}) {
  try {
    const userData = dir || require("electron").app.getPath("userData");
    const configPath = path.join(userData, "config.json");

    let raw = null;
    let parsed = {};
    let corrupt = false;
    if (fs.existsSync(configPath)) {
      raw = fs.readFileSync(configPath, "utf8");
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        corrupt = true;
        fs.copyFileSync(configPath, path.join(userData, `config.json.corrupt-${stamp()}`));
        pruneSiblings(userData, "config.json.corrupt-");
        error("config.json is not valid JSON; original kept aside and defaults applied", "validateSchema");
        parsed = {};
      }
    }

    const result = repairConfig(parsed, compile(false), compile(true));
    const fromVersion = Number(parsed?.configSchemaVersion) || 1;
    const upgrading = raw != null && !corrupt && fromVersion < CONFIG_SCHEMA_VERSION;
    result.config.configSchemaVersion = Math.max(fromVersion, CONFIG_SCHEMA_VERSION);

    if ((result.actions.length || upgrading) && raw != null && !corrupt) {
      fs.copyFileSync(configPath, path.join(userData, `config.json.bak-${stamp()}`));
      pruneSiblings(userData, "config.json.bak-");
    }
    if (result.quarantined.length) {
      const file = path.join(userData, `config.quarantine-${stamp()}.json`);
      writeAtomic(file, JSON.stringify(result.quarantined, null, 2));
      pruneSiblings(userData, "config.quarantine-");
    }

    const written = raw == null || corrupt || JSON.stringify(result.config) !== JSON.stringify(parsed);
    // Tab indentation matches what electron-store writes.
    if (written) writeAtomic(configPath, JSON.stringify(result.config, null, "\t"));

    if (result.actions.length) {
      info("Config repaired", {
        actions: result.actions,
        quarantined: result.quarantined.length,
        removedKeys: result.removedKeys,
      });
    } else if (upgrading) {
      info("Config upgraded", { from: fromVersion, to: CONFIG_SCHEMA_VERSION });
    } else {
      info("Config valid; defaults ensured.");
    }
    if (!result.valid) {
      error("Config still has invalid values after repair; continuing with them", {
        errors: result.remainingErrors.slice(0, 10),
      });
    }
    return { actions: result.actions, upgraded: upgrading, written };
  } catch (err) {
    error("validateSchema failed; config left unchanged", { message: err?.message });
    return { failed: true };
  }
}

module.exports = validateSchema;
module.exports.CONFIG_SCHEMA_VERSION = CONFIG_SCHEMA_VERSION;
