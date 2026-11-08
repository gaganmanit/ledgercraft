import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { balanceSheet, profitAndLoss, trialBalance } from "../lib/engine.js";
import { formatINR, parseRupees } from "../lib/money.js";
import { buildSpecimen } from "../lib/specimen.js";
import { createStore } from "../lib/store.js";
import { start } from "../server.js";

test("indian grouping keeps paise", () => {
  assert.equal(formatINR(0), "0.00");
  assert.equal(formatINR(10000000), "1,00,000.00");
  assert.equal(formatINR(123456789), "12,34,567.89");
  assert.equal(parseRupees("1,00,000.50"), 10000050);
  assert.throws(() => parseRupees("10.999"), /rupees/);
});

test("specimen books balance and earn 2,000", () => {
  const { company, vouchers } = buildSpecimen(new Date("2026-11-07T10:00:00"));
  const to = "2026-11-07";
  const trial = trialBalance(company, vouchers, company.booksFrom, to);
  const sheet = balanceSheet(company, vouchers, to);
  const profit = profitAndLoss(company, vouchers, company.booksFrom, to);
  assert.equal(trial.difference, 0);
  assert.equal(sheet.difference, 0);
  assert.equal(profit.grossProfit, 1_000_000);
  assert.equal(profit.netProfit, 200_000);
  assert.equal(sheet.profit, 200_000);
  assert.equal(formatINR(sheet.assetTotal), "2,67,000.00");
});

test("a later voucher stays out of a closed period", () => {
  const { company, vouchers } = buildSpecimen(new Date("2026-11-07T10:00:00"));
  const early = profitAndLoss(company, vouchers, company.booksFrom, "2026-04-07");
  assert.equal(early.netProfit, 2_500_000);
});

test("voucher rules reject an unbalanced payment and a contra into rent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "financer-"));
  const store = createStore(dir);
  try {
    const created = await store.create({ name: "Rule Book", booksFrom: "2026-04-01" });
    const cash = created.company.ledgers[0].id;
    await assert.rejects(
      () =>
        store.passVoucher(created.company.id, {
          type: "Payment",
          date: "2026-04-02",
          number: "PMT-1",
          lines: [
            { ledgerId: cash, dc: "Dr", paise: 100 },
            { ledgerId: cash, dc: "Cr", paise: 50 },
          ],
        }),
      /do not match/,
    );
    const withRent = await store.addLedger(created.company.id, {
      name: "Rent",
      groupId: "g-indirect-exp",
      openingPaise: 0,
      openingDc: "Dr",
    });
    const rent = withRent.company.ledgers.find((ledger) => ledger.name === "Rent").id;
    await assert.rejects(
      () =>
        store.passVoucher(created.company.id, {
          type: "Sales",
          date: "2026-04-02",
          number: "SAL-1",
          lines: [
            { ledgerId: cash, dc: "Dr", paise: 100 },
            { ledgerId: cash, dc: "Cr", paise: 100 },
          ],
        }),
      /income ledger/,
    );
    await assert.rejects(
      () =>
        store.passVoucher(created.company.id, {
          type: "Contra",
          date: "2026-04-02",
          number: "CTR-1",
          lines: [
            { ledgerId: rent, dc: "Dr", paise: 100 },
            { ledgerId: cash, dc: "Cr", paise: 100 },
          ],
        }),
      /cash and bank/,
    );
    const passed = await store.passVoucher(created.company.id, {
      type: "Payment",
      date: "2026-04-02",
      number: "PMT-1",
      narration: "Rent",
      lines: [
        { ledgerId: rent, dc: "Dr", paise: 100 },
        { ledgerId: cash, dc: "Cr", paise: 100 },
      ],
    });
    assert.equal(passed.voucher.lines.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("http books round-trip", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "financer-http-"));
  const server = await start({ port: 0, dataDir: dir });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Ledgercraft/);
    const created = await fetch(`${base}/api/companies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "HTTP Mills", booksFrom: "2026-04-01" }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    const id = body.company.id;
    const sales = await fetch(`${base}/api/companies/${id}/ledgers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Sales", groupId: "g-sales", openingPaise: 0, openingDc: "Cr" }),
    });
    const salesBody = await sales.json();
    const cash = salesBody.company.ledgers.find((ledger) => ledger.name === "Cash").id;
    const salesId = salesBody.company.ledgers.find((ledger) => ledger.name === "Sales").id;
    const passed = await fetch(`${base}/api/companies/${id}/vouchers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "Receipt",
        date: "2026-04-04",
        number: "RCT-1",
        narration: "Counter",
        lines: [
          { ledgerId: cash, dc: "Dr", paise: 50000 },
          { ledgerId: salesId, dc: "Cr", paise: 50000 },
        ],
      }),
    });
    assert.equal(passed.status, 201);
    const trial = await fetch(`${base}/api/companies/${id}/reports/trial-balance?from=2026-04-01&to=2026-04-30`);
    const trialBody = await trial.json();
    assert.equal(trialBody.difference, 0);
    assert.equal(trialBody.credit, 50000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
