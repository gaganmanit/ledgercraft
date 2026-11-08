import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { decodeBase64, decodeTally, parseTallyXml, tallyRecords } from "../lib/tally-format.js";
import { hash, previewTally, restoreTallyArchive, tallyAmount } from "../lib/tally-import.js";
import { tallyRecordView } from "../lib/tally-read.js";
import { start } from "../server.js";

const options = { companyName: "Public example books", booksFrom: "2026-04-01" };
const fixture = (name) => readFile(new URL(`fixtures/tally/${name}`, import.meta.url));
async function files() {
  return Promise.all(["Masters.xml", "DayBook.xml"].map(async (name) => ({ name, base64: (await fixture(name)).toString("base64") })));
}

function nativeObject(node) {
  const result = {};
  for (const entry of node.children) {
    const key = entry.tag.toLowerCase().replace(/\.list$/, "");
    const item = entry.children.length ? nativeObject(entry) : entry.text.trim();
    if (entry.tag.endsWith(".LIST")) (result[key] ||= []).push(item);
    else result[key] = item;
  }
  return result;
}

test("public invoice structure, signs, inventory allocations and nonposting records reconcile", async () => {
  const preview = previewTally(await files(), options);
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
  assert.equal(preview.company.ledgers.length, 8);
  assert.equal(preview.vouchers.length, 2);
  assert.equal(preview.summary.reconciliation.sourceVouchers, 5);
  assert.equal(preview.summary.reconciliation.excludedVouchers, 3);
  assert.equal(preview.summary.reconciliation.postedDebitPaise, 2_164_625);
  assert.equal(preview.summary.reconciliation.postedCreditPaise, 2_164_625);
  assert.equal(preview.summary.trial.difference, 0);
  const sale = preview.vouchers.find((voucher) => voucher.type === "Sales");
  assert.equal(sale.lines.length, 5);
  assert.equal(sale.source.guid, "public-invoice-1");
  const source = tallyRecordView(preview.records.find((record) => record.voucherId === sale.id));
  assert.equal(source.inventory.length, 2);
  assert.equal(source.bills[0].BILLTYPE, "New Ref");
  assert.equal(source.batches[0].GODOWNNAME, "Main Location");
  assert.ok(JSON.stringify(source.original).includes("Original extension field retained"));
  const item = tallyRecordView(preview.records.find((record) => record.type === "STOCKITEM"));
  assert.deepEqual(item.hsn, ["8528"]);
  const payment = tallyRecordView(preview.records.find((record) => record.targetType === "Payment"));
  assert.equal(payment.banks[0].INSTRUMENTNUMBER, "DEMO-1");
  assert.ok(payment.costs.some((row) => row.NAME === "Office"));
});

test("UTF-16 little/big endian and Tally character references preserve names", async () => {
  const raw = (await fixture("Masters.xml")).toString("utf8").replace("UTF-8", "UTF-16");
  const le = Buffer.concat([Buffer.from([255, 254]), Buffer.from(raw, "utf16le")]);
  const be = Buffer.from(le.subarray(2));
  be.swap16();
  const beBom = Buffer.concat([Buffer.from([254, 255]), be]);
  assert.equal(decodeTally(le).text, raw);
  assert.equal(decodeTally(beBom).text, raw);
  assert.equal(decodeTally(Buffer.from(` \n${raw}`, "utf16le")).text, ` \n${raw}`);
  for (const bytes of [le, beBom]) {
    const preview = previewTally([{ name: "Masters.xml", base64: bytes.toString("base64") }], options);
    assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
    const stock = preview.records.find((record) => record.type === "STOCKGROUP");
    assert.ok(JSON.stringify(stock.node).includes("\\u0004"));
    assert.equal(preview.sources[0].sha256, hash(bytes));
  }
});

test("native JSON metadata objects project the same accounting books", async () => {
  const source = await files();
  const objects = [];
  for (const file of source) {
    const xml = Buffer.from(file.base64, "base64").toString("utf8");
    for (const record of tallyRecords(parseTallyXml(xml))) objects.push({ metadata: { type: record.type, ...Object.fromEntries(Object.entries(record.node.attrs).map(([key, entry]) => [key.toLowerCase(), entry])) }, ...nativeObject(record.node) });
  }
  const json = previewTally([{ name: "Native.json", base64: Buffer.from(JSON.stringify({ tallymessage: objects })).toString("base64") }], options);
  const xml = previewTally(source, options);
  assert.equal(json.canCommit, true, JSON.stringify(json.issues));
  assert.deepEqual(json.summary.trial, xml.summary.trial);
  assert.deepEqual(json.vouchers.map(({ type, number, date, lines }) => ({ type, number, date, lines })), xml.vouchers.map(({ type, number, date, lines }) => ({ type, number, date, lines })));
});

test("binary data, foreign currencies, conflicting signs and unbalanced vouchers block creation", async () => {
  const binary = previewTally([{ name: "Company.900", base64: Buffer.from([0, 3, 5, 7]).toString("base64") }], options);
  assert.equal(binary.canCommit, false);
  assert.equal(binary.issues[0].code, "native-data-needs-tally-export");
  const source = await files();
  const badSigns = source.map((file) => file.name === "DayBook.xml" ? { ...file, base64: Buffer.from(Buffer.from(file.base64, "base64").toString("utf8").replace("-21546.00", "21546.00")).toString("base64") } : file);
  assert.ok(previewTally(badSigns, options).issues.some((issue) => /sign.*disagree/.test(issue.message)));
  const imbalance = source.map((file) => file.name === "DayBook.xml" ? { ...file, base64: Buffer.from(Buffer.from(file.base64, "base64").toString("utf8").replace("-21546.00", "-21547.00")).toString("base64") } : file);
  assert.equal(previewTally(imbalance, options).canCommit, false);
  assert.throws(() => tallyAmount("USD 100 @ 83 = INR 8300"), /exact INR/);
  assert.throws(() => parseTallyXml('<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><ENVELOPE>&y;</ENVELOPE>'), /DTDs/);
  assert.throws(() => parseTallyXml("<ENVELOPE><LEDGER></ENVELOPE>"), /do not match/);
});

test("duplicate source records reconcile explicitly and conflicting copies block", async () => {
  const source = await files();
  const duplicate = previewTally([...source, { ...source[1], name: "SecondDayBook.xml" }], options);
  assert.equal(duplicate.canCommit, true);
  assert.equal(duplicate.summary.reconciliation.sourceVouchers, 10);
  assert.equal(duplicate.summary.reconciliation.duplicateVouchers, 5);
  assert.equal(duplicate.vouchers.length, 2);
  const conflicting = { ...source[1], name: "ChangedDayBook.xml", base64: Buffer.from(Buffer.from(source[1].base64, "base64").toString("utf8").replace("Public invoice example", "Changed invoice example")).toString("base64") };
  assert.equal(previewTally([...source, conflicting], options).canCommit, false);
});

test("base64 decoding handles large inputs without a recursive regular expression", () => {
  const bytes = Buffer.alloc(1024 * 1024, 42);
  assert.deepEqual(decodeBase64(bytes.toString("base64")), bytes);
  assert.throws(() => decodeBase64("AA=A"), /Invalid/);
});

test("isolated HTTP preview/confirm/source/full-archive/restore preserves original byte hashes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "financer-tally-http-"));
  const server = await start({ port: 0, dataDir: dir });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, input, expected = 200) => {
    const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const json = await response.json();
    assert.equal(response.status, expected, JSON.stringify(json));
    return json;
  };
  try {
    const sourceFiles = await files();
    const preview = await post("/api/tally/preview", { ...options, files: sourceFiles });
    assert.equal(preview.canCommit, true);
    assert.equal((await (await fetch(base + "/api/companies")).json()).companies.length, 0);
    await post("/api/tally/commit", { token: preview.token, acknowledge: false }, 400);
    const [created, simultaneous] = await Promise.all([
      post("/api/tally/commit", { token: preview.token, acknowledge: true }, 201),
      post("/api/tally/commit", { token: preview.token, acknowledge: true }, 201),
    ]);
    assert.equal(simultaneous.company.id, created.company.id);
    assert.equal(created.vouchers.length, 2);
    assert.equal(created.vouchers[0].source.guid, "public-invoice-1");
    const again = await post("/api/tally/commit", { token: preview.token, acknowledge: true }, 201);
    assert.equal(again.company.id, created.company.id);
    assert.equal(again.tallyImport.alreadyImported, true);
    const originalFileState = await (await fetch(`${base}/api/tally/companies/${created.company.id}/files`)).json();
    assert.equal(originalFileState.unchangedSinceImport, true);
    const rawDownload = await fetch(`${base}/api/tally/companies/${created.company.id}/file/0`);
    assert.match(rawDownload.headers.get("content-disposition"), /attachment/);
    assert.equal(hash(Buffer.from(await rawDownload.arrayBuffer())), hash(Buffer.from(sourceFiles[0].base64, "base64")));
    const payment = created.vouchers.find((voucher) => voucher.type === "Payment");
    const editedResponse = await fetch(`${base}/api/companies/${created.company.id}/vouchers/${payment.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payment, narration: "Edited after Tally import" }) });
    assert.equal(editedResponse.status, 200);
    created.vouchers = (await editedResponse.json()).vouchers;
    assert.equal(created.vouchers.find((voucher) => voucher.id === payment.id).source.guid, "public-payment-1");
    const api = `/api/tally/companies/${created.company.id}`;
    const changedSource = await (await fetch(base + api + "/record/" + payment.source.recordId)).json();
    assert.equal(changedSource.record.editedAfterImport, true);
    assert.equal((await (await fetch(base + api + "/files")).json()).unchangedSinceImport, false);
    const accountingXml = await fetch(base + api + "/export/daybook");
    assert.match(accountingXml.headers.get("content-disposition"), /DayBook-accounting.xml/);
    assert.ok((await accountingXml.text()).includes("Edited after Tally import"));
    const index = await (await fetch(base + api + "/records")).json();
    assert.equal(index.counts.STOCKITEM, 2);
    const stock = await (await fetch(base + api + "/records?type=STOCKITEM&q=8528")).json();
    assert.equal(stock.total, 1);
    const detail = await (await fetch(base + api + "/record/" + stock.records[0].recordId)).json();
    assert.deepEqual(detail.record.hsn, ["8528"]);
    const archiveResponse = await fetch(base + api + "/archive");
    assert.match(archiveResponse.headers.get("content-disposition"), /attachment/);
    const archive = await archiveResponse.json();
    const restored = restoreTallyArchive(archive);
    assert.deepEqual(restored.sources.map((file) => file.sha256), sourceFiles.map((file) => hash(Buffer.from(file.base64, "base64"))));
    const restorePreview = await post("/api/tally/preview", { files: [{ name: "FullArchive.json", base64: Buffer.from(JSON.stringify(archive)).toString("base64") }] });
    const imported = await post("/api/tally/commit", { token: restorePreview.token, acknowledge: true }, 201);
    assert.notEqual(imported.company.id, created.company.id);
    assert.equal((await (await fetch(`${base}/api/tally/companies/${imported.company.id}/files`)).json()).unchangedSinceImport, false);
    assert.deepEqual(imported.vouchers, created.vouchers);
    const ordinaryBackup = await (await fetch(`${base}/api/companies/${created.company.id}/backup`)).json();
    assert.equal(ordinaryBackup.format, "financer-tally-archive");
    const libraryImported = await post("/api/import", ordinaryBackup, 201);
    assert.deepEqual(libraryImported.vouchers, created.vouchers);
    const libraryArchive = await (await fetch(`${base}/api/companies/${libraryImported.company.id}/backup`)).json();
    assert.deepEqual(restoreTallyArchive(libraryArchive).sources.map((file) => file.sha256), restored.sources.map((file) => file.sha256));
    const orphan = { format: "financer-company", version: 1, company: structuredClone(created.company), vouchers: structuredClone(created.vouchers) };
    await post("/api/import", orphan, 400);
    const accountingCopy = await post("/api/import", { ...orphan, accountingOnly: true }, 201);
    assert.equal(accountingCopy.company.source.archive, "accounting-only");
    const copyBackup = await (await fetch(`${base}/api/companies/${accountingCopy.company.id}/backup`)).json();
    assert.equal(copyBackup.format, "financer-company");
    assert.equal(copyBackup.accountingOnly, true);
    const secondArchive = await (await fetch(`${base}/api/tally/companies/${imported.company.id}/archive`)).json();
    assert.deepEqual(restoreTallyArchive(secondArchive).sources.map((file) => file.sha256), restored.sources.map((file) => file.sha256));
    const tampered = structuredClone(archive);
    tampered.sourcePayload.data = "AAAA";
    assert.throws(() => restoreTallyArchive(tampered), /hash/);
    const folders = await readdir(path.join(dir, "companies"));
    assert.equal(folders.filter((name) => name.startsWith("tally-")).length, 3);
    assert.ok(!folders.some((name) => name.startsWith(".tally-")));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});


test("unknown flags block postings and custom order types inherit nonposting treatment", async () => {
  const source = await files();
  const badFlag = source.map((file) => file.name !== "DayBook.xml" ? file : { ...file, base64: Buffer.from(Buffer.from(file.base64, "base64").toString("utf8").replace("<ISINVOICE>Yes</ISINVOICE>", "<ISINVOICE>Yes</ISINVOICE><ISOPTIONAL>Maybe</ISOPTIONAL>")).toString("base64") });
  assert.equal(previewTally(badFlag, options).canCommit, false);
  const customOrder = source.map((file) => ({ ...file, base64: Buffer.from(Buffer.from(file.base64, "base64").toString("utf8").replaceAll("Sales Order", "Reservation").replace("</TALLYMESSAGE>", file.name === "Masters.xml" ? '<VOUCHERTYPE NAME="Reservation"><PARENT>Sales Order</PARENT></VOUCHERTYPE></TALLYMESSAGE>' : "</TALLYMESSAGE>")).toString("base64") }));
  const preview = previewTally(customOrder, options);
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
  assert.equal(preview.summary.reconciliation.excludedVouchers, 3);
});

test("unfamiliar root masters remain visible source records", async () => {
  const source = await files();
  source[0].base64 = Buffer.from(Buffer.from(source[0].base64, "base64").toString("utf8").replace("</TALLYMESSAGE>", '<GSTCLASSIFICATION NAME="Public classification"><DESCRIPTION>Public extension</DESCRIPTION></GSTCLASSIFICATION></TALLYMESSAGE>')).toString("base64");
  const preview = previewTally(source, options);
  assert.equal(preview.canCommit, true);
  assert.ok(preview.records.some((record) => record.type === "GSTCLASSIFICATION" && record.disposition === "reference-master"));
});
