// Regression tests for docs/audit-2026-11-08/gst.md. Each test reproduces a
// wrong return figure or an accepted invalid document before the fix.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertGstMasters, assertGstReferences, assertGstSnapshot, buildGstInvoice, correctionCutoff, gstinCheckDigit, gstinType, gstVoucher, isBeyondCorrectionCutoff, normalizeGstin } from "../lib/gst.js";
import { itcClaimDeadline, itcState } from "../lib/gst-itc.js";
import { reconcile2B } from "../lib/gst-reconcile.js";
import { returnWorkbook } from "../lib/gst-returns.js";
import { createStore } from "../lib/store.js";
import { companyBackup, validateTransfer } from "../lib/transfer.js";

const withCheck = stem => stem + gstinCheckDigit(stem);
const gstin = (state, pan = "ABCDE1234F") => withCheck(`${state}${pan}1Z`);
const TDS = withCheck("07DELA12345A1D");
const TCS = withCheck("07AAACF1234A1C");
const UIN = withCheck("0717UNO00157UN");
const EMBASSY_UIN = withCheck("0718USA00001ON");
const NRTP = withCheck("0718USA00001NR");
const OIDAR = withCheck("9917SGP29001OS");

async function book(run, { booksFrom = "2024-04-01", partyState = "23", partyGstin } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ledgercraft-gst-audit-"));
  const store = createStore(dataDir);
  try {
    const { company } = await store.create({ name: "Synthetic GST Audit Books", booksFrom });
    const registration = (await store.saveGstMaster(company.id, "registration", { name: "Synthetic Trader", legalName: "Synthetic Trader", gstin: gstin("23"), stateCode: "23", address: "Test address", pincode: "462001" })).registration;
    const party = (await store.saveGstMaster(company.id, "party", { name: "Synthetic Party", gstin: partyGstin ?? gstin(partyState, "PQRST5678L"), stateCode: partyState, address: "Party test address", kind: "both" })).party;
    const item = (await store.saveGstMaster(company.id, "item", { name: "Synthetic Goods", kind: "goods", hsnSac: "8541", unit: "NOS", pricePaise: 10000, gstRateBps: 1800, cessRateBps: 0, supplyStatus: "taxable", openingQuantity: "10" })).item;
    const input = { type: "Sales", registrationId: registration.id, partyId: party.id, date: "2024-05-01", placeOfSupply: partyState, pricing: "exclusive", items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000 }] };
    await run({ store, dataDir, company, registration, party, item, input });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
}

// 1. Section 34(2) -----------------------------------------------------------
test("section 34(2): a tax-reducing sales credit note after 30 November of the next FY is rejected with guidance", async () => {
  await book(async ({ store, company, input }) => {
    const sale = (await store.passGstInvoice(company.id, input)).invoice;
    const note = { ...input, type: "Credit Note", direction: "sales", originalInvoiceId: sale.id, date: "2026-01-15" };
    await assert.rejects(store.passGstInvoice(company.id, note), error => {
      assert.match(error.message, /section 34\(2\)/i);
      assert.match(error.message, /30-11-2025/);
      assert.match(error.message, /without GST/i);
      return true;
    });
    // No CDNR row and no 3.1(a) reduction can be produced for the rejected note.
    const books = await store.get(company.id);
    const report = returnWorkbook(books.company, books.vouchers, sale.registrationId, "2026-01");
    assert.equal(report.sheets.cdnr.length, 0);
    assert.equal(report.summary.outwardTaxable.cgstPaise, 0);
    // The last permitted day still works.
    const onTime = await store.passGstInvoice(company.id, { ...note, date: "2025-11-30" });
    assert.equal(onTime.invoice.totals.cgstPaise, 900);
  });
});

test("section 34(2): unlinked notes use their declared original date and a recorded annual return brings the cutoff forward", async () => {
  await book(async ({ store, company, input }) => {
    const unlinked = { ...input, type: "Credit Note", direction: "sales", originalNumber: "OLD-1", originalDate: "2024-06-10", date: "2025-12-01" };
    await assert.rejects(store.passGstInvoice(company.id, unlinked), /section 34\(2\)/i);
    const books = await store.get(company.id);
    const withAnnual = structuredClone(books.company);
    withAnnual.gst.outwardAmendments = { version: 1, revision: 1, records: [{ registrationId: input.registrationId, cutoff: { financialYear: "2024-04-01", annualReturnFiledDate: "2025-10-10" } }] };
    assert.throws(() => buildGstInvoice(withAnnual, books.vouchers, { ...unlinked, date: "2025-10-10" }), /10-10-2025/);
    assert.doesNotThrow(() => buildGstInvoice(withAnnual, books.vouchers, { ...unlinked, date: "2025-10-09" }));
    // A zero-tax note does not reduce output tax and is outside section 34(2).
    const exempt = (await store.saveGstMaster(company.id, "item", { name: "Exempt Goods", kind: "goods", hsnSac: "0701", unit: "KGS", gstRateBps: 0, supplyStatus: "exempt" })).item;
    const latest = await store.get(company.id);
    assert.doesNotThrow(() => buildGstInvoice(latest.company, latest.vouchers, { ...unlinked, items: [{ itemId: exempt.id, quantity: "1", unitPricePaise: 1000 }] }));
  });
});

test("section 34(2) helper is the single cutoff rule, including legacy September cutoffs", () => {
  assert.deepEqual(correctionCutoff("2024-05-01"), { financialYear: "2024-04-01", ordinaryDate: "2025-11-30", annualReturnFiledDate: null, latestDate: "2025-11-30" });
  const early = correctionCutoff("2024-05-01", "2025-08-01");
  assert.equal(early.latestDate, "2025-08-01");
  assert.equal(isBeyondCorrectionCutoff("2025-07-31", early), false);
  assert.equal(isBeyondCorrectionCutoff("2025-08-01", early), true);
  assert.equal(correctionCutoff("2020-05-01", null, { legacy: true }).ordinaryDate, "2021-09-30");
  assert.equal(correctionCutoff("2021-05-01", null, { legacy: true }).ordinaryDate, "2022-11-30");
});

test("section 34(2): notes saved before the cutoff check still replay, back up and restore", async () => {
  await book(async ({ store, company, input }) => {
    const sale = (await store.passGstInvoice(company.id, input)).invoice;
    await store.passGstInvoice(company.id, { ...input, type: "Credit Note", direction: "sales", originalInvoiceId: sale.id, date: "2025-11-30" });
    const books = await store.get(company.id);
    // Simulate a late note written by an earlier release (same FY, later date).
    const legacy = books.vouchers.find(voucher => voucher.gst.type === "Credit Note");
    legacy.date = "2026-01-15"; legacy.gst.date = "2026-01-15";
    assert.doesNotThrow(() => assertGstSnapshot(books.company, legacy));
    assert.doesNotThrow(() => assertGstReferences(legacy.gst, books.vouchers));
    assert.equal(validateTransfer(companyBackup(books.company, books.vouchers)).vouchers.length, 2);
  });
});

// 2. Supplier invoice date -----------------------------------------------------
test("section 16(4) deadline, ITC evidence and 2B matching use the supplier invoice date", async () => {
  await book(async ({ store, company, input }) => {
    const purchase = { ...input, type: "Purchase", date: "2025-04-05", supplierInvoiceNumber: "SUP/77", supplierInvoiceDate: "2025-03-28", itcEligibility: "eligible" };
    await assert.rejects(store.passGstInvoice(company.id, { ...purchase, supplierInvoiceDate: "2025-04-06" }), /supplier invoice date/i);
    await assert.rejects(store.passGstInvoice(company.id, { ...purchase, supplierInvoiceDate: "28-03-2025" }), /supplier invoice date/i);
    await assert.rejects(store.passGstInvoice(company.id, { ...input, supplierInvoiceDate: "2024-05-01" }), /purchase/i);
    const { invoice, voucher } = await store.passGstInvoice(company.id, purchase);
    assert.equal(invoice.supplierInvoiceDate, "2025-03-28");
    assert.equal(itcClaimDeadline(invoice).ordinary, "2025-11-30");
    const books = await store.get(company.id);
    const row = itcState(books.company, books.vouchers, "2025-04-30").documents.find(document => document.id === invoice.id);
    assert.equal(row.supplierInvoiceDate, "2025-03-28");
    assert.equal(row.claimDeadline, "2025-11-30");
    const report = returnWorkbook(books.company, books.vouchers, invoice.registrationId, "2025-04");
    assert.equal(report.evidence.find(entry => entry.id === invoice.id).supplierInvoiceDate, "2025-03-28");
    // Replay rejects a tampered supplier date.
    const tampered = structuredClone(voucher);
    tampered.gst.supplierInvoiceDate = "2025-04-09";
    assert.throws(() => assertGstSnapshot(books.company, tampered), /supplier invoice date/i);
    // Saves that omit the field keep working and fall back to the voucher date.
    const plain = await store.passGstInvoice(company.id, { ...purchase, supplierInvoiceNumber: "SUP/78", supplierInvoiceDate: undefined });
    assert.equal(plain.invoice.supplierInvoiceDate, undefined);
    assert.equal(itcClaimDeadline(plain.invoice).ordinary, "2026-11-30");
    // Purchase notes accept it and inherit the supplier date of the original.
    const note = await store.passGstInvoice(company.id, { ...purchase, type: "Debit Note", direction: "purchase", originalInvoiceId: invoice.id, supplierInvoiceNumber: "SUP/DN1", supplierInvoiceDate: "2025-04-02", date: "2025-04-07" });
    assert.equal(note.invoice.supplierInvoiceDate, "2025-04-02");
    assert.equal(note.invoice.originalDate, "2025-03-28");
    const after = await store.get(company.id);
    assert.equal(validateTransfer(companyBackup(after.company, after.vouchers)).vouchers.length, 3);
  }, { partyState: "27" });
});

test("2B reconciliation keys and compares on the supplier invoice date across a financial-year boundary", () => {
  const party = { gstin: "27ABCDE1234F1Z0" };
  const reg = { id: "main", gstin: "23ABCDE1234F1Z8" };
  const company = { gst: { registrations: [reg] } };
  const totals = { taxablePaise: 10000, igstPaise: 1800, cgstPaise: 0, sgstPaise: 0, utgstPaise: 0, cessPaise: 0, totalPaise: 11800 };
  const vouchers = [{ gst: { id: "late", direction: "purchase", registrationId: reg.id, type: "Purchase", supplierInvoiceNumber: "SUP/77", supplierInvoiceDate: "2025-03-28", date: "2025-04-05", party, totals, placeOfSupply: "23", reverseCharge: false } }];
  const statement = { gstin: reg.gstin, rtnprd: "042025", docdata: { b2b: [{ ctin: party.gstin, inv: [{ inum: "SUP/77", dt: "28-03-2025", pos: "23", rev: "N", val: 118, txval: 100, igst: 18, itcavl: "Y" }] }] } };
  const [row] = reconcile2B(company, vouchers, reg.id, "2025-04", statement).results;
  assert.equal(row.status, "Matched");
  assert.equal(row.bookId, "late");
  assert.deepEqual(row.differences, []);
  // A March 2B also sees the April booking because the supplier dated it in March.
  const march = reconcile2B(company, vouchers, reg.id, "2025-03", { ...statement, rtnprd: "032025" }).results;
  assert.equal(march[0].status, "Matched");
});

// 3. SEZ ---------------------------------------------------------------------
test("SEZ supplies need a recipient GSTIN and can never fall into B2CS", async () => {
  await book(async ({ store, company, input, item }) => {
    const unregistered = (await store.saveGstMaster(company.id, "party", { name: "Unregistered SEZ claim", gstin: "", stateCode: "23", address: "SEZ address", kind: "customer" })).party;
    const sez = { ...input, date: "2025-06-01", partyId: unregistered.id, supplyCategory: "sez", exportMode: "with-payment", items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000, supplyStatus: "zero-rated", gstRateBps: 1800 }] };
    await assert.rejects(store.passGstInvoice(company.id, sez), /SEZ.*GSTIN/i);
  });
  const registration = { id: "reg", name: "Synthetic", gstin: "23ABCDE1234F1Z8", stateCode: "23" };
  const line = { itemId: "item", kind: "goods", name: "Goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1800, supplyStatus: "zero-rated", quantity: "1", taxablePaise: 100000, igstPaise: 18000, cgstPaise: 0, sgstPaise: 0, utgstPaise: 0, cessPaise: 0, taxPaise: 18000, totalPaise: 118000 };
  const legacy = { id: "SEZ-1", date: "2026-01-05", gst: { id: "SEZ-1", date: "2026-01-05", number: "SEZ-1", type: "Sales", direction: "sales", registration, registrationId: "reg", party: { name: "Legacy", gstin: "" }, placeOfSupply: "23", supplyCategory: "sez", exportMode: "with-payment", items: [line], totals: line } };
  assert.throws(() => returnWorkbook({ gst: { registrations: [registration] } }, [legacy], "reg", "2026-01"), /SEZ-1.*(SEZ|zero-rated)/);
});

// 4. GSTIN identifier types ----------------------------------------------------
test("GSTN identifier formats (TDS, TCS, UIN, NRTP, OIDAR) pass the same checksum and are typed", () => {
  assert.equal(gstinType(gstin("23")), "regular");
  assert.equal(gstinType(normalizeGstin(TDS)), "tds");
  assert.equal(gstinType(normalizeGstin(TCS)), "tcs");
  assert.equal(gstinType(normalizeGstin(UIN)), "uin");
  assert.equal(gstinType(normalizeGstin(EMBASSY_UIN)), "uin");
  assert.equal(gstinType(normalizeGstin(NRTP)), "nrtp");
  assert.equal(gstinType(normalizeGstin(OIDAR)), "oidar");
  assert.throws(() => normalizeGstin(TDS.slice(0, 14) + (TDS[14] === "A" ? "B" : "A")), /checksum/);
  assert.throws(() => normalizeGstin(UIN.slice(0, 14) + (UIN[14] === "A" ? "B" : "A")), /checksum/);
  assert.throws(() => normalizeGstin(withCheck("0717UNO00157XX")), /checksum|format/);
});

test("TDS and UIN recipients are B2B customers, cannot be suppliers, and registrations stay regular", async () => {
  await book(async ({ store, company, input, registration }) => {
    await assert.rejects(store.saveGstMaster(company.id, "registration", { name: "TDS desk", gstin: TDS, stateCode: "07", address: "Delhi" }), /regular GSTIN/);
    const tds = (await store.saveGstMaster(company.id, "party", { name: "Synthetic Government Department", gstin: TDS, stateCode: "07", address: "Delhi office" })).party;
    assert.equal(tds.identifierType, "tds");
    assert.equal(tds.kind, "customer");
    const uin = (await store.saveGstMaster(company.id, "party", { name: "Synthetic UN Body", gstin: UIN, stateCode: "07", address: "Delhi mission" })).party;
    assert.equal(uin.identifierType, "uin");
    await assert.rejects(store.saveGstMaster(company.id, "party", { name: "UIN supplier", gstin: EMBASSY_UIN, stateCode: "07", address: "Embassy", kind: "supplier" }), /UIN.*supplier|cannot be a supplier/i);
    await assert.rejects(store.saveGstMaster(company.id, "party", { name: "TDS both", gstin: withCheck("23BPLA12345B1D"), stateCode: "23", address: "Office", kind: "both" }), /cannot be a supplier/i);
    const regular = (await store.saveGstMaster(company.id, "party", { name: "Synthetic Regular", gstin: gstin("27", "LMNOP1234Q"), stateCode: "27", address: "Mumbai" })).party;
    assert.equal(regular.identifierType, "regular");
    const sale = await store.passGstInvoice(company.id, { ...input, date: "2025-06-01", partyId: uin.id, placeOfSupply: "07" });
    await store.passGstInvoice(company.id, { ...input, date: "2025-06-02", partyId: tds.id, placeOfSupply: "07" });
    const books = await store.get(company.id);
    assert.doesNotThrow(() => assertGstMasters(books.company));
    const report = returnWorkbook(books.company, books.vouchers, registration.id, "2025-06");
    assert.deepEqual(report.sheets["b2b,sez,de"].map(row => row[0]).sort(), [TDS, UIN].sort());
    assert.equal(report.sheets.b2cs.length, 0);
    assert.equal(report.sheets.b2cl.length, 0);
    assert.equal(sale.invoice.party.identifierType, "uin");
  });
});

test("TCS collection IDs cannot be invoice parties; OIDAR IDs belong to foreign suppliers only", async () => {
  await book(async ({ store, company, input }) => {
    const tcs = (await store.saveGstMaster(company.id, "party", { name: "Synthetic Marketplace TCS", gstin: TCS, stateCode: "07", address: "Delhi" })).party;
    assert.equal(tcs.identifierType, "tcs");
    await assert.rejects(store.passGstInvoice(company.id, { ...input, date: "2025-06-01", partyId: tcs.id, placeOfSupply: "07" }), /TCS/);
    await assert.rejects(store.saveGstMaster(company.id, "party", { name: "OIDAR in India", gstin: OIDAR, stateCode: "29", address: "Bengaluru" }), /foreign/i);
    const oidar = (await store.saveGstMaster(company.id, "party", { name: "Synthetic Cloud Vendor", gstin: OIDAR, stateCode: "96", address: "Singapore" })).party;
    assert.equal(oidar.identifierType, "oidar");
    assert.equal(oidar.kind, "supplier");
    const nrtp = (await store.saveGstMaster(company.id, "party", { name: "Synthetic Exhibitor", gstin: NRTP, stateCode: "07", address: "Pragati Maidan" })).party;
    assert.equal(nrtp.identifierType, "nrtp");
    assert.equal(nrtp.kind, "both");
  });
});

// 5. Medium findings -------------------------------------------------------------
test("GST rates outside the notified slabs are rejected unless the item carries an explicit override", async () => {
  await book(async ({ store, company, input, item }) => {
    await assert.rejects(store.saveGstMaster(company.id, "item", { name: "Typo rate", kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1700 }), /notified GST rate/);
    for (const gstRateBps of [0, 10, 25, 100, 150, 300, 500, 600, 750, 1200, 1800, 2800, 4000]) {
      await store.saveGstMaster(company.id, "item", { name: `Rate ${gstRateBps}`, kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps });
    }
    await assert.rejects(store.passGstInvoice(company.id, { ...input, date: "2025-06-01", items: [{ ...input.items[0], gstRateBps: 1700 }] }), /notified GST rate/);
    await assert.rejects(store.passGstInvoice(company.id, { ...input, date: "2025-09-21", items: [{ ...input.items[0], gstRateBps: 4000 }] }), /22-09-2025/);
    assert.equal((await store.passGstInvoice(company.id, { ...input, date: "2025-09-22", items: [{ ...input.items[0], gstRateBps: 4000 }] })).invoice.totals.cgstPaise, 2000);
    const special = (await store.saveGstMaster(company.id, "item", { name: "Override rate", kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1700, rateOverride: true })).item;
    assert.equal(special.rateOverride, true);
    const saved = await store.passGstInvoice(company.id, { ...input, date: "2025-06-02", items: [{ itemId: special.id, quantity: "1", unitPricePaise: 10000 }] });
    assert.equal(saved.invoice.totals.cgstPaise, 850);
    // Books holding older odd-rate documents and masters still load.
    const books = await store.get(company.id);
    const legacy = structuredClone(books.company);
    delete legacy.gst.items.find(row => row.id === special.id).rateOverride;
    assert.doesNotThrow(() => assertGstMasters(legacy));
    assert.doesNotThrow(() => assertGstSnapshot(legacy, books.vouchers.find(voucher => voucher.id === saved.invoice.id)));
    assert.ok(item.id);
  });
});

test("services report UQC NA with zero quantity in the HSN summary and default to NA", async () => {
  await book(async ({ store, company, input, registration }) => {
    const service = (await store.saveGstMaster(company.id, "item", { name: "Consulting", kind: "service", hsnSac: "998311", gstRateBps: 1800 })).item;
    assert.equal(service.unit, "NA");
    const legacy = (await store.saveGstMaster(company.id, "item", { name: "Legacy service", kind: "service", hsnSac: "998312", unit: "OTH", gstRateBps: 1800 })).item;
    await store.passGstInvoice(company.id, { ...input, date: "2025-06-01", items: [{ itemId: service.id, quantity: "3", unitPricePaise: 10000 }, { itemId: legacy.id, quantity: "2", unitPricePaise: 10000 }] });
    const books = await store.get(company.id);
    const rows = returnWorkbook(books.company, books.vouchers, registration.id, "2025-06").sheets["hsn(b2b)"];
    assert.deepEqual(rows.map(row => [row[0], row[2], row[3]]).sort(), [["998311", "NA", "0"], ["998312", "NA", "0"]]);
    assert.equal(books.vouchers[0].gst.items[1].unit, "OTH");
    // Re-saving an invoiced legacy service without a unit keeps its stored unit.
    assert.equal((await store.saveGstMaster(company.id, "item", { id: legacy.id, name: "Legacy service", kind: "service", hsnSac: "998312", gstRateBps: 1800 })).item.unit, "OTH");
  });
});

test("an optional rupee round-off posts to a Round Off ledger and changes the party amount, not the taxable value", async () => {
  await book(async ({ store, company, input, party, registration }) => {
    const sale = { ...input, date: "2025-06-01", items: [{ ...input.items[0], unitPricePaise: 10034 }], roundOffPaise: -40 };
    await assert.rejects(store.passGstInvoice(company.id, sale), /Round Off ledger/);
    await store.addLedger(company.id, { name: "Round Off", groupId: "g-indirect-exp", openingPaise: 0, openingDc: "Dr" });
    const ledger = (await store.get(company.id)).company.ledgers.find(row => row.name === "Round Off");
    await assert.rejects(store.passGstInvoice(company.id, { ...sale, roundOffPaise: 51 }), /between -50 and \+50/);
    await assert.rejects(store.passGstInvoice(company.id, { ...sale, roundOffPaise: 0.5 }), /between -50 and \+50/);
    const { invoice, voucher } = await store.passGstInvoice(company.id, sale);
    assert.equal(invoice.totals.totalPaise, 11840);
    assert.equal(invoice.totals.taxablePaise, 10034);
    assert.equal(invoice.roundOffPaise, -40);
    assert.equal(invoice.roundOffLedgerId, ledger.id);
    assert.equal(invoice.invoiceValuePaise, 11800);
    assert.deepEqual(voucher.lines, [
      { ledgerId: party.customerLedgerId, dc: "Dr", paise: 11800 },
      { ledgerId: registration.accounts.sales, dc: "Cr", paise: 10034 },
      { ledgerId: registration.accounts["output-cgst"], dc: "Cr", paise: 903 },
      { ledgerId: registration.accounts["output-sgst"], dc: "Cr", paise: 903 },
      { ledgerId: ledger.id, dc: "Dr", paise: 40 },
    ]);
    const up = await store.passGstInvoice(company.id, { ...sale, date: "2025-06-02", roundOffPaise: 20, type: "Purchase", supplierInvoiceNumber: "R-1", itcEligibility: "eligible" });
    assert.deepEqual(up.voucher.lines[0], { ledgerId: party.supplierLedgerId, dc: "Cr", paise: 11860 });
    assert.deepEqual(up.voucher.lines.at(-1), { ledgerId: ledger.id, dc: "Dr", paise: 20 });
    const books = await store.get(company.id);
    const report = returnWorkbook(books.company, books.vouchers, registration.id, "2025-06");
    assert.equal(report.sheets["b2b,sez,de"][0][4], "118.00");
    assert.equal(report.sheets["b2b,sez,de"][0][11], "100.34");
    assert.equal(report.summary.outwardTaxable.taxablePaise, 10034);
    const tampered = structuredClone(books.vouchers[0]);
    tampered.gst.roundOffPaise = -41;
    assert.throws(() => assertGstSnapshot(books.company, tampered));
    assert.equal(validateTransfer(companyBackup(books.company, books.vouchers)).vouchers.length, 2);
    assert.equal(gstVoucher(invoice).lines.length, 5);
  });
});

test("RCM reversals marked time-barred or unclassified still reduce the net 4(C) working", async () => {
  const tax = (cgstPaise, sgstPaise) => ({ cgstPaise, sgstPaise, utgstPaise: 0, igstPaise: 0, cessPaise: 0 });
  const claimReview = { received: true, businessUse: true, notBlocked: true, documentsHeld: true, basis: "Synthetic section16/17 eligibility review" };
  for (const reversalReason of ["time-barred", undefined]) {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ledgercraft-gst-audit-rcm-"));
    const store = createStore(dataDir);
    try {
      const { company } = await store.create({ name: "Synthetic RCM Books", booksFrom: "2025-04-01" });
      const registration = (await store.saveGstMaster(company.id, "registration", { name: "Synthetic Recipient", gstin: gstin("23"), stateCode: "23", address: "Public test address" })).registration;
      const party = (await store.saveGstMaster(company.id, "party", { name: "Synthetic Supplier", kind: "supplier", gstin: "", stateCode: "23", address: "Public supplier address" })).party;
      const item = (await store.saveGstMaster(company.id, "item", { name: "Synthetic RCM supply", kind: "service", hsnSac: "998599", gstRateBps: 1800, pricePaise: 10000 })).item;
      const saved = await store.passGstInvoice(company.id, { type: "Purchase", registrationId: registration.id, partyId: party.id, date: "2026-04-10", supplierInvoiceNumber: "SUP-1", placeOfSupply: "23", reverseCharge: true, rcm: { applicabilityConfirmed: true, basisReference: "Synthetic notified RCM basis under section9(3)", receiptDate: "2026-04-01", supplierInvoiceDate: "2026-04-01", selfInvoiceDate: "2026-04-10" }, items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000 }] });
      let sequence = 0;
      const action = (type, fields) => store.gstRcmAction(company.id, type, { invoiceId: saved.invoice.id, date: "2026-04-10", requestId: `rcm-audit-action-${String(++sequence).padStart(8, "0")}`, reference: `Public reference ${sequence}`, ...fields });
      await action("cash-deposit", { bankLedgerId: "l-cash", components: tax(900, 900) });
      await action("tax-payment", { components: tax(900, 900), evidenceType: "cash-ledger-debit" });
      await action("itc-claim", { date: "2026-04-11", components: tax(900, 900), review: claimReview });
      await action("itc-reversal", { date: "2026-04-20", components: tax(300, 300), ...(reversalReason ? { reversalReason } : {}) });
      const books = await store.get(company.id);
      const report = returnWorkbook(books.company, books.vouchers, registration.id, "2026-04");
      assert.equal(report.summary.rcmDomesticCredit.cgstPaise, 900);
      assert.equal(report.itc.reviewedNet.cgstPaise, 600, `reason ${reversalReason || "unclassified"}`);
      if (!reversalReason) {
        assert.equal(report.itc.provisional, true);
        assert.ok(report.issues.some(issue => /classify/i.test(issue.reason)));
      } else {
        assert.equal(report.summary.rcmPermanentReversals.cgstPaise, 300);
        assert.equal(report.itc.table4["4D(2)"].cgstPaise, 300);
        assert.equal(report.itc.provisional, false);
      }
    } finally { await rm(dataDir, { recursive: true, force: true }); }
  }
});

// Pass 2: edge cases around the new fields --------------------------------------
test("clearing a party identifier or an item rate override removes the stored flag", async () => {
  await book(async ({ store, company }) => {
    const tds = (await store.saveGstMaster(company.id, "party", { name: "Changing Department", gstin: TDS, stateCode: "07", address: "Delhi" })).party;
    const cleared = (await store.saveGstMaster(company.id, "party", { id: tds.id, name: "Changing Department", gstin: "", stateCode: "07", address: "Delhi", kind: "customer" })).party;
    assert.equal(cleared.identifierType, undefined);
    const special = (await store.saveGstMaster(company.id, "item", { name: "Special", kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1700, rateOverride: true })).item;
    await assert.rejects(store.saveGstMaster(company.id, "item", { id: special.id, name: "Special", kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1700 }), /notified GST rate/);
    const normal = (await store.saveGstMaster(company.id, "item", { id: special.id, name: "Special", kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1800 })).item;
    assert.equal(normal.rateOverride, undefined);
    const books = await store.get(company.id);
    assert.doesNotThrow(() => assertGstMasters(books.company));
    assert.equal(books.company.gst.parties.find(row => row.id === tds.id).identifierType, undefined);
    assert.equal(books.company.gst.items.find(row => row.id === special.id).rateOverride, undefined);
    await assert.rejects(store.saveGstMaster(company.id, "item", { name: "Bad flag", kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1800, rateOverride: "yes" }), /special GST rate override/);
  });
});

test("the same supplier document booked on both sides of 1 April is a duplicate", async () => {
  await book(async ({ store, company, input }) => {
    const purchase = { ...input, type: "Purchase", supplierInvoiceNumber: "SUP/9", itcEligibility: "eligible" };
    await store.passGstInvoice(company.id, { ...purchase, date: "2025-03-29" });
    await assert.rejects(store.passGstInvoice(company.id, { ...purchase, date: "2025-04-03", supplierInvoiceDate: "2025-03-29" }), /already recorded/);
    // A new supplier year with the same number is a different document.
    assert.equal((await store.passGstInvoice(company.id, { ...purchase, date: "2025-04-04", supplierInvoiceDate: "2025-04-02" })).invoice.supplierInvoiceDate, "2025-04-02");
  }, { partyState: "27" });
});

test("rounded invoices report the rounded value in outward corrections and HSN totals still reconcile", async () => {
  const { outwardDocumentSnapshot, normalizeReportedSnapshot } = await import("../lib/gst-outward-amendments.js");
  await book(async ({ store, company, input }) => {
    await store.addLedger(company.id, { name: "Round off", groupId: "g-indirect-inc", openingPaise: 0, openingDc: "Cr" });
    const { invoice } = await store.passGstInvoice(company.id, { ...input, date: "2025-06-01", items: [{ ...input.items[0], unitPricePaise: 10034 }], roundOffPaise: -40 });
    const snapshot = outwardDocumentSnapshot(invoice, []);
    assert.equal(snapshot.invoiceValuePaise, 11800);
    assert.equal(snapshot.roundOffPaise, -40);
    assert.equal(snapshot.hsnRows.reduce((sum, row) => sum + row.totalPaise, 0), 11840);
    assert.throws(() => normalizeReportedSnapshot({ ...snapshot, roundOffPaise: 60 }), /round-off/);
    assert.throws(() => normalizeReportedSnapshot({ ...snapshot, roundOffPaise: undefined }), /reconcile to the full reported invoice value/);
    // Unrounded documents keep the earlier snapshot shape.
    const plain = (await store.passGstInvoice(company.id, { ...input, date: "2025-06-02" })).invoice;
    assert.equal(Object.hasOwn(outwardDocumentSnapshot(plain, []), "roundOffPaise"), false);
  }, { partyState: "27" });
});

test("the HTTP invoice route accepts the supplier invoice date and round-off and the evidence route follows the supplier period", async () => {
  const { start } = await import("../server.js");
  const dataDir = await mkdtemp(path.join(tmpdir(), "ledgercraft-gst-audit-http-"));
  const server = await start({ dataDir });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, method = "GET", body) => {
    const response = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    return { ok: response.ok, result };
  };
  try {
    const { result: { company } } = await call("/api/companies", "POST", { name: "GST audit HTTP", booksFrom: "2025-04-01" });
    const route = `/api/companies/${company.id}/gst`;
    const { result: { registration } } = await call(`${route}/settings`, "PUT", { name: "HTTP Trader", gstin: gstin("23"), stateCode: "23", address: "Synthetic address" });
    const { result: { party } } = await call(`${route}/parties`, "POST", { name: "HTTP Supplier", gstin: gstin("27", "PQRST5678L"), stateCode: "27", address: "Supplier address", kind: "supplier" });
    const { result: { item } } = await call(`${route}/items`, "POST", { name: "HTTP Goods", kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1800, pricePaise: 10000 });
    await call(`/api/companies/${company.id}/ledgers`, "POST", { name: "Round Off", groupId: "g-indirect-exp", openingPaise: 0, openingDc: "Dr" });
    const payload = { type: "Purchase", registrationId: registration.id, partyId: party.id, date: "2025-04-05", placeOfSupply: "23", supplierInvoiceNumber: "HTTP/1", supplierInvoiceDate: "2025-04-01", itcEligibility: "eligible", roundOffPaise: 0, items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000 }] };
    const saved = await call(`${route}/invoices`, "POST", payload);
    assert.ok(saved.ok, saved.result.error);
    assert.equal(saved.result.invoice.supplierInvoiceDate, "2025-04-01");
    const plain = await call(`${route}/invoices`, "POST", { ...payload, supplierInvoiceNumber: "HTTP/2", supplierInvoiceDate: undefined, roundOffPaise: undefined });
    assert.ok(plain.ok, plain.result.error);
    const bad = await call(`${route}/invoices`, "POST", { ...payload, supplierInvoiceNumber: "HTTP/3", supplierInvoiceDate: "2025-04-06" });
    assert.equal(bad.ok, false);
    assert.match(bad.result.error, /supplier invoice date/i);
    const evidence = await call(`/api/companies/${company.id}/gst-returns/statement-evidence?invoice=${saved.result.invoice.id}`);
    assert.ok(evidence.ok, evidence.result.error);
    assert.equal(evidence.result.supplierInvoiceDate, "2025-04-01");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("section 16(4): a claim after 30 November following the supplier invoice FY cannot enter 4A(5)", async () => {
  await book(async ({ store, company, input, registration }) => {
    const { invoice } = await store.passGstInvoice(company.id, { ...input, type: "Purchase", date: "2025-04-05", supplierInvoiceNumber: "SUP/31", supplierInvoiceDate: "2025-03-28", itcEligibility: "eligible" });
    const evidence = { basis: "Synthetic section 16 and 17 review", documentReference: "PUBLIC-DOC-1", invoiceHeld: true, received: true, businessUse: true, notBlocked: true, supplierReported: true, supplierTaxPaid: true, returnFurnished: true, paymentReview: true, noTaxDepreciation: true, annualReturnStatus: "not-filed" };
    const claim = (date, requestId) => store.gstItcAction(company.id, "claim", { invoiceId: invoice.id, date, reference: "PUBLIC-REVIEW", requestId, evidence });
    // Before the fix the book date gave a 30-11-2026 limit and this claim reached 4A(5).
    await assert.rejects(claim("2025-12-05", "audit-itc-claim-late-0001"), /section 16\(4\)/);
    const books = await store.get(company.id);
    assert.equal(returnWorkbook(books.company, books.vouchers, registration.id, "2025-12").itc.table4["4A(5)"].cgstPaise, 0);
    const onTime = await claim("2025-11-30", "audit-itc-claim-ok-00001");
    assert.deepEqual(onTime.record.returnRows.map(row => row.table), ["4A(5)"]);
    // A prior claim between the supplier date and the book date is accepted as following the supplier document.
    const prior = await store.passGstInvoice(company.id, { ...input, type: "Purchase", date: "2025-04-05", supplierInvoiceNumber: "SUP/32", supplierInvoiceDate: "2025-03-28", itcEligibility: "eligible" });
    const priorEvidence = { ...evidence, priorClaimDate: "2025-04-01", priorReturnReference: "GSTR-3B 03-2025", priorClaimVerified: true };
    const result = await store.gstItcAction(company.id, "prior-claim", { invoiceId: prior.invoice.id, date: "2025-05-01", reference: "PUBLIC-PRIOR", requestId: "audit-itc-prior-claim-01", evidence: priorEvidence });
    assert.equal(result.record.action, "prior-claim");
  }, { partyState: "27" });
});
