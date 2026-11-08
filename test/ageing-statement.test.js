import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../lib/store.js";
import { partyStatement, statementCsv, statementFilename } from "../lib/statement-routes.js";
import { start } from "../server.js";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "ledgercraft-statement-test-"));
  const store = createStore(dir);
  const { company } = await store.create({ name: "Statement Test Books", booksFrom: "2026-04-01" });
  const id = company.id;
  for (const row of [
    { name: "Test Bank", groupId: "g-bank", openingPaise: 100000, openingDc: "Dr" },
    { name: "Customer, A", groupId: "g-debtors", openingPaise: 20000, openingDc: "Dr" },
    { name: "Sales", groupId: "g-sales", openingPaise: 0, openingDc: "Cr" },
    { name: "Freight", groupId: "g-indirect-inc", openingPaise: 0, openingDc: "Cr" },
  ]) await store.addLedger(id, row);
  const ids = Object.fromEntries((await store.get(id)).company.ledgers.map(row => [row.name, row.id]));
  const customer = ids["Customer, A"];
  const post = async (type, number, date, lines, narration = number) => (await store.passVoucher(id, { type, number, date, narration, lines })).voucher;
  await post("Sales", "INV-001", "2026-04-02", [{ ledgerId: customer, dc: "Dr", paise: 10000 }, { ledgerId: ids.Sales, dc: "Cr", paise: 9000 }, { ledgerId: ids.Freight, dc: "Cr", paise: 1000 }], "=cmd|' /C calc'!A0");
  const { registration } = await store.saveGstMaster(id, "registration", { name: "Main", legalName: "Statement Test Books", gstin: "23ABCDE1234F1Z8", stateCode: "23", address: "Test Road" });
  const { party } = await store.saveGstMaster(id, "party", { name: "GST Customer", kind: "customer", stateCode: "23", address: "12 Market Road, Bhopal", customerLedgerId: customer });
  const { item } = await store.saveGstMaster(id, "item", { name: "Test goods", kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1800, pricePaise: 10000, openingQuantity: "10" });
  const { invoice } = await store.passGstInvoice(id, { type: "Sales", registrationId: registration.id, partyId: party.id, date: "2026-04-03", placeOfSupply: "23", items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000 }] });
  const receipt = await post("Receipt", "RCT-001", "2026-04-05", [{ ledgerId: ids["Test Bank"], dc: "Dr", paise: 6000 }, { ledgerId: customer, dc: "Cr", paise: 6000 }]);
  return { dir, store, id, ids, customer, invoice, receipt, close: () => rm(dir, { recursive: true, force: true }) };
}

test("party statement keeps a running balance, names contra ledgers and GST documents, and ages the closing balance", async () => {
  const f = await fixture();
  try {
    const { company, vouchers } = await f.store.get(f.id);
    const statement = partyStatement(company, vouchers, f.customer, "2026-04-03", "2026-04-30");
    assert.deepEqual(statement.company, { name: "Statement Test Books", gstin: "23ABCDE1234F1Z8" });
    assert.deepEqual(statement.party, { ledgerId: f.customer, name: "Customer, A", side: "receivable", address: "12 Market Road, Bhopal", msme: false, creditDays: 0 });
    assert.deepEqual(statement.period, { from: "2026-04-03", to: "2026-04-30" });
    // The opening balance plus the 2 April sale, which falls before the period.
    assert.deepEqual(statement.opening, { dc: "Dr", paise: 30000 });
    assert.deepEqual(statement.lines.map(line => [line.date, line.type, line.debitPaise, line.creditPaise, line.balance.paise, line.balance.dc]), [
      ["2026-04-03", "Sales", 11800, 0, 41800, "Dr"],
      ["2026-04-05", "Receipt", 0, 6000, 35800, "Dr"],
    ]);
    const [gstLine, receiptLine] = statement.lines;
    assert.equal(gstLine.voucherId, f.invoice.id);
    assert.equal(gstLine.documentNumber, f.invoice.number);
    assert.match(gstLine.particulars, new RegExp(`Tax Invoice ${f.invoice.number}$`));
    assert.match(gstLine.particulars, /GST Sales/);
    assert.equal(gstLine.dueDate, "2026-04-03");
    assert.equal(gstLine.overdueDays, 27);
    assert.equal(receiptLine.particulars, "Test Bank");
    assert.equal(receiptLine.dueDate, undefined);
    assert.deepEqual(statement.closing, { dc: "Dr", paise: 35800 });
    assert.deepEqual(statement.totals, { debitPaise: 11800, creditPaise: 6000, lineCount: 2 });
    assert.equal(statement.ageing.asOf, "2026-04-30");
    assert.equal(statement.ageing.total, 35800);
    assert.equal(statement.ageing.buckets.find(row => row.label === "1-30").paise, 35800);
    assert.equal(statement.ageing.oldestDate, "2026-04-01");
    // The receipt settles the opening balance first, so the GST invoice stays fully open.
    assert.deepEqual(statement.ageing.openItems.map(item => [item.reference, item.openPaise]), [["Opening balance", 14000], ["INV-001", 10000], [f.invoice.number, 11800]]);
    // The whole year: the 2 April sale names both income ledgers.
    const full = partyStatement(company, vouchers, f.customer, "2026-04-01", "2026-04-30");
    assert.deepEqual(full.opening, { dc: "Dr", paise: 20000 });
    assert.equal(full.lines[0].particulars, "Sales, Freight");
    assert.equal(full.lines[0].overdueDays, 28);
    assert.throws(() => partyStatement(company, vouchers, f.ids.Sales, "2026-04-01", "2026-04-30"), /sundry debtor/);
    assert.throws(() => partyStatement(company, vouchers, f.customer, "2026-04-30", "2026-04-01"), /period/);
  } finally { await f.close(); }
});

test("statement CSV uses a BOM, dd-mm-yyyy dates, plain numbers and escapes text", async () => {
  const f = await fixture();
  try {
    const { company, vouchers } = await f.store.get(f.id);
    const statement = partyStatement(company, vouchers, f.customer, "2026-04-01", "2026-04-30");
    const csv = statementCsv(statement);
    assert.ok(csv.startsWith("\uFEFF"));
    const rows = csv.slice(1).trimEnd().split("\r\n");
    assert.equal(rows[0], "Date,Voucher type,Voucher number,Particulars,Narration,Debit,Credit,Balance,Dr/Cr,Due date,Overdue days");
    assert.equal(rows[1], "01-04-2026,,,Opening balance,,,,200.00,Dr,,");
    assert.equal(rows[2], `02-04-2026,Sales,INV-001,"Sales, Freight",'=cmd|' /C calc'!A0,100.00,,300.00,Dr,02-04-2026,28`);
    assert.match(rows[3], new RegExp(`^03-04-2026,Sales,${f.invoice.number},.*,118\\.00,,418\\.00,Dr,03-04-2026,27$`));
    assert.equal(rows[4], "05-04-2026,Receipt,RCT-001,Test Bank,RCT-001,,60.00,358.00,Dr,,");
    assert.equal(rows[5], ",,,Total for the period,,218.00,60.00,,,,");
    assert.equal(rows[6], "30-04-2026,,,Closing balance,,,,358.00,Dr,,");
    assert.equal(rows.length, 7);
    assert.equal(statementFilename(statement), "customer-a-statement-2026-04-01-2026-04-30.csv");
  } finally { await f.close(); }
});

test("statement endpoints return JSON and a CSV attachment for party ledgers only", async () => {
  const f = await fixture();
  const server = await start({ port: 0, dataDir: f.dir });
  const base = `http://127.0.0.1:${server.address().port}/api/companies/${f.id}/parties/${encodeURIComponent(f.customer)}`;
  try {
    const json = await fetch(`${base}/statement?from=2026-04-03&to=2026-04-30`);
    assert.equal(json.status, 200);
    const statement = await json.json();
    assert.equal(statement.closing.paise, 35800);
    assert.equal(statement.lines.length, 2);
    assert.equal("gstin" in statement.party, false);
    const csv = await fetch(`${base}/statement.csv?from=2026-04-03&to=2026-04-30`);
    assert.equal(csv.status, 200);
    assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.equal(csv.headers.get("content-disposition"), 'attachment; filename="customer-a-statement-2026-04-03-2026-04-30.csv"');
    const bytes = new Uint8Array(await csv.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    // Without dates the statement runs from the financial year start to today.
    assert.equal((await fetch(`${base}/statement`)).status, 200);
    const wrong = await fetch(`http://127.0.0.1:${server.address().port}/api/companies/${f.id}/parties/${encodeURIComponent(f.ids.Sales)}/statement?from=2026-04-01&to=2026-04-30`);
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /sundry debtor/);
    const badPeriod = await fetch(`${base}/statement?from=2026-05-01&to=2026-04-01`);
    assert.equal(badPeriod.status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/companies/missing-company/parties/x/statement`)).status, 404);
    assert.equal((await fetch(`${base}/statement.pdf`)).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await f.close();
  }
});
