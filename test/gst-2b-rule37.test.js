import test from "node:test";
import assert from "node:assert/strict";
import { rule37Watch } from "../lib/gst-ims.js";
import { reconcile2B } from "../lib/gst-reconcile.js";
import { ensureItcAccounts, buildItcAction, ITC_COMPONENTS } from "../lib/gst-itc.js";
import { gstVoucher } from "../lib/gst.js";
import { reservedGroups } from "../lib/groups.js";
import { billReport, allocateBill } from "../lib/reconciliation-bills.js";
import { section } from "../lib/reconciliation-common.js";

const zero = () => Object.fromEntries(ITC_COMPONENTS.map(key => [key + "Paise", 0]));
const addDays = (iso, days) => new Date(Date.parse(iso + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);

function fixture() {
  const accounts = { sales: "sales", purchase: "purchase-account", nonCreditTax: "expense", ...Object.fromEntries(ITC_COMPONENTS.map(key => ["input-" + key, "input-" + key])) };
  const registration = { id: "registration", gstin: "23ABCDE1234F1Z8", invoicePrefix: "P1", accounts };
  const company = { id: "public-rule37", name: "Public rule 37 test", booksFrom: "2026-04-01", groups: reservedGroups(),
    ledgers: [...Object.entries(accounts).map(([key, id]) => ({ id, name: key, groupId: key === "sales" ? "g-sales" : ["purchase", "nonCreditTax"].includes(key) ? "g-purchase" : "g-current-assets", opening: { dc: "Dr", paise: 0 } })),
      { id: "supplier", name: "Supplier", groupId: "g-creditors", opening: { dc: "Dr", paise: 0 } },
      { id: "bank", name: "Bank", groupId: "g-bank", opening: { dc: "Dr", paise: 0 } }],
    gst: { registrations: [registration], items: [{ id: "goods", name: "Public goods", kind: "goods", unit: "NOS" }] } };
  const party = { id: "party", name: "Public supplier", gstin: "27ABCDE1234F1Z0", supplierLedgerId: "supplier", customerLedgerId: "supplier" };
  const vouchers = [];
  function purchase(id, date, options = {}) {
    const item = { itemId: "goods", name: "Public goods", kind: "goods", quantity: "1", taxablePaise: 10000, ...zero(), cgstPaise: 900, sgstPaise: 900, taxPaise: 1800, totalPaise: 11800, gstRateBps: 1800, cessRateBps: 0 };
    const totals = { ...zero(), taxablePaise: 10000, cgstPaise: 900, sgstPaise: 900, taxPaise: 1800, totalPaise: 11800 };
    const invoice = { id, date, number: id, supplierInvoiceNumber: id, supplierInvoiceDate: options.supplierInvoiceDate || date, type: "Purchase", direction: "purchase", stockEffect: "none",
      registrationId: registration.id, registration, partyId: party.id, party, items: [item], totals, itcEligibility: options.itcEligibility || "eligible",
      reverseCharge: false, originalInvoiceId: null, narration: "", placeOfSupply: "23" };
    const voucher = gstVoucher(invoice);
    if (options.reverseCharge) voucher.gst.reverseCharge = true;
    vouchers.push(voucher);
    return voucher;
  }
  function payment(id, date, paise) {
    const voucher = { id, type: "Payment", date, number: id, narration: "", lines: [{ ledgerId: "supplier", dc: "Dr", paise }, { ledgerId: "bank", dc: "Cr", paise }] };
    vouchers.push(voucher);
    return voucher;
  }
  return { company, vouchers, purchase, payment, registration };
}

test("rule 37 lists an unpaid claimed purchase only beyond 180 days from the supplier invoice date", () => {
  const f = fixture();
  f.purchase("P-1", "2026-04-12", { supplierInvoiceDate: "2026-04-10" });
  const day179 = rule37Watch(f.company, f.vouchers, addDays("2026-04-10", 179));
  assert.equal(day179.rows.length, 0);
  assert.equal(day179.approaching.length, 1);
  assert.equal(day179.approaching[0].daysOutstanding, 179);
  assert.equal(rule37Watch(f.company, f.vouchers, addDays("2026-04-10", 180)).rows.length, 0);
  const day181 = rule37Watch(f.company, f.vouchers, addDays("2026-04-10", 181));
  assert.equal(day181.rows.length, 1);
  const [row] = day181.rows;
  assert.equal(row.invoiceId, "P-1");
  assert.equal(row.daysOutstanding, 181);
  assert.equal(row.deadline, addDays("2026-04-10", 180));
  assert.equal(row.reversalPeriod, "2026-11");
  assert.equal(row.basis, "ledger");
  assert.equal(row.postedPaise, 11800);
  assert.equal(row.unpaidPaise, 11800);
  assert.equal(row.itcToReverse.cgstPaise, 900);
  assert.equal(row.itcToReverse.sgstPaise, 900);
  assert.equal(row.itcToReversePaise, 1800);
  assert.equal(row.interest.section, "50(3)");
  assert.equal(row.interest.rateBps, 1800);
  assert.equal(row.interest.principalPaise, 1800);
  assert.equal(row.interest.fromDate, "2026-04-12");
  assert.equal(day181.totals.totalPaise, 1800);
});

test("rule 37 reverses ITC in proportion to the unpaid amount and ignores paid, unclaimed and reverse-charge documents", () => {
  const f = fixture();
  f.purchase("P-1", "2026-04-10");
  f.payment("PAY-1", "2026-05-01", 5900);
  const asOf = addDays("2026-04-10", 181);
  const [row] = rule37Watch(f.company, f.vouchers, asOf).rows;
  assert.equal(row.unpaidPaise, 5900);
  assert.equal(row.itcToReverse.cgstPaise, 450);
  assert.equal(row.itcToReverse.sgstPaise, 450);
  f.payment("PAY-2", "2026-06-01", 5900);
  assert.equal(rule37Watch(f.company, f.vouchers, asOf).rows.length, 0);
  const g = fixture();
  g.purchase("PENDING", "2026-04-10", { itcEligibility: "pending" });
  g.purchase("RCM", "2026-04-10", { reverseCharge: true });
  assert.equal(rule37Watch(g.company, g.vouchers, asOf).rows.length, 0);
});

test("ledger basis settles the oldest invoice first; bill-wise allocations take precedence when the party uses them", () => {
  const f = fixture();
  const older = f.purchase("OLD", "2026-04-02");
  f.purchase("NEW", "2026-04-20");
  const pay = f.payment("PAY-1", "2026-05-01", 11800);
  const asOf = addDays("2026-04-20", 181);
  const ledger = rule37Watch(f.company, f.vouchers, asOf);
  assert.deepEqual(ledger.rows.map(row => row.invoiceId), ["NEW"]);
  const meta = section(null);
  const bills = billReport(meta, f.company, f.vouchers, "2026-05-01", "supplier").rows;
  const newer = bills.find(bill => bill.voucherId === "NEW");
  allocateBill(meta, f.company, f.vouchers, { ledgerId: "supplier", billId: newer.id, creditKey: `${pay.id}:supplier`, date: "2026-05-01", paise: 11800 });
  f.company.reconciliation = meta;
  const billwise = rule37Watch(f.company, f.vouchers, asOf);
  assert.deepEqual(billwise.rows.map(row => [row.invoiceId, row.basis, row.unpaidPaise]), [[older.id, "bill-wise", 11800]]);
});

test("reviewed books use the claimed ITC balance and its claim date", () => {
  const f = fixture();
  f.purchase("P-1", "2026-04-10", { itcEligibility: "pending" });
  ensureItcAccounts(f.company, f.registration.id);
  const evidence = { basis: "Synthetic section 16 review", documentReference: "PUBLIC-DOC", invoiceHeld: true, received: true, businessUse: true, notBlocked: true, supplierReported: true, supplierTaxPaid: true, returnFurnished: true, paymentReview: true, noTaxDepreciation: true, annualReturnStatus: "not-filed" };
  const asOf = addDays("2026-04-10", 181);
  assert.equal(rule37Watch(f.company, f.vouchers, asOf).rows.length, 0);
  const result = buildItcAction(f.company, f.vouchers, "claim", { invoiceId: "P-1", date: "2026-05-15", reference: "Reviewed", requestId: "public-rule37-claim-0001", evidence });
  f.company.gst.itc.records.push(result.record);
  f.vouchers.push(result.voucher);
  const [row] = rule37Watch(f.company, f.vouchers, asOf).rows;
  assert.equal(row.itcToReversePaise, 1800);
  assert.equal(row.interest.fromDate, "2026-05-15");
});

test("the 2B reconciliation result carries the rule 37 watch at the month end", () => {
  const f = fixture();
  f.purchase("P-1", "2026-04-10");
  const statement = { gstin: f.registration.gstin, rtnprd: "102026", docdata: { b2b: [] } };
  const result = reconcile2B(f.company, f.vouchers, f.registration.id, "2026-10", statement);
  assert.equal(result.rule37.asOf, "2026-10-31");
  assert.deepEqual(result.rule37.rows.map(row => row.invoiceId), ["P-1"]);
});
