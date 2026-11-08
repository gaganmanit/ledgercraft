import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../lib/store.js";
import { trialBalance } from "../lib/engine.js";
import { start } from "../server.js";

async function withStore(run) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "financer-masters-"));
  try { await run(createStore(dataDir), dataDir); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}

test("masters allow corrections and protect used ledgers and reserved groups", async () => {
  await withStore(async (store) => {
    const { company } = await store.specimen();
    const id = company.id;
    let book = await store.addLedger(id, { name: "Bank Charge", groupId: "g-indirect-exp", openingDc: "Dr", openingPaise: 0 });
    const ledger = book.company.ledgers.find((item) => item.name === "Bank Charge");
    book = await store.updateLedger(id, ledger.id, { name: "Bank Charges", groupId: "g-direct-exp", openingPaise: 12550, openingDc: "Dr" });
    assert.equal(book.company.ledgers.find((item) => item.id === ledger.id).opening.paise, 12550);
    assert.equal(book.company.ledgers.find((item) => item.id === ledger.id).groupId, "g-direct-exp");
    await store.removeLedger(id, ledger.id);
    assert.equal((await store.get(id)).company.ledgers.some((item) => item.id === ledger.id), false);
    const used = company.ledgers.find((item) => item.id === company.ledgers[0].id);
    await assert.rejects(store.removeLedger(id, used.id), /has vouchers/);
    await assert.rejects(store.updateLedger(id, used.id, { name: used.name, groupId: used.groupId, openingPaise: used.opening.paise + 1, openingDc: used.opening.dc }), /only before a voucher/);
    await assert.rejects(store.updateLedger(id, used.id, { name: used.name, groupId: "g-indirect-exp", openingPaise: used.opening.paise, openingDc: used.opening.dc }), /receipt debits cash/);
    await assert.rejects(store.updateGroup(id, "g-cash", { name: "Petty Cash" }), /Reserved groups/);
    await assert.rejects(store.removeGroup(id, "g-cash"), /Reserved groups/);
    assert.equal((await store.get(id)).company.ledgers.find((item) => item.id === used.id).groupId, used.groupId);
  });
});

test("custom groups rename and refuse deletion with children or ledgers", async () => {
  await withStore(async (store) => {
    const { company } = await store.create({ name: "Group Book", booksFrom: "2026-04-01" });
    const id = company.id;
    let book = await store.addGroup(id, { name: "Expenses Detail", parentId: "g-indirect-exp" });
    const parent = book.company.groups.find((item) => item.name === "Expenses Detail");
    book = await store.updateGroup(id, parent.id, { name: "Operating Expenses" });
    assert.equal(book.company.groups.find((item) => item.id === parent.id).name, "Operating Expenses");
    book = await store.addGroup(id, { name: "Banking Detail", parentId: parent.id });
    const child = book.company.groups.find((item) => item.name === "Banking Detail");
    await assert.rejects(store.removeGroup(id, parent.id), /child groups/);
    await store.removeGroup(id, child.id);
    book = await store.addLedger(id, { name: "Bank Charges", groupId: parent.id, openingPaise: 0, openingDc: "Dr" });
    const ledger = book.company.ledgers.find((item) => item.name === "Bank Charges");
    await assert.rejects(store.removeGroup(id, parent.id), /ledgers/);
    await store.removeLedger(id, ledger.id);
    await store.removeGroup(id, parent.id);
    assert.equal((await store.get(id)).company.groups.some((item) => item.id === parent.id), false);
  });
});

test("concurrent mutations preserve every ledger and a failed mutation releases the queue", async () => {
  await withStore(async (store, dataDir) => {
    const { company } = await store.create({ name: "Concurrent Book", booksFrom: "2026-04-01" });
    const otherStore = createStore(dataDir);
    await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? store : otherStore).addLedger(company.id, { name: `Expense ${index}`, groupId: "g-indirect-exp", openingPaise: index, openingDc: "Dr" })));
    await assert.rejects(store.addLedger(company.id, { name: "Cash", groupId: "g-cash", openingPaise: 0, openingDc: "Dr" }), /already exists/);
    await store.addLedger(company.id, { name: "Final Expense", groupId: "g-indirect-exp", openingPaise: 0, openingDc: "Dr" });
    assert.equal((await store.get(company.id)).company.ledgers.length, 14);
  });
});

test("receipt alteration keeps its number and deletion restores trial balance", async () => {
  await withStore(async (store) => {
    let book = await store.specimen();
    const { company } = book;
    const before = trialBalance(company, book.vouchers, company.booksFrom, "2099-03-31");
    const receipt = book.vouchers.find((voucher) => voucher.type === "Receipt");
    const changed = { ...receipt, lines: receipt.lines.map((line) => ({ ...line, paise: line.paise + 111 })) };
    book = await store.passVoucher(company.id, changed, receipt.id);
    assert.equal(book.voucher.number, receipt.number);
    const after = trialBalance(book.company, book.vouchers, company.booksFrom, "2099-03-31");
    assert.equal(after.debit - before.debit, 111);
    assert.equal(after.difference, 0);
    book = await store.removeVoucher(company.id, receipt.id);
    const removed = trialBalance(book.company, book.vouchers, company.booksFrom, "2099-03-31");
    assert.equal(before.debit - removed.debit, receipt.lines[0].paise);
    assert.equal(removed.difference, 0);
  });
});

test("HTTP master update and delete routes round trip", async () => {
  await withStore(async (store, dataDir) => {
    const { company } = await store.create({ name: "HTTP Master Book", booksFrom: "2026-04-01" });
    const server = await start({ dataDir });
    const base = `http://127.0.0.1:${server.address().port}/api/companies/${company.id}`;
    try {
      const created = await fetch(`${base}/groups`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Banking", parentId: "g-indirect-exp" }) }).then((response) => response.json());
      const group = created.company.groups.find((item) => item.name === "Banking");
      const renamed = await fetch(`${base}/groups/${group.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Banking Costs" }) });
      assert.equal(renamed.status, 200);
      assert.equal((await renamed.json()).company.groups.find((item) => item.id === group.id).name, "Banking Costs");
      assert.equal((await fetch(`${base}/groups/${group.id}`, { method: "DELETE" })).status, 200);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});

test("stale master and voucher edits preserve the newer saved entry", async () => {
  await withStore(async (store) => {
    let book = await store.specimen();
    const id = book.company.id;
    const cash = book.company.ledgers.find((item) => item.id === "l-cash");
    const expected = { name: cash.name, groupId: cash.groupId, opening: cash.opening };
    await store.updateLedger(id, cash.id, { ...cash, name: "Cash Account", groupId: cash.groupId, expected });
    await assert.rejects(store.updateLedger(id, cash.id, { ...cash, name: "Stale Cash Name", groupId: cash.groupId, expected }), /changed while you were editing/);
    assert.equal((await store.get(id)).company.ledgers.find((item) => item.id === cash.id).name, "Cash Account");
    book = await store.addGroup(id, { name: "Custom Charges", parentId: "g-indirect-exp" });
    const group = book.company.groups.find((item) => item.name === "Custom Charges");
    await store.updateGroup(id, group.id, { name: "Updated Charges", expected: { name: group.name } });
    await assert.rejects(store.updateGroup(id, group.id, { name: "Stale Charges", expected: { name: group.name } }), /changed while you were editing/);
    const voucher = book.vouchers[0];
    await store.passVoucher(id, { ...voucher, narration: "New narration", expected: voucher }, voucher.id);
    await assert.rejects(store.passVoucher(id, { ...voucher, narration: "Stale narration", expected: voucher }, voucher.id), /changed while you were editing/);
    assert.equal((await store.get(id)).vouchers.find((item) => item.id === voucher.id).narration, "New narration");
  });
});

test("repeated voucher requests save once and reject a reused identifier with different entries", async () => {
  await withStore(async (store, dataDir) => {
    const book = await store.specimen();
    const voucher = book.vouchers.find((item) => item.type === "Receipt");
    const input = { ...voucher, number: "RCT-2", requestId: "daily-books-retry-123456" };
    const saves = await Promise.all([store.passVoucher(book.company.id, input), createStore(dataDir).passVoucher(book.company.id, input)]);
    assert.equal(saves[0].voucher.id, saves[1].voucher.id);
    assert.equal(saves[1].replayed, true);
    assert.equal((await store.get(book.company.id)).vouchers.length, book.vouchers.length + 1);
    const changed = { ...input, narration: "A different entry" };
    await assert.rejects(store.passVoucher(book.company.id, changed), /different voucher/);
    await assert.rejects(store.passVoucher(book.company.id, { ...input, requestId: "bad" }), /save identifier/);
  });
});

test("balance-affecting writes reject unsafe book totals without saving partial changes", async () => {
  await withStore(async (store) => {
    const { company } = await store.create({ name: "Large Amount Book", booksFrom: "2026-04-01" });
    const id = company.id;
    const opening = Number.MAX_SAFE_INTEGER - 10;
    await store.updateLedger(id, "l-cash", { name: "Cash", groupId: "g-cash", openingPaise: opening, openingDc: "Dr" });
    let book = await store.addLedger(id, { name: "Capital", groupId: "g-capital", openingPaise: opening, openingDc: "Cr" });
    await assert.rejects(store.addLedger(id, { name: "Too Much Opening", groupId: "g-indirect-exp", openingPaise: 11, openingDc: "Dr" }), /totals exceed/);
    book = await store.addLedger(id, { name: "Sales", groupId: "g-sales", openingPaise: 0, openingDc: "Cr" });
    const sales = book.company.ledgers.find((ledger) => ledger.name === "Sales");
    const receipt = { type: "Receipt", date: "2026-04-02", number: "RCT-1", narration: "Small receipt", lines: [{ ledgerId: "l-cash", dc: "Dr", paise: 5 }, { ledgerId: sales.id, dc: "Cr", paise: 5 }] };
    book = await store.passVoucher(id, receipt);
    const saved = book.voucher;
    await assert.rejects(store.passVoucher(id, { ...receipt, lines: receipt.lines.map((line) => ({ ...line, paise: 11 })) }, saved.id), /totals exceed/);
    await assert.rejects(store.passVoucher(id, { ...receipt, number: "RCT-2", lines: receipt.lines.map((line) => ({ ...line, paise: 6 })) }), /totals exceed/);
    book = await store.addLedger(id, { name: "Expenses", groupId: "g-indirect-exp", openingPaise: 0, openingDc: "Dr" });
    const expense = book.company.ledgers.find((ledger) => ledger.name === "Expenses");
    await assert.rejects(store.updateLedger(id, expense.id, { name: expense.name, groupId: expense.groupId, openingPaise: 6, openingDc: "Dr" }), /totals exceed/);
    const result = await store.get(id);
    assert.equal(result.vouchers.length, 1);
    assert.equal(result.vouchers[0].lines[0].paise, 5);
    assert.equal(result.company.ledgers.some((ledger) => ledger.name === "Too Much Opening"), false);
    assert.equal(result.company.ledgers.find((ledger) => ledger.id === expense.id).opening.paise, 0);
  });
});

test("balanced maximum-safe openings remain supported", async () => {
  await withStore(async (store) => {
    const { company } = await store.create({ name: "Maximum Opening Book", booksFrom: "2026-04-01" });
    await store.updateLedger(company.id, "l-cash", { name: "Cash", groupId: "g-cash", openingPaise: Number.MAX_SAFE_INTEGER, openingDc: "Dr" });
    const book = await store.addLedger(company.id, { name: "Capital", groupId: "g-capital", openingPaise: Number.MAX_SAFE_INTEGER, openingDc: "Cr" });
    assert.equal(book.company.ledgers[0].opening.paise, Number.MAX_SAFE_INTEGER);
    const trial = trialBalance(book.company, book.vouchers, company.booksFrom, "2026-04-02");
    assert.equal(trial.difference, 0);
  });
});

test("an opening balance on a used ledger changes only with a reason, and the edit log keeps before and after", async () => {
  await withStore(async (store, dataDir) => {
    const { company } = await store.create({ name: "Opening Correction Book", booksFrom: "2026-04-01" });
    const id = company.id;
    await store.updateLedger(id, "l-cash", { name: "Cash", groupId: "g-cash", openingPaise: 50000, openingDc: "Dr" });
    let book = await store.addLedger(id, { name: "Capital", groupId: "g-capital", openingPaise: 50000, openingDc: "Cr" });
    const capital = book.company.ledgers.find((ledger) => ledger.name === "Capital");
    book = await store.addLedger(id, { name: "Sales", groupId: "g-sales", openingPaise: 0, openingDc: "Cr" });
    const sales = book.company.ledgers.find((ledger) => ledger.name === "Sales");
    await store.passVoucher(id, { type: "Receipt", date: "2026-04-02", number: "RCT-1", narration: "", lines: [{ ledgerId: "l-cash", dc: "Dr", paise: 1000 }, { ledgerId: sales.id, dc: "Cr", paise: 1000 }] });
    const cash = { name: "Cash", groupId: "g-cash", openingPaise: 62550, openingDc: "Dr" };
    await assert.rejects(store.updateLedger(id, "l-cash", cash), /only before a voucher uses this ledger\. Give a reason for the correction \(10 to 240 characters\) to change it now/);
    await assert.rejects(store.updateLedger(id, "l-cash", { ...cash, reason: "Too short" }), /10 to 240 characters/);
    await assert.rejects(store.updateLedger(id, "l-cash", { ...cash, reason: "x".repeat(241) }), /10 to 240 characters/);
    await assert.rejects(store.updateLedger(id, "l-cash", { ...cash, reason: 42 }), /10 to 240 characters/);
    book = await store.updateLedger(id, "l-cash", { ...cash, reason: "Cash count on 31-03-2026 was 625.50, not 500" });
    assert.deepEqual(book.company.ledgers.find((ledger) => ledger.id === "l-cash").opening, { dc: "Dr", paise: 62550 });
    // Balance-direction corrections are allowed with a reason as well.
    await store.updateLedger(id, capital.id, { name: "Capital", groupId: "g-capital", openingPaise: 62550, openingDc: "Cr", reason: "Capital introduced matches the corrected cash count" });
    const trial = trialBalance((await store.get(id)).company, (await store.get(id)).vouchers, "2026-04-01", "2026-04-30");
    assert.equal(trial.difference, 0);
    // A reason does not bypass the balance checks.
    await assert.rejects(store.updateLedger(id, "l-cash", { name: "Cash", groupId: "g-cash", openingPaise: Number.MAX_SAFE_INTEGER, openingDc: "Dr", reason: "Testing the supported amount limit" }), /totals exceed/);

    const log = (await readFile(path.join(dataDir, "companies", id, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const correction = log.find((entry) => entry.entity === "ledger" && entry.reason === "Cash count on 31-03-2026 was 625.50, not 500");
    assert.equal(correction.action, "alter");
    assert.equal(correction.id, "l-cash");
    assert.deepEqual(correction.before.opening, { dc: "Dr", paise: 50000 });
    assert.deepEqual(correction.after.opening, { dc: "Dr", paise: 62550 });
    assert.equal(correction.summary, "Ledger Cash altered: opening balance corrected from ₹500.00 Dr to ₹625.50 Dr. Reason: Cash count on 31-03-2026 was 625.50, not 500");
  });
});

test("HTTP ledger update accepts an opening-balance correction reason", async () => {
  await withStore(async (store, dataDir) => {
    const book = await store.specimen();
    const used = book.company.ledgers[0];
    const server = await start({ dataDir });
    const url = `http://127.0.0.1:${server.address().port}/api/companies/${book.company.id}/ledgers/${used.id}`;
    try {
      const put = (body) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const base = { name: used.name, groupId: used.groupId, openingPaise: used.opening.paise + 100, openingDc: used.opening.dc, expected: { name: used.name, groupId: used.groupId, opening: used.opening } };
      const refused = await put(base);
      assert.equal(refused.status, 400);
      assert.match((await refused.json()).error, /Give a reason for the correction/);
      const corrected = await put({ ...base, reason: "Opening balance confirmed by the bank certificate" });
      assert.equal(corrected.status, 200);
      assert.equal((await corrected.json()).company.ledgers.find((ledger) => ledger.id === used.id).opening.paise, used.opening.paise + 100);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});
