import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendAudit, canonicalJson, entryHash, GENESIS_HASH, verifyAuditLog } from "../lib/audit-log.js";
import { gstinCheckDigit } from "../lib/gst.js";
import { createStore } from "../lib/store.js";
import { companyBackup, importCompany } from "../lib/transfer.js";
import { start } from "../server.js";

async function withStore(run) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ledgercraft-audit-"));
  try { await run(createStore(dataDir), dataDir); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}

async function readLog(dataDir, id) {
  const text = await readFile(path.join(dataDir, "companies", id, "audit.jsonl"), "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

const gstin = (state, pan = "ABCDE1234F") => { const stem = `${state}${pan}1Z`; return stem + gstinCheckDigit(stem); };
const receipt = (cash, income, number, date = "2026-04-05", paise = 50000) => ({ type: "Receipt", date, number, narration: "Counter sale", lines: [{ ledgerId: cash, dc: "Dr", paise }, { ledgerId: income, dc: "Cr", paise }] });

test("every master and voucher change appends a hash-chained edit-log entry after the save", async () => {
  await withStore(async (store, dataDir) => {
    const { company } = await store.create({ name: "Edit Log Traders", booksFrom: "2026-04-01" });
    const id = company.id;
    let book = await store.addGroup(id, { name: "Shop Expenses", parentId: "g-indirect-exp" });
    const group = book.company.groups.find((item) => item.name === "Shop Expenses");
    await store.updateGroup(id, group.id, { name: "Store Expenses" });
    book = await store.addLedger(id, { name: "Counter Sales", groupId: "g-sales", openingPaise: 0, openingDc: "Cr" });
    const sales = book.company.ledgers.find((item) => item.name === "Counter Sales");
    book = await store.addLedger(id, { name: "Sweeping", groupId: group.id, openingPaise: 0, openingDc: "Dr" });
    const sweeping = book.company.ledgers.find((item) => item.name === "Sweeping");
    await store.updateLedger(id, sweeping.id, { name: "Cleaning", groupId: group.id });
    await store.removeLedger(id, sweeping.id);
    await store.removeGroup(id, group.id);
    const passed = await store.passVoucher(id, { ...receipt("l-cash", sales.id, "RCT-1"), requestId: "edit-log-receipt-000001" });
    await store.passVoucher(id, { ...passed.voucher, narration: "Counter sale, corrected", lines: passed.voucher.lines.map((line) => ({ ...line, paise: 60000 })) }, passed.voucher.id);
    // A replayed save and an unchanged save add nothing.
    await store.passVoucher(id, { ...receipt("l-cash", sales.id, "RCT-1"), requestId: "edit-log-receipt-000001" }).catch(() => {});
    await store.removeVoucher(id, passed.voucher.id);

    const entries = await readLog(dataDir, id);
    assert.deepEqual(entries.map((entry) => `${entry.action}:${entry.entity}`), [
      "create:company", "create:group", "alter:group", "create:ledger", "create:ledger", "alter:ledger", "delete:ledger", "delete:group",
      "create:voucher", "alter:voucher", "delete:voucher",
    ]);
    assert.deepEqual(entries.map((entry) => entry.seq), entries.map((_, index) => index + 1));
    assert.equal(entries[0].prevHash, GENESIS_HASH);
    for (let index = 1; index < entries.length; index += 1) assert.equal(entries[index].prevHash, entries[index - 1].hash);
    for (const entry of entries) {
      assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(entry.hash, entryHash(entry.prevHash, entry));
      assert.ok(entry.summary.length > 10);
    }
    const created = entries[8];
    assert.equal(created.number, "RCT-1");
    assert.equal(created.requestId, "edit-log-receipt-000001");
    assert.equal(created.before, null);
    assert.equal(created.after.lines[0].paise, 50000);
    assert.match(created.summary, /Receipt RCT-1 dated 05-04-2026 for ₹500\.00 passed/);
    const altered = entries[9];
    assert.equal(altered.before.lines[0].paise, 50000);
    assert.equal(altered.after.lines[0].paise, 60000);
    assert.match(altered.summary, /amount ₹500\.00 to ₹600\.00/);
    assert.match(altered.summary, /narration/);
    assert.equal(entries[10].after, null);
    assert.equal(entries[10].before.number, "RCT-1");
    assert.match(entries[2].summary, /Shop Expenses renamed to Store Expenses/);
    assert.deepEqual(await verifyAuditLog(path.join(dataDir, "companies", id)), { verified: true, count: 11, lastHash: entries[10].hash, problems: [] });
  });
});

test("editing, removing or reordering any edit-log line is detected", async () => {
  await withStore(async (store, dataDir) => {
    const { company } = await store.create({ name: "Tamper Check", booksFrom: "2026-04-01" });
    for (const name of ["Rent", "Power", "Water"]) await store.addLedger(company.id, { name, groupId: "g-indirect-exp", openingPaise: 0, openingDc: "Dr" });
    const folder = path.join(dataDir, "companies", company.id);
    const file = path.join(folder, "audit.jsonl");
    const original = await readFile(file, "utf8");
    assert.equal((await verifyAuditLog(folder)).verified, true);
    const lines = original.trim().split("\n");

    const edited = JSON.parse(lines[2]);
    edited.summary = "Ledger Rent created with a different story.";
    await writeFile(file, [lines[0], lines[1], JSON.stringify(edited), lines[3]].join("\n") + "\n");
    let result = await verifyAuditLog(folder);
    assert.equal(result.verified, false);
    assert.equal(result.problems[0].line, 3);
    assert.match(result.problems[0].reason, /hash does not match/);

    await writeFile(file, [lines[0], lines[2], lines[3]].join("\n") + "\n");
    result = await verifyAuditLog(folder);
    assert.equal(result.verified, false);
    assert.match(result.problems.map((problem) => problem.reason).join(" "), /sequence|previous hash/);

    await writeFile(file, [lines[0], lines[2], lines[1], lines[3]].join("\n") + "\n");
    assert.equal((await verifyAuditLog(folder)).verified, false);

    // Rehashing an edited line still breaks the link to the next line.
    const forged = { ...JSON.parse(lines[1]), summary: "Forged" };
    forged.hash = entryHash(forged.prevHash, forged);
    await writeFile(file, [lines[0], JSON.stringify(forged), lines[2], lines[3]].join("\n") + "\n");
    assert.equal((await verifyAuditLog(folder)).verified, false);

    await writeFile(file, original);
    assert.equal((await verifyAuditLog(folder)).verified, true);
  });
});

test("canonical JSON is key-order independent and the chain resumes after a torn final line", async () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
  const folder = await mkdtemp(path.join(tmpdir(), "ledgercraft-audit-raw-"));
  try {
    await appendAudit(folder, [{ action: "create", entity: "company", id: "raw", summary: "Company Raw created." }]);
    await writeFile(path.join(folder, "audit.jsonl"), (await readFile(path.join(folder, "audit.jsonl"), "utf8")) + '{"seq":2,"at":"tor');
    const [next] = await appendAudit(folder, [{ action: "alter", entity: "company", id: "raw", summary: "Company Raw renamed." }]);
    assert.equal(next.seq, 2);
    const result = await verifyAuditLog(folder);
    // The torn line stays visible as damage instead of being silently dropped.
    assert.equal(result.verified, false);
    assert.equal(result.count, 2);
    assert.deepEqual(result.problems, [{ line: 2, reason: "unreadable entry" }]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("a book saved before edit logging starts its log with a marker entry", async () => {
  await withStore(async (store, dataDir) => {
    const { company } = await store.create({ name: "Older Book", booksFrom: "2026-04-01" });
    await unlink(path.join(dataDir, "companies", company.id, "audit.jsonl"));
    await store.addLedger(company.id, { name: "Rent", groupId: "g-indirect-exp", openingPaise: 0, openingDc: "Dr" });
    const entries = await readLog(dataDir, company.id);
    assert.deepEqual(entries.map((entry) => `${entry.seq}:${entry.action}:${entry.entity}`), ["1:import:company", "2:create:ledger"]);
    assert.match(entries[0].summary, /before Ledgercraft kept an edit log/);
  });
});

test("GST masters, GST invoices and reverse-charge actions are logged", async () => {
  await withStore(async (store, dataDir) => {
    const { company } = await store.create({ name: "GST Edit Log", booksFrom: "2025-04-01" });
    const registration = (await store.saveGstMaster(company.id, "registration", { name: "Synthetic Recipient", legalName: "Synthetic Recipient", gstin: gstin("23"), stateCode: "23", address: "Public test address", pincode: "462001" })).registration;
    const party = (await store.saveGstMaster(company.id, "party", { name: "Synthetic Supplier", kind: "both", gstin: "", stateCode: "23", address: "Public supplier address" })).party;
    const item = (await store.saveGstMaster(company.id, "item", { name: "Synthetic RCM supply", kind: "service", hsnSac: "998599", unit: "NOS", gstRateBps: 1800, cessRateBps: 0, pricePaise: 10000, purchasePricePaise: 10000, supplyStatus: "taxable", openingQuantity: "0" })).item;
    await store.saveGstMaster(company.id, "item", { ...item, name: "Synthetic RCM service" });
    const saved = await store.passGstInvoice(company.id, { type: "Purchase", registrationId: registration.id, partyId: party.id, date: "2026-04-10", supplierInvoiceNumber: "SUP-1", placeOfSupply: "23", pricing: "exclusive", reverseCharge: true, rcm: { applicabilityConfirmed: true, basisReference: "Synthetic notified RCM basis under section9(3)", receiptDate: "2026-04-01", supplierInvoiceDate: "2026-04-01", selfInvoiceDate: "2026-04-10" }, items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000 }], requestId: "audit-rcm-invoice-00001" });
    await store.gstRcmAction(company.id, "cash-deposit", { invoiceId: saved.invoice.id, date: "2026-04-10", requestId: "audit-rcm-deposit-000001", reference: "Public reference 1", bankLedgerId: "l-cash", components: { cgstPaise: 900, sgstPaise: 900, utgstPaise: 0, igstPaise: 0, cessPaise: 0 } });
    const entries = await readLog(dataDir, company.id);
    const masters = entries.filter((entry) => entry.entity === "gst-master");
    assert.deepEqual(masters.map((entry) => entry.action), ["create", "create", "create", "alter"]);
    assert.equal(masters[3].before.name, "Synthetic RCM supply");
    assert.equal(masters[3].after.name, "Synthetic RCM service");
    const documents = entries.filter((entry) => entry.entity === "gst-document");
    assert.equal(documents.length, 2);
    assert.equal(documents[0].id, saved.voucher.id);
    assert.equal(documents[0].number, saved.invoice.number);
    assert.equal(documents[0].requestId, "audit-rcm-invoice-00001");
    assert.match(documents[0].summary, /GST purchase Purchase .* dated 10-04-2026 for ₹118\.00/);
    assert.match(documents[1].summary, /Reverse-charge cash-deposit recorded on 10-04-2026/);
    assert.equal(documents[1].requestId, "audit-rcm-deposit-000001");
    assert.equal((await verifyAuditLog(path.join(dataDir, "companies", company.id))).verified, true);
  });
});

test("stock and reconciliation changes through the store are logged", async () => {
  await withStore(async (store, dataDir) => {
    const { company } = await store.create({ name: "Section Log", booksFrom: "2026-04-01" });
    await store.mutateCompanySection(company.id, "reconciliation", () => ({ version: 1, revision: 1, statements: [], matches: [], bills: [], allocations: [], audit: [{ id: "ra-public-1", requestId: "public-request-0001", requestHash: "a".repeat(64), action: "bank-opening", at: "2026-04-02T00:00:00.000Z", result: {} }] }));
    const entries = await readLog(dataDir, company.id);
    const last = entries.at(-1);
    assert.equal(last.entity, "reconciliation");
    assert.equal(last.id, "ra-public-1");
    assert.equal(last.requestId, "public-request-0001");
    assert.equal(last.revision, 1);
    assert.match(last.summary, /bank opening/);
  });
});

test("HTTP edit log lists newest first with filters, search, paging and the chain status", async () => {
  await withStore(async (store, dataDir) => {
    const { company } = await store.create({ name: "Audit Route Book", booksFrom: "2026-04-01" });
    let book = await store.addLedger(company.id, { name: "Sales", groupId: "g-sales", openingPaise: 0, openingDc: "Cr" });
    const sales = book.company.ledgers.find((item) => item.name === "Sales");
    for (let index = 1; index <= 4; index += 1) await store.passVoucher(company.id, receipt("l-cash", sales.id, `RCT-${index}`));
    const server = await start({ dataDir });
    const base = `http://127.0.0.1:${server.address().port}/api/companies/${company.id}/audit`;
    try {
      let body = await fetch(base).then((response) => response.json());
      assert.equal(body.total, 6);
      assert.equal(body.verified, true);
      assert.deepEqual(body.entries.map((entry) => entry.seq), [6, 5, 4, 3, 2, 1]);
      body = await fetch(`${base}?entity=voucher&limit=2&offset=1`).then((response) => response.json());
      assert.equal(body.total, 4);
      assert.deepEqual(body.entries.map((entry) => entry.number), ["RCT-3", "RCT-2"]);
      body = await fetch(`${base}?q=rct-2`).then((response) => response.json());
      assert.deepEqual(body.entries.map((entry) => entry.number), ["RCT-2"]);
      body = await fetch(`${base}?limit=100000`).then((response) => response.json());
      assert.equal(body.limit, 500);
      const today = new Date();
      const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      body = await fetch(`${base}?from=${iso}&to=${iso}`).then((response) => response.json());
      assert.equal(body.total, 6);
      body = await fetch(`${base}?to=2000-01-01`).then((response) => response.json());
      assert.equal(body.total, 0);
      const bad = await fetch(`${base}?entity=everything`);
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /entry type/);
      // Tampering shows on the route.
      const file = path.join(dataDir, "companies", company.id, "audit.jsonl");
      await writeFile(file, (await readFile(file, "utf8")).replace("RCT-2", "RCT-9"));
      body = await fetch(base).then((response) => response.json());
      assert.equal(body.verified, false);
      assert.ok(body.problems.length >= 1);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});

test("backups carry the edit log and a restore appends to it instead of starting over", async () => {
  await withStore(async (store, dataDir) => {
    const { company } = await store.create({ name: "Backup Log Book", booksFrom: "2026-04-01" });
    const book = await store.addLedger(company.id, { name: "Sales", groupId: "g-sales", openingPaise: 0, openingDc: "Cr" });
    const sales = book.company.ledgers.find((item) => item.name === "Sales");
    await store.passVoucher(company.id, receipt("l-cash", sales.id, "RCT-1"));
    const server = await start({ dataDir });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    try {
      const backup = await fetch(`${base}/companies/${company.id}/backup`).then((response) => response.json());
      assert.equal(backup.auditLog.version, 1);
      assert.equal(backup.auditLog.lines.length, 3);
      const restored = await fetch(`${base}/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(backup) });
      assert.equal(restored.status, 201);
      const restoredId = (await restored.json()).company.id;
      const entries = await readLog(dataDir, restoredId);
      assert.deepEqual(entries.map((entry) => `${entry.seq}:${entry.action}:${entry.entity}`), ["1:create:company", "2:create:ledger", "3:create:voucher", "4:restore:company"]);
      assert.deepEqual(entries.slice(0, 3).map((entry) => JSON.stringify(entry)), backup.auditLog.lines);
      assert.match(entries[3].summary, /restored from a Ledgercraft backup exported on \d{2}-\d{2}-\d{4} with 1 voucher and 2 ledgers; 3 earlier edit-log entries were carried over/);
      assert.equal((await verifyAuditLog(path.join(dataDir, "companies", restoredId))).verified, true);
      // The restored book keeps logging on the same chain.
      await store.passVoucher(restoredId, receipt("l-cash", sales.id, "RCT-2"));
      assert.equal((await verifyAuditLog(path.join(dataDir, "companies", restoredId))).count, 5);

      const tampered = structuredClone(backup);
      tampered.auditLog.lines[1] = tampered.auditLog.lines[1].replace("Sales", "Slaes");
      const refused = await fetch(`${base}/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tampered) });
      assert.equal(refused.status, 400);
      assert.match((await refused.json()).error, /edit log in this backup has been altered \(line 2/);
      const dropped = structuredClone(backup);
      dropped.auditLog.lines.splice(1, 1);
      assert.equal((await fetch(`${base}/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(dropped) })).status, 400);
    } finally { await new Promise((resolve) => server.close(resolve)); }
    // A backup from before edit logging imports with an explicit marker entry.
    const current = await store.get(company.id);
    const imported = await importCompany(dataDir, companyBackup(current.company, current.vouchers));
    const entries = await readLog(dataDir, imported.company.id);
    assert.deepEqual(entries.map((entry) => `${entry.action}:${entry.entity}`), ["import:company"]);
    assert.match(entries[0].summary, /carried no edit log/);
  });
});

test("full Tally archives carry the edit log and a library restore appends to it", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ledgercraft-audit-tally-"));
  const server = await start({ port: 0, dataDir });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, input, expected) => {
    const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const json = await response.json();
    assert.equal(response.status, expected, JSON.stringify(json));
    return json;
  };
  try {
    const files = await Promise.all(["Masters.xml", "DayBook.xml"].map(async (name) => ({ name, base64: (await readFile(new URL(`fixtures/tally/${name}`, import.meta.url))).toString("base64") })));
    const preview = await post("/api/tally/preview", { companyName: "Public example books", booksFrom: "2026-04-01", files }, 200);
    const created = await post("/api/tally/commit", { token: preview.token, acknowledge: true }, 201);
    const payment = created.vouchers.find((voucher) => voucher.type === "Payment");
    const edited = await fetch(`${base}/api/companies/${created.company.id}/vouchers/${payment.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payment, narration: "Edited after Tally import" }) });
    assert.equal(edited.status, 200);
    const archive = await (await fetch(`${base}/api/tally/companies/${created.company.id}/archive`)).json();
    assert.deepEqual(archive.auditLog.lines.map((line) => JSON.parse(line).action), ["import", "alter"]);
    const backup = await (await fetch(`${base}/api/companies/${created.company.id}/backup`)).json();
    assert.equal(backup.format, "financer-tally-archive");
    assert.deepEqual(backup.auditLog, archive.auditLog);
    const restored = await post("/api/import", backup, 201);
    const entries = await readLog(dataDir, restored.company.id);
    assert.deepEqual(entries.map((entry) => `${entry.seq}:${entry.action}`), ["1:import", "2:alter", "3:restore"]);
    assert.equal((await verifyAuditLog(path.join(dataDir, "companies", restored.company.id))).verified, true);
    const tampered = structuredClone(backup);
    tampered.auditLog.lines.pop();
    tampered.auditLog.lines.push(JSON.stringify({ ...JSON.parse(backup.auditLog.lines[1]), summary: "Nothing happened" }));
    const refused = await post("/api/import", tampered, 400);
    assert.match(refused.error, /edit log in this backup has been altered/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
