const test = require("node:test");
const assert = require("node:assert/strict");
const { runTallyExclusive, xmlText } = require("../util/tallyQueue");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("Tally requests for different companies never overlap", async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];
  const request = (company, ms) => runTallyExclusive(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${company}`);
    await sleep(ms);
    order.push(`end:${company}`);
    active--;
    return company;
  });

  const results = await Promise.all([request("A", 30), request("B", 5), request("C", 10)]);
  assert.equal(maxActive, 1);
  assert.deepEqual(results, ["A", "B", "C"]);
  assert.deepEqual(order, ["start:A", "end:A", "start:B", "end:B", "start:C", "end:C"]);
});

test("a failed request does not block the queue", async () => {
  await assert.rejects(runTallyExclusive(async () => { throw new Error("timeout"); }));
  assert.equal(await runTallyExclusive(async () => "next"), "next");
});

test("company names are XML-escaped for SVCURRENTCOMPANY", () => {
  assert.equal(xmlText("Shah & Sons <Pune>"), "Shah &amp; Sons &lt;Pune&gt;");
  assert.equal(xmlText("Plain Co"), "Plain Co");
  assert.equal(xmlText(20250401), "20250401");
});
