import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { reservedGroups } from "../lib/groups.js";
import { createStore } from "../lib/store.js";
import { assertReconciliation, bankReport, mutateReconciliation, parseBankCsv, previewBankStatement, reconciliationSection } from "../lib/reconciliation.js";
import { referenceTokens, xlsxStatementCsv } from "../lib/reconciliation-bank.js";
import { learnedPattern, ruleMatches } from "../lib/bank-rules.js";
import { handleReconciliationRoute } from "../lib/reconciliation-routes.js";
import { nextNumberFor } from "../lib/numbering.js";
import { companyBackup, validateTransfer } from "../lib/transfer.js";

// Synthetic books: a bank, a customer, a supplier and bank charges; vouchers are added per test.
function books(vouchers = []) {
  const company = { id: "loop-books", name: "Synthetic loop books", booksFrom: "2026-04-01", groups: reservedGroups(), ledgers: [
    { id: "l-bank", name: "Synthetic Bank", groupId: "g-bank", opening: { dc: "Dr", paise: 100000 } },
    { id: "l-customer", name: "Synthetic Customer", groupId: "g-debtors", opening: { dc: "Dr", paise: 0 } },
    { id: "l-supplier", name: "Synthetic Supplier", groupId: "g-creditors", opening: { dc: "Cr", paise: 0 } }] };
  return { company, vouchers };
}
const receipt = (id, number, date, paise, narration = "") => ({ id, type: "Receipt", number, date, narration, lines: [{ ledgerId: "l-bank", dc: "Dr", paise }, { ledgerId: "l-customer", dc: "Cr", paise }] });
const payment = (id, number, date, paise, narration = "") => ({ id, type: "Payment", number, date, narration, lines: [{ ledgerId: "l-supplier", dc: "Dr", paise }, { ledgerId: "l-bank", dc: "Cr", paise }] });
let serial = 0;
const requestId = () => `loop-request-${String(++serial).padStart(8, "0")}-${Date.now()}`;
function change(meta, book, action, input) {
  return mutateReconciliation(meta, book, action, { revision: meta?.revision || 0, requestId: requestId(), ...input });
}
const statement = (csv, extra = {}) => ({ ledgerId: "l-bank", name: "April", from: "2026-04-01", to: "2026-04-30", openingPaise: 100000, closingPaise: 100000,
  csv, mapping: { date: 0, narration: 1, reference: 2, amount: 3 }, dateFormat: "dd/mm/yyyy", signedConvention: "credit-positive", ...extra });

test("reference extraction keeps 12 to 22 character references with a digit and 6-digit cheque numbers", () => {
  assert.deepEqual([...referenceTokens("NEFT CR-HDFCN52026040712345-SYNTHETIC CUSTOMER")], ["HDFCN52026040712345"]);
  assert.deepEqual([...referenceTokens("UPI/412345678901/PAYMENT")], ["412345678901"]);
  assert.deepEqual([...referenceTokens("CHQ DEP 004512 CLG", "Cheque 1234567")], ["004512"]);
  assert.deepEqual([...referenceTokens("SYNTHETICCUSTOMERNAME", "HDFC0001234", "A".repeat(23) + "1")], []);
  assert.deepEqual([...referenceTokens("RTGS SBINR52026040712345678 X")], ["SBINR52026040712345678"]);
});

test("suggestions rank same-amount book entries within three days by shared reference, then date distance", () => {
  const book = books([
    receipt("v-a", "R-A", "2026-04-05", 6000, "Received from customer"),
    receipt("v-b", "R-B", "2026-04-08", 6000, "Received"),
    receipt("v-c", "R-C", "2026-04-10", 6000, "NEFT UTR HDFCN52026040712345"),
    receipt("v-d", "R-D", "2026-04-11", 6000, "Four days away"),
    receipt("v-e", "R-E", "2026-04-07", 5000, "Different amount"),
    payment("v-f", "P-F", "2026-04-07", 6000, "Opposite direction"),
  ]);
  const csv = "Date,Narration,Reference,Amount\r\n07/04/2026,NEFT CR-HDFCN52026040712345-SYNTHETIC CUSTOMER,,60.00\r\n";
  const { section: meta, result } = change(null, book, "import-statement", statement(csv, { closingPaise: 106000 }));
  const report = bankReport(meta, book.company, book.vouchers, result.id);
  const row = report.rows[0];
  assert.deepEqual(row.suggestions.map(item => item.number), ["R-C", "R-B", "R-A"]);
  assert.equal(row.suggestions[0].matchedReference, "HDFCN52026040712345");
  assert.equal(row.suggestions[0].basis, "amount-reference");
  assert.equal(row.suggestions[0].dayDistance, 3);
  assert.equal(row.suggestions[1].basis, "amount-date");
  assert.equal(row.suggestions[1].dayDistance, 1);
  assert.equal(row.suggestions[2].dayDistance, 2);
  assert.ok(row.suggestions.every(item => item.amountPaise === 6000));
  // Existing exact-date candidates are unchanged: no receipt of Rs 60 on 07-04-2026.
  assert.equal(row.candidateKind, "none");
  // Once matched the row has no suggestions, and the matched entry leaves other rows' suggestions.
  const matched = change(meta, book, "match-bank", { statementId: result.id, rowIds: [row.id], voucherIds: ["v-c"] }).section;
  const after = bankReport(matched, book.company, book.vouchers, result.id);
  assert.deepEqual(after.rows[0].suggestions, []);
  assert.equal(after.rows[0].ruleSuggestion, null);
});

test("a cheque number or the same reference column in both records outranks a nearer date", () => {
  const book = books([
    payment("v-near", "P-1", "2026-04-12", 25000, "Supplier payment"),
    payment("v-cheque", "P-2", "2026-04-14", 25000, "Cheque 004512 to supplier"),
    payment("v-ref", "INV-77", "2026-04-15", 25000, ""),
  ]);
  const csv = "Date,Narration,Reference,Amount\r\n12/04/2026,CHQ PAID 004512 CLG,,-250.00\r\n13/04/2026,TRANSFER TO SUPPLIER,INV/77,-250.00\r\n";
  const { section: meta, result } = change(null, book, "import-statement", statement(csv, { closingPaise: 50000 }));
  const report = bankReport(meta, book.company, book.vouchers, result.id);
  assert.deepEqual(report.rows[0].suggestions.map(item => [item.number, item.matchedReference]), [["P-2", "004512"], ["P-1", null], ["INV-77", null]]);
  assert.equal(report.rows[1].suggestions[0].number, "INV-77");
  assert.equal(report.rows[1].suggestions[0].matchedReference, "INV77");
});

test("one statement row matches several book entries and several rows match one entry, with exact sums", () => {
  const book = books([
    receipt("v-60", "R-60", "2026-04-05", 6000), receipt("v-40", "R-40", "2026-04-05", 4000),
    receipt("v-90", "R-90", "2026-04-09", 9000), payment("v-pay", "P-1", "2026-04-09", 1000),
  ]);
  const csv = "Date,Narration,Reference,Amount\r\n05/04/2026,BATCH DEPOSIT,,100.00\r\n09/04/2026,PART ONE,,50.00\r\n09/04/2026,PART TWO,,40.00\r\n09/04/2026,CHARGES,,-10.00\r\n";
  let { section: meta, result } = change(null, book, "import-statement", statement(csv, { closingPaise: 118000 }));
  const rows = bankReport(meta, book.company, book.vouchers, result.id).rows;
  assert.throws(() => change(meta, book, "match-bank", { statementId: result.id, rowIds: [rows[0].id], voucherIds: ["v-60"] }), /Match equal totals.*₹100\.00.*₹60\.00/);
  assert.throws(() => change(meta, book, "match-bank", { statementId: result.id, rowIds: [rows[1].id, rows[3].id], voucherIds: ["v-60"] }), /same direction/);
  meta = change(meta, book, "match-bank", { statementId: result.id, rowIds: [rows[0].id], voucherIds: ["v-60", "v-40"] }).section;
  meta = change(meta, book, "match-bank", { statementId: result.id, rowIds: [rows[1].id, rows[2].id], voucherIds: ["v-90"] }).section;
  assert.deepEqual(meta.matches.map(match => [match.rowIds.length, match.voucherIds.length]), [[1, 2], [2, 1]]);
  assertReconciliation({ ...book.company, reconciliation: meta }, book.vouchers);
  const report = bankReport(meta, book.company, book.vouchers, result.id);
  assert.deepEqual(report.rows.map(row => row.matched), [true, true, true, false]);
  assert.equal(report.rows[3].suggestions[0].number, "P-1");
  // A saved group whose totals were tampered with no longer validates.
  const tampered = structuredClone(meta);
  tampered.matches[1].rowIds = [tampered.matches[1].rowIds[0]];
  assert.throws(() => assertReconciliation({ ...book.company, reconciliation: tampered }, book.vouchers), /Match equal totals/);
});

test("rules: plain text and /regex/ patterns, learned patterns drop digits, dates and rail words", () => {
  assert.equal(learnedPattern("NEFT CR-HDFCN52026040712345-SYNTHETIC CUSTOMER A 05/04/2026"), "SYNTHETIC CUSTOMER");
  assert.equal(learnedPattern("UPI/412345678901/05-APR-2026"), null);
  assert.equal(ruleMatches({ pattern: "synthetic customer" }, "NEFT CR SYNTHETIC-CUSTOMER LTD"), true);
  assert.equal(ruleMatches({ pattern: "customer synthetic" }, "NEFT CR SYNTHETIC CUSTOMER"), true);
  assert.equal(ruleMatches({ pattern: "/^neft.*charges$/" }, "NEFT SERVICE CHARGES"), true);
  assert.equal(ruleMatches({ pattern: "/^neft.*charges$/" }, "IMPS SERVICE CHARGES"), false);
});

async function storeFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "ledgercraft-reconciliation-loop-"));
  const store = createStore(dir);
  const { company } = await store.create({ name: "Synthetic Loop Books", booksFrom: "2026-04-01" });
  const id = company.id;
  for (const row of [
    { name: "Loop Bank", groupId: "g-bank", openingPaise: 100000, openingDc: "Dr" },
    { name: "Synthetic Customer", groupId: "g-debtors", openingPaise: 0, openingDc: "Dr" },
    { name: "Bank Charges", groupId: "g-indirect-exp", openingPaise: 0, openingDc: "Dr" },
  ]) await store.addLedger(id, row);
  const ids = Object.fromEntries((await store.get(id)).company.ledgers.map(row => [row.name, row.id]));
  const calls = [];
  const route = async (method, pathname, body) => {
    const url = new URL(`http://localhost${pathname}`);
    const parts = url.pathname.split("/").filter(Boolean);
    let sent;
    const send = (res, status, payload) => { sent = { status, body: payload }; };
    await handleReconciliationRoute({ req: { method }, res: {}, url, parts, store, readBody: async () => structuredClone(body), send });
    calls.push(sent);
    return sent;
  };
  const csv = "Date,Narration,Reference,Amount\r\n05/04/2026,NEFT CR-HDFCN52026040512345-SYNTHETIC CUSTOMER,,60.00\r\n06/04/2026,SMS ALERT CHARGES APR,,-1.18\r\n"
    + "07/04/2026,NEFT CR-HDFCN52026040799999-SYNTHETIC CUSTOMER,,25.00\r\n";
  const imported = await route("POST", `/api/companies/${id}/reconciliation/import-statement`, { ...statement(csv, { ledgerId: ids["Loop Bank"], closingPaise: 108382 }), requestId: requestId(), revision: 0 });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  const statementId = imported.body.result.id;
  return { dir, store, id, ids, route, statementId, close: () => rm(dir, { recursive: true, force: true }) };
}

test("a voucher from an unmatched statement row posts through the voucher rules and matches the row atomically", async () => {
  const f = await storeFixture();
  try {
    const base = `/api/companies/${f.id}/reconciliation`;
    const body = { ledgerId: f.ids["Synthetic Customer"], requestId: requestId() };
    const opened = await f.store.get(f.id);
    const expectedNumber = nextNumberFor(opened.company, opened.vouchers, "Receipt", "2026-04-05");
    const created = await f.route("POST", `${base}/bank/${f.statementId}/rows/0/voucher`, body);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { voucher, match } = created.body;
    assert.equal(voucher.type, "Receipt");
    assert.equal(voucher.date, "2026-04-05");
    assert.equal(voucher.number, expectedNumber);
    assert.equal(voucher.narration, "NEFT CR-HDFCN52026040512345-SYNTHETIC CUSTOMER");
    assert.deepEqual(voucher.lines, [{ ledgerId: f.ids["Loop Bank"], dc: "Dr", paise: 6000 }, { ledgerId: f.ids["Synthetic Customer"], dc: "Cr", paise: 6000 }]);
    assert.deepEqual(match.voucherIds, [voucher.id]);
    const book = await f.store.get(f.id);
    assert.ok(book.vouchers.some(row => row.id === voucher.id && row.requestId === body.requestId));
    assert.equal(book.company.reconciliation.matches.length, 1);
    assert.equal(book.company.reconciliation.audit.at(-1).action, "bank-voucher");
    // Retrying the same request returns the same voucher without posting twice.
    const again = await f.route("POST", `${base}/bank/${f.statementId}/rows/0/voucher`, body);
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.voucher.id, voucher.id);
    assert.equal((await f.store.get(f.id)).vouchers.length, book.vouchers.length);
    // A matched row cannot get a second voucher; a reused identifier with other content is refused.
    await assert.rejects(() => f.route("POST", `${base}/bank/${f.statementId}/rows/0/voucher`, { ...body, requestId: requestId() }), /already matched/);
    await assert.rejects(() => f.route("POST", `${base}/bank/${f.statementId}/rows/1/voucher`, body), /different reconciliation change/);
    // Payments: a debit row defaults to a Payment that credits the bank; a Receipt is refused.
    await assert.rejects(() => f.route("POST", `${base}/bank/${f.statementId}/rows/1/voucher`, { ledgerId: f.ids["Bank Charges"], type: "Receipt", requestId: requestId() }), /Payment/);
    const charges = await f.route("POST", `${base}/bank/${f.statementId}/rows/1/voucher`, { ledgerId: f.ids["Bank Charges"], narration: "SMS charges", requestId: requestId() });
    assert.equal(charges.body.voucher.type, "Payment");
    assert.equal(charges.body.voucher.narration, "SMS charges");
    assert.deepEqual(charges.body.voucher.lines, [{ ledgerId: f.ids["Bank Charges"], dc: "Dr", paise: 118 }, { ledgerId: f.ids["Loop Bank"], dc: "Cr", paise: 118 }]);
    const report = (await f.route("GET", `${base}/bank?statementId=${f.statementId}`)).body;
    assert.deepEqual(report.rows.map(row => row.matched), [true, true, false]);
    assert.equal(report.totals.unmatchedBookPaise, 0);
    // Edit log: the voucher and the match are both recorded, in that order.
    const log = (await readFile(path.join(f.dir, "companies", f.id, "audit.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const tail = log.slice(-2);
    assert.deepEqual(tail.map(entry => entry.entity), ["voucher", "reconciliation"]);
    assert.match(tail[1].summary, /05-04-2026|06-04-2026/);
    // The saved book still validates and survives a backup round trip.
    const saved = await f.store.get(f.id);
    const transfer = validateTransfer(companyBackup(saved.company, saved.vouchers));
    assertReconciliation(transfer.company, transfer.vouchers);
  } finally { await f.close(); }
});

test("a statement voucher respects the books lock and leaves both files untouched", async () => {
  const f = await storeFixture();
  try {
    await f.store.setLocks(f.id, { books: { to: "2026-04-05", reason: "April first week reviewed" } });
    const before = await f.store.get(f.id);
    const base = `/api/companies/${f.id}/reconciliation`;
    await assert.rejects(() => f.route("POST", `${base}/bank/${f.statementId}/rows/0/voucher`, { ledgerId: f.ids["Synthetic Customer"], requestId: requestId() }), /books are locked up to 05-04-2026/);
    await assert.rejects(() => f.route("POST", `${base}/bank/${f.statementId}/rows/1/voucher`, { ledgerId: f.ids["Bank Charges"], date: "2026-04-04", requestId: requestId() }), /books are locked/);
    const after = await f.store.get(f.id);
    assert.deepEqual(after.vouchers, before.vouchers);
    assert.deepEqual(after.company.reconciliation, before.company.reconciliation);
    // An open date in the statement period is accepted; one outside the period is not.
    await assert.rejects(() => f.route("POST", `${base}/bank/${f.statementId}/rows/1/voucher`, { ledgerId: f.ids["Bank Charges"], date: "2026-05-02", requestId: requestId() }), /statement period/);
    const moved = await f.route("POST", `${base}/bank/${f.statementId}/rows/1/voucher`, { ledgerId: f.ids["Bank Charges"], date: "2026-04-06", requestId: requestId() });
    assert.equal(moved.status, 201);
    // A stale reconciliation revision is refused when it is sent.
    await assert.rejects(() => f.route("POST", `${base}/bank/${f.statementId}/rows/2/voucher`, { ledgerId: f.ids["Synthetic Customer"], revision: 0, requestId: requestId() }), /changed while/);
  } finally { await f.close(); }
});

test("saving a voucher with saveRule learns a rule that suggests the ledger for the next similar row; rules are edited through PUT", async () => {
  const f = await storeFixture();
  try {
    const base = `/api/companies/${f.id}/reconciliation`;
    let rules = await f.route("GET", `${base}/bank-rules`);
    assert.deepEqual(rules.body.rules, []);
    let report = (await f.route("GET", `${base}/bank?statementId=${f.statementId}`)).body;
    assert.equal(report.rows[2].ruleSuggestion, null);
    const created = await f.route("POST", `${base}/bank/${f.statementId}/rows/0/voucher`, { ledgerId: f.ids["Synthetic Customer"], saveRule: true, requestId: requestId() });
    assert.equal(created.body.rule.pattern, "SYNTHETIC CUSTOMER");
    assert.equal(created.body.ruleLearned, true);
    report = (await f.route("GET", `${base}/bank?statementId=${f.statementId}`)).body;
    assert.deepEqual({ ledgerId: report.rows[2].ruleSuggestion.ledgerId, type: report.rows[2].ruleSuggestion.type, ruleId: report.rows[2].ruleSuggestion.ruleId },
      { ledgerId: f.ids["Synthetic Customer"], type: "Receipt", ruleId: created.body.rule.id });
    assert.equal(report.rows[1].ruleSuggestion, null);
    rules = await f.route("GET", `${base}/bank-rules`);
    assert.equal(rules.body.rules.length, 1);
    assert.equal(rules.body.rules[0].ledgerName, "Synthetic Customer");
    // Replace the list: keep the learned rule, add a regex rule for bank charges with a narration template.
    const saved = await f.route("PUT", `${base}/bank-rules`, { revision: rules.body.revision, requestId: requestId(), rules: [
      rules.body.rules[0], { pattern: "/charges/", ledgerId: f.ids["Bank Charges"], narration: "Bank charges {date} {narration}" }] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.rules.length, 2);
    assert.equal(saved.body.rules[0].id, created.body.rule.id);
    report = (await f.route("GET", `${base}/bank?statementId=${f.statementId}`)).body;
    assert.equal(report.rows[1].ruleSuggestion.ledgerId, f.ids["Bank Charges"]);
    assert.equal(report.rows[1].ruleSuggestion.type, "Payment");
    assert.equal(report.rows[1].ruleSuggestion.narration, "Bank charges 06-04-2026 SMS ALERT CHARGES APR");
    // Without a narration, the matching rule's template is used for the new voucher.
    const charges = await f.route("POST", `${base}/bank/${f.statementId}/rows/1/voucher`, { ledgerId: f.ids["Bank Charges"], requestId: requestId() });
    assert.equal(charges.body.voucher.narration, "Bank charges 06-04-2026 SMS ALERT CHARGES APR");
    // Invalid rules are refused and change nothing.
    const current = (await f.route("GET", `${base}/bank-rules`)).body;
    await assert.rejects(() => f.route("PUT", `${base}/bank-rules`, { revision: current.revision, requestId: requestId(), rules: [{ pattern: "/(unclosed/", ledgerId: f.ids["Bank Charges"] }] }), /regular expression/);
    await assert.rejects(() => f.route("PUT", `${base}/bank-rules`, { revision: current.revision, requestId: requestId(), rules: [{ pattern: "rent", ledgerId: "l-missing" }] }), /ledger/);
    assert.equal((await f.route("GET", `${base}/bank-rules`)).body.rules.length, 2);
    // The edit log names the learned rule.
    const log = await readFile(path.join(f.dir, "companies", f.id, "audit.jsonl"), "utf8");
    assert.match(log, /Bank rule SYNTHETIC CUSTOMER learned/);
    // A tampered rule makes the saved section invalid.
    const book = await f.store.get(f.id);
    const broken = structuredClone(book.company.reconciliation);
    broken.bankRules[0].pattern = "";
    assert.throws(() => assertReconciliation({ ...book.company, reconciliation: broken }, book.vouchers), /rule pattern/);
  } finally { await f.close(); }
});

// A minimal XLSX writer (stored as deflate entries) for a synthetic statement workbook.
function zip(entries) {
  const parts = [], directory = []; let offset = 0;
  for (const [name, input] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(input), packed = deflateRawSync(bytes), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    parts.push(header, filename, packed); directory.push(central, filename); offset += header.length + filename.length + packed.length;
  }
  const tail = Buffer.alloc(22), central = Buffer.concat(directory); tail.writeUInt32LE(0x06054b50); tail.writeUInt16LE(entries.length, 8); tail.writeUInt16LE(entries.length, 10); tail.writeUInt32LE(central.length, 12); tail.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, tail]);
}
const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const column = index => String.fromCharCode(65 + index);
function statementWorkbook(rows, { second = null } = {}) {
  const cell = (value, ref) => value === null ? "" : typeof value === "object"
    ? `<c r="${ref}"${value.s ? ` s="${value.s}"` : ""}><v>${value.n}</v></c>`
    : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
  const sheet = list => `<worksheet><sheetData>${list.map((values, index) => `<row r="${index + 1}">${values.map((value, at) => cell(value, `${column(at)}${index + 1}`)).join("")}</row>`).join("")}</sheetData></worksheet>`;
  return zip([
    ["[Content_Types].xml", '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'],
    ["_rels/.rels", '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Statement" sheetId="1" r:id="r1"/>${second ? '<sheet name="Summary" sheetId="2" r:id="r3"/>' : ""}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${second ? '<Relationship Id="r3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' : ""}</Relationships>`],
    ["xl/styles.xml", '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'],
    ["xl/worksheets/sheet1.xml", sheet(rows)],
    ...(second ? [["xl/worksheets/sheet2.xml", sheet(second)]] : []),
  ]);
}

test("an XLSX statement is read from its first sheet and imported through the CSV rules", async () => {
  // 46117 is the Excel serial date for 05-04-2026 and 46118 for 06-04-2026.
  const bytes = statementWorkbook([
    ["SYNTHETIC BANK LTD", null, null, null, null],
    ["Statement of account", null, null, null, null],
    ["Txn Date", "Description", "Ref No", "Debit", "Credit"],
    [{ n: 46117, s: 1 }, "NEFT CR, SYNTHETIC CUSTOMER", "RCT-001", null, { n: 60 }],
    [{ n: 46118, s: 1 }, 'UPI "SYNTHETIC" SUPPLIER', "PAY-001", { n: 40.5 }, null],
    ["Closing balance", null, null, null, { n: 1019.5 }],
  ], { second: [["Not", "read"], ["x", "y"]] });
  const xlsxBase64 = bytes.toString("base64");
  const converted = xlsxStatementCsv(xlsxBase64);
  assert.equal(converted.sheet, "Statement");
  assert.doesNotMatch(converted.csv, /Not,read/);
  const { headers, records } = parseBankCsv(converted.csv);
  assert.deepEqual(headers, ["Txn Date", "Description", "Ref No", "Debit", "Credit"]);
  assert.deepEqual(records[0], ["2026-04-05", "NEFT CR, SYNTHETIC CUSTOMER", "RCT-001", "", "60"]);
  const book = books([receipt("v-r", "RCT-001", "2026-04-05", 6000), payment("v-p", "PAY-001", "2026-04-06", 4050)]);
  const input = { ledgerId: "l-bank", name: "April XLSX", from: "2026-04-01", to: "2026-04-30", openingPaise: 100000, closingPaise: 101950,
    xlsxBase64, mapping: { date: "Txn Date", narration: "Description", reference: "Ref No", debit: "Debit", credit: "Credit" }, dateFormat: "dd/mm/yyyy" };
  const preview = previewBankStatement(book.company, book.vouchers, input);
  assert.deepEqual(preview.rows.map(row => [row.date, row.amountPaise, row.reference]), [["2026-04-05", 6000, "RCT-001"], ["2026-04-06", -4050, "PAY-001"]]);
  assert.equal(preview.sourceFormat, "xlsx");
  const { section: meta, result } = change(null, book, "import-statement", input);
  const saved = meta.statements[0];
  assert.equal(saved.sourceCsv, converted.csv);
  assert.equal(saved.sourceFormat, "xlsx");
  assert.match(saved.sourceFileHash, /^[a-f0-9]{64}$/);
  assertReconciliation({ ...book.company, reconciliation: meta }, book.vouchers);
  const report = bankReport(meta, book.company, book.vouchers, result.id);
  assert.deepEqual(report.rows.map(row => row.candidateKind), ["amount-date-reference", "amount-date-reference"]);
  assert.equal(report.totals.differencePaise, 0);
  assert.throws(() => change(meta, book, "import-statement", input), /already been imported/);
  assert.throws(() => previewBankStatement(book.company, book.vouchers, { ...input, csv: "Date,Amount\n" }), /either a CSV or an XLSX/);
  assert.throws(() => xlsxStatementCsv(Buffer.from("not a workbook").toString("base64")), /XLSX statement could not be read/);
});

test("the CSV column and preview routes accept an XLSX statement", async () => {
  const f = await storeFixture();
  try {
    const bytes = statementWorkbook([["Date", "Narration", "Amount"], [{ n: 46119, s: 1 }, "SYNTHETIC CUSTOMER", { n: 12.5 }]]);
    const base = `/api/companies/${f.id}/reconciliation`;
    const columns = await f.route("POST", `${base}/csv-columns`, { xlsxBase64: bytes.toString("base64") });
    assert.deepEqual(columns.body.headers, ["Date", "Narration", "Amount"]);
    assert.deepEqual(columns.body.sample, [["2026-04-07", "SYNTHETIC CUSTOMER", "12.5"]]);
    assert.equal(columns.body.sourceFormat, "xlsx");
    const preview = await f.route("POST", `${base}/bank-preview`, { ledgerId: f.ids["Loop Bank"], from: "2026-04-01", to: "2026-04-30", openingPaise: 0, closingPaise: 1250,
      xlsxBase64: bytes.toString("base64"), mapping: { date: 0, narration: 1, amount: 2 }, signedConvention: "credit-positive", dateFormat: "yyyy-mm-dd" });
    assert.equal(preview.body.statement.rows[0].amountPaise, 1250);
    assert.equal(preview.body.statement.sourceCsv, undefined);
  } finally { await f.close(); }
});

test("books saved before rules and suggestions keep loading and reporting", () => {
  const book = books([receipt("v-r", "R-1", "2026-04-05", 6000)]);
  const { section: meta, result } = change(reconciliationSection(), book, "import-statement", statement("Date,Narration,Reference,Amount\n05/04/2026,X,,60.00\n", { closingPaise: 106000 }));
  assert.equal(meta.bankRules, undefined);
  assertReconciliation({ ...book.company, reconciliation: meta }, book.vouchers);
  const report = bankReport(meta, book.company, book.vouchers, result.id);
  assert.equal(report.rows[0].suggestions[0].number, "R-1");
  assert.equal(report.rows[0].ruleSuggestion, null);
});
