import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildGstInvoice, gstInventory, gstinCheckDigit, normalizeGstin } from "../lib/gst.js";
import { balanceSheet, profitAndLoss, trialBalance } from "../lib/engine.js";
import { createStore } from "../lib/store.js";
import { companyBackup, importCompany, validateTransfer } from "../lib/transfer.js";
import { start } from "../server.js";

const gstin = (state, pan = "ABCDE1234F") => {
  const prefix = `${state}${pan}1Z`;
  return prefix + gstinCheckDigit(prefix);
};
async function book(run, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "financer-gst-"));
  const store = createStore(dataDir);
  try {
    const { company } = await store.create({ name: "Synthetic GST Books", booksFrom: "2025-04-01" });
    const registration = (await store.saveGstMaster(company.id, "registration", { name: "Synthetic Trader", legalName: "Synthetic Trader", gstin: gstin(options.state || "23"), stateCode: options.state || "23", address: "Test address", pincode: "462001" })).registration;
    const party = (await store.saveGstMaster(company.id, "party", { name: "Synthetic Party", gstin: gstin(options.partyState || "23", "PQRST5678L"), stateCode: options.partyState || "23", address: "Party test address", kind: "both" })).party;
    const item = (await store.saveGstMaster(company.id, "item", { name: "Synthetic Goods", kind: "goods", hsnSac: "8541", unit: "NOS", pricePaise: 10000, gstRateBps: 1800, cessRateBps: 0, supplyStatus: "taxable", openingQuantity: "10" })).item;
    const input = { type: "Sales", registrationId: registration.id, partyId: party.id, date: "2026-07-01", placeOfSupply: options.state || "23", pricing: "exclusive", items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000 }] };
    await run({ store, dataDir, company, registration, party, item, input });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
}

test("GSTIN checks format, state and checksum using a public example", () => {
  assert.equal(normalizeGstin("27AAPFU0939F1ZV"), "27AAPFU0939F1ZV");
  assert.throws(() => normalizeGstin("27AAPFU0939F1Z0"), /checksum/);
  assert.throws(() => normalizeGstin(gstin("99")), /state code/);
  assert.equal(normalizeGstin("", false), "");
});

test("sales invoice posts exact output CGST/SGST, receivable and stock once", async () => {
  await book(async ({ store, company, registration, party, input, item }) => {
    const payload = { ...input, requestId: "gst-sales-repeat-123456" };
    const [saved, replay] = await Promise.all([store.passGstInvoice(company.id, payload), store.passGstInvoice(company.id, payload)]);
    assert.equal(saved.invoice.id, replay.invoice.id);
    assert.equal(replay.replayed, true);
    assert.deepEqual(saved.invoice.totals, { grossPaise: 10000, discountPaise: 0, taxablePaise: 10000, cgstPaise: 900, sgstPaise: 900, utgstPaise: 0, igstPaise: 0, cessPaise: 0, taxPaise: 1800, totalPaise: 11800 });
    assert.deepEqual(saved.voucher.lines, [
      { ledgerId: party.customerLedgerId, dc: "Dr", paise: 11800 },
      { ledgerId: registration.accounts.sales, dc: "Cr", paise: 10000 },
      { ledgerId: registration.accounts["output-cgst"], dc: "Cr", paise: 900 },
      { ledgerId: registration.accounts["output-sgst"], dc: "Cr", paise: 900 },
    ]);
    const state = await store.gstState(company.id);
    assert.equal(state.invoices.length, 1);
    assert.equal(state.inventory.find(row => row.itemId === item.id).quantity, "9");
    const books = await store.get(company.id);
    assert.equal(trialBalance(books.company, books.vouchers, company.booksFrom, "2026-07-31").difference, 0);
    assert.equal(profitAndLoss(books.company, books.vouchers, company.booksFrom, "2026-07-31").netProfit, 10000);
    assert.equal(balanceSheet(books.company, books.vouchers, "2026-07-31").difference, 0);
    await assert.rejects(store.passVoucher(company.id, saved.voucher, saved.voucher.id), /linked to tax and stock/);
    await assert.rejects(store.removeVoucher(company.id, saved.voucher.id), /tax and stock linkage/);
    await assert.rejects(store.updateLedger(company.id, registration.accounts["output-cgst"], { name: "Moved CGST", groupId: "g-current-assets", openingPaise: 0, openingDc: "Dr" }), /keep their account groups/);
  });
});

test("interstate purchase uses supplier location and posts input IGST", async () => {
  await book(async ({ store, company, registration, party, input, item }) => {
    const { invoice, voucher } = await store.passGstInvoice(company.id, { ...input, type: "Purchase", supplierInvoiceNumber: "VENDOR-1", itcEligibility: "eligible", items: [{ itemId: item.id, quantity: "2.5", unitPricePaise: 10000 }] });
    assert.equal(invoice.interState, true);
    assert.equal(invoice.totals.igstPaise, 4500);
    assert.equal(invoice.totals.totalPaise, 29500);
    assert.deepEqual(voucher.lines, [
      { ledgerId: party.supplierLedgerId, dc: "Cr", paise: 29500 },
      { ledgerId: registration.accounts.purchase, dc: "Dr", paise: 25000 },
      { ledgerId: registration.accounts["input-igst"], dc: "Dr", paise: 4500 },
    ]);
    assert.equal((await store.gstState(company.id)).inventory[0].quantity, "12.5");
  }, { partyState: "27" });
});

test("inclusive mixed-rate discounted lines and cess retain exact paise", async () => {
  await book(async ({ store, company, input, item }) => {
    const exempt = (await store.saveGstMaster(company.id, "item", { name: "Exempt Service", kind: "service", hsnSac: "998599", pricePaise: 5000, gstRateBps: 0, supplyStatus: "exempt" })).item;
    const { invoice } = await store.previewGstInvoice(company.id, { ...input, pricing: "inclusive", items: [
      { itemId: item.id, quantity: "1", unitPricePaise: 12000, gstRateBps: 1800, cessRateBps: 200 },
      { itemId: item.id, quantity: "0.5", unitPricePaise: 10000, discountBps: 1000, gstRateBps: 500 },
      { itemId: exempt.id, quantity: "1", unitPricePaise: 5000 },
    ] });
    assert.equal(invoice.items[0].taxablePaise, 10000);
    assert.equal(invoice.items[0].cgstPaise, 900);
    assert.equal(invoice.items[0].sgstPaise, 900);
    assert.equal(invoice.items[0].cessPaise, 200);
    assert.equal(invoice.items[1].discountPaise, 500);
    assert.equal(invoice.items[2].taxPaise, 0);
    assert.equal(invoice.totals.totalPaise, 21500);
    assert.equal(invoice.totals.taxablePaise + invoice.totals.taxPaise, invoice.totals.totalPaise);
    assert.equal((await store.get(company.id)).vouchers.length, 0);
  });
});

test("intra-UT uses UTGST while ineligible purchase tax becomes cost", async () => {
  await book(async ({ store, company, registration, input }) => {
    const { invoice, voucher } = await store.passGstInvoice(company.id, { ...input, type: "Purchase", supplierInvoiceNumber: "UT-1", itcEligibility: "ineligible" });
    assert.equal(invoice.totals.cgstPaise, 900);
    assert.equal(invoice.totals.utgstPaise, 900);
    assert.equal(invoice.totals.sgstPaise, 0);
    assert.ok(voucher.lines.some(line => line.ledgerId === registration.accounts.nonCreditTax && line.paise === 1800 && line.dc === "Dr"));
    assert.equal(voucher.lines.some(line => line.ledgerId === registration.accounts["input-cgst"]), false);
  }, { state: "04", partyState: "04" });
});

test("credit notes reverse tax and physical quantity while financial notes leave stock", async () => {
  await book(async ({ store, company, input, item }) => {
    const sale = (await store.passGstInvoice(company.id, { ...input, items: [{ itemId: item.id, quantity: "3", unitPricePaise: 10000 }] })).invoice;
    const note = { ...input, type: "Credit Note", direction: "sales", originalInvoiceId: sale.id, items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000 }] };
    const financial = await store.passGstInvoice(company.id, note);
    assert.equal(financial.invoice.stockEffect, "none");
    assert.equal((await store.gstState(company.id)).inventory[0].quantity, "7");
    const physical = await store.passGstInvoice(company.id, { ...note, stockEffect: "quantity" });
    assert.equal(physical.voucher.lines[0].dc, "Cr");
    assert.equal(physical.voucher.lines.slice(1).every(line => line.dc === "Dr"), true);
    assert.equal((await store.gstState(company.id)).inventory[0].quantity, "8");
    assert.equal(physical.invoice.originalNumber, sale.number);
  });
});

test("FY numbering, mixed status validation and incomplete RCM are explicit", async () => {
  await book(async ({ store, company, input }) => {
    const first = (await store.passGstInvoice(company.id, { ...input, date: "2026-03-31" })).invoice;
    const nextYear = (await store.passGstInvoice(company.id, { ...input, date: "2026-04-01" })).invoice;
    assert.match(first.number, /2526\/00001$/);
    assert.match(nextYear.number, /2627\/00001$/);
    assert.equal(first.number.length <= 16 && nextYear.number.length <= 16, true);
    await assert.rejects(store.passGstInvoice(company.id, { ...input, reverseCharge: true }), /RCM legal basis/);
    await assert.rejects(store.passGstInvoice(company.id, { ...input, items: input.items.map(row => ({ ...row, supplyStatus: "exempt", gstRateBps: 1800 })) }), /zero tax rates/);
    await assert.rejects(store.passGstInvoice(company.id, { ...input, type: "Credit Note", direction: "sales" }), /original invoice number/);
  });
});

test("GST invoices and master snapshots round trip backups and reject tampered tax/postings", async () => {
  await book(async ({ store, company, input, dataDir }) => {
    await store.passGstInvoice(company.id, input);
    const book = await store.get(company.id);
    const backup = companyBackup(book.company, book.vouchers);
    const restored = validateTransfer(backup);
    assert.deepEqual(restored.vouchers[0].gst, book.vouchers[0].gst);
    assert.deepEqual(restored.company.gst, book.company.gst);
    assert.deepEqual(gstInventory(restored.company, restored.vouchers), gstInventory(book.company, book.vouchers));
    const imported = await importCompany(dataDir, backup);
    assert.notEqual(imported.company.id, company.id);
    assert.deepEqual(imported.vouchers[0].gst, book.vouchers[0].gst);
    const tampered = structuredClone(backup);
    tampered.vouchers[0].gst.items[0].cgstPaise += 1;
    assert.throws(() => validateTransfer(tampered), /saved tax calculation/);
    const journal = structuredClone(backup);
    journal.vouchers[0].lines[0].paise += 1;
    journal.vouchers[0].lines[1].paise += 1;
    assert.throws(() => validateTransfer(journal), /double-entry postings/);
  });
});

test("zero-rated export and SEZ supplies choose IGST or LUT without domestic tax", async () => {
  await book(async ({ store, company, registration, item, input }) => {
    const foreign = (await store.saveGstMaster(company.id, "party", { name: "Synthetic Overseas Customer", gstin: "", stateCode: "96", address: "Overseas test address", kind: "customer" })).party;
    const exportInput = { ...input, partyId: foreign.id, placeOfSupply: "96", supplyCategory: "export", items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000, supplyStatus: "zero-rated", gstRateBps: 1800 }] };
    const lut = await store.passGstInvoice(company.id, { ...exportInput, exportMode: "lut" });
    assert.equal(lut.invoice.totals.totalPaise, 10000);
    assert.equal(lut.invoice.totals.taxPaise, 0);
    assert.equal(lut.voucher.lines.length, 2);
    const paid = await store.passGstInvoice(company.id, { ...exportInput, exportMode: "with-payment" });
    assert.equal(paid.invoice.totals.igstPaise, 1800);
    assert.equal(paid.invoice.totals.cgstPaise, 0);
    assert.ok(paid.voucher.lines.some(line => line.ledgerId === registration.accounts["output-igst"] && line.paise === 1800));
    const sez = await store.passGstInvoice(company.id, { ...input, supplyCategory: "sez", exportMode: "with-payment", items: exportInput.items });
    assert.equal(sez.invoice.interState, true);
    assert.equal(sez.invoice.totals.igstPaise, 1800);
    assert.equal(sez.invoice.totals.sgstPaise, 0);
    await assert.rejects(store.passGstInvoice(company.id, { ...input, supplyCategory: "export", exportMode: "lut", items: exportInput.items }), /foreign recipient/);
  });
});

test("purchase debit/credit notes adjust input taxes and notes cannot over-credit the invoice", async () => {
  await book(async ({ store, company, input, registration }) => {
    const purchase = (await store.passGstInvoice(company.id, { ...input, type: "Purchase", supplierInvoiceNumber: "SUP-1", itcEligibility: "eligible" })).invoice;
    const note = { ...input, direction: "purchase", originalInvoiceId: purchase.id, supplierInvoiceNumber: "SUP-CN-1", itcEligibility: "eligible" };
    const credit = await store.passGstInvoice(company.id, { ...note, type: "Credit Note", stockEffect: "quantity" });
    assert.equal(credit.invoice.originalNumber, "SUP-1");
    assert.equal(credit.voucher.lines.find(line => line.ledgerId === registration.accounts["input-cgst"]).dc, "Cr");
    assert.equal((await store.gstState(company.id)).inventory[0].quantity, "10");
    await assert.rejects(store.passGstInvoice(company.id, { ...note, type: "Credit Note", supplierInvoiceNumber: "SUP-CN-2" }), /credit exceeds/);
    const debit = await store.passGstInvoice(company.id, { ...note, type: "Debit Note", supplierInvoiceNumber: "SUP-DN-1" });
    assert.equal(debit.voucher.lines.find(line => line.ledgerId === registration.accounts["input-cgst"]).dc, "Dr");
    const creditAgain = await store.passGstInvoice(company.id, { ...note, type: "Credit Note", supplierInvoiceNumber: "SUP-CN-2" });
    assert.equal(creditAgain.invoice.totals.totalPaise, purchase.totals.totalPaise);
    const backup = await store.get(company.id);
    assert.equal(validateTransfer(companyBackup(backup.company, backup.vouchers)).vouchers.length, 4);
  });
});

test("GST master history, invoice-number case and backup source metadata stay consistent", async () => {
  await book(async ({ store, company, party, input }) => {
    const saved = await store.passGstInvoice(company.id, { ...input, number: "inv-abc" });
    assert.equal(saved.invoice.number, "INV-ABC");
    await assert.rejects(store.passGstInvoice(company.id, { ...input, number: "INV-ABC" }), /already used/);
    await assert.rejects(store.saveGstMaster(company.id, "party", { ...party, gstin: gstin("27", "PQRST5678L"), stateCode: "27" }), /keeps its GSTIN and state/);
    const source = { system: "tally", recordId: "synthetic-record", guid: "synthetic-guid", masterId: "1", originalType: "Journal", originalNumber: "OLD-1", archive: "tally-source" };
    const raw = await store.get(company.id);
    const voucher = { ...raw.vouchers[0], gst: undefined, stock: undefined, number: "JRN-1", type: "Journal", source, requestId: "synthetic-request-123456" };
    const backup = companyBackup({ ...raw.company, source }, [voucher]);
    const restored = validateTransfer(backup);
    assert.deepEqual(restored.vouchers[0].source, source);
    assert.equal(restored.vouchers[0].requestId, voucher.requestId);
    assert.deepEqual(restored.company.source, source);
  });
});

test("HTTP registration, masters, preview, invoice, report and backup form one route", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "financer-gst-http-"));
  const server = await start({ dataDir });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, method = "GET", body) => {
    const response = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.ok(response.ok, `${method} ${url}: ${result.error || response.status}`);
    return result;
  };
  try {
    const { company } = await call("/api/companies", "POST", { name: "GST HTTP Test", booksFrom: "2026-04-01" });
    const route = `/api/companies/${company.id}/gst`;
    assert.equal((await call(route)).registrations.length, 0);
    const { registration } = await call(`${route}/settings`, "PUT", { name: "HTTP Trader", gstin: gstin("23"), stateCode: "23", address: "Synthetic address" });
    const { party } = await call(`${route}/parties`, "POST", { name: "HTTP Customer", gstin: "", stateCode: "23", address: "Synthetic party address", kind: "customer" });
    const { item } = await call(`${route}/items`, "POST", { name: "HTTP Goods", kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1800, pricePaise: 10000, openingQuantity: "5" });
    const payload = { type: "Sales", registrationId: registration.id, partyId: party.id, date: "2026-07-01", placeOfSupply: "23", pricing: "exclusive", items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000 }] };
    assert.equal((await call(`${route}/preview`, "POST", payload)).invoice.totals.totalPaise, 11800);
    const { invoice } = await call(`${route}/invoices`, "POST", payload);
    assert.deepEqual((await call(`${route}/invoices/${invoice.id}`)).invoice, invoice);
    assert.equal((await call(route)).inventory[0].quantity, "4");
    const trial = await call(`/api/companies/${company.id}/reports/trial-balance?from=2026-04-01&to=2026-07-31`);
    assert.equal(trial.difference, 0);
    const backup = await call(`/api/companies/${company.id}/backup`);
    assert.deepEqual(validateTransfer(backup).vouchers[0].gst, invoice);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("purchase supplier dates determine 2B matching, section 16 cutoff, reference identity and restore", async () => {
  const { reconcile2B } = await import("../lib/gst-reconcile.js");
  const { itcClaimDeadline } = await import("../lib/gst-itc.js");
  await book(async ({ store, company, registration, party, input }) => {
    const purchase = { ...input, type: "Purchase", number: "101", date: "2026-04-02", supplierInvoiceNumber: "SUP/31", supplierInvoiceDate: "2026-03-31" };
    const saved = await store.passGstInvoice(company.id, purchase);
    const doc = saved.voucher.gst;
    assert.equal(doc.date, "2026-04-02");
    assert.equal(doc.supplierInvoiceDate, "2026-03-31");
    assert.equal(itcClaimDeadline(doc).ordinary, "2026-11-30");
    const statement = { gstin: registration.gstin, rtnprd: "042026", docdata: { b2b: [{ ctin: party.gstin,
      inv: [{ inum: "SUP/31", dt: "31-03-2026", pos: "23", rev: "N", val: 118, txval: 100, cgst: 9, sgst: 9, itcavl: "Y" }] }] } };
    const current = await store.snapshot(company.id);
    const reconcile = reconcile2B(current.company, current.vouchers, registration.id, "2026-04", statement);
    assert.equal(reconcile.results[0].status, "Matched");
    assert.equal(reconcile.results[0].bookId, doc.id);
    const earlier = reconcile2B(current.company, current.vouchers, registration.id, "2026-03", { ...statement, rtnprd:"032026" });
    assert.equal(earlier.results[0].status, "Matched");
    assert.equal(earlier.results[0].bookDate, "2026-04-02");
    assert.equal(reconcile.results[0].candidates[0].date, "2026-03-31");
    assert.deepEqual(validateTransfer(companyBackup(current.company, current.vouchers)).vouchers, current.vouchers);
    await assert.rejects(store.passGstInvoice(company.id, { ...purchase, number: "P-2", date: "2026-03-31" }), /supplier document is already/i);
    await store.passGstInvoice(company.id, { ...input, number: "101", date: "2026-04-02" });
    await store.passGstInvoice(company.id, { ...purchase, number: "P-2", supplierInvoiceDate: "2026-04-01" });
    const note = await store.passGstInvoice(company.id, { ...purchase, type: "Credit Note", direction: "purchase", number: "CN-1", supplierInvoiceNumber: "CN/1", date: "2026-04-08", supplierInvoiceDate: "2026-04-05", originalInvoiceId: doc.id, stockEffect:"none" });
    assert.equal(note.voucher.gst.originalNumber, "SUP/31");
    assert.equal(note.voucher.gst.originalDate, "2026-03-31");
    const final = await store.snapshot(company.id);
    assert.deepEqual(validateTransfer(companyBackup(final.company,final.vouchers)).vouchers, final.vouchers);
    const forgedParty = structuredClone(final);
    forgedParty.vouchers[0].gst.party.gstin = gstin("23","LMNOP1234Q");
    assert.throws(()=>validateTransfer(forgedParty),/registration differs/);
    const forgedRole = structuredClone(final);
    forgedRole.vouchers[0].gst.party.kind = "customer";
    assert.throws(()=>validateTransfer(forgedRole),/posting role/);
    const corrupt = structuredClone(final);
    corrupt.vouchers.find(v=>v.number==="P-2").gst.supplierInvoiceDate="2026-03-31";
    assert.throws(()=>validateTransfer(corrupt),/supplier document is already/i);
    await assert.rejects(store.passGstInvoice(company.id, { ...purchase, number: "P-3", supplierInvoiceDate: "2026-04-03" }), /supplier document date/i);
  });
});

test("earlier party-scoped purchase records restore with a duplicate-source review and keep new credits unclaimed", async () => {
  const { itcState, buildItcAction } = await import("../lib/gst-itc.js");
  await book(async ({store, company, party, input}) => {
    const other=(await store.saveGstMaster(company.id,"party",{name:"Alternate ledger",gstin:gstin("23","LMNOP1234Q"),kind:"supplier",stateCode:"23",address:"Synthetic address"})).party;
    const base={...input,type:"Purchase",supplierInvoiceNumber:"LEGACY/7"};
    const first=(await store.passGstInvoice(company.id,{...base,number:"OLD-1"})).invoice;
    await store.passGstInvoice(company.id,{...base,number:"OLD-2",partyId:other.id});
    const historic=structuredClone(await store.snapshot(company.id));
    historic.company.gst.parties.find(p=>p.id===other.id).gstin=party.gstin;
    for (const v of historic.vouchers) { delete v.gst.purchaseIdentityVersion; v.gst.party.gstin=party.gstin; }
    const restored=validateTransfer(historic);
    const issueIds=itcState(restored.company,restored.vouchers,"2026-07-31").issues.filter(i=>i.code==="duplicate-supplier-document").map(i=>i.invoiceId);
    assert.equal(issueIds.length,2);
    assert.throws(()=>buildItcAction(restored.company,restored.vouchers,"claim",{invoiceId:first.id,date:"2026-07-31",requestId:"legacy-claim-review-0001"}),/multiple historical entries/);
    assert.throws(()=>buildGstInvoice(restored.company,restored.vouchers,{...base,number:"NEW-3"}),/supplier document is already/);
    historic.vouchers[1].gst.purchaseIdentityVersion=2;
    assert.throws(()=>validateTransfer(historic),/supplier document is already/);
  });
});


test("a later-posted original purchase remains selectable when reviewing its earlier-booked supplier credit note", async () => {
  await book(async ({store, company, input}) => {
    const source = await store.passGstInvoice(company.id, {...input,type:"Purchase",number:"INTERNAL BILL APRIL 003",date:"2026-04-03",supplierInvoiceNumber:"M-003",supplierInvoiceDate:"2026-03-28"});
    const note={...input,type:"Credit Note",direction:"purchase",number:"NOTE 100",date:"2026-04-01",stockEffect:"none",originalInvoiceId:source.invoice.id,supplierInvoiceNumber:"C-2",supplierInvoiceDate:"2026-03-31"};
    await assert.rejects(store.passGstInvoice(company.id,{...note,supplierInvoiceDate:"2026-03-27"}),/original invoice date/);
    const saved=await store.passGstInvoice(company.id,note);
    const review=await store.gstItcAction(company.id,"credit-note",{invoiceId:saved.invoice.id,date:"2026-04-10",requestId:"cross-period-credit-0001",reference:"Synthetic return of goods",evidence:{basis:"Credit note applied to the original supplier bill",documentReference:"C-2"}});
    assert.equal(review.record.components.cgstPaise,900);
    assert.equal(review.record.components.sgstPaise,900);
    assert.deepEqual(review.record.returnRows,[]);
    const restored=await store.snapshot(company.id);
    assert.deepEqual(validateTransfer(restored).vouchers,restored.vouchers);
  });
});
