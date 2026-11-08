import assert from "node:assert/strict";
import test from "node:test";
import { previewTally, restoreTallyArchive } from "../lib/tally-import.js";
import { saveRegistration, saveParty, saveItem, gstinCheckDigit } from "../lib/gst.js";
import { planTallyGstPromotion, saveTallyGstMapping, activateTallyGstPromotion, assertTallyGstBook, assertTallyGstOrigins } from "../lib/tally-gst.js";
import { stockState, stockPeriod } from "../lib/stock-engine.js";
import { returnWorkbook } from "../lib/gst-returns.js";
import { trialBalance } from "../lib/engine.js";
import { validateTransfer } from "../lib/transfer.js";
import { itcState } from "../lib/gst-itc.js";

const gstin = (state = "23", pan = "ABCDE1234F") => { const prefix = `${state}${pan}1Z`; return prefix + gstinCheckDigit(prefix); };
const supplierGstin = gstin("23", "PQRST5678L");
const xml = () => `<ENVELOPE><TALLYMESSAGE>
<COMPANY NAME="Synthetic Purchase Books"><NAME>Synthetic Purchase Books</NAME><GSTREGISTRATIONNUMBER>${gstin()}</GSTREGISTRATIONNUMBER></COMPANY>
<UNIT NAME="nos"><NAME>nos</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>0</DECIMALPLACES></UNIT>
<GODOWN NAME="Workshop"><NAME>Workshop</NAME><PARENT>Primary</PARENT></GODOWN>
<LEDGER NAME="Source Supplier"><PARENT>Sundry Creditors</PARENT><PARTYGSTIN>${supplierGstin}</PARTYGSTIN></LEDGER>
<LEDGER NAME="Source Purchases"><PARENT>Purchase Accounts</PARENT></LEDGER>
<LEDGER NAME="Input CGST"><PARENT>Duties &amp; Taxes</PARENT></LEDGER><LEDGER NAME="Input SGST"><PARENT>Duties &amp; Taxes</PARENT></LEDGER>
<STOCKITEM NAME="Widget"><NAME>Widget</NAME><BASEUNITS>nos</BASEUNITS><COSTINGMETHOD>FIFO Perpetual</COSTINGMETHOD><OPENINGBALANCE>0 nos</OPENINGBALANCE><OPENINGVALUE>0</OPENINGVALUE></STOCKITEM>
<VOUCHER VCHTYPE="Purchase"><GUID>synthetic-gst-purchase</GUID><DATE>20260403</DATE><VOUCHERNUMBER>P-101</VOUCHERNUMBER><REFERENCE>SUP-209</REFERENCE><REFERENCEDATE>20260331</REFERENCEDATE><PARTYLEDGERNAME>Source Supplier</PARTYLEDGERNAME><PARTYGSTIN>${supplierGstin}</PARTYGSTIN><CMPGSTIN>${gstin()}</CMPGSTIN><PLACEOFSUPPLY>Madhya Pradesh</PLACEOFSUPPLY><IRN>source-supplier-reference-only</IRN>
${[["Source Supplier", "No", "1180"], ["Source Purchases", "Yes", "-1000"], ["Input CGST", "Yes", "-90"], ["Input SGST", "Yes", "-90"]].map(([name, sign, amount]) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${name}</LEDGERNAME><ISDEEMEDPOSITIVE>${sign}</ISDEEMEDPOSITIVE><AMOUNT>${amount}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join("")}
<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Widget</STOCKITEMNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ACTUALQTY>3 nos</ACTUALQTY><BILLEDQTY>2 nos</BILLEDQTY><RATE>500/nos</RATE><AMOUNT>-1000</AMOUNT>
${[["Main Location", 1], ["Workshop", 2]].map(([godown, quantity]) => `<BATCHALLOCATIONS.LIST><GODOWNNAME>${godown}</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><ACTUALQTY>${quantity} nos</ACTUALQTY><BILLEDQTY>1 nos</BILLEDQTY><AMOUNT>-500</AMOUNT></BATCHALLOCATIONS.LIST>`).join("")}</ALLINVENTORYENTRIES.LIST>
</VOUCHER></TALLYMESSAGE></ENVELOPE>`;
function fixture(change = input => input) {
  const text = change(xml());
  const preview = previewTally([{ name: "synthetic-purchase.xml", base64: Buffer.from(text).toString("base64") }], { companyName: "Synthetic Purchase Books", booksFrom: "2026-04-01" });
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
  const { company, vouchers } = preview;
  const registration = saveRegistration(company, { name: "Synthetic Buyer", gstin: gstin(), stateCode: "23", address: "Synthetic buyer registration" }, vouchers);
  const ledger = name => company.ledgers.find(row => row.name === name).id;
  const sourceGstin = /<PARTYGSTIN>([^<]+)<\/PARTYGSTIN>/.exec(text)[1];
  const party = saveParty(company, { name: "Source Supplier", gstin: sourceGstin, stateCode: sourceGstin.slice(0, 2), address: "Synthetic supplier registration", kind: "supplier", supplierLedgerId: ledger("Source Supplier") }, vouchers);
  const master = company.stock.masters[0];
  const item = saveItem(company, { ...master, stockItemId: master.id, name: master.name, kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1800 }, vouchers);
  const record = preview.records.find(row => row.type === "VOUCHER");
  const accounts = Object.fromEntries([["party", "Source Supplier"], ["purchase", "Source Purchases"], ["cgst", "Input CGST"], ["sgst", "Input SGST"], ["igst", "Input IGST"]].filter(([, name]) => company.ledgers.some(row => row.name === name)).map(([role, name]) => [role, ledger(name)]));
  const mapping = { recordId: record.recordId, registrationId: registration.id, partyId: party.id, items: [{ sourceName: "Widget", itemId: item.id }], accounts,
    purchaseReview: { receivedDate: "2026-04-02", itcEligibility: "pending" }, evidence: { name: "Synthetic purchase review", reference: "Synthetic supplier invoice, receipt and local HSN/rate mapping" } };
  return { ...preview, registration, party, item, record, mapping };
}
function reviewed(book) {
  return { ...book, ...saveTallyGstMapping(book.company, book.vouchers, book.records, { ...book.mapping, revision: 0, requestId: "purchase-mapping-test-0001" }) };
}
function active(book = reviewed(fixture())) {
  const plan = planTallyGstPromotion(book.company, book.vouchers, book.records);
  assert.equal(plan.summary.ready, 1, JSON.stringify(plan.rows));
  const input = { revision: plan.revision, reviewHash: plan.reviewHash, recordIds: [book.record.recordId], requestId: "purchase-activate-test-0001" };
  return { ...book, ...activateTallyGstPromotion(book.company, book.vouchers, book.records, input), activationInput: input };
}
const stock = book => stockState(book.company, book.vouchers, { to: "2026-04-30" });
const archive = book => ({ format: "financer-tally-archive", version: 1, company: book.company, vouchers: book.vouchers, records: book.records, sources: book.sources, sourceBookHash: null });

test("regular domestic purchase promotes supplier GST and one receipt without reposting or claiming ITC", () => {
  const original = fixture(), postings = structuredClone(original.vouchers), journals = structuredClone(original.company.stock.journals);
  const before = stock(original), beforeTrial = trialBalance(original.company, original.vouchers, "2026-04-30");
  const book = active(reviewed(original)), invoice = book.vouchers[0].gst;
  assert.deepEqual(book.vouchers.map(({ gst, ...voucher }) => voucher), postings);
  assert.deepEqual(book.company.stock.journals, journals);
  assert.deepEqual(trialBalance(book.company, book.vouchers, "2026-04-30"), beforeTrial);
  assert.equal(invoice.direction, "purchase");
  assert.equal(invoice.tallyOrigin.version, 2);
  assert.equal(invoice.number, "P-101");
  assert.equal(invoice.supplierInvoiceNumber, "SUP-209");
  assert.equal(invoice.supplierInvoiceDate, "2026-03-31");
  assert.equal(invoice.date, "2026-04-03");
  assert.equal(invoice.receivedDate, "2026-04-02");
  assert.equal(invoice.itcEligibility, "pending");
  assert.equal(invoice.tallyOrigin.source.taxFacts.sellerGstin.value, supplierGstin);
  assert.equal(invoice.tallyOrigin.source.taxFacts.buyerGstin.value, gstin());
  assert.equal(invoice.items[0].quantity, "2");
  assert.equal(invoice.tallyOrigin.source.items[0].actualQuantity, "3");
  assert.equal(invoice.totals.taxablePaise, 100000);
  assert.equal(invoice.totals.taxPaise, 18000);
  const after = stock(book);
  assert.equal(after.items[0].quantity, before.items[0].quantity);
  assert.equal(after.items[0].quantity, "3");
  assert.equal(book.company.stock.journals.length, 1);
  assert.equal(book.company.stock.journals[0].type, "receipt");
  assert.equal(book.company.stock.journals[0].financialKind, "purchase");
  assert.ok(book.company.stock.journals[0].lines.every(line => line.revenuePaise === undefined && line.valuePaise === 50000));
  const period = stockPeriod(book.company, book.vouchers, { from: "2026-04-01", to: "2026-04-30" });
  assert.equal(period.financial.netPurchasesPaise, 100000);
  assert.ok(after.items[0].movements.every(row => row.financialKind !== "sale"));
  assert.deepEqual(after.items[0].godowns.map(row => [row.godownId, row.quantity, row.knownValuePaise]), before.items[0].godowns.map(row => [row.godownId, row.quantity, row.knownValuePaise]));
  const returns = returnWorkbook(book.company, book.vouchers, book.registration.id, "2026-04", new Map());
  assert.equal(returns.summary.purchases.taxablePaise, 100000);
  assert.equal(returns.summary.pendingInput.cgstPaise + returns.summary.pendingInput.sgstPaise, 18000);
  assert.equal(returns.itc.reviewedNet.cgstPaise + returns.itc.reviewedNet.sgstPaise, 0);
  const itc = itcState(book.company, book.vouchers, "2026-04-30");
  assert.equal(itc.documents[0].initialEligibility, "pending");
  assertTallyGstOrigins(book.company, book.vouchers, book.records);
  const replay = activateTallyGstPromotion(book.company, book.vouchers, book.records, book.activationInput);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.vouchers, book.vouchers);
});

test("purchase source supplier references and dates require evidence and preserve corrections", () => {
  const missing = fixture(input => input.replace("<REFERENCE>SUP-209</REFERENCE><REFERENCEDATE>20260331</REFERENCEDATE>", ""));
  const pending = reviewed(missing);
  assert.match(pending.report.rows[0].blockers[0].message, /supplier invoice number and supplier invoice date/);
  missing.mapping.purchaseReview = { supplierInvoiceNumber: "REVIEW-209", supplierInvoiceDate: "2026-03-30", receivedDate: "2026-04-02", itcEligibility: "pending" };
  const book = active(reviewed(missing));
  assert.equal(book.vouchers[0].gst.supplierInvoiceNumber, "REVIEW-209");
  assert.equal(book.vouchers[0].gst.supplierInvoiceDate, "2026-03-30");
  assert.equal(book.vouchers[0].gst.tallyOrigin.source.supplierDocument.dateBasis, "reviewed");
  const conflict = fixture(); conflict.mapping.purchaseReview.supplierInvoiceNumber = "CHANGED";
  assert.match(reviewed(conflict).report.rows[0].blockers[0].message, /explicit correction reason/);
  conflict.mapping.sourceCorrections = { supplierInvoiceNumber: "Checked corrected supplier document against named evidence" };
  assert.equal(active(reviewed(conflict)).vouchers[0].gst.supplierInvoiceNumber, "CHANGED");
  const future = fixture(); future.mapping.purchaseReview.receivedDate = "2026-04-04";
  assert.match(reviewed(future).report.rows[0].blockers[0].message, /receipt date/);
  const claimed = fixture(); claimed.mapping.purchaseReview.itcEligibility = "eligible";
  assert.throws(() => reviewed(claimed), /pending ITC/);
});

test("purchase role, amount, identity and unsupported source treatments fail closed", () => {
  const cases = [
    [input => input.replace("<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ACTUALQTY>", "<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><ACTUALQTY>"), /direction/],
    [input => input.replace("<AMOUNT>-90</AMOUNT>", "<AMOUNT>-89</AMOUNT>").replace("<AMOUNT>1180</AMOUNT>", "<AMOUNT>1179</AMOUNT>"), /reconcile|equal/],
    [input => input.replace("<IRN>", "<ISREVERSECHARGEAPPLICABLE>Yes</ISREVERSECHARGEAPPLICABLE><IRN>"), /specific GST workflow/],
  ];
  for (const [change, message] of cases) assert.match(reviewed(fixture(change)).report.rows[0].blockers[0].message, message);
  const wrongRole = fixture(); wrongRole.mapping.accounts.sales = wrongRole.mapping.accounts.purchase; delete wrongRole.mapping.accounts.purchase;
  assert.match(reviewed(wrongRole).report.rows[0].blockers[0].message, /GST role/);
  const wrongHead = fixture(); [wrongHead.mapping.accounts.cgst, wrongHead.mapping.accounts.sgst] = [wrongHead.mapping.accounts.sgst, wrongHead.mapping.accounts.cgst];
  assert.match(reviewed(wrongHead).report.rows[0].blockers[0].message, /cannot be mapped/);
  const wrongParty = fixture(); wrongParty.company.gst.parties[0].supplierLedgerId = wrongParty.registration.accounts.purchase;
  assert.match(reviewed(wrongParty).report.rows[0].blockers[0].message, /creditor ledger/);
  const wrongGroup = fixture(); wrongGroup.company.ledgers.find(row => row.id === wrongGroup.mapping.accounts.cgst).groupId = "g-sales";
  assert.match(reviewed(wrongGroup).report.rows[0].blockers[0].message, /account group/);
  const bankAsTax = fixture(); bankAsTax.company.ledgers.find(row => row.id === bankAsTax.mapping.accounts.cgst).groupId = "g-bank";
  assert.match(reviewed(bankAsTax).report.rows[0].blockers[0].message, /account group/);
  const changedPosting = fixture(); changedPosting.vouchers = structuredClone(changedPosting.vouchers); changedPosting.vouchers[0].lines[0].paise++;
  assert.match(reviewed(changedPosting).report.rows[0].blockers[0].message, /changed after import/);
});

test("unresolved purchase quantities permit report-only GST without manufacturing a receipt", () => {
  const book = fixture(input => input.replace(/<ACTUALQTY>[^<]*<\/ACTUALQTY>/g, ""));
  assert.equal(book.company.stock.journals.length, 0);
  book.mapping.stockMode = "report-only";
  const promoted = active(reviewed(book));
  assert.equal(promoted.vouchers[0].gst.stockEffect, "none");
  assert.equal(promoted.vouchers[0].gst.tallyOrigin.stockJournalId, null);
  assert.equal(promoted.company.stock.journals.length, 0);
  assert.equal(stock(promoted).items[0].quantity, "0");
  assertTallyGstOrigins(promoted.company, promoted.vouchers, promoted.records);
  const physical = fixture(); physical.mapping.stockMode = "report-only";
  assert.match(reviewed(physical).report.rows[0].blockers[0].message, /physical quantities are unresolved/);
});

test("full and accounting restore preserve purchase lineage and reject invoice/receipt tampering", () => {
  const book = active();
  const restored = restoreTallyArchive(archive(book));
  assert.deepEqual(restored.vouchers, book.vouchers);
  validateTransfer({ company: book.company, vouchers: book.vouchers });
  for (const mutate of [
    copy => { copy.vouchers[0].gst.itcEligibility = "eligible"; },
    copy => { copy.vouchers[0].gst.supplierInvoiceDate = "2026-04-01"; },
    copy => { copy.vouchers[0].gst.supplierInvoiceNumber = "OTHER"; },
    copy => { copy.vouchers[0].gst.receivedDate = "2026-04-03"; },
    copy => { copy.company.stock.journals[0].lines[0].valuePaise++; },
    copy => { copy.company.stock.journals[0].type = "issue"; },
    copy => { copy.company.stock.journals[0].lines[0].revenuePaise = 50000; },
    copy => { copy.vouchers[0].gst.tallyOrigin.postingRoles[1] = "sales"; },
  ]) {
    const copy = structuredClone(book); mutate(copy);
    assert.throws(() => assertTallyGstBook(copy.company, copy.vouchers));
    assert.throws(() => restoreTallyArchive(archive(copy)));
    assert.throws(() => validateTransfer({ company: copy.company, vouchers: copy.vouchers }));
  }
});


test("interstate purchase uses supplier state and explicit destination, with input assets accepted", () => {
  const interstate = fixture(input => input.replaceAll(supplierGstin, gstin("27", "PQRST5678L"))
    .replace('<LEDGER NAME="Input SGST"><PARENT>Duties &amp; Taxes</PARENT></LEDGER>', "")
    .replace('<ALLLEDGERENTRIES.LIST><LEDGERNAME>Input SGST</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-90</AMOUNT></ALLLEDGERENTRIES.LIST>', "")
    .replaceAll("Input CGST", "Input IGST").replace("<AMOUNT>-90</AMOUNT>", "<AMOUNT>-180</AMOUNT>"));
  interstate.company.ledgers.find(row => row.id === interstate.mapping.accounts.igst).groupId = "g-current-assets";
  const book = active(reviewed(interstate));
  assert.equal(book.vouchers[0].gst.party.stateCode, "27");
  assert.equal(book.vouchers[0].gst.registration.stateCode, "23");
  assert.equal(book.vouchers[0].gst.placeOfSupply, "23");
  assert.equal(book.vouchers[0].gst.interState, true);
  assert.equal(book.vouchers[0].gst.totals.igstPaise, 18000);
  assertTallyGstOrigins(book.company, book.vouchers, book.records);
  const absent = fixture(input => input.replace("<PLACEOFSUPPLY>Madhya Pradesh</PLACEOFSUPPLY>", "<PARTYSTATENAME>Madhya Pradesh</PARTYSTATENAME>"));
  assert.equal(reviewed(absent).report.rows[0].source.placeOfSupply, "");
  assert.match(reviewed(absent).report.rows[0].blockers[0].message, /explicit purchase place of supply/);
  absent.mapping.purchaseReview.placeOfSupply = "23";
  assert.equal(active(reviewed(absent)).vouchers[0].gst.placeOfSupply, "23");
});

test("repeated purchased items retain document order and original receipt cost splits", () => {
  const book = fixture(input => {
    const entry = /<ALLINVENTORYENTRIES\.LIST>[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/.exec(input)[0];
    return input.replace(entry, entry + entry).replace("<AMOUNT>1180</AMOUNT>", "<AMOUNT>2360</AMOUNT>")
      .replace("<AMOUNT>-1000</AMOUNT>", "<AMOUNT>-2000</AMOUNT>").replaceAll("<AMOUNT>-90</AMOUNT>", "<AMOUNT>-180</AMOUNT>");
  });
  const before = stock(book), result = active(reviewed(book));
  assert.equal(result.vouchers[0].gst.items.length, 2);
  assert.deepEqual(result.vouchers[0].gst.tallyOrigin.stockLineMap, [0, 0, 1, 1]);
  const after = stock(result);
  assert.equal(after.items[0].quantity, "6");
  assert.deepEqual(after.items[0].godowns.map(row => [row.godownId, row.quantity, row.knownValuePaise]), before.items[0].godowns.map(row => [row.godownId, row.quantity, row.knownValuePaise]));
  assertTallyGstOrigins(result.company, result.vouchers, result.records);
  assert.deepEqual(restoreTallyArchive(archive(result)).vouchers, result.vouchers);
});

test("purchase date review accepts midnight source dates and records explicit corrections", () => {
  const iso = active(reviewed(fixture(input => input.replace("<REFERENCEDATE>20260331</REFERENCEDATE>", "<REFERENCEDATE>2026-03-31T00:00:00.000Z</REFERENCEDATE>"))));
  assert.equal(iso.vouchers[0].gst.supplierInvoiceDate, "2026-03-31");
  const invalid = fixture(input => input.replace("<REFERENCEDATE>20260331</REFERENCEDATE>", "<REFERENCEDATE>2026-03-31T12:00:00.000Z</REFERENCEDATE>"));
  assert.match(reviewed(invalid).report.rows[0].blockers[0].message, /Unsupported or missing Tally date/);
  invalid.mapping.purchaseReview.supplierInvoiceDate = "2026-03-31";
  invalid.mapping.sourceCorrections = { supplierInvoiceDate: "Supplier paper invoice confirms the date; invalid timestamp is export metadata" };
  const corrected = active(reviewed(invalid));
  assert.equal(corrected.vouchers[0].gst.tallyOrigin.source.supplierDocument.sourceDate, "2026-03-31T12:00:00.000Z");
  assertTallyGstOrigins(corrected.company, corrected.vouchers, corrected.records);
});

test("duplicate receipts and hidden netting cannot survive a Purchase promotion", () => {
  const duplicate = fixture();
  duplicate.company.stock.journals.push({ ...structuredClone(duplicate.company.stock.journals[0]), id: "sj-duplicate-receipt" });
  assert.match(reviewed(duplicate).report.rows[0].blockers[0].message, /unchanged original stock movement/);
  const wrongDirection = fixture();
  wrongDirection.vouchers = structuredClone(wrongDirection.vouchers);
  wrongDirection.vouchers[0].lines.find(row => row.ledgerId === wrongDirection.mapping.accounts.cgst).dc = "Cr";
  assert.match(reviewed(wrongDirection).report.rows[0].blockers[0].message, /changed after import/);
  const outputTax = fixture(input => input.replaceAll("Input CGST", "Output CGST"));
  outputTax.mapping.accounts.cgst = outputTax.company.ledgers.find(row => row.name === "Output CGST").id;
  assert.match(reviewed(outputTax).report.rows[0].blockers[0].message, /cannot be mapped/);
});


test("Purchase preserves long internal voucher numbers and source numbers reused across fiscal years", () => {
  const long = fixture(input => input.replace("<VOUCHERNUMBER>P-101</VOUCHERNUMBER>", "<VOUCHERNUMBER>purchase-entry-number-01</VOUCHERNUMBER>"));
  const longBook = active(reviewed(long));
  assert.equal(longBook.vouchers[0].gst.number, "purchase-entry-number-01");
  assert.equal(longBook.vouchers[0].number, "purchase-entry-number-01");
  assert.equal(longBook.vouchers[0].gst.supplierInvoiceNumber, "SUP-209");
  assertTallyGstOrigins(longBook.company, longBook.vouchers, longBook.records);
  const source = fixture(input => {
    const entry = /<VOUCHER VCHTYPE="Purchase">[\s\S]*?<\/VOUCHER>/.exec(input)[0];
    const later = entry.replace("synthetic-gst-purchase", "synthetic-gst-purchase-next-year")
      .replace("<DATE>20260403</DATE>", "<DATE>20270403</DATE>").replace("<REFERENCEDATE>20260331</REFERENCEDATE>", "<REFERENCEDATE>20270331</REFERENCEDATE>");
    return input.replace(entry, entry + later);
  });
  let book = reviewed(source);
  const second = source.records.filter(row => row.type === "VOUCHER")[1];
  book = { ...book, ...saveTallyGstMapping(book.company, book.vouchers, book.records, { ...source.mapping, recordId: second.recordId,
    purchaseReview: { receivedDate: "2027-04-02", itcEligibility: "pending" }, revision: 1, requestId: "purchase-mapping-test-0002" }) };
  const plan = planTallyGstPromotion(book.company, book.vouchers, book.records);
  assert.equal(plan.summary.ready, 2, JSON.stringify(plan.rows.map(row => row.blockers)));
  const promoted = activateTallyGstPromotion(book.company, book.vouchers, book.records, { revision: plan.revision, reviewHash: plan.reviewHash,
    recordIds: [source.record.recordId, second.recordId], requestId: "purchase-bulk-years-0001" });
  assert.notEqual(promoted.vouchers[0].number, promoted.vouchers[1].number);
  assert.ok(promoted.vouchers[1].number.includes("~"));
  assert.deepEqual(promoted.vouchers.map(row => row.gst.number), promoted.vouchers.map(row => row.number));
  assert.deepEqual(promoted.vouchers.map(row => row.gst.tallyOrigin.source.sourceVoucherNumber), ["P-101", "P-101"]);
  assert.deepEqual(promoted.vouchers.map(row => row.gst.supplierInvoiceNumber), ["SUP-209", "SUP-209"]);
  assertTallyGstOrigins(promoted.company, promoted.vouchers, source.records);
  assert.deepEqual(restoreTallyArchive(archive({ ...source, ...promoted })).vouchers, promoted.vouchers);
});


test("repeated inventory names cannot silently replace an earlier line's supplied HSN", () => {
  const book = fixture(input => {
    const entry = /<ALLINVENTORYENTRIES\.LIST>[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/.exec(input)[0];
    const first = entry.replace("<STOCKITEMNAME>Widget</STOCKITEMNAME>", "<STOCKITEMNAME>Widget</STOCKITEMNAME><HSNCODE>8541</HSNCODE>");
    const second = entry.replace("<STOCKITEMNAME>Widget</STOCKITEMNAME>", "<STOCKITEMNAME>Widget</STOCKITEMNAME><HSNCODE>8504</HSNCODE>");
    return input.replace(entry, first + second).replace("<AMOUNT>1180</AMOUNT>", "<AMOUNT>2360</AMOUNT>")
      .replace("<AMOUNT>-1000</AMOUNT>", "<AMOUNT>-2000</AMOUNT>").replaceAll("<AMOUNT>-90</AMOUNT>", "<AMOUNT>-180</AMOUNT>");
  });
  assert.match(reviewed(book).report.rows[0].blockers[0].message, /different HSN classifications/);
});


test("explicit source Purchase discounts reduce tax and receipt cost without inferred adjustments", () => {
  const discounted = fixture(input => input.replace("<RATE>500/nos</RATE>", "<RATE>500/nos</RATE><DISCOUNT>10 %</DISCOUNT>")
    .replaceAll("<AMOUNT>-1000</AMOUNT>", "<AMOUNT>-900</AMOUNT>").replaceAll("<AMOUNT>-500</AMOUNT>", "<AMOUNT>-450</AMOUNT>")
    .replaceAll("<AMOUNT>-90</AMOUNT>", "<AMOUNT>-81</AMOUNT>").replace("<AMOUNT>1180</AMOUNT>", "<AMOUNT>1062</AMOUNT>"));
  const book = active(reviewed(discounted));
  assert.equal(book.vouchers[0].gst.items[0].discountBps, 1000);
  assert.equal(book.vouchers[0].gst.totals.taxablePaise, 90000);
  assert.equal(book.vouchers[0].gst.totals.taxPaise, 16200);
  assert.equal(stock(book).items[0].knownValuePaise, 90000);
  assertTallyGstOrigins(book.company, book.vouchers, book.records);
  const unreviewed = fixture(input => input.replace("<RATE>500/nos</RATE>", "<RATE>500/nos</RATE><DISCOUNT>5 %</DISCOUNT>"));
  assert.match(reviewed(unreviewed).report.rows[0].blockers[0].message, /value does not equal/);
});


test("GST review lists potential invoices while ordinary receipts and payments stay in the source book", () => {
  const book = fixture(input => input.replace("</TALLYMESSAGE>", `<LEDGER NAME="Source Bank"><PARENT>Bank Accounts</PARENT></LEDGER>
    <VOUCHER VCHTYPE="Payment"><GUID>synthetic-settlement</GUID><DATE>20260404</DATE><VOUCHERNUMBER>PMT-1</VOUCHERNUMBER>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Source Supplier</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1180</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Source Bank</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1180</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>
    <VOUCHER VCHTYPE="Receipt"><GUID>synthetic-receipt</GUID><DATE>20260405</DATE><VOUCHERNUMBER>RCT-1</VOUCHERNUMBER>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Source Bank</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-100</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Source Supplier</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>100</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>
    <VOUCHER VCHTYPE="Credit Note"><GUID>synthetic-unsupported-note</GUID><DATE>20260406</DATE><VOUCHERNUMBER>CN-1</VOUCHERNUMBER>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Source Supplier</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1180</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Source Purchases</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1180</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>
    </TALLYMESSAGE>`));
  const plan = planTallyGstPromotion(book.company, book.vouchers, book.records);
  assert.equal(book.vouchers.length, 4);
  assert.equal(book.records.filter(row => row.type === "VOUCHER").length, 4);
  assert.deepEqual(plan.rows.map(row => row.type), ["Purchase", "Credit Note"]);
  assert.equal(plan.summary.sourceInvoices, 2);
  assert.equal(plan.summary.blocked, 2);
  assert.match(plan.rows[1].blockers[0].message, /Sales or Purchase/);
  const cancelled = fixture(input => input.replace("<IRN>", "<ISCANCELLED>Yes</ISCANCELLED><IRN>"));
  const cancelledPlan = planTallyGstPromotion(cancelled.company, cancelled.vouchers, cancelled.records);
  assert.equal(cancelledPlan.rows.length, 1);
  assert.equal(cancelledPlan.rows[0].type, "Purchase");
  assert.equal(cancelledPlan.summary.blocked, 1);
});


test("Purchase export snapshot retains native type, signed discounts and actual allocation data", () => {
  const source = fixture(input => input.replace("<AMOUNT>1180</AMOUNT></ALLLEDGERENTRIES.LIST>", `<AMOUNT>1180</AMOUNT>
    <BILLALLOCATIONS.LIST><NAME>SUP-209</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>1180</AMOUNT><BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD></BILLALLOCATIONS.LIST>
    <BANKALLOCATIONS.LIST><INSTRUMENTNUMBER>synthetic-payment-reference</INSTRUMENTNUMBER></BANKALLOCATIONS.LIST>
    <ORDERALLOCATIONS.LIST><ORDERNO>synthetic-order</ORDERNO></ORDERALLOCATIONS.LIST>
    <COSTCENTREALLOCATIONS.LIST></COSTCENTREALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>`));
  const book = active(reviewed(source));
  const snapshot = book.vouchers[0].gst.tallyOrigin.source;
  assert.equal(snapshot.sourceVoucherType, "Purchase");
  assert.deepEqual(snapshot.exportUnsupportedAllocations, ["BANKALLOCATIONS", "ORDERALLOCATIONS"]);
  assert.equal(snapshot.exportBillAllocations.length, 1);
  assert.equal(snapshot.exportBillAllocations[0].postingIndex, 0);
  assert.equal(snapshot.exportBillAllocations[0].node.tag, "BILLALLOCATIONS.LIST");
  assert.equal(snapshot.items[0].sourceAmountPaise, -100000);
  assert.equal(snapshot.items[0].sourceDirectionFlag, "Yes");
  assert.equal(snapshot.items[0].discountEvidence, null);
  assertTallyGstOrigins(book.company, book.vouchers, book.records);
  assert.deepEqual(restoreTallyArchive(archive(book)).vouchers, book.vouchers);
});


test("explicit non-domestic or special Purchase treatment never becomes a regular forward invoice", () => {
  for (const marker of ["<GSTNATUREOFTRANSACTION>Purchase From SEZ - Taxable</GSTNATUREOFTRANSACTION>",
    "<GSTNATUREOFTRANSACTION>Imports Taxable</GSTNATUREOFTRANSACTION>", "<PARTYGSTREGTYPE>Regular - SEZ</PARTYGSTREGTYPE>",
    "<BILLOFENTRYNO>SYNTHETIC-BOE</BILLOFENTRYNO>", "<GSTNATUREOFTRANSACTION>Purchase Exempt</GSTNATUREOFTRANSACTION>"]) {
    const book = reviewed(fixture(input => input.replace("<IRN>", marker + "<IRN>")));
    assert.match(book.report.rows[0].blockers[0].message, /separate GST workflow/);
    assert.equal(book.vouchers.some(row => row.gst), false);
  }
});
