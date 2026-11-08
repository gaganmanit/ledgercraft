import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nextNumbers as legacyNextNumbers } from "../lib/groups.js";
import { checkedSeries, fyToken, formatNumber, nextNumberFor, nextNumbers, trailingCounter } from "../lib/numbering.js";
import { buildSpecimen } from "../lib/specimen.js";
import { createStore } from "../lib/store.js";
import { companyBackup, validateTransfer } from "../lib/transfer.js";
import { start } from "../server.js";

async function withStore(run) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ledgercraft-numbering-"));
  try { await run(createStore(dataDir), dataDir); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}

const voucher = (type, number, date, id = `v-${number}-${date}`) => ({ id, type, number, date, narration: "", lines: [] });
const receipt = (income, number, date) => ({ type: "Receipt", date, number, narration: "Counter", lines: [{ ledgerId: "l-cash", dc: "Dr", paise: 100 }, { ledgerId: income, dc: "Cr", paise: 100 }] });

test("default series reproduce the original suggestions", () => {
  const company = { booksFrom: "2026-04-01" };
  assert.deepEqual(nextNumbers(company, [], "2026-04-01"), {
    Payment: "PMT-1", Receipt: "RCT-1", Contra: "CTR-1", Journal: "JRN-1", Sales: "SAL-1", Purchase: "PUR-1", "Debit Note": "DBN-1", "Credit Note": "CRN-1",
  });
  const { company: specimen, vouchers } = buildSpecimen(new Date("2026-11-07T10:00:00"));
  assert.deepEqual(nextNumbers(specimen, vouchers, "2026-11-07"), legacyNextNumbers(vouchers));
  const many = [voucher("Receipt", "RCT-9", "2026-04-02"), voucher("Receipt", "RCT-10", "2026-04-03"), voucher("Payment", "77", "2026-04-03")];
  assert.deepEqual(nextNumbers(company, many, "2026-04-04"), legacyNextNumbers(many));
});

test("financial-year suffixed numbers continue from their trailing counter", () => {
  assert.equal(trailingCounter("INV/26-27/0012"), 12);
  assert.equal(trailingCounter("SAL-5/26-27"), 5);
  assert.equal(trailingCounter("SAL-7-2026-27"), 7);
  assert.equal(trailingCounter("RCT-12"), 12);
  assert.equal(trailingCounter("2026-27"), 27);
  assert.equal(trailingCounter("PMT-10-12"), 12);
  assert.equal(trailingCounter("No digits"), null);
  const company = { booksFrom: "2026-04-01" };
  assert.equal(nextNumberFor(company, [voucher("Sales", "INV/26-27/0012", "2026-05-01")], "Sales", "2026-05-02"), "SAL-13");
  assert.equal(nextNumberFor(company, [voucher("Sales", "SAL-5/26-27", "2026-05-01")], "Sales", "2026-05-02"), "SAL-6");
  assert.equal(fyToken("2026-04-01"), "26-27");
  assert.equal(fyToken("2027-03-31"), "26-27");
  assert.equal(fyToken("2099-12-31"), "99-00");
  assert.equal(formatNumber({ prefix: "INV/{fy}/", suffix: "", width: 4 }, 12, "2026-06-01"), "INV/26-27/0012");
});

test("a yearly series restarts at the financial-year rollover and keeps numbers unique within each year", () => {
  const company = { booksFrom: "2026-04-01", numbering: { Sales: { prefix: "INV/", suffix: "/{fy}", width: 4, restartEachFY: true } } };
  const vouchers = [voucher("Sales", "INV/0001/26-27", "2026-04-02"), voucher("Sales", "INV/0002/26-27", "2027-03-31")];
  assert.equal(nextNumberFor(company, vouchers, "Sales", "2027-03-31"), "INV/0003/26-27");
  assert.equal(nextNumberFor(company, vouchers, "Sales", "2027-04-01"), "INV/0001/27-28");
  vouchers.push(voucher("Sales", "INV/0001/27-28", "2027-04-01"));
  assert.equal(nextNumberFor(company, vouchers, "Sales", "2027-04-02"), "INV/0002/27-28");
  // A series without the year in the number repeats its numbers each year.
  const plain = { booksFrom: "2026-04-01", numbering: { Receipt: { prefix: "R-", suffix: "", width: 0, restartEachFY: true } } };
  assert.equal(nextNumberFor(plain, [voucher("Receipt", "R-1", "2026-04-02"), voucher("Receipt", "R-2", "2026-07-02")], "Receipt", "2027-04-01"), "R-1");
});

test("a book with mixed numbers continues the configured series without clashing", () => {
  const mixed = [voucher("Receipt", "RCT-1", "2026-04-02"), voucher("Receipt", "RCT-2", "2026-04-03"), voucher("Receipt", "R/0050", "2026-04-04"), voucher("Receipt", "Counter", "2026-04-05")];
  const company = { booksFrom: "2026-04-01" };
  // Default series keep the original rule: after the highest number of the type.
  assert.equal(nextNumberFor(company, mixed, "Receipt", "2026-04-06"), "RCT-51");
  // A configured series follows its own numbers and pads them.
  const configured = { ...company, numbering: { Receipt: { prefix: "RCT-", suffix: "", width: 3, restartEachFY: false } } };
  assert.equal(nextNumberFor(configured, mixed, "Receipt", "2026-04-06"), "RCT-003");
  // A new series with no numbers yet continues after the highest number.
  const fresh = { ...company, numbering: { Receipt: { prefix: "CR/{fy}/", suffix: "", width: 4, restartEachFY: false } } };
  assert.equal(nextNumberFor(fresh, mixed, "Receipt", "2026-04-06"), "CR/26-27/0051");
  // A floor set with `next` lifts the counter.
  const floored = { ...company, numbering: { Receipt: { prefix: "RCT-", suffix: "", width: 0, restartEachFY: false, next: 500 } } };
  assert.equal(nextNumberFor(floored, mixed, "Receipt", "2026-04-06"), "RCT-500");
  // Never suggest a number that already exists.
  const taken = [voucher("Receipt", "RCT-003", "2026-04-02"), voucher("Receipt", "RCT-2", "2026-04-02")];
  assert.equal(nextNumberFor(configured, taken, "Receipt", "2026-04-06"), "RCT-004");
});

test("numbering settings are validated", () => {
  assert.deepEqual(checkedSeries("Sales", { prefix: "INV/{fy}/", suffix: "", width: 4, restartEachFY: true }), { prefix: "INV/{fy}/", suffix: "", width: 4, restartEachFY: true });
  assert.throws(() => checkedSeries("Sales", { prefix: "ABCDEFGHIJKLM" }), /prefix can be up to 12 characters/);
  assert.throws(() => checkedSeries("Sales", { prefix: "INV#" }), /letters, digits, \/ and -/);
  assert.throws(() => checkedSeries("Sales", { suffix: "A B" }), /suffix can use letters/);
  assert.throws(() => checkedSeries("Sales", { width: 9 }), /width is a whole number from 0 to 8/);
  assert.throws(() => checkedSeries("Sales", { width: 1.5 }), /width/);
  assert.throws(() => checkedSeries("Sales", { restartEachFY: "yes" }), /restart each financial year/);
  assert.throws(() => checkedSeries("Sales", { next: 0 }), /next number/);
  assert.throws(() => checkedSeries("Payroll", {}), /Unknown voucher type/);
  assert.throws(() => checkedSeries("Sales", { prefix: "{fy}{fy}{fy}", suffix: "{fy}{fy}{fy}", width: 8 }), /too little room/);
});

test("saved numbering drives suggestions, per-year uniqueness, the HTTP routes and the edit log", async () => {
  await withStore(async (store, dataDir) => {
    const { company } = await store.create({ name: "Numbering Book", booksFrom: "2026-04-01" });
    const id = company.id;
    const book = await store.addLedger(id, { name: "Sales", groupId: "g-sales", openingPaise: 0, openingDc: "Cr" });
    const sales = book.company.ledgers.find((ledger) => ledger.name === "Sales").id;
    await store.passVoucher(id, receipt(sales, "R-1", "2026-05-01"));
    // Default series: numbers are unique across years.
    await assert.rejects(store.passVoucher(id, receipt(sales, "R-1", "2027-05-01")), /already used for this type/);
    const server = await start({ dataDir });
    const base = `http://127.0.0.1:${server.address().port}/api/companies/${id}`;
    const call = async (route, method = "GET", body) => {
      const response = await fetch(base + route, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    };
    try {
      let view = await call("/numbering?date=2026-06-01");
      assert.equal(view.status, 200);
      assert.deepEqual(view.body.numbering.Receipt, { prefix: "RCT-", suffix: "", width: 0, restartEachFY: false });
      assert.equal(view.body.preview.Receipt, "RCT-2");
      assert.equal(view.body.date, "2026-06-01");
      const bad = await call("/numbering", "PUT", { numbering: { Receipt: { prefix: "R#", width: 0 } } });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, "Receipt: the prefix can use letters, digits, / and -, and the {fy} token");
      const saved = await call("/numbering", "PUT", { numbering: { Receipt: { prefix: "R-", suffix: "", width: 0, restartEachFY: true } }, requestId: "numbering-save-receipt-01", expected: view.body.numbering });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.replayed, false);
      assert.deepEqual(saved.body.numbering.Receipt, { prefix: "R-", suffix: "", width: 0, restartEachFY: true });
      assert.deepEqual(saved.body.numbering.Payment, { prefix: "PMT-", suffix: "", width: 0, restartEachFY: false });
      assert.equal((await call("/numbering", "PUT", { numbering: { Receipt: { prefix: "R-", suffix: "", width: 0, restartEachFY: true } } })).body.replayed, true);
      const stale = await call("/numbering", "PUT", { numbering: { Receipt: { prefix: "Q-" } }, expected: view.body.numbering });
      assert.equal(stale.status, 400);
      assert.match(stale.body.error, /numbering changed while you were editing/);
      view = await call("/numbering?date=2027-04-01");
      assert.equal(view.body.preview.Receipt, "R-1");
      assert.equal((await call("/numbering?date=2026-06-01")).body.preview.Receipt, "R-2");
    } finally { await new Promise((resolve) => server.close(resolve)); }

    // Per-year uniqueness once the series restarts each year.
    await store.passVoucher(id, receipt(sales, "R-1", "2027-05-01"));
    await assert.rejects(store.passVoucher(id, receipt(sales, "R-1", "2027-06-01")), /already used for this type/);
    await assert.rejects(store.setNumbering(id, { numbering: { Receipt: { prefix: "R-", restartEachFY: false } } }), /Receipt number R-1 is used in more than one financial year/);
    const current = await store.get(id);
    assert.match(current.nextNumbers.Receipt, /^R-\d+$/);
    // Backups keep the setting and the per-year rule.
    const restored = validateTransfer(companyBackup(current.company, current.vouchers));
    assert.equal(restored.company.numbering.Receipt.restartEachFY, true);
    assert.throws(() => validateTransfer(companyBackup({ ...current.company, numbering: undefined }, current.vouchers)), /already used for this type/);
    assert.throws(() => validateTransfer(companyBackup({ ...current.company, numbering: { Receipt: { prefix: "R#", suffix: "", width: 0, restartEachFY: true } } }, current.vouchers)), /prefix can use/);

    const log = (await readFile(path.join(dataDir, "companies", id, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const numbering = log.filter((entry) => entry.entity === "numbering");
    assert.equal(numbering.length, 1);
    assert.equal(numbering[0].action, "alter");
    assert.equal(numbering[0].id, "Receipt");
    assert.equal(numbering[0].requestId, "numbering-save-receipt-01");
    assert.deepEqual(numbering[0].before, { prefix: "RCT-", suffix: "", width: 0, restartEachFY: false });
    assert.deepEqual(numbering[0].after, { prefix: "R-", suffix: "", width: 0, restartEachFY: true });
    assert.match(numbering[0].summary, /^Receipt numbering changed; the next number is R-\d+\.$/);
  });
});
