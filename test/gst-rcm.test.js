import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { gstinCheckDigit } from "../lib/gst.js";
import { createStore } from "../lib/store.js";
import { assertRcmBook, rcmLiabilityRows, rcmReturnRows, rcmState } from "../lib/gst-rcm.js";
import { companyBackup, importCompany, validateTransfer } from "../lib/transfer.js";
import { trialBalance } from "../lib/engine.js";
import { start } from "../server.js";

const gstin = (state, pan = "ABCDE1234F") => { const stem = `${state}${pan}1Z`; return stem + gstinCheckDigit(stem); };
const tax = (cgstPaise = 900, sgstPaise = 900) => ({ cgstPaise, sgstPaise, utgstPaise: 0, igstPaise: 0, cessPaise: 0 });
const claimReview = { received: true, businessUse: true, notBlocked: true, documentsHeld: true, basis: "Synthetic section16/17 eligibility review" };
async function withBooks(run, { registered = false, kind = "service", partyState = "23" } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "financer-rcm-"));
  const store = createStore(dataDir);
  try {
    const { company } = await store.create({ name: "Synthetic RCM Books", booksFrom: "2025-04-01" });
    const registration = (await store.saveGstMaster(company.id, "registration", { name: "Synthetic Recipient", legalName: "Synthetic Recipient", gstin: gstin("23"), stateCode: "23", address: "Public test address", pincode: "462001" })).registration;
    const party = (await store.saveGstMaster(company.id, "party", { name: "Synthetic Supplier", kind: "both", gstin: registered ? gstin(partyState, "PQRST5678L") : "", stateCode: partyState, address: "Public supplier address" })).party;
    const item = (await store.saveGstMaster(company.id, "item", { name: "Synthetic RCM supply", kind, hsnSac: kind === "service" ? "998599" : "8541", unit: "NOS", gstRateBps: 1800, cessRateBps: 0, pricePaise: 10000, purchasePricePaise: 10000, supplyStatus: "taxable", openingQuantity: "0" })).item;
    const input = { type: "Purchase", registrationId: registration.id, partyId: party.id, date: "2026-04-10", supplierInvoiceNumber: "SUP-1", placeOfSupply: "23", pricing: "exclusive", reverseCharge: true, rcm: { applicabilityConfirmed: true, basisReference: "Synthetic notified RCM basis under section9(3)", receiptDate: "2026-04-01", supplierInvoiceDate: "2026-04-01", selfInvoiceDate: "2026-04-10" }, items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000 }], requestId: "rcm-invoice-public-0001" };
    const saved = await store.passGstInvoice(company.id, input);
    let sequence = 0;
    const action = (type, fields = {}) => store.gstRcmAction(company.id, type, { invoiceId: saved.invoice.id, date: "2026-04-10", requestId: `rcm-public-action-${String(++sequence).padStart(8, "0")}`, reference: `Public reference ${sequence}`, ...fields });
    await run({ store, dataDir, company, registration, party, item, input, saved, action });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
}

test("inward RCM separates supplier amount, liability and pending input tax", async () => {
  await withBooks(async ({ store, company, saved, registration, party }) => {
    assert.equal(saved.invoice.partyDuePaise, 10000);
    assert.equal(saved.invoice.totals.totalPaise, 11800);
    assert.equal(saved.invoice.documentLabel, "Self-invoice");
    assert.equal(saved.voucher.lines.find((line) => line.ledgerId === party.supplierLedgerId).paise, 10000);
    assert.ok(!saved.voucher.lines.some((line) => line.ledgerId === registration.accounts["input-cgst"]));
    const book = await store.get(company.id);
    const accounts = book.company.gst.rcm.accountsByRegistration[registration.id];
    assert.ok(saved.voucher.lines.some((line) => line.ledgerId === accounts["pending-cgst"] && line.dc === "Dr" && line.paise === 900));
    assert.ok(saved.voucher.lines.some((line) => line.ledgerId === accounts["liability-cgst"] && line.dc === "Cr" && line.paise === 900));
    assert.equal(trialBalance(book.company, book.vouchers, company.booksFrom, "2026-04-30").difference, 0);
  });
});

test("cash deposit unlocks no ITC; actual discharge and eligibility review do", async () => {
  await withBooks(async ({ store, company, saved, action }) => {
    await assert.rejects(action("itc-claim", { components: tax(), review: claimReview }), /exceeds/);
    await action("cash-deposit", { bankLedgerId: "l-cash", components: tax() });
    await assert.rejects(action("itc-claim", { components: tax(), review: claimReview }), /exceeds/);
    await assert.rejects(action("tax-payment", { components: tax(), evidenceType: "deposit-only" }), /actual tax discharge/);
    const discharged = await action("tax-payment", { components: tax(), evidenceType: "cash-ledger-debit" });
    assert.equal(discharged.voucher.type, "Journal");
    await assert.rejects(action("itc-claim", { components: tax(), review: { ...claimReview, notBlocked: false } }), /eligibility review/);
    const claimed = await action("itc-claim", { date: "2026-04-11", components: tax(), review: claimReview });
    assert.equal(claimed.record.action, "itc-claim");
    const book = await store.get(company.id);
    assertRcmBook(book.company, book.vouchers);
    const rows = rcmReturnRows(book.company, book.vouchers, "2026-04-01", "2026-04-30");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cgstPaise, 900);
    assert.equal(rows[0].date, "2026-04-11");
    assert.equal(rcmState(book.company, book.vouchers, "2026-04-30").documents[0].availableCredit.cgstPaise, 0);
  });
});

test("service timing uses self-invoice after2024 and earlier proportional supplier payments", async () => {
  await withBooks(async ({ store, company, action }) => {
    await action("supplier-payment", { date: "2026-04-03", bankDebitDate: "2026-04-02", amountPaise: 5000, bankLedgerId: "l-cash", allocationMethod: "pro-rata" });
    const book = await store.get(company.id);
    const rows = rcmLiabilityRows(book.company, book.vouchers, "2026-04-01", "2026-04-30");
    assert.equal(rows.find((row) => row.date === "2026-04-02").cgstPaise, 450);
    assert.equal(rows.find((row) => row.date === "2026-04-10").cgstPaise, 450);
    assert.equal(rows.reduce((sum, row) => sum + row.taxablePaise, 0), 10000);
  });
});

test("registered services use day61 and goods use receipt/day31", async () => {
  await withBooks(async ({ store, company, saved }) => {
    assert.equal(saved.invoice.rcm.liabilityDate, "2026-06-01");
    const book = await store.get(company.id);
    assert.equal(rcmLiabilityRows(book.company, book.vouchers, "2026-04-01", "2026-04-30").length, 0);
    assert.equal(rcmLiabilityRows(book.company, book.vouchers, "2026-06-01", "2026-06-30")[0].cgstPaise, 900);
  }, { registered: true });
  await withBooks(async ({ saved }) => { assert.equal(saved.invoice.rcm.liabilityDate, "2026-04-01"); }, { kind: "goods" });
});

test("notes expose overclaimed and overpaid amounts until dated reversal/refund records", async () => {
  await withBooks(async ({ store, company, input, saved, action }) => {
    await action("supplier-payment", { amountPaise: 10000, bankLedgerId: "l-cash", allocationMethod: "pro-rata" });
    await action("cash-deposit", { bankLedgerId: "l-cash", components: tax() });
    await action("tax-payment", { components: tax(), evidenceType: "cash-ledger-debit" });
    await action("itc-claim", { date: "2026-04-11", components: tax(), review: claimReview });
    await store.passGstInvoice(company.id, { ...input, requestId: "rcm-credit-public-0001", type: "Credit Note", direction: "purchase", date: "2026-04-20", supplierInvoiceNumber: "CN-1", originalInvoiceId: saved.invoice.id, stockEffect: "none", items: [{ ...input.items[0], unitPricePaise: 5000 }] });
    let book = await store.get(company.id);
    let position = rcmState(book.company, book.vouchers, "2026-04-30").documents[0];
    assert.equal(position.reversalRequired.cgstPaise, 450);
    assert.equal(position.overpaid.cgstPaise, 450);
    assert.equal(position.supplierOverpaid, 5000);
    await action("itc-reversal", { date: "2026-04-21", components: tax(450, 450) });
    await action("tax-refund", { date: "2026-04-22", components: tax(450, 450), bankLedgerId: "l-cash" });
    await action("supplier-refund", { date: "2026-04-22", amountPaise: 5000, bankLedgerId: "l-cash", allocationMethod: "pro-rata" });
    book = await store.get(company.id);
    position = rcmState(book.company, book.vouchers, "2026-04-30").documents[0];
    assert.equal(position.reversalRequired.cgstPaise, 0);
    assert.equal(position.overpaid.cgstPaise, 0);
    assert.equal(position.supplierOverpaid, 0);
    assert.equal(position.claimed.cgstPaise, 450);
    const restored = validateTransfer(companyBackup(book.company, book.vouchers));
    assert.deepEqual(restored.vouchers, book.vouchers);
  });
});

test("outward RCM receivable excludes recipient tax and no supplier output tax is posted", async () => {
  await withBooks(async ({ store, company, input, registration }) => {
    const party = (await store.saveGstMaster(company.id, "party", { name: "Synthetic RCM customer", kind: "customer", gstin: gstin("23", "LMNOP1234Q"), stateCode: "23", address: "Public recipient address" })).party;
    const { invoice, voucher } = await store.passGstInvoice(company.id, { ...input, requestId: "rcm-outward-public-01", type: "Sales", partyId: party.id });
    assert.equal(invoice.partyDuePaise, 10000);
    assert.equal(voucher.lines.length, 2);
    assert.ok(!voucher.lines.some((line) => Object.entries(registration.accounts).some(([key, id]) => key.startsWith("output-") && id === line.ledgerId)));
  });
});

test("return worksheets recognise RCM across month boundaries, isolate payable from supplier turnover, and count statutory documents", async () => {
  const { returnWorkbook } = await import("../lib/gst-returns.js");
  await withBooks(async ({ store, company, registration, party, input, action }) => {
    await action("supplier-payment", { date: "2026-05-04", bankDebitDate: "2026-05-04", amountPaise: 5000, bankLedgerId: "l-cash", allocationMethod: "pro-rata" });
    await action("cash-deposit", { date: "2026-05-05", bankLedgerId: "l-cash", components: tax(450,450) });
    await action("tax-payment", { date: "2026-05-05", components: tax(450,450), evidenceType: "cash-ledger-debit" });
    await action("itc-claim", { date: "2026-06-02", components: tax(450,450), review: claimReview });
    await store.passGstInvoice(company.id, { ...input, requestId: "public-rcm-return-sale", type: "Sales", partyId: party.id });
    const state = await store.get(company.id);
    const report = m => returnWorkbook(state.company,state.vouchers,registration.id,"2026-"+m);
    const apr = report("04"), may = report("05"), jun = report("06");
    assert.equal(apr.sheets["b2b,sez,de"][0][6], "Y");
    assert.equal(apr.summary.outwardTaxable.cgstPaise, 0);
    assert.equal(apr.summary.outwardRcm.cgstPaise, 900);
    assert.equal(apr.summary.inwardRcm.cgstPaise,0);
    assert.equal(may.summary.inwardRcm.cgstPaise,450);
    assert.equal(may.summary.rcmDomesticCredit.cgstPaise,0);
    assert.ok(may.sheets.docs.some(row=>row[0]==="Payment Voucher" && row[3]===1));
    assert.equal(jun.summary.inwardRcm.cgstPaise,450);
    assert.equal(jun.summary.rcmDomesticCredit.cgstPaise,450);
    assert.equal(jun.rcmRows.length,2);
  },{ registered: true });
  await withBooks(async ({ store, company, registration }) => {
    const state=await store.get(company.id);
    const report=returnWorkbook(state.company,state.vouchers,registration.id,"2026-04");
    assert.ok(report.sheets.docs.some(row=>row[0]==="Invoices for inward supply from unregistered person" && row[3]===1));
  });
});

test("RCM retries, evidence allocations and component overpayments are checked", async () => {
  await withBooks(async ({ store, company, saved, action }) => {
    const input = { invoiceId: saved.invoice.id, date: "2026-04-10", requestId: "rcm-repeat-proof-0001", reference: "PUBLIC-CASH-DEPOSIT", components: tax(), bankLedgerId: "l-cash" };
    const [first, replay] = await Promise.all([store.gstRcmAction(company.id, "cash-deposit", input), store.gstRcmAction(company.id, "cash-deposit", input)]);
    assert.equal(first.record.id, replay.record.id);
    assert.equal(replay.replayed, true);
    await assert.rejects(store.gstRcmAction(company.id, "cash-deposit", { ...input, components: tax(1000, 1000) }), /different request/);
    await assert.rejects(action("cash-deposit", { reference: "PUBLIC-CASH-DEPOSIT", components: tax(), bankLedgerId: "l-cash" }), /already recorded/);
    await assert.rejects(action("tax-payment", { components: tax(1000, 1000), evidenceType: "cash-ledger-debit" }), /exceeds/);
    assert.equal((await store.get(company.id)).vouchers.filter((voucher) => voucher.gstRcm).length, 1);
  });
});

test("pending tax can become cost and return to eligibility after an actual review reversal", async () => {
  await withBooks(async ({ store, company, action }) => {
    await action("expense", { components: tax() });
    await action("cash-deposit", { components: tax(), bankLedgerId: "l-cash" });
    await action("tax-payment", { components: tax(), evidenceType: "cash-ledger-debit" });
    await assert.rejects(action("itc-claim", { components: tax(), review: claimReview }), /exceeds/);
    await action("expense-reversal", { components: tax() });
    await action("itc-claim", { components: tax(), review: claimReview });
    const book = await store.get(company.id);
    assert.equal(rcmState(book.company, book.vouchers, "2026-04-30").documents[0].claimed.cgstPaise, 900);
  });
});

test("unpaid service notes reduce the future baseline without inventing an earlier negative liability", async () => {
  await withBooks(async ({ store, company, input, saved, action }) => {
    await store.passGstInvoice(company.id, { ...input, type: "Credit Note", direction: "purchase", requestId: "rcm-early-credit-0001", date: "2026-04-20", supplierInvoiceNumber: "EARLY-CN", originalInvoiceId: saved.invoice.id, stockEffect: "none", items: [{ ...input.items[0], unitPricePaise: 5000 }] });
    await action("supplier-payment", { date: "2026-05-01", bankDebitDate: "2026-05-01", amountPaise: 5000, bankLedgerId: "l-cash", allocationMethod: "pro-rata" });
    const book = await store.get(company.id);
    assert.deepEqual(rcmLiabilityRows(book.company, book.vouchers, "2026-04-01", "2026-04-30"), []);
    const may = rcmLiabilityRows(book.company, book.vouchers, "2026-05-01", "2026-05-31");
    assert.equal(may.reduce((sum, row) => sum + row.cgstPaise, 0), 450);
    assert.deepEqual(rcmLiabilityRows(book.company, book.vouchers, "2026-06-01", "2026-06-30"), []);
  }, { registered: true });
});

test("future documents stay out of dated outstanding while earlier advance liabilities remain", async () => {
  await withBooks(async ({ store, company, action }) => {
    await action("supplier-payment", { date: "2026-04-03", bankDebitDate: "2026-04-02", amountPaise: 5000, bankLedgerId: "l-cash", allocationMethod: "pro-rata" });
    const book = await store.get(company.id);
    const state = rcmState(book.company, book.vouchers, "2026-04-03");
    assert.equal(state.documents.length, 0);
    assert.equal(state.liabilityRows[0].cgstPaise, 450);
  });
});

test("imported-service claims retain their distinct return-table classification and timing", async () => {
  await withBooks(async ({ store, company, saved, action }) => {
    assert.equal(saved.invoice.totals.igstPaise, 1800);
    await action("cash-deposit", { bankLedgerId: "l-cash", components: { igstPaise: 1800 } });
    await action("tax-payment", { components: { igstPaise: 1800 }, evidenceType: "cash-ledger-debit" });
    await action("itc-claim", { components: { igstPaise: 1800 }, review: claimReview });
    const book = await store.get(company.id);
    assert.equal(rcmReturnRows(book.company, book.vouchers, "2026-04-01", "2026-04-30")[0].importOfServices, true);
    assertRcmBook(book.company, book.vouchers);
  }, { partyState: "96" });
});

test("RCM action API and native backup restore preserve complete payment and review linkage", async () => {
  await withBooks(async ({ store, dataDir, company, saved }) => {
    const server = await start({ port: 0, dataDir });
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = `/api/companies/${company.id}/gst/rcm`;
    const post = async (route, body, expected = 201) => {
      const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = await response.json();
      assert.equal(response.status, expected, JSON.stringify(json));
      return json;
    };
    try {
      const entry = { invoiceId: saved.invoice.id, date: "2026-04-10", reference: "PUBLIC-HTTP-DEPOSIT", requestId: "rcm-http-public-0001", components: tax(), bankLedgerId: "l-cash" };
      await post(`${api}/cash-deposit`, entry);
      await post(`${api}/tax-payment`, { ...entry, reference: "PUBLIC-HTTP-DISCHARGE", requestId: "rcm-http-public-0002", evidenceType: "cash-ledger-debit" });
      await post(`${api}/itc-claim`, { ...entry, reference: "PUBLIC-HTTP-CLAIM", requestId: "rcm-http-public-0003", review: claimReview });
      await post(`${api}/itc-reversal`, { ...entry, components: tax(450, 450), reference: "PUBLIC-HTTP-REVERSAL", requestId: "rcm-http-public-0004", reversalReason: "temporary-reversal" });
      const state = await (await fetch(base + api + "?to=2026-04-30")).json();
      assert.equal(state.documents[0].claimed.cgstPaise, 450);
      const backup = await (await fetch(`${base}/api/companies/${company.id}/backup`)).json();
      const restored = await post("/api/import", backup);
      assert.deepEqual(restored.vouchers, (await store.get(company.id)).vouchers);
      const restoredState = await (await fetch(`${base}/api/companies/${restored.company.id}/gst/rcm?to=2026-04-30`)).json();
      assert.equal(restoredState.documents[0].claimed.cgstPaise, 450);
      const tampered = structuredClone(backup);
      tampered.vouchers.find((voucher) => voucher.gstRcm?.action === "itc-claim").gstRcm.components.cgstPaise++;
      await post("/api/import", tampered, 400);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});

test("mixed goods/service credit notes reduce their own statutory timing bucket", async () => {
  await withBooks(async ({ store, company, registration, party, item, input }) => {
    const goods = (await store.saveGstMaster(company.id, "item", { name: "Synthetic mixed goods", kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1800, cessRateBps: 0, pricePaise: 10000, purchasePricePaise: 10000, supplyStatus: "taxable", openingQuantity: "0" })).item;
    const mixed = (await store.passGstInvoice(company.id, { ...input, requestId: "rcm-mixed-invoice-0001", supplierInvoiceNumber: "MIXED-1", items: [{ itemId: goods.id, quantity: "1", unitPricePaise: 10000 }, { itemId: item.id, quantity: "1", unitPricePaise: 10000 }] })).invoice;
    await store.passGstInvoice(company.id, { ...input, requestId: "rcm-mixed-credit-0001", type: "Credit Note", direction: "purchase", date: "2026-04-20", supplierInvoiceNumber: "MIXED-CN-1", originalInvoiceId: mixed.id, stockEffect: "none", items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000 }] });
    const book = await store.get(company.id);
    const rows = rcmLiabilityRows(book.company, book.vouchers, "2026-04-01", "2026-06-30").filter((row) => row.invoiceId === mixed.id);
    assert.equal(rows.filter((row) => row.date === "2026-04-01").reduce((sum, row) => sum + row.cgstPaise, 0), 900);
    assert.equal(rows.some((row) => row.date === "2026-04-20"), false);
    assert.equal(rows.some((row) => row.date === "2026-06-01"), false);
  }, { registered: true });
});

test("evidenced early discharge preserves statutory timing and releases ITC only as liability is recognised", async () => {
  await withBooks(async ({ store, company, action, saved }) => {
    await action("supplier-payment", { date: "2026-05-01", bankDebitDate: "2026-05-01", bankLedgerId: "l-cash", amountPaise: 5000, allocationMethod: "pro-rata" });
    await action("cash-deposit", { date: "2026-05-02", bankLedgerId: "l-cash", components: tax() });
    const discharge = await action("tax-payment", { date: "2026-05-02", components: tax(), evidenceType: "cash-ledger-debit" });
    assert.equal(discharge.record.earlyDischarge, true);
    assert.equal(discharge.record.earlyDischargeComponents.cgstPaise, 450);
    await assert.rejects(action("itc-claim", { date: "2026-05-03", components: tax(), review: claimReview }), /exceeds/);
    await action("itc-claim", { date: "2026-05-03", components: tax(450, 450), review: claimReview });
    let book = await store.get(company.id);
    let position = rcmState(book.company, book.vouchers, "2026-05-31").documents[0];
    assert.equal(position.earlyTaxPaid.cgstPaise, 450);
    assert.equal(position.availableCredit.cgstPaise, 0);
    assert.equal(saved.invoice.rcm.liabilityDate, "2026-06-01");
    await action("itc-claim", { date: "2026-06-01", components: tax(450, 450), review: claimReview });
    book = await store.get(company.id);
    position = rcmState(book.company, book.vouchers, "2026-06-30").documents[0];
    assert.equal(position.earlyTaxPaid.cgstPaise, 0);
    assert.equal(position.claimed.cgstPaise, 900);
    assertRcmBook(book.company, book.vouchers);
  }, { registered: true });
});
