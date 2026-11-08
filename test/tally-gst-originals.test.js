import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reservedGroups } from "../lib/groups.js";
import { saveRegistration, saveParty, saveItem, buildGstInvoice, gstVoucher, gstinCheckDigit } from "../lib/gst.js";
import { tallyGstOriginalInvoicePage, planTallyGstPromotion, saveTallyGstMapping } from "../lib/tally-gst.js";
import { handleTallyRoute } from "../lib/tally-routes.js";

const gstin = pan => { const prefix = `23${pan}1Z`; return prefix + gstinCheckDigit(prefix); };
function fixture(count = 1000) {
  const company = { id: "catalog-fixture", name: "Synthetic original catalog", booksFrom: "2026-04-01", groups: reservedGroups(), ledgers: [] };
  const registration = saveRegistration(company, { name: "Own", gstin: gstin("ABCDE1234F"), stateCode: "23", address: "Synthetic catalog evidence" });
  const party = saveParty(company, { name: "Buyer", gstin: gstin("PQRST5678L"), stateCode: "23", address: "Synthetic buyer", kind: "customer" });
  const item = saveItem(company, { name: "Service", kind: "service", hsnSac: "998599", unit: "OTH", gstRateBps: 1800 });
  const invoice = buildGstInvoice(company, [], { type: "Sales", number: "CAT-0000", registrationId: registration.id, partyId: party.id, date: "2026-04-01", placeOfSupply: "23", stockEffect: "none", items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000 }] }, "v-catalog-0000");
  const vouchers = Array.from({ length: count }, (_, index) => {
    const row = structuredClone(invoice);
    row.id = row.voucherId = `v-catalog-${String(index).padStart(4, "0")}`;
    row.number = `CAT-${String(index).padStart(4, "0")}`;
    // A read catalog must never copy arbitrary source/transport payloads.
    row.transport = { privateProof: "DO-NOT-SERIALIZE-RAW-SOURCE".repeat(300) };
    return gstVoucher(row);
  });
  return { company, vouchers, party, registration };
}

test("1000 original invoices produce a bounded 20-row catalog without raw source or full snapshots", () => {
  const { company, vouchers, party, registration } = fixture();
  const report = planTallyGstPromotion(company, vouchers, []);
  assert.equal(report.originalInvoiceCount, 1000);
  assert.deepEqual(report.originalInvoices, []);
  const page = tallyGstOriginalInvoicePage(vouchers, { direction: "sales", partyId: party.id, registrationId: registration.id, partyLedgerId: party.customerLedgerId });
  assert.equal(page.rows.length, 20);
  assert.deepEqual(page.page, { offset: 0, limit: 20, total: 1000 });
  assert.equal(page.selectedInvoice, null);
  assert.ok(page.rows.every(row => row.items === undefined && row.tallyOrigin === undefined && row.transport === undefined));
  const bytes = Buffer.byteLength(JSON.stringify(page));
  assert.ok(bytes < 25000, `Catalog page unexpectedly contains ${bytes} bytes`);
  assert.ok(!JSON.stringify(page).includes("DO-NOT-SERIALIZE"));
  const all = [];
  for (let offset = 0; offset < 1000; offset += 20) all.push(...tallyGstOriginalInvoicePage(vouchers, { offset }).rows.map(row => row.id));
  assert.equal(new Set(all).size, 1000, "Every original remains reachable without a source reference");
});

test("search and paging retain one selected original detail outside the search result", () => {
  const { vouchers, party } = fixture();
  const selected = vouchers[999].id;
  const page = tallyGstOriginalInvoicePage(vouchers, { q: "CAT-0001", selected, partyId: party.id, offset: "999999" });
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].number, "CAT-0001");
  assert.equal(page.page.offset, 0);
  assert.equal(page.selectedInvoice.id, selected);
  assert.equal(page.selectedInvoice.items.length, 1);
  assert.equal(page.selectedInvoice.items[0].hsnSac, "998599");
  assert.equal(page.selectedInvoice.transport, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 5000);
  assert.equal(tallyGstOriginalInvoicePage(vouchers, { direction: "purchase", selected }).selectedInvoice, null);
  assert.throws(() => tallyGstOriginalInvoicePage(vouchers, { offset: "-1" }), /valid original invoice search/);
  assert.throws(() => tallyGstOriginalInvoicePage(vouchers, { q: "x".repeat(201) }), /valid original invoice search/);
});

test("HTTP desk and original lookup share the current review hash and stay bounded for 1000 originals", async () => {
  const book = fixture(), dataDir = await mkdtemp(path.join(tmpdir(), "ledgercraft-catalog-"));
  const folder = path.join(dataDir, "companies", book.company.id, "tally-source");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "records.json"), "[]");
  const store = { snapshot: async () => book };
  async function get(suffix) {
    const url = new URL(`http://localhost/api/tally/companies/${book.company.id}/gst${suffix}`);
    let response;
    const handled = await handleTallyRoute({ req: { method: "GET" }, res: {}, url, parts: url.pathname.slice(1).split("/"), dataDir, store, send: (_res, status, body) => { response = { status, body }; } });
    assert.equal(handled, true); assert.equal(response.status, 200);
    return response.body;
  }
  try {
    const desk = await get("?view=desk"), catalog = await get("/originals?q=CAT-0999&selected=v-catalog-0999");
    assert.deepEqual(desk.originalInvoices, []);
    assert.equal(desk.originalInvoiceCount, 1000);
    assert.equal(catalog.reviewHash, desk.reviewHash);
    assert.equal(catalog.sourceHash, desk.sourceHash);
    assert.equal(catalog.revision, desk.revision);
    assert.equal(catalog.rows[0].id, "v-catalog-0999");
    assert.equal(catalog.selectedInvoice.items.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(desk)) < 30000);
    assert.ok(Buffer.byteLength(JSON.stringify(catalog)) < 5000);
    const unfiltered = await get("/originals?offset=980");
    assert.equal(unfiltered.rows.length, 20); assert.equal(unfiltered.page.offset, 980);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});


test("a selected catalog original is revalidated before saving a note mapping", () => {
  const book = fixture(1), original = book.vouchers[0];
  original.gst.items[0].taxablePaise++;
  assert.equal(tallyGstOriginalInvoicePage(book.vouchers).rows.length, 1, "Catalog reads do not repeatedly rebuild unused snapshots");
  const record = { type: "VOUCHER", disposition: "voucher", recordId: "r-note-catalog", node: { tag: "VOUCHER", attrs: {}, text: "", children: [] } };
  assert.throws(() => saveTallyGstMapping(book.company, book.vouchers, [record], {
    recordId: record.recordId, registrationId: book.registration.id, partyId: book.party.id, items: [],
    accounts: { party: book.party.customerLedgerId, sales: book.registration.accounts.sales },
    noteReview: { direction: "sales", originalInvoiceId: original.id, originalNumber: original.number, originalDate: original.date, stockEffect: "none", lines: [{ originalLineIndex: 0, quantity: "1", unitPricePaise: 10000, discountBps: 0 }] },
    evidence: { name: "Synthetic catalog selection", reference: "Selected source original must still pass its actual snapshot validation" },
    revision: 0, requestId: "catalog-write-recheck-00001",
  }), /saved tax calculation/);
  assert.equal(book.company.gst.tallyPromotion, undefined);
});
