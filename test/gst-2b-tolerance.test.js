import test from "node:test";
import assert from "node:assert/strict";
import { reconcile2B, reconciliationSettings, buildToleranceChange, DEFAULT_TOLERANCE } from "../lib/gst-reconcile.js";

const party = { gstin: "27ABCDE1234F1Z0" };
const reg = { id: "main", gstin: "23ABCDE1234F1Z8" };
const totals = { taxablePaise: 10000, igstPaise: 1800, cgstPaise: 0, sgstPaise: 0, utgstPaise: 0, cessPaise: 0, totalPaise: 11800 };
function book(id, number, supplierInvoiceDate, overrides = {}) {
  return { gst: { id, direction: "purchase", registrationId: reg.id, type: "Purchase", supplierInvoiceNumber: number, supplierInvoiceDate, date: overrides.date || supplierInvoiceDate, party, totals: { ...totals, ...overrides.totals }, placeOfSupply: "23", reverseCharge: false } };
}
const doc = (overrides = {}) => ({ inum: "S/1", dt: "08-04-2026", pos: "23", rev: "N", val: "118.00", txval: "100.00", igst: "18.00", itcavl: "Y", ...overrides });
function run(vouchers, docs, options, company = { gst: { registrations: [reg] } }) {
  const statement = { gstin: reg.gstin, rtnprd: "042026", docdata: { b2b: [{ ctin: party.gstin, inv: docs }] } };
  return reconcile2B(company, vouchers, reg.id, "2026-04", statement, options);
}

test("exact amounts stay Matched; a tax head exactly at the 100 paise default matches within tolerance and carries the difference", () => {
  const exact = run([book("a", "S/1", "2026-04-08")], [doc()]).results[0];
  assert.equal(exact.status, "Matched");
  assert.equal(exact.matchCode, "matched");
  assert.deepEqual(exact.tolerated, []);
  assert.deepEqual(exact.amountDifferences, { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 });

  const at = run([book("a", "S/1", "2026-04-08")], [doc({ igst: "19.00", val: "119.00" })]).results[0];
  assert.equal(at.status, "Matched within tolerance");
  assert.equal(at.matchCode, "matched-within-tolerance");
  assert.deepEqual(at.differences, ["igst", "total"]);
  assert.deepEqual(at.tolerated, ["igst", "total"]);
  assert.equal(at.amountDifferences.igst, 100);
  assert.equal(at.amountDifferences.total, 100);
  assert.ok(at.notes.includes("amount-within-tolerance"));
});

test("one paisa over the tax head or taxable tolerance is a mismatch", () => {
  const over = run([book("a", "S/1", "2026-04-08")], [doc({ igst: "19.01", val: "119.01" })]).results[0];
  assert.equal(over.status, "Mismatch");
  assert.equal(over.matchCode, "mismatch");
  assert.deepEqual(over.tolerated, ["total"]);
  assert.equal(over.amountDifferences.igst, 101);

  const taxableAt = run([book("a", "S/1", "2026-04-08")], [doc({ txval: "99.00" })]).results[0];
  assert.equal(taxableAt.status, "Matched within tolerance");
  assert.equal(taxableAt.amountDifferences.taxable, -100);
  const taxableOver = run([book("a", "S/1", "2026-04-08")], [doc({ txval: "98.99" })]).results[0];
  assert.equal(taxableOver.status, "Mismatch");
  assert.deepEqual(taxableOver.differences.filter(f => !taxableOver.tolerated.includes(f)), ["taxable"]);
});

test("request options and saved company settings set the tolerance; zero reproduces the earlier exact matching", () => {
  const vouchers = [book("a", "S/1", "2026-04-08")];
  const penny = [doc({ igst: "18.01", val: "118.01" })];
  assert.equal(run(vouchers, penny).results[0].status, "Matched within tolerance");
  assert.equal(run(vouchers, penny, { tolerancePaise: 0, dateToleranceDays: 0 }).results[0].status, "Mismatch");
  assert.equal(run(vouchers, [doc({ igst: "18.60", val: "118.60" })], { tolerancePaise: { igst: 50 } }).results[0].status, "Mismatch");
  assert.equal(run(vouchers, [doc({ igst: "18.50", val: "118.50" })], { tolerancePaise: { igstPaise: 50 } }).results[0].status, "Matched within tolerance");
  const saved = { gst: { registrations: [reg], reconciliation2B: { version: 1, tolerance: { ...DEFAULT_TOLERANCE, igstPaise: 0 }, dateToleranceDays: 3 } } };
  const result = run(vouchers, penny, undefined, saved);
  assert.equal(result.results[0].status, "Mismatch");
  assert.equal(result.tolerance.source, "saved");
  assert.equal(result.tolerance.tolerance.igstPaise, 0);
  for (const bad of [-1, 10001, 1.5, "100"]) assert.throws(() => run(vouchers, penny, { tolerancePaise: bad }), /tolerance/);
  assert.throws(() => run(vouchers, penny, { tolerancePaise: { freight: 10 } }), /tolerance/);
  assert.throws(() => run(vouchers, penny, { dateToleranceDays: 31 }), /days/);
});

test("a supplier date within three days matches with a date-differs note; four days is a mismatch", () => {
  const three = run([book("a", "S/1", "2026-04-08")], [doc({ dt: "11-04-2026" })]).results[0];
  assert.equal(three.status, "Matched within tolerance");
  assert.equal(three.matchCode, "matched-within-tolerance");
  assert.deepEqual(three.notes, ["date-differs"]);
  assert.equal(three.dateDifferenceDays, 3);
  assert.deepEqual(three.tolerated, ["date"]);
  const earlier = run([book("a", "S/1", "2026-04-08")], [doc({ dt: "05-04-2026" })]).results[0];
  assert.equal(earlier.status, "Matched within tolerance");
  assert.equal(earlier.dateDifferenceDays, -3);
  const four = run([book("a", "S/1", "2026-04-08")], [doc({ dt: "12-04-2026" })]).results[0];
  assert.equal(four.status, "Mismatch");
  assert.deepEqual(four.differences, ["date"]);
  assert.equal(run([book("a", "S/1", "2026-04-08")], [doc({ dt: "11-04-2026" })], { dateToleranceDays: 0 }).results[0].status, "Mismatch");
});

test("date tolerance reaches across the 31 March financial-year boundary", () => {
  const result = run([book("a", "S/1", "2026-03-31")], [doc({ dt: "01-04-2026" })]);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].bookId, "a");
  assert.equal(result.results[0].status, "Matched within tolerance");
  assert.deepEqual(result.results[0].notes, ["date-differs"]);
  const strict = run([book("a", "S/1", "2026-03-31")], [doc({ dt: "01-04-2026" })], { dateToleranceDays: 0 });
  assert.equal(strict.results[0].status, "Only in 2B");
});

test("tolerance settings validate, replay unchanged values and report the edit-log entry", () => {
  const company = { gst: { registrations: [reg] } };
  assert.deepEqual(reconciliationSettings(company).tolerance, DEFAULT_TOLERANCE);
  assert.equal(reconciliationSettings(company).dateToleranceDays, 3);
  const change = buildToleranceChange(company, { tolerance: { taxablePaise: 500, igstPaise: 200 }, dateToleranceDays: 2, requestId: "tolerance-settings-0001" });
  assert.equal(change.replayed, false);
  assert.equal(change.entry.entity, "gst-master");
  change.update(company);
  assert.deepEqual(company.gst.reconciliation2B.tolerance, { ...DEFAULT_TOLERANCE, taxablePaise: 500, igstPaise: 200 });
  assert.equal(company.gst.reconciliation2B.dateToleranceDays, 2);
  assert.equal(buildToleranceChange(company, { tolerance: { taxablePaise: 500, igstPaise: 200 }, dateToleranceDays: 2 }).replayed, true);
  assert.throws(() => buildToleranceChange(company, { tolerance: { igstPaise: 10001 } }), /tolerance/);
  assert.throws(() => buildToleranceChange(company, { tolerance: { igstPaise: 10 }, expected: { tolerance: DEFAULT_TOLERANCE, dateToleranceDays: 3 } }), /changed/);
});
