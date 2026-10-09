const fs = require("fs");
const path = require("path");

/**
 * Company data folders a backup may read. The selection (which the renderer can write)
 * names companies; the folders come from Tally's own discovery in this process, or must
 * canonicalise (links/junctions resolved) to a numbered company folder directly inside a
 * Tally data root this process has seen. Anything else is refused before any file access.
 */
const TALLY_COMPANY_FOLDER = /^\d{1,6}$/;
const MAX_ROOTS = 5;

const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

async function canonical(p, realpath) {
  if (typeof p !== "string" || !p.trim() || p.includes("\0")) return null;
  try {
    return await realpath(path.resolve(p));
  } catch (_) {
    return null;
  }
}

/** Data roots (parents of company folders) from a discovery result. */
function rootsFromDiscovery(discovery) {
  const roots = [];
  for (const c of discovery?.companies || []) {
    if (typeof c?.destination === "string" && c.destination.trim()) roots.push(path.dirname(path.resolve(c.destination)));
  }
  return roots;
}

/** Remembered roots (main-process only setting), newest first, bounded. */
function mergeRoots(previous, found) {
  const out = [];
  for (const r of [...found, ...(Array.isArray(previous) ? previous : [])]) {
    if (typeof r === "string" && r && !out.some((x) => samePath(x, r))) out.push(r);
  }
  return out.slice(0, MAX_ROOTS);
}

/**
 * @returns {{ folders: Array<{guid, path}>, rejected: Array<{guid, reason}> }}
 */
async function resolveBackupFolders(companies, { discovery = null, knownRoots = [], realpath = fs.promises.realpath } = {}) {
  const discovered = new Map();
  for (const c of discovery?.companies || []) {
    if (c?.guid && typeof c.destination === "string") discovered.set(String(c.guid), c.destination);
  }
  const roots = [];
  for (const r of [...rootsFromDiscovery(discovery), ...knownRoots]) {
    const real = await canonical(r, realpath);
    if (real && !roots.some((x) => samePath(x, real))) roots.push(real);
  }

  const folders = [];
  const rejected = [];
  for (const company of companies || []) {
    const guid = String(company?.guid || company?.id || "");
    const candidate = discovered.get(guid) ?? company?.path;
    const real = await canonical(candidate, realpath);
    if (!real) {
      rejected.push({ guid, reason: "folder_not_found" });
      continue;
    }
    const insideRoot = roots.some((root) => samePath(path.dirname(real), root));
    if (!insideRoot || !TALLY_COMPANY_FOLDER.test(path.basename(real))) {
      rejected.push({ guid, reason: "folder_outside_tally_data" });
      continue;
    }
    if (!folders.some((f) => samePath(f.path, real))) folders.push({ guid, path: real });
  }
  return { folders, rejected };
}

module.exports = { resolveBackupFolders, rootsFromDiscovery, mergeRoots };
