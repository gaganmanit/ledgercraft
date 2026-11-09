import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pageQuery, PAGE_LIMIT_MAX } from "../lib/engine.js";
import { gstRegister } from "../lib/book-routes.js";
import { start } from "../server.js";

async function withBooks(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledgercraft-paging-"));
  const server = await start({ port: 0, dataDir: dir });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, method = "GET", body) => {
    const response = await fetch(base + route, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const { body: created } = await call("/api/companies", "POST", { name: "Paging Mills", booksFrom: "2026-04-01" });
    const id = created.company.id;
    const { body: withSales } = await call(`/api/companies/${id}/ledgers`, "POST", { name: "Sales", groupId: "g-sales", openingPaise: 0, openingDc: "Cr" });
    const salesId = withSales.company.ledgers.find((ledger) => ledger.name === "Sales").id;
    const entry = (number, day, paise) => ({ type: "Receipt", date: `2026-04-${String(day).padStart(2, "0")}`, number, narration: "Counter", lines: [{ ledgerId: "l-cash", dc: "Dr", paise }, { ledgerId: salesId, dc: "Cr", paise }] });
    await run({ call, id, salesId, entry });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test("page queries: absent means the whole list, limit is cut to 500, bad values are refused", () => {
  assert.equal(pageQuery(new URLSearchParams("")), null);
  assert.deepEqual(pageQuery(new URLSearchParams("limit=20")), { offset: 0, limit: 20 });
  assert.deepEqual(pageQuery(new URLSearchParams("offset=40")), { offset: 40, limit: null });
  assert.deepEqual(pageQuery(new URLSearchParams("offset=5&limit=9000")), { offset: 5, limit: PAGE_LIMIT_MAX });
  assert.equal(PAGE_LIMIT_MAX, 500);
  assert.throws(() => pageQuery(new URLSearchParams("limit=0")), /page size from 1 to 500/);
  assert.throws(() => pageQuery(new URLSearchParams("offset=-1")), /page start/);
  assert.throws(() => pageQuery(new URLSearchParams("limit=ten")), /page size/);
});

test("day book and ledger pages carry rows, total, offset and limit while totals cover every row", () => withBooks(async ({ call, id, salesId, entry }) => {
  for (let day = 1; day <= 7; day += 1) assert.equal((await call(`/api/companies/${id}/vouchers`, "POST", entry(`RCT-${day}`, day, day * 1000))).status, 201);
  const period = "from=2026-04-01&to=2026-04-30";

  const whole = (await call(`/api/companies/${id}/reports/daybook?${period}`)).body;
  assert.deepEqual([whole.rows.length, whole.total, whole.offset, whole.limit, whole.totalPaise], [7, 7, 0, null, 28000]);
  assert.equal(whole.from, "2026-04-01");
  const page = (await call(`/api/companies/${id}/reports/daybook?${period}&offset=2&limit=3`)).body;
  assert.deepEqual(page.rows.map((row) => row.number), ["RCT-3", "RCT-4", "RCT-5"]);
  assert.deepEqual([page.total, page.offset, page.limit, page.totalPaise], [7, 2, 3, 28000]);
  const tail = (await call(`/api/companies/${id}/reports/daybook?${period}&offset=6`)).body;
  assert.deepEqual([tail.rows.length, tail.limit], [1, null]);
  assert.equal((await call(`/api/companies/${id}/reports/daybook?${period}&limit=0`)).status, 400);

  const ledger = (await call(`/api/companies/${id}/reports/ledger/l-cash?${period}`)).body;
  assert.equal(ledger.lines.length, 7);
  assert.deepEqual(ledger.rows, ledger.lines);
  assert.deepEqual([ledger.total, ledger.offset, ledger.limit], [7, 0, null]);
  assert.deepEqual(ledger.totals, { debitPaise: 28000, creditPaise: 0 });
  const second = (await call(`/api/companies/${id}/reports/ledger/l-cash?${period}&offset=3&limit=2`)).body;
  assert.deepEqual(second.rows.map((row) => row.number), ["RCT-4", "RCT-5"]);
  assert.deepEqual(second.lines, second.rows);
  assert.deepEqual(second.pageOpening, { paise: 6000, dc: "Dr" }, "balance brought forward to the first line of the page");
  assert.deepEqual(second.closing, ledger.closing);
  assert.deepEqual(second.opening, ledger.opening);
  assert.deepEqual(second.totals, ledger.totals);
  const first = (await call(`/api/companies/${id}/reports/ledger/${salesId}?${period}&limit=1`)).body;
  assert.deepEqual(first.pageOpening, first.opening);
  assert.equal((await call(`/api/companies/${id}/reports/ledger/l-none?${period}`)).status, 400);
}));

test("the GST register pages documents newest first with totals for every match", () => {
  const company = { id: "c-1", name: "Register Co", booksFrom: "2026-04-01" };
  const invoice = (n, date, type, taxable, tax, party = "Asha Stores") => ({ id: `v-${n}`, gst: { id: `v-${n}`, voucherId: `v-${n}`, number: `INV-${n}`, date, type, direction: "sales", registrationId: "r-1", party: { id: "p-1", name: party, gstin: "23AAAAA0000A1Z5" }, narration: "", totals: { taxablePaise: taxable, taxPaise: tax, totalPaise: taxable + tax } } });
  const vouchers = [invoice(1, "2026-04-02", "Sales", 10000, 1800), invoice(2, "2026-04-05", "Sales", 20000, 3600, "Bharat Traders"), invoice(3, "2026-05-01", "Credit Note", 5000, 900), { id: "v-plain", lines: [] }];
  const all = gstRegister(company, vouchers, {});
  assert.deepEqual(all.rows.map((row) => row.number), ["INV-3", "INV-2", "INV-1"]);
  assert.deepEqual([all.total, all.offset, all.limit], [3, 0, null]);
  assert.deepEqual(all.totals, { taxablePaise: 35000, taxPaise: 6300, amountDuePaise: 41300 });
  const april = gstRegister(company, vouchers, { from: "2026-04-01", to: "2026-04-30", page: { offset: 1, limit: 1 } });
  assert.deepEqual(april.rows.map((row) => row.number), ["INV-1"]);
  assert.deepEqual([april.total, april.offset, april.limit], [2, 1, 1]);
  assert.deepEqual(april.totals, { taxablePaise: 30000, taxPaise: 5400, amountDuePaise: 35400 });
  assert.deepEqual(gstRegister(company, vouchers, { q: "bharat" }).rows.map((row) => row.number), ["INV-2"]);
  assert.deepEqual(gstRegister(company, vouchers, { type: "Credit Note" }).rows.map((row) => row.number), ["INV-3"]);
  assert.throws(() => gstRegister(company, vouchers, { from: "2026-05-01", to: "2026-04-01" }), /register period/);
});

test("the GST register endpoint answers with the paged shape", () => withBooks(async ({ call, id }) => {
  const register = await call(`/api/companies/${id}/gst-register?limit=10`);
  assert.equal(register.status, 200);
  assert.deepEqual(register.body, { company: register.body.company, from: null, to: null, rows: [], total: 0, offset: 0, limit: 10, totals: { taxablePaise: 0, taxPaise: 0, amountDuePaise: 0 } });
  assert.equal(register.body.company.id, id);
}));

test("slim writes answer with the changed record, next numbers and the edit-log revision", () => withBooks(async ({ call, id, entry }) => {
  const slimKeys = (kind, extra = []) => ["company", kind, "nextNumbers", "revision", ...extra].sort();
  const full = await call(`/api/companies/${id}/vouchers`, "POST", entry("RCT-1", 2, 5000));
  assert.ok(Array.isArray(full.body.vouchers), "the default answer is still the whole book");
  assert.ok(Array.isArray(full.body.company.ledgers));
  const startRevision = full.body.revision;
  assert.ok(Number.isInteger(startRevision));

  const voucher = await call(`/api/companies/${id}/vouchers?slim=1`, "POST", entry("RCT-2", 3, 7000));
  assert.equal(voucher.status, 201);
  assert.deepEqual(Object.keys(voucher.body).sort(), slimKeys("voucher"));
  assert.deepEqual(voucher.body.company, { id, name: "Paging Mills", booksFrom: "2026-04-01" });
  assert.equal(voucher.body.voucher.number, "RCT-2");
  assert.equal(voucher.body.revision, startRevision + 1);
  assert.equal(typeof voucher.body.nextNumbers.Receipt, "string");

  const saved = voucher.body.voucher;
  const altered = await call(`/api/companies/${id}/vouchers/${saved.id}`, "PUT", { ...entry("RCT-2", 3, 7000), narration: "Corrected", slim: true, expected: saved });
  assert.equal(altered.status, 200);
  assert.deepEqual(Object.keys(altered.body).sort(), slimKeys("voucher"));
  assert.equal(altered.body.voucher.narration, "Corrected");
  assert.equal(altered.body.voucher.slim, undefined, "the slim flag is not saved");
  assert.equal(altered.body.revision, startRevision + 2);

  const ledger = await call(`/api/companies/${id}/ledgers`, "POST", { name: "Rent", groupId: "g-indirect-exp", openingPaise: 0, openingDc: "Dr", slim: true });
  assert.deepEqual(Object.keys(ledger.body).sort(), slimKeys("ledger"));
  assert.equal(ledger.body.ledger.name, "Rent");
  const renamed = await call(`/api/companies/${id}/ledgers/${ledger.body.ledger.id}?slim=1`, "PUT", { name: "Office rent", groupId: "g-indirect-exp" });
  assert.equal(renamed.body.ledger.name, "Office rent");
  const ledgerGone = await call(`/api/companies/${id}/ledgers/${ledger.body.ledger.id}?slim=1`, "DELETE", {});
  assert.deepEqual(Object.keys(ledgerGone.body).sort(), slimKeys("ledger", ["removed"]));
  assert.equal(ledgerGone.body.removed, true);

  const group = await call(`/api/companies/${id}/groups?slim=1`, "POST", { name: "Branch expenses", parentId: "g-indirect-exp" });
  assert.equal(group.status, 201);
  assert.deepEqual(Object.keys(group.body).sort(), slimKeys("group"));
  assert.equal(group.body.group.name, "Branch expenses");
  const groupRenamed = await call(`/api/companies/${id}/groups/${group.body.group.id}`, "PUT", { name: "Branch costs", slim: true });
  assert.equal(groupRenamed.body.group.name, "Branch costs");
  assert.equal((await call(`/api/companies/${id}/groups/${group.body.group.id}?slim=1`, "DELETE", {})).body.removed, true);

  const removed = await call(`/api/companies/${id}/vouchers/${saved.id}?slim=1`, "DELETE", { expected: altered.body.voucher });
  assert.deepEqual(Object.keys(removed.body).sort(), slimKeys("voucher", ["removed"]));
  assert.equal(removed.body.voucher.id, saved.id);

  const audit = await call(`/api/companies/${id}/audit`);
  assert.equal(audit.body.entries[0].seq, removed.body.revision, "revision is the edit-log sequence after the write");

  // A replayed save names the same voucher and does not move the revision.
  const requestId = "slim-replay-0000000001";
  const firstSave = await call(`/api/companies/${id}/vouchers?slim=1`, "POST", { ...entry("RCT-9", 9, 900), requestId });
  const replay = await call(`/api/companies/${id}/vouchers?slim=1`, "POST", { ...entry("RCT-9", 9, 900), requestId });
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.voucher.id, firstSave.body.voucher.id);
  assert.equal(replay.body.revision, firstSave.body.revision);
}));
