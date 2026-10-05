// The backend replaces these collections per voucher (DELETE by voucher GUID, then INSERT)
// in each chunk, so one voucher's rows must never be split across two chunks.
const PER_VOUCHER_XMLS = new Set(["StockTransaction.xml", "LedgerTransaction.xml"]);

function voucherGroupKey(row) {
  if (!PER_VOUCHER_XMLS.has(row?.XML)) return null;
  const guid = row.GUID || row.Guid;
  return guid ? `${row.XML}\u0000${guid}` : null;
}

/** Rows grouped so each voucher's per-voucher rows sit together (first-occurrence order kept). */
function groupRowsByVoucher(items) {
  const groups = [];
  const byKey = new Map();
  for (const row of items) {
    const key = voucherGroupKey(row);
    if (key == null) {
      groups.push([row]);
    } else if (byKey.has(key)) {
      byKey.get(key).push(row);
    } else {
      const g = [row];
      byKey.set(key, g);
      groups.push(g);
    }
  }
  return groups;
}

/**
 * Yields NDJSON line arrays of at most maxItems rows / maxBytes, cutting only between
 * groups. A single group larger than the limits is sent whole.
 */
function* planChunks(items, { maxItems, maxBytes }) {
  let lines = [];
  let bytes = 0;
  for (const group of groupRowsByVoucher(items)) {
    const groupLines = group.map((x) => JSON.stringify(x));
    const groupBytes = groupLines.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
    if (lines.length && (lines.length + groupLines.length > maxItems || bytes + groupBytes > maxBytes)) {
      yield lines;
      lines = [];
      bytes = 0;
    }
    for (const l of groupLines) lines.push(l);
    bytes += groupBytes;
  }
  if (lines.length) yield lines;
}

module.exports = { planChunks, groupRowsByVoucher, PER_VOUCHER_XMLS };
