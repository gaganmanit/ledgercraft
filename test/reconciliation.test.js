import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../lib/store.js";
import { assertReconciliation, bankReport, billReport, guardReconciledLedger, guardReconciledVoucher, mutateReconciliation, parseBankCsv, previewBankStatement, reconciliationSection } from "../lib/reconciliation.js";
import { companyBackup, validateTransfer } from "../lib/transfer.js";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "financer-reconciliation-test-"));
  const store = createStore(dir);
  const { company } = await store.create({ name: "Synthetic Reconciliation Books", booksFrom: "2026-04-01" });
  const id = company.id;
  for (const row of [
    { name: "Test Bank", groupId: "g-bank", openingPaise: 100000 },
    { name: "Customer A", groupId: "g-debtors", openingPaise: 20000 },
    { name: "Supplier A", groupId: "g-creditors", openingPaise: 0 },
    { name: "Sales", groupId: "g-sales", openingPaise: 0 },
    { name: "Purchases", groupId: "g-purchase", openingPaise: 0 },
  ]) await store.addLedger(id, { ...row, openingDc: row.groupId === "g-creditors" ? "Cr" : "Dr" });
  const snapshot = await store.get(id);
  const ids = Object.fromEntries(snapshot.company.ledgers.map(row => [row.name, row.id]));
  const post = async (type, number, when, dr, cr, paise) => (await store.passVoucher(id, { type, number, date: when, narration: number, lines: [{ ledgerId: ids[dr], dc: "Dr", paise }, { ledgerId: ids[cr], dc: "Cr", paise }] })).voucher;
  const sale = await post("Sales", "INV-001", "2026-04-02", "Customer A", "Sales", 10000);
  const receipt = await post("Receipt", "RCT-001", "2026-04-05", "Test Bank", "Customer A", 6000);
  const payment = await post("Payment", "PAY-001", "2026-04-06", "Supplier A", "Test Bank", 4000);
  const purchase = await post("Purchase", "PUR-001", "2026-04-03", "Purchases", "Supplier A", 8000);
  const book = await store.get(id);
  return { dir, store, id, ids, sale, receipt, payment, purchase, post, book, close: () => rm(dir, { recursive: true, force: true }) };
}
function change(meta, book, action, input, requestId = crypto.randomUUID()) {
  return mutateReconciliation(meta, book, action, { revision: meta?.revision || 0, requestId, ...input });
}
function statementInput(f, extra = {}) {
  return { ledgerId: f.ids["Test Bank"], name: "April statement", from: "2026-04-01", to: "2026-04-30", openingPaise: 100000, closingPaise: 102000,
    csv: 'Date,Details,Reference,Debit,Credit\r\n05/04/2026,"Customer, A",RCT-001,,60.00\r\n06/04/2026,Supplier,PAY-001,40.00,\r\n',
    mapping: { date: 0, narration: 1, reference: 2, debit: 3, credit: 4 }, dateFormat: "dd/mm/yyyy", ...extra };
}

test("CSV parser preserves quotes, BOM and signed conventions, rejects ambiguous amounts and dates", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(parseBankCsv('\uFEFFDate,Description,Amount\n2026-04-05,"A ""quoted"", description",+60.00\n').records[0], ["2026-04-05", 'A "quoted", description', "+60.00"]);
    const p = previewBankStatement(f.book.company, f.book.vouchers, statementInput(f));
    assert.deepEqual(p.rows.map(row => row.amountPaise), [6000, -4000]);
    assert.equal(p.computedClosingPaise, 102000);
    const signed = previewBankStatement(f.book.company, f.book.vouchers, statementInput(f, { csv: "Date,Amount\n2026-04-05,-60.00\n2026-04-06,40.00\n", mapping: { date: 0, amount: 1 }, dateFormat: "yyyy-mm-dd", signedConvention: "debit-positive" }));
    assert.deepEqual(signed.rows.map(row => row.amountPaise), [6000, -4000]);
    assert.throws(() => previewBankStatement(f.book.company, f.book.vouchers, statementInput(f, { csv: "Date,Debit,Credit\n31/04/2026,1,\n", mapping: { date: 0, debit: 1, credit: 2 } })), /valid statement date/);
    assert.throws(() => parseBankCsv('Date,Amount\n"unfinished,1'), /unfinished/);
  } finally { await f.close(); }
});

test("statement candidates require confirmation, exact matches and unmatching preserve every ledger amount", async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.book.vouchers);
    let result = change(null, f.book, "import-statement", statementInput(f));
    let meta = result.section;
    const id = result.result.id;
    let report = bankReport(meta, f.book.company, f.book.vouchers, id);
    assert.equal(report.matches.length, 0);
    assert.equal(report.rows[0].candidateKind, "amount-date-reference");
    assert.equal(report.totals.differencePaise, 0);
    result = change(meta, f.book, "match-bank", { statementId: id, rowIds: [report.rows[0].id], voucherIds: [f.receipt.id] });
    meta = result.section;
    assert.throws(() => change(meta, f.book, "match-bank", { statementId: id, rowIds: [report.rows[0].id], voucherIds: [f.receipt.id] }), /already matched/);
    assert.throws(() => guardReconciledVoucher({ ...f.book.company, reconciliation: meta }, f.receipt, { ...f.receipt, date: "2026-04-07" }), /bank matches/);
    assert.doesNotThrow(() => guardReconciledVoucher({ ...f.book.company, reconciliation: meta }, f.receipt, { ...f.receipt, narration: "Corrected narration" }));
    meta = change(meta, f.book, "unmatch-bank", { matchId: result.result.id }).section;
    assert.equal(meta.matches.length, 0);
    assert.deepEqual(f.book.vouchers, before);
    assertReconciliation({ ...f.book.company, reconciliation: meta }, f.book.vouchers);
  } finally { await f.close(); }
});

test("duplicate amount/date rows remain ambiguous and imported duplicates are refused", async () => {
  const f = await fixture();
  try {
    const duplicate = statementInput(f, { closingPaise: 112000, csv: "Date,Debit,Credit\n05/04/2026,,60.00\n05/04/2026,,60.00\n", mapping: { date: 0, debit: 1, credit: 2 } });
    const { section: meta, result } = change(null, f.book, "import-statement", duplicate);
    const report = bankReport(meta, f.book.company, f.book.vouchers, result.id);
    assert.equal(report.rows[0].candidateKind, "ambiguous");
    assert.equal(meta.matches.length, 0);
    assert.throws(() => change(meta, f.book, "import-statement", duplicate), /already been imported/);
  } finally { await f.close(); }
});

test("older uncleared transactions reconcile opening and closing balances explicitly", async () => {
  const f = await fixture();
  try {
    const input = statementInput(f, { from: "2026-04-06", openingPaise: 100000, closingPaise: 102000, openingPendingVoucherIds: [f.receipt.id], csv: "Date,Debit,Credit\n06/04/2026,,60.00\n06/04/2026,40.00,\n", mapping: { date: 0, debit: 1, credit: 2 } });
    let { section: meta, result } = change(null, f.book, "import-statement", input);
    let report = bankReport(meta, f.book.company, f.book.vouchers, result.id);
    assert.equal(report.totals.openingDifferencePaise, 0);
    meta = change(meta, f.book, "match-bank", { statementId: result.id, rowIds: [report.rows[0].id], voucherIds: [f.receipt.id] }).section;
    report = bankReport(meta, f.book.company, f.book.vouchers, result.id);
    assert.equal(report.totals.differencePaise, 0);
    assert.equal(report.totals.statementArithmeticDifferencePaise, 0);
  } finally { await f.close(); }
});

test("bill references, partial receipts, advances, ageing and unallocation agree with unchanged ledger", async () => {
  const f = await fixture();
  try {
    let meta = reconciliationSection();
    let saved = change(meta, f.book, "save-bill", { ledgerId: f.ids["Customer A"], sourceKey: `${f.sale.id}:${f.ids["Customer A"]}`, reference: "INV-001", dueDate: "2026-04-10", amountPaise: 10000 });
    meta = saved.section;
    const billId = saved.result.id;
    saved = change(meta, f.book, "allocate-bill", { ledgerId: f.ids["Customer A"], billId, creditKey: `${f.receipt.id}:${f.ids["Customer A"]}`, date: "2026-04-05", paise: 6000 });
    meta = saved.section;
    const report = billReport(meta, f.book.company, f.book.vouchers, "2026-05-15", f.ids["Customer A"]);
    assert.equal(report.rows[0].openPaise, 4000);
    assert.equal(report.rows[0].bucket, "31–60");
    assert.equal(report.unreferenced[0].remainingPaise, 20000);
    assert.equal(report.totals[0].ledgerPaise, 24000);
    assert.equal(report.totals[0].differencePaise, 0);
    assert.throws(() => change(meta, f.book, "allocate-bill", { ledgerId: f.ids["Customer A"], billId, creditKey: `${f.receipt.id}:${f.ids["Customer A"]}`, date: "2026-04-05", paise: 1 }), /exceeds/);
    assert.throws(() => guardReconciledVoucher({ ...f.book.company, reconciliation: meta }, f.receipt, null), /allocations/);
    meta = change(meta, f.book, "unallocate-bill", { allocationId: saved.result.id }).section;
    assert.equal(billReport(meta, f.book.company, f.book.vouchers, "2026-05-15", f.ids["Customer A"]).settlements[0].remainingPaise, 6000);
    const supplier = change(meta, f.book, "save-bill", { ledgerId: f.ids["Supplier A"], sourceKey: `${f.purchase.id}:${f.ids["Supplier A"]}`, reference: "PUR-001", dueDate: "2026-04-03", amountPaise: 8000 });
    const payable = billReport(supplier.section, f.book.company, f.book.vouchers, "2026-04-30", f.ids["Supplier A"]);
    assert.equal(payable.totals[0].advancePaise, 4000);
    assert.equal(payable.totals[0].ledgerPaise, 4000);
    assert.equal(payable.totals[0].differencePaise, 0);
  } finally { await f.close(); }
});

test("serialized metadata writes are retry-safe, stale reviewers fail, backups retain references", async () => {
  const f = await fixture();
  try {
    const requestId = crypto.randomUUID();
    const input = { ...statementInput(f), requestId, revision: 0 };
    const persist = payload => f.store.mutateCompanySection(f.id, "reconciliation", (current, book) => mutateReconciliation(current, book, "import-statement", payload).section);
    await Promise.all([persist(input), persist(input)]);
    const current = await f.store.get(f.id);
    assert.equal(current.company.reconciliation.statements.length, 1);
    assert.equal(current.company.reconciliation.audit.length, 1);
    assert.equal(current.company.reconciliation.revision, 1);
    await assert.rejects(() => persist({ ...input, requestId: crypto.randomUUID() }), /changed while/);
    const transfer = validateTransfer(companyBackup(current.company, current.vouchers));
    assert.deepEqual(transfer.company.reconciliation, current.company.reconciliation);
    assertReconciliation(transfer.company, transfer.vouchers);
  } finally { await f.close(); }
});

test("manual grouping confirms equal signed totals and rejects tampered statement evidence", async () => {
  const f = await fixture();
  try {
    const second = await f.post("Receipt", "RCT-002", "2026-04-05", "Test Bank", "Customer A", 4000);
    const book = await f.store.get(f.id);
    const input = statementInput(f, { closingPaise: 110000, csv: "Date,Amount,Ref\n2026-04-05,100.00,BATCH-1\n", mapping: { date: 0, amount: 1, reference: 2 }, dateFormat: "yyyy-mm-dd", signedConvention: "credit-positive" });
    let { section: meta, result } = change(null, book, "import-statement", input);
    const report = bankReport(meta, book.company, book.vouchers, result.id);
    assert.equal(report.rows[0].candidateKind, "none");
    meta = change(meta, book, "match-bank", { statementId: result.id, rowIds: [report.rows[0].id], voucherIds: [f.receipt.id, second.id] }).section;
    assert.equal(meta.matches[0].voucherIds.length, 2);
    assertReconciliation({ ...book.company, reconciliation: meta }, book.vouchers);
    const corrupt = structuredClone(meta); corrupt.statements[0].rows[0].amountPaise++;
    assert.throws(() => assertReconciliation({ ...book.company, reconciliation: corrupt }, book.vouchers), /statement row/);
    assert.deepEqual((await f.store.get(f.id)).vouchers, book.vouchers);
  } finally { await f.close(); }
});

test("opening references can be split and protect their opening source", async () => {
  const f = await fixture();
  try {
    let meta;
    for (const reference of ["Opening A", "Opening B"]) meta = change(meta, f.book, "save-bill", { ledgerId: f.ids["Customer A"], sourceKey: `opening:${f.ids["Customer A"]}`, reference, dueDate: "2026-04-15", amountPaise: 10000 }).section;
    const account = f.book.company.ledgers.find(row => row.id === f.ids["Customer A"]);
    assert.throws(() => guardReconciledLedger({ ...f.book.company, reconciliation: meta }, account, { ...account, opening: { dc: "Dr", paise: 25000 } }), /opening-balance/);
    assert.doesNotThrow(() => guardReconciledLedger({ ...f.book.company, reconciliation: meta }, account, { ...account, name: "Customer renamed" }));
    const report = billReport(meta, f.book.company, f.book.vouchers, "2026-04-30", account.id);
    assert.equal(report.rows.length, 2);
    assert.equal(report.totals[0].differencePaise, 0);
  } finally { await f.close(); }
});

test("GST invoices gain bill references and due-date edits survive a company round trip", async () => {
  const f = await fixture();
  try {
    const { registration } = await f.store.saveGstMaster(f.id, "registration", { name: "Main", legalName: "Synthetic Books", gstin: "23ABCDE1234F1Z8", stateCode: "23", address: "Test Road" });
    const { party } = await f.store.saveGstMaster(f.id, "party", { name: "GST Customer", kind: "customer", stateCode: "23", address: "Test Road" });
    const { item } = await f.store.saveGstMaster(f.id, "item", { name: "Test goods", kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1800, pricePaise: 10000, openingQuantity: "10" });
    const { invoice } = await f.store.passGstInvoice(f.id, { type: "Sales", registrationId: registration.id, partyId: party.id, date: "2026-04-03", placeOfSupply: "23", items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000 }] });
    const book = await f.store.get(f.id);
    const before = billReport(reconciliationSection(), book.company, book.vouchers, "2026-04-30", party.customerLedgerId);
    assert.equal(before.rows.length, 1);
    assert.equal(before.rows[0].amountPaise, 11800);
    const result = change(null, book, "save-bill", { ...before.rows[0], dueDate: "2026-05-03" });
    const company = { ...book.company, reconciliation: result.section };
    const roundTrip = validateTransfer(companyBackup(company, book.vouchers));
    assertReconciliation(roundTrip.company, roundTrip.vouchers);
    const after = billReport(result.section, company, book.vouchers, "2026-04-30", party.customerLedgerId);
    assert.equal(after.rows[0].dueDate, "2026-05-03");
    assert.equal(after.rows[0].bucket, "current");
    assert.equal(after.totals[0].differencePaise, 0);
    assert.deepEqual(book.vouchers.find(row => row.id === invoice.id).gst, invoice);
  } finally { await f.close(); }
});

test("bank validation scales linearly: thousands of vouchers and matches validate well under a second", async () => {
  const { reservedGroups } = await import("../lib/groups.js");
  const { bookEntries } = await import("../lib/reconciliation-common.js");
  const company = { id: "scale", name: "Synthetic scale books", booksFrom: "2026-04-01", groups: reservedGroups(), ledgers: [
    { id: "l-bank", name: "Synthetic Bank", groupId: "g-bank", opening: { dc: "Dr", paise: 0 } },
    { id: "l-sales", name: "Sales", groupId: "g-sales", opening: { dc: "Cr", paise: 0 } }] };
  const voucherCount = 4000, matchCount = 2500;
  const vouchers = [];
  let csv = "Date,Narration,Deposit\n";
  for (let i = 0; i < voucherCount; i++) {
    const day = new Date(Date.UTC(2026, 3, 1) + (i % 360) * 86400000).toISOString().slice(0, 10);
    vouchers.push({ id: `v-${i}`, type: "Receipt", number: `R${i}`, date: day, narration: "", lines: [{ ledgerId: "l-bank", dc: "Dr", paise: 10000 + i }, { ledgerId: "l-sales", dc: "Cr", paise: 10000 + i }] });
    if (i < matchCount) { const [y, m, d] = day.split("-"); csv += `${d}/${m}/${y},Synthetic ${i},${((10000 + i) / 100).toFixed(2)}\n`; }
  }
  const imported = mutateReconciliation(null, { company, vouchers }, "import-statement", { requestId: "scale-import-0000001", revision: 0, ledgerId: "l-bank", from: "2026-04-01", to: "2027-03-31",
    openingPaise: 0, closingPaise: 0, csv, mapping: { date: 0, narration: 1, amount: 2 }, signedConvention: "credit-positive", dateFormat: "dd/mm/yyyy" });
  const meta = imported.section, statement = meta.statements[0];
  const fingerprints = new Map(bookEntries(company, vouchers, "l-bank").map(entry => [entry.voucherId, entry.fingerprint]));
  for (let i = 0; i < matchCount - 1; i++) meta.matches.push({ id: `bm-${i.toString(16).padStart(20, "0")}`, ledgerId: "l-bank", statementId: statement.id, rowIds: [statement.rows[i].id], voucherIds: [`v-${i}`], fingerprints: { [`v-${i}`]: fingerprints.get(`v-${i}`) }, matchedAt: "2026-11-08T00:00:00.000Z" });
  let started = performance.now();
  assertReconciliation({ ...company, reconciliation: meta }, vouchers);
  const validationMs = performance.now() - started;
  assert.ok(validationMs < 1000, `validation took ${Math.round(validationMs)} ms`);
  // One more match through the ordinary mutation path, then the store-style re-check.
  started = performance.now();
  const last = matchCount - 1;
  const matched = mutateReconciliation(meta, { company, vouchers }, "match-bank", { requestId: "scale-match-00000001", revision: meta.revision, statementId: statement.id, rowIds: [statement.rows[last].id], voucherIds: [`v-${last}`] });
  assertReconciliation({ ...company, reconciliation: matched.section }, structuredClone(vouchers));
  const mutationMs = performance.now() - started;
  assert.equal(matched.section.matches.length, matchCount);
  assert.ok(mutationMs < 1000, `match plus store re-check took ${Math.round(mutationMs)} ms`);
  // Validation stays strict at scale.
  const tampered = structuredClone(matched.section);
  tampered.matches[17].fingerprints["v-17"] = "0".repeat(64);
  assert.throws(() => assertReconciliation({ ...company, reconciliation: tampered }, vouchers), /no longer agrees/);
  const doubled = structuredClone(matched.section);
  doubled.matches[18].rowIds = [...doubled.matches[17].rowIds];
  assert.throws(() => assertReconciliation({ ...company, reconciliation: doubled }, vouchers), /Match equal totals|matched twice/);
});
