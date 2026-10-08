const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const schema = require("./schema.json");
const { info, error } = require("./logger.js");
const { repairConfig } = require("./settingsMigration");

const MAX_BACKUPS = 5;

function compile(useDefaults) {
  const ajv = new Ajv({ allErrors: true, useDefaults, coerceTypes: false, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

/** Keep the newest MAX_BACKUPS files with the given prefix. */
function pruneSiblings(dir, prefix) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .sort()
      .reverse();
    for (const f of files.slice(MAX_BACKUPS)) fs.unlinkSync(path.join(dir, f));
  } catch (_) { /* best effort */ }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Validate config.json, apply defaults and repair invalid values without losing
 * user data: the original file is copied aside before any change and invalid
 * company entries are written to a quarantine file. Never deletes the config and
 * never relaunches the app.
 */
function validateSchema() {
  try {
    const dir = app.getPath("userData");
    const configPath = path.join(dir, "config.json");

    let raw = null;
    let parsed = {};
    if (fs.existsSync(configPath)) {
      raw = fs.readFileSync(configPath, "utf8");
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        const corrupt = path.join(dir, `config.json.corrupt-${stamp()}`);
        fs.copyFileSync(configPath, corrupt);
        pruneSiblings(dir, "config.json.corrupt-");
        error("config.json is not valid JSON; original kept aside and defaults applied", "validateSchema");
        parsed = {};
      }
    }

    const result = repairConfig(parsed, compile(false), compile(true));

    if (result.actions.length && raw != null) {
      fs.copyFileSync(configPath, path.join(dir, `config.json.bak-${stamp()}`));
      pruneSiblings(dir, "config.json.bak-");
    }
    if (result.quarantined.length) {
      const file = path.join(dir, `config.quarantine-${stamp()}.json`);
      fs.writeFileSync(file, JSON.stringify(result.quarantined, null, 2), "utf8");
      pruneSiblings(dir, "config.quarantine-");
    }

    fs.writeFileSync(configPath, JSON.stringify(result.config, null, 2), "utf8");

    if (result.actions.length) {
      info("Config repaired", {
        actions: result.actions,
        quarantined: result.quarantined.length,
        removedKeys: result.removedKeys,
      });
    } else {
      info("Config valid; defaults ensured and written.");
    }
    if (!result.valid) {
      error("Config still has invalid values after repair; continuing with them", {
        errors: result.remainingErrors.slice(0, 10),
      });
    }
  } catch (err) {
    error("validateSchema failed; config left unchanged", { message: err?.message });
  }
}

module.exports = validateSchema;
