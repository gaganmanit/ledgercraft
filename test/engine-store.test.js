import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../lib/store.js";
import { companyBackup, importCompany } from "../lib/transfer.js";
import { start } from "../server.js";

async function withStore(run) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "financer-engine-store-"));
  try { await run(createStore(dataDir), dataDir); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const receipt = (cash, sales, number, paise = 10_000) => ({
  type: "Receipt", date: "2026-04-02", number, narration: "",
  lines: [{ ledgerId: cash, dc: "Dr", paise }, { ledgerId: sales, dc: "Cr", paise }],
});

async function seeded(store) {
  const { company } = await store.create({ name: "Durable Book", booksFrom: "2026-04-01" });
  const withSales = await store.addLedger(company.id, { name: "Sales", groupId: "g-sales", openingPaise: 0, openingDc: "Cr" });
  const cash = withSales.company.ledgers.find((item) => item.name === "Cash").id;
  const sales = withSales.company.ledgers.find((item) => item.name === "Sales").id;
  return { id: company.id, cash, sales };
}

test("each save keeps the previous file as a single rolling .bak and leaves no temporary files", async () => {
  await withStore(async (store, dataDir) => {
    const { id, cash, sales } = await seeded(store);
    const folder = path.join(dataDir, "companies", id);
    await store.passVoucher(id, receipt(cash, sales, "RCT-1"));
    await store.passVoucher(id, receipt(cash, sales, "RCT-2"));
    assert.deepEqual((await readJson(path.join(folder, "vouchers.json"))).map((item) => item.number), ["RCT-1", "RCT-2"]);
    assert.deepEqual((await readJson(path.join(folder, "vouchers.json.bak"))).map((item) => item.number), ["RCT-1"]);
    const companyBak = await readJson(path.join(folder, "company.json.bak"));
    assert.equal(companyBak.ledgers.some((item) => item.name === "Sales"), false);
    const files = (await readdir(folder)).sort();
    assert.deepEqual(files, ["company.json", "company.json.bak", "vouchers.json", "vouchers.json.bak"]);
  });
});

test("a corrupt primary file opens from its .bak with a warning and the next save does not overwrite the good copy", async () => {
  await withStore(async (store, dataDir) => {
    const { id, cash, sales } = await seeded(store);
    const folder = path.join(dataDir, "companies", id);
    await store.passVoucher(id, receipt(cash, sales, "RCT-1"));
    await store.passVoucher(id, receipt(cash, sales, "RCT-2"));
    await writeFile(path.join(folder, "vouchers.json"), ""); // a crash left an empty primary
    const fresh = createStore(dataDir);
    const opened = await fresh.get(id);
    assert.deepEqual(opened.vouchers.map((item) => item.number), ["RCT-1"]);
    assert.match(opened.warning, /vouchers\.json/);
    assert.match(opened.warning, /previous saved copy/);
    const shared = await fresh.snapshot(id);
    assert.match(shared.warning, /vouchers\.json/);
    const saved = await fresh.passVoucher(id, receipt(cash, sales, "RCT-3"));
    assert.deepEqual(saved.vouchers.map((item) => item.number), ["RCT-1", "RCT-3"]);
    assert.deepEqual((await readJson(path.join(folder, "vouchers.json.bak"))).map((item) => item.number), ["RCT-1"]);
    const healed = await fresh.get(id);
    assert.equal(healed.warning, undefined);
    // A corrupt company.json is listed and opened from its backup too.
    await writeFile(path.join(folder, "company.json"), "{\"id\":");
    assert.deepEqual((await createStore(dataDir).list()).map((item) => item.id), [id]);
    const company = await createStore(dataDir).get(id);
    assert.match(company.warning, /company\.json/);
    // Without a usable backup the original parse error still surfaces.
    await writeFile(path.join(folder, "company.json.bak"), "nope");
    await assert.rejects(createStore(dataDir).get(id), SyntaxError);
  });
});

test("healthy books carry no warning field", async () => {
  await withStore(async (store) => {
    const { id } = await seeded(store);
    assert.equal(Object.hasOwn(await store.get(id), "warning"), false);
    assert.equal(Object.hasOwn(await store.snapshot(id), "warning"), false);
  });
});

function auditSection(count) {
  const audit = Array.from({ length: count }, (_, index) => ({
    id: `ra-${String(index).padStart(8, "0")}`,
    action: "bank-match",
    requestId: `request-${String(index).padStart(12, "0")}`,
    requestHash: "a".repeat(64),
    at: "2026-04-02T10:00:00.000Z",
    note: "x".repeat(40),
  }));
  return { version: 1, revision: count, statements: [], matches: [], bills: [], allocations: [], audit };
}

test("the reconciliation section accepts more than 1 MB and names itself and its size when too large", async () => {
  await withStore(async (store) => {
    const { id } = await seeded(store);
    const large = auditSection(9_000);
    assert.ok(Buffer.byteLength(JSON.stringify(large)) > 1_000_000);
    await store.mutateCompanySection(id, "reconciliation", () => large);
    assert.equal((await store.get(id)).company.reconciliation.audit.length, 9_000);
    const huge = { ...auditSection(0), padding: "x".repeat(33 * 1024 * 1024) };
    await assert.rejects(
      store.mutateCompanySection(id, "reconciliation", () => huge),
      (error) => /reconciliation/.test(error.message) && /oversized/.test(error.message) && /at 3,46,\d{2},\d{3} bytes/.test(error.message) && /limit is 3,35,54,432 bytes/.test(error.message),
    );
    await assert.rejects(store.mutateCompanySection(id, "stock", () => []), /Invalid stock section/);
  });
});

test("deletes honour a supplied expected version and still work without one", async () => {
  await withStore(async (store) => {
    const { id, cash, sales } = await seeded(store);
    const first = (await store.passVoucher(id, receipt(cash, sales, "RCT-1"))).voucher;
    const second = (await store.passVoucher(id, receipt(cash, sales, "RCT-2"))).voucher;
    const stale = { ...first, narration: "an older view" };
    await assert.rejects(store.removeVoucher(id, first.id, stale), /changed while you were editing/);
    await store.passVoucher(id, { ...receipt(cash, sales, "RCT-1"), narration: "edited elsewhere", expected: first }, first.id);
    await assert.rejects(store.removeVoucher(id, first.id, first), /changed while you were editing/);
    const current = (await store.get(id)).vouchers.find((item) => item.id === first.id);
    await store.removeVoucher(id, first.id, current);
    await store.removeVoucher(id, second.id);
    assert.deepEqual((await store.get(id)).vouchers, []);

    const book = await store.addLedger(id, { name: "Bank Charges", groupId: "g-indirect-exp", openingPaise: 0, openingDc: "Dr" });
    const ledger = book.company.ledgers.find((item) => item.name === "Bank Charges");
    await assert.rejects(store.removeLedger(id, ledger.id, { ...ledger, name: "Bank Charge" }), /changed while you were editing/);
    await store.removeLedger(id, ledger.id, ledger);
    const grouped = await store.addGroup(id, { name: "Office Costs", parentId: "g-indirect-exp" });
    const group = grouped.company.groups.find((item) => item.name === "Office Costs");
    await assert.rejects(store.removeGroup(id, group.id, { name: "Office Cost" }), /changed while you were editing/);
    await store.removeGroup(id, group.id, { name: "Office Costs" });
    assert.equal((await store.get(id)).company.groups.some((item) => item.id === group.id), false);
  });
});

test("the unused recursive company delete is no longer exposed", async () => {
  await withStore(async (store) => {
    assert.equal(store.removeCompany, undefined);
  });
});

test("an imported company is published with fsynced files and no leftover stage folder", async () => {
  await withStore(async (store, dataDir) => {
    const { id, cash, sales } = await seeded(store);
    await store.passVoucher(id, receipt(cash, sales, "RCT-1"));
    const { company, vouchers } = await store.get(id);
    const imported = await importCompany(dataDir, companyBackup(company, vouchers));
    const entries = await readdir(path.join(dataDir, "companies"));
    assert.equal(entries.some((name) => name.startsWith(".financer-import-")), false);
    const opened = await createStore(dataDir).get(imported.company.id);
    assert.deepEqual(opened.vouchers.map((item) => item.number), ["RCT-1"]);
    assert.deepEqual((await readdir(path.join(dataDir, "companies", imported.company.id))).sort(), ["company.json", "vouchers.json"]);
  });
});

test("the DELETE routes pass an optional expected version from the request body", async () => {
  await withStore(async (store, dataDir) => {
    const { id, cash, sales } = await seeded(store);
    const voucher = (await store.passVoucher(id, receipt(cash, sales, "RCT-1"))).voucher;
    const server = await start({ port: 0, dataDir });
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/companies/${id}`;
      const del = (route, body) => fetch(base + route, { method: "DELETE", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const stale = await del(`/vouchers/${voucher.id}`, { expected: { ...voucher, narration: "older" } });
      assert.equal(stale.status, 400);
      assert.match((await stale.json()).error, /changed while you were editing/);
      assert.equal((await del(`/vouchers/${voucher.id}`, { expected: voucher })).status, 200);
      const ledger = (await store.get(id)).company.ledgers.find((item) => item.id === sales);
      assert.equal((await del(`/ledgers/${sales}`, { expected: { ...ledger, name: "Old name" } })).status, 400);
      assert.equal((await del(`/ledgers/${sales}`)).status, 200);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});
