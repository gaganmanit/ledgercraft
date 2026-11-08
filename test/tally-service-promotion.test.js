import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { previewTally, restoreTallyArchive } from "../lib/tally-import.js";
import { saveRegistration, saveParty, saveItem } from "../lib/gst.js";
import { planTallyGstPromotion, saveTallyGstMapping, activateTallyGstPromotion, assertTallyGstBook, assertTallyGstOrigins } from "../lib/tally-gst.js";
import { value } from "../lib/tally-format.js";
import { stockState } from "../lib/stock-engine.js";
import { trialBalance } from "../lib/engine.js";
import { validateTransfer } from "../lib/transfer.js";

const original = await readFile(new URL("fixtures/tally-service-cycle.xml", import.meta.url), "utf8");
const serviceNames = ["Consulting Income", "Support Income", "Professional Fees", "Maintenance Expense"];
let requests = 0;
const requestId = kind => `service-core-${kind}-${String(++requests).padStart(8, "0")}`;
function fixture(change = text => text, stockBaselineVersion) {
  const book = previewTally([{ name: "synthetic-service-cycle.xml", base64: Buffer.from(change(original)).toString("base64") }], { companyName: "Service core fixture", booksFrom: "2026-04-01" }, stockBaselineVersion);
  assert.equal(book.canCommit, true, JSON.stringify(book.issues));
  const ledger = name => book.company.ledgers.find(row => row.name === name).id;
  const registration = saveRegistration(book.company, { name: "Synthetic owner", gstin: "23ABCDE1234F1Z8", stateCode: "23", address: "Synthetic owner address" }, book.vouchers);
  const buyer = saveParty(book.company, { name: "Service Buyer", kind: "customer", gstin: "23PQRST5678L1Z8", stateCode: "23", address: "Synthetic buyer", customerLedgerId: ledger("Service Buyer") }, book.vouchers);
  const supplier = saveParty(book.company, { name: "Service Supplier", kind: "supplier", gstin: "23LMNOP4321A1Z9", stateCode: "23", address: "Synthetic supplier", supplierLedgerId: ledger("Service Supplier") }, book.vouchers);
  const master = book.company.stock.masters[0];
  const goods = saveItem(book.company, { ...master, stockItemId: master.id, kind: "goods", hsnSac: "8541", gstRateBps: 1800 }, book.vouchers);
  const services = new Map(serviceNames.map(name => [name, saveItem(book.company, { name, kind: "service", unit: "OTH", hsnSac: /Support|Maintenance/.test(name) ? "998713" : "998313", gstRateBps: 1800 }, book.vouchers)]));
  return { ...book, registration, buyer, supplier, goods, services };
}
const archive = book => ({ format: "financer-tally-archive", version: 1, company: book.company, vouchers: book.vouchers, records: book.records, sources: book.sources, sourceBookHash: null });
function mapping(book, number, completion = { status: "pending" }) {
  const plan = planTallyGstPromotion(book.company, book.vouchers, book.records), row = plan.rows.find(row => row.number === number);
  assert.ok(row.source, JSON.stringify(row.blockers));
  const inward = row.type === "Purchase", mixed = row.source.hasGoods;
  const ledger = name => book.company.ledgers.find(row => row.name === name).id;
  return { recordId: row.recordId, registrationId: book.registration.id, partyId: inward ? book.supplier.id : book.buyer.id,
    stockMode: mixed ? "source" : "financial-only", items: mixed ? [{ sourceName: "Widget", itemId: book.goods.id }] : [],
    serviceItems: row.source.items.filter(item => item.kind === "service").map(item => ({ sourceLineId: item.sourceLineId, itemId: book.services.get(item.sourceName).id, ...(inward ? { completionReview: structuredClone(completion) } : {}) })),
    accounts: { party: inward ? book.supplier.supplierLedgerId : book.buyer.customerLedgerId, cgst: ledger("CGST"), sgst: ledger("SGST"), ...(mixed ? { [inward ? "purchase" : "sales"]: ledger(inward ? "Goods Purchases" : "Goods Sales") } : {}) },
    ...(mixed && inward ? { purchaseReview: { receivedDate: "2026-04-11" } } : {}), evidence: { name: "Synthetic service source review", reference: `Original service rows, SAC and dated financial evidence for ${number}` } };
}
function save(book, input) {
  return { ...book, ...saveTallyGstMapping(book.company, book.vouchers, book.records, { ...input, revision: book.company.gst.tallyPromotion?.revision || 0, requestId: requestId("map") }) };
}
function active(book = fixture(), numbers = ["SV-101", "PV-201", "MS-102", "MP-202"]) {
  for (const number of numbers) book = save(book, mapping(book, number));
  const plan = planTallyGstPromotion(book.company, book.vouchers, book.records), rows = plan.rows.filter(row => numbers.includes(row.number));
  assert.ok(rows.every(row => row.status === "ready"), JSON.stringify(rows.map(row => [row.number, row.blockers])));
  const input = { revision: plan.revision, reviewHash: plan.reviewHash, recordIds: rows.map(row => row.recordId), requestId: requestId("activate") };
  return { ...book, ...activateTallyGstPromotion(book.company, book.vouchers, book.records, input), activationInput: input };
}

test("pure and mixed Sales/Purchase services preserve every original posting and goods-only stock", () => {
  const source = fixture(), postings = structuredClone(source.vouchers), trial = trialBalance(source.company, source.vouchers, "2026-04-01", "2026-04-30");
  const book = active(source);
  assert.deepEqual(book.vouchers.map(({ gst, ...row }) => row), postings);
  assert.deepEqual(trialBalance(book.company, book.vouchers, "2026-04-01", "2026-04-30"), trial);
  assert.deepEqual(book.vouchers.map(row => [row.gst.tallyOrigin.version, row.gst.totals.taxablePaise, row.gst.totals.taxPaise]), [[4, 150000, 27000], [4, 100000, 18000], [4, 150000, 27000], [4, 140000, 25200]]);
  assert.equal(book.company.stock.journals.length, 2);
  assert.equal(stockState(book.company, book.vouchers, { to: "2026-04-30" }).items[0].quantity, "11");
  for (const voucher of book.vouchers) {
    const invoice = voucher.gst, origin = invoice.tallyOrigin, services = origin.source.items.filter(row => row.kind === "service");
    assert.equal(origin.serviceItems.length, services.length);
    assert.ok(services.every(row => row.quantityBasis === "amount-only" && row.quantity === "1" && row.actualQuantity === null));
    assert.ok(origin.stockLineMap.every(index => invoice.items[index].kind === "goods"));
    if (origin.source.serviceOnly) { assert.equal(origin.stockMode, "financial-only"); assert.equal(invoice.receivedDate, undefined); assert.equal(origin.stockJournalId, null); }
    for (const service of origin.serviceItems) {
      const row = origin.source.items[service.invoiceLineIndex], role = `service:${service.sourceLineId}`;
      assert.equal(origin.accounts[role], row.sourceLedgerId);
      assert.ok(row.sourcePostingIndexes.every(index => origin.postingRoles[index] === role && voucher.lines[index].ledgerId === row.sourceLedgerId));
    }
  }
  assert.equal(book.vouchers[1].gst.supplierInvoiceNumber, "SUP-SVC-21");
  assert.equal(book.vouchers[1].gst.supplierInvoiceDate, "2026-04-06");
  assertTallyGstOrigins(book.company, book.vouchers, book.records);
  assert.deepEqual(restoreTallyArchive(archive(book)).vouchers, book.vouchers);
  validateTransfer({ company: book.company, vouchers: book.vouchers });
  const replay = activateTallyGstPromotion(book.company, book.vouchers, book.records, book.activationInput);
  assert.equal(replay.replayed, true); assert.equal(replay.company.stock.journals.length, 2);
});

test("service completion is explicit, can follow booking, and never becomes a goods receipt", () => {
  const source = fixture(), input = mapping(source, "PV-201");
  delete input.serviceItems[0].completionReview;
  const held = save(source, input);
  assert.match(held.report.rows.find(row => row.number === "PV-201").blockers[0].message, /confirmed or pending receipt/);
  const confirmed = mapping(source, "PV-201", { status: "confirmed", date: "2026-04-15", reference: "Synthetic completion after the supplier expense was accrued" });
  let book = save(source, confirmed);
  const plan = planTallyGstPromotion(book.company, book.vouchers, book.records), row = plan.rows.find(row => row.number === "PV-201");
  assert.equal(row.status, "ready", JSON.stringify(row.blockers));
  book = { ...book, ...activateTallyGstPromotion(book.company, book.vouchers, book.records, { revision: plan.revision, reviewHash: plan.reviewHash, recordIds: [row.recordId], requestId: requestId("accrual") }) };
  assert.equal(book.vouchers[1].gst.tallyOrigin.serviceItems[0].completionReview.date, "2026-04-15");
  assert.equal(book.vouchers[1].gst.itcEligibility, "pending"); assert.equal(book.vouchers[1].gst.receivedDate, undefined);
  const invented = mapping(source, "PV-201"); invented.purchaseReview = { receivedDate: "2026-04-07" };
  assert.match(save(source, invented).report.rows.find(row => row.number === "PV-201").blockers[0].message, /not a goods receipt/);
  const datedPending = mapping(source, "PV-201"); datedPending.serviceItems[0].completionReview.date = "2026-04-07";
  assert.throws(() => save(source, datedPending), /pending service cannot assert/);
});

test("historical SAC/rate proofs win over later local master edits and survive full restore", () => {
  const book = active();
  for (const item of book.services.values()) saveItem(book.company, { ...item, hsnSac: "998311", gstRateBps: 1200 }, book.vouchers);
  assert.ok(book.vouchers.every(voucher => voucher.gst.items.every(line => line.gstRateBps === 1800)));
  assert.ok(book.vouchers[0].gst.tallyOrigin.taxFactReview.filter(row => row.field.startsWith("service:") && row.field.endsWith(":gstRateBps")).every(row => row.evidence.some(proof => proof.effectiveFrom === "2025-04-01") && row.superseded.some(proof => proof.reason === "future-effective")));
  assert.deepEqual(restoreTallyArchive(archive(book)).vouchers, book.vouchers);
});

function changeMaster(xml, name, edit) {
  const pattern = new RegExp(`<LEDGER NAME="${name}">[\\s\\S]*?<\\/LEDGER>`);
  return xml.replace(pattern, edit);
}
function changeVoucher(xml, number, edit) {
  return xml.replace(/<VOUCHER\b[\s\S]*?<\/VOUCHER>/g, entry => entry.includes(`<VOUCHERNUMBER>${number}</VOUCHERNUMBER>`) ? edit(entry) : entry);
}
function stripServiceFacts(entry) {
  return entry.replace(/<GSTTYPEOFSUPPLY>[\s\S]*?<\/GSTTYPEOFSUPPLY>/g, "").replace(/<GSTDETAILS\.LIST>[\s\S]*?<\/GSTDETAILS\.LIST>/g, "").replace(/<HSNDETAILS\.LIST>[\s\S]*?<\/HSNDETAILS\.LIST>/g, "");
}

test("missing SAC/rate facts stay distinct from invalid facts and require the matching review basis", () => {
  const missing = fixture(xml => changeMaster(xml, "Consulting Income", entry => entry.replace(/<GSTDETAILS\.LIST>[\s\S]*?<\/GSTDETAILS\.LIST>/g, "").replace(/<HSNDETAILS\.LIST>[\s\S]*?<\/HSNDETAILS\.LIST>/g, "")));
  const local = active(missing, ["SV-101"]), missingReview = local.vouchers[0].gst.tallyOrigin.taxFactReview;
  assert.ok(missingReview.some(row => row.field === "service:ledger-entry:1:hsnSac" && row.status === "absent" && row.chosenBasis === "local-mapping"));
  const invalid = fixture(xml => changeMaster(xml, "Consulting Income", entry => entry.replace("<HSNCODE>998313</HSNCODE>", "<HSNCODE>BAD-SAC</HSNCODE>")));
  const input = mapping(invalid, "SV-101"), held = save(invalid, input), row = held.report.rows.find(row => row.number === "SV-101");
  assert.equal(row.source.taxFacts.items[0].hsnSac.status, "conflict");
  assert.match(row.blockers[0].message, /explicit review or a correction reason/);
  input.sourceCorrections = { "service:ledger-entry:1:hsnSac": "Actual synthetic invoice confirms SAC 998313; invalid exported SAC retained for audit" };
  let corrected = save(invalid, input), plan = planTallyGstPromotion(corrected.company, corrected.vouchers, corrected.records), ready = plan.rows.find(row => row.number === "SV-101");
  assert.equal(ready.status, "ready", JSON.stringify(ready.blockers));
  corrected = { ...corrected, ...activateTallyGstPromotion(corrected.company, corrected.vouchers, corrected.records, { revision: plan.revision, reviewHash: plan.reviewHash, recordIds: [ready.recordId], requestId: requestId("correct") }) };
  assert.equal(corrected.vouchers[0].gst.items[0].hsnSac, "998313");
  assert.equal(corrected.vouchers[0].gst.tallyOrigin.taxFactReview.find(row => row.field === "service:ledger-entry:1:hsnSac").status, "corrected");
  assert.deepEqual(restoreTallyArchive(archive(corrected)).vouchers, corrected.vouchers);
});

test("a generic Purchase ledger never becomes a service without explicit row classification and evidence", () => {
  const book = fixture(xml => changeMaster(xml, "Professional Fees", entry => stripServiceFacts(entry).replace('NAME="Professional Fees"', 'NAME="Purchase"').replace("<PARENT>Indirect Expenses</PARENT>", "<PARENT>Purchase Accounts</PARENT>")).replaceAll("<LEDGERNAME>Professional Fees</LEDGERNAME>", "<LEDGERNAME>Purchase</LEDGERNAME>"));
  const input = mapping(book, "PV-201"), held = save(book, input), row = held.report.rows.find(row => row.number === "PV-201");
  assert.equal(row.source.serviceCandidates.length, 1);
  assert.equal(row.source.serviceCandidates[0].classificationStatus, "absent");
  assert.match(row.blockers[0].message, /every unclassified source amount/);
  input.serviceItems.push({ sourceLineId: row.source.serviceCandidates[0].sourceLineId, itemId: book.services.get("Professional Fees").id, classificationConfirmed: true, completionReview: { status: "pending", reference: "Actual supplier document establishes a service; acceptance still pending" } });
  let reviewed = save(book, input), plan = planTallyGstPromotion(reviewed.company, reviewed.vouchers, reviewed.records), ready = plan.rows.find(row => row.number === "PV-201");
  assert.equal(ready.status, "ready", JSON.stringify(ready.blockers));
  reviewed = { ...reviewed, ...activateTallyGstPromotion(reviewed.company, reviewed.vouchers, reviewed.records, { revision: plan.revision, reviewHash: plan.reviewHash, recordIds: [ready.recordId], requestId: requestId("classified") }) };
  const invoice = reviewed.vouchers[1].gst;
  assert.equal(invoice.tallyOrigin.source.items[0].serviceClassification, "reviewed");
  assert.equal(invoice.tallyOrigin.source.items[0].sourceLedgerName, "Purchase");
  assert.equal(invoice.tallyOrigin.serviceItems[0].classificationConfirmed, true);
  assert.deepEqual(restoreTallyArchive(archive(reviewed)).vouchers, reviewed.vouchers);
});

test("a source with only generic posting candidates has an explicit accounting-only review blocker", () => {
  const book = fixture(xml => ["Professional Fees", "Maintenance Expense"].reduce((source, name) => changeMaster(source, name, stripServiceFacts), xml));
  const row = planTallyGstPromotion(book.company, book.vouchers, book.records).rows.find(row => row.number === "PV-201");
  assert.equal(row.status, "blocked");
  assert.equal(row.source.items.length, 0);
  assert.equal(row.source.serviceCandidates.length, 2);
  assert.ok(row.source.serviceCandidates.every(row => row.classificationRequired && row.classificationStatus === "absent"));
  assert.match(row.blockers[0].message, /no classified goods or service item lines.*Unconfirmed.*accounting-only/);
  assert.equal(book.vouchers[1].gst, undefined);
});

test("distinct service rows sharing one source ledger retain independent posting roles", () => {
  const book = fixture(xml => changeVoucher(xml, "SV-101", entry => entry.replace("<LEDGERNAME>Support Income</LEDGERNAME>", "<LEDGERNAME>Consulting Income</LEDGERNAME>")));
  const input = mapping(book, "SV-101"); input.serviceItems.reverse();
  let saved = save(book, input), plan = planTallyGstPromotion(saved.company, saved.vouchers, saved.records), row = plan.rows.find(row => row.number === "SV-101");
  assert.equal(row.status, "ready", JSON.stringify(row.blockers));
  saved = { ...saved, ...activateTallyGstPromotion(saved.company, saved.vouchers, saved.records, { revision: plan.revision, reviewHash: plan.reviewHash, recordIds: [row.recordId], requestId: requestId("same-ledger") }) };
  const origin = saved.vouchers[0].gst.tallyOrigin;
  assert.equal(origin.accounts["service:ledger-entry:1"], origin.accounts["service:ledger-entry:2"]);
  assert.equal(origin.postingRoles[1], "service:ledger-entry:1"); assert.equal(origin.postingRoles[2], "service:ledger-entry:2");
  assert.deepEqual(saved.vouchers[0].gst.items.map(row => row.taxablePaise), [100000, 50000]);
  assert.deepEqual(restoreTallyArchive(archive(saved)).vouchers, saved.vouchers);
});

for (const stockBaselineVersion of [undefined, 1]) test(`goods and a service sharing a source ledger retain separate postings with ${stockBaselineVersion === 1 ? "legacy" : "current"} stock baseline`, () => {
  const book = fixture(xml => changeVoucher(xml, "MS-102", entry => entry.replace("<LEDGERNAME>Consulting Income</LEDGERNAME>", "<LEDGERNAME>Goods Sales</LEDGERNAME><GSTTYPEOFSUPPLY>Services</GSTTYPEOFSUPPLY><HSNCODE>998313</HSNCODE>")), stockBaselineVersion);
  const baseline = book.company.stock.journals.find(row => row.accountingVoucherId === book.vouchers[2].id);
  book.services.set("Goods Sales", book.services.get("Consulting Income"));
  const promoted = active(book, ["MS-102"]), origin = promoted.vouchers[2].gst.tallyOrigin;
  assert.equal(origin.accounts.sales, origin.accounts["service:ledger-entry:2"]);
  assert.equal(origin.postingRoles[1], "sales"); assert.equal(origin.postingRoles[2], "service:ledger-entry:2");
  assert.deepEqual(origin.stockLineMap, [0]);
  if (stockBaselineVersion === 1) { assert.equal(baseline, undefined); assert.ok(origin.stockJournalId.startsWith("sj-tally-service-")); }
  else { assert.ok(baseline); assert.equal(origin.stockJournalId, baseline.id); assert.deepEqual(promoted.company.stock.journals.find(row => row.id === baseline.id), baseline); }
  assert.deepEqual(restoreTallyArchive(archive(promoted)).vouchers, promoted.vouchers);
});

test("mixed services retain reporting-only goods gaps without manufacturing stock", () => {
  let book = fixture(xml => xml.replace(/<ACTUALQTY>[^<]*<\/ACTUALQTY>/g, ""));
  assert.equal(book.company.stock.journals.length, 0);
  for (const number of ["MS-102", "MP-202"]) book = save(book, { ...mapping(book, number), stockMode: "report-only" });
  const plan = planTallyGstPromotion(book.company, book.vouchers, book.records), rows = plan.rows.filter(row => ["MS-102", "MP-202"].includes(row.number));
  assert.ok(rows.every(row => row.status === "ready"), JSON.stringify(rows.map(row => row.blockers)));
  book = { ...book, ...activateTallyGstPromotion(book.company, book.vouchers, book.records, { revision: plan.revision, reviewHash: plan.reviewHash, recordIds: rows.map(row => row.recordId), requestId: requestId("reporting-only") }) };
  assert.equal(book.company.stock.journals.length, 0);
  assert.equal(book.company.stock.tally.hasSourceGaps, true);
  assert.equal(stockState(book.company, book.vouchers, { to: "2026-04-30" }).items[0].quantity, "10");
  for (const voucher of book.vouchers.filter(row => row.gst)) {
    assert.equal(voucher.gst.stockEffect, "none");
    assert.equal(voucher.gst.tallyOrigin.stockJournalId, null);
    assert.deepEqual(voucher.gst.tallyOrigin.stockLineMap, []);
    assert.ok(voucher.gst.items.some(row => row.kind === "goods"));
    assert.ok(voucher.gst.items.some(row => row.kind === "service"));
  }
  assertTallyGstOrigins(book.company, book.vouchers, book.records);
  assert.deepEqual(restoreTallyArchive(archive(book)).vouchers, book.vouchers);
  const physical = fixture(), input = { ...mapping(physical, "MS-102"), stockMode: "report-only" };
  assert.match(save(physical, input).report.rows.find(row => row.number === "MS-102").blockers[0].message, /cannot hide a supplied physical quantity/);
});

const digest = input => createHash("sha256").update(JSON.stringify(input)).digest("hex");
function resealInvoices(book) {
  for (const voucher of book.vouchers.filter(row => row.gst)) {
    const target = book.company.gst.tallyPromotion.activations.flatMap(row => row.targets).find(row => row.voucherId === voucher.id);
    target.invoiceHash = digest(voucher.gst);
  }
}

test("service ledger, completion and stock invariants reject altered snapshots even with refreshed invoice hashes", () => {
  const book = active();
  const edits = [
    copy => { copy.vouchers[1].gst.receivedDate = "2026-04-08"; },
    copy => { copy.vouchers[1].gst.itcEligibility = "eligible"; },
    copy => { copy.vouchers[1].gst.tallyOrigin.serviceItems[0].completionReview = { status: "confirmed", date: "2026-04-15", reference: "Altered completion evidence" }; },
    copy => { copy.vouchers[0].gst.tallyOrigin.serviceItems[0].invoiceLineIndex = 1; },
    copy => { copy.vouchers[0].gst.tallyOrigin.serviceItems[0].sourceLedgerId = copy.vouchers[0].gst.tallyOrigin.source.items[1].sourceLedgerId; },
    copy => { copy.vouchers[0].gst.tallyOrigin.source.items[0].actualQuantity = "1"; },
    copy => { copy.vouchers[0].gst.tallyOrigin.source.items[0].sourcePostingIndexes = [2]; },
    copy => { copy.vouchers[0].gst.tallyOrigin.postingRoles[1] = "service:ledger-entry:2"; },
    copy => { copy.vouchers[2].gst.tallyOrigin.stockLineMap[0] = 1; },
    copy => { const voucher = copy.vouchers[3], journal = copy.company.stock.journals.find(row => row.accountingVoucherId === voucher.id); journal.lines[0].quantity = "4"; voucher.gst.tallyOrigin.stockJournalHash = digest(journal); },
    copy => { copy.company.ledgers.find(row => row.name === "Consulting Income").groupId = "g-bank"; },
  ];
  for (const [index, edit] of edits.entries()) {
    const copy = structuredClone(book); edit(copy); resealInvoices(copy);
    assert.throws(() => assertTallyGstBook(copy.company, copy.vouchers), `book guard ${index}`);
    assert.throws(() => restoreTallyArchive(archive(copy)), `archive guard ${index}`);
    assert.throws(() => validateTransfer({ company: copy.company, vouchers: copy.vouchers }), `accounting guard ${index}`);
  }
});

test("full restore rebuilds service tax evidence from the original dated source", () => {
  const book = active(), copy = structuredClone(book), invoice = copy.vouchers[0].gst;
  const review = invoice.tallyOrigin.taxFactReview.find(row => row.field === "service:ledger-entry:1:gstRateBps");
  assert.ok(review.evidence.some(row => row.effectiveFrom === "2025-04-01"));
  review.evidence.find(row => row.effectiveFrom === "2025-04-01").effectiveFrom = "2026-04-01";
  resealInvoices(copy);
  assert.throws(() => assertTallyGstOrigins(copy.company, copy.vouchers, copy.records), /differs from its original source/);
  assert.throws(() => restoreTallyArchive(archive(copy)), /differs from its original source/);
});
