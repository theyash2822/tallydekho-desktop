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
    throw new TallyEncodingError(
      `Tally response is not valid UTF-8/UTF-16${declared ? ` (declared ${declared})` : ""}`,
    );
  }
}

module.exports = { decodeTallyBytes, TallyEncodingError, ENCODING_UNSUPPORTED };
