/**
 * R2 / X5: Tally allows the same item (and godown/batch) on several lines of one voucher.
 * Each line gets its position among identical lines of its voucher, in Tally's export
 * order, before the rows are chunked — so a voucher split across chunks, or a replayed
 * chunk, always yields the same ordinals and the server stores each line exactly once.
 */
const s = (v) => (v == null ? "" : String(v));

const KEYS = {
  "StockTransaction.xml": (r) => [s(r.GUID || r.Guid), s(r.STOCKITEMNAME || r.StockItemName), s(r.GODOWNNAME || r.GodownName)],
  "VoucherInventoryDetail.xml": (r) => [
    s(r.VOUCHERGUID || r.VoucherGuid || r.GUID),
    s(r.STOCKITEMNAME || r.StockItemName),
    s(r.GODOWNNAME || r.GodownName),
    s(r.BATCHNAME || r.BatchName),
  ],
};

function assignLineOrdinals(xml, rows) {
  const keyOf = KEYS[xml];
  if (!keyOf || !Array.isArray(rows)) return rows;
  const seen = new Map();
  return rows.map((r) => {
    const key = JSON.stringify(keyOf(r));
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    return { ...r, _LINE_ORDINAL: n };
  });
}

module.exports = { assignLineOrdinals };
