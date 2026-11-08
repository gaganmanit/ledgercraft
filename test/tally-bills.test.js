import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { previewTally, restoreTallyArchive, hash } from "../lib/tally-import.js";
import { activateTallyBillReferences, planTallyBillReferences } from "../lib/tally-bills.js";
import { billReport, mutateReconciliation } from "../lib/reconciliation.js";
import { exportTallyMasters } from "../lib/tally-export.js";
import { start } from "../server.js";

const options = { companyName: "Synthetic imported bill books", booksFrom: "2026-04-01" };
async function files() {
  return Promise.all(["BillMasters.xml", "BillVouchers.xml"].map(async name => ({ name, base64: (await readFile(new URL(`fixtures/tally/${name}`, import.meta.url))).toString("base64") })));
}
function edit(source, name, change) {
  return source.map(file => file.name === name ? { ...file, base64: Buffer.from(change(Buffer.from(file.base64, "base64").toString("utf8"))).toString("base64") } : file);
}
const reportOf = preview => billReport(preview.company.reconciliation, preview.company, preview.vouchers, "2026-05-15");
function archiveOf(preview) {
  return { format: "financer-tally-archive", version: 1, company: preview.company, vouchers: preview.vouchers, sources: preview.sources, records: preview.records, sourceBookHash: null };
}

test("Tally debtor/creditor references, opening bill dates and partial settlements activate without changing postings", async () => {
  const input = await files(), original = structuredClone(input);
  const preview = previewTally(input, options);
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
  assert.equal(preview.summary.billReferences.billsReady, 4);
  assert.equal(preview.summary.billReferences.allocationsReady, 2);
  assert.equal(preview.summary.billReferences.openingBillsReady, 2);
  assert.equal(preview.summary.billReferences.exceptions, 0);
  const report = reportOf(preview);
  const rows = Object.fromEntries(report.rows.map(row => [row.reference, row]));
  assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([key,row]) => [key,row.openPaise])), { "OLD-C": 4000, "OLD-P": 5000, "PUR-1": 7000, "INV-1": 20000 });
  assert.equal(rows["OLD-C"].date, "2026-03-01");
  assert.equal(rows["OLD-C"].dueDate, "2026-03-31");
  assert.equal(rows["OLD-C"].bucket, "31–60");
  assert.equal(rows["INV-1"].dueDate, "2026-05-02");
  assert.equal(rows["PUR-1"].side, "payable");
  assert.ok(report.totals.every(row => row.differencePaise === 0));
  assert.equal(preview.summary.reconciliation.postedDebitPaise, preview.summary.reconciliation.sourceDebitPaise);
  assert.deepEqual(input, original);
  assert.ok(!JSON.stringify(preview.records).includes('"origin"'));
  assert.match(exportTallyMasters(preview.company), /<REPORTNAME>All Masters<\/REPORTNAME>/);
});

test("unresolved, overpaid, unknown-term and contradictory source bill rows remain explicit exceptions", async () => {
  const source = await files();
  const cases = [
    edit(source, "BillVouchers.xml", xml => xml.replace('<NAME>OLD-C</NAME><BILLTYPE>Agst Ref</BILLTYPE>', '<NAME>MISSING</NAME><BILLTYPE>Agst Ref</BILLTYPE>')),
    edit(source, "BillVouchers.xml", xml => xml.replaceAll('60.00', '160.00')),
    edit(source, "BillVouchers.xml", xml => xml.replace('<BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD>', '<BILLCREDITPERIOD>Thirty days</BILLCREDITPERIOD>')),
    edit(source, "BillVouchers.xml", xml => xml.replace('<BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>60.00</AMOUNT>', '<BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>-60.00</AMOUNT>')),
    edit(source, "BillMasters.xml", xml => xml.replace('<BILLDATE>20260301</BILLDATE>', '<BILLDATE>20260402</BILLDATE>')),
  ];
  for (const input of cases) {
    const preview = previewTally(input, options);
    assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
    assert.ok(preview.summary.billReferences.exceptions > 0);
    assert.ok(preview.issues.some(issue => issue.code === "bill-reference-retained"));
    assert.ok(reportOf(preview).totals.every(row => row.differencePaise === 0));
  }
});

test("duplicate named references and mixed or over-net opening breakups are preserved for review", async () => {
  const source = await files();
  const duplicate = edit(source, "BillVouchers.xml", xml => {
    const sale = xml.match(/<VOUCHER VCHTYPE="Sales">[\s\S]*?<\/VOUCHER>/)[0].replace('synthetic-bill-sale','synthetic-bill-sale-2').replace('<VOUCHERNUMBER>S-1</VOUCHERNUMBER>','<VOUCHERNUMBER>S-2</VOUCHERNUMBER>');
    return xml.replace('</TALLYMESSAGE>', sale + '</TALLYMESSAGE>');
  });
  const preview = previewTally(duplicate, options);
  assert.equal(preview.canCommit, true);
  assert.equal(reportOf(preview).rows.filter(row => row.reference === "INV-1").length, 0);
  assert.equal(preview.summary.billReferences.exceptions, 2);
  const opening = previewTally(edit(source, "BillMasters.xml", xml => xml.replace('<OPENINGBALANCE>-100.00</OPENINGBALANCE><BILLCREDITPERIOD>', '<OPENINGBALANCE>-200.00</OPENINGBALANCE><BILLCREDITPERIOD>')), options);
  assert.ok(opening.summary.billReferences.exceptions > 0);
  assert.ok(reportOf(opening).totals.every(row => row.differencePaise === 0));
});

test("activation is retry-safe and deliberately removed links are retained as removed after restore", async () => {
  const preview = previewTally(await files(), options);
  const company = { ...preview.company, reconciliation: undefined };
  const records = structuredClone(preview.records), vouchers = structuredClone(preview.vouchers);
  const plan = planTallyBillReferences(company, vouchers, records);
  const input = { revision: 0, reviewHash: plan.reviewHash, requestId: crypto.randomUUID() };
  const first = activateTallyBillReferences(undefined, { company, vouchers }, records, input);
  const second = activateTallyBillReferences(first.section, { company, vouchers }, records, input);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.section, first.section);
  const allocation = first.section.allocations[0];
  const removed = mutateReconciliation(first.section, { company: { ...company, reconciliation: first.section }, vouchers }, "unallocate-bill", { revision: 1, requestId: crypto.randomUUID(), allocationId: allocation.id }).section;
  const next = activateTallyBillReferences(removed, { company, vouchers }, records, { revision: removed.revision, requestId: crypto.randomUUID() });
  assert.equal(next.section.allocations.length, 1);
  assert.equal(next.report.rows.filter(row => row.status === "removed").length, 1);
  const restored = restoreTallyArchive(archiveOf({ ...preview, company: { ...company, reconciliation: next.section } }));
  assert.deepEqual(restored.company.reconciliation, next.section);
  assert.deepEqual(vouchers, preview.vouchers);
  assert.deepEqual(records, preview.records);
});

test("identical copied source files do not duplicate active bills and full archives restore every original copy", async () => {
  const source = await files();
  const preview = previewTally([...source, { ...source[1], name: "BillVouchers-copy.xml" }], options);
  assert.equal(preview.canCommit, true);
  assert.equal(preview.vouchers.length, 4);
  assert.equal(preview.company.reconciliation.bills.length, 4);
  assert.equal(preview.company.reconciliation.allocations.length, 2);
  const restored = restoreTallyArchive(archiveOf(preview));
  assert.equal(restored.sources.length, 3);
  assert.deepEqual(restored.sources.map(source => source.sha256), preview.sources.map(source => source.sha256));
});

test("legacy-source HTTP review/activation is serialized, stale-safe and retained in full backup/restore", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "financer-tally-bills-"));
  const server = await start({ port: 0, dataDir: dir });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (endpoint, body, method = "POST", expected = 200) => {
    const response = await fetch(base + endpoint, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  };
  try {
    const raw = previewTally(await files(), options);
    delete raw.company.reconciliation;
    const staged = await post("/api/tally/preview", { archive: archiveOf(raw) });
    const created = await post("/api/tally/commit", { token: staged.token, acknowledge: true }, "POST", 201);
    const id = created.company.id, api = `/api/tally/companies/${id}/bills`;
    const review = await (await fetch(base + api)).json();
    assert.equal(review.summary.billsReady, 4);
    assert.equal(review.summary.allocationsReady, 2);
    const input = { revision: review.revision, reviewHash: review.reviewHash, requestId: crypto.randomUUID() };
    const saved = await post(api + "/activate", input);
    assert.equal(saved.result.activatedBills, 4);
    const replay = await post(api + "/activate", input);
    assert.equal(replay.replayed, true);
    const current = await (await fetch(base + `/api/companies/${id}`)).json();
    assert.equal(current.company.reconciliation.audit.length, 1);
    assert.deepEqual(current.vouchers, created.vouchers);
    const backup = await (await fetch(base + `/api/companies/${id}/backup`)).json();
    const restored = restoreTallyArchive(backup);
    assert.equal(restored.company.reconciliation.bills.length, 4);
    assert.equal(restored.company.reconciliation.allocations.length, 2);
    assert.deepEqual(restored.sources.map(file => file.sha256), raw.sources.map(file => file.sha256));
    const sourceBytes = await (await fetch(base + `/api/tally/companies/${id}/file/0`)).arrayBuffer();
    assert.equal(hash(Buffer.from(sourceBytes)), raw.sources[0].sha256);
    const masters = await fetch(base + `/api/tally/companies/${id}/export/masters`);
    assert.equal(masters.status, 200);
    assert.match(await masters.text(), /All Masters/);
    await post(api + "/activate", { ...input, requestId: crypto.randomUUID() }, "POST", 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
