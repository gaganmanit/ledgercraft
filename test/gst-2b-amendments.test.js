import test from "node:test";
import assert from "node:assert/strict";
import { reconcile2B } from "../lib/gst-reconcile.js";

const party = { gstin: "27ABCDE1234F1Z0" };
const reg = { id: "main", gstin: "23ABCDE1234F1Z8" };
const company = { gst: { registrations: [reg] } };
const totals = { taxablePaise: 10000, igstPaise: 1800, cgstPaise: 0, sgstPaise: 0, utgstPaise: 0, cessPaise: 0, totalPaise: 11800 };
function book(id, number, date, type = "Purchase") {
  return { gst: { id, direction: "purchase", registrationId: reg.id, type, supplierInvoiceNumber: number, date, party, totals, placeOfSupply: "23", reverseCharge: false } };
}
const document = { inum: "REV/2", dt: "01-04-2026", oinum: "OLD/1", oidt: "29-03-2026", pos: "23", rev: "N", val: 118, txval: 100, igst: 18, itcavl: "Y" };
function run(vouchers, section, docs) {
  const group = { ctin: party.gstin, [section.startsWith("b2b") ? "inv" : "nt"]: docs };
  const statement = { gstin: reg.gstin, rtnprd: "042026", docdata: { [section]: [group] } };
  return reconcile2B(company, vouchers, reg.id, "2026-04", { code: 200, data: { status_cd: "1", data: { data: statement } } }).results;
}
test("amendment follows the original across financial years, reports revised identity and preserves books", () => {
  const vouchers = [book("one", "OLD/1", "2026-03-29")], before = structuredClone(vouchers);
  const [row] = run(vouchers, "b2ba", [document]);
  assert.equal(row.bookId, "one");
  assert.equal(row.status, "Mismatch");
  assert.deepEqual(row.differences, ["number", "date"]);
  assert.equal(row.original.number, "OLD/1");
  assert.equal(row.number, "REV/2");
  assert.deepEqual(vouchers, before);
});
test("conflicting original and revised candidates and repeated amendments remain visible individually", () => {
  const vouchers = [book("a", "OLD/1", "2026-03-29"), book("b", "REV/2", "2026-04-01")];
  const [row] = run(vouchers, "b2ba", [document]);
  assert.equal(row.status, "Ambiguous");
  assert.equal(row.bookId, undefined);
  assert.deepEqual(row.candidates.map(v=>v.id).sort(), ["a","b"]);
  const rows = run(vouchers.slice(1), "b2ba", [document, { ...document, val: 119 }]);
  assert.deepEqual(rows.map(v=>v.status), ["Duplicate", "Duplicate"]);
  assert.deepEqual(rows.map(v=>v.portalValue), [11800, 11900]);
});
test("checks place of supply and RCM, retains IMS and ITC data, matches note amendments through their original type", () => {
  const vouchers = [book("x", "OLD/1", "2026-03-29", "Credit Note")];
  const [row] = run(vouchers, "cdnra", [{ ...document, onttyp: "C", typ: "D", ontnum: "OLD/1", ontdt: document.oidt, ntnum: "REV/2", pos: "27", rev: "Y", imsStatus: "A", itcavl: "N", rsn: "P" }]);
  assert.equal(row.bookId, "x");
  assert.deepEqual(row.differences, ["type", "number", "date", "placeOfSupply", "reverseCharge"]);
  assert.equal(row.imsStatus, "A"); assert.equal(row.statementITC,"N"); assert.equal(row.reason, "P");
});

test("page sets need the same registration and period; missing or repeated pages cannot prove a book-only exception", () => {
  const base = { gstin: reg.gstin, rtnprd: "042026" };
  const page = number => ({...base, docdata: { b2b: [{ctin: party.gstin,inv:[{...document,inum:number}]}] }});
  const books = [book("a","UNMATCHED","2026-04-01")];
  const run = files => reconcile2B(company,books,reg.id,"2026-04",files);
  assert.equal(run([page("p1")]).results.at(-1).status,"Absent from selected pages");
  const complete=run([{...base,fc:2},page("p1"),page("p2")]);
  assert.equal(complete.partial,false);
  assert.equal(complete.results.at(-1).status,"Only in books");
  assert.throws(()=>run([{...base,fc:2},page("p1")]),/expects 2/);
  assert.throws(()=>run([page("p1"),page("p1")]),/selected twice/);
  assert.throws(()=>run([page("p1"),{...page("p2"),rtnprd:"052026"}]),/period/);
});
