import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { previewTally, restoreTallyArchive, hash } from "../lib/tally-import.js";
import { exportTallyDayBook, exportTallyMasters } from "../lib/tally-export.js";
import { activateTallyStockProjection, planTallyStockProjection, tallyStockPostingHash } from "../lib/tally-stock.js";
import { stockState, stockPeriod } from "../lib/stock-engine.js";
import { start } from "../server.js";

const options = { companyName: "Synthetic Tally stock books", booksFrom: "2026-04-01" };
const file = (name, text) => ({ name, base64: Buffer.from(text).toString("base64") });
async function files() {
  return Promise.all(["StockMasters.xml", "StockVouchers.xml"].map(async name => file(name, await readFile(new URL(`fixtures/tally/${name}`, import.meta.url)))));
}
const archiveOf = preview => ({ format: "financer-tally-archive", version: 1, company: preview.company, vouchers: preview.vouchers, sources: preview.sources, records: preview.records, sourceBookHash: null });
test("new mixed invoices post independently proven goods stock and old archives retain their earlier baseline",async()=>{
  const name="tally-service-cycle.xml", xml=await readFile(new URL("./fixtures/"+name,import.meta.url),"utf8");
  const options={companyName:"Service baseline compatibility",booksFrom:"2026-04-01"};
  const modern=previewTally([file(name,xml)],options);
  assert.equal(modern.company.stock.tally.version,2);
  assert.deepEqual(modern.company.stock.journals.map(j=>j.number),["MS-102","MP-202"]);
  assert.deepEqual(restoreTallyArchive(archiveOf(modern)).company.stock,modern.company.stock);
  const older=previewTally([file(name,xml)],options,1);
  assert.equal(older.company.stock.tally.version,1);
  assert.equal(older.company.stock.tally.baselineHash,"ac736dae8859e8726560855f6456f211d6cbbc813636f53dcd62ecd282e07ee4");
  assert.deepEqual(older.company.stock.journals.map(j=>j.number),["MP-202"]);
  assert.deepEqual(restoreTallyArchive(archiveOf(older)).company.stock,older.company.stock);
  const mismatch=xml.replace(/(<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Goods Sales<\/LEDGERNAME>.*?<AMOUNT>)1000.00/,"$1"+"999.00");
  assert.notEqual(mismatch,xml);
  const held=previewTally([file(name,mismatch)],options);
  assert.ok(held.company.stock.tally.sourceGaps.some(g=>g.message.includes("MS-102")));
});
function edit(source, name, change) {
  return source.map(entry => entry.name === name ? file(name, change(Buffer.from(entry.base64, "base64").toString("utf8"))) : entry);
}
const reportOf = preview => stockState(preview.company, preview.vouchers, { to: "2026-04-30" });

test("Tally source-native items, godown openings, invoices and quantity transfers share the cost engine", async () => {
  const source = await files(), original = structuredClone(source);
  const preview = previewTally(source, options);
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
  assert.equal(preview.summary.stockProjection.items, 1);
  assert.equal(preview.summary.stockProjection.journals, 3);
  assert.equal(preview.summary.stockProjection.exceptions, 0);
  assert.equal(preview.company.gst, undefined, "No GST/tax facts are invented for stock masters");
  const report = reportOf(preview), item = report.items[0];
  assert.equal(item.quantity, "11");
  assert.equal(item.valuePaise, 95000);
  assert.equal(report.totals.complete, true);
  const period = stockPeriod(preview.company, preview.vouchers, { from: "2026-04-01", to: "2026-04-30" });
  assert.equal(period.financial.netPurchasesPaise, 15000);
  assert.equal(period.financial.costOfGoodsSoldPaise, 20000, "Selling price does not supply inventory cost");
  assert.deepEqual(source, original);
  const restored = restoreTallyArchive(archiveOf(preview));
  assert.deepEqual(restored.company.stock, preview.company.stock);
  assert.deepEqual(reportOf(restored), report);
});

test("stock XML re-export roundtrips quantities, cost and godown allocations without duplicate ledger postings", async () => {
  const preview = previewTally(await files(), options);
  const masters = exportTallyMasters(preview.company), daybook = exportTallyDayBook(preview.company, preview.vouchers, "2026-04-01", "2026-04-30");
  assert.match(masters, /<UNIT /);
  assert.match(masters, /<GODOWN /);
  assert.match(masters, /<COSTINGMETHOD>FIFO Perpetual<\/COSTINGMETHOD>/);
  assert.match(daybook, /INVENTORYENTRIESIN.LIST/);
  const again = previewTally([file("masters.xml", masters), file("daybook.xml", daybook)], options);
  assert.equal(again.canCommit, true, JSON.stringify(again.issues));
  assert.equal(again.vouchers.length, preview.vouchers.length);
  assert.equal(again.summary.stockProjection.journals, 3, JSON.stringify(again.issues));
  assert.equal(reportOf(again).items[0].quantity, "11");
  assert.equal(reportOf(again).items[0].valuePaise, 95000);
  assert.deepEqual(again.summary.reconciliation.postedDebitPaise, preview.summary.reconciliation.postedDebitPaise);
  const average = structuredClone(preview.company);
  average.stock.items[average.stock.masters[0].id].costingMethod = "moving-average";
  assert.throws(() => exportTallyMasters(average), /not Tally's annual\/monthly Average Cost/);
});

test("unsupported units, valuation, named batches, unknown godowns and mismatched openings stay explicit", async () => {
  const source = await files();
  const cases = [
    edit(source, "StockMasters.xml", xml => xml.replace("<ISSIMPLEUNIT>Yes", "<ISSIMPLEUNIT>No")),
    edit(source, "StockMasters.xml", xml => xml.replace("FIFO Perpetual", "LIFO Perpetual")),
    edit(source, "StockMasters.xml", xml => xml.replace("<BATCHNAME>Primary Batch</BATCHNAME>", "<BATCHNAME>Private lot</BATCHNAME><EXPIRYPERIOD>1 Year</EXPIRYPERIOD>")),
    edit(source, "StockMasters.xml", xml => xml.replace("<GODOWNNAME>Workshop", "<GODOWNNAME>Missing")),
    edit(source, "StockMasters.xml", xml => xml.replace("<OPENINGBALANCE>4 nos", "<OPENINGBALANCE>5 nos")),
    edit(source, "StockVouchers.xml", xml => xml.replace("<ACTUALQTY>4 nos", "<ACTUALQTY>5 nos")),
    edit(source, "StockVouchers.xml", xml => xml.replace("<AMOUNT>-150.00</AMOUNT><BATCHALLOCATIONS", "<AMOUNT>150.00</AMOUNT><BATCHALLOCATIONS")),
    edit(source, "StockVouchers.xml", xml => xml.replace('<GUID>synthetic-stock-transfer</GUID>', '<GUID>synthetic-stock-transfer</GUID><ISCANCELLED>maybe</ISCANCELLED>')),
  ];
  for (const input of cases) {
    const preview = previewTally(input, options);
    assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
    assert.ok(preview.summary.stockProjection.exceptions > 0);
    assert.ok(preview.issues.some(issue => issue.code === "tally-stock-source-exception"));
    assert.equal(preview.vouchers.length, 2, "Stock exceptions do not alter the accounting projection");
    assert.equal(preview.company.stock.tally.hasSourceGaps, true);
    assert.equal(reportOf(preview).totals.complete, false, "Omitted source stock cannot create a complete understated balance");
    assert.equal(reportOf(preview).totals.valuePaise, null);
    assert.deepEqual(restoreTallyArchive(archiveOf(preview)).company.stock, preview.company.stock);
  }
  // Tally Average Cost and a named batch were exceptions before; they now import (with a disclosure for the average).
  const average = previewTally(edit(source, "StockMasters.xml", xml => xml.replace("FIFO Perpetual", "Average Cost")), options);
  assert.equal(average.summary.stockProjection.exceptions, 0);
  assert.ok(average.issues.some(issue => issue.code === "tally-costing-mapped" && issue.severity === "info"));
  assert.equal(reportOf(average).totals.complete, true);
  const named = previewTally(edit(source, "StockMasters.xml", xml => xml.replace("Primary Batch", "Private lot")), options);
  assert.equal(named.summary.stockProjection.exceptions, 0, JSON.stringify(named.issues));
  assert.deepEqual(reportOf(named).items[0].batches.map(row => row.name), ["Private lot"]);
  assert.equal(reportOf(named).items[0].quantity, "11");
});

test("copied originals do not duplicate inventory and missing opening costs remain incomplete", async () => {
  const source = await files();
  const copied = previewTally([...source, { ...source[1], name: "copied-vouchers.xml" }], options);
  assert.equal(copied.canCommit, true);
  assert.equal(copied.company.stock.journals.length, 3);
  assert.equal(reportOf(copied).items[0].quantity, "11");
  assert.deepEqual(restoreTallyArchive(archiveOf(copied)).company.stock, copied.company.stock);
  const missing = previewTally(edit(source, "StockMasters.xml", xml => xml.replaceAll(/<OPENINGVALUE>[^<]+<\/OPENINGVALUE>/g, "")), options);
  assert.equal(missing.canCommit, true);
  assert.equal(reportOf(missing).items[0].quantity, "11");
  assert.equal(reportOf(missing).items[0].valuePaise, null);
  assert.equal(reportOf(missing).totals.complete, false);
});

test("earlier imports merge independent operator stock settings, reject collisions and cannot duplicate activation", async () => {
  const preview = previewTally(await files(), options), company = structuredClone(preview.company);
  company.stock = { version: 1, revision: 4, integrateAccounts: false, masters: [{ id: "existing", name: "Existing operator item", unit: "box", openingQuantity: "0" }],
    godowns: [{ id: "main", name: "Main Location" }, { id: "operator-room", name: "Operator room" }], items: { existing: { costingMethod: "moving-average", openingValuePaise: 0, openingAllocations: [] } }, journals: [] };
  const plan = planTallyStockProjection(company, preview.vouchers, preview.records);
  assert.equal(plan.canActivate, true);
  const input = { reviewHash: plan.reviewHash, requestId: crypto.randomUUID() };
  const saved = activateTallyStockProjection(company.stock, { company, vouchers: preview.vouchers }, preview.records, input);
  assert.equal(saved.section.revision, 5);
  assert.equal(saved.section.godowns.find(row => row.id === "operator-room").name, "Operator room");
  assert.deepEqual(saved.section.items.existing, company.stock.items.existing);
  const repeated = activateTallyStockProjection(saved.section, { company, vouchers: preview.vouchers }, preview.records, input);
  assert.equal(repeated.replayed, true);
  assert.equal(repeated.section.journals.length, 3);
  assert.throws(() => activateTallyStockProjection(company.stock, { company, vouchers: preview.vouchers }, preview.records, { ...input, reviewHash: "0".repeat(64) }), /books changed/);
  const collision = structuredClone(company);
  collision.stock.masters[0].name = "Synthetic Widget";
  assert.equal(planTallyStockProjection(collision, preview.vouchers, preview.records).canActivate, false);
  const edited = structuredClone(preview.vouchers);
  edited[0].date = "2026-04-02";
  assert.ok(planTallyStockProjection(company, edited, preview.records).rows.some(row => row.message.includes("changed or was removed")));
  assert.equal(planTallyStockProjection(company, edited, preview.records).canActivate, false);
});

test("restore rejects stock source/baseline tampering and preserves deliberate sign review", async () => {
  const source = await files();
  const conflict = edit(source, "StockVouchers.xml", xml => xml.replace(/(<LEDGERNAME>Cash<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>)-500.00/, "$1500.00").replace(/(<LEDGERNAME>Sales<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>)500.00/, "$1-500.00"));
  // A balanced contradictory sign pair requires explicit operator selection.
  const first = previewTally(conflict, options);
  const signConflict = first.issues.find(issue => issue.code === "posting-sign-conflict");
  assert.ok(signConflict);
  const reviewed = previewTally(conflict, { ...options, signChoices: { [signConflict.reference]: "debit-credit-flags" } });
  assert.equal(reviewed.canCommit, true, JSON.stringify(reviewed.issues));
  assert.deepEqual(restoreTallyArchive(archiveOf(reviewed)).company.stock, reviewed.company.stock);
  for (const mutate of [
    input => { input.company.stock.tally.baselineHash = "0".repeat(64); },
    input => { input.company.stock.tally.itemDetails[0].precision = 6; },
    input => { input.company.stock.tally.sourceGaps = [{ code: "invented", reference: "invented", message: "invented" }]; },
    input => { input.company.stock.journals[0].lines[0].quantity = "1"; },
    input => { input.company.stock.masters[0].openingQuantity = "11"; input.company.stock.items[input.company.stock.masters[0].id].openingAllocations[0].quantity = "7"; },
  ]) {
    const input = archiveOf(structuredClone(reviewed));
    mutate(input);
    assert.throws(() => restoreTallyArchive(input), /stock.*(source|baseline)|imported stock/i);
  }
  const voucher = reviewed.vouchers[0];
  assert.equal(tallyStockPostingHash(voucher), tallyStockPostingHash({ ...voucher, number: "renumbered", narration: "new note", lines: [...voucher.lines].reverse() }));
});

test("normal HTTP import, stock review, earlier-company activation and ordinary backup/restore retain exact originals", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "financer-tally-stock-"));
  const server = await start({ port: 0, dataDir: dir }), base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body, status = 200) => {
    const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result)); return result;
  };
  try {
    const input = await files();
    const staged = await post("/api/tally/preview", { ...options, files: input });
    assert.equal(staged.summary.stockProjection.journals, 3);
    const created = await post("/api/tally/commit", { token: staged.token, acknowledge: true }, 201);
    const defaultDayBook = await (await fetch(base + `/api/tally/companies/${created.company.id}/export/daybook`)).text();
    assert.match(defaultDayBook, /<VOUCHERTYPENAME>Stock Journal<\/VOUCHERTYPENAME>/, "Default export includes stock journals later than the last accounting voucher");
    const api = `/api/tally/companies/${created.company.id}/stock`;
    const review = await (await fetch(base + api)).json();
    assert.equal(review.summary.alreadyActive, true);
    const backup = await (await fetch(base + `/api/companies/${created.company.id}/backup`)).json();
    const restored = await post("/api/import", backup, 201);
    assert.deepEqual(restored.company.stock, created.company.stock);
    const original = await (await fetch(base + `/api/tally/companies/${restored.company.id}/file/0`)).arrayBuffer();
    assert.equal(hash(Buffer.from(original)), hash(Buffer.from(input[0].base64, "base64")));
    const legacy = previewTally(input, options);
    delete legacy.company.stock;
    const olderPreview = await post("/api/tally/preview", { archive: archiveOf(legacy) });
    const older = await post("/api/tally/commit", { token: olderPreview.token, acknowledge: true }, 201);
    const endpoint = `/api/tally/companies/${older.company.id}/stock`;
    const ready = await (await fetch(base + endpoint)).json();
    assert.equal(ready.canActivate, true);
    const change = { reviewHash: ready.reviewHash, requestId: crypto.randomUUID() };
    assert.equal((await post(endpoint + "/activate", change)).replayed, false);
    assert.equal((await post(endpoint + "/activate", change)).replayed, true);
    const current = await (await fetch(base + `/api/companies/${older.company.id}`)).json();
    assert.equal(reportOf(current).items[0].valuePaise, 95000);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty stock source reviews require archived-source reparse and survive normal import/restore", async () => {
  const input = [file("empty-stock-masters.xml", '<ENVELOPE><BODY><DATA><TALLYMESSAGE><LEDGER NAME="Cash"><PARENT>Cash-in-Hand</PARENT></LEDGER></TALLYMESSAGE></DATA></BODY></ENVELOPE>')];
  const parsed = previewTally(input, options);
  assert.equal(parsed.canCommit, true);
  assert.equal(parsed.summary.stockProjection.emptySource, true);
  assert.equal(parsed.company.stock.tally.emptySourceReview, true, "Newly parsed empty sources are marked automatically");
  assert.deepEqual(restoreTallyArchive(archiveOf(parsed)).company.stock, parsed.company.stock);
  const legacy = structuredClone(parsed);
  delete legacy.company.stock;
  const dir = await mkdtemp(path.join(tmpdir(), "financer-tally-empty-stock-"));
  const server = await start({ port: 0, dataDir: dir }), base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body, status = 200) => {
    const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result)); return result;
  };
  try {
    const staged = await post("/api/tally/preview", { archive: archiveOf(legacy) });
    const created = await post("/api/tally/commit", { token: staged.token, acknowledge: true }, 201);
    const endpoint = `/api/tally/companies/${created.company.id}/stock`;
    const review = await (await fetch(base + endpoint)).json();
    assert.equal(review.canActivate, true);
    assert.equal(review.summary.emptySource, true);
    const recordsFile = path.join(dir, "companies", created.company.id, "tally-source", "records.json"), original = await readFile(recordsFile);
    const changed = JSON.parse(original);
    changed[0].node.children.push({ tag: "INVENTORYALLOCATIONS.LIST", attrs: {}, text: "", children: [] });
    await writeFile(recordsFile, JSON.stringify(changed));
    const request = { reviewHash: review.reviewHash, requestId: crypto.randomUUID() };
    const rejected = await post(endpoint + "/activate", request, 400);
    assert.match(rejected.error, /source record differs/);
    await writeFile(recordsFile, original);
    assert.equal((await post(endpoint + "/activate", request)).replayed, false);
    const backup = await (await fetch(base + `/api/companies/${created.company.id}/backup`)).json();
    const restored = await post("/api/import", backup, 201);
    assert.equal(restored.company.stock.tally.emptySourceReview, true);
    assert.equal(restored.company.stock.tally.hasSourceGaps, false);
    assert.equal(reportOf(restored).totals.complete, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("Ledgercraft restores historical Financer stock evidence and rejects altered costing text", async () => {
  for (const method of ["", "Average Cost"]) {
    const changed = edit(await files(), "StockMasters.xml", xml => xml.replace("FIFO Perpetual</COSTINGMETHOD>", method + "</COSTINGMETHOD>"));
    // Earlier versions rejected Average Cost; build that archive with the reading it was saved under.
    const archive = archiveOf(previewTally(changed, method ? { ...options, legacyStockAverageCost: true } : options));
    const gap = archive.company.stock.tally.sourceGaps.find(row => row.message.includes("Ledgercraft"));
    assert.ok(gap);
    gap.message = gap.message.replace("Ledgercraft", "Financer");
    assert.deepEqual(restoreTallyArchive(archive).company.stock, archive.company.stock);
    gap.message += " (altered)";
    assert.throws(() => restoreTallyArchive(archive), /baseline/);
  }
});

test("TallyPrime negative stock opening values import as normal debit stock and export with Tally's sign", async () => {
  const prime = file("TallyPrimeStockMasters.xml", await readFile(new URL("fixtures/tally/TallyPrimeStockMasters.xml", import.meta.url)));
  const vouchers = (await files())[1];
  const preview = previewTally([prime, vouchers], { ...options, companyName: "Synthetic Prime Traders" });
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
  assert.equal(preview.summary.stockProjection.items, 1);
  assert.equal(preview.summary.stockProjection.exceptions, 0, JSON.stringify(preview.issues.filter(issue => issue.code === "tally-stock-source-exception")));
  assert.equal(preview.company.stock.tally.hasSourceGaps, false);
  assert.ok(!preview.issues.some(issue => issue.code === "tally-stock-opening-value-sign"), "Tally's normal negative sign needs no review");
  const settings = preview.company.stock.items[preview.company.stock.masters[0].id];
  assert.equal(settings.openingValuePaise, 100000);
  assert.deepEqual(settings.openingAllocations.map(row => row.valuePaise), [60000, 40000]);
  const report = reportOf(preview);
  assert.equal(report.items[0].quantity, "11");
  assert.equal(report.items[0].valuePaise, 95000);
  assert.equal(report.totals.complete, true);

  const masters = exportTallyMasters(preview.company);
  assert.match(masters, /<OPENINGBALANCE>10 nos<\/OPENINGBALANCE><OPENINGVALUE>-1000\.00<\/OPENINGVALUE>/);
  assert.match(masters, /<OPENINGVALUE>-600\.00<\/OPENINGVALUE>/);
  assert.match(masters, /<OPENINGVALUE>-400\.00<\/OPENINGVALUE>/);
  assert.doesNotMatch(masters, /<OPENINGVALUE>\d/, "No stock opening value is exported with the credit sign");
  const daybook = exportTallyDayBook(preview.company, preview.vouchers, "2026-04-01", "2026-04-30");
  const again = previewTally([file("masters.xml", masters), file("daybook.xml", daybook)], options);
  assert.equal(again.canCommit, true, JSON.stringify(again.issues));
  assert.ok(!again.issues.some(issue => issue.code === "tally-stock-opening-value-sign"));
  assert.equal(reportOf(again).items[0].valuePaise, 95000);
});

test("a positive stock opening value keeps its magnitude but is flagged for review", async () => {
  const preview = previewTally(await files(), options);
  assert.equal(preview.canCommit, true);
  assert.equal(preview.summary.stockProjection.exceptions, 0);
  const flagged = preview.issues.filter(issue => issue.code === "tally-stock-opening-value-sign");
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].severity, "review");
  assert.match(flagged[0].message, /Synthetic Widget/);
  assert.equal(reportOf(preview).items[0].valuePaise, 95000);
  assert.deepEqual(restoreTallyArchive(archiveOf(preview)).company.stock, preview.company.stock);
});

test("archives made before the negative-sign rule still restore with their recorded stock gaps", async () => {
  const prime = file("TallyPrimeStockMasters.xml", await readFile(new URL("fixtures/tally/TallyPrimeStockMasters.xml", import.meta.url)));
  const source = [prime, (await files())[1]];
  const legacy = previewTally(source, { ...options, legacyStockOpeningSign: true });
  assert.equal(legacy.canCommit, true, JSON.stringify(legacy.issues));
  assert.ok(legacy.company.stock.tally.sourceGaps.some(gap => /Negative opening stock values require source review/.test(gap.message)));
  assert.deepEqual(restoreTallyArchive(archiveOf(legacy)).company.stock, legacy.company.stock);
});

test("Tally's \\u0004 Primary godown parent is a flat godown, while older archives keep their recorded hierarchy gap", async () => {
  const source = edit(await files(), "StockMasters.xml", xml => xml.replace("<PARENT>Primary</PARENT>", "<PARENT>&#4; Primary</PARENT>"));
  const preview = previewTally(source, options);
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
  assert.ok(!preview.issues.some(issue => issue.code === "tally-stock-godown-hierarchy"));
  assert.equal(preview.company.stock.tally.hasSourceGaps, false);
  assert.match(exportTallyMasters(preview.company), /<GODOWN NAME="Workshop"/);
  const legacy = previewTally(source, { ...options, legacyStockGodownParent: true });
  assert.ok(legacy.company.stock.tally.sourceGaps.some(gap => gap.code === "tally-stock-godown-hierarchy"));
  assert.deepEqual(restoreTallyArchive(archiveOf(legacy)).company.stock, legacy.company.stock);
  assert.deepEqual(restoreTallyArchive(archiveOf(preview)).company.stock, preview.company.stock);
});
