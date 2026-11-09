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

test("http books keep a verified edit log, honour a books lock and suggest numbers from the saved series", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "financer-http-controls-"));
  const server = await start({ port: 0, dataDir: dir });
  const base = `http://127.0.0.1:${server.address().port}/api/companies`;
  const call = async (route, method = "GET", body) => {
    const response = await fetch(base + route, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  try {
    const { body: created } = await call("", "POST", { name: "Controls Mills", booksFrom: "2026-04-01" });
    const id = created.company.id;
    const { body: withSales } = await call(`/${id}/ledgers`, "POST", { name: "Sales", groupId: "g-sales", openingPaise: 0, openingDc: "Cr" });
    const salesId = withSales.company.ledgers.find((ledger) => ledger.name === "Sales").id;
    const entry = (number, date) => ({ type: "Receipt", date, number, narration: "Counter", lines: [{ ledgerId: "l-cash", dc: "Dr", paise: 10000 }, { ledgerId: salesId, dc: "Cr", paise: 10000 }] });
    assert.equal((await call(`/${id}/vouchers`, "POST", entry("RCT-1", "2026-04-04"))).status, 201);
    assert.equal((await call(`/${id}/locks`, "PUT", { books: { to: "2026-04-30", reason: "April closed" } })).status, 200);
    const refused = await call(`/${id}/vouchers`, "POST", entry("RCT-2", "2026-04-20"));
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "The books are locked up to 30-04-2026 (April closed). Unlock them under Books settings to change this entry.");
    assert.equal((await call(`/${id}/vouchers`, "POST", entry("RCT-2", "2026-05-02"))).status, 201);
    const report = await call(`/${id}/reports/trial-balance?from=2026-04-01&to=2026-04-30`);
    assert.equal(report.body.credit, 10000);
    assert.equal((await call(`/${id}/numbering`, "PUT", { numbering: { Receipt: { prefix: "CR/", suffix: "/{fy}", width: 3, restartEachFY: true } } })).status, 200);
    const masters = await call(`/${id}/masters`);
    assert.match(masters.body.nextNumbers.Receipt, /^CR\/00\d\/\d{2}-\d{2}$/);
    const audit = await call(`/${id}/audit`);
    assert.equal(audit.body.verified, true);
    assert.deepEqual(audit.body.entries.map((row) => `${row.action}:${row.entity}`), ["alter:numbering", "create:voucher", "lock:lock", "create:voucher", "create:ledger", "create:company"]);
    assert.equal((await call(`/missing-company/audit`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("store.as(actor) names the user in the edit log; plain store calls record user null", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "financer-actor-"));
  const store = createStore(dir);
  try {
    const created = await store.create({ name: "Actor Book", booksFrom: "2026-04-01" });
    const id = created.company.id;
    const asha = { id: "u-asha", name: "Asha", role: "accountant" };
    const withRent = await store.as(asha).addLedger(id, { name: "Rent", groupId: "g-indirect-exp", openingPaise: 0, openingDc: "Dr" });
    assert.equal(withRent.ledger.name, "Rent");
    assert.equal(withRent.revision, 2);
    await store.as(null).addGroup(id, { name: "Branch costs", parentId: "g-indirect-exp" });
    const { entries } = await store.auditTrail(id, {});
    assert.deepEqual(entries.map((row) => [row.entity, row.user]), [["group", null], ["ledger", { id: "u-asha", name: "Asha" }], ["company", null]]);
    const filtered = await store.auditTrail(id, { user: "u-asha" });
    assert.deepEqual(filtered.entries.map((row) => row.entity), ["ledger"]);
    assert.equal(filtered.verified, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
