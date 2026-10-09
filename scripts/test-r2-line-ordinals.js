// R2 / X5: ordinals come from Tally's export order, per voucher + item (+ godown/batch).
const test = require("node:test");
const assert = require("node:assert/strict");
const { assignLineOrdinals } = require("../util/lineOrdinals");

test("identical lines get 0, 1, 2…; different vouchers, items or godowns start at 0", () => {
  const rows = [
    { GUID: "v1", STOCKITEMNAME: "Widget", GODOWNNAME: "Main" },
    { GUID: "v1", STOCKITEMNAME: "Widget", GODOWNNAME: "Main" },
    { GUID: "v1", STOCKITEMNAME: "Widget", GODOWNNAME: "Annex" },
    { GUID: "v2", STOCKITEMNAME: "Widget", GODOWNNAME: "Main" },
    { GUID: "v1", STOCKITEMNAME: "Bolt", GODOWNNAME: "Main" },
    { GUID: "v1", STOCKITEMNAME: "Widget", GODOWNNAME: "Main" },
  ];
  assert.deepEqual(assignLineOrdinals("StockTransaction.xml", rows).map((r) => r._LINE_ORDINAL), [0, 1, 0, 0, 0, 2]);
});

test("the same input always yields the same ordinals (replay-safe), other reports untouched", () => {
  const rows = [{ VOUCHERGUID: "v1", STOCKITEMNAME: "A", BATCHNAME: "B1" }, { VOUCHERGUID: "v1", STOCKITEMNAME: "A", BATCHNAME: "B1" }];
  assert.deepEqual(assignLineOrdinals("VoucherInventoryDetail.xml", rows), assignLineOrdinals("VoucherInventoryDetail.xml", rows));
  assert.deepEqual(assignLineOrdinals("VoucherInventoryDetail.xml", rows).map((r) => r._LINE_ORDINAL), [0, 1]);
  assert.equal(assignLineOrdinals("LedgerFull.xml", rows), rows);
});
