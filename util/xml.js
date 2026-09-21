const { XMLParser } = require("fast-xml-parser");
const path = require("path");
const { readFile } = require("fs").promises;
const axios = require("axios");
const iconv = require("iconv-lite");

const { error, info } = require("./logger");
const store = require("./store");
const createFinancialYears = require("./createFinancialYears");
const { normalizeEnvelope } = require("./tallyHelper");
const { axiosInstance } = require("./helper");
const { ensureBillOutstandingTdl } = require("./ensureBillOutstandingTdl");

/** Decode Tally HTTP body — custom reports may return UTF-16 LE with BOM. */
function decodeTallyResponse(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return iconv.decode(buf, "utf16-le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return iconv.decode(buf, "utf16-be");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString("utf8");
  }
  const sample = buf.slice(0, Math.min(120, buf.length));
  let nulls = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) nulls++;
  if (sample.length > 20 && nulls > sample.length / 4) {
    return iconv.decode(buf, "utf16-le");
  }
  return buf.toString("utf8");
}

/** BILLROW nested objects from TDKBillOutstandingWorking — not parallel field arrays. */
function rowsFromBillOutstandingEnvelope(envelope) {
  if (!envelope) return [];
  const raw = envelope.BILLROW ?? envelope.BillRow;
  if (raw != null) {
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr
      .filter((r) => r && typeof r === "object")
      .map((r) => ({
        LedgerName: String(r.LedgerName ?? r.LEDGERNAME ?? ""),
        BillName: String(r.BillName ?? r.BILLNAME ?? ""),
        BillDate: r.BillDate ?? r.BILLDATE ?? null,
        DueDate: r.DueDate ?? r.DUEDATE ?? null,
        Amount: r.Amount ?? r.AMOUNT ?? 0,
        PendingAmount: r.PendingAmount ?? r.PENDINGAMOUNT ?? 0,
        DrCr: r.DrCr ?? r.DRCR ?? null,
        BillType: r.BillType ?? r.BILLTYPE ?? r.DrCr ?? r.DRCR ?? null,
        LedgerParent: String(r.LedgerParent ?? r.LEDGERPARENT ?? ""),
        VoucherGuid: r.VoucherGuid ?? r.VOUCHERGUID ?? null,
        AlterId: r.AlterId ?? r.ALTERID ?? 0,
      }));
  }
  // No BILLROW = TDL not loaded or empty — do not fall back to HEADER/BODY junk
  return [];
}

const parser = new XMLParser({
  //   ignoreAttributes: false,
  //   attributeNamePrefix: "@_",
  //   textNodeName: "#text",
  ignoreAttributes: true, // drop @_TYPE, @_NAME, etc.
  attributeNamePrefix: "", // (ignored anyway)
  textNodeName: "value", // where element text lands
  parseTagValue: true, // auto number/boolean coercion
  trimValues: true,
});

async function uploadLargeArray({
  records,
  master,
  vouchers,
  chunkItems = 10_000,
  maxChunkBytes = 10 * 1024 * 1024,
  // completeBatchSize = 1000,
  // gzip = false,
  extras = {},
  sendMessage,
}) {
  const gzip = false;

  info("[sync] size", {
    records: records.length,
    master: master.length,
    vouchers: vouchers.length,
  });

  sendMessage("Uploading Data");

  // Retry init up to 3x with backoff (backend may be briefly unavailable)
  let initRes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      initRes = (await axiosInstance.post("/ingest/init", {}, { timeout: 15_000 })).data;
      break;
    } catch (err) {
      info("[sync] init attempt failed", { attempt, message: err?.message });
      if (attempt === 3) return { status: false, message: "Backend unreachable. Sync paused — retry when backend is available." };
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
  });

  info("[sync] ingest init [voucher]", vouchersResponse);

  if (!vouchersResponse.status) {
    return vouchersResponse;
  }

  info("[sync] ingest complete body", { uploadId, ...extras });
  sendMessage("Processing Data");

  // Retry complete up to 3x (all data uploaded — just need to confirm)
  let completeRes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      completeRes = (await axiosInstance.post("/ingest/complete", { uploadId, ...extras })).data;
      break;
    } catch (err) {
      info("[sync] complete attempt failed", { attempt, message: err?.message });
      if (attempt === 3) {
        return {
          status: false,
          message: err?.response?.data?.message || "Could not complete sync. Will retry on next sync.",
          data: err?.response?.data?.data,
        };
      }
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }

  // sendMessage("Data Synced");

  info(`[sync] API response`, completeRes);

  if (completeRes?.outcome === 'partial') {
    sendMessage(completeRes.message || 'Books synced. Some calculations could not be updated.');
  }

  return {
    status: true,
    uploadId,
    outcome: completeRes?.outcome || 'complete',
    message: completeRes?.message || 'Sync complete',
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
}) {
  function* chunkArray(arr, n) {
    for (let i = 0; i < arr.length; i += n) {
      yield arr.slice(i, i + n);
    }
  }

  let chunkIndex = 0;
  // let totalChunksPlanned = Math.ceil(items.length / chunkItems);

  for (const batch of chunkArray(items, chunkItems)) {
    // NDJSON
    const lines = batch.map((x) => JSON.stringify(x));
    const ndjson = lines.join("\n") + "\n";
    let payload = Buffer.from(ndjson, "utf8");

    // Size guard — if one NDJSON batch exceeds the negotiated max, split again
    if (payload.length > maxChunkBytes) {
      // split by lines to keep within size; do a quick binary split
      let start = 0;
      while (start < lines.length) {
        let end = start;
        let accum = 0;
        while (end < lines.length) {
          const len = Buffer.byteLength(lines[end], "utf8") + 1; // + newline
          if (accum + len > maxChunkBytes && end > start) break;
          accum += len;
          end++;
        }
        const subNdjson = lines.slice(start, end).join("\n") + "\n";
        const subBuf = Buffer.from(subNdjson, "utf8");
        const response = await sendOneChunk(
          client,
          uploadId,
          streamName,
          chunkIndex++,
          subBuf,
          gzip
        );
        if (!response.status) {
          return response;
        }
        start = end;
      }
    } else {
      // const body = gzip ? zlib.gzipSync(payload) : payload;
      const response = await sendOneChunk(
        client,
        uploadId,
        streamName,
        chunkIndex++,
        payload,
        gzip
      );
      if (!response.status) {
        return response;
      }
    }
  }

  return { status: true };
}

async function sendOneChunk(client, uploadId, streamName, idx, body, gzip) {
  const headers = {
    "Upload-Id": uploadId,
    "Stream-Name": streamName,
    "Chunk-Index": String(idx),
    "Content-Type": "application/x-ndjson",
  };
  if (gzip) headers["Content-Encoding"] = "gzip";

  // retry 3 times with small backoff
  let attempt = 0;
  while (true) {
    try {
      await client.post("/ingest/chunk", body, { headers });
      info(`[sync] Chunks`, { attempt, idx });

      return { status: true };
    } catch (e) {
      if (++attempt >= 3) {
        return { status: false, message: e?.response?.data?.message };
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
    });
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
let stopTallySyncCode = null;

const getData = async (filePath, replacer = []) => {
  const TALLY_URL = tallyUrl();

  const xmlPath = path.join(__dirname, "..", "xmls", filePath);

  let xml = await readFile(xmlPath, "utf8");

  replacer.forEach((item) => {
    const { key, value } = item;
    xml = xml.replace(key, value);
  });

  // SAFETY: Force SVCURRENTCOMPANY to always use the real company name.
  // This fixes any XML files that have hardcoded placeholder names
  // (e.g. 'Test Company Data', 'Demo2') from development/testing.
  const companyNameVal = replacer.find(r => r.key === '$$COMPANY_NAME')?.value;
  if (companyNameVal) {
    xml = xml.replace(
      /<SVCURRENTCOMPANY>[^<]*<\/SVCURRENTCOMPANY>/g,
      `<SVCURRENTCOMPANY>${companyNameVal}</SVCURRENTCOMPANY>`
    );
  }

  let attempt = 0;
  while (true) {
    try {
      const response = await axios.post(TALLY_URL, xml, {
        headers: {
          "Content-Type": "text/xml",
          Accept: "application/xml, text/xml, */*",
        },
        responseType: "arraybuffer",
        timeout: 15000 * 4,
      });
      const decoded = decodeTallyResponse(response.data);
      return { status: true, data: decoded, message: "" };
    } catch (err) {
      error(err?.message, filePath);
      if (++attempt >= 3 || filePath == "TallyDestination.xml") {
        stopTallySyncCode = "tally_timeout";
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
      const response = await axios.post(TALLY_URL, xmlBody, {
        headers: {
          "Content-Type": "text/xml",
          Accept: "application/xml, text/xml, */*",
        },
        timeout: 15000,
      });
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

const getCompanies = async () => {
  const response = await getData("Companies.xml");

  if (!response.status) {
    return [];
  }

  const currentCompany = await getCurrentCompany();

  const json = parser.parse(response.data);
  const companiesNode = json?.ENVELOPE?.BODY?.DATA?.COLLECTION?.COMPANY ?? [];

  const companies = Array.isArray(companiesNode)
    ? companiesNode
    : [companiesNode].filter(Boolean);

  // getCompanyGSTNumber(
  //   companies.map((company) => company.NAME)
  // );

  let ledgerPromises = [];

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];

    ledgerPromises.push(
      syncHelper({
        xml: "SimplifiedLedger.xml",
        companyName: company.NAME,
      })
    );
  }

  ledgerPromises = await Promise.all(ledgerPromises);

  return companies.map((company, i) => ({
    name: company.NAME,
    guid: company.GUID,
    startingFrom: company.STARTINGFROM,
    booksFrom: company.BOOKSFROM,
    website: company.WEBSITE,
    email: company.EMAIL,
    phoneNumber: company.PHONENUMBER,
    mobileNumber: company.MOBILENO,
    address: [
      company._ADDRESS1 ?? "",
      company._ADDRESS2 ?? "",
      company._ADDRESS3 ?? "",
      company._ADDRESS4 ?? "",
      company._ADDRESS5 ?? "",
    ],
    pincode: company.PINCODE,
    state: company.STATENAME,
    country: company.COUNTRYNAME,
    gstNumber: "",
    incomeTaxNumber: company.INCOMETAXNUMBER,
    companyNumber: company.COMPANYNUMBER,
    destination: company.DESTINATION,
    isSynced: false,
    years: createFinancialYears(
      company.STARTINGFROM.toString(),
      company.ENDINGAT.toString()
    ),
    isCurrentCompany: company.GUID == currentCompany.GUID,
    ledgersCount: ledgerPromises[i].length,
  }));
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

const syncHelperWithDate = async ({
  xml,
  companyName,
  alterId,
  fromDate,
  toDate,
  companyGuid,
  yearId,
  financialYear: financialYearArg,
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
  ]);

  if (!response.status) {
    return [];
  }

  const json = parser.parse(response.data);

  // Never derive FY from an FY-end / day-before query date (20270331 → 2027-2028).
  const financialYear = financialYearArg || computeFinancialYear(fromDate);
  const envelope = json.ENVELOPE || json.Envelope || {};
  const baseRows =
    xml === "BillOutstanding.xml"
      ? rowsFromBillOutstandingEnvelope(envelope)
      : normalizeEnvelope(envelope);
  const normalizeData = baseRows.map((item) => ({
    ...item,
    COMPANY_NAME:    companyName,
    XML:             xml,
    FROM_DATE:       fromDate,
    TO_DATE:         toDate,
    COMPANY_GUID:    companyGuid,
    YEAR_ID:         yearId,
    _RECORD_TYPE:    XML_RECORD_TYPE[xml] || 'unknown',
    _FINANCIAL_YEAR: financialYear,
  }));

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

const syncTallyData = async (windowContent, companies, isHardSync) => {
  if (companies.length == 0) {
    return { status: false, data: { code: "no_company_selected" } };
  }

  totalVouchers = 0;
  stopTallySyncCode = null;
  const sendProgress = createTallySyncProgressSender(windowContent);
  const sendMessage = tallySyncMessageSender(windowContent);

  // Option B: ensure TDL on disk; if not live-loaded, restart Tally with /TDL+/LOAD (no manual F1)
  try {
    const companyName = companies[0]?.name || "";
    const companyNumber = companies[0]?.companyNumber ?? null;
    const tdlResult = await ensureBillOutstandingTdl({
      companyName,
      companyNumber,
      allowRestart: true,
    });
    info("[tdl] ensureBillOutstandingTdl", {
      status: tdlResult?.status,
      liveLoaded: tdlResult?.liveLoaded,
      billRows: tdlResult?.liveBillRows,
      activated: !!tdlResult?.activateResult?.status,
      activateArgs: tdlResult?.activateResult?.args || null,
      message: tdlResult?.message,
    });
  } catch (e) {
    info("[tdl] ensureBillOutstandingTdl threw (non-fatal):", e?.message);
  }

  const startTime = new Date().getTime();

  // V2: Start a sync_run record for monitoring/atomicity
  let syncRunId = null;
  try {
    const firstCompanyGuid = companies[0]?.guid || companies[0]?.id;
    if (firstCompanyGuid) {
      const runRes = await axiosInstance.post('/ingest/sync-run/start', {
        companyGuid: firstCompanyGuid,
        syncType: isHardSync ? 'hard' : 'normal',
      });
      syncRunId = runRes?.data?.data?.syncRunId || null;
      info('[sync_run] started', { syncRunId, companyGuid: firstCompanyGuid, isHardSync });
    }
  } catch (err) {
    info('[sync_run] start failed (non-fatal):', err?.message);
  }

  let promises = [];
  sendProgress(0);
  sendMessage("Initializing");

  let syncedData = await initSync(companies, isHardSync);

  info("[sync] data", syncedData);

  if (!syncedData.status) {
    return {
      status: false,
      data: {
        message: syncedData.message,
      },
    };
  }

  syncedData = syncedData.data;

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
    info("[sync] after hard sync data", syncedData);
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

  sendMessage("Fetching Vouchers Basic Details");

  const endTime = new Date().getTime();
  const timeTaken = endTime - startTime;
  info(`[sync] Master Function took ${timeTaken} milliseconds`);

  const startTime2 = new Date().getTime();

  let masterPromises = [];
  let voucherPromises = [];

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
          syncGuidHelper({
            xml: "SimplifiedVoucher.xml",
            companyName: name,
            collectionName: "Voucher",
            fromDate: year.begin,
            toDate: year.end,
            companyGuid,
            yearId,
          })
        );
      }
    }
  }

  masterPromises = await Promise.all(masterPromises);
  voucherPromises = await Promise.all(voucherPromises);

  masterPromises = masterPromises.flat();
  voucherPromises = voucherPromises.flat();

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

    // Bill outstanding — once per company per sync (needs pre-loaded TDKBillOutstanding.tdl)
    if (years.length > 0) {
      const outstandingYear = [...years].sort((a, b) =>
        String(b.end || "").localeCompare(String(a.end || ""))
      )[0];
      const fromDate = String(outstandingYear.begin || "").replace(/-/g, "");
      const toDate = String(outstandingYear.end || "").replace(/-/g, "");
      try {
        const billOutstandingResponse = await syncHelperWithDate({
          xml: "BillOutstanding.xml",
          companyName: name,
          alterId: 0,
          fromDate,
          toDate,
          companyGuid,
          yearId: yearIds[companyGuid]?.[outstandingYear.finYear] || null,
          financialYear: outstandingYear.finYear,
        });
        promises.push(billOutstandingResponse);
        info("[sync] BillOutstanding.xml", {
          company: name,
          fromDate,
          toDate,
          rows: Array.isArray(billOutstandingResponse)
            ? billOutstandingResponse.length
            : 0,
        });
      } catch (e) {
        info("[sync] BillOutstanding.xml failed (non-fatal):", e?.message);
      }
    }

    for (let j = 0; j < years.length; j++) {
      if (stopTallySyncCode) {
        return {
          status: false,
          data: { code: stopTallySyncCode },
        };
      }
      const year = years[j];
      const yearId = yearIds[companyGuid][year.finYear];

      const voucherAlterId = alterIds[company.guid].voucher[year.finYear];

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
        financialYear: year.finYear,
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
        financialYear: year.finYear,
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
        financialYear: year.finYear,
      });
      promises.push(stockFYOpeningResponse);

      const stockresponse = await syncHelperWithDate({
        xml: "StockItemFull.xml",
        companyName: name,
        alterId: voucherAlterId == 0 ? 0 : masterAlterId,
        fromDate: year.begin,
        toDate: year.end,
        companyGuid,
        yearId,
        financialYear: year.finYear,
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
        financialYear: year.finYear,
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
        financialYear: year.finYear,
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
        financialYear: year.finYear,
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
        financialYear: year.finYear,
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
        financialYear: year.finYear,
      });
      promises.push(gstDetailsResponse);

      const ledgerOpeningBalanceResponse = await syncHelperWithDate({
        xml: "LedgerOpeningBalance.xml",
        companyName: name,
        alterId: voucherAlterId,
        fromDate: year.begin,
        toDate: year.end,
        companyGuid,
        yearId,
        financialYear: year.finYear,
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

  if (stopTallySyncCode) {
    return {
      status: false,
      data: { code: stopTallySyncCode },
    };
  }

  const endTime3 = new Date().getTime();
  const timeTaken3 = endTime3 - startTime3;

  info(
    `[sync] Year Function took ${timeTaken3} milliseconds. Total Vouchers: ${totalVouchers}`
  );

  const records = promises.flat();

  let response;

  try {
    response = await uploadLargeArray({
      records,
      master: masterPromises,
      vouchers: voucherPromises,
      gzip: false,
      extras: {
        companies: companies.map((c) => ({
          guid: c.guid,
          name: c.name,
          years: c.years,
          yearIds: c.yearIds,
        })),
        isHardSync,
      },
      sendMessage,
    });
  } catch (err) {
    const apiMessage = err?.response?.data?.message || err?.message;
    const apiCode = err?.response?.data?.code;
    info(`[sync] API Error main`, { err: apiMessage, code: apiCode });
    response = {
      status: false,
      message: apiMessage || "Something went wrong",
      code: apiCode,
      data: err?.response?.data,
    };
  }

  if (!response.status) {
    // V2: Mark sync_run as failed
    if (syncRunId) {
      try {
        await axiosInstance.post('/ingest/sync-run/complete', {
          syncRunId, status: 'failed', errorMessage: response.message || 'Upload failed',
        });
      } catch (err) {
        info('[sync_run] failed-mark failed (non-fatal):', err?.message);
      }
    }
    return {
      status: false,
      data: {
        message: response.message,
        code: response.code || response.data?.code,
      },
      code: response.code || response.data?.code,
      message: response.message,
    };
  }

  // V2: Mark sync_run as completed
  if (syncRunId) {
    try {
      await axiosInstance.post('/ingest/sync-run/complete', {
        syncRunId,
        uploadId: response.uploadId,
        status: 'completed',
      });
      info('[sync_run] completed', { syncRunId });
    } catch (err) {
      info('[sync_run] complete failed (non-fatal):', err?.message);
    }
  }

  store.set("uploadId", response.uploadId);
  return { status: true, data: { code: null, uploadId: response.uploadId } };
};

const stopTallySyncHandler = (code) => {
  stopTallySyncCode = code;
};

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
  syncTallyData,
  stopTallySyncHandler,
  postToTally,
  fetchAndIngestSingleVouchers,
};

// console.dir(json, { depth: null, colors: true, maxArrayLength: null });
