const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const schema = require("./schema.json");
const { info } = require("./logger.js");

// const errors = [
//   {
//     instancePath: "/isOnline",
//     schemaPath: "#/properties/isOnline/type",
//     keyword: "type",
//     params: { type: "boolean" },
//     message: "must be boolean",
//   },
//   {
//     instancePath: "/selectedCompanies/0",
//     schemaPath: "#/required",
//     keyword: "required",
//     params: { missingProperty: "path" },
//     message: "must have required property 'path'",
//   },
//   {
//     instancePath: "/selectedCompanies/0/allYears/0/finYear",
//     schemaPath: "#/definitions/yearItem/properties/finYear/type",
//     keyword: "type",
//     params: { type: "string" },
//     message: "must be string",
//   },
//   {
//     instancePath: "/selectedCompanies/0/allYears/1",
//     schemaPath: "#/definitions/yearItem/required",
//     keyword: "required",
//     params: { missingProperty: "finYear" },
//     message: "must have required property 'finYear'",
//   },
//   {
//     instancePath: "/backups/0/size",
//     schemaPath: "#/definitions/backupItem/properties/size/type",
//     keyword: "type",
//     params: { type: "string" },
//     message: "must be string",
//   },
// ];

const decodePointerParts = (pointer) =>
  pointer
    .slice(1)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));

const deleteExactPath = (rootObj, instancePath) => {
  if (!instancePath || instancePath === "") return false;
  const parts = decodePointerParts(instancePath);
  let cur = rootObj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const idx = /^[0-9]+$/.test(key) ? Number(key) : key;
    if (cur == null) return false;
    cur = cur[idx];
  }
  const last = parts[parts.length - 1];
  const lastIdx = /^[0-9]+$/.test(last) ? Number(last) : last;
  if (cur == null) return false;

  if (Array.isArray(cur) && typeof lastIdx === "number") {
    if (lastIdx < 0 || lastIdx >= cur.length) return false;
    // mark as null (do not splice now)
    const removedValue = cur[lastIdx];
    cur[lastIdx] = null;
    return { marked: true, removed: removedValue };
  } else if (Object.prototype.hasOwnProperty.call(cur, lastIdx)) {
    const removedValue = cur[lastIdx];
    delete cur[lastIdx];
    return { deleted: true, removed: removedValue };
  }
  return false;
};

function deleteInstancePaths(obj, instancePaths) {
  if (!Array.isArray(instancePaths) || instancePaths.length === 0) {
    return { deleted: [], notFound: [] };
  }

  const topArrays = new Set([
    "selectedCompanies",
    "backups",
    "backupAndRestoreActivity",
  ]);

  const uniquePaths = Array.from(new Set(instancePaths));

  const marks = {
    selectedCompanies: new Set(),
    backups: new Set(),
    backupAndRestoreActivity: new Set(),
  };

  const deleteWholeProp = new Set();
  const leftoverPaths = new Set();

  // First pass: decide what to mark/delete
  for (const ip of uniquePaths) {
    if (!ip || ip === "") {
      leftoverPaths.add(ip);
      continue;
    }

    const parts = decodePointerParts(ip);
    if (parts.length === 0) {
      leftoverPaths.add(ip);
      continue;
    }

    const top = parts[0];
    if (topArrays.has(top)) {
      if (parts.length === 1) {
        deleteWholeProp.add(top);
        continue;
      }
      const maybeIdx = parts[1];
      if (/^[0-9]+$/.test(maybeIdx)) {
        marks[top].add(Number(maybeIdx));
        continue;
      }
      leftoverPaths.add(ip);
      continue;
    }

    leftoverPaths.add(ip);
  }

  const deleted = [];
  const notFound = [];

  for (const prop of deleteWholeProp) {
    if (Object.prototype.hasOwnProperty.call(obj, prop)) {
      delete obj[prop];
      deleted.push({ path: `/${prop}`, why: "deleted whole array property" });
    } else {
      notFound.push(`/${prop}`);
    }
  }

  for (const top of Object.keys(marks)) {
    const arr = obj && obj[top];
    const indices = Array.from(marks[top]);
    if (!Array.isArray(arr)) {
      for (const idx of indices) notFound.push(`/${top}/${idx}`);
      continue;
    }
    for (const idx of indices) {
      if (idx < 0 || idx >= arr.length) {
        notFound.push(`/${top}/${idx}`);
        continue;
      }
      const removedValue = arr[idx];
      arr[idx] = null;
      deleted.push({
        path: `/${top}/${idx}`,
        why: `marked null (to be removed later)`,
        removed: removedValue,
      });
    }
  }

  for (const ip of leftoverPaths) {
    if (!ip || ip === "") continue; // skip root-level handling
    const res = deleteExactPath(obj, ip);
    if (res === false) {
      notFound.push(ip);
    } else if (res.marked) {
      deleted.push({
        path: ip,
        why: "marked null (exact path inside array)",
        removed: res.removed,
      });
    } else if (res.deleted) {
      deleted.push({
        path: ip,
        why: "deleted exact property",
        removed: res.removed,
      });
    }
  }

  // Cleanup pass: remove all nulls from each special array (collapse the array)
  for (const top of Object.keys(marks)) {
    const arr = obj && obj[top];
    if (!Array.isArray(arr)) continue;
    const beforeLen = arr.length;
    const cleaned = arr.filter((item) => item !== null);
    obj[top] = cleaned;
    const removedCount = beforeLen - cleaned.length;
    if (removedCount > 0) {
      deleted.push({
        path: `/${top}`,
        why: `cleaned ${removedCount} null entries from ${top}`,
        removedCount,
      });
    }
  }

  return { deleted, notFound };
}

function validateSchema() {
  try {
    const configPath = path.join(app.getPath("userData"), "config.json");

    let parsed;
    let existed = true;

    if (!fs.existsSync(configPath)) {
      parsed = {};
      existed = false;
    } else {
      const raw = fs.readFileSync(configPath, "utf8");
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        // const bak = configPath + ".corrupt." + Date.now();
        // fs.copyFileSync(configPath, bak);
        // console.warn("config.json corrupt -> backed up to", bak);
        parsed = {};
        existed = false;
      }
    }

    const ajvForError = new Ajv({ allErrors: true, strict: false });
    addFormats(ajvForError);
    const validateForError = ajvForError.compile(schema);
    const validForError = validateForError(parsed);

    if (validForError) {
      const ajvWithDefaults = new Ajv({
        allErrors: true,
        useDefaults: true,
        strict: false,
      });
      addFormats(ajvWithDefaults);
      const validateWithDefaults = ajvWithDefaults.compile(schema);
      validateWithDefaults(parsed);
      fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), "utf8");
      info("Config valid; defaults ensured and written.");
      return;
    }

    const instancePaths = Array.from(
      new Set(
        (validateForError.errors || [])
          .map((e) => e.instancePath || "")
          .filter((p) => p !== "")
      )
    );

    // if (existed) {
    //   const bak = configPath + ".bak." + Date.now();
    //   try {
    //     fs.copyFileSync(configPath, bak);
    //     console.log("Backup saved to", bak);
    //   } catch (e) {}
    // }

    const { deleted, notFound } = deleteInstancePaths(parsed, instancePaths);

    const ajv = new Ajv({
      allErrors: true,
      useDefaults: true,
      coerceTypes: false,
      strict: false,
    });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const valid = validate(parsed);

    if (!valid) {
      info("Config still invalid after repair attempt:", validate.errors);

      try {
        fs.unlinkSync(configPath);
        info("Deleted corrupt config.json");
      } catch (err) {
        info("Failed to delete config.json:", err);
        return;
      }

      info("Restarting app due to unrecoverable config errors...");
      app.relaunch();
      // app.quit();
      app.exit(0);
      return;
    }

    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), "utf8");

    info("Config repaired and defaults applied for keys:", {
      deleted,
      notFound,
    });
  } catch (err) {
    info("validateSchema error:", err);
  }
}

module.exports = validateSchema;
