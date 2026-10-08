const { XMLParser } = require("fast-xml-parser");

// Tally pads list fields with marker characters such as &#4; ("Not Applicable"). Tab, LF and CR are
// real content (multi-line addresses/narrations) and must survive.
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

const cleanTallyText = (value) =>
  typeof value === "string" ? value.replace(CONTROL_CHARS_RE, "").trim() : value;

/**
 * Values stay exact strings (HSN 04021010, pincode 0012, rate 12.10, ids like 2E5 / 0x1A) — any
 * numeric conversion belongs to the consumer. Character references (&#13;&#10;, &#8377;) are decoded
 * exactly once here; an escaped literal (&amp;#13;) stays the text "&#13;".
 */
const createTallyParser = () =>
  new XMLParser({
    ignoreAttributes: true,
    attributeNamePrefix: "",
    textNodeName: "value",
    parseTagValue: false,
    htmlEntities: true,
    trimValues: true,
    tagValueProcessor: (_name, value) => cleanTallyText(value),
  });

module.exports = { createTallyParser, cleanTallyText, CONTROL_CHARS_RE };
