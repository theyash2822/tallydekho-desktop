const iconv = require("iconv-lite");

const ENCODING_UNSUPPORTED = "TALLY_ENCODING_UNSUPPORTED";

class TallyEncodingError extends Error {
  constructor(message) {
    super(message);
    this.name = "TallyEncodingError";
    this.code = ENCODING_UNSUPPORTED;
  }
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const utf8Lenient = new TextDecoder("utf-8");

// Our templates emit `$$StrByCharCode:241` as the "empty date" marker. Tally writes it as one raw
// 0xF1 byte, which is not UTF-8; the pre-P3 decoder turned it into U+FFFD and the backend relies
// on that. Only this byte is tolerated; any other invalid sequence is still rejected.
const EMPTY_MARKER_BYTE = 0xf1;

const utf8SequenceLength = (buf, i) => {
  const b = buf[i];
  if (b < 0x80) return 1;
  const cont = (k) => i + k < buf.length && (buf[i + k] & 0xc0) === 0x80;
  if (b >= 0xc2 && b <= 0xdf) return cont(1) ? 2 : 0;
  if (b === 0xe0) return buf[i + 1] >= 0xa0 && buf[i + 1] <= 0xbf && cont(2) ? 3 : 0;
  if (b === 0xed) return buf[i + 1] >= 0x80 && buf[i + 1] <= 0x9f && cont(2) ? 3 : 0;
  if (b >= 0xe1 && b <= 0xef) return cont(1) && cont(2) ? 3 : 0;
  if (b === 0xf0) return buf[i + 1] >= 0x90 && buf[i + 1] <= 0xbf && cont(2) && cont(3) ? 4 : 0;
  if (b === 0xf4) return buf[i + 1] >= 0x80 && buf[i + 1] <= 0x8f && cont(2) && cont(3) ? 4 : 0;
  if (b >= 0xf1 && b <= 0xf3) return cont(1) && cont(2) && cont(3) ? 4 : 0;
  return 0;
};

/** Offset/value of the first invalid byte other than the empty-date marker, or null. */
const firstForeignInvalidByte = (buf, start) => {
  for (let i = start; i < buf.length;) {
    const n = utf8SequenceLength(buf, i);
    if (n) { i += n; continue; }
    if (buf[i] !== EMPTY_MARKER_BYTE) return { offset: i, byte: buf[i] };
    i += 1;
  }
  return null;
};

const decodeUtf16 = (buf, start, encoding) => {
  if ((buf.length - start) % 2 !== 0) {
    throw new TallyEncodingError(`Tally response has an odd byte count for ${encoding}`);
  }
  return iconv.decode(buf.subarray(start), encoding);
};

const declaredEncoding = (buf) => {
  const head = buf.subarray(0, 200).toString("latin1");
  const m = head.match(/^\s*<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/);
  return m ? m[1].toLowerCase() : null;
};

/**
 * Tally answers in UTF-8 or UTF-16 (LE/BE, with or without BOM). Every XML response starts with
 * "<" or whitespace, so a BOM-less UTF-16 body is identified by where the NUL byte sits in the
 * first code unit — never by a NUL-count guess. Bytes that are not valid in the identified
 * encoding (and no supported prolog declaration) are rejected instead of becoming U+FFFD.
 */
function decodeTallyBytes(data) {
  if (data == null) return "";
  if (typeof data === "string") return data;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length === 0) return "";

  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return decodeUtf16(buf, 2, "utf16-le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return decodeUtf16(buf, 2, "utf16-be");
  const utf8Start = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;

  if (!utf8Start && buf.length >= 2) {
    if (buf[0] !== 0 && buf[1] === 0) return decodeUtf16(buf, 0, "utf16-le");
    if (buf[0] === 0 && buf[1] !== 0) return decodeUtf16(buf, 0, "utf16-be");
  }

  try {
    return utf8Strict.decode(buf.subarray(utf8Start));
  } catch (_) {
    const declared = declaredEncoding(buf);
    if (declared && !/^utf-?8$/.test(declared) && iconv.encodingExists(declared)) {
      return iconv.decode(buf, declared);
    }
    const foreign = firstForeignInvalidByte(buf, utf8Start);
    if (!foreign) return utf8Lenient.decode(buf.subarray(utf8Start));
    const hex = foreign.byte.toString(16).padStart(2, "0");
    throw new TallyEncodingError(
      `Tally response is not valid UTF-8/UTF-16${declared ? ` (declared ${declared})` : ""} at byte ${foreign.offset} (0x${hex})`,
    );
  }
}

module.exports = { decodeTallyBytes, TallyEncodingError, ENCODING_UNSUPPORTED };
