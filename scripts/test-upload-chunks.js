const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { planChunks, groupRowsByVoucher } = require("../util/uploadChunks");

const st = (guid, n) => ({ XML: "StockTransaction.xml", GUID: guid, n });
const lt = (guid, n) => ({ XML: "LedgerTransaction.xml", Guid: guid, n });
const av = (guid) => ({ XML: "AllVoucher.xml", GUID: guid });
const rows = (chunks) => chunks.map((c) => c.map((l) => JSON.parse(l)));

test("a voucher's stock / ledger lines never straddle two chunks", () => {
  const items = [st("A", 1), st("A", 2), st("B", 1), st("B", 2), st("B", 3), lt("C", 1), lt("C", 2)];
  const chunks = rows([...planChunks(items, { maxItems: 3, maxBytes: 1e9 })]);
  for (const key of ["StockTransaction.xml|A", "StockTransaction.xml|B", "LedgerTransaction.xml|C"]) {
    const holders = chunks.filter((c) => c.some((r) => `${r.XML}|${r.GUID || r.Guid}` === key));
    assert.equal(holders.length, 1, key);
  }
  assert.equal(chunks.flat().length, items.length);
});

test("byte limit also cuts only between vouchers; an oversized voucher is sent whole", () => {
  const big = Array.from({ length: 5 }, (_, i) => st("BIG", i));
  const items = [st("A", 1), ...big, st("Z", 1)];
  const one = Buffer.byteLength(JSON.stringify(st("A", 1))) + 1;
  const chunks = rows([...planChunks(items, { maxItems: 1000, maxBytes: one * 2 })]);
  assert.deepEqual(chunks.map((c) => c.length), [1, 5, 1]);
});

test("scattered rows of one voucher are pulled together; other rows keep their order", () => {
  const items = [st("A", 1), av("X"), st("B", 1), st("A", 2), av("Y")];
  assert.deepEqual(groupRowsByVoucher(items), [[st("A", 1), st("A", 2)], [av("X")], [st("B", 1)], [av("Y")]]);
  const sameGuidOtherXml = [av("A"), av("A")];
  assert.equal(groupRowsByVoucher(sameGuidOtherXml).length, 2, "only per-voucher-replaced collections are grouped");
});

test("item limit still respected for ordinary rows", () => {
  const items = Array.from({ length: 7 }, (_, i) => av(String(i)));
  assert.deepEqual([...planChunks(items, { maxItems: 3, maxBytes: 1e9 })].map((c) => c.length), [3, 3, 1]);
  assert.deepEqual([...planChunks([], { maxItems: 3, maxBytes: 1e9 })], []);
});

test("sendChunks uses the voucher-aware planner", () => {
  const src = fs.readFileSync(path.join(__dirname, "../util/xml.js"), "utf8");
  assert.match(src, /for \(const lines of planChunks\(items, \{ maxItems: chunkItems, maxBytes: maxChunkBytes \}\)\)/);
  assert.doesNotMatch(src, /function\* chunkArray/);
});
