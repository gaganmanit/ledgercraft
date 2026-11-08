import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { previewTally, restoreTallyArchive } from "../lib/tally-import.js";
import { saveRegistration, saveParty, saveItem, buildGstInvoice, gstVoucher, gstinCheckDigit, assertGstSnapshot } from "../lib/gst.js";
import { planTallyGstPromotion, saveTallyGstMapping, activateTallyGstPromotion, assertTallyGstBook, assertTallyGstOrigins } from "../lib/tally-gst.js";
import { stockState, stockPeriod } from "../lib/stock-engine.js";
import { returnWorkbook } from "../lib/gst-returns.js";
import { validateTransfer } from "../lib/transfer.js";
import { section } from "../lib/reconciliation-common.js";
import { billReport } from "../lib/reconciliation-bills.js";
import { trialBalance, dayBook } from "../lib/engine.js";
import { exportTallyDayBook } from "../lib/tally-export.js";
import { tallyGstFactIndex, sourceTaxFacts } from "../lib/tally-gst-facts.js";
import { needsResources, TALLY_SALES_GST_ZIP } from "./helpers/resources.mjs";

const gstin = (state = "23", pan = "ABCDE1234F") => { const prefix = `${state}${pan}1Z`; return prefix + gstinCheckDigit(prefix); };
const file = text => ({ name: "synthetic-gst.xml", base64: Buffer.from(text).toString("base64") });
const xml = () => `<ENVELOPE><TALLYMESSAGE>
<UNIT NAME="nos"><NAME>nos</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>0</DECIMALPLACES></UNIT>
<GODOWN NAME="Workshop"><NAME>Workshop</NAME><PARENT>Primary</PARENT></GODOWN>
<LEDGER NAME="Source Buyer"><PARENT>Sundry Debtors</PARENT></LEDGER><LEDGER NAME="Source Sales"><PARENT>Sales Accounts</PARENT></LEDGER>
<LEDGER NAME="CGST"><PARENT>Duties &amp; Taxes</PARENT></LEDGER><LEDGER NAME="SGST"><PARENT>Duties &amp; Taxes</PARENT></LEDGER>
${[["Widget", "10", "1000"], ["Gadget", "20", "4000"]].map(([name, q, amount]) => `<STOCKITEM NAME="${name}"><NAME>${name}</NAME><BASEUNITS>nos</BASEUNITS><COSTINGMETHOD>FIFO Perpetual</COSTINGMETHOD><OPENINGBALANCE>${q} nos</OPENINGBALANCE><OPENINGVALUE>${amount}</OPENINGVALUE><BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><OPENINGBALANCE>${Number(q) / 2} nos</OPENINGBALANCE><OPENINGVALUE>${Number(amount) / 2}</OPENINGVALUE></BATCHALLOCATIONS.LIST><BATCHALLOCATIONS.LIST><GODOWNNAME>Workshop</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><OPENINGBALANCE>${Number(q) / 2} nos</OPENINGBALANCE><OPENINGVALUE>${Number(amount) / 2}</OPENINGVALUE></BATCHALLOCATIONS.LIST></STOCKITEM>`).join("")}
<VOUCHER VCHTYPE="Sales"><GUID>synthetic-gst-sale</GUID><DATE>20260401</DATE><VOUCHERNUMBER>101</VOUCHERNUMBER><PARTYLEDGERNAME>Source Buyer</PARTYLEDGERNAME><PARTYGSTIN>23PQRST5678L1Z0</PARTYGSTIN><PLACEOFSUPPLY>Madhya Pradesh</PLACEOFSUPPLY><IRN>source-reference-only</IRN>
${[["Source Buyer", "Yes", "-3540"], ["Source Sales", "No", "3000"], ["CGST", "No", "270"], ["SGST", "No", "270"]].map(([name, sign, amount]) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${name}</LEDGERNAME><ISDEEMEDPOSITIVE>${sign}</ISDEEMEDPOSITIVE><AMOUNT>${amount}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join("")}
${[["Widget", 2, 1000], ["Gadget", 4, 2000]].map(([name, q, amount]) => `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${name}</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><ACTUALQTY>${q} nos</ACTUALQTY><BILLEDQTY>${q} nos</BILLEDQTY><RATE>500/nos</RATE><AMOUNT>${amount}</AMOUNT>${["Main Location", "Workshop"].map(godown => `<BATCHALLOCATIONS.LIST><GODOWNNAME>${godown}</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><ACTUALQTY>${q / 2} nos</ACTUALQTY><BILLEDQTY>${q / 2} nos</BILLEDQTY><AMOUNT>${amount / 2}</AMOUNT></BATCHALLOCATIONS.LIST>`).join("")}</ALLINVENTORYENTRIES.LIST>`).join("")}
</VOUCHER></TALLYMESSAGE></ENVELOPE>`;
function fixture(change = input => input, companions = []) {
  const preview = previewTally([file(change(xml())), ...companions], { companyName: "Synthetic source GST", booksFrom: "2026-04-01" });
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
  const { company, vouchers } = preview;
  const registration = saveRegistration(company, { name: "Synthetic Seller", gstin: gstin(), stateCode: "23", address: "Synthetic local evidence" }, vouchers);
  const customerLedgerId = company.ledgers.find(ledger => ledger.name === "Source Buyer").id;
  const party = saveParty(company, { name: "Source Buyer", gstin: gstin("23", "PQRST5678L"), stateCode: "23", address: "Reviewed synthetic buyer", kind: "customer", customerLedgerId }, vouchers);
  const items = company.stock.masters.map(master => saveItem(company, { ...master, stockItemId: master.id, name: master.name, kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1800 }, vouchers));
  const record = preview.records.find(record => record.type === "VOUCHER");
  const accounts = Object.fromEntries([["party", "Source Buyer"], ["sales", "Source Sales"], ["cgst", "CGST"], ["sgst", "SGST"]].map(([role, name]) => [role, company.ledgers.find(ledger => ledger.name === name).id]));
  const mapping = { recordId: record.recordId, registrationId: registration.id, partyId: party.id, items: items.map(item => ({ sourceName: item.name, itemId: item.id })), accounts, sourceCorrections: { buyerGstin: "Synthetic local buyer registration corrects the source checksum" }, evidence: { name: "Synthetic reviewed mappings", reference: "Synthetic seller registration, corrected buyer checksum and confirmed HSN/rate; not facts supplied by source" } };
  return { ...preview, registration, party, items, mapping, record };
}
function reviewed(book) {
  const mapped = saveTallyGstMapping(book.company, book.vouchers, book.records, { ...book.mapping, requestId: "synthetic-gst-mapping-0001", revision: 0 });
  return { ...book, ...mapped };
}
function active(book = reviewed(fixture())) {
  const plan = planTallyGstPromotion(book.company, book.vouchers, book.records);
  assert.equal(plan.summary.ready, 1, JSON.stringify(plan.rows));
  const input = { requestId: "synthetic-gst-activate-0001", revision: plan.revision, reviewHash: plan.reviewHash, recordIds: [book.record.recordId] };
  return { ...book, ...activateTallyGstPromotion(book.company, book.vouchers, book.records, input), activationInput: input };
}
const stock = book => stockState(book.company, book.vouchers, { to: "2026-04-30" });
const archive = book => ({ format: "financer-tally-archive", version: 1, company: book.company, vouchers: book.vouchers, records: book.records, sources: book.sources, sourceBookHash: null });

test("reviewed source invoice enters real GST/HSN and bills without reposting accounts or stock", () => {
  const source = fixture(), before = stock(source), nativeMasters = structuredClone(source.company.stock.masters), originalPostings = structuredClone(source.vouchers);
  const pending = planTallyGstPromotion(source.company, source.vouchers, source.records);
  assert.equal(pending.summary.blocked, 1);
  const book = active(reviewed(source));
  assert.equal(book.vouchers.length, 1);
  assert.deepEqual(book.vouchers.map(({ gst, ...voucher }) => voucher), originalPostings);
  assert.deepEqual(book.company.stock.masters, nativeMasters);
  const after = stock(book);
  assert.equal(after.items.length, 2, "GST enrichment shares canonical source stock identities");
  assert.deepEqual(after.items.map(item => [item.itemId, item.quantity, item.valuePaise, item.locations]), before.items.map(item => [item.itemId, item.quantity, item.valuePaise, item.locations]));
  assert.equal(after.issues.length, before.issues.length);
  assert.deepEqual(stockPeriod(book.company, book.vouchers, { from: "2026-04-01", to: "2026-04-30" }).financial, stockPeriod(source.company, source.vouchers, { from: "2026-04-01", to: "2026-04-30" }).financial);
  const invoice = book.vouchers[0].gst;
  assert.equal(invoice.totals.taxablePaise, 300000);
  assert.equal(invoice.totals.cgstPaise, 27000);
  assert.equal(invoice.totals.sgstPaise, 27000);
  const returns = returnWorkbook(book.company, book.vouchers, book.registration.id, "2026-04", new Map());
  assert.equal(returns.summary.outwardTaxable.taxablePaise, 300000);
  assert.equal(returns.sheets["b2b,sez,de"].length, 1);
  assert.equal(returns.hsnCheck.reconciliation[0].differencePaise, 0);
  assert.equal(returns.issues.filter(issue => issue.reason === "Accounting voucher has no GST classification").length, 0);
  const bills = billReport(section(book.company.reconciliation), book.company, book.vouchers, "2026-04-30", book.party.customerLedgerId);
  assert.equal(bills.rows.length, 1);
  assert.equal(bills.rows[0].amountPaise, 354000);
  assert.equal(bills.totals[0].differencePaise, 0);
  assert.equal(book.report.summary.active, 1);
  assert.equal(book.result.activated, 1);
  assert.ok(book.company.gst.tallyPromotion.activations[0].targets[0].discrepancies.some(item => item.code === "source-tax-fact-corrected" && item.message.startsWith("buyerGstin:")));
  assert.equal(invoice.tallyOrigin.source.gstin, "23PQRST5678L1Z0");
});

test("retry, stale review, mapping edits and atomic selected bulk activation preserve lineage", () => {
  const book = reviewed(fixture()), previous = structuredClone(book.company.gst.tallyPromotion.mappings[0]);
  const stale = planTallyGstPromotion(book.company, book.vouchers, book.records);
  const mapped = saveTallyGstMapping(book.company, book.vouchers, book.records, { ...book.mapping, evidence: { name: "Second review", reference: "Explicit revised local mapping evidence" }, revision: 1, requestId: "synthetic-gst-mapping-0002" });
  assert.deepEqual(mapped.company.gst.tallyPromotion.mappings[0], previous);
  assert.equal(mapped.company.gst.tallyPromotion.mappings.length, 2);
  assert.throws(() => activateTallyGstPromotion(mapped.company, mapped.vouchers, book.records, { requestId: "synthetic-gst-stale-000001", revision: stale.revision, reviewHash: stale.reviewHash, recordIds: [book.record.recordId] }), /changed/);
  const activated = active({ ...book, ...mapped });
  const replay = activateTallyGstPromotion(activated.company, activated.vouchers, book.records, activated.activationInput);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.company, activated.company);
  assert.deepEqual(replay.vouchers, activated.vouchers);
  assert.throws(() => activateTallyGstPromotion(activated.company, activated.vouchers, book.records, { ...activated.activationInput, recordIds: ["r-other"] }), /different request/);
  assert.throws(() => saveTallyGstMapping(activated.company, activated.vouchers, book.records, { ...book.mapping, revision: 3, requestId: "synthetic-gst-mapping-0003" }), /keeps its reviewed mapping/);
});

test("tax heads, item arithmetic, unreviewed masters and changed financial postings block promotion", () => {
  for (const alter of [
    book => { book.mapping.accounts.sgst = book.mapping.accounts.cgst; },
    book => { [book.mapping.accounts.cgst, book.mapping.accounts.sgst] = [book.mapping.accounts.sgst, book.mapping.accounts.cgst]; },
    book => { book.company.gst.items[0].gstRateBps = 1200; },
    book => { book.company.gst.items[0].stockItemId = undefined; },
    book => { book.company.gst.parties[0].customerLedgerId = book.registration.accounts.sales; },
    book => { book.vouchers[0].lines[0].paise++; },
  ]) {
    const source = fixture(); alter(source);
    try {
      const book = reviewed(source), plan = planTallyGstPromotion(book.company, book.vouchers, book.records);
      assert.equal(plan.summary.ready, 0);
      assert.equal(plan.summary.blocked, 1);
      assert.throws(() => activateTallyGstPromotion(book.company, book.vouchers, book.records, { requestId: "synthetic-gst-blocked-0001", revision: plan.revision, reviewHash: plan.reviewHash, recordIds: [source.record.recordId] }));
    } catch (error) { assert.match(error.message, /distinct GST role|original item identity|original identity|source stock/i); }
  }
  const missing = fixture(input => input.replaceAll(/<ACTUALQTY>[^<]+<\/ACTUALQTY>/g, ""));
  assert.equal(planTallyGstPromotion(missing.company, missing.vouchers, missing.records).summary.ready, 0);
  const changed = reviewed(fixture(input => input.replace("<RATE>500/nos</RATE>", "<RATE>499.99/nos</RATE>")));
  assert.match(planTallyGstPromotion(changed.company, changed.vouchers, changed.records).rows[0].blockers[0].message, /value does not equal/);
});

test("full source and accounting-only backups preserve reviews and reject changed invoice/stock lineage", () => {
  const book = active();
  assertTallyGstBook(book.company, book.vouchers);
  assertTallyGstOrigins(book.company, book.vouchers, book.records);
  const restored = restoreTallyArchive(archive(book));
  assert.deepEqual(restored.vouchers, book.vouchers);
  assert.deepEqual(restored.company.gst.tallyPromotion, book.company.gst.tallyPromotion);
  const accountingOnly = structuredClone(book);
  accountingOnly.company.source.archive = "accounting-only";
  assert.deepEqual(validateTransfer(accountingOnly).vouchers, book.vouchers);
  for (const mutate of [
    changed => { changed.vouchers[0].gst.tallyOrigin.postings.reverse(); },
    changed => { changed.vouchers[0].gst.tallyOrigin.stockLineMap[0] = 1; },
    changed => { changed.company.gst.tallyPromotion.activations = []; },
    changed => { changed.company.stock.journals[0].lines[0].quantity = "2"; },
    changed => { changed.company.gst.tallyPromotion.mappings[0].mapping.evidence.name = "Rewritten"; },
  ]) {
    const changed = structuredClone(book); mutate(changed);
    assert.throws(() => { validateTransfer(changed); assertTallyGstBook(changed.company, changed.vouchers); });
  }
  const changedSource = structuredClone(book);
  changedSource.records.find(item => item.recordId === book.record.recordId).node.children.find(item => item.tag === "PARTYGSTIN").text = gstin();
  assert.throws(() => assertTallyGstOrigins(changedSource.company, changedSource.vouchers, changedSource.records), /preserved original/);
});

test("future native sales and linked physical returns use the same source stock and party ledger", () => {
  const book = active(), original = book.vouchers[0].gst;
  const sale = buildGstInvoice(book.company, book.vouchers, { type: "Sales", registrationId: book.registration.id, partyId: book.party.id, date: "2026-04-02", placeOfSupply: "23", items: [{ itemId: book.items[0].id, quantity: "1", unitPricePaise: 50000 }] }, "v-native-after-source");
  const note = buildGstInvoice(book.company, book.vouchers, { type: "Credit Note", direction: "sales", registrationId: book.registration.id, partyId: book.party.id, date: "2026-04-03", placeOfSupply: "23", originalInvoiceId: original.id, stockEffect: "quantity", items: [{ itemId: book.items[0].id, quantity: "2", unitPricePaise: 50000 }] }, "v-return-source");
  book.vouchers.push(gstVoucher(sale), gstVoucher(note));
  const report = stock(book);
  assert.equal(report.items.find(item => item.itemId === book.items[0].id).quantity, "9");
  assert.equal(report.items.find(item => item.itemId === book.items[0].id).valuePaise, 90000);
  assert.equal(report.issues.length, 0, JSON.stringify(report.issues));
  assert.equal(sale.party.customerLedgerId, book.party.customerLedgerId);
  assertGstSnapshot(book.company, book.vouchers[0]);
  validateTransfer(book);
  assert.equal(trialBalance(book.company, book.vouchers, "2026-04-01", "2026-04-30").difference, 0);
});

test("dated HSN/rate master edits retain original reviewed invoice snapshots through full restore", () => {
  const book = active(), item = book.company.gst.items[0];
  saveItem(book.company, { ...item, gstRateBps: 1200, hsnSac: "8542" }, book.vouchers);
  assertTallyGstOrigins(book.company, book.vouchers, book.records);
  assert.equal(restoreTallyArchive(archive(book)).vouchers[0].gst.items[0].gstRateBps, 1800);
});

test("raw freight adjustments are not inferred as GST and bill-to identity is independent of source POS", () => {
  const adjusted = fixture(input => input.replace('<LEDGER NAME="CGST">', '<LEDGER NAME="Freight"><PARENT>Direct Incomes</PARENT></LEDGER><LEDGER NAME="CGST">').replace("<AMOUNT>-3540</AMOUNT>", "<AMOUNT>-3640</AMOUNT>").replace("<ALLINVENTORYENTRIES.LIST>", "<ALLLEDGERENTRIES.LIST><LEDGERNAME>Freight</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>100</AMOUNT></ALLLEDGERENTRIES.LIST><ALLINVENTORYENTRIES.LIST>"));
  const row = planTallyGstPromotion(adjusted.company, adjusted.vouchers, adjusted.records).rows[0];
  assert.equal(row.source.itemValuePaise, 300000);
  assert.equal(row.source.taxablePaise, null);
  assert.equal(row.source.taxPaise, 54000);
  assert.equal(row.source.unresolvedAdjustmentsPaise, 10000);
  const mapped = reviewed(adjusted);
  assert.equal(planTallyGstPromotion(mapped.company, mapped.vouchers, mapped.records).summary.ready, 0);
  const source = fixture();
  saveParty(source.company, { ...source.party, gstin: gstin("07", "PQRST5678L"), stateCode: "07" }, source.vouchers);
  const book = active(reviewed(source));
  assert.equal(book.vouchers[0].gst.party.stateCode, "07");
  assert.equal(book.vouchers[0].gst.placeOfSupply, "23");
  assert.equal(book.vouchers[0].gst.totals.cgstPaise, 27000);
  assert.throws(() => saveParty(book.company, { ...source.party, id: undefined, name: "Duplicate registration", gstin: gstin("07", "PQRST5678L"), stateCode: "07", customerLedgerId: source.party.customerLedgerId }, book.vouchers), /already linked/);
});

test("documented actual and billed quantities remain distinct in HSN, stock cost and return bounds", () => {
  const changeActual = (input, factor) => input.replace(/<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Widget[\s\S]+?<\/ALLINVENTORYENTRIES.LIST>/, block => block.replace(/<ACTUALQTY>([\d.]+) nos<\/ACTUALQTY>/g, (_, amount) => `<ACTUALQTY>${Number(amount) * factor} nos</ACTUALQTY>`));
  const source = fixture(input => changeActual(input, 2));
  const before = stock(source), book = active(reviewed(source));
  const invoice = book.vouchers[0].gst;
  assert.equal(invoice.items[0].quantity, "2");
  assert.equal(invoice.tallyOrigin.source.items[0].actualQuantity, "4");
  assert.deepEqual(stock(book).items.map(item => [item.quantity, item.valuePaise]), before.items.map(item => [item.quantity, item.valuePaise]));
  assert.ok(book.company.gst.tallyPromotion.activations[0].targets[0].discrepancies.some(item => item.code === "stock-billed-quantity-difference"));
  const note = buildGstInvoice(book.company, book.vouchers, { type: "Credit Note", direction: "sales", registrationId: book.registration.id, partyId: book.party.id, date: "2026-04-03", placeOfSupply: "23", originalInvoiceId: invoice.id, stockEffect: "quantity", items: [{ itemId: book.items[0].id, quantity: "2", unitPricePaise: 50000 }] }, "v-split-qty-return");
  const afterReturn = stockState(book.company, [...book.vouchers, gstVoucher(note)], { to: "2026-04-30" });
  assert.equal(afterReturn.items.find(item => item.itemId === book.items[0].id).valuePaise, 80000);
  assert.equal(afterReturn.issues.length, 0);
  const fewer = active(reviewed(fixture(input => changeActual(input, 0.5).replace("<DECIMALPLACES>0", "<DECIMALPLACES>1"))));
  assert.throws(() => buildGstInvoice(fewer.company, fewer.vouchers, { type: "Credit Note", direction: "sales", registrationId: fewer.registration.id, partyId: fewer.party.id, date: "2026-04-03", placeOfSupply: "23", originalInvoiceId: fewer.vouchers[0].id, stockEffect: "quantity", items: [{ itemId: fewer.items[0].id, quantity: "2", unitPricePaise: 50000 }] }, "v-excess-physical-return"), /return quantity/);
});

async function officialFixture(useBilledAsActual, companions = []) {
  const bytes = await readFile(new URL("fixtures/tally-xlsx/Tally-Sales-GST-Template.zip", import.meta.url));
  const book = previewTally([{ name: "Tally-Sales-GST-Template.zip", base64: bytes.toString("base64") }, ...companions], { companyName: "Public workbook with synthetic reviewed masters", booksFrom: "2023-04-01", useBilledAsActual });
  assert.equal(book.canCommit, true, JSON.stringify(book.issues));
  const registration = saveRegistration(book.company, { name: "Synthetic Haryana Seller", gstin: gstin("06"), stateCode: "06", address: "Synthetic public-fixture evidence" }, book.vouchers);
  for (const master of book.company.stock.masters) saveItem(book.company, { stockItemId: master.id, name: master.name, kind: "goods", hsnSac: "9608", unit: "NOS", openingQuantity: master.openingQuantity, gstRateBps: 1800 }, book.vouchers);
  const rows = planTallyGstPromotion(book.company, book.vouchers, book.records).rows;
  let working = book;
  for (const row of rows) {
    const original = row.source.gstin;
    const corrected = original.slice(0, 14) + gstinCheckDigit(original.slice(0, 14));
    const party = saveParty(working.company, { name: `${row.source.partyName} ${row.source.placeOfSupply}`, gstin: corrected, stateCode: row.source.placeOfSupply, address: "Synthetic local mapping, original source retained", kind: "customer", customerLedgerId: row.source.partyLedgerId }, working.vouchers);
    const accounts = {};
    for (const line of row.source.postings) accounts[line.dc === "Dr" ? "party" : /cgst/i.test(line.name) ? "cgst" : /sgst/i.test(line.name) ? "sgst" : /igst/i.test(line.name) ? "igst" : "sales"] = line.ledgerId;
    const mapping = { recordId: row.recordId, registrationId: registration.id, partyId: party.id, items: row.source.items.map(item => ({ sourceName: item.sourceName, itemId: working.company.gst.items.find(master => master.name === item.sourceName).id })), accounts, stockMode: useBilledAsActual ? "source" : "report-only", ...(row.source.gstinChecksumValid === false ? { sourceCorrections: { buyerGstin: "Synthetic local buyer master explicitly corrects the original public-sample checksum" } } : {}), evidence: { name: "Synthetic local public-workbook review", reference: "Synthetic seller GSTIN, source buyer checksum correction and HSN 9608/rate 18% are testing mappings, not facts established by Tally's source workbook" } };
    const saved = saveTallyGstMapping(working.company, working.vouchers, book.records, { ...mapping, requestId: `public-source-mapping-${row.number}`, revision: working.company.gst.tallyPromotion?.revision || 0 });
    working = { ...working, ...saved };
  }
  return { ...working, registration };
}

for (const stockMode of ["source", "report-only"]) test(`official four invoices activate in ${stockMode} mode with exact source tax, ten HSN lines and full restore`, async (t) => {
  if (!needsResources(t, TALLY_SALES_GST_ZIP)) return;
  const book = await officialFixture(stockMode === "source"), before = stockState(book.company, book.vouchers, { to: "2023-04-30" });
  const originalPostings = structuredClone(book.vouchers);
  const plan = planTallyGstPromotion(book.company, book.vouchers, book.records);
  assert.equal(plan.summary.ready, 4, JSON.stringify(plan.rows.map(row => row.blockers)));
  assert.equal(plan.summary.taxablePaise, 2720000);
  assert.equal(plan.summary.taxPaise, 489600);
  assert.equal(plan.rows.flatMap(row => row.source.items).length, 10);
  const input = { requestId: `public-four-activate-${stockMode}`, revision: plan.revision, reviewHash: plan.reviewHash, recordIds: plan.rows.map(row => row.recordId) };
  const activated = activateTallyGstPromotion(book.company, book.vouchers, book.records, input);
  assert.equal(activated.result.activated, 4);
  assert.deepEqual(activated.vouchers.map(({ gst, ...voucher }) => voucher), originalPostings);
  assert.equal(activateTallyGstPromotion(activated.company, activated.vouchers, book.records, input).replayed, true);
  const report = returnWorkbook(activated.company, activated.vouchers, book.registration.id, "2023-04", new Map());
  assert.equal(report.summary.outwardTaxable.taxablePaise, 2720000);
  assert.equal(report.summary.outwardTaxable.cgstPaise, 45000);
  assert.equal(report.summary.outwardTaxable.sgstPaise, 45000);
  assert.equal(report.summary.outwardTaxable.igstPaise, 399600);
  assert.equal(report.sheets["b2b,sez,de"].length, 4);
  assert.equal(report.hsnCheck.reconciliation[0].differencePaise, 0);
  const after = stockState(activated.company, activated.vouchers, { to: "2023-04-30" });
  assert.deepEqual(after.items.map(item => [item.quantity, item.valuePaise]), before.items.map(item => [item.quantity, item.valuePaise]));
  assert.equal(after.issues.length, before.issues.length);
  if (stockMode === "report-only") { assert.equal(activated.company.stock.tally.hasSourceGaps, true); assert.ok(activated.vouchers.every(voucher => voucher.gst.stockEffect === "none")); }
  assertTallyGstOrigins(activated.company, activated.vouchers, book.records);
  const restored = restoreTallyArchive(archive({ ...book, ...activated }));
  assert.deepEqual(restored.vouchers, activated.vouchers);
  assert.ok(activated.vouchers.some(voucher => voucher.gst.tallyOrigin.source.gstinChecksumValid === false));
  assert.ok(activated.vouchers.every(voucher => voucher.gst.tallyOrigin.source.transportStatus === "source-unverified" && !voucher.gstExchange));
  assert.ok(activated.vouchers.every(voucher => voucher.gst.tallyOrigin.source.workbookRows.length));
  const bills = billReport(section(activated.company.reconciliation), activated.company, activated.vouchers, "2023-04-30");
  assert.equal(bills.rows.length, 4);
  assert.equal(bills.rows.reduce((total, row) => total + row.amountPaise, 0), 3209600);
  assert.ok(bills.totals.every(row => row.differencePaise === 0));
  assert.ok(activated.report.rows.every(row => row.discrepancies.filter(item => item.code === "duplicate-source-reference").length === 3));
});

test("bulk selection with an unsupported fourth source invoice leaves all original vouchers unpromoted", async (t) => {
  if (!needsResources(t, TALLY_SALES_GST_ZIP)) return;
  const book = await officialFixture(true), fourth = planTallyGstPromotion(book.company, book.vouchers, book.records).rows[3];
  const wrong = { ...fourth.mapping, accounts: { ...fourth.mapping.accounts, igst: book.registration.accounts["output-igst"] } };
  const changed = saveTallyGstMapping(book.company, book.vouchers, book.records, { ...wrong, requestId: "public-fourth-unsupported", revision: book.company.gst.tallyPromotion.revision });
  const plan = planTallyGstPromotion(changed.company, changed.vouchers, book.records), original = structuredClone(changed);
  assert.equal(plan.summary.ready, 3);
  assert.equal(plan.summary.blocked, 1);
  assert.throws(() => activateTallyGstPromotion(changed.company, changed.vouchers, book.records, { requestId: "public-all-or-none-activate", revision: plan.revision, reviewHash: plan.reviewHash, recordIds: plan.rows.map(row => row.recordId) }), /every source posting/);
  assert.deepEqual(changed, original);
  assert.ok(changed.vouchers.every(voucher => !voucher.gst));
});

test("real supporting native GST masters corroborate the public workbook by date and survive later HSN/rate edits", async (t) => {
  if (!needsResources(t, TALLY_SALES_GST_ZIP)) return;
  const support = await readFile(new URL("fixtures/tally-gst-support.xml", import.meta.url));
  const book = await officialFixture(true, [{ name: "Synthetic-GST-Support.xml", base64: support.toString("base64") }]);
  const marker = book.company.gst.items.find(item => item.name === "Marker-Blue");
  saveItem(book.company, { ...marker, hsnSac: "8541", gstRateBps: 1200 }, book.vouchers);
  const plan = planTallyGstPromotion(book.company, book.vouchers, book.records), row = plan.rows.find(row => row.number === "101");
  assert.equal(plan.summary.ready, 4, JSON.stringify(plan.rows.map(row => row.blockers)));
  assert.equal(row.source.taxFacts.sellerGstin.status, "supplied");
  assert.equal(row.source.taxFacts.sellerGstin.value, book.registration.gstin);
  const item = row.source.taxFacts.items.find(item => item.sourceName === "Marker-Blue");
  assert.equal(item.hsnSac.value, "96082000");
  assert.equal(item.gstRateBps.value, 1800);
  assert.equal(item.gstRateBps.evidence[0].effectiveFrom, "2023-04-01");
  assert.match(item.hsnSac.evidence[0].fieldPath, /HSNDETAILS\[0\]\/HSNCODE/);
  assert.equal(item.hsnSac.evidence[0].file, "Synthetic-GST-Support.xml");
  assert.equal(item.hsnSac.evidence[0].effectiveSourceValue, "20230401");
  assert.ok(item.hsnSac.superseded.some(proof => proof.reason === "future-effective"));
  assert.equal(row.suggestions.items.find(item => item.sourceName === "Marker-Blue").hsnSac, "96082000");
  const active = activateTallyGstPromotion(book.company, book.vouchers, book.records, { requestId: "source-supported-four-activate", revision: plan.revision, reviewHash: plan.reviewHash, recordIds: plan.rows.map(row => row.recordId) });
  const invoice = active.vouchers.find(voucher => voucher.number === "101").gst;
  assert.equal(invoice.items[0].hsnSac, "96082000");
  assert.equal(invoice.items[0].gstRateBps, 1800);
  assert.equal(active.company.gst.items.find(item => item.id === marker.id).hsnSac, "8541", "Historical source selection does not rewrite today's master");
  const review = invoice.tallyOrigin.taxFactReview.find(item => item.field === "item:Marker-Blue:hsnSac");
  assert.equal(review.chosenBasis, "source");
  assert.equal(review.localMasterValue, "8541");
  assert.ok(!invoice.tallyOrigin.discrepancies.some(item => item.code === "source-tax-fact-absent" && item.message.startsWith("item:Marker-Blue:hsnSac")));
  saveItem(active.company, { ...active.company.gst.items.find(item => item.id === marker.id), hsnSac: "96081000", gstRateBps: 500 }, active.vouchers);
  assertTallyGstOrigins(active.company, active.vouchers, book.records);
  assert.deepEqual(restoreTallyArchive(archive({ ...book, ...active })).vouchers, active.vouchers);
  const index = tallyGstFactIndex(book.records), record = book.records.find(record => record.recordId === row.recordId);
  const before = sourceTaxFacts(index, record, "2023-03-31", row.source.items), boundary = sourceTaxFacts(index, record, "2023-05-01", row.source.items);
  assert.equal(before.items[0].gstRateBps.status, "absent");
  assert.equal(boundary.items[0].gstRateBps.value, 1200);
  assert.equal(boundary.items[0].hsnSac.value, "96081000");
});

const nativeRate = (rate = 18, extra = "", from = "20260401", state = "Any") => `<GSTDETAILS.LIST><APPLICABLEFROM>${from}</APPLICABLEFROM><TAXABILITY>Taxable</TAXABILITY><SUPPLYTYPE>Goods</SUPPLYTYPE><STATEWISEDETAILS.LIST><STATENAME>${state}</STATENAME><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE><GSTRATE>${rate}</GSTRATE></RATEDETAILS.LIST>${extra}</STATEWISEDETAILS.LIST></GSTDETAILS.LIST>`;
const addWidgetFacts = (input, facts, override = "") => input.replace('<STOCKITEM NAME="Widget"><NAME>Widget</NAME>', `<STOCKITEM NAME="Widget"><NAME>Widget</NAME>${facts}`).replace('<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Widget</STOCKITEMNAME>', `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Widget</STOCKITEMNAME>${override}`);

test("invoice-specific HSN/rate overrides outrank conflicting masters and preserve both exact source fields", () => {
  const book = fixture(input => addWidgetFacts(input, `<HSNDETAILS.LIST><APPLICABLEFROM>20260401</APPLICABLEFROM><HSNCODE>0101</HSNCODE></HSNDETAILS.LIST>${nativeRate(12)}`, `<GSTHSNNAME>0102</GSTHSNNAME>${nativeRate(18)}`));
  const reviewedBook = reviewed(book), plan = planTallyGstPromotion(reviewedBook.company, reviewedBook.vouchers, book.records);
  const facts = plan.rows[0].source.taxFacts.items[0];
  assert.equal(facts.hsnSac.value, "0102");
  assert.equal(facts.gstRateBps.value, 1800);
  assert.ok(facts.hsnSac.superseded.some(proof => proof.sourceValue === "0101" && proof.reason === "invoice-override"));
  assert.ok(facts.gstRateBps.superseded.some(proof => proof.sourceValue === "12" && proof.reason === "invoice-override"));
  assert.match(facts.hsnSac.evidence[0].fieldPath, /VOUCHER\/ALLINVENTORYENTRIES\[0\]\/GSTHSNNAME/);
  assert.equal(facts.hsnSac.evidence[0].effectiveSourceValue, "20260401");
  const activeBook = active(reviewedBook);
  assert.equal(activeBook.vouchers[0].gst.items[0].hsnSac, "0102");
  assert.ok(activeBook.vouchers[0].gst.tallyOrigin.discrepancies.some(item => item.code === "source-invoice-override"));
  assertTallyGstOrigins(activeBook.company, activeBook.vouchers, book.records);
});

test("ambiguous, undated, wrong-state and service-classified source rates never become automatic suggestions", () => {
  const conflictingHead = `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE><GSTRATE>12</GSTRATE></RATEDETAILS.LIST>`;
  const cases = [nativeRate(18, conflictingHead), nativeRate(18).replace("<APPLICABLEFROM>20260401</APPLICABLEFROM>", ""), nativeRate(18, "", "20260401", "Haryana"), nativeRate(18).replace("<SUPPLYTYPE>Goods", "<SUPPLYTYPE>Services")];
  for (const facts of cases) {
    const book = fixture(input => addWidgetFacts(input, facts)), mapped = reviewed(book), plan = planTallyGstPromotion(mapped.company, mapped.vouchers, book.records);
    assert.equal(plan.rows[0].source.taxFacts.items[0].gstRateBps.status, "conflict");
    assert.equal(plan.rows[0].suggestions.items.find(item => item.sourceName === "Widget")?.gstRateBps, undefined);
    assert.equal(plan.summary.ready, 0);
    assert.match(plan.rows[0].blockers[0].message, /gstRateBps.*require review/);
  }
  const book = fixture(input => addWidgetFacts(input, nativeRate(18, conflictingHead)));
  book.mapping.sourceCorrections["item:Widget:gstRateBps"] = "Reviewed local rate 18% corrects two conflicting source rate heads";
  const activeBook = active(reviewed(book));
  assert.equal(activeBook.vouchers[0].gst.items[0].gstRateBps, 1800);
  assert.equal(activeBook.vouchers[0].gst.tallyOrigin.taxFactReview.find(item => item.field === "item:Widget:gstRateBps").status, "corrected");
});

function gstSupportWorkbook(dateHeader = "GST Details - Applicable From", rate = "18") {
  const headers = ["Name", "Units", "HSN/SAC", dateHeader, "GST Rate (%)", "GST Type of Supply", "Taxability"];
  const row = ["Widget", "nos", { number: "101", style: 1 }, "2026-04-01", rate, "Goods", "Taxable"];
  const render = (cells, number) => `<row r="${number}">${cells.map((cell, index) => `<c r="${String.fromCharCode(65 + index)}${number}"${typeof cell === "object" ? ` s="${cell.style}"><v>${cell.number}</v>` : ` t="inlineStr"><is><t>${cell}</t></is>`}</c>`).join("")}</row>`;
  const entries = [
    ["[Content_Types].xml", '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'],
    ["_rels/.rels", '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Stock Items" sheetId="1" r:id="r1"/></sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ["xl/styles.xml", '<styleSheet><numFmts><numFmt numFmtId="165" formatCode="0000"/><numFmt numFmtId="166" formatCode="0%"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="165"/><xf numFmtId="166"/></cellXfs></styleSheet>'],
    ["xl/worksheets/sheet1.xml", `<worksheet><sheetData>${render(headers, 1)}${render(row, 2)}</sheetData></worksheet>`],
  ];
  const files = [], directory = []; let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(text), header = Buffer.alloc(30), central = Buffer.alloc(46), checksum = crc32(bytes);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    files.push(header, filename, bytes); directory.push(central, filename); offset += header.length + filename.length + bytes.length;
  }
  const end = Buffer.alloc(22), listing = Buffer.concat(directory); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(listing.length, 12); end.writeUInt32LE(offset, 16);
  return { name: "Synthetic-Explicit-GST.xlsx", base64: Buffer.concat([...files, listing, end]).toString("base64") };
}
test("actual Excel HSN/rate cells retain formatted leading zeros and GST dates never borrow standard-cost dates", () => {
  const withoutWidget = input => input.replace(/<STOCKITEM NAME="Widget">[\s\S]+?<\/STOCKITEM>/, "");
  const book = fixture(withoutWidget, [gstSupportWorkbook()]), plan = planTallyGstPromotion(book.company, book.vouchers, book.records), facts = plan.rows[0].source.taxFacts.items[0];
  assert.equal(facts.hsnSac.value, "0101");
  assert.equal(facts.gstRateBps.value, 1800);
  assert.equal(facts.hsnSac.evidence[0].fieldPath, "XLSX:Stock Items!C2");
  assert.equal(facts.hsnSac.evidence[0].rawValue, "101");
  assert.equal(facts.hsnSac.evidence[0].numberFormat, "0000");
  assert.equal(facts.gstRateBps.evidence[0].effectiveFieldPath, "XLSX:Stock Items!D2");
  const activated = active(reviewed(book));
  assert.equal(activated.vouchers[0].gst.items[0].hsnSac, "0101");
  assert.deepEqual(restoreTallyArchive(archive(activated)).vouchers, activated.vouchers);
  const wrongDate = fixture(withoutWidget, [gstSupportWorkbook("Standard Cost - Applicable From")]);
  const rate = planTallyGstPromotion(wrongDate.company, wrongDate.vouchers, wrongDate.records).rows[0].source.taxFacts.items[0].gstRateBps;
  assert.equal(rate.status, "conflict");
  assert.match(rate.issues.join(" "), /Undated master GST/);
  const percentCell = fixture(withoutWidget, [gstSupportWorkbook(undefined, { number: "0.07", style: 2 })]);
  assert.equal(planTallyGstPromotion(percentCell.company, percentCell.vouchers, percentCell.records).rows[0].source.taxFacts.items[0].gstRateBps.value, 700, "Excel percent formatting is converted in exact decimal arithmetic");
});

function reusedNumber(date = "20270401") {
  return fixture(input => input.replace(/<VOUCHER VCHTYPE="Sales">[\s\S]+?<\/VOUCHER>/, block => block + block.replace("synthetic-gst-sale", "synthetic-gst-sale-second").replace("<DATE>20260401</DATE>", `<DATE>${date}</DATE>`)));
}
function reviewReused(book, secondRegistrationId = book.registration.id) {
  const first = reviewed(book), second = book.records.filter(record => record.type === "VOUCHER")[1];
  const saved = saveTallyGstMapping(first.company, first.vouchers, book.records, { ...book.mapping, recordId: second.recordId, registrationId: secondRegistrationId, revision: first.company.gst.tallyPromotion.revision, requestId: "synthetic-reused-number-map2" });
  return { ...book, ...saved };
}
function activateAll(book) {
  const plan = planTallyGstPromotion(book.company, book.vouchers, book.records);
  return activateTallyGstPromotion(book.company, book.vouchers, book.records, { requestId: "synthetic-reused-number-activate", revision: plan.revision, reviewHash: plan.reviewHash, recordIds: plan.rows.map(row => row.recordId) });
}
test("reused statutory invoice numbers across financial years keep literal GST IDs and unchanged internal daybook identities", () => {
  const source = reusedNumber(), book = reviewReused(source), original = structuredClone(source.vouchers);
  assert.match(book.vouchers[1].number, /^101~/);
  const plan = planTallyGstPromotion(book.company, book.vouchers, book.records);
  assert.equal(plan.rows[1].sourceNumber, "101");
  assert.equal(plan.summary.ready, 2, JSON.stringify(plan.rows));
  const active = activateAll(book);
  assert.deepEqual(active.vouchers.map(voucher => voucher.gst.number), ["101", "101"]);
  assert.deepEqual(active.vouchers.map(({ gst, ...voucher }) => voucher), original);
  for (const year of [2026, 2027]) assert.equal(returnWorkbook(active.company, active.vouchers, book.registration.id, `${year}-04`, new Map()).sheets["b2b,sez,de"][0][2], "101");
  assert.deepEqual(dayBook(active.company, active.vouchers, "2026-04-01", "2027-04-30").map(voucher => voucher.number), original.map(voucher => voucher.number));
  const bills = billReport(section(active.company.reconciliation), active.company, active.vouchers, "2027-04-30", book.party.customerLedgerId);
  assert.deepEqual(bills.rows.map(row => row.reference), ["101", "101"]);
  assert.equal(bills.rows.reduce((total, row) => total + row.amountPaise, 0), 708000);
  assert.equal(bills.totals[0].differencePaise, 0);
  const xml = exportTallyDayBook(active.company, active.vouchers, "2026-04-01", "2027-04-30");
  assert.ok(xml.includes(`<VOUCHERNUMBER>${original[1].number}</VOUCHERNUMBER>`));
  assert.deepEqual(restoreTallyArchive(archive({ ...book, ...active })).vouchers, active.vouchers);
  const tampered = structuredClone(active);
  tampered.vouchers[1].source.originalNumber = tampered.vouchers[1].number;
  assert.throws(() => validateTransfer(tampered), /source GST invoice/);
});
test("same-year same-registration duplicate statutory number rejects the whole bulk; another registration can reuse it", () => {
  const sameYear = reviewReused(reusedNumber("20260402")), original = structuredClone(sameYear.vouchers);
  assert.throws(() => activateAll(sameYear), /invoice number is already used/);
  assert.deepEqual(sameYear.vouchers, original);
  const separate = reusedNumber("20260402"), registration = saveRegistration(separate.company, { name: "Second synthetic seller", gstin: gstin("23", "KLMNO4321P"), stateCode: "23", address: "Separate synthetic registration", invoicePrefix: "R2" }, separate.vouchers);
  const book = reviewReused(separate, registration.id), active = activateAll(book);
  assert.equal(active.result.activated, 2);
  assert.deepEqual(active.vouchers.map(voucher => voucher.gst.number), ["101", "101"]);
  assert.notEqual(active.vouchers[0].gst.registrationId, active.vouchers[1].gst.registrationId);
  assert.deepEqual(restoreTallyArchive(archive({ ...book, ...active })).vouchers, active.vouchers);
});
