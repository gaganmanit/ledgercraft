import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { start } from "../server.js";
import { createStore } from "../lib/store.js";
import { gstinCheckDigit } from "../lib/gst.js";
import { imsEligible, IMS_ACTIONS } from "../lib/gst-ims.js";
import { reconcile2B } from "../lib/gst-reconcile.js";
import { matchSavedStatement } from "../lib/gst-statement-library.js";

const gstin = stem => stem + gstinCheckDigit(stem);
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64");

async function book(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ledgercraft-ims-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createStore(dataDir);
  const { company } = await store.create({ name: "Public IMS book", booksFrom: "2026-04-01" });
  const { registration } = await store.saveGstMaster(company.id, "registration", { name: "Synthetic buyer", gstin: gstin("23ABCDE1234F1Z"), stateCode: "23", address: "Public test address" });
  const { party } = await store.saveGstMaster(company.id, "party", { name: "Synthetic supplier", kind: "supplier", gstin: gstin("27PQRST5678L1Z"), stateCode: "27", address: "Public test address" });
  const { item } = await store.saveGstMaster(company.id, "item", { name: "Sample service", kind: "service", hsnSac: "998599", unit: "OTH", gstRateBps: 1800 });
  const { invoice } = await store.passGstInvoice(company.id, { registrationId: registration.id, partyId: party.id, type: "Purchase", date: "2026-04-08", placeOfSupply: "23", itcEligibility: "pending", supplierInvoiceNumber: "S/1", items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000 }] });
  const statement = { data: { gstin: registration.gstin, rtnprd: "042026", itcsumm: {}, docdata: { b2b: [{ ctin: party.gstin, inv: [
    { inum: "S/1", dt: "08-04-2026", val: 118, txval: 100, igst: 18, pos: "23", rev: "N", itcavl: "Y" },
    { inum: "S/2", dt: "09-04-2026", val: 236, txval: 200, igst: 36, pos: "23", rev: "N", itcavl: "Y" },
  ] }] } } };
  const saved = await store.saveGstStatement(company.id, registration.id, "2026-04", { files: [{ name: "April.json", base64: encode(statement) }] });
  const rowKey = number => saved.results.find(row => row.number === number).statementRowKey;
  return { dataDir, store, id: company.id, registration, party, invoice, statement, saved, rowKey, companyDir: path.join(dataDir, "companies", company.id) };
}
const auditLines = async dir => (await readFile(path.join(dir, "audit.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

test("imsEligible keeps rejected and pending rows out of available ITC and reads portal codes", () => {
  assert.deepEqual(IMS_ACTIONS, ["accept", "reject", "pending", "no-action"]);
  assert.equal(imsEligible({ ims: { action: "accept" } }), true);
  assert.equal(imsEligible({ ims: { action: "no-action" } }), true);
  assert.equal(imsEligible({ ims: { action: "reject" } }), false);
  assert.equal(imsEligible({ ims: { action: "pending" } }), false);
  assert.equal(imsEligible({ imsStatus: "R" }), false);
  assert.equal(imsEligible({ imsStatus: "P" }), false);
  assert.equal(imsEligible({ imsStatus: "A" }), true);
  assert.equal(imsEligible({}), true);
});

test("IMS actions are append-only per statement row, idempotent by request id and logged", async t => {
  const f = await book(t);
  const before = await matchSavedStatement(f.companyDir, (await f.store.get(f.id)).company, (await f.store.get(f.id)).vouchers, f.saved.statement.id);
  assert.equal(before.results.every(row => row.ims && "action" in row.ims), true);
  assert.equal(before.imsCounts.none, 2);
  assert.equal(before.itcAvailable.count, 2);

  const reject = { registration: f.registration.id, statementId: f.saved.statement.id, rowKey: f.rowKey("S/2"), action: "reject", reason: "Goods not received", at: "2026-05-05", requestId: "ims-action-request-0001" };
  const logBefore = (await auditLines(f.companyDir)).length;
  const first = await f.store.saveImsAction(f.id, reject);
  assert.equal(first.replayed, false);
  assert.equal(first.record.action, "reject");
  assert.equal(first.record.at, "2026-05-05");
  assert.deepEqual(first.history.map(row => row.action), ["reject"]);
  const log = await auditLines(f.companyDir);
  assert.equal(log.length, logBefore + 1);
  assert.equal(log.at(-1).entity, "gst-document");
  assert.equal(log.at(-1).requestId, reject.requestId);

  const again = await f.store.saveImsAction(f.id, reject);
  assert.equal(again.replayed, true);
  assert.equal(again.record.id, first.record.id);
  assert.equal((await auditLines(f.companyDir)).length, logBefore + 1);
  await assert.rejects(f.store.saveImsAction(f.id, { ...reject, reason: "Different reason" }), /different IMS action/);

  const { company, vouchers } = await f.store.get(f.id);
  assert.equal(company.gst.ims.actions.length, 1);
  const matched = await matchSavedStatement(f.companyDir, company, vouchers, f.saved.statement.id);
  const rejected = matched.results.find(row => row.number === "S/2");
  assert.deepEqual({ action: rejected.ims.action, at: rejected.ims.at, reason: rejected.ims.reason }, { action: "reject", at: "2026-05-05", reason: "Goods not received" });
  assert.equal(imsEligible(rejected), false);
  assert.equal(rejected.itcAvailable, false);
  assert.equal(matched.imsCounts.reject, 1);
  assert.equal(matched.imsCounts.none, 1);
  assert.equal(matched.itcAvailable.count, 1);
  assert.equal(matched.itcAvailable.igstPaise, 1800);
  assert.equal(matched.itcExcludedByIms.igstPaise, 3600);
  assert.equal(matched.results.find(row => row.number === "S/1").statementRowKey, f.rowKey("S/1"));

  const accept = await f.store.saveImsAction(f.id, { ...reject, action: "accept", reason: "", requestId: "ims-action-request-0002", expected: { recordId: first.record.id } });
  assert.deepEqual(accept.history.map(row => row.action), ["reject", "accept"]);
  assert.equal(accept.record.previous.id, first.record.id);
  await assert.rejects(f.store.saveImsAction(f.id, { ...reject, action: "pending", requestId: "ims-action-request-0003", expected: { recordId: first.record.id } }), /changed/);
  const latest = await f.store.get(f.id);
  assert.equal(latest.company.gst.ims.actions.length, 2);
  const after = await matchSavedStatement(f.companyDir, latest.company, latest.vouchers, f.saved.statement.id);
  assert.equal(after.results.find(row => row.number === "S/2").ims.action, "accept");
  assert.equal(after.itcAvailable.count, 2);

  // An unsaved upload of the same 2B inherits the document's recorded action.
  const adhoc = reconcile2B(latest.company, latest.vouchers, f.registration.id, "2026-04", f.statement);
  const inherited = adhoc.results.find(row => row.number === "S/2").ims;
  assert.equal(inherited.action, "accept");
  assert.equal(inherited.inherited, true);
});

test("IMS actions validate the action, reason, row, registration and GST period lock", async t => {
  const f = await book(t);
  const base = { registration: f.registration.id, statementId: f.saved.statement.id, rowKey: f.rowKey("S/1"), action: "pending", reason: "Awaiting debit note", at: "2026-05-02" };
  let n = 0;
  const id = () => `ims-validate-request-${String(++n).padStart(4, "0")}`;
  await assert.rejects(f.store.saveImsAction(f.id, { ...base, action: "approve", requestId: id() }), /accept, reject, pending or no-action/);
  await assert.rejects(f.store.saveImsAction(f.id, { ...base, reason: "", requestId: id() }), /reason/);
  await assert.rejects(f.store.saveImsAction(f.id, { ...base, rowKey: "a".repeat(64), requestId: id() }), /row/);
  await assert.rejects(f.store.saveImsAction(f.id, { ...base, registration: "other", requestId: id() }), /registration/);
  await assert.rejects(f.store.saveImsAction(f.id, { ...base, at: "2026-04-01", requestId: id() }), /precede/);
  await assert.rejects(f.store.saveImsAction(f.id, { ...base, requestId: "short" }), /identifier/);
  await f.store.setLocks(f.id, { gst: { to: "2026-04-30", reason: "GSTR-3B filed for April" } });
  await assert.rejects(f.store.saveImsAction(f.id, { ...base, requestId: id() }), /lock/i);
  const { company } = await f.store.get(f.id);
  assert.equal(company.gst.ims, undefined);
});

test("HTTP: IMS rows, actions, tolerance settings and rule 37 watch", async t => {
  const f = await book(t);
  const server = await start({ port: 0, dataDir: f.dataDir });
  t.after(() => new Promise(done => server.close(done)));
  const origin = "http://127.0.0.1:" + server.address().port, base = origin + "/api/companies/" + f.id + "/gst-returns";
  const call = async (method, route, body, status) => {
    const res = await fetch(base + route, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await res.json();
    assert.equal(res.status, status, JSON.stringify(json));
    return json;
  };
  const view = await call("GET", `/ims?registration=${f.registration.id}&statement=${f.saved.statement.id}`, null, 200);
  assert.equal(view.statement.id, f.saved.statement.id);
  assert.equal(view.rows.length, 2);
  assert.ok(view.rows.every(row => row.rowKey && row.ims && Array.isArray(row.history)));
  assert.equal(view.rule37.asOf, "2026-04-30");
  assert.deepEqual(view.actions, ["accept", "reject", "pending", "no-action"]);
  const latest = await call("GET", `/ims?registration=${f.registration.id}`, null, 200);
  assert.equal(latest.statement.id, f.saved.statement.id);

  const action = { registration: f.registration.id, statementId: f.saved.statement.id, rowKey: f.rowKey("S/1"), action: "accept", requestId: "ims-http-request-000001", at: "2026-05-03" };
  const saved = await call("POST", "/ims/actions", action, 201);
  assert.equal(saved.record.action, "accept");
  assert.equal((await call("POST", "/ims/actions", action, 201)).replayed, true);
  await call("POST", "/ims/actions", { ...action, action: "maybe", requestId: "ims-http-request-000002" }, 400);
  const refreshed = await call("GET", `/ims?registration=${f.registration.id}&statement=${f.saved.statement.id}`, null, 200);
  const row = refreshed.rows.find(entry => entry.rowKey === f.rowKey("S/1"));
  assert.equal(row.ims.action, "accept");
  assert.equal(row.history.length, 1);
  assert.equal(refreshed.imsCounts.accept, 1);

  const settings = await call("GET", "/reconcile-2b/settings", null, 200);
  assert.equal(settings.tolerance.igstPaise, 100);
  assert.equal(settings.dateToleranceDays, 3);
  const changed = await call("POST", "/reconcile-2b/settings", { tolerance: { igstPaise: 0 }, dateToleranceDays: 1, requestId: "tolerance-http-000001" }, 200);
  assert.equal(changed.settings.tolerance.igstPaise, 0);
  assert.equal(changed.replayed, false);
  await call("POST", "/reconcile-2b/settings", { tolerance: { igstPaise: 10001 } }, 400);
  assert.equal((await call("GET", "/reconcile-2b/settings", null, 200)).dateToleranceDays, 1);

  const watch = await call("GET", `/ims/rule37?registration=${f.registration.id}&asOf=2026-12-31`, null, 200);
  assert.equal(watch.asOf, "2026-12-31");
  assert.deepEqual(watch.rows, []);

  // A full backup carries the IMS history and restores it against the original statement rows.
  const backup = await (await fetch(origin + "/api/companies/" + f.id + "/backup")).json();
  assert.equal(backup.company.gst.ims.actions.length, 1);
  const restore = async (body, status) => {
    const res = await fetch(origin + "/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    assert.equal(res.status, status, JSON.stringify(json));
    return json;
  };
  const restored = await restore(backup, 201);
  assert.deepEqual(restored.company.gst.ims, backup.company.gst.ims);
  assert.deepEqual(restored.company.gst.reconciliation2B.tolerance, backup.company.gst.reconciliation2B.tolerance);
  const tampered = structuredClone(backup);
  tampered.company.gst.ims.actions[0].rowKey = "b".repeat(64);
  assert.match((await restore(tampered, 400)).error, /IMS action/);
});
