import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { start } from "../server.js";
import { createStore } from "../lib/store.js";
import { gstinCheckDigit } from "../lib/gst.js";
import { assertItcImsClaim, itcImsState } from "../lib/gst-itc.js";

const gstin = stem => stem + gstinCheckDigit(stem);
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64");
const confirmations = Object.fromEntries(["invoiceHeld", "received", "businessUse", "notBlocked", "supplierReported", "supplierTaxPaid", "returnFurnished", "paymentReview", "noTaxDepreciation"].map(key => [key, true]));

// Three purchases, one statement: S/1 without IMS status, S/2 pending on the portal, S/3 rejected on the portal.
async function book(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ledgercraft-itc-ims-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createStore(dataDir);
  const { company } = await store.create({ name: "Public ITC IMS book", booksFrom: "2026-04-01" });
  const { registration } = await store.saveGstMaster(company.id, "registration", { name: "Synthetic buyer", gstin: gstin("23ABCDE1234F1Z"), stateCode: "23", address: "Public test address" });
  const { party } = await store.saveGstMaster(company.id, "party", { name: "Synthetic supplier", kind: "supplier", gstin: gstin("27PQRST5678L1Z"), stateCode: "27", address: "Public test address" });
  const { item } = await store.saveGstMaster(company.id, "item", { name: "Sample service", kind: "service", hsnSac: "998599", unit: "OTH", gstRateBps: 1800 });
  const invoices = {};
  for (const [number, date] of [["S/1", "2026-04-08"], ["S/2", "2026-04-09"], ["S/3", "2026-04-10"]]) {
    invoices[number] = (await store.passGstInvoice(company.id, { registrationId: registration.id, partyId: party.id, type: "Purchase", date, placeOfSupply: "23", itcEligibility: "pending", supplierInvoiceNumber: number, items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000 }] })).invoice;
  }
  const statement = { data: { gstin: registration.gstin, rtnprd: "042026", itcsumm: {}, docdata: { b2b: [{ ctin: party.gstin, inv: [
    { inum: "S/1", dt: "08-04-2026", val: 118, txval: 100, igst: 18, pos: "23", rev: "N", itcavl: "Y" },
    { inum: "S/2", dt: "09-04-2026", val: 118, txval: 100, igst: 18, pos: "23", rev: "N", itcavl: "Y", imsStatus: "P" },
    { inum: "S/3", dt: "10-04-2026", val: 118, txval: 100, igst: 18, pos: "23", rev: "N", itcavl: "Y", imsStatus: "R" },
  ] }] } } };
  const saved = await store.saveGstStatement(company.id, registration.id, "2026-04", { files: [{ name: "April.json", base64: encode(statement) }] });
  const server = await start({ port: 0, dataDir });
  t.after(() => new Promise(done => server.close(done)));
  const origin = "http://127.0.0.1:" + server.address().port, base = origin + "/api/companies/" + company.id;
  const evidence = async invoice => {
    const res = await fetch(base + "/gst-returns/statement-evidence?invoice=" + invoice.id);
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    return body.matches;
  };
  const claim = (invoice, statementRow, requestId) => ({ invoiceId: invoice.id, date: "2026-05-02", reference: "Reviewed " + invoice.supplierInvoiceNumber, requestId,
    evidence: { ...confirmations, annualReturnStatus: "not-filed", basis: "Synthetic evidence confirming forward credit", documentReference: "PUBLIC-IMS", statement: Object.fromEntries(["id", "sha256", "rowKey", "period", "availability", "matchStatus", "reason"].map(key => [key, statementRow[key]])) } });
  return { store, id: company.id, registration, saved, invoices, evidence, claim };
}

test("itcImsState and assertItcImsClaim read recorded IMS actions before portal codes", () => {
  assert.deepEqual(itcImsState({ ims: { action: "reject", source: "recorded" }, imsStatus: "A" }), { action: "reject", source: "recorded" });
  assert.deepEqual(itcImsState({ imsStatus: "P" }), { action: "pending", source: "portal" });
  assert.deepEqual(itcImsState({ ims: { action: null, source: "none" } }), { action: null, source: "none" });
  assert.deepEqual(itcImsState({}), { action: null, source: "none" });
  assert.throws(() => assertItcImsClaim("claim", { ims: { action: "reject", source: "recorded" } }), { message: "This document is rejected on IMS; accept it on the portal before claiming the credit" });
  assert.throws(() => assertItcImsClaim("reclaim", { imsStatus: "P" }), { message: "This document is pending on IMS; accept it on the portal before claiming the credit" });
  assert.throws(() => assertItcImsClaim("prior-claim", { imsStatus: "R" }), /rejected on IMS/);
  // A recorded accept overrides a portal reject code; reversals are never blocked.
  assert.doesNotThrow(() => assertItcImsClaim("claim", { ims: { action: "accept", source: "recorded" }, imsStatus: "R" }));
  assert.doesNotThrow(() => assertItcImsClaim("permanent", { imsStatus: "R" }));
  assert.doesNotThrow(() => assertItcImsClaim("claim", {}));
});

test("statement evidence carries the IMS state and ITC claims on rejected or pending documents are refused", async t => {
  const f = await book(t);
  const [first] = await f.evidence(f.invoices["S/1"]);
  const [pending] = await f.evidence(f.invoices["S/2"]);
  const [rejected] = await f.evidence(f.invoices["S/3"]);
  assert.deepEqual(first.ims, { action: null, source: "none" });
  assert.deepEqual(pending.ims, { action: "pending", source: "portal" });
  assert.deepEqual(rejected.ims, { action: "reject", source: "portal" });
  assert.equal(first.availability, "Y");
  assert.equal(first.id, f.saved.statement.id);

  await assert.rejects(f.store.gstItcAction(f.id, "claim", f.claim(f.invoices["S/2"], pending, "itc-ims-claim-pending-01")), { message: "This document is pending on IMS; accept it on the portal before claiming the credit" });
  await assert.rejects(f.store.gstItcAction(f.id, "claim", f.claim(f.invoices["S/3"], rejected, "itc-ims-claim-reject-001")), { message: "This document is rejected on IMS; accept it on the portal before claiming the credit" });
  assert.equal((await f.store.get(f.id)).company.gst.itc?.records.length ?? 0, 0);
  const ok = await f.store.gstItcAction(f.id, "claim", f.claim(f.invoices["S/1"], first, "itc-ims-claim-first-0001"));
  assert.equal(ok.record.components.igstPaise, 1800);

  // A recorded reject on S/1's row would block a further claim; a recorded accept on S/2 lifts the portal pending code.
  await f.store.saveImsAction(f.id, { registration: f.registration.id, statementId: f.saved.statement.id, rowKey: pending.rowKey, action: "accept", at: "2026-05-01", requestId: "itc-ims-accept-pending-1" });
  const [accepted] = await f.evidence(f.invoices["S/2"]);
  assert.deepEqual(accepted.ims, { action: "accept", source: "recorded" });
  const claimed = await f.store.gstItcAction(f.id, "claim", f.claim(f.invoices["S/2"], accepted, "itc-ims-claim-accepted-1"));
  assert.equal(claimed.record.components.igstPaise, 1800);

  await f.store.saveImsAction(f.id, { registration: f.registration.id, statementId: f.saved.statement.id, rowKey: rejected.rowKey, action: "pending", reason: "Awaiting supplier credit note", at: "2026-05-01", requestId: "itc-ims-pending-reject-1" });
  const [kept] = await f.evidence(f.invoices["S/3"]);
  assert.deepEqual(kept.ims, { action: "pending", source: "recorded" });
  await assert.rejects(f.store.gstItcAction(f.id, "claim", f.claim(f.invoices["S/3"], kept, "itc-ims-claim-kept-00001")), /pending on IMS/);
});
