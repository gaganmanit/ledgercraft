import assert from "node:assert/strict";
import test from "node:test";
import { balanceSheet, dayBook, ledgerReport, PL_BROUGHT_FORWARD_ID, profitAndLoss, trialBalance } from "../lib/engine.js";
import { reservedGroups } from "../lib/groups.js";
import { groupSummary } from "../lib/report-tools.js";
import { ownerReview } from "../lib/review.js";

// Ledgers: cash (asset), capital, sales (income, gross), rent (indirect expense).
function book(booksFrom, openings = {}) {
  const ledger = (id, name, groupId, dc = "Dr") => ({ id, name, groupId, opening: { dc: openings[id]?.dc || dc, paise: openings[id]?.paise || 0 } });
  return {
    id: "fy-book",
    name: "FY Book",
    booksFrom,
    groups: reservedGroups(),
    ledgers: [
      ledger("l-cash", "Cash", "g-cash"),
      ledger("l-capital", "Capital", "g-capital", "Cr"),
      ledger("l-sales", "Sales", "g-sales", "Cr"),
      ledger("l-rent", "Rent", "g-indirect-exp"),
    ],
  };
}
let seq = 0;
const sale = (date, paise, number = `SAL-${++seq}`) => ({ id: `v-${++seq}`, type: "Sales", date, number, narration: "", lines: [{ ledgerId: "l-cash", dc: "Dr", paise }, { ledgerId: "l-sales", dc: "Cr", paise }] });
const rent = (date, paise, number = `PMT-${++seq}`) => ({ id: `v-${++seq}`, type: "Payment", date, number, narration: "", lines: [{ ledgerId: "l-rent", dc: "Dr", paise }, { ledgerId: "l-cash", dc: "Cr", paise }] });
const row = (trial, ledgerId) => trial.rows.find((item) => item.ledgerId === ledgerId);

// FY 2024-25: sales 1,000, rent 300 => profit 700. FY 2025-26: sales 500, rent 100 => profit 400.
function twoYears() {
  const company = book("2024-04-01", { "l-cash": { dc: "Dr", paise: 1_000_000 }, "l-capital": { dc: "Cr", paise: 1_000_000 } });
  const vouchers = [
    sale("2024-05-10", 100_000), rent("2024-06-01", 30_000),
    sale("2025-04-15", 20_000), sale("2025-07-01", 30_000), rent("2025-08-01", 10_000),
  ];
  return { company, vouchers };
}

test("second-year trial balance resets income and expense and carries earlier profit as one capital row", () => {
  const { company, vouchers } = twoYears();
  const trial = trialBalance(company, vouchers, "2025-04-01", "2026-03-31");
  assert.equal(trial.difference, 0);
  assert.deepEqual(row(trial, "l-sales").opening, { dc: "Dr", paise: 0 });
  assert.deepEqual(row(trial, "l-sales").closing, { dc: "Cr", paise: 50_000 });
  assert.deepEqual(row(trial, "l-rent").opening, { dc: "Dr", paise: 0 });
  assert.deepEqual(row(trial, "l-rent").closing, { dc: "Dr", paise: 10_000 });
  const carried = row(trial, PL_BROUGHT_FORWARD_ID);
  assert.equal(carried.name, "Profit & loss account (brought forward)");
  assert.equal(carried.groupId, "g-capital");
  assert.equal(carried.synthetic, true);
  assert.deepEqual(carried.opening, { dc: "Cr", paise: 70_000 });
  assert.deepEqual(carried.closing, { dc: "Cr", paise: 70_000 });
  assert.equal(carried.periodDr + carried.periodCr, 0);
  // Balance-sheet ledgers still carry everything before the period.
  assert.deepEqual(row(trial, "l-cash").opening, { dc: "Dr", paise: 1_070_000 });
  // The first year has no earlier profit to carry.
  const first = trialBalance(company, vouchers, "2024-04-01", "2025-03-31");
  assert.equal(row(first, PL_BROUGHT_FORWARD_ID), undefined);
  assert.equal(first.difference, 0);
});

test("a mid-year period keeps this year's earlier income and expense in the opening column", () => {
  const { company, vouchers } = twoYears();
  const trial = trialBalance(company, vouchers, "2025-06-01", "2025-09-30");
  assert.equal(trial.difference, 0);
  assert.deepEqual(row(trial, "l-sales").opening, { dc: "Cr", paise: 20_000 });
  assert.deepEqual(row(trial, "l-sales").closing, { dc: "Cr", paise: 50_000 });
  assert.deepEqual(row(trial, PL_BROUGHT_FORWARD_ID).opening, { dc: "Cr", paise: 70_000 });
  const ledger = ledgerReport(company, vouchers, "l-sales", "2025-06-01", "2025-09-30");
  assert.deepEqual(ledger.opening, { dc: "Cr", paise: 20_000 });
  assert.deepEqual(ledger.closing, { dc: "Cr", paise: 50_000 });
});

test("second-year P&L equals second-year movements and the balance sheet splits retained and current profit", () => {
  const { company, vouchers } = twoYears();
  const pl = profitAndLoss(company, vouchers, "2025-04-01", "2026-03-31");
  assert.equal(pl.netProfit, 40_000);
  const sheet = balanceSheet(company, vouchers, "2026-03-31");
  assert.equal(sheet.retainedProfit, 70_000);
  assert.equal(sheet.currentProfit, 40_000);
  assert.equal(sheet.profit, 40_000);
  assert.equal(sheet.difference, 0);
  const capital = sheet.liabilityGroups.find((group) => group.groupName === "Capital Account");
  const carried = capital.ledgers.find((item) => item.ledgerId === PL_BROUGHT_FORWARD_ID);
  assert.equal(carried.paise, 70_000);
  assert.equal(carried.name, "Profit & loss account (brought forward)");
  assert.equal(capital.total, 1_070_000);
  // Within the first year nothing is brought forward.
  const firstSheet = balanceSheet(company, vouchers, "2025-03-31");
  assert.equal(firstSheet.retainedProfit, 0);
  assert.equal(firstSheet.profit, 70_000);
  assert.equal(firstSheet.difference, 0);
  // The current-FY profit on the sheet equals the FY P&L to the same date.
  const mid = balanceSheet(company, vouchers, "2025-07-31");
  assert.equal(mid.currentProfit, profitAndLoss(company, vouchers, "2025-04-01", "2025-07-31").netProfit);
  assert.equal(mid.difference, 0);
});

test("second-year ledger report of a revenue ledger opens at nil and the carried row has its own ledger view", () => {
  const { company, vouchers } = twoYears();
  const sales = ledgerReport(company, vouchers, "l-sales", "2025-04-01", "2026-03-31");
  assert.deepEqual(sales.opening, { dc: "Dr", paise: 0 });
  assert.deepEqual(sales.closing, { dc: "Cr", paise: 50_000 });
  assert.equal(sales.lines.length, 2);
  const carried = ledgerReport(company, vouchers, PL_BROUGHT_FORWARD_ID, "2025-04-01", "2026-03-31");
  assert.equal(carried.ledger.name, "Profit & loss account (brought forward)");
  assert.equal(carried.ledger.synthetic, true);
  assert.deepEqual(carried.opening, { dc: "Cr", paise: 70_000 });
  assert.deepEqual(carried.closing, { dc: "Cr", paise: 70_000 });
  assert.deepEqual(carried.lines, []);
  // Rent (an expense) behaves the same way.
  assert.deepEqual(ledgerReport(company, vouchers, "l-rent", "2025-04-01", "2026-03-31").opening, { dc: "Dr", paise: 0 });
});

test("an earlier-year loss is carried as a debit row and appears on the asset side", () => {
  const company = book("2024-04-01", { "l-cash": { dc: "Dr", paise: 1_000_000 }, "l-capital": { dc: "Cr", paise: 1_000_000 } });
  const vouchers = [sale("2024-05-10", 10_000), rent("2024-06-01", 40_000), sale("2025-05-01", 5_000)];
  const trial = trialBalance(company, vouchers, "2025-04-01", "2026-03-31");
  assert.equal(trial.difference, 0);
  assert.deepEqual(row(trial, PL_BROUGHT_FORWARD_ID).opening, { dc: "Dr", paise: 30_000 });
  const sheet = balanceSheet(company, vouchers, "2026-03-31");
  assert.equal(sheet.retainedProfit, -30_000);
  assert.equal(sheet.profit, 5_000);
  assert.equal(sheet.difference, 0);
  const asset = sheet.assetGroups.flatMap((group) => group.ledgers).find((item) => item.ledgerId === PL_BROUGHT_FORWARD_ID);
  assert.equal(asset.paise, 30_000);
});

test("three financial years carry the cumulative earlier profit", () => {
  const { company, vouchers } = twoYears();
  vouchers.push(sale("2026-04-02", 7_000));
  const trial = trialBalance(company, vouchers, "2026-04-01", "2027-03-31");
  assert.equal(trial.difference, 0);
  assert.deepEqual(row(trial, PL_BROUGHT_FORWARD_ID).opening, { dc: "Cr", paise: 110_000 });
  assert.deepEqual(row(trial, "l-sales").opening, { dc: "Dr", paise: 0 });
  const sheet = balanceSheet(company, vouchers, "2027-03-31");
  assert.equal(sheet.retainedProfit, 110_000);
  assert.equal(sheet.profit, 7_000);
  assert.equal(sheet.difference, 0);
  // Group summary rolls the carried row into Capital Account.
  const capital = groupSummary(company, vouchers, "2026-04-01", "2027-03-31", "g-capital");
  assert.equal(capital.credit, 1_110_000);
  // The owner review reports the period's own profit and a balanced book.
  const review = ownerReview(company, vouchers, "2026-04-01", "2027-03-31");
  assert.equal(review.netProfit, 7_000);
  assert.equal(review.difference, 0);
});

// Mid-year migration: books begin 1 Oct 2025 with income and expense already earned that year.
function migrated() {
  const company = book("2025-10-01", {
    "l-cash": { dc: "Dr", paise: 500_000 },
    "l-sales": { dc: "Cr", paise: 800_000 },
    "l-rent": { dc: "Dr", paise: 300_000 },
  });
  return { company, vouchers: [sale("2025-11-01", 100_000)] };
}

test("a P&L that starts at the books beginning includes income and expense openings and agrees with the balance sheet", () => {
  const { company, vouchers } = migrated();
  const pl = profitAndLoss(company, vouchers, "2025-10-01", "2026-03-31");
  assert.equal(pl.netProfit, 600_000);
  const sales = pl.lines.find((line) => line.ledgerId === "l-sales");
  assert.deepEqual(sales.opening, { dc: "Cr", paise: 800_000 });
  assert.equal(sales.signed, 900_000);
  assert.equal(sales.cr, 100_000);
  const rentLine = pl.lines.find((line) => line.ledgerId === "l-rent");
  assert.deepEqual(rentLine.opening, { dc: "Dr", paise: 300_000 });
  assert.equal(rentLine.signed, -300_000);
  const sheet = balanceSheet(company, vouchers, "2026-03-31");
  assert.equal(sheet.profit, pl.netProfit);
  assert.equal(sheet.retainedProfit, 0);
  assert.equal(sheet.difference, 0);
  const trial = trialBalance(company, vouchers, "2025-10-01", "2026-03-31");
  assert.equal(trial.difference, 0);
  assert.equal(row(trial, PL_BROUGHT_FORWARD_ID), undefined);
});

test("a later P&L period excludes the openings and the next year carries them as retained profit", () => {
  const { company, vouchers } = migrated();
  const later = profitAndLoss(company, vouchers, "2025-11-01", "2026-03-31");
  assert.equal(later.netProfit, 100_000);
  assert.equal(later.lines.find((line) => line.ledgerId === "l-rent"), undefined);
  assert.equal(later.lines.find((line) => line.ledgerId === "l-sales").opening, undefined);
  const trial = trialBalance(company, vouchers, "2025-11-01", "2026-03-31");
  assert.deepEqual(row(trial, "l-sales").opening, { dc: "Cr", paise: 800_000 });
  assert.equal(trial.difference, 0);
  const next = trialBalance(company, vouchers, "2026-04-01", "2026-06-30");
  assert.deepEqual(row(next, PL_BROUGHT_FORWARD_ID).opening, { dc: "Cr", paise: 600_000 });
  assert.equal(row(next, "l-rent"), undefined);
  assert.equal(next.difference, 0);
  const sheet = balanceSheet(company, vouchers, "2026-06-30");
  assert.equal(sheet.retainedProfit, 600_000);
  assert.equal(sheet.profit, 0);
  assert.equal(sheet.difference, 0);
  assert.deepEqual(ledgerReport(company, vouchers, "l-sales", "2026-04-01", "2026-06-30").opening, { dc: "Dr", paise: 0 });
});

test("same-day vouchers sort by their numbers naturally in the day book and ledger", () => {
  const { company } = twoYears();
  const vouchers = [sale("2025-04-05", 1_000, "RCT-10"), sale("2025-04-05", 2_000, "RCT-9"), sale("2025-04-05", 3_000, "RCT-100"), sale("2025-04-04", 4_000, "RCT-11")];
  assert.deepEqual(dayBook(company, vouchers, "2025-04-01", "2025-04-30").map((item) => item.number), ["RCT-11", "RCT-9", "RCT-10", "RCT-100"]);
  const ledger = ledgerReport(company, vouchers, "l-cash", "2025-04-01", "2025-04-30");
  assert.deepEqual(ledger.lines.map((line) => line.number), ["RCT-11", "RCT-9", "RCT-10", "RCT-100"]);
  assert.deepEqual(ledger.lines.map((line) => line.balance.paise), [1_004_000, 1_006_000, 1_007_000, 1_010_000]);
});
