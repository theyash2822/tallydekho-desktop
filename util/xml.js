const { createTallyParser } = require("./tallyXmlParser");
const { decodeTallyBytes, TallyEncodingError } = require("./tallyDecode");
const { yearsFromCompanyNodes, planFiscalScope, applyPlannedYears } = require("./fiscalPlanner");
const { getSelectedCompanies, setSelectedCompanies } = require("./companySelection");
const path = require("path");
const { readFile } = require("fs").promises;
const axios = require("axios");
const { error, info } = require("./logger");
const store = require("./store");
const { normalizeEnvelope } = require("./tallyHelper");
const { axiosInstance } = require("./helper");
const { installTdlFiles } = require("./tdlFiles");
const {
  BILL_STATUS,
  rowsFromBillOutstandingEnvelope,
  fetchCompanyBillSnapshot,
  snapshotSummary,
} = require("./billSnapshot");
const { checkTdlHealth, looksLikeCompanyNotOpen } = require("./tdlHealth");
const { planChunks } = require("./uploadChunks");
const { runTallyExclusive, xmlText } = require("./tallyQueue");
const { coordinator } = require("./jobCoordinator");
const { toDiscoveredCompany, buildDiscovery } = require("./companyDiscovery");
const {
  checkVoucherListResponse,
  buildVoucherListSummary,
  buildVoucherWatermarks,
  trailingCheckYears,
  voucherListLog,
} = require("./voucherList");

const decodeTallyResponse = decodeTallyBytes;

/** Counts only — the full sync state (every company / FY alter id) is too large and too revealing for logs. */
function summarizeSyncState(res) {
  const d = res?.data || {};
  return {
    status: res?.status,
    message: res?.message,
    companies: Object.keys(d.alterIds || {}).length,
    yearIds: Object.keys(d.yearIds || {}).length,
  };
}

/** Stop reason of the job this code runs in (cancel request or failed source read). */
const jobStopCode = () => coordinator.current()?.stopCode() || null;
const jobCancelled = () => !!coordinator.current()?.isCancelled();
const jobSignal = () => coordinator.current()?.signal;
const CANCELLED_RESULT = () => ({
  status: false,
  code: "cancelled",
  cancelled: true,
  global: true,
  message: "Sync stopped before upload finished.",
});
const AUTH_CODES = new Set(["DEVICE_NOT_PAIRED", "BINDING_REVOKED", "UNAUTHORIZED", "DEVICE_REVOKED"]);
/** Failures that make every remaining company fail the same way. */
const isGlobalUploadFailure = (err) => {
  const httpStatus = err?.response?.status;
  return !err?.response || httpStatus === 401 || httpStatus === 403 || AUTH_CODES.has(err?.response?.data?.code);
};

const parser = createTallyParser();

async function uploadLargeArray({
  records,
  master,
  vouchers,
  chunkItems = 10_000,
  maxChunkBytes = 10 * 1024 * 1024,
  // completeBatchSize = 1000,
  // gzip = false,
  extras = {},
  companyGuid = null,
  billSnapshotMode = null,
  sendMessage,
}) {
  const gzip = false;

  info("[sync] size", {
    companyGuid,
    records: records.length,
    master: master.length,
    vouchers: vouchers.length,
  });

  if (jobCancelled()) return CANCELLED_RESULT();
  sendMessage("Uploading Data");

  // Retry init up to 3x with backoff (backend may be briefly unavailable)
  let initRes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      initRes = (await axiosInstance.post("/ingest/init", {}, { timeout: 15_000, signal: jobSignal() })).data;
      break;
    } catch (err) {
      if (jobCancelled()) return CANCELLED_RESULT();
      info("[sync] init attempt failed", { attempt, message: err?.message });
      if (attempt === 3) {
        return {
          status: false,
          global: isGlobalUploadFailure(err),
          code: err?.response?.data?.code,
          message: err?.response?.data?.message || "Backend unreachable. Sync paused — retry when backend is available.",
        };
      }
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }

  info("[sync] ingest init", initRes);

  const uploadId = initRes.data.uploadId;

  if (initRes.data.maxChunkBytes) maxChunkBytes = initRes.data.maxChunkBytes;

  const recordsResponse = await sendChunks({
    client: axiosInstance,
    items: records,
    maxChunkBytes,
    uploadId,
    gzip,
    streamName: "records",
    chunkItems,
    companyGuid,
    billSnapshotMode,
  });

  info("[sync] ingest init [records]", recordsResponse);

  if (!recordsResponse.status) {
    return recordsResponse;
  }

  const masterResponse = await sendChunks({
    client: axiosInstance,
    items: master,
    maxChunkBytes,
    uploadId,
    gzip,
    streamName: "master",
    chunkItems,
    companyGuid,
    billSnapshotMode,
  });

  info("[sync] ingest init [master]", masterResponse);

  if (!masterResponse.status) {
    return masterResponse;
  }

  const vouchersResponse = await sendChunks({
    client: axiosInstance,
    items: vouchers,
    maxChunkBytes,
    uploadId,
    gzip,
    streamName: "vouchers",
    chunkItems,
    companyGuid,
    billSnapshotMode,
  });

  info("[sync] ingest init [voucher]", vouchersResponse);

  if (!vouchersResponse.status) {
    return vouchersResponse;
  }

  const { voucherLists, ...logExtras } = extras;
  info("[sync] ingest complete body", {
    uploadId,
    ...logExtras,
    ...(voucherLists ? { voucherLists: voucherLists.map(voucherListLog) } : {}),
  });
  // Last point where Stop is honoured: once /ingest/complete is sent the server may commit,
  // so that request is never aborted.
  if (jobCancelled()) return CANCELLED_RESULT();
  sendMessage("Processing Data");

  // Retry complete up to 3x (all data uploaded — just need to confirm)
  let completeRes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      completeRes = (await axiosInstance.post("/ingest/complete", { uploadId, ...extras }, { timeout: COMPLETE_TIMEOUT_MS })).data;
      break;
    } catch (err) {
      info("[sync] complete attempt failed", { attempt, message: err?.message });
      // No answer within the deadline: the server may still be committing. Re-sending
      // complete could run it twice, so report the outcome as unknown instead.
      if (err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT") {
        return {
          status: false,
          global: true,
          code: "COMPLETE_OUTCOME_UNKNOWN",
          message: "The server did not confirm this sync in time. It may still finish; check the last sync time before syncing again.",
        };
      }
      if (attempt === 3) {
        return {
          status: false,
          global: isGlobalUploadFailure(err),
          code: err?.response?.data?.code,
          message: err?.response?.data?.message || "Could not complete sync. Will retry on next sync.",
          data: err?.response?.data?.data,
        };
      }
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }

  // sendMessage("Data Synced");

  info(`[sync] API response`, completeRes);

  return {
    status: true,
    uploadId,
  };
}

async function sendChunks({
  client,
  items,
  maxChunkBytes,
  uploadId,
  gzip,
  streamName,
  chunkItems,
  companyGuid = null,
  billSnapshotMode = null,
}) {
  let chunkIndex = 0;

  for (const lines of planChunks(items, { maxItems: chunkItems, maxBytes: maxChunkBytes })) {
    if (jobCancelled()) return CANCELLED_RESULT();
    const payload = Buffer.from(lines.join("\n") + "\n", "utf8");
    const response = await sendOneChunk(
      client,
      uploadId,
      streamName,
      chunkIndex++,
      payload,
      gzip,
      companyGuid,
      billSnapshotMode
    );
    if (!response.status) {
      return response;
    }
  }

  return { status: true };
}

const CHUNK_TIMEOUT_MS = 120_000;
const COMPLETE_TIMEOUT_MS = 10 * 60_000;
// Server will refuse these the same way every time.
const NON_RETRYABLE_CHUNK_CODES = new Set([
  "NDJSON_INVALID",
  "CHUNK_TOO_LARGE",
  "CHUNK_CONTENT_CONFLICT",
  "UPLOAD_OWNERSHIP_DENIED",
  "COMPANY_GUID_REQUIRED",
]);

async function sendOneChunk(client, uploadId, streamName, idx, body, gzip, companyGuid = null, billSnapshotMode = null) {
  const headers = {
    "Upload-Id": uploadId,
    "Stream-Name": streamName,
    "Chunk-Index": String(idx),
    "Content-Type": "application/x-ndjson",
  };
  if (companyGuid) headers["Company-Guid"] = companyGuid;
  // Staged: bill rows wait on the backend until /ingest/complete confirms the snapshot.
  if (billSnapshotMode) headers["Bill-Snapshot-Mode"] = billSnapshotMode;
  if (gzip) headers["Content-Encoding"] = "gzip";

  // retry 3 times with small backoff; the server acknowledges an identical replay without re-applying it
  let attempt = 0;
  while (true) {
    try {
      await client.post("/ingest/chunk", body, { headers, signal: jobSignal(), timeout: CHUNK_TIMEOUT_MS });
      info(`[sync] Chunks`, { attempt, idx });

      return { status: true };
    } catch (e) {
      if (jobCancelled()) return CANCELLED_RESULT();
      const code = e?.response?.data?.code;
      const retryable = !NON_RETRYABLE_CHUNK_CODES.has(code) && e?.response?.status !== 401 && e?.response?.status !== 403;
      if (!retryable || ++attempt >= 3) {
        return {
          status: false,
          global: isGlobalUploadFailure(e),
          code: e?.response?.data?.code,
          message: e?.response?.data?.message || e?.message,
        };
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

const initSync = async (companies, isHardSync = false) => {
  let response;

  try {
    // isHardSync → backend purges selected company GUID tally data, then rebuilds via ingest
    response = await axiosInstance.post("/desktop/init-sync", {
      companies,
      isHardSync: !!isHardSync,
      // We send voucherWatermarks and fetch opening balances / stock items in full.
      watermarkSync: true,
    }, { timeout: 10 * 60_000 });
    response = response.data;
  } catch (err) {
    info("[sync] data error", err);
    return { status: false, message: err?.response?.data?.message };
  }

  return response;
};

function createTallySyncProgressSender(webContents) {
  return (percent) => {
    if (!webContents?.isDestroyed()) {
      webContents.send("tally:sync_progress", {
        percent: Math.min(100, Math.max(0, Math.round(percent))),
      });
    }
  };
}

function tallySyncMessageSender(webContents) {
  return (message) => {
    if (!webContents?.isDestroyed()) {
      webContents.send("window:listener", {
        key: "syncMessage",
        value: message,
      });
    }
  };
}

const tallyUrl = () => {
  const port = store.get("port") || 9000; // Default Tally port is 9000
  return `http://localhost:${port}`;
};

let totalVouchers = 0;

const getData = async (filePath, replacer = []) => {
  const TALLY_URL = tallyUrl();

  const xmlPath = path.join(__dirname, "..", "xmls", filePath);

  let xml = await readFile(xmlPath, "utf8");

  // Function replacers: a string replacement would expand `$&` / `$'` inside company names.
  replacer.forEach((item) => {
    const { key, value } = item;
    const text = xmlText(value);
    xml = xml.replace(key, () => text);
  });

  // SAFETY: Force SVCURRENTCOMPANY to always use the real company name.
  // This fixes any XML files that have hardcoded placeholder names
  // (e.g. 'Test Company Data', 'Demo2') from development/testing.
  const companyNameVal = replacer.find(r => r.key === '$$COMPANY_NAME')?.value;
  if (companyNameVal) {
    const companyTag = `<SVCURRENTCOMPANY>${xmlText(companyNameVal)}</SVCURRENTCOMPANY>`;
    xml = xml.replace(/<SVCURRENTCOMPANY>[^<]*<\/SVCURRENTCOMPANY>/g, () => companyTag);
  }

  // A failure marks only the job this request belongs to; a status probe or company
  // discovery running outside any job can never stop a sync.
  const job = coordinator.current();
  let attempt = 0;
  while (true) {
    if (job?.isCancelled()) return { status: false, data: null, message: "cancelled", cancelled: true };
    try {
      const response = await runTallyExclusive(() => axios.post(TALLY_URL, xml, {
        headers: {
          "Content-Type": "text/xml",
          Accept: "application/xml, text/xml, */*",
        },
        responseType: "arraybuffer",
        timeout: 15000 * 4,
        signal: job?.signal,
      }));
      const decoded = decodeTallyResponse(response.data);
      return { status: true, data: decoded, message: "" };
    } catch (err) {
      if (job?.isCancelled()) return { status: false, data: null, message: "cancelled", cancelled: true };
      if (err instanceof TallyEncodingError) {
        error(err.message, filePath);
        job?.recordSourceFailure("tally_encoding_unsupported");
        return { status: false, data: null, message: err.message, code: err.code };
      }
      error(err?.message, filePath);
      if (++attempt >= 3 || filePath == "TallyDestination.xml") {
        job?.recordSourceFailure("tally_timeout");
        return { status: false, data: null, message: err?.message };
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
};

// postToTally - send a write XML directly to Tally's HTTP port
// Used for data entry: create vouchers, masters etc.
const postToTally = async (xmlBody) => {
  const TALLY_URL = tallyUrl();
  let attempt = 0;
  while (true) {
    try {
      const response = await runTallyExclusive(() => axios.post(TALLY_URL, xmlBody, {
        headers: {
          "Content-Type": "text/xml",
          Accept: "application/xml, text/xml, */*",
        },
        timeout: 15000,
      }));
      const data = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || '');

      // Parse Tally XML response properly
      // Tally returns LINEERROR on failure, empty BODY or CREATED on success
      const hasLineError = data.includes('LINEERROR') || data.includes('<LINEERROR>');
      // hasCancelled: IMPORTRESULT contains <CANCELLED>N</CANCELLED> where N > 0.
      // CANCELLED=0 is normal in every successful IMPORTRESULT — must NOT treat as failure.
      // Also skip if ISCANCELLED is present (voucher-level field, not import result).
      const cancelledMatch = data.match(/<CANCELLED>(\d+)<\/CANCELLED>/i);
      const hasCancelled = cancelledMatch ? parseInt(cancelledMatch[1]) > 0 : false;
      const hasImportResult = data.includes('IMPORTRESULT') || data.includes('CREATED') || data.includes('ALTERED');

      // Metadata only — a Tally response body carries voucher amounts, party
      // names and GST details and must never reach a persistent log.
      info('[tally:write] response', {
        url: TALLY_URL,
        length: data.length,
        hasLineError,
        hasCancelled,
        hasImportResult,
      });

      if (hasLineError) {
        // Extract error message from XML
        const match = data.match(/<LINEERROR>(.*?)<\/LINEERROR>/s);
        const errMsg = match ? match[1].trim() : 'Tally validation error';
        return { status: false, message: errMsg, data };
      }

      if (hasCancelled) {
        return { status: false, message: 'Tally cancelled the operation', data };
      }

      // Success: parse internal IDs from response
      const createdMatch  = data.match(/<CREATED>(\d+)<\/CREATED>/i);
      const alteredMatch  = data.match(/<ALTERED>(\d+)<\/ALTERED>/i);
      const exceptionsMatch = data.match(/<EXCEPTIONS>(\d+)<\/EXCEPTIONS>/i);
      const lastVchMatch  = data.match(/<LASTVCHID>(.*?)<\/LASTVCHID>/i);
      const vchNumMatch   = data.match(/<VOUCHERNUMBER>(.*?)<\/VOUCHERNUMBER>/i);
      const created       = createdMatch  ? parseInt(createdMatch[1], 10)  : 0;
      const altered       = alteredMatch  ? parseInt(alteredMatch[1], 10)  : 0;
      const exceptions    = exceptionsMatch ? parseInt(exceptionsMatch[1], 10) : 0;
      const tallyIdRaw    = lastVchMatch  ? lastVchMatch[1].trim()     : null;
      const tallyId       = (tallyIdRaw && tallyIdRaw !== '0') ? tallyIdRaw : null;
      const voucherNumber = vchNumMatch   ? vchNumMatch[1].trim()      : null;

      // Tally often returns HTTP 200 with CREATED=0 + EXCEPTIONS>0 and NO <LINEERROR>.
      // That must NOT be treated as success (false "Posted" in audit trail).
      if (created === 0 && altered === 0) {
        const excMatch = data.match(/<EXCEPTIONS\.LIST>[\s\S]*?<DESC>([\s\S]*?)<\/DESC>/i)
          || data.match(/<ERRORDESCRIPTION>([\s\S]*?)<\/ERRORDESCRIPTION>/i);
        const excMsg = excMatch ? excMatch[1].replace(/<[^>]+>/g, '').trim() : '';
        const msg = excMsg
          || (exceptions > 0
            ? `Tally rejected the entry (${exceptions} exception${exceptions > 1 ? 's' : ''})`
            : 'Tally did not create the voucher (CREATED=0)');
        // `msg` is Tally's own error description; the response body is not logged.
        info('[tally:write] treated as failure', { created, altered, exceptions, tallyIdRaw, reason: msg });
        return { status: false, message: msg, data, created, altered, exceptions, tallyId: null, voucherNumber: null };
      }

      return { status: true, message: 'Entry created in Tally', data, tallyId, voucherNumber, created, altered, exceptions };
    } catch (err) {
      error(err?.message, 'postToTally');
      if (++attempt >= 2) {
        return {
          status: false,
          message: err?.code === 'ECONNREFUSED'
            ? `Cannot connect to Tally at ${tallyUrl()}. Is Tally Prime running?`
            : err?.message || 'Tally not reachable',
        };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
};

module.exports.postToTally = postToTally;

const getCompanyDestinations = async () => {
  const response = await getData("TallyDestination.xml");

  if (!response.status) {
    return {};
  }

  const json = parser.parse(response.data);
  const companiesNode = json?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY ?? []; // could be an object or array depending on count

  const companies = Array.isArray(companiesNode)
    ? companiesNode
    : [companiesNode].filter(Boolean);

  const destMap = {};
  for (const c of companies) {
    const name = c?.["NAME"] || null;
    const destination = c?.DESTINATION || null;
    if (name && destination) destMap[name] = destination;
  }
  return destMap;
};

// A full SimplifiedLedger export per company used to run on every 5-second poll.
// Counts are display-only, so they refresh in the background at most this often.
const LEDGER_COUNT_TTL_MS = 10 * 60 * 1000;
const ledgerCountCache = new Map();
let ledgerRefreshRunning = false;

const refreshLedgerCounts = async (companies) => {
  if (ledgerRefreshRunning) return;
  ledgerRefreshRunning = true;
  try {
    for (const c of companies) {
      if (coordinator.isActive(["sync", "hard_sync", "restore", "tally_restart"])) return;
      const cached = ledgerCountCache.get(c.guid);
      if (cached && Date.now() - cached.at < LEDGER_COUNT_TTL_MS) continue;
      const response = await getData("SimplifiedLedger.xml", [{ key: "$$COMPANY_NAME", value: c.name }]);
      if (!response.status) continue;
      try {
        const rows = normalizeEnvelope(parser.parse(response.data).ENVELOPE);
        ledgerCountCache.set(c.guid, { count: rows.length, at: Date.now() });
      } catch (_) { /* keep the previous count */ }
    }
  } finally {
    ledgerRefreshRunning = false;
  }
};

const cachedLedgerCount = (guid) => ledgerCountCache.get(guid)?.count ?? null;

/**
 * Typed discovery result. `status: "ok"` is the only positive evidence about which
 * companies are open; anything else means "unknown" and must not change the selection.
 */
const discoverCompanies = async () => {
  const observedAt = new Date().toISOString();
  const response = await getData("Companies.xml");
  if (!response.status) {
    return { status: "unavailable", reason: "tally_request_failed", observedAt, companies: [] };
  }
  let list;
  try {
    const node = parser.parse(response.data)?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY ?? [];
    list = Array.isArray(node) ? node : [node].filter(Boolean);
  } catch (_) {
    return { status: "unavailable", reason: "parse_failed", observedAt, companies: [] };
  }
  const currentCompany = await getCurrentCompany();
  const result = buildDiscovery(list, currentCompany?.GUID, { observedAt, ledgerCountFor: cachedLedgerCount });
  refreshLedgerCounts(result.companies).catch(() => {});
  return result;
};

/** Legacy array shape (empty on failure); prefer discoverCompanies(). */
const getCompanies = async () => {
  const result = await discoverCompanies();
  return result.companies;
};

const getCompaniesGSTNumber = async (companies = []) => {
  let promises = [];

  for (let i = 0; i < companies.length; i++) {
    const response = getData("CompanyGST.xml", [
      {
        key: "$$COMPANY_NAME",
        value: companies[i],
      },
    ]);

    promises.push(response);
  }

  try {
    promises = await Promise.all(promises);
  } catch (err) {
    return {};
  }

  const companiesWithGst = {};

  for (let i = 0; i < promises.length; i++) {
    const response = promises[i];
    const json = parser.parse(response.data);
    const taxUnitNode = json?.ENVELOPE?.BODY?.DATA?.COLLECTION?.TAXUNIT ?? [];

    const taxUnits = Array.isArray(taxUnitNode)
      ? taxUnitNode
      : [taxUnitNode].filter(Boolean);

    const gstNumber = taxUnits.reduce((acc, cv) => {
      if (cv.GSTREGNUMBER && !acc) {
        acc = cv.GSTREGNUMBER;
      }
      return acc;
    }, "");

    companiesWithGst[companies[i]] = gstNumber;
  }

  // console.log(companiesWithGst);
};

const getCurrentCompany = async () => {
  const response = await getData("CurrentCompany.xml");

  if (!response.status) {
    return {};
  }

  const json = parser.parse(response.data);
  const company = json?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY ?? {};

  return company;
  //GUID
};

// Maps XML filename → explicit recordType tag (V2 spec: explicit routing, no field-signature guessing)
const XML_RECORD_TYPE = {
  'AllVoucher.xml':              'voucher',
  'LedgerFull.xml':              'ledger',
  'FullLedger.xml':              'ledger',
  'LedgerTransaction.xml':       'ledger_transaction',
  'StockItemFull.xml':           'stock',
  'StockTransaction.xml':        'stock_transaction',
  'GroupMaster.xml':             'group',
  'VoucherInventoryDetail.xml':  'voucher_inventory',
  'GSTDetails.xml':              'gst_detail',
  'BillOutstanding.xml':         'bill_outstanding',
  'LedgerOpeningBalance.xml':    'ledger_opening_balance',
  'Godown.xml':                  'warehouse',
  'UnitFull.xml':                'unit',
  'VoucherTypeFull.xml':         'voucher_type',
  'CurrencyMaster.xml':          'currency',
  'StockGroupFull.xml':          'stock_group',
  'StockOpeningBalance.xml':     'stock_opening_balance',
  'StockValuation.xml':          'stock_valuation',
  'StockFYBalance.xml':           'stock_fy_balance',
  'OpeningBalanceDiff.xml':       'opening_balance_diff',
  'StockCategory.xml':           'stock_category',
  'CostCategory.xml':            'cost_category',
  'CostCentre.xml':              'cost_centre',
  'Master.xml':                  'master_catalog',
  'SimplifiedVoucher.xml':       'voucher_stub',
};

// Compute financial year label from YYYYMMDD fromDate
// e.g. "20250401" -> "2025-2026"
function computeFinancialYear(fromDate) {
  if (!fromDate || String(fromDate).length < 4) return null;
  const year = parseInt(String(fromDate).slice(0, 4), 10);
  return `${year}-${year + 1}`;
}

const syncHelper = async ({ xml, companyName, alterId, companyGuid }) => {
  const response = await getData(xml, [
    {
      key: "$$COMPANY_NAME",
      value: companyName,
    },
    {
      key: "$$ALTER_ID",
      value: alterId,
    },
  ]);

  if (!response.status) {
    return [];
  }

  const json = parser.parse(response.data);

  // const fieldMap = {
  //   ALTERID: (v) => (v == null ? null : Number(v)),
  //   ALLOCATEREVENUE: (v) => Number(v) === 1,
  //   ALLOCATENONREVENUE: (v) => Number(v) === 1,
  // };

  //   normalizeEnvelope(
  //     json.ENVELOPE
  //     // { map: fieldMap }
  //   )[0]
  // );

  return normalizeEnvelope(json.ENVELOPE).map((item) => ({
    ...item,
    COMPANY_NAME:    companyName,
    XML:             xml,
    COMPANY_GUID:    companyGuid,
    _RECORD_TYPE:    XML_RECORD_TYPE[xml] || 'unknown',
    _FINANCIAL_YEAR: null,
  }));
};

/** Machine date as YYYYMMDD in local time (Tally's date, not UTC). */
function localYmd(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function decorateRows(rows, { xml, companyName, fromDate, toDate, companyGuid, yearId, fiscal }) {
  const financialYear = computeFinancialYear(fromDate);
  return rows.map((item) => ({
    ...item,
    COMPANY_NAME:    companyName,
    XML:             xml,
    FROM_DATE:       fromDate,
    TO_DATE:         toDate,
    COMPANY_GUID:    companyGuid,
    YEAR_ID:         yearId,
    _RECORD_TYPE:    XML_RECORD_TYPE[xml] || 'unknown',
    _FINANCIAL_YEAR: financialYear,
    ...(fiscal || {}),
  }));
}

/** Explicit per-row scope for point-in-time balances; the query date alone does not identify the FY. */
const stockBalanceFiscal = (year, role, balanceDate) => ({
  _FINANCIAL_YEAR: year.finYear,
  FY_BEGIN: year.begin,
  FY_END: year.end,
  BALANCE_DATE: balanceDate,
  BALANCE_ROLE: role,
});

const TALLY_GUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-[0-9a-f]+/gi;
const hasForeignTallyGuid = (text, companyGuid) => {
  const own = String(companyGuid).toLowerCase();
  for (const m of text.matchAll(TALLY_GUID_RE)) {
    if (m[1].toLowerCase() !== own) return true;
  }
  return false;
};

const syncHelperWithDate = async ({
  xml,
  companyName,
  alterId,
  fromDate,
  toDate,
  companyGuid,
  yearId,
  onFail,
  fiscal,
}) => {
  const response = await getData(xml, [
    {
      key: "$$COMPANY_NAME",
      value: companyName,
    },
    {
      key: "$$ALTER_ID",
      value: alterId,
    },
    {
      key: "$$FROM_DATE",
      value: fromDate,
    },
    {
      key: "$$TO_DATE",
      value: toDate,
    },
    {
      key: "$$CURRENT_DATE",
      value: localYmd(),
    },
  ]);

  // An empty result is indistinguishable from "nothing changed"; callers that move
  // the sync watermark need to know the request itself failed.
  const text = String(response.data ?? "");
  if (!response.status || /<LINEERROR>/i.test(text) || looksLikeCompanyNotOpen(text)) {
    onFail?.(xml);
    if (!response.status) return [];
  }

  const json = parser.parse(response.data);

  const envelope = json.ENVELOPE || json.Envelope || {};
  const baseRows =
    xml === "BillOutstanding.xml"
      ? rowsFromBillOutstandingEnvelope(envelope)
      : normalizeEnvelope(envelope);
  // Tally GUIDs are `<companyGuid>-<hex>`; one from another company means Tally answered for
  // a different open company. Rows without any GUID (envelope/header rows) are ignored.
  if (onFail && companyGuid && baseRows.some((r) => hasForeignTallyGuid(JSON.stringify(r), companyGuid))) {
    onFail(xml);
  }
  const normalizeData = decorateRows(baseRows, { xml, companyName, fromDate, toDate, companyGuid, yearId, fiscal });

  if (xml == "Voucher.xml") {
    totalVouchers += normalizeData.length;
  }

  return normalizeData;
};

const syncGuidHelper = async ({
  xml,
  companyName,
  collectionName,
  fromDate,
  toDate,
  companyGuid,
  yearId,
}) => {
  const response = await getData(xml, [
    {
      key: "$$COMPANY_NAME",
      value: companyName,
    },
    {
      key: "$$COLLNAME",
      value: collectionName,
    },
    {
      key: "$$FROM_DATE",
      value: fromDate,
    },
    {
      key: "$$TO_DATE",
      value: toDate,
    },
  ]);

  if (!response.status) {
    return [];
  }

  const json = parser.parse(response.data);

  return normalizeEnvelope(json.ENVELOPE).map((item) => ({
    ...item,
    COMPANY_NAME: companyName,
    XML: xml,
    COLLECTION_NAME: collectionName,
    COMPANY_GUID: companyGuid,
    YEAR_ID: yearId,
  }));
};

/** SimplifiedVoucher.xml for one FY: stub rows for ingest plus the strict check used for deletions. */
const fetchVoucherList = async ({ companyName, companyGuid, year, yearId }) => {
  const xml = "SimplifiedVoucher.xml";
  const response = await getData(xml, [
    { key: "$$COMPANY_NAME", value: companyName },
    { key: "$$COLLNAME", value: "Voucher" },
    { key: "$$FROM_DATE", value: year.begin },
    { key: "$$TO_DATE", value: year.end },
  ]);
  const check = checkVoucherListResponse(response, companyGuid);
  let rows = [];
  if (response.status) {
    try {
      rows = normalizeEnvelope(parser.parse(response.data).ENVELOPE).map((item) => ({
        ...item,
        COMPANY_NAME: companyName,
        XML: xml,
        COLLECTION_NAME: "Voucher",
        COMPANY_GUID: companyGuid,
        YEAR_ID: yearId,
      }));
    } catch (e) {
      info("[sync] voucher list parse failed", { companyGuid, finYear: year.finYear, message: e?.message });
      return { rows: [], year, check: { ok: false, reason: "parse_failed" } };
    }
  }
  return { rows, year, check };
};

let syncInProgress = false;

/** Foreground, auto, headless and socket-triggered syncs all funnel through here; only one may run. */
const syncTallyData = async (windowContent, companies, isHardSync) => {
  if (syncInProgress) {
    info("[sync] rejected: another sync is still running");
    return {
      status: false,
      data: { code: "sync_in_progress", message: "A sync is already running on this Desktop." },
    };
  }
  syncInProgress = true;
  try {
    return await syncTallyDataUnlocked(windowContent, companies, isHardSync);
  } finally {
    stopSyncRunHeartbeat();
    syncInProgress = false;
  }
};

const SYNC_RUN_HEARTBEAT_MS = 60_000;
let syncRunHeartbeat = null;

/** The server treats a run without heartbeats for its lease as abandoned. */
const startSyncRunHeartbeat = (syncRunId) => {
  stopSyncRunHeartbeat();
  if (!syncRunId) return;
  syncRunHeartbeat = setInterval(() => {
    axiosInstance
      .post('/ingest/sync-run/heartbeat', { syncRunId })
      .catch((err) => info('[sync_run] heartbeat failed (non-fatal):', err?.message));
  }, SYNC_RUN_HEARTBEAT_MS);
};

const stopSyncRunHeartbeat = () => {
  if (syncRunHeartbeat) clearInterval(syncRunHeartbeat);
  syncRunHeartbeat = null;
};

const isSyncRunning = () => syncInProgress;

/** GUID → current name of every company open in Tally, or null when Tally could not be asked. */
const getOpenCompanies = async () => {
  const response = await getData("Companies.xml");
  if (!response.status) return null;
  let list;
  try {
    const node = parser.parse(response.data)?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY ?? [];
    list = Array.isArray(node) ? node : [node].filter(Boolean);
  } catch (_) {
    return null;
  }
  return {
    names: new Map(list.filter((c) => c?.GUID).map((c) => [String(c.GUID), String(c.NAME ?? "")])),
    years: yearsFromCompanyNodes(list),
  };
};

/** Every run (window, scheduled, headless, socket) gets its fiscal scope here, then keeps it. */
const planJobScope = (companies, open) => {
  const { companies: planned, added } = planFiscalScope(companies, open?.years || null);
  if (added.length) {
    info("[sync] new financial year(s) added to scope", added);
    try {
      const next = applyPlannedYears(getSelectedCompanies(), added, planned);
      if (next) setSelectedCompanies(next);
    } catch (e) {
      info("[sync] could not persist planned years (scope still applies to this run):", e?.message);
    }
  }
  return planned;
};

const syncTallyDataUnlocked = async (windowContent, companies, isHardSync) => {
  if (companies.length == 0) {
    return { status: false, data: { code: "no_company_selected" } };
  }

  totalVouchers = 0;
  const sendProgress = createTallySyncProgressSender(windowContent);
  const sendMessage = tallySyncMessageSender(windowContent);

  // Keep the TDL file on disk current. Sync never closes or restarts Tally: a TDL that is
  // not active shows up per company in the bill snapshot and keeps that company's bills.
  try {
    const { detected, applyResult } = await installTdlFiles();
    info("[tdl] sync files", {
      tallyDir: detected?.path || null,
      installed: applyResult?.status ?? null,
      message: applyResult?.message || null,
    });
  } catch (e) {
    info("[tdl] sync file install failed (non-fatal):", e?.message);
  }

  // Tally resolves SVCURRENTCOMPANY by name and falls back to another open company when the
  // name is not loaded (closed or renamed). Sync only
  // companies that are open right now, under their current Tally name.
  // init-sync still gets every selected company: it marks companies missing from the list
  // inactive, and a company closed in Tally for one sync must not disappear from the apps.
  const open = await getOpenCompanies();
  companies = planJobScope(companies, open);
  const selectedCompanies = companies;
  const openCompanies = open?.names || null;
  if (openCompanies) {
    const notOpen = companies.filter((c) => !openCompanies.has(String(c.guid)));
    if (notOpen.length) {
      const names = notOpen.map((c) => c.name || c.guid).join(", ");
      info("[sync] selected companies not open in Tally", notOpen.map((c) => c.guid));
      // Hard sync purges every company it is given before re-fetching, so never run it partially.
      if (isHardSync || notOpen.length === companies.length) {
        return {
          status: false,
          data: { code: "company_not_open", message: `Open ${names} in Tally, then sync again.` },
        };
      }
      sendMessage(`Skipping ${names} (not open in Tally)`);
    }
    companies = companies
      .filter((c) => openCompanies.has(String(c.guid)))
      .map((c) => ({ ...c, name: openCompanies.get(String(c.guid)) || c.name }));
  }

  const startTime = new Date().getTime();
  let syncRunId = null;

  let promises = [];
  const billSnapshots = {};
  const billSnapshotProblems = [];
  const contextStatuses = {};
  // TDL health is global to the running Tally: one check per sync run, shared by every company.
  let syncTdlHealth = null;
  sendProgress(0);
  sendMessage("Initializing");

  let syncedData = await initSync(selectedCompanies, isHardSync);

  info("[sync] data", summarizeSyncState(syncedData));

  if (!syncedData.status) {
    return {
      status: false,
      data: {
        message: syncedData.message,
      },
    };
  }

  syncedData = syncedData.data;

  // After init-sync so a first-sync company already exists on the server and gets a run ID.
  try {
    const firstCompanyGuid = companies[0]?.guid || companies[0]?.id;
    if (firstCompanyGuid) {
      const runRes = await axiosInstance.post('/ingest/sync-run/start', {
        companyGuid: firstCompanyGuid,
        syncType: isHardSync ? 'hard' : 'normal',
      });
      syncRunId = runRes?.data?.data?.syncRunId || null;
      info('[sync_run] started', { syncRunId, companyGuid: firstCompanyGuid, isHardSync });
      startSyncRunHeartbeat(syncRunId);
    }
  } catch (err) {
    info('[sync_run] start failed (non-fatal):', err?.message);
  }

  if (isHardSync) {
    // Use cv.allYears if available, fall back to cv.years (both contain FY list)
    const alterIds = companies.reduce((acc, cv) => {
      const yearList = cv.allYears || cv.years || [];
      acc[cv.guid] = {
        master: 0,
        voucher: yearList.reduce((years, year) => {
          years[year.finYear] = 0;
          return years;
        }, {}),
      };
      return acc;
    }, {});

    syncedData.alterIds = alterIds;
  }

  if (isHardSync) {
    info("[sync] after hard sync data", summarizeSyncState({ status: true, data: syncedData }));
  }

  const { alterIds, yearIds } = syncedData;

  companies = companies.map((company) => ({
    ...company,
    // yearIds keyed by guid on backend, fallback to id for compatibility
    yearIds: company.years.map((year) =>
      (yearIds[company.guid] || yearIds[company.id] || {})[year.finYear]
    ),
  }));

  sendMessage("Fetching Masters");

  const masterXmls = [
    "CostCategory.xml",
    "CostCentre.xml",
    "Godown.xml",             // Warehouses/godowns
    "GroupMaster.xml",        // Group masters with nature/revenue flags
    "StockGroupFull.xml",     // StockGroup with ParentGuid (replaces StockGroup.xml)
    "UnitFull.xml",           // Units with FormalName, IsSimpleUnit, Conversion
    "VoucherTypeFull.xml",    // VoucherType with ParentGuid, AffectsStock
    "LedgerFull.xml",         // Full ledger with bank, GSTIN, PAN, address
    "StockCategory.xml",
    "StockOpeningBalance.xml",
    "CurrencyMaster.xml",     // Currency masters
    // BillOutstanding.xml moved to per-company syncHelperWithDate (needs FY dates + pre-loaded TDL)
  ];

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    const companyGuid = company.guid;
    const name = company.name;

    const masterAlterId = alterIds[company.guid].master;

    for (let j = 0; j < masterXmls.length; j++) {
      const xml = masterXmls[j];
      promises.push(
        syncHelper({
          xml,
          companyName: name,
          alterId: masterAlterId,
          companyGuid,
        })
      );
    }
  }

  promises = await Promise.all(promises);

  if (jobStopCode()) return stoppedResult(syncRunId);

  sendMessage("Fetching Vouchers Basic Details");

  const endTime = new Date().getTime();
  const timeTaken = endTime - startTime;
  info(`[sync] Master Function took ${timeTaken} milliseconds`);

  const startTime2 = new Date().getTime();

  let masterPromises = [];
  let voucherPromises = [];
  const voucherListChecks = {};
  const voucherListExpected = {};
  const voucherLists = {};
  const failedVoucherYears = {};

  sendProgress(5);

  if (true) {
    const collectionNames = [
      "CostCategory",
      "CostCentre",
      "Godown",
      "Group",
      "StockGroup",
      "Unit",
      "VoucherType",
      "Ledger",
      "StockItem",
      "StockCategory",
    ];

    for (let i = 0; i < companies.length; i++) {
      const company = companies[i];
      const name = company.name;
      const years = company.years;

      const companyGuid = company.guid;
      // const masterAlterId = alterIds[companyGuid].master;

      // if (masterAlterId > 0) {
      for (let j = 0; j < collectionNames.length; j++) {
        const collectionName = collectionNames[j];
        masterPromises.push(
          syncGuidHelper({
            xml: "Master.xml",
            companyName: name,
            collectionName,
            companyGuid,
          })
        );
      }
      // }

      for (let j = 0; j < years.length; j++) {
        const year = years[j];
        const yearId = yearIds[companyGuid][year.finYear];

        voucherPromises.push(
          fetchVoucherList({ companyName: name, companyGuid, year, yearId }).then((r) => {
            (voucherListChecks[companyGuid] ||= []).push(r);
            return r.rows;
          })
        );
      }

      const trailing = trailingCheckYears(years);
      voucherListExpected[companyGuid] = years.length + trailing.length;
      for (const year of trailing) {
        voucherPromises.push(
          fetchVoucherList({ companyName: name, companyGuid, year, yearId: null }).then((r) => {
            (voucherListChecks[companyGuid] ||= []).push({ ...r, trailing: true });
            return [];
          })
        );
      }
    }
  }

  masterPromises = await Promise.all(masterPromises);
  voucherPromises = await Promise.all(voucherPromises);

  masterPromises = masterPromises.flat();
  voucherPromises = voucherPromises.flat();

  if (jobStopCode()) return stoppedResult(syncRunId);

  // Tally's AlterId only grows — unless its data was restored from a backup. If the highest
  // AlterId Tally lists is below what we already hold, re-fetch every FY for this company.
  for (const c of companies) {
    const held = Object.values(alterIds[c.guid]?.voucher || {}).map(Number).filter(Number.isFinite);
    const listed = (voucherListChecks[c.guid] || [])
      .map((r) => r.check?.ok ? r.check.maxAlterId : null)
      .filter((n) => Number.isFinite(n));
    if (!held.length || !listed.length) continue;
    if (Math.max(...listed) < Math.max(...held)) {
      info("[sync] Tally AlterIds went backwards (restored data?) — full voucher fetch", {
        company: c.name, listed: Math.max(...listed), held: Math.max(...held),
      });
      for (const fy of Object.keys(alterIds[c.guid].voucher)) alterIds[c.guid].voucher[fy] = 0;
    }
  }

  info(
    `[sync] Master : ${masterPromises.length} and Voucher: ${voucherPromises.length}`
  );

  const endTime2 = new Date().getTime();
  const timeTaken2 = endTime2 - startTime2;

  info(`[sync] Master GUID Function took ${timeTaken2} milliseconds`);

  let currentProgress = 10;
  sendProgress(currentProgress);

  const startTime3 = new Date().getTime();

  const totalYears = companies.map((company) => company.years).flat().length;
  const perYearPercentage = +(80 / totalYears).toFixed(2);

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    const years = company.years;

    const name = company.name;
    const companyGuid = company.guid;
    const masterAlterId = alterIds[company.guid].master;

    const trimmedName = name.length > 20 ? `${name.slice(0, 20)}...` : name;

    sendMessage(`Fetching ${trimmedName} Data`);

    // ── OpeningBalanceDiff.xml ── once per company (not per FY)
    // Fetches per-ledger signed opening balances at company's BOOKSFROM date.
    // SUM of all values = Tally's fixed "Difference in Opening Balances" for the Trial Balance.
    // Fallback: use startingFrom if booksFrom is null (same concept, always available).
    const obDiffDate = company.booksFrom || company.startingFrom;
    if (obDiffDate) {
      const obDiffDateStr = String(obDiffDate).replace(/-/g, ''); // ensure YYYYMMDD
      const obDiffResponse = await syncHelperWithDate({
        xml: 'OpeningBalanceDiff.xml',
        companyName: name,
        alterId: 0,
        fromDate: obDiffDateStr,
        toDate:   obDiffDateStr,
        companyGuid,
        yearId: null,
      });
      promises.push(obDiffResponse);
      info('[sync] OpeningBalanceDiff.xml fetched for', name, 'at date', obDiffDateStr);
    } else {
      info('[sync] OpeningBalanceDiff.xml skipped — no booksFrom/startingFrom for', name);
    }

    // Bill outstanding — run-wide health, then this company's Context → Bills (serialized); failures keep the old bills.
    if (years.length > 0) {
      const outstandingYear = [...years].sort((a, b) =>
        String(b.end || "").localeCompare(String(a.end || ""))
      )[0];
      const fromDate = String(outstandingYear.begin || "").replace(/-/g, "");
      const toDate = String(outstandingYear.end || "").replace(/-/g, "");
      if (!syncTdlHealth) {
        syncTdlHealth = await checkTdlHealth();
        info("[tdl] sync health", {
          syncRunId: syncRunId || null,
          status: syncTdlHealth.status,
          version: syncTdlHealth.version || null,
          reason: syncTdlHealth.reason || null,
        });
      }
      const snapshot = await fetchCompanyBillSnapshot({
        companyName: name,
        companyGuid,
        fromDate,
        toDate,
        currentDate: localYmd(),
        health: syncTdlHealth,
      });
      billSnapshots[companyGuid] = snapshotSummary(snapshot);
      contextStatuses[companyGuid] = snapshot.contextStatus || null;
      if (snapshot.status === BILL_STATUS.SUCCESS) {
        promises.push(decorateRows(snapshot.rows, {
          xml: "BillOutstanding.xml",
          companyName: name,
          fromDate,
          toDate,
          companyGuid,
          yearId: yearIds[companyGuid]?.[outstandingYear.finYear] || null,
        }));
      } else {
        billSnapshotProblems.push(name);
      }
      info("[sync] bill_snapshot", {
        company: name,
        companyGuid,
        status: snapshot.status,
        snapshotComplete: snapshot.snapshotComplete,
        rows: snapshot.rowCount,
        tdlStatus: snapshot.tdlStatus || null,
        tdlVersion: snapshot.tdlVersion || null,
        contextStatus: snapshot.contextStatus || null,
        contextCompany: snapshot.contextCompany || null,
        authority: snapshot.authority || null,
        reason: snapshot.reason || null,
        durationMs: snapshot.durationMs,
      });
    }

    // Deleted-voucher check: needs this company's verified Context and a clean list for every FY.
    const listChecks = voucherListChecks[companyGuid] || [];
    voucherLists[companyGuid] = buildVoucherListSummary({
      companyGuid,
      contextStatus: contextStatuses[companyGuid],
      years: listChecks.length > 0 && listChecks.length === voucherListExpected[companyGuid]
        ? listChecks.map(({ year, check, trailing }) => ({ finYear: year.finYear, begin: year.begin, end: year.end, trailing: !!trailing, check }))
        : [],
    });
    info("[sync] voucher_list", { company: name, ...voucherListLog(voucherLists[companyGuid]) });

    for (let j = 0; j < years.length; j++) {
      if (jobStopCode()) return stoppedResult(syncRunId);
      const year = years[j];
      const yearId = yearIds[companyGuid][year.finYear];

      const voucherAlterId = alterIds[company.guid].voucher[year.finYear];
      const markFailed = () => (failedVoucherYears[companyGuid] ||= new Set()).add(year.finYear);

      info(`[sync] Year Function`, { year, voucherAlterId });

      // StockItemFull.xml replaces StockItem.xml — includes full GST rates, HSN, alias
      // StockValuation.xml — FY-specific opening/closing stock VALUE (existing, current FY only)
      const stockValuationResponse = await syncHelperWithDate({
        xml: "StockValuation.xml",
        companyName: name,
        alterId: 0,
        fromDate: year.begin,
        toDate: year.end,
        companyGuid,
        yearId,
      });
      promises.push(stockValuationResponse);

      // StockFYBalance.xml — queries Tally stock AT EXACT DATES (from=to=single date)
      // Bypasses Tally's limitation where $ClosingValue returns current FY data for ranges
      // Closing balance: query at FY end date
      const fyEndStr   = year.end;   // e.g. '20260331'
      // Opening balance: query at day BEFORE FY start
      const fyStartMs  = new Date(year.begin.slice(0,4)+'-'+year.begin.slice(4,6)+'-'+year.begin.slice(6,8)+'T00:00:00Z');
      const prevDayMs  = new Date(fyStartMs.getTime() - 86400000);
      const prevDayStr = prevDayMs.toISOString().slice(0,10).replace(/-/g,''); // YYYYMMDD

      // Closing stock at FY end
      const stockFYClosingResponse = await syncHelperWithDate({
        xml: "StockFYBalance.xml",
        companyName: name,
        alterId: 0,
        fromDate: fyEndStr,
        toDate:   fyEndStr,
        companyGuid,
        yearId,
        fiscal: stockBalanceFiscal(year, "closing", fyEndStr),
      });
      promises.push(stockFYClosingResponse);

      // Opening stock = closing stock at day before FY start
      const stockFYOpeningResponse = await syncHelperWithDate({
        xml: "StockFYBalance.xml",
        companyName: name,
        alterId: 0,
        fromDate: prevDayStr,
        toDate:   prevDayStr,
        companyGuid,
        yearId,
        fiscal: stockBalanceFiscal(year, "opening", prevDayStr),
      });
      promises.push(stockFYOpeningResponse);

      // Always full: FY-dated stock values change without the item's AlterId moving.
      const stockresponse = await syncHelperWithDate({
        xml: "StockItemFull.xml",
        companyName: name,
        alterId: 0,
        fromDate: year.begin,
        toDate: year.end,
        companyGuid,
        yearId,
      });
      promises.push(stockresponse);

      const stockTransactionResponse = await syncHelperWithDate({
        xml: "StockTransaction.xml",
        companyName: name,
        alterId: voucherAlterId,
        fromDate: year.begin,
        toDate: year.end,
        companyGuid,
        yearId,
        onFail: markFailed,
      });
      promises.push(stockTransactionResponse);

      // AllVoucher.xml replaces Voucher.xml — includes inventory, batch, ledger entries, bill allocations
      const voucherResponse = await syncHelperWithDate({
        xml: "AllVoucher.xml",
        companyName: name,
        alterId: voucherAlterId,
        fromDate: year.begin,
        toDate: year.end,
        companyGuid,
        yearId,
        onFail: markFailed,
      });
      promises.push(voucherResponse);

      const ledgerTransactionResponse = await syncHelperWithDate({
        xml: "LedgerTransaction.xml",
        companyName: name,
        alterId: voucherAlterId,
        fromDate: year.begin,
        toDate: year.end,
        companyGuid,
        yearId,
        onFail: markFailed,
      });

      promises.push(ledgerTransactionResponse);

      // Voucher inventory line items (qty, rate, item, batch, godown)
      const voucherInventoryResponse = await syncHelperWithDate({
        xml: "VoucherInventoryDetail.xml",
        companyName: name,
        alterId: voucherAlterId,
        fromDate: year.begin,
        toDate: year.end,
        companyGuid,
        yearId,
        onFail: markFailed,
      });
      promises.push(voucherInventoryResponse);

      // GST voucher-level details (CGST/SGST/IGST, taxable amount, IRN)
      const gstDetailsResponse = await syncHelperWithDate({
        xml: "GSTDetails.xml",
        companyName: name,
        alterId: voucherAlterId,
        fromDate: year.begin,
        toDate: year.end,
        companyGuid,
        yearId,
        onFail: markFailed,
      });
      promises.push(gstDetailsResponse);

      const ledgerOpeningBalanceResponse = await syncHelperWithDate({
        xml: "LedgerOpeningBalance.xml",
        companyName: name,
        // Always full: a back-dated voucher changes opening balances without the ledger's AlterId moving.
        alterId: 0,
        fromDate: year.begin,
        toDate: year.end,
        companyGuid,
        yearId,
      });

      promises.push(ledgerOpeningBalanceResponse);

      currentProgress += perYearPercentage;
      currentProgress = +currentProgress.toFixed(2);
      sendProgress(currentProgress);

      // NONE

      // yearPromises.push(
      //   syncHelperWithDate(
      //     "CostCentreTransactionTest.xml",
      //     name,
      //     year.begin,
      //     year.end
      //   )
      // );

      // yearPromises.push(
      //   syncHelperWithDate("VoucherBill.xml", name, year.begin, year.end)
      // );
    }
  }

  if (jobStopCode()) return stoppedResult(syncRunId);

  const endTime3 = new Date().getTime();
  const timeTaken3 = endTime3 - startTime3;

  info(
    `[sync] Year Function took ${timeTaken3} milliseconds. Total Vouchers: ${totalVouchers}`
  );

  const records = promises.flat();

  if (billSnapshotProblems.length) {
    sendMessage(`Bill outstanding kept from last sync for ${billSnapshotProblems.join(", ")} — check Settings → Bill Outstanding TDL`);
  }

  // One upload per company: the backend files a whole chunk under one company, so a
  // chunk must never straddle two companies. A company-specific failure no longer
  // skips the companies after it; cancellation, auth and an unreachable backend do.
  const ofCompany = (rows, guid) => rows.filter((r) => r?.COMPANY_GUID === guid);
  const outcomes = [];
  let globalFailure = null;
  for (const c of companies) {
    if (globalFailure) {
      outcomes.push({ guid: c.guid, name: c.name, status: "not_attempted", code: globalFailure.code || null });
      continue;
    }
    let response;
    try {
      const companyRecords = ofCompany(records, c.guid);
      const sentOf = (xml) => companyRecords.reduce((n, r) => n + (r?.XML === xml ? 1 : 0), 0);
      const voucherWatermarks = buildVoucherWatermarks({
        companyGuid: c.guid,
        years: (voucherListChecks[c.guid] || []).map(({ year, check, trailing }) => ({ finYear: year.finYear, trailing: !!trailing, check })),
        failedYears: failedVoucherYears[c.guid],
        sent: { "AllVoucher.xml": sentOf("AllVoucher.xml"), "StockTransaction.xml": sentOf("StockTransaction.xml") },
      });
      info("[sync] voucher_watermarks", { company: c.name, years: voucherWatermarks.years, sent: voucherWatermarks.sent });
      response = await uploadLargeArray({
        records: companyRecords,
        master: ofCompany(masterPromises, c.guid),
        vouchers: ofCompany(voucherPromises, c.guid),
        gzip: false,
        companyGuid: c.guid,
        billSnapshotMode: billSnapshots[c.guid] ? "staged" : null,
        extras: {
          companyGuid: c.guid,
          companies: [{ guid: c.guid, name: c.name, years: c.years, yearIds: c.yearIds }],
          isHardSync,
          ...(billSnapshots[c.guid] ? { billSnapshots: [billSnapshots[c.guid]] } : {}),
          ...(voucherLists[c.guid] ? { voucherLists: [voucherLists[c.guid]] } : {}),
          voucherWatermarks: [voucherWatermarks],
          // Its server start time precedes every Tally fetch: the backend's cutoff for deletions.
          ...(syncRunId ? { syncRunId } : {}),
        },
        sendMessage,
      });
    } catch (err) {
      const apiMessage = err?.response?.data?.message || err?.message;
      const apiCode = err?.response?.data?.code;
      info(`[sync] API Error main`, { err: apiMessage, code: apiCode });
      response = {
        status: false,
        global: isGlobalUploadFailure(err),
        message: apiMessage || "Something went wrong",
        code: apiCode,
        data: err?.response?.data,
      };
    }
    if (response.status) {
      outcomes.push({ guid: c.guid, name: c.name, status: "uploaded", uploadId: response.uploadId });
    } else {
      const code = response.code || response.data?.code || null;
      outcomes.push({ guid: c.guid, name: c.name, status: "failed", code, message: response.message || null });
      info("[sync] company upload failed", { companyGuid: c.guid, code, global: !!response.global });
      if (response.global || jobCancelled()) globalFailure = { code, message: response.message };
    }
  }

  const uploaded = outcomes.filter((o) => o.status === "uploaded");
  const failed = outcomes.filter((o) => o.status !== "uploaded");
  const lastUploadId = uploaded.length ? uploaded[uploaded.length - 1].uploadId : null;

  if (failed.length) {
    const firstFailure = failed.find((o) => o.status === "failed") || failed[0];
    if (syncRunId) {
      try {
        await axiosInstance.post('/ingest/sync-run/complete', {
          syncRunId,
          status: uploaded.length > 0 ? 'partial' : 'failed',
          errorMessage: firstFailure.message || 'Upload failed',
          ...(lastUploadId ? { uploadId: lastUploadId } : {}),
        });
      } catch (err) {
        info('[sync_run] failed-mark failed (non-fatal):', err?.message);
      }
    }
    if (lastUploadId) store.set("uploadId", lastUploadId);
    const partial = uploaded.length > 0;
    const code = jobCancelled() ? "cancelled" : partial ? "partial_sync" : firstFailure.code;
    const message = partial
      ? `Synced ${uploaded.map((o) => o.name).join(", ")}. Not synced: ${failed.map((o) => o.name).join(", ")}${firstFailure.message ? ` (${firstFailure.message})` : ""}.`
      : firstFailure.message;
    return {
      status: false,
      partial,
      data: { message, code, companies: outcomes, uploadId: lastUploadId },
      code,
      message,
    };
  }

  // V2: Mark sync_run as completed
  if (syncRunId) {
    try {
      await axiosInstance.post('/ingest/sync-run/complete', {
        syncRunId,
        uploadId: lastUploadId,
        status: 'completed',
      });
      info('[sync_run] completed', { syncRunId });
    } catch (err) {
      info('[sync_run] complete failed (non-fatal):', err?.message);
    }
  }

  store.set("uploadId", lastUploadId);
  return { status: true, data: { code: null, uploadId: lastUploadId, companies: outcomes } };
};

/** Stopped before any upload was committed: nothing was sent to the server. */
const stoppedResult = (syncRunId) => {
  const code = jobStopCode() || "cancelled";
  if (syncRunId) {
    axiosInstance
      .post('/ingest/sync-run/complete', { syncRunId, status: 'failed', errorMessage: `stopped: ${code}` })
      .catch((err) => info('[sync_run] stop-mark failed (non-fatal):', err?.message));
  }
  return { status: false, data: { code }, code };
};

/** Ask the running sync to stop. It stops at the next safe point and then releases itself. */
const stopTallySyncHandler = (code) =>
  coordinator.requestCancel({ types: ["sync", "hard_sync"], code: code || "manually_stopped" });

// ---------------------------------------------------------------------------
// Phase 2b (2026-07-02): Targeted post-write sync
// ---------------------------------------------------------------------------
// After a successful tally:write, backend emits sync:request with tallyIds
// (MASTERIDs of the freshly-created vouchers). Instead of running a full
// AllVoucher.xml sync, fetch ONLY those vouchers via SingleVoucher.xml and
// push them through the existing /ingest/init → /chunk → /complete pipeline,
// which already triggers the Receipt reconciler + bill-alloc parser in
// ingestProcessor.processVouchers.
//
// Falls back to full sync silently on any failure (see socket.js sync:request
// handler). Auto / Manual / Hard sync paths are untouched — this only
// replaces the post-write sync trigger when tallyIds are provided.
const fetchAndIngestSingleVouchers = async ({ companyName, companyGuid, tallyIds }) => {
  if (!companyName || !companyGuid || !Array.isArray(tallyIds) || !tallyIds.length) {
    return { status: false, message: 'Missing companyName / companyGuid / tallyIds' };
  }

  const uniqIds = Array.from(new Set(tallyIds.map(String).filter(Boolean)));
  if (!uniqIds.length) return { status: false, message: 'No valid tallyIds' };

  info(`[single-voucher] fetching ${uniqIds.length} voucher(s) from Tally for ${companyName}`);

  // Wide date window — SingleVoucher.xml filters by MASTERID, but Tally still
  // requires SVFROMDATE/SVTODATE. Cover a big range so we never miss the
  // record (backdated entries, future-dated etc.).
  const FROM_DATE = '20200101';
  const TO_DATE   = '20500101';

  const collected = [];
  for (const masterId of uniqIds) {
    const response = await getData('SingleVoucher.xml', [
      { key: '$$COMPANY_NAME', value: companyName },
      { key: '$$FROM_DATE',    value: FROM_DATE },
      { key: '$$TO_DATE',      value: TO_DATE },
      { key: '$$MASTER_ID',    value: masterId },
    ]);
    if (!response.status) {
      info(`[single-voucher] Tally fetch failed for MASTERID=${masterId}: ${response.message}`);
      // One failure aborts the batch → caller will fall back to full sync,
      // which is safe (full sync will pick up all pending vouchers).
      return { status: false, message: `Tally fetch failed for MASTERID=${masterId}: ${response.message}` };
    }
    const json = parser.parse(response.data);
    const rows = normalizeEnvelope(json.ENVELOPE) || [];
    if (!rows.length) {
      info(`[single-voucher] Tally returned 0 rows for MASTERID=${masterId} — may not exist yet, will fall back to full sync`);
      return { status: false, message: `MASTERID=${masterId} not found in Tally response` };
    }
    for (const item of rows) {
      collected.push({
        ...item,
        COMPANY_NAME:    companyName,
        XML:             'SingleVoucher.xml',
        FROM_DATE:       FROM_DATE,
        TO_DATE:         TO_DATE,
        COMPANY_GUID:    companyGuid,
        YEAR_ID:         null,
        _RECORD_TYPE:    'voucher',
        _FINANCIAL_YEAR: null, // ingestProcessor derives from voucher.date
      });
    }
  }

  if (!collected.length) {
    return { status: false, message: 'No voucher records collected' };
  }

  info(`[single-voucher] collected ${collected.length} row(s), pushing to backend ingest`);

  // Minimal ingest handshake — same endpoints as the full sync pipeline.
  let uploadId;
  try {
    const initRes = (await axiosInstance.post('/ingest/init', {}, { timeout: 15_000 })).data;
    uploadId = initRes?.data?.uploadId;
    if (!uploadId) return { status: false, message: 'ingest/init returned no uploadId' };
  } catch (err) {
    return { status: false, message: `ingest/init failed: ${err?.message}` };
  }

  // Ship as a single JSON array (payload is tiny — 1-2 vouchers typically).
  try {
    await axiosInstance.post('/ingest/chunk', collected, {
      headers: {
        'Content-Type':  'application/json',
        'upload-id':     uploadId,
        'stream-name':   'vouchers',
        'chunk-index':   '0',
        'company-guid':  companyGuid,
      },
      timeout: 30_000,
    });
  } catch (err) {
    return { status: false, message: `ingest/chunk failed: ${err?.response?.data?.message || err?.message}` };
  }

  try {
    await axiosInstance.post('/ingest/complete', {
      uploadId,
      companyGuid,
      voucherCount: collected.length,
      recordCount:  collected.length,
      isHardSync:   false,
    }, { timeout: 15_000 });
  } catch (err) {
    return { status: false, message: `ingest/complete failed: ${err?.response?.data?.message || err?.message}` };
  }

  info(`[single-voucher] ingest complete — ${collected.length} voucher row(s) processed`);
  return { status: true, count: collected.length };
};

module.exports = {
  getCompanyDestinations,
  getCompanies,
  discoverCompanies,
  toDiscoveredCompany,
  syncTallyData,
  isSyncRunning,
  stopTallySyncHandler,
  postToTally,
  fetchAndIngestSingleVouchers,
};

// console.dir(json, { depth: null, colors: true, maxArrayLength: null });
