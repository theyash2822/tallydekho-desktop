/**
 * Pre-extraction and pre-apply checks for restore archives. Pure helpers so the
 * rules are unit-testable without 7-Zip or Electron.
 */

const SPACE_MARGIN_BYTES = 200 * 1024 * 1024;

/** Parse `7za l -slt` output into entries. */
function parseSevenZipListing(text) {
  const entries = [];
  const body = String(text || "").split(/\r?\n----------\r?\n/).slice(1).join("\n----------\n");
  let cur = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) {
      if (cur && cur.path != null) entries.push(cur);
      cur = null;
      continue;
    }
    const m = line.match(/^([^=]+?) = ?(.*)$/);
    if (!m) continue;
    cur = cur || {};
    const key = m[1].trim();
    const val = m[2];
    if (key === "Path") cur.path = val;
    else if (key === "Size") cur.size = Number(val) || 0;
    else if (key === "Folder") cur.isDir = val === "+";
    else if (key === "Attributes") cur.attributes = val;
    else if (key === "Symbolic Link") cur.symlink = val;
  }
  if (cur && cur.path != null) entries.push(cur);
  return entries;
}

function isSymlinkEntry(e) {
  if (e.symlink) return true;
  const attrs = String(e.attributes || "");
  return /(^|\s)l[rwxsStT-]{9}\b/.test(attrs);
}

function splitEntryPath(p) {
  return String(p || "").split(/[\\/]+/).filter((s) => s.length > 0);
}

/**
 * @returns {{ ok: true, totalBytes: number, topFolders: string[] } | { ok: false, code: string, message: string }}
 */
function inspectArchiveEntries(entries, { freeBytes = null, margin = SPACE_MARGIN_BYTES } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, code: "BACKUP_ARCHIVE_EMPTY", message: "Backup archive has no files" };
  }
  let totalBytes = 0;
  const top = new Set();
  for (const e of entries) {
    const p = String(e.path || "");
    if (!p || /^[\\/]/.test(p) || /^[a-zA-Z]:/.test(p) || p.includes("\0")) {
      return { ok: false, code: "BACKUP_ARCHIVE_UNSAFE", message: "Backup archive contains an absolute path" };
    }
    const parts = splitEntryPath(p);
    if (parts.some((s) => s === ".." || s === ".")) {
      return { ok: false, code: "BACKUP_ARCHIVE_UNSAFE", message: "Backup archive contains a path outside its folder" };
    }
    if (isSymlinkEntry(e)) {
      return { ok: false, code: "BACKUP_ARCHIVE_UNSAFE", message: "Backup archive contains a link" };
    }
    if (parts.length === 1 && !e.isDir) {
      return { ok: false, code: "BACKUP_ARCHIVE_UNSAFE", message: "Backup archive has files outside company folders" };
    }
    top.add(parts[0]);
    totalBytes += Number(e.size) || 0;
  }
  if (freeBytes != null && Number.isFinite(freeBytes) && totalBytes + margin > freeBytes) {
    return { ok: false, code: "RESTORE_DISK_SPACE", message: "Not enough free disk space to restore" };
  }
  return { ok: true, totalBytes, topFolders: [...top].sort() };
}

function manifestFolders(manifest) {
  let list = manifest;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  const names = (Array.isArray(list) ? list : [])
    .flatMap((c) => [c?.folder, c?.folder_name])
    .map((n) => String(n || "").trim())
    .filter(Boolean);
  return [...new Set(names)];
}

/** Archive folders must be exactly the folders the backup recorded. Legacy manifests are skipped. */
function checkRestoredFolders(manifest, folders) {
  const expected = manifestFolders(manifest);
  if (!expected.length) return { ok: true, skipped: true };
  const got = new Set((folders || []).map((f) => String(f).toLowerCase()));
  const want = new Set(expected.map((f) => f.toLowerCase()));
  const missing = expected.filter((f) => !got.has(f.toLowerCase()));
  const extra = (folders || []).filter((f) => !want.has(String(f).toLowerCase()));
  if (missing.length || extra.length) {
    return { ok: false, code: "TALLY_DATA_MISMATCH", missing, extra };
  }
  return { ok: true, skipped: false };
}

module.exports = {
  parseSevenZipListing,
  inspectArchiveEntries,
  manifestFolders,
  checkRestoredFolders,
  SPACE_MARGIN_BYTES,
};
