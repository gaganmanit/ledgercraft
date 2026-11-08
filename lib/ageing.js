import { isIsoDate } from "./money.js";
import { billReport } from "./reconciliation-bills.js";
import { partySide, section, sum } from "./reconciliation-common.js";

// Receivables and payables ageing.
//
// Every open amount ages from its due date. A bill-wise reference (reconciliation bills,
// including GST invoices) carries its own due date; anything without a reference ages from
// its voucher date plus the party's credit days (company.gst party `creditDays`, else the
// ledger's own `creditDays`, else 0). Receipts, payments and credit notes that are not
// allocated to a bill settle the oldest due amounts first; any surplus is an advance.
//
// MSME: for payables to a ledger marked `msme: true`, Section 43B(h) of the Income-tax Act
// read with section 15 of the MSMED Act allows the deduction only when the supplier is paid
// within 45 days of the bill date. `msmeOverduePaise` is the amount still unpaid more than
// 45 days after its bill date.

export const DEFAULT_BUCKETS = Object.freeze([30, 60, 90, 180]);
export const MSME_PAYMENT_DAYS = 45;
export const OVERDUE_REVIEW_DAYS = 30;
const DAY = 86_400_000;

function checkedDate(value, label = "ageing date") {
  if (!isIsoDate(value)) throw new Error(`Enter a valid ${label}`);
  return value;
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${checkedDate(to)}T00:00:00Z`) - Date.parse(`${checkedDate(from, "due date")}T00:00:00Z`)) / DAY);
}

export function addDays(iso, days) {
  return new Date(Date.parse(`${checkedDate(iso, "date")}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** Ordered bucket rows: current (not yet due), one row per limit, then everything beyond the last limit. */
export function bucketRanges(buckets = DEFAULT_BUCKETS) {
  if (!Array.isArray(buckets) || !buckets.length || buckets.some((limit, index) => !Number.isSafeInteger(limit) || limit < 1 || (index && limit <= buckets[index - 1]))) {
    throw new Error("Choose ascending whole-day ageing limits greater than zero");
  }
  const rows = [{ label: "current", from: null, to: 0, paise: 0 }];
  let previous = 0;
  for (const limit of buckets) {
    rows.push({ label: `${previous + 1}-${limit}`, from: previous + 1, to: limit, paise: 0 });
    previous = limit;
  }
  rows.push({ label: `over${previous}`, from: previous + 1, to: null, paise: 0 });
  return rows;
}

function bucketIndex(rows, days) {
  if (days <= 0) return 0;
  return rows.findIndex((row, index) => index > 0 && (row.to === null || days <= row.to));
}

/**
 * Age signed paise amounts as on `asOf`. Each entry is `{ paise, dueDate }` (or `{ paise, date }`
 * when no due date applies). Returns `{ buckets: [{ label, from, to, paise }], total }`, where
 * `from`/`to` are days past due (current is everything not yet overdue).
 */
export function ageBuckets(entries, asOf, buckets = DEFAULT_BUCKETS) {
  checkedDate(asOf);
  const rows = bucketRanges(buckets);
  let total = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry?.paise)) throw new Error("Enter ageing amounts in whole paise");
    const row = rows[bucketIndex(rows, daysBetween(entry.dueDate || entry.date, asOf))];
    row.paise = sum([row.paise, entry.paise]);
    total = sum([total, entry.paise]);
  }
  return { buckets: rows, total };
}

/** Add bucket arrays that share the same labels. */
export function sumBuckets(list, buckets = DEFAULT_BUCKETS) {
  const rows = bucketRanges(buckets);
  for (const ageing of list) {
    for (const row of ageing) {
      const target = rows.find((item) => item.label === row.label);
      if (!target) throw new Error("Ageing buckets do not use the same day limits");
      target.paise = sum([target.paise, row.paise]);
    }
  }
  return rows;
}

const validDays = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 3650;

/** The GST party master linked to this party ledger, when there is one. */
export function linkedGstParty(company, account, side = partySide(company, account)) {
  const field = side === "receivable" ? "customerLedgerId" : "supplierLedgerId";
  const linked = (company.gst?.parties || []).filter((party) => party?.[field] === account.id);
  return linked.find((party) => validDays(party.creditDays)) || linked[0] || null;
}

export function partyCreditDays(company, account, side = partySide(company, account)) {
  const party = linkedGstParty(company, account, side);
  if (validDays(party?.creditDays)) return party.creditDays;
  if (validDays(account.creditDays)) return account.creditDays;
  return 0;
}

/** Index vouchers by the ledgers they touch so that each party scans only its own entries. */
export function vouchersByLedger(vouchers) {
  const index = new Map();
  for (const voucher of vouchers) {
    for (const ledgerId of new Set(voucher.lines.map((line) => line.ledgerId))) {
      if (!index.has(ledgerId)) index.set(ledgerId, []);
      index.get(ledgerId).push(voucher);
    }
  }
  return index;
}

const byDue = (a, b) => a.dueDate.localeCompare(b.dueDate) || a.date.localeCompare(b.date) || String(a.reference).localeCompare(String(b.reference));

/**
 * Age one sundry debtor or creditor as on `asOf`. `partyVouchers` may be the subset of
 * vouchers that touch this ledger (see vouchersByLedger); the result is the same.
 */
export function partyAgeing(company, vouchers, ledgerId, asOf, { buckets = DEFAULT_BUCKETS, partyVouchers } = {}) {
  checkedDate(asOf);
  const account = company.ledgers.find((row) => row.id === ledgerId);
  if (!account) throw new Error("Choose a ledger in this company");
  const side = partySide(company, account);
  const creditDays = partyCreditDays(company, account, side);
  const msme = account.msme === true;
  const result = { ledgerId, name: account.name, side, asOf, creditDays, msme, items: [], buckets: bucketRanges(buckets),
    total: 0, advancePaise: 0, netPaise: 0, oldestDate: null, overduePaise: 0, msmeOverduePaise: 0, differencePaise: 0 };
  if (asOf < company.booksFrom) return result;
  // Only this party's ledger and entries are needed; narrowing keeps large books fast.
  const report = billReport(section(company.reconciliation), { ...company, ledgers: [account] }, partyVouchers || vouchers, asOf, ledgerId);
  const items = [];
  for (const bill of report.rows) {
    // A GST invoice without a saved reference carries its invoice date as due date; the
    // party's credit terms still apply to it.
    const dueDate = bill.derived && creditDays ? addDays(bill.date, creditDays) : bill.dueDate;
    items.push({ kind: "bill", billWise: true, billId: bill.id, voucherId: bill.voucherId, reference: bill.reference, date: bill.date, dueDate, amountPaise: bill.amountPaise, openPaise: bill.openPaise });
  }
  for (const entry of report.unreferenced) {
    items.push({ kind: entry.sourceKind === "opening" ? "opening" : "on-account", billWise: false, billId: null, voucherId: entry.voucherId, reference: entry.reference,
      date: entry.date, dueDate: addDays(entry.date, creditDays), amountPaise: entry.remainingPaise, openPaise: entry.remainingPaise });
  }
  items.sort(byDue);
  // Unallocated settlements clear the oldest due amounts first.
  let credit = sum(report.settlements.map((row) => row.remainingPaise));
  for (const item of items) {
    if (!credit || item.openPaise <= 0) continue;
    const used = Math.min(credit, item.openPaise);
    item.openPaise -= used;
    credit -= used;
  }
  for (const item of items) item.days = Math.max(0, daysBetween(item.dueDate, asOf));
  const open = items.filter((item) => item.openPaise > 0);
  const aged = ageBuckets(open.map((item) => ({ paise: item.openPaise, dueDate: item.dueDate })), asOf, buckets);
  result.items = items;
  result.buckets = aged.buckets;
  result.total = aged.total;
  result.advancePaise = credit;
  result.netPaise = sum([aged.total, -credit]);
  result.oldestDate = open.reduce((oldest, item) => (!oldest || item.date < oldest ? item.date : oldest), null);
  result.overduePaise = sum(open.filter((item) => item.days > OVERDUE_REVIEW_DAYS).map((item) => item.openPaise));
  if (msme && side === "payable") {
    result.msmeOverduePaise = sum(open.filter((item) => daysBetween(item.date, asOf) > MSME_PAYMENT_DAYS).map((item) => item.openPaise));
  }
  const ledgerPaise = report.totals[0]?.ledgerPaise ?? 0;
  result.differencePaise = sum([ledgerPaise, -result.netPaise]);
  return result;
}

/** Age many party ledgers in one pass over the vouchers. Returns a Map keyed by ledger id. */
export function companyAgeing(company, vouchers, asOf, ledgerIds, options = {}) {
  const index = vouchersByLedger(vouchers);
  const result = new Map();
  for (const ledgerId of ledgerIds) {
    result.set(ledgerId, partyAgeing(company, vouchers, ledgerId, asOf, { ...options, partyVouchers: index.get(ledgerId) || [] }));
  }
  return result;
}
