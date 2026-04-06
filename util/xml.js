const { XMLParser } = require("fast-xml-parser");
const path = require("path");
const { readFile } = require("fs").promises;
const axios = require("axios");

const { error, info } = require("./logger");
const store = require("./store");
const createFinancialYears = require("./createFinancialYears");
const { normalizeEnvelope } = require("./tallyHelper");
const { axiosInstance } = require("./helper");

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

  let initRes;
  try {
    initRes = await axiosInstance.post("/ingest/init", {}, { timeout: 15_000 });

    initRes = initRes.data;
  } catch (err) {
    info("[sync] size err", {
      message: err?.response?.data?.message || err?.message,
    });
    return { status: false, message: "Something went wrong" };
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

  let completeRes;

  try {
    completeRes = await axiosInstance.post("/ingest/complete", {
      uploadId,
      ...extras,
    });
    completeRes = completeRes.data;
  } catch (err) {
    info("[sync] completed error", {
      message: err?.response?.data?.message || err?.message,
      code: err.code,
      errno: err.errno,
      address: err.address,
      port: err.port,
      responseStatus: err.response?.status,
      responseData: err.response?.data,
      configUrl: err.config?.baseURL + err.config?.url,
      headersSent: !!err.response,
    });
    return {
      status: false,
      message: err?.response?.data?.message,
      data: err?.response?.data?.data,
    };
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

const initSync = async (companies) => {
  let response;

  try {
    response = await axiosInstance.post("/desktop/init-sync", {
      companies,
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
  const port = store.get("port");
  return `http://localhost:${port}`; // adjust if needed
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

  let attempt = 0;
  while (true) {
    try {
      const response = await axios.post(TALLY_URL, xml, {
        headers: {
          "Content-Type": "text/xml",
          Accept: "application/xml, text/xml, */*",
        },
        timeout: 15000 * 4,
      });
      return { status: true, data: response.data, message: "" };
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
    COMPANY_NAME: companyName,
    XML: xml,
    COMPANY_GUID: companyGuid,
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

  const normalizeData = normalizeEnvelope(json.ENVELOPE).map((item) => ({
    ...item,
    COMPANY_NAME: companyName,
    XML: xml,
    FROM_DATE: fromDate,
    TO_DATE: toDate,
    COMPANY_GUID: companyGuid,
    YEAR_ID: yearId,
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

  const startTime = new Date().getTime();

  let promises = [];
  sendProgress(0);
  sendMessage("Initializing");

  let syncedData = await initSync(companies);

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
    const alterIds = companies.reduce((acc, cv) => {
      acc[cv.guid] = {
        master: 0,
        voucher: cv.allYears.reduce((years, year) => {
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
    yearIds: company.years.map((year) => yearIds[company.id][year.finYear]),
  }));

  // syncedData.masterAlterId.forEach((item) => {
  //   alterIds[item._id].master = item.maxAlterId;
  // });

  // syncedData.voucherAlterId.forEach((item) => {
  //   alterIds[item._id].voucher = item.voucherAlterId;
  // });

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
      const stockresponse = await syncHelperWithDate({
        xml: "StockItemFull.xml",
        companyName: name,
        alterId: voucherAlterId == 0 ? 0 : masterAlterId,
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
    info(`[sync] API Error main`, {
      err: err?.response?.data?.message || err?.message,
    });
    response = {
      status: false,
      message: "Something went wrong",
    };
  }

  if (!response.status) {
    return {
      status: false,
      data: { message: response.message, code: response.data?.code },
    };
  }

  // sendProgress(100);

  store.set("uploadId", response.uploadId);
  return { status: true, data: { code: null, uploadId: response.uploadId } };
};

const stopTallySyncHandler = (code) => {
  stopTallySyncCode = code;
};

module.exports = {
  getCompanyDestinations,
  getCompanies,
  syncTallyData,
  stopTallySyncHandler,
};

// console.dir(json, { depth: null, colors: true, maxArrayLength: null });
