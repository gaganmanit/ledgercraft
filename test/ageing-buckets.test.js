import assert from "node:assert/strict";
import test from "node:test";
import { ageBuckets, bucketRanges, companyAgeing, partyAgeing, sumBuckets } from "../lib/ageing.js";
import { emptyCashLedger, reservedGroups } from "../lib/groups.js";
import { mutateReconciliation } from "../lib/reconciliation.js";
import { ownerReview } from "../lib/review.js";

const AS_OF = "2026-07-31";
const minus = (days) => new Date(Date.parse(`${AS_OF}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
const paiseOf = (result) => Object.fromEntries(result.buckets.map((row) => [row.label, row.paise]));

function book() {
  const company = {
    id: "ageing-test", name: "Ageing Test Traders", booksFrom: "2026-04-01", groups: reservedGroups(),
    ledgers: [
      { ...emptyCashLedger(), opening: { dc: "Dr", paise: 10_000_000 } },
      { id: "l-sales", name: "Sales", groupId: "g-sales", opening: { dc: "Cr", paise: 0 } },
      { id: "l-purchase", name: "Purchases", groupId: "g-purchase", opening: { dc: "Dr", paise: 0 } },
      { id: "l-customer", name: "Customer A", groupId: "g-debtors", opening: { dc: "Dr", paise: 0 } },
      { id: "l-supplier", name: "Supplier MSME", groupId: "g-creditors", opening: { dc: "Cr", paise: 0 }, msme: true },
      { id: "l-trader", name: "Supplier Trader", groupId: "g-creditors", opening: { dc: "Cr", paise: 0 } },
    ],
  };
  const vouchers = [];
  let serial = 0;
  const post = (type, date, dr, cr, paise) => {
    const voucher = { id: `v-${++serial}`, type, date, number: `${type.slice(0, 3).toUpperCase()}-${serial}`, narration: "", lines: [{ ledgerId: dr, dc: "Dr", paise }, { ledgerId: cr, dc: "Cr", paise }] };
    vouchers.push(voucher);
    return voucher;
  };
  return { company, vouchers, post };
}

test("bucket ranges follow the requested day limits and reject unordered limits", () => {
  assert.deepEqual(bucketRanges().map((row) => [row.label, row.from, row.to]), [
    ["current", null, 0], ["1-30", 1, 30], ["31-60", 31, 60], ["61-90", 61, 90], ["91-180", 91, 180], ["over180", 181, null],
  ]);
  assert.deepEqual(bucketRanges([15, 45]).map((row) => row.label), ["current", "1-15", "16-45", "over45"]);
  assert.throws(() => bucketRanges([30, 30]), /ageing/);
  assert.throws(() => bucketRanges([0, 30]), /ageing/);
  assert.throws(() => bucketRanges([]), /ageing/);
});

test("ageing arithmetic places every bucket edge on the correct side", () => {
  const days = [-5, 0, 1, 30, 31, 60, 61, 90, 91, 180, 181, 400];
  const entries = days.map((day, index) => ({ dueDate: minus(day), paise: 100 * (index + 1) }));
  const result = ageBuckets(entries, AS_OF);
  assert.deepEqual(paiseOf(result), {
    current: 100 + 200, "1-30": 300 + 400, "31-60": 500 + 600, "61-90": 700 + 800,
    "91-180": 900 + 1000, over180: 1100 + 1200,
  });
  assert.equal(result.total, entries.reduce((sum, entry) => sum + entry.paise, 0));
  // Entries without a due date age from their own date; custom limits change the edges.
  const custom = ageBuckets([{ date: minus(15), paise: 7 }, { date: minus(16), paise: 11 }, { date: minus(46), paise: 13 }], AS_OF, [15, 45]);
  assert.deepEqual(paiseOf(custom), { current: 0, "1-15": 7, "16-45": 11, over45: 13 });
  assert.equal(ageBuckets([], AS_OF).total, 0);
  assert.throws(() => ageBuckets([{ dueDate: "2026-02-30", paise: 1 }], AS_OF), /date/);
  assert.throws(() => ageBuckets([{ dueDate: AS_OF, paise: 0.5 }], AS_OF), /paise/);
  assert.deepEqual(sumBuckets([result.buckets, result.buckets]).map((row) => row.paise), result.buckets.map((row) => row.paise * 2));
});

test("date-based ageing applies receipts to the oldest bills first and honours party credit days", () => {
  const { company, vouchers, post } = book();
  post("Sales", "2026-04-10", "l-customer", "l-sales", 10_000);
  post("Sales", "2026-06-01", "l-customer", "l-sales", 5_000);
  post("Receipt", "2026-06-15", "l-cash", "l-customer", 4_000);
  let result = partyAgeing(company, vouchers, "l-customer", AS_OF);
  assert.equal(result.side, "receivable");
  assert.equal(result.creditDays, 0);
  assert.deepEqual(paiseOf(result), { current: 0, "1-30": 0, "31-60": 5_000, "61-90": 0, "91-180": 6_000, over180: 0 });
  assert.equal(result.total, 11_000);
  assert.equal(result.netPaise, 11_000);
  assert.equal(result.advancePaise, 0);
  assert.equal(result.oldestDate, "2026-04-10");
  assert.equal(result.overduePaise, 11_000);
  assert.equal(result.msmeOverduePaise, 0);
  // Party credit days come from the linked GST party and shift every due date.
  company.gst = { version: 1, registrations: [], parties: [{ id: "p-a", name: "Customer A", customerLedgerId: "l-customer", supplierLedgerId: "l-trader", creditDays: 30 }], items: [] };
  result = partyAgeing(company, vouchers, "l-customer", AS_OF);
  assert.equal(result.creditDays, 30);
  assert.deepEqual(paiseOf(result), { current: 0, "1-30": 5_000, "31-60": 0, "61-90": 6_000, "91-180": 0, over180: 0 });
  assert.equal(result.overduePaise, 6_000);
  assert.deepEqual(result.items.filter((item) => item.openPaise).map((item) => [item.date, item.dueDate, item.days]), [["2026-04-10", "2026-05-10", 82], ["2026-06-01", "2026-07-01", 30]]);
  // A receipt beyond every open bill is reported as an advance, not a negative bucket.
  post("Receipt", "2026-07-20", "l-cash", "l-customer", 12_000);
  result = partyAgeing(company, vouchers, "l-customer", AS_OF);
  assert.equal(result.total, 0);
  assert.equal(result.advancePaise, 1_000);
  assert.equal(result.netPaise, -1_000);
  assert.equal(result.oldestDate, null);
  // Entries after the ageing date are ignored.
  assert.equal(partyAgeing(company, vouchers, "l-customer", "2026-06-10").total, 15_000);
  assert.throws(() => partyAgeing(company, vouchers, "l-sales", AS_OF), /sundry debtor/);
});

test("bill-wise references age by their due date while unreferenced entries age by voucher date", () => {
  const { company, vouchers, post } = book();
  const first = post("Sales", "2026-04-10", "l-customer", "l-sales", 10_000);
  post("Sales", "2026-06-01", "l-customer", "l-sales", 5_000);
  const receipt = post("Receipt", "2026-06-15", "l-cash", "l-customer", 4_000);
  const saved = mutateReconciliation(null, { company, vouchers }, "save-bill", { revision: 0, requestId: "ageing-bill-0000000001", ledgerId: "l-customer", sourceKey: `${first.id}:l-customer`, reference: "INV-A", dueDate: "2026-07-20", amountPaise: 10_000 });
  company.reconciliation = saved.section;
  let result = partyAgeing(company, vouchers, "l-customer", AS_OF);
  // The unallocated receipt settles the oldest due item, the unreferenced June sale.
  assert.deepEqual(paiseOf(result), { current: 0, "1-30": 10_000, "31-60": 1_000, "61-90": 0, "91-180": 0, over180: 0 });
  const bill = result.items.find((item) => item.billWise);
  assert.deepEqual([bill.reference, bill.dueDate, bill.days, bill.openPaise], ["INV-A", "2026-07-20", 11, 10_000]);
  assert.equal(result.oldestDate, "2026-04-10");
  // Allocating the receipt to the bill reduces that bill instead.
  const allocated = mutateReconciliation(company.reconciliation, { company, vouchers }, "allocate-bill", { revision: 1, requestId: "ageing-bill-0000000002", ledgerId: "l-customer", billId: saved.result.id, creditKey: `${receipt.id}:l-customer`, date: "2026-06-15", paise: 4_000 });
  company.reconciliation = allocated.section;
  result = partyAgeing(company, vouchers, "l-customer", AS_OF);
  assert.deepEqual(paiseOf(result), { current: 0, "1-30": 6_000, "31-60": 5_000, "61-90": 0, "91-180": 0, over180: 0 });
  assert.equal(result.total, 11_000);
});

test("MSME payables report the amount unpaid beyond 45 days of the bill date", () => {
  const { company, vouchers, post } = book();
  post("Purchase", minus(91), "l-purchase", "l-supplier", 20_000);
  post("Purchase", minus(46), "l-purchase", "l-supplier", 3_000);
  post("Purchase", minus(45), "l-purchase", "l-supplier", 7_000);
  post("Payment", minus(10), "l-supplier", "l-cash", 5_000);
  post("Purchase", minus(91), "l-purchase", "l-trader", 9_000);
  post("Sales", minus(100), "l-customer", "l-sales", 8_000);
  company.ledgers.find((row) => row.id === "l-customer").msme = true;
  const msme = partyAgeing(company, vouchers, "l-supplier", AS_OF);
  assert.equal(msme.side, "payable");
  assert.equal(msme.msme, true);
  // 15,000 of the first bill and all of the 46-day bill are past 45 days; the 45-day bill is not.
  assert.equal(msme.msmeOverduePaise, 18_000);
  assert.equal(msme.total, 25_000);
  assert.equal(partyAgeing(company, vouchers, "l-trader", AS_OF).msmeOverduePaise, 0);
  assert.equal(partyAgeing(company, vouchers, "l-trader", AS_OF).msme, false);
  assert.equal(partyAgeing(company, vouchers, "l-customer", AS_OF).msmeOverduePaise, 0);
  const all = companyAgeing(company, vouchers, AS_OF, ["l-supplier", "l-trader", "l-customer"]);
  assert.deepEqual([...all.keys()], ["l-supplier", "l-trader", "l-customer"]);
  assert.equal(all.get("l-supplier").msmeOverduePaise, 18_000);
});

test("owner review reports receivables and payables overdue beyond 30 days and MSME arrears", () => {
  const { company, vouchers, post } = book();
  post("Sales", minus(31), "l-customer", "l-sales", 4_000);
  post("Sales", minus(30), "l-customer", "l-sales", 6_000);
  post("Purchase", minus(60), "l-purchase", "l-supplier", 2_500);
  post("Purchase", minus(20), "l-purchase", "l-trader", 1_500);
  const review = ownerReview(company, vouchers, "2026-04-01", AS_OF);
  assert.equal(review.receivable, 10_000);
  assert.equal(review.payable, 4_000);
  assert.equal(review.receivableOverduePaise, 4_000);
  assert.equal(review.payableOverduePaise, 2_500);
  assert.equal(review.msmeOverduePaise, 2_500);
  assert.equal(typeof review.netProfit, "number");
  // A period ending before the books begin has nothing to age.
  const early = ownerReview(company, vouchers, "2026-03-01", "2026-03-31");
  assert.deepEqual([early.receivableOverduePaise, early.payableOverduePaise, early.msmeOverduePaise], [0, 0, 0]);
});
