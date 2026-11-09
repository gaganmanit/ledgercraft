// Groups, ledgers, vouchers, day book and ledger report over HTTP. lib/book-routes.js answers
// these paths; one test per path pins the status and answer the old inline server handlers gave.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { start } from "../server.js";
import { createStore } from "../lib/store.js";
import { dayBook, ledgerReport } from "../lib/engine.js";

let dir, server, base, store;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ledgercraft-book-paths-"));
  server = await start({ port: 0, dataDir: dir });
  base = `http://127.0.0.1:${server.address().port}/api/companies`;
  store = createStore(dir);
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

async function call(route, method = "GET", body) {
  const response = await fetch(base + route, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function company(name) {
  const { body } = await call("", "POST", { name, booksFrom: "2026-04-01" });
  return body.company.id;
}
async function withSales(id) {
  const { body } = await call(`/${id}/ledgers`, "POST", { name: "Sales", groupId: "g-sales", openingPaise: 0, openingDc: "Cr" });
  return body.company.ledgers.find((ledger) => ledger.name === "Sales");
}
const receipt = (salesId, number, paise = 10000) => ({ type: "Receipt", date: "2026-04-04", number, narration: "Counter", lines: [{ ledgerId: "l-cash", dc: "Dr", paise }, { ledgerId: salesId, dc: "Cr", paise }] });
// The full (non-slim) answer is the whole book, as store mutations return it.
function assertFullBook(body, id) {
  assert.equal(body.company.id, id);
  assert.ok(Array.isArray(body.company.groups) && Array.isArray(body.company.ledgers) && Array.isArray(body.vouchers));
}

test("POST /groups creates a group with 201 and the full book", async () => {
  const id = await company("Paths Groups Create");
  const { status, body } = await call(`/${id}/groups`, "POST", { name: "Branch costs", parentId: "g-indirect-exp" });
  assert.equal(status, 201);
  assertFullBook(body, id);
  assert.ok(body.company.groups.some((group) => group.name === "Branch costs" && group.parentId === "g-indirect-exp"));
});

test("PUT /groups/<gid> renames a group with 200", async () => {
  const id = await company("Paths Groups Update");
  const created = (await call(`/${id}/groups`, "POST", { name: "Branch costs", parentId: "g-indirect-exp" })).body.company.groups.find((group) => group.name === "Branch costs");
  const { status, body } = await call(`/${id}/groups/${created.id}`, "PUT", { name: "Branch expenses", parentId: "g-indirect-exp" });
  assert.equal(status, 200);
  assertFullBook(body, id);
  assert.equal(body.company.groups.find((group) => group.id === created.id).name, "Branch expenses");
});

test("DELETE /groups/<gid> honours expected in the body and answers 200", async () => {
  const id = await company("Paths Groups Delete");
  const created = (await call(`/${id}/groups`, "POST", { name: "Branch costs", parentId: "g-indirect-exp" })).body.company.groups.find((group) => group.name === "Branch costs");
  const stale = await call(`/${id}/groups/${created.id}`, "DELETE", { expected: { name: "Something else" } });
  assert.equal(stale.status, 400);
  assert.match(stale.body.error, /changed while you were editing/);
  const { status, body } = await call(`/${id}/groups/${created.id}`, "DELETE", { expected: { name: "Branch costs" } });
  assert.equal(status, 200);
  assertFullBook(body, id);
  assert.equal(body.company.groups.some((group) => group.id === created.id), false);
});

test("POST /groups/<gid> is not a delete: the group stays and the path is not found", async () => {
  const id = await company("Paths Groups Post Record");
  const created = (await call(`/${id}/groups`, "POST", { name: "Branch costs", parentId: "g-indirect-exp" })).body.company.groups.find((group) => group.name === "Branch costs");
  const { status } = await call(`/${id}/groups/${created.id}`, "POST", { name: "Other", parentId: "g-indirect-exp" });
  assert.equal(status, 404);
  assert.ok((await store.get(id)).company.groups.some((group) => group.id === created.id));
});

test("POST /ledgers creates a ledger with 201 and the full book", async () => {
  const id = await company("Paths Ledgers Create");
  const { status, body } = await call(`/${id}/ledgers`, "POST", { name: "Rent", groupId: "g-indirect-exp", openingPaise: 0, openingDc: "Dr" });
  assert.equal(status, 201);
  assertFullBook(body, id);
  assert.ok(body.company.ledgers.some((ledger) => ledger.name === "Rent"));
});

test("PUT /ledgers/<lid> alters a ledger with 200", async () => {
  const id = await company("Paths Ledgers Update");
  const rent = (await call(`/${id}/ledgers`, "POST", { name: "Rent", groupId: "g-indirect-exp", openingPaise: 0, openingDc: "Dr" })).body.company.ledgers.find((ledger) => ledger.name === "Rent");
  const { status, body } = await call(`/${id}/ledgers/${rent.id}`, "PUT", { name: "Office rent", groupId: "g-indirect-exp", openingPaise: 0, openingDc: "Dr" });
  assert.equal(status, 200);
  assertFullBook(body, id);
  assert.equal(body.company.ledgers.find((ledger) => ledger.id === rent.id).name, "Office rent");
});

test("DELETE /ledgers/<lid> honours expected in the body and answers 200", async () => {
  const id = await company("Paths Ledgers Delete");
  const rent = (await call(`/${id}/ledgers`, "POST", { name: "Rent", groupId: "g-indirect-exp", openingPaise: 0, openingDc: "Dr" })).body.company.ledgers.find((ledger) => ledger.name === "Rent");
  assert.equal((await call(`/${id}/ledgers/${rent.id}`, "DELETE", { expected: { ...rent, name: "Changed" } })).status, 400);
  const { status, body } = await call(`/${id}/ledgers/${rent.id}`, "DELETE", { expected: rent });
  assert.equal(status, 200);
  assertFullBook(body, id);
  assert.equal(body.company.ledgers.some((ledger) => ledger.id === rent.id), false);
});

test("POST /vouchers passes a voucher with 201 and the full book", async () => {
  const id = await company("Paths Vouchers Create");
  const sales = await withSales(id);
  const { status, body } = await call(`/${id}/vouchers`, "POST", receipt(sales.id, "RCT-1"));
  assert.equal(status, 201);
  assertFullBook(body, id);
  assert.equal(body.vouchers.filter((voucher) => voucher.number === "RCT-1").length, 1);
});

test("PUT /vouchers/<vid> alters a voucher with 200", async () => {
  const id = await company("Paths Vouchers Update");
  const sales = await withSales(id);
  const passed = (await call(`/${id}/vouchers`, "POST", receipt(sales.id, "RCT-1"))).body.vouchers.find((voucher) => voucher.number === "RCT-1");
  const { status, body } = await call(`/${id}/vouchers/${passed.id}`, "PUT", receipt(sales.id, "RCT-1", 25000));
  assert.equal(status, 200);
  assertFullBook(body, id);
  assert.equal(body.vouchers.find((voucher) => voucher.id === passed.id).lines[0].paise, 25000);
});

test("DELETE /vouchers/<vid> honours expected in the body and answers 200", async () => {
  const id = await company("Paths Vouchers Delete");
  const sales = await withSales(id);
  const passed = (await call(`/${id}/vouchers`, "POST", receipt(sales.id, "RCT-1"))).body.vouchers.find((voucher) => voucher.number === "RCT-1");
  assert.equal((await call(`/${id}/vouchers/${passed.id}`, "DELETE", { expected: { ...passed, narration: "Changed" } })).status, 400);
  const { status, body } = await call(`/${id}/vouchers/${passed.id}`, "DELETE", { expected: passed });
  assert.equal(status, 200);
  assertFullBook(body, id);
  assert.equal(body.vouchers.some((voucher) => voucher.id === passed.id), false);
});

test("GET /reports/daybook answers the engine day book for the period", async () => {
  const id = await company("Paths Day Book");
  const sales = await withSales(id);
  await call(`/${id}/vouchers`, "POST", receipt(sales.id, "RCT-1"));
  await call(`/${id}/vouchers`, "POST", receipt(sales.id, "RCT-2", 5000));
  const { status, body } = await call(`/${id}/reports/daybook?from=2026-04-01&to=2026-04-30`);
  assert.equal(status, 200);
  const { company: book, vouchers } = await store.get(id);
  assert.equal(body.from, "2026-04-01");
  assert.equal(body.to, "2026-04-30");
  assert.deepEqual(body.rows, dayBook(book, vouchers, "2026-04-01", "2026-04-30"));
  // Without from and to the period is the day the books begin.
  const fallback = await call(`/${id}/reports/daybook`);
  assert.deepEqual([fallback.body.from, fallback.body.to], ["2026-04-01", "2026-04-01"]);
  assert.equal((await call(`/${id}/reports/daybook?from=2026-05-01&to=2026-04-01`)).status, 400);
});

test("GET /reports/ledger/<lid> answers the engine ledger report for the period", async () => {
  const id = await company("Paths Ledger Report");
  const sales = await withSales(id);
  await call(`/${id}/vouchers`, "POST", receipt(sales.id, "RCT-1"));
  const { status, body } = await call(`/${id}/reports/ledger/l-cash?from=2026-04-01&to=2026-04-30`);
  assert.equal(status, 200);
  const { company: book, vouchers } = await store.get(id);
  const expected = ledgerReport(book, vouchers, "l-cash", "2026-04-01", "2026-04-30");
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(body[key], value, key);
});
