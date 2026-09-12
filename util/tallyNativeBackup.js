const axios = require("axios");
const path = require("path");
const fsp = require("fs/promises");
const fs = require("fs");
const store = require("./store");
const { info } = require("./logger");

function tallyUrl() {
  const port = store.get("port") || 9000;
  return `http://localhost:${port}`;
}

function sanitizeParam(value) {
  return String(value || "").replace(/"/g, "").replace(/,/g, " ");
}

function backupCompanyXml({ dest, source, name, number }) {
  const params = [dest, source, sanitizeParam(name), sanitizeParam(number)].join(",");
  return `<?xml version="1.0"?>
<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Execute</TALLYREQUEST>
  <TYPE>TDL</TYPE>
  <ID>TDKBackupCompany</ID>
 </HEADER>
 <BODY>
  <DESC>
   <TDL>
    <TDLMESSAGE>
     <FUNCTION NAME="TDKBackupCompany">
      <ACTION>Backup Company : "," : "${params}"</ACTION>
     </FUNCTION>
    </TDLMESSAGE>
   </TDL>
  </DESC>
 </BODY>
</ENVELOPE>`;
}

async function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const entries = await fsp.readdir(cur, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

/**
 * Tally-native Backup Company (TDL action) into nativeDir.
 * Does not change Tally business XML/TDL. Fails open: caller still folder-zips.
 */
async function runTallyNativeBackup(companies, nativeDir) {
  await fsp.mkdir(nativeDir, { recursive: true });
  const results = [];
  for (const c of companies || []) {
    const companyPath = c.path;
    if (!companyPath || !fs.existsSync(companyPath)) {
      results.push({ name: c.name, ok: false, message: "Company path missing" });
      continue;
    }
    const source = path.dirname(companyPath);
    const number = c.companyNumber || c.COMPANYNUMBER || path.basename(companyPath);
    const xml = backupCompanyXml({
      dest: nativeDir,
      source,
      name: c.name,
      number,
    });
    try {
      const response = await axios.post(tallyUrl(), xml, {
        headers: { "Content-Type": "text/xml", Accept: "application/xml, text/xml, */*" },
        timeout: 120000,
      });
      const data = typeof response.data === "string" ? response.data : JSON.stringify(response.data || "");
      const failed = /<LINEERROR>/i.test(data);
      results.push({
        guid: c.guid,
        name: c.name,
        ok: !failed,
        message: failed ? (data.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/i) || [])[1] : null,
      });
    } catch (err) {
      results.push({ guid: c.guid, name: c.name, ok: false, message: err.message });
    }
  }
  const files = await listFiles(nativeDir);
  const ok = files.length > 0;
  info("[backup] tally-native", { ok, fileCount: files.length, results });
  return { ok, files, results };
}

module.exports = { runTallyNativeBackup, listFiles };
