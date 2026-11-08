import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { previewTally, restoreTallyArchive } from "../lib/tally-import.js";
import { saveRegistration, saveParty, saveItem, gstinCheckDigit } from "../lib/gst.js";
import { planTallyGstPromotion, saveTallyGstMapping, activateTallyGstPromotion, assertTallyGstBook, assertTallyGstOrigins } from "../lib/tally-gst.js";
import { stockState } from "../lib/stock-engine.js";
import { returnWorkbook } from "../lib/gst-returns.js";
import { validateTransfer } from "../lib/transfer.js";
import { value } from "../lib/tally-format.js";

const gstin = pan => { const prefix = `23${pan}1Z`; return prefix + gstinCheckDigit(prefix); };
const own = gstin("ABCDE1234F"), customer = gstin("PQRST5678L"), supplier = gstin("LMNOP1234Q");
const specs = [
  { number: "P-1", type: "Purchase", party: "Vendor", date: "20260401", amount: 50000, quantity: "10", price: 5000, debit: true, reference: "SUP-1", original: "" },
  { number: "S-1", type: "Sales", party: "Buyer", date: "20260402", amount: 40000, quantity: "4", price: 10000, debit: false, original: "" },
  { number: "SC-1", type: "Credit Note", party: "Buyer", date: "20260403", amount: 10000, quantity: "1", price: 10000, debit: true, original: "S-1" },
  { number: "SD-1", type: "Debit Note", party: "Buyer", date: "20260404", amount: 11000, quantity: "1", price: 11000, debit: false, original: "S-1" },
  { number: "PD-1", type: "Debit Note", party: "Vendor", date: "20260405", amount: 5000, quantity: "1", price: 5000, debit: false, reference: "SUP-CN-1", original: "SUP-1" },
  { number: "PC-1", type: "Credit Note", party: "Vendor", date: "20260406", amount: 5000, quantity: "1", price: 5000, debit: true, reference: "SUP-DN-1", original: "SUP-1" },
  { number: "SF-1", type: "Credit Note", party: "Buyer", date: "20260407", amount: 1000, debit: true, original: "S-1" },
];
const rupees = paise => (paise / 100).toFixed(2);
function voucherXml(row) {
  const purchase = row.party === "Vendor", tax = row.amount * 9 / 100;
  const lines = [[row.party, !row.debit, row.amount + 2 * tax], [purchase ? "Purchase" : "Sales", row.debit, row.amount], [purchase ? "Input CGST" : "Output CGST", row.debit, tax], [purchase ? "Input SGST" : "Output SGST", row.debit, tax]];
  return `<VOUCHER VCHTYPE="${row.type}"><GUID>independent-note-${row.number}</GUID><DATE>${row.date}</DATE><VOUCHERNUMBER>${row.number}</VOUCHERNUMBER><PARTYLEDGERNAME>${row.party}</PARTYLEDGERNAME><PARTYGSTIN>${purchase ? supplier : customer}</PARTYGSTIN><CMPGSTIN>${own}</CMPGSTIN><PLACEOFSUPPLY>Madhya Pradesh</PLACEOFSUPPLY>
  ${row.reference ? `<REFERENCE>${row.reference}</REFERENCE><REFERENCEDATE>${row.date}</REFERENCEDATE>` : ""}${row.original ? `<ORIGINALINVOICENO>${row.original}</ORIGINALINVOICENO><ORIGINALINVOICEDATE>${purchase ? "20260401" : "20260402"}</ORIGINALINVOICEDATE>` : ""}
  ${lines.map(([ledger, debit, amount]) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${ledger}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${debit ? "-" : ""}${rupees(amount)}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join("")}
  ${row.quantity ? `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Widget</STOCKITEMNAME><ISDEEMEDPOSITIVE>${row.debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE><BILLEDQTY>${row.quantity} nos</BILLEDQTY><ACTUALQTY>${row.quantity} nos</ACTUALQTY><RATE>${rupees(row.price)}/nos</RATE><AMOUNT>${row.debit ? "-" : ""}${rupees(row.amount)}</AMOUNT></ALLINVENTORYENTRIES.LIST>` : ""}</VOUCHER>`;
}
function sourceXml() {
  return `<ENVELOPE><TALLYMESSAGE><COMPANY NAME="Independent Note Books"><NAME>Independent Note Books</NAME><GSTREGISTRATIONNUMBER>${own}</GSTREGISTRATIONNUMBER></COMPANY>
  <UNIT NAME="nos"><NAME>nos</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>0</DECIMALPLACES></UNIT>
  ${[["Vendor", "Sundry Creditors"], ["Buyer", "Sundry Debtors"], ["Purchase", "Purchase Accounts"], ["Sales", "Sales Accounts"], ...["Input CGST", "Input SGST", "Output CGST", "Output SGST"].map(name => [name, "Duties &amp; Taxes"])].map(([name, parent]) => `<LEDGER NAME="${name}"><PARENT>${parent}</PARENT></LEDGER>`).join("")}
  <STOCKITEM NAME="Widget"><NAME>Widget</NAME><BASEUNITS>nos</BASEUNITS><COSTINGMETHOD>FIFO Perpetual</COSTINGMETHOD><OPENINGBALANCE>0 nos</OPENINGBALANCE><OPENINGVALUE>0</OPENINGVALUE></STOCKITEM>
  ${specs.map(voucherXml).join("")}</TALLYMESSAGE></ENVELOPE>`;
}
let request = 0;
const requestId = action => `independent-note-${action}-${String(++request).padStart(8, "0")}`;
function fixture(change = input => input) {
  const xml = change(sourceXml()), book = previewTally([{ name: "independent-gst-notes.xml", base64: Buffer.from(xml).toString("base64") }], { companyName: "Independent Note Books", booksFrom: "2026-04-01" });
  assert.equal(book.canCommit, true, JSON.stringify(book.issues));
  const ledger = name => book.company.ledgers.find(row => row.name === name).id;
  const registration = saveRegistration(book.company, { name: "Own", gstin: own, stateCode: "23", address: "Synthetic note test" }, book.vouchers);
  const buyer = saveParty(book.company, { name: "Buyer", gstin: customer, stateCode: "23", address: "Synthetic buyer", kind: "customer", customerLedgerId: ledger("Buyer") }, book.vouchers);
  const vendor = saveParty(book.company, { name: "Vendor", gstin: supplier, stateCode: "23", address: "Synthetic vendor", kind: "supplier", supplierLedgerId: ledger("Vendor") }, book.vouchers);
  const master = book.company.stock.masters[0], item = saveItem(book.company, { ...master, stockItemId: master.id, kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1800 }, book.vouchers);
  return { ...book, registration, buyer, vendor, item };
}
const recordFor = (book, number) => book.records.find(row => row.type === "VOUCHER" && value(row.node, "VOUCHERNUMBER") === number);
function mapping(book, number) {
  const spec = specs.find(row => row.number === number), record = recordFor(book, number), purchase = spec.party === "Vendor";
  const ledger = name => book.company.ledgers.find(row => row.name === name).id;
  const row = { recordId: record.recordId, registrationId: book.registration.id, partyId: purchase ? book.vendor.id : book.buyer.id, items: spec.quantity ? [{ sourceName: "Widget", itemId: book.item.id }] : [], accounts: { party: ledger(spec.party), [purchase ? "purchase" : "sales"]: ledger(purchase ? "Purchase" : "Sales"), cgst: ledger(purchase ? "Input CGST" : "Output CGST"), sgst: ledger(purchase ? "Input SGST" : "Output SGST") }, evidence: { name: "Independent synthetic legal note evidence", reference: `Actual ${purchase ? "supplier" : "issued customer"} document for ${number}; synthetic fixture` } };
  if (["Purchase", "Sales"].includes(spec.type)) { if (purchase) row.purchaseReview = { receivedDate: "2026-04-01" }; return row; }
  const original = book.vouchers.find(row => row.gst?.type === (purchase ? "Purchase" : "Sales")).gst;
  row.noteReview = { direction: purchase ? "purchase" : "sales", originalInvoiceId: original.id, originalNumber: purchase ? original.supplierInvoiceNumber : original.number, originalDate: original.supplierInvoiceDate || original.date, stockEffect: spec.quantity ? "quantity" : "none", ...(purchase ? { supplierDocumentConfirmed: true } : {}), lines: spec.quantity ? [{ sourceLineIndex: 0, originalLineIndex: 0 }] : [{ originalLineIndex: 0, quantity: "1", unitPricePaise: spec.amount, discountBps: 0 }] };
  return row;
}
function save(book, input) {
  return { ...book, ...saveTallyGstMapping(book.company, book.vouchers, book.records, { ...input, revision: book.company.gst.tallyPromotion?.revision || 0, requestId: requestId("mapping") }) };
}
function activate(book, numbers) {
  const plan = planTallyGstPromotion(book.company, book.vouchers, book.records), ids = numbers.map(number => recordFor(book, number).recordId);
  for (const id of ids) assert.equal(plan.rows.find(row => row.recordId === id).status, "ready", JSON.stringify(plan.rows.find(row => row.recordId === id).blockers));
  const input = { revision: plan.revision, reviewHash: plan.reviewHash, recordIds: ids, requestId: requestId("activate") };
  return { ...book, ...activateTallyGstPromotion(book.company, book.vouchers, book.records, input), activationInput: input };
}
function originals(book = fixture()) {
  book = save(book, mapping(book, "P-1")); book = save(book, mapping(book, "S-1")); return activate(book, ["P-1", "S-1"]);
}
const archive = book => ({ format: "financer-tally-archive", version: 1, company: book.company, vouchers: book.vouchers, records: book.records, sources: book.sources, sourceBookHash: null });

test("all four native note flows retain postings and independently verified statutory identities", () => {
  let book = originals();
  assert.deepEqual(book.vouchers.filter(row => row.gst).map(row => row.gst.tallyOrigin.version), [2, 1]);
  assert.deepEqual(restoreTallyArchive(archive(book)).vouchers, book.vouchers);
  const postings = book.vouchers.map(({ gst, ...row }) => structuredClone(row));
  for (const number of ["SC-1", "SD-1", "PD-1", "PC-1"]) book = save(book, mapping(book, number));
  book = activate(book, ["SC-1", "SD-1", "PD-1", "PC-1"]);
  assert.deepEqual(book.vouchers.map(({ gst, ...row }) => row), postings);
  assert.deepEqual(book.vouchers.slice(2, 6).map(row => [row.type, row.gst.type, row.gst.direction]), [["Credit Note", "Credit Note", "sales"], ["Debit Note", "Debit Note", "sales"], ["Debit Note", "Credit Note", "purchase"], ["Credit Note", "Debit Note", "purchase"]]);
  assert.deepEqual(book.vouchers.slice(2, 6).map(row => row.gst.tallyOrigin.version), [3, 3, 3, 3]);
  assert.equal(book.vouchers[4].gst.supplierInvoiceNumber, "SUP-CN-1");
  assert.equal(book.vouchers[5].gst.supplierInvoiceNumber, "SUP-DN-1");
  assert.equal(book.company.stock.journals.length, 6);
  const closingStock = stockState(book.company, book.vouchers, { to: "2026-04-30" });
  assert.equal(closingStock.items[0].quantity, "6");
  assert.equal(closingStock.items[0].knownValuePaise, 30000, "returned sales goods use original cost, not the note selling value");
  assertTallyGstBook(book.company, book.vouchers); assertTallyGstOrigins(book.company, book.vouchers, book.records);
  assert.deepEqual(restoreTallyArchive(archive(book)).vouchers, book.vouchers);
  validateTransfer({ company: book.company, vouchers: book.vouchers });
  const replay = activateTallyGstPromotion(book.company, book.vouchers, book.records, book.activationInput);
  assert.equal(replay.replayed, true); assert.equal(replay.company.stock.journals.length, 6);
  const returns = returnWorkbook(book.company, book.vouchers, book.registration.id, "2026-04", new Map());
  assert.equal(returns.summary.purchases.taxablePaise, 50000);
  assert.equal(returns.bookSummary.outwardTaxable.taxablePaise, 41000);
  assert.equal(returns.summary.outwardTaxable.taxablePaise, 51000, "classification alone does not establish output-tax reduction eligibility");
  assert.equal(returns.creditReviews.length, 1);
});

test("accounting-only valuation note uses explicit original HSN/rate allocation without a stock movement", () => {
  let book = originals(), before = stockState(book.company, book.vouchers, { to: "2026-04-30" });
  book = activate(save(book, mapping(book, "SF-1")), ["SF-1"]);
  const invoice = book.vouchers.find(row => row.number === "SF-1").gst;
  assert.equal(invoice.stockEffect, "none"); assert.equal(invoice.tallyOrigin.stockMode, "financial-only");
  assert.equal(invoice.tallyOrigin.source.noteInventory, false);
  assert.equal(invoice.tallyOrigin.source.items[0].basis, "reviewed-financial-allocation");
  assert.equal(invoice.items[0].hsnSac, "8541"); assert.equal(invoice.items[0].gstRateBps, 1800);
  assert.equal(invoice.totals.taxablePaise, 1000); assert.equal(book.company.stock.journals.length, 2);
  assert.equal(stockState(book.company, book.vouchers, { to: "2026-04-30" }).items[0].quantity, before.items[0].quantity);
  assert.deepEqual(restoreTallyArchive(archive(book)).vouchers, book.vouchers);
});

test("buyer accounting notes cannot become supplier GST notes without actual supplier document evidence", () => {
  let book = originals(), review = mapping(book, "PD-1");
  review.noteReview.supplierDocumentConfirmed = false;
  let saved = save(book, review);
  assert.match(saved.report.rows.find(row => row.recordId === review.recordId).blockers[0].message, /actual supplier GST credit\/debit note/);
  const native = specs.find(row => row.number === "PD-1");
  book = originals(fixture(xml => xml.replace(voucherXml(native), voucherXml({ ...native, reference: "" }))));
  review = mapping(book, "PD-1");
  saved = save(book, review);
  assert.match(saved.report.rows.find(row => row.recordId === review.recordId).blockers[0].message, /actual supplier GST credit\/debit note/);
  review.noteReview.supplierNoteNumber = "ACTUAL-SCN-1";
  review.noteReview.supplierNoteDate = "2026-04-05";
  const active = activate(save(book, review), ["PD-1"]);
  assert.equal(active.vouchers.find(row => row.number === "PD-1").gst.supplierInvoiceNumber, "ACTUAL-SCN-1");
});

test("notes require the exact verified original and source discrepancies need explicit correction", () => {
  const book = originals();
  const wrong = mapping(book, "SC-1"); wrong.noteReview.originalInvoiceId = book.vouchers.find(row => row.gst?.type === "Purchase").id;
  assert.match(save(book, wrong).report.rows.find(row => row.recordId === wrong.recordId).blockers[0].message, /same party, registration and direction/);
  const reference = mapping(book, "SC-1"); reference.noteReview.originalNumber = "OTHER";
  assert.match(save(book, reference).report.rows.find(row => row.recordId === reference.recordId).blockers[0].message, /explicit correction reason/);
  reference.sourceCorrections = { originalNumber: "Wrong source link reviewed against the actual original" };
  assert.match(save(book, reference).report.rows.find(row => row.recordId === reference.recordId).blockers[0].message, /must equal the verified original/);
  const source = specs.find(row => row.number === "SC-1");
  let mismatch = originals(fixture(xml => xml.replace(voucherXml(source), voucherXml(source).replace("<ORIGINALINVOICENO>S-1</ORIGINALINVOICENO>", "<ORIGINALINVOICENO>WRONG</ORIGINALINVOICENO>"))));
  let mapped = mapping(mismatch, "SC-1");
  assert.match(save(mismatch, mapped).report.rows.find(row => row.recordId === mapped.recordId).blockers[0].message, /explicit correction reason/);
  mapped.sourceCorrections = { originalNumber: "Actual issued note confirms S-1; export reference was transcribed incorrectly" };
  mismatch = activate(save(mismatch, mapped), ["SC-1"]);
  assert.equal(mismatch.vouchers.find(row => row.number === "SC-1").gst.tallyOrigin.source.originalDocument.sourceNumber, "WRONG");
  assertTallyGstOrigins(mismatch.company, mismatch.vouchers, mismatch.records);
});

test("physical source quantities cannot be hidden and financial-only allocations must reconcile exactly", () => {
  const book = originals(), hidden = mapping(book, "SC-1"); hidden.noteReview.stockEffect = "none";
  assert.match(save(book, hidden).report.rows.find(row => row.recordId === hidden.recordId).blockers[0].message, /cannot discard a supplied physical quantity/);
  const invented = mapping(book, "SF-1"); invented.noteReview.stockEffect = "quantity";
  assert.match(save(book, invented).report.rows.find(row => row.recordId === invented.recordId).blockers[0].message, /accounting-only note/);
  const mismatch = mapping(book, "SF-1"); mismatch.noteReview.lines[0].unitPricePaise = 999;
  assert.match(save(book, mismatch).report.rows.find(row => row.recordId === mismatch.recordId).blockers[0].message, /postings do not equal/);
  const wrongLine = mapping(book, "SC-1"); wrongLine.noteReview.lines[0].originalLineIndex = 2;
  assert.match(save(book, wrongLine).report.rows.find(row => row.recordId === wrongLine.recordId).blockers[0].message, /missing original invoice line/);
  const independent = structuredClone(book), note = independent.vouchers.find(row => row.number === "SC-1");
  independent.company.stock.journals.push({ ...structuredClone(independent.company.stock.journals[0]), id: "sj-independent-note", accountingVoucherId: note.id });
  const independentMapping = mapping(independent, "SC-1");
  assert.match(save(independent, independentMapping).report.rows.find(row => row.recordId === independentMapping.recordId).blockers[0].message, /independent stock movement/);
  const native = specs.find(row => row.number === "SC-1");
  const opposite = originals(fixture(xml => xml.replace(voucherXml(native), voucherXml(native).replace("<STOCKITEMNAME>Widget</STOCKITEMNAME><ISDEEMEDPOSITIVE>Yes", "<STOCKITEMNAME>Widget</STOCKITEMNAME><ISDEEMEDPOSITIVE>No"))));
  const oppositePlan = planTallyGstPromotion(opposite.company, opposite.vouchers, opposite.records);
  assert.match(oppositePlan.rows.find(row => row.sourceNumber === "SC-1").blockers[0].message, /debit direction contradicts/);
});

test("original HSN/rate snapshots survive later master edits and note tampering fails both restore paths", () => {
  let book = originals();
  saveItem(book.company, { ...book.item, stockItemId: book.item.id, hsnSac: "8542", gstRateBps: 1200 }, book.vouchers);
  book = activate(save(book, mapping(book, "PD-1")), ["PD-1"]);
  const invoice = book.vouchers.find(row => row.number === "PD-1").gst;
  assert.equal(invoice.items[0].hsnSac, "8541"); assert.equal(invoice.items[0].gstRateBps, 1800);
  assert.deepEqual(restoreTallyArchive(archive(book)).vouchers, book.vouchers);
  for (const mutate of [
    copy => { copy.vouchers.find(row => row.number === "PD-1").type = "Credit Note"; },
    copy => { copy.vouchers.find(row => row.number === "PD-1").gst.type = "Debit Note"; },
    copy => { copy.vouchers.find(row => row.number === "PD-1").gst.originalLineMap[0] = 1; },
    copy => { copy.vouchers.find(row => row.number === "PD-1").gst.tallyOrigin.noteReview.supplierDocumentConfirmed = false; },
    copy => { copy.vouchers.find(row => row.number === "PD-1").gst.supplierInvoiceNumber = "FAKE"; },
    copy => { copy.company.stock.journals.find(row => row.sourceRef.startsWith("tally-note:")).lines[0].sourceValuePaise++; },
    copy => { copy.company.stock.journals.push(structuredClone(copy.company.stock.journals.find(row => row.sourceRef.startsWith("tally-note:")))); },
  ]) {
    const copy = structuredClone(book); mutate(copy);
    assert.throws(() => assertTallyGstBook(copy.company, copy.vouchers));
    assert.throws(() => restoreTallyArchive(archive(copy)));
    assert.throws(() => validateTransfer({ company: copy.company, vouchers: copy.vouchers }));
  }
});


test("financial accounting notes may identify exactly one posted party when the header is absent", () => {
  const spec = specs.find(row => row.number === "SF-1");
  let book = originals(fixture(xml => xml.replace(voucherXml(spec), voucherXml(spec).replace("<PARTYLEDGERNAME>Buyer</PARTYLEDGERNAME>", ""))));
  book = activate(save(book, mapping(book, "SF-1")), ["SF-1"]);
  assert.equal(book.vouchers.find(row => row.number === "SF-1").gst.tallyOrigin.source.partyBasis, "unique-posted-party");
  assert.deepEqual(restoreTallyArchive(archive(book)).vouchers, book.vouchers);
});

test("selected note activation is atomic for cumulative reductions and duplicate statutory notes", () => {
  const spec = specs.find(row => row.number === "SC-1");
  for (const duplicate of [false, true]) {
    const first = duplicate ? spec : { ...spec, amount: 30000, quantity: "3" };
    const second = { ...first, number: duplicate ? "SC-1" : "SC-2" };
    let book = originals(fixture(xml => xml.replace(voucherXml(spec), voucherXml(first) + voucherXml(second).replace(`independent-note-${second.number}`, "independent-note-second-reduction"))));
    const records = book.records.filter(row => row.type === "VOUCHER" && ["SC-1", "SC-2"].includes(value(row.node, "VOUCHERNUMBER")));
    book = save(book, mapping(book, "SC-1"));
    book = save(book, { ...mapping(book, "SC-1"), recordId: records[1].recordId });
    const plan = planTallyGstPromotion(book.company, book.vouchers, book.records);
    assert.ok(records.every(record => plan.rows.find(row => row.recordId === record.recordId).status === "ready"));
    assert.throws(() => activateTallyGstPromotion(book.company, book.vouchers, book.records, { revision: plan.revision, reviewHash: plan.reviewHash, recordIds: records.map(row => row.recordId), requestId: requestId("atomic") }), duplicate ? /invoice number.*already used/ : /exceed|remaining|original/i);
    assert.equal(book.vouchers.filter(row => row.gst?.tallyOrigin.version === 3).length, 0);
    assert.equal(book.company.stock.journals.length, 2);
  }
});

test("physical note retains billed entitlement and actual return quantity independently", () => {
  const sale = specs.find(row => row.number === "S-1"), credit = specs.find(row => row.number === "SC-1");
  let book = originals(fixture(xml => xml.replace(voucherXml(sale), voucherXml(sale).replace("<ACTUALQTY>4 nos</ACTUALQTY>", "<ACTUALQTY>1 nos</ACTUALQTY>"))
    .replace(voucherXml(credit), voucherXml({ ...credit, amount: 20000, quantity: "2" }).replace("<ACTUALQTY>2 nos</ACTUALQTY>", "<ACTUALQTY>1 nos</ACTUALQTY>"))));
  book = activate(save(book, mapping(book, "SC-1")), ["SC-1"]);
  const invoice = book.vouchers.find(row => row.number === "SC-1").gst;
  assert.equal(invoice.items[0].quantity, "2");
  assert.equal(invoice.tallyOrigin.source.items[0].actualQuantity, "1");
  assert.equal(stockState(book.company, book.vouchers, { to: "2026-04-30" }).items[0].quantity, "10");
  assert.deepEqual(restoreTallyArchive(archive(book)).vouchers, book.vouchers);
});


test("recomputed storage hashes cannot authorize contradictory financial or source allocation evidence", () => {
  let book = originals(); book = activate(save(book, mapping(book, "SF-1")), ["SF-1"]);
  const digest = input => createHash("sha256").update(JSON.stringify(input)).digest("hex");
  for (const change of ["review-only", "review-and-mapping", "source-value", "source-original-reference"]) {
    const copy = structuredClone(book), note = copy.vouchers.find(row => row.number === "SF-1"), origin = note.gst.tallyOrigin;
    const target = copy.company.gst.tallyPromotion.activations.flatMap(event => event.targets).find(row => row.voucherId === note.id);
    if (change.startsWith("review")) {
      origin.noteReview.lines[0].quantity = "2";
      origin.noteReview.lines[0].unitPricePaise = 500;
      if (change === "review-and-mapping") {
        const saved = copy.company.gst.tallyPromotion.mappings.find(row => digest(row.mapping) === origin.mappingHash);
        saved.mapping.noteReview = structuredClone(origin.noteReview);
        origin.mappingHash = target.mappingHash = digest(saved.mapping);
      }
    } else if (change === "source-value") origin.source.items[0].unitPricePaise = 999999;
    else origin.source.originalDocument.chosenNumber = "FORGED-ORIGINAL";
    target.invoiceHash = digest(note.gst);
    assert.throws(() => assertTallyGstBook(copy.company, copy.vouchers), /evidence changed|differ|no longer/);
    assert.throws(() => validateTransfer({ company: copy.company, vouchers: copy.vouchers }));
    assert.throws(() => restoreTallyArchive(archive(copy)));
  }
});
