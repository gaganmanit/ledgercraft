import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../lib/store.js";
import { assertGstMasters, gstinCheckDigit, saveParty } from "../lib/gst.js";
import { gstr3bWorking } from "../lib/gst-3b.js";

const gstin = stem => stem + gstinCheckDigit(stem);
const address = "Public test address";

async function book(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ledgercraft-composition-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createStore(dataDir);
  const { company } = await store.create({ name: "Public composition book", booksFrom: "2026-04-01" });
  const { registration } = await store.saveGstMaster(company.id, "registration", { name: "Synthetic seller", gstin: gstin("23ABCDE1234F1Z"), stateCode: "23", address });
  const { item } = await store.saveGstMaster(company.id, "item", { name: "Sample panel", kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1800 });
  const { item: zeroItem } = await store.saveGstMaster(company.id, "item", { name: "Bill of supply goods", kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 0 });
  return { store, id: company.id, registration, item, zeroItem };
}

test("saveParty stores compositionDealer only when true, keeps it on edits that omit it, and refuses it for UIN and TDS holders", () => {
  const company = { ledgers: [], groups: [{ id: "g-debtors", name: "Sundry Debtors" }, { id: "g-creditors", name: "Sundry Creditors" }] };
  const plain = saveParty(company, { name: "Plain buyer", kind: "customer", gstin: gstin("29AAACP1234C1Z"), stateCode: "29", address, compositionDealer: false });
  assert.equal("compositionDealer" in plain, false);
  const composition = saveParty(company, { name: "Composition buyer", kind: "customer", gstin: gstin("29AAACC1234C1Z"), stateCode: "29", address, compositionDealer: true });
  assert.equal(composition.compositionDealer, true);
  const edited = saveParty(company, { id: composition.id, name: "Composition buyer", kind: "customer", gstin: composition.gstin, stateCode: "29", address: "New public address" });
  assert.equal(edited.compositionDealer, true);
  const cleared = saveParty(company, { id: composition.id, name: "Composition buyer", kind: "customer", gstin: composition.gstin, stateCode: "29", address, compositionDealer: false });
  assert.equal("compositionDealer" in cleared, false);
  assert.equal("compositionDealer" in company.gst.parties.find(row => row.id === composition.id), false);
  assert.throws(() => saveParty(company, { name: "Bad flag", kind: "customer", gstin: gstin("29AAACB1234C1Z"), stateCode: "29", address, compositionDealer: "yes" }), /composition dealer as yes or no/);
  assert.throws(() => saveParty(company, { name: "Embassy", kind: "customer", gstin: gstin("0718USA00001UN"), stateCode: "07", address, compositionDealer: true }), /composition dealer cannot hold a UIN/);
  assert.throws(() => saveParty(company, { name: "Deductor", kind: "customer", gstin: gstin("23ABCD12345F1D"), stateCode: "23", address, compositionDealer: true }), /composition dealer cannot hold a UIN or TDS registration/);
  const tampered = structuredClone(company);
  tampered.gst.parties[0].compositionDealer = "true";
  assert.throws(() => assertGstMasters(tampered), /composition dealer flag/);
});

test("GSTR-3B Table 3.2 and Table 5 show composition rows from new snapshots and from documents saved before the flag", async t => {
  const f = await book(t);
  const { party: buyer } = await f.store.saveGstMaster(f.id, "party", { name: "Composition buyer", kind: "customer", gstin: gstin("29AAACC1234C1Z"), stateCode: "29", address, compositionDealer: true });
  const { party: later } = await f.store.saveGstMaster(f.id, "party", { name: "Later composition buyer", kind: "customer", gstin: gstin("27AAACL1234C1Z"), stateCode: "27", address });
  const { party: supplier } = await f.store.saveGstMaster(f.id, "party", { name: "Composition supplier", kind: "supplier", gstin: gstin("23AAACK1234C1Z"), stateCode: "23", address, compositionDealer: true });
  const sale = (await f.store.passGstInvoice(f.id, { registrationId: f.registration.id, partyId: buyer.id, type: "Sales", date: "2026-06-05", placeOfSupply: "29", items: [{ itemId: f.item.id, quantity: "1", unitPricePaise: 40000 }] })).invoice;
  assert.equal(sale.party.compositionDealer, true);
  const oldSale = (await f.store.passGstInvoice(f.id, { registrationId: f.registration.id, partyId: later.id, type: "Sales", date: "2026-06-06", placeOfSupply: "27", items: [{ itemId: f.item.id, quantity: "1", unitPricePaise: 10000 }] })).invoice;
  assert.equal("compositionDealer" in oldSale.party, false);
  const bill = (await f.store.passGstInvoice(f.id, { registrationId: f.registration.id, partyId: supplier.id, type: "Purchase", date: "2026-06-07", placeOfSupply: "23", itcEligibility: "pending", supplierInvoiceNumber: "BOS/1", items: [{ itemId: f.zeroItem.id, quantity: "1", unitPricePaise: 2500 }] })).invoice;
  assert.equal(bill.party.compositionDealer, true);

  let { company, vouchers } = await f.store.get(f.id);
  let working = gstr3bWorking(company, vouchers, f.registration.id, "2026-06", { filingDate: "2026-07-20" });
  assert.deepEqual(working.table32.composition.map(row => [row.pos, row.taxablePaise, row.igstPaise]), [["29", 40000, 7200]]);
  assert.deepEqual(working.table32.unregistered, []);
  assert.equal(working.table5.gst.intraPaise, 2500);
  assert.deepEqual(working.table5.documents.map(row => [row.number, row.composition, row.valuePaise]), [[bill.number, true, 2500]]);

  // Flagging a party later reaches documents saved before the flag through the party master.
  await f.store.saveGstMaster(f.id, "party", { id: later.id, name: later.name, kind: "customer", gstin: later.gstin, stateCode: "27", address, compositionDealer: true });
  ({ company, vouchers } = await f.store.get(f.id));
  working = gstr3bWorking(company, vouchers, f.registration.id, "2026-06", { filingDate: "2026-07-20" });
  assert.deepEqual(working.table32.composition.map(row => [row.pos, row.taxablePaise]), [["27", 10000], ["29", 40000]]);
  assert.equal(working.table32.totals.composition.taxablePaise, 50000);
});
