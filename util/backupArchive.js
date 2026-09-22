const fs = require("fs");

function looksLikeZipArchive(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(4);
    const read = fs.readSync(fd, header, 0, 4, 0);
    fs.closeSync(fd);
    if (read < 2) return false;
    return header[0] === 0x50 && header[1] === 0x4b;
  } catch (_) {
    return false;
  }
}

module.exports = { looksLikeZipArchive };
