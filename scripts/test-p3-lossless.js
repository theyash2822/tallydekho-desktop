// P3 field/encoding contract: exact text values, references decoded once, deterministic decoding.
const test = require("node:test");
const assert = require("node:assert/strict");
const iconv = require("iconv-lite");

const { createTallyParser, cleanTallyText } = require("../util/tallyXmlParser");
const { decodeTallyBytes, TallyEncodingError } = require("../util/tallyDecode");
const { normalizeEnvelope } = require("../util/tallyHelper");

const parser = createTallyParser();

const ledgerXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <NAME>राम &amp; Sons ₹</NAME>
  <HSN>04021010</HSN>
  <PINCODE>0012</PINCODE>
  <RATE>12.10</RATE>
  <CODE>2E5</CODE>
  <HEX>0x1A</HEX>
  <ALTERID>9007199254740993</ALTERID>
  <PHONE>09876543210</PHONE>
  <ADDRESS>Line 1&#13;&#10;Line 2&#9;Tab</ADDRESS>
  <SYMBOL>&#8377; &#x20B9;</SYMBOL>
  <LITERAL>&amp;#13; stays literal</LITERAL>
  <MARKER>&#4; Not Applicable</MARKER>
  <FLAG>true</FLAG>
</ENVELOPE>`;

test("identifier-like values stay exact strings", () => {
  const row = normalizeEnvelope(parser.parse(ledgerXml).ENVELOPE)[0];
  assert.equal(row.HSN, "04021010");
  assert.equal(row.PINCODE, "0012");
  assert.equal(row.RATE, "12.10");
  assert.equal(row.CODE, "2E5");
  assert.equal(row.HEX, "0x1A");
  assert.equal(row.ALTERID, "9007199254740993");
  assert.equal(row.PHONE, "09876543210");
  assert.equal(row.FLAG, "true");
});

test("character references are decoded once; Hindi, rupee, newline and tab survive", () => {
  const row = normalizeEnvelope(parser.parse(ledgerXml).ENVELOPE)[0];
  assert.equal(row.NAME, "राम & Sons ₹");
  assert.equal(row.ADDRESS, "Line 1\r\nLine 2\tTab");
  assert.equal(row.SYMBOL, "₹ ₹");
  assert.equal(row.LITERAL, "&#13; stays literal");
  assert.equal(row.MARKER, "Not Applicable");
});

test("sibling list values stay distinct per row", () => {
  const xml = `<ENVELOPE><NAME>A&#13;&#10;1</NAME><NAME>B</NAME><GSTIN>27AAAAA0000A1Z5</GSTIN><GSTIN></GSTIN></ENVELOPE>`;
  const rows = normalizeEnvelope(parser.parse(xml).ENVELOPE);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].NAME, "A\r\n1");
  assert.equal(rows[1].NAME, "B");
  assert.equal(rows[0].GSTIN, "27AAAAA0000A1Z5");
  assert.equal(rows[1].GSTIN, "");
});

test("cleanTallyText strips control markers only", () => {
  assert.equal(cleanTallyText("\u0004 x\r\ny\t"), "x\r\ny");
  assert.equal(cleanTallyText(42), 42);
});

const sample = `<ENVELOPE><NAME>राम ₹ &amp; Co</NAME></ENVELOPE>`;

test("decoder: UTF-8 with and without BOM", () => {
  assert.equal(decodeTallyBytes(Buffer.from(sample, "utf8")), sample);
  assert.equal(decodeTallyBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(sample)])), sample);
});

test("decoder: UTF-16 LE/BE with BOM and BOM-less, including short bodies", () => {
  assert.equal(decodeTallyBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(sample, "utf16-le")])), sample);
  assert.equal(decodeTallyBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(sample, "utf16-be")])), sample);
  assert.equal(decodeTallyBytes(iconv.encode(sample, "utf16-le")), sample);
  assert.equal(decodeTallyBytes(iconv.encode(sample, "utf16-be")), sample);
  assert.equal(decodeTallyBytes(iconv.encode("<A/>", "utf16-le")), "<A/>");
  assert.equal(decodeTallyBytes(Buffer.from([0xff, 0xfe])), "");
});

test("decoder: invalid bytes fail explicitly instead of becoming replacement characters", () => {
  const bad = Buffer.concat([Buffer.from("<ENVELOPE><N>"), Buffer.from([0xc3, 0x28]), Buffer.from("</N></ENVELOPE>")]);
  assert.throws(() => decodeTallyBytes(bad), (e) => e instanceof TallyEncodingError && e.code === "TALLY_ENCODING_UNSUPPORTED");
  const odd = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([0x3c, 0x00, 0x41])]);
  assert.throws(() => decodeTallyBytes(odd), TallyEncodingError);
});

test("decoder: the $$StrByCharCode:241 empty-date byte decodes as before; other bad bytes still fail with offset", () => {
  const row = (date) => Buffer.concat([Buffer.from("<R><N>मिठाई ₹ 0042</N><ManfDate>"), date, Buffer.from("</ManfDate></R>")]);
  const body = Buffer.concat([row(Buffer.from([0xf1])), row(Buffer.from("2024-04-01")), row(Buffer.from([0xf1]))]);
  const out = decodeTallyBytes(body);
  assert.equal(out, body.toString("utf8"), "same result as the pre-P3 decoder");
  assert.equal(out.split("\uFFFD").length - 1, 2);
  assert.match(out, /<N>मिठाई ₹ 0042<\/N><ManfDate>2024-04-01</);
  const bad = Buffer.concat([row(Buffer.from([0xf1])), Buffer.from([0x92])]);
  assert.throws(() => decodeTallyBytes(bad), (e) => e instanceof TallyEncodingError && /at byte \d+ \(0x92\)/.test(e.message));
});

test("decoder: a declared single-byte encoding is honoured", () => {
  const body = Buffer.concat([
    Buffer.from(`<?xml version="1.0" encoding="windows-1252"?><N>caf`),
    Buffer.from([0xe9]),
    Buffer.from("</N>"),
  ]);
  assert.match(decodeTallyBytes(body), /<N>café<\/N>/);
});

test("decoder: empty and string inputs", () => {
  assert.equal(decodeTallyBytes(Buffer.alloc(0)), "");
  assert.equal(decodeTallyBytes("<A/>"), "<A/>");
  assert.equal(decodeTallyBytes(null), "");
});
