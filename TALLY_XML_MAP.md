# TALLY_XML_MAP.md — td-source/desktop

All XML templates in `xmls/`. Used by `util/xml.js` + `util/tallyHelper.js`.
Sent via HTTP POST to Tally Prime at `http://localhost:9000`.

## Read/Query XMLs (Fetch data from Tally)
| File | Data Fetched |
|------|-------------|
| Companies.xml | Company list |
| CurrentCompany.xml | Current active company |
| TallyDestination.xml | Company data file paths (destinations) |
| Master.xml | All master data (combined) |
| Ledger.xml | Ledger master list |
| LedgerFull.xml | Full ledger details |
| FullLedger.xml | Full ledger with transactions |
| SimplifiedLedger.xml | Simplified ledger data |
| LedgerOpeningBalance.xml | Ledger opening balances per FY ← ACTIVE (V2) |
| LedgerTransaction.xml | Ledger transaction history |
| LedgerTransactionTest.xml | Test variant |
| Group.xml | Ledger group list |
| GroupMaster.xml | Full group master |
| AllVoucher.xml | All vouchers (paginated) |
| Voucher.xml | Single voucher |
| VoucherBill.xml | Voucher with bill details |
| VoucherInventoryDetail.xml | Voucher inventory lines |
| SimplifiedVoucher.xml | Simplified voucher view |
| VoucherType.xml | Voucher type list |
| VoucherTypeFull.xml | Full voucher type details |
| VoucherTest.xml | Test variant |
| StockItem.xml | Stock items |
| StockItemFull.xml | Full stock item details |
| StockGroup.xml | Stock groups |
| StockGroupFull.xml | Full stock group |
| StockCategory.xml | Stock categories |
| StockTransaction.xml | Stock transactions |
| StockTransactionTest.xml | Test variant |
| StockValuation.xml | Stock valuation |
| StockOpeningBalance.xml | Stock opening balances |
| StockFYBalance.xml | Stock FY balances |
| StockGST.xml | Stock GST details |
| StockTest.xml | Test variant |
| Godown.xml | Warehouse/godown list |
| Unit.xml | Units of measurement |
| UnitFull.xml | Full unit details |
| GSTDetails.xml | GST details |
| CompanyGST.xml | Company GST info |
| BillOutstanding.xml | Outstanding bills |
| CostCategory.xml | Cost categories |
| CostCentre.xml | Cost centres |
| CostCentreTransaction.xml | Cost centre transactions |
| CostCentreTransactionTest.xml | Test variant |
| CurrencyMaster.xml | Currency master |
| OpeningBalanceDiff.xml | Opening balance diff |

## Write XMLs (Create/Update data in Tally)
| File | Action |
|------|--------|
| CreateSales.xml | Create sales invoice |
| CreateSalesOrder.xml | Create sales order |
| CreatePurchaseInvoice.xml | Create purchase invoice |
| CreatePurchaseOrder.xml | Create purchase order |
| CreateCreditNote.xml | Create credit note |
| CreateDebitNote.xml | Create debit note |
| CreateDeliveryNote.xml | Create delivery note |
| CreatePayment.xml | Create payment voucher |
| CreateReceipt.xml | Create receipt voucher |
| CreateJournal.xml | Create journal entry |
| CreateContra.xml | Create contra voucher |
| CreateParty.xml | Create party/ledger |
| CreateStockItem.xml | Create stock item |
| CreateWarehouse.xml | Create warehouse/godown |
| DeleteVoucher.xml | Delete a voucher |

## XML Parsing Rules
- All Tally XML response keys are UPPERCASE
- Use `tallyName()` in tallyHelper.js for name normalization
- Stock qty format: `"(-) 20 NOS"` → use `parseTallyQty()` 
- Dr/Cr: read from `ISDEBIT` or `BILLTYPE` fields — never infer from amount sign
- Financial year: included in all V2 records as `_FINANCIAL_YEAR`

## Tally HTTP Interface
- Endpoint: `http://localhost:9000`
- Method: POST
- Content-Type: text/xml
- Response: XML (parsed by xml2js or similar in util/xml.js)
