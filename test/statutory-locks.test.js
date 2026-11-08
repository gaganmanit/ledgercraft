import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { trialBalance } from "../lib/engine.js";
import { gstinCheckDigit } from "../lib/gst.js";
import { createStore } from "../lib/store.js";
import { companyBackup, validateTransfer } from "../lib/transfer.js";
import { start } from "../server.js";

const gstin = (state, pan = "ABCDE1234F") => { const stem = `${state}${pan}1Z`; return stem + gstinCheckDigit(stem); };
const BOOKS_LOCKED = /The books are locked up to 31-03-2026 \(FY 2025-26 audited\)\. Unlock them under Books settings to change this entry\.$/;
const GST_LOCKED = /GST returns are locked up to 30-04-2026 \(April GSTR-1 and GSTR-3B filed\)\. Unlock them under Books settings to change this entry\.$/;

async function withStore(run) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ledgercraft-locks-"));
  try { await run(createStore(dataDir), dataDir); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}

async function readLog(dataDir, id) {
  return (await readFile(path.join(dataDir, "companies", id, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

const receipt = (income, number, date, paise = 50000) => ({ type: "Receipt", date, number, narration: "Counter sale", lines: [{ ledgerId: "l-cash", dc: "Dr", paise }, { ledgerId: income, dc: "Cr", paise }] });

async function seeded(store) {
  const { company } = await store.create({ name: "Locked Books", booksFrom: "2025-04-01" });
  const book = await store.addLedger(company.id, { name: "Sales", groupId: "g-sales", openingPaise: 0, openingDc: "Cr" });
  const sales = book.company.ledgers.find((ledger) => ledger.name === "Sales").id;
  const old = (await store.passVoucher(company.id, receipt(sales, "RCT-1", "2026-03-15"))).voucher;
  const current = (await store.passVoucher(company.id, receipt(sales, "RCT-2", "2026-04-15"))).voucher;
  return { id: company.id, sales, old, current };
}

test("a books lock refuses creating, altering and deleting entries on or before its date and is logged", async () => {
  await withStore(async (store, dataDir) => {
    const { id, sales, old, current } = await seeded(store);
    const saved = await store.setLocks(id, { books: { to: "2026-03-31", reason: "FY 2025-26 audited" }, requestId: "lock-books-fy2526-0001" });
    assert.equal(saved.replayed, false);
    assert.equal(saved.locks.books.to, "2026-03-31");
    assert.equal(saved.locks.books.reason, "FY 2025-26 audited");
    assert.equal(saved.locks.books.requestId, "lock-books-fy2526-0001");
    assert.match(saved.locks.books.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(saved.locks.gst, null);

    await assert.rejects(store.passVoucher(id, receipt(sales, "RCT-3", "2026-03-31")), BOOKS_LOCKED);
    await assert.rejects(store.passVoucher(id, { ...old, narration: "Changed after audit" }, old.id), BOOKS_LOCKED);
    await assert.rejects(store.removeVoucher(id, old.id), BOOKS_LOCKED);
    // Moving an open voucher back into the locked year is a change to the locked year.
    await assert.rejects(store.passVoucher(id, { ...current, date: "2026-03-20" }, current.id), BOOKS_LOCKED);
    // Moving a locked voucher out of the locked year is refused too.
    await assert.rejects(store.passVoucher(id, { ...old, date: "2026-04-02" }, old.id), BOOKS_LOCKED);
    // Openings belong to the first day of the books.
    await assert.rejects(store.updateLedger(id, "l-cash", { name: "Cash", groupId: "g-cash", openingPaise: 100, openingDc: "Dr", reason: "Opening cash count corrected" }), BOOKS_LOCKED);
    await assert.rejects(store.addLedger(id, { name: "Late Capital", groupId: "g-capital", openingPaise: 100, openingDc: "Cr" }), BOOKS_LOCKED);

    // Open-period work and master changes without a balance effect continue.
    await store.passVoucher(id, receipt(sales, "RCT-3", "2026-04-01"));
    await store.passVoucher(id, { ...current, narration: "Open period correction" }, current.id);
    await store.updateLedger(id, sales, { name: "Counter Sales", groupId: "g-sales" });

    // Reports still read the locked year.
    const book = await store.get(id);
    const trial = trialBalance(book.company, book.vouchers, "2025-04-01", "2026-03-31");
    assert.equal(trial.credit, 50000);
    assert.equal(trial.difference, 0);
    assert.equal(book.vouchers.find((voucher) => voucher.id === old.id).narration, "Counter sale");

    const repeat = await store.setLocks(id, { books: { to: "2026-03-31", reason: "FY 2025-26 audited" } });
    assert.equal(repeat.replayed, true);
    const unlocked = await store.setLocks(id, { books: { to: null, reason: "Auditor asked for a reclassification" } });
    assert.equal(unlocked.locks.books.to, null);
    await store.passVoucher(id, { ...old, narration: "Reclassified on the auditor's advice" }, old.id);

    const locks = (await readLog(dataDir, id)).filter((entry) => entry.entity === "lock");
    assert.deepEqual(locks.map((entry) => `${entry.action}:${entry.id}`), ["lock:books", "unlock:books"]);
    assert.equal(locks[0].before, null);
    assert.equal(locks[0].after.to, "2026-03-31");
    assert.equal(locks[0].requestId, "lock-books-fy2526-0001");
    assert.equal(locks[0].summary, "Books locked up to 31-03-2026. Reason: FY 2025-26 audited");
    assert.equal(locks[1].summary, "Books unlocked (were locked up to 31-03-2026). Reason: Auditor asked for a reclassification");
    assert.equal(locks[1].before.to, "2026-03-31");
  });
});

test("lock requests need a reason within 240 characters and a valid date, and reject stale edits", async () => {
  await withStore(async (store) => {
    const { id } = await seeded(store);
    await assert.rejects(store.setLocks(id, { books: { to: "2026-03-31" } }), /Give a reason for this lock change/);
    await assert.rejects(store.setLocks(id, { books: { to: "2026-03-31", reason: "   " } }), /Give a reason/);
    await assert.rejects(store.setLocks(id, { books: { to: "2026-03-31", reason: "x".repeat(241) } }), /within 240 characters/);
    await assert.rejects(store.setLocks(id, { books: { to: "31-03-2026", reason: "Audited" } }), /Enter the books lock date/);
    await assert.rejects(store.setLocks(id, { gst: { to: "2026-02-30", reason: "Filed" } }), /Enter the GST lock date/);
    await assert.rejects(store.setLocks(id, {}), /Choose the books or GST lock/);
    await assert.rejects(store.setLocks(id, { books: { to: "2026-03-31", reason: "Audited" }, requestId: "short" }), /Invalid lock save identifier/);
    const { locks } = await store.locks(id);
    assert.deepEqual(locks, { books: null, gst: null });
    await store.setLocks(id, { books: { to: "2026-03-31", reason: "Audited" }, expected: locks });
    await assert.rejects(store.setLocks(id, { books: { to: "2026-04-30", reason: "Audited" }, expected: locks }), /locks changed while you were editing/);
    assert.equal((await store.setLocks(id, { books: { to: "x".repeat(0) || null, reason: "Reopened" } })).locks.books.to, null);
  });
});

async function gstBook(store) {
  const { company } = await store.create({ name: "GST Locked Books", booksFrom: "2025-04-01" });
  const registration = (await store.saveGstMaster(company.id, "registration", { name: "Synthetic Recipient", legalName: "Synthetic Recipient", gstin: gstin("23"), stateCode: "23", address: "Public test address", pincode: "462001" })).registration;
  const party = (await store.saveGstMaster(company.id, "party", { name: "Synthetic Supplier", kind: "both", gstin: "", stateCode: "23", address: "Public supplier address" })).party;
  const item = (await store.saveGstMaster(company.id, "item", { name: "Synthetic RCM supply", kind: "service", hsnSac: "998599", unit: "NOS", gstRateBps: 1800, cessRateBps: 0, pricePaise: 10000, purchasePricePaise: 10000, supplyStatus: "taxable", openingQuantity: "0" })).item;
  const rcmInput = (date, requestId) => ({ type: "Purchase", registrationId: registration.id, partyId: party.id, date, supplierInvoiceNumber: `SUP-${requestId.slice(-4)}`, placeOfSupply: "23", pricing: "exclusive", reverseCharge: true, rcm: { applicabilityConfirmed: true, basisReference: "Synthetic notified RCM basis under section9(3)", receiptDate: date, supplierInvoiceDate: date, selfInvoiceDate: date }, items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000 }], requestId });
  return { id: company.id, registration, party, item, rcmInput };
}

const tax = { cgstPaise: 900, sgstPaise: 900, utgstPaise: 0, igstPaise: 0, cessPaise: 0 };

test("a GST lock refuses GST documents and reverse-charge decisions on or before its date while ordinary vouchers continue", async () => {
  await withStore(async (store, dataDir) => {
    const { id, rcmInput } = await gstBook(store);
    const april = await store.passGstInvoice(id, rcmInput("2026-04-10", "gst-lock-invoice-00001"));
    await store.setLocks(id, { gst: { to: "2026-04-30", reason: "April GSTR-1 and GSTR-3B filed" } });
    await assert.rejects(store.passGstInvoice(id, rcmInput("2026-04-29", "gst-lock-invoice-00002")), GST_LOCKED);
    await assert.rejects(store.gstRcmAction(id, "cash-deposit", { invoiceId: april.invoice.id, date: "2026-04-30", requestId: "gst-lock-deposit-000001", reference: "Public reference 1", bankLedgerId: "l-cash", components: tax }), GST_LOCKED);
    // A replay of a save made before the lock still answers with the saved invoice.
    assert.equal((await store.passGstInvoice(id, rcmInput("2026-04-10", "gst-lock-invoice-00001"))).replayed, true);
    // Decisions dated after the lock on a locked-period document are allowed.
    const deposit = await store.gstRcmAction(id, "cash-deposit", { invoiceId: april.invoice.id, date: "2026-05-02", requestId: "gst-lock-deposit-000002", reference: "Public reference 2", bankLedgerId: "l-cash", components: tax });
    assert.equal(deposit.record.date, "2026-05-02");
    await store.passGstInvoice(id, rcmInput("2026-05-05", "gst-lock-invoice-00003"));
    // The GST lock does not freeze ordinary books.
    const book = await store.addLedger(id, { name: "Sundry Income", groupId: "g-indirect-inc", openingPaise: 0, openingDc: "Cr" });
    const income = book.company.ledgers.find((ledger) => ledger.name === "Sundry Income").id;
    await store.passVoucher(id, receipt(income, "RCT-1", "2026-04-12"));
    // Reports still read the locked month.
    const state = await store.gstState(id, "2026-04-30");
    assert.ok(state.invoices.some((invoice) => invoice.id === april.invoice.id));

    await store.setLocks(id, { gst: { to: null, reason: "Amendment to April return" } });
    await store.passGstInvoice(id, rcmInput("2026-04-29", "gst-lock-invoice-00002"));
    const entries = (await readLog(dataDir, id)).filter((entry) => entry.entity === "lock");
    assert.deepEqual(entries.map((entry) => `${entry.action}:${entry.id}`), ["lock:gst", "unlock:gst"]);
    assert.equal(entries[0].summary, "GST returns locked up to 30-04-2026. Reason: April GSTR-1 and GSTR-3B filed");
  });
});

test("a books lock also covers GST documents and stock journals in the locked period", async () => {
  await withStore(async (store, dataDir) => {
    const { id, rcmInput } = await gstBook(store);
    await store.setLocks(id, { books: { to: "2026-03-31", reason: "FY 2025-26 audited" } });
    await assert.rejects(store.passGstInvoice(id, rcmInput("2026-03-30", "books-lock-invoice-0001")), BOOKS_LOCKED);
    const server = await start({ dataDir });
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/companies/${id}`;
      const call = async (route, method, body) => {
        const response = await fetch(base + route, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
        return { status: response.status, body: await response.json() };
      };
      const goods = (await store.saveGstMaster(id, "item", { name: "Locked Goods", kind: "goods", hsnSac: "854140", unit: "NOS", pricePaise: 20000, purchasePricePaise: 12000, gstRateBps: 1800, openingQuantity: "4" })).item;
      const godown = await call("/stock/godowns", "POST", { name: "East depot", revision: 0, requestId: "locks-stock-godown-0001" });
      assert.equal(godown.status, 200, JSON.stringify(godown.body));
      const transfer = (date, number, requestId) => ({ number, date, type: "transfer", lines: [{ itemId: goods.id, quantity: "1", fromGodownId: "main", toGodownId: godown.body.result.id }], requestId, revision: 1 });
      const refused = await call("/stock/journals", "POST", transfer("2026-03-20", "ST-1", "locks-stock-journal-001"));
      assert.equal(refused.status, 400);
      assert.match(refused.body.error, BOOKS_LOCKED);
      const saved = await call("/stock/journals", "POST", transfer("2026-04-03", "ST-2", "locks-stock-journal-002"));
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const entries = (await readLog(dataDir, id)).filter((entry) => entry.entity === "stock-journal");
      assert.deepEqual(entries.map((entry) => `${entry.action}:${entry.number || entry.id}`), ["create:stock-settings", "create:ST-2"]);
      assert.match(entries[1].summary, /Stock journal ST-2 dated 03-04-2026 recorded/);

      const locks = await call("/locks", "PUT", { books: { to: null, reason: "Reopen" }, gst: { to: "2026-03-31", reason: "Filed" } });
      assert.equal(locks.status, 200);
      assert.equal(locks.body.locks.books.to, null);
      assert.equal(locks.body.locks.gst.to, "2026-03-31");
      assert.deepEqual((await call("/locks", "GET")).body.locks, locks.body.locks);
      const bad = await call("/locks", "PUT", { books: { to: "2026-03-31", reason: "" } });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, "Give a reason for this lock change");
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});

test("saved locks survive a backup restore and malformed locks are refused", async () => {
  await withStore(async (store) => {
    const { id } = await seeded(store);
    await store.setLocks(id, { books: { to: "2026-03-31", reason: "Audited" } });
    const { company, vouchers } = await store.get(id);
    assert.equal(validateTransfer(companyBackup(company, vouchers)).company.locks.books.to, "2026-03-31");
    assert.throws(() => validateTransfer(companyBackup({ ...company, locks: { books: { to: "soon", reason: "x", at: "now" } } }, vouchers)), /Invalid period locks/);
    assert.throws(() => validateTransfer(companyBackup({ ...company, locks: { payroll: null } }, vouchers)), /Invalid period locks/);
  });
});
