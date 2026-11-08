import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bookBalances, cashBankBook, exportXml, groupSummary, outstanding } from "../lib/report-tools.js";
import { companyBackup, importCompany, validateTransfer } from "../lib/transfer.js";
import { buildSpecimen } from "../lib/specimen.js";
import { trialBalance } from "../lib/engine.js";
import { createStore } from "../lib/store.js";
import { start } from "../server.js";

const makeBook = () => buildSpecimen(new Date("2026-11-07T10:00:00"));
const FROM = "2026-04-01";
const TO = "2026-11-07";

test("group summary totals and drilldown use the same trial rows", () => {
  const { company, vouchers } = makeBook();
  const trial = trialBalance(company, vouchers, FROM, TO);
  const report = groupSummary(company, vouchers, FROM, TO);
  assert.equal(report.rows.length, company.groups.length);
  assert.equal(report.debit, trial.debit);
  assert.equal(report.credit, trial.credit);
  // Rows roll up their descendants, so only the primary groups add up to the trial balance.
  const primary = report.rows.filter((row) => !row.parentId);
  assert.equal(primary.reduce((sum, row) => sum + row.debit, 0), trial.debit);
  assert.equal(primary.reduce((sum, row) => sum + row.credit, 0), trial.credit);
  const cash = groupSummary(company, vouchers, FROM, TO, "g-cash");
  assert.equal(cash.ledgers.length, 1);
  assert.equal(cash.ledgers[0].name, "Cash");
  assert.match(report.rows.find((row) => row.groupId === "g-cash").path, /Current Assets \/ Cash-in-Hand/);
  assert.throws(() => groupSummary(company, vouchers, TO, FROM), /period/);
});

test("group summary rolls subgroups into their parents and drills down one level at a time", () => {
  const { company, vouchers } = makeBook();
  const report = groupSummary(company, vouchers, FROM, TO);
  const byId = new Map(report.rows.map((row) => [row.groupId, row]));
  const current = byId.get("g-current-assets");
  const bank = byId.get("g-bank");
  const cash = byId.get("g-cash");
  assert.ok(bank.debit > 0 && cash.debit > 0);
  assert.equal(current.debit, bank.debit + cash.debit);
  assert.equal(current.periodDr, bank.periodDr + cash.periodDr);
  assert.equal(current.periodCr, bank.periodCr + cash.periodCr);
  assert.equal(current.parentId, null);
  assert.equal(cash.parentId, "g-current-assets");
  assert.equal(cash.depth, 1);
  const drill = groupSummary(company, vouchers, FROM, TO, "g-current-assets");
  assert.deepEqual(drill.ledgers, []);
  assert.deepEqual(drill.childGroups.map((row) => row.name).sort(), ["Bank Accounts", "Cash-in-Hand"]);
  assert.equal(drill.childGroups.find((row) => row.groupId === "g-bank").debit, bank.debit);
  assert.equal(drill.debit, bank.debit + cash.debit);
  assert.equal(drill.credit, 0);
  // A custom subgroup with its own ledger rolls up two levels and appears beside the direct ledgers.
  company.groups.push({ id: "g-petty", name: "Petty cash boxes", parentId: "g-cash", nature: null, gross: false, cashBank: false, reserved: false });
  company.ledgers.push({ id: "l-petty", name: "Front desk box", groupId: "g-petty", opening: { dc: "Dr", paise: 4_321 } });
  const nested = groupSummary(company, vouchers, FROM, TO, "g-cash");
  assert.deepEqual(nested.ledgers.map((row) => row.name), ["Cash"]);
  assert.deepEqual(nested.childGroups.map((row) => [row.name, row.debit]), [["Petty cash boxes", 4_321]]);
  assert.equal(nested.debit, cash.debit + 4_321);
  assert.equal(groupSummary(company, vouchers, FROM, TO, "g-current-assets").debit, bank.debit + cash.debit + 4_321);
  // Empty child groups are not listed in the drilldown.
  assert.equal(groupSummary(company, vouchers, FROM, TO, "g-current-liab").childGroups.some((row) => row.groupId === "g-provisions"), false);
});

test("cash/bank excludes credit purchase and outstanding includes that supplier", () => {
  const { company, vouchers } = makeBook();
  const cash = cashBankBook(company, vouchers, FROM, TO);
  assert.deepEqual(cash.rows.map((row) => row.type).sort(), ["Payment", "Receipt"]);
  assert.equal(cash.balances.length, 2);
  assert.equal(cash.balances.find((row) => row.name === "Cash").closing.paise, 19_700_000);
  const parties = outstanding(company, vouchers, FROM, TO);
  assert.equal(parties.debtors.length, 0);
  assert.equal(parties.creditors[0].name, "Mill Stores");
  assert.equal(parties.payable, 1_500_000);
});

test("XML exports match engine paise totals and escape text", () => {
  const { company, vouchers } = makeBook();
  company.name = "North & Mill <Traders>";
  vouchers[0].narration = 'Counter & "cash"';
  const trial = trialBalance(company, vouchers, FROM, TO);
  const xml = exportXml(company, vouchers, "trial-balance", FROM, TO);
  assert.match(xml, new RegExp(`debitPaise="${trial.debit}" creditPaise="${trial.credit}"`));
  assert.match(xml, /North &amp; Mill &lt;Traders&gt;/);
  assert.match(xml, /alias="DebitPaise" type="integer" length="0" precision="16" scale="0" nullable="false"/);
  const detail = exportXml(company, vouchers, "vouchers", FROM, TO);
  assert.match(detail, /<FinancerLines>/);
  assert.match(detail, /Counter &amp; &quot;cash&quot;/);
  assert.match(detail, /voucherCount="3"/);
  const early = exportXml(company, vouchers, "daybook", FROM, "2026-04-07");
  assert.match(early, /debitPaise="2500000" creditPaise="2500000" voucherCount="1"/);
});

test("company backup imports into a fresh folder and preserves accounting", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "financer-transfer-"));
  try {
    const { company, vouchers } = makeBook();
    const imported = await importCompany(dir, companyBackup(company, vouchers));
    assert.notEqual(imported.company.id, company.id);
    assert.deepEqual(trialBalance(imported.company, imported.vouchers, FROM, TO), trialBalance(company, vouchers, FROM, TO));
    const disk = JSON.parse(await readFile(path.join(dir, "companies", imported.company.id, "company.json"), "utf8"));
    assert.equal(disk.id, imported.company.id);
    const originalFolder = await importCompany(dir, { company, vouchers });
    assert.notEqual(originalFolder.company.id, imported.company.id);
    assert.equal((await createStore(dir).list()).length, 2);
    assert.deepEqual((await readdir(path.join(dir, "companies"))).sort(), [imported.company.id, originalFolder.company.id].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid and reclassified backups reject before any company write", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "financer-invalid-transfer-"));
  try {
    const original = makeBook();
    const changed = structuredClone(original);
    changed.company.groups.find((group) => group.id === "g-sales").nature = "Asset";
    await assert.rejects(importCompany(dir, changed), /reserved account group/);
    const badAmount = structuredClone(original);
    badAmount.vouchers[0].lines[0].paise = 0;
    await assert.rejects(importCompany(dir, badAmount), /greater than zero/);
    const repeated = structuredClone(original);
    repeated.vouchers.push(structuredClone(repeated.vouchers[0]));
    assert.throws(() => validateTransfer(repeated), /duplicate voucher/);
    assert.throws(() => validateTransfer({ ...original, format: "other", version: 1 }), /not a Ledgercraft/);
    assert.throws(() => validateTransfer({ ...original, format: "financer-company", version: 2 }), /version/);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("custom group cycles and invalid line references are rejected", () => {
  const cyclic = makeBook();
  cyclic.company.groups.push({ id: "g-one", name: "One", parentId: "g-two", nature: null, gross: false, cashBank: false, reserved: false }, { id: "g-two", name: "Two", parentId: "g-one", nature: null, gross: false, cashBank: false, reserved: false });
  assert.throws(() => validateTransfer(cyclic), /cycle/);
  const missing = makeBook();
  missing.vouchers[0].lines[0].ledgerId = "l-missing";
  assert.throws(() => validateTransfer(missing), /ledger is not/);
});

test("duplicate voucher numbers reject and custom children preserve inherited grouping", () => {
  const book = makeBook();
  const extra = structuredClone(book.vouchers[0]);
  extra.id = "v-copy";
  book.vouchers.push(extra);
  assert.throws(() => validateTransfer(book), /number is already/);
  const nested = makeBook();
  nested.company.groups.push({ id: "g-client", name: "Local clients", parentId: "g-debtors", nature: null, gross: false, cashBank: false, reserved: false });
  nested.company.ledgers.push({ id: "l-client", name: "First client", groupId: "g-client", opening: { dc: "Dr", paise: 12345 } });
  assert.equal(validateTransfer(nested).company.groups.length, 29);
  assert.equal(outstanding(nested.company, nested.vouchers, FROM, TO).receivable, 12345);
});


test("opposite party balances remain signed and gross owner totals include both groups", () => {
  const book = makeBook();
  book.company.ledgers.push(
    { id: "l-debtor", name: "Customer advance", groupId: "g-debtors", opening: { dc: "Cr", paise: 10001 } },
    { id: "l-creditor", name: "Supplier advance", groupId: "g-creditors", opening: { dc: "Dr", paise: 20002 } },
    { id: "l-overdraft", name: "Overdraft bank", groupId: "g-od", opening: { dc: "Cr", paise: 30003 } },
  );
  const report = outstanding(book.company, book.vouchers, FROM, TO);
  assert.equal(report.receivable, -10001);
  assert.equal(report.payable, 1_500_000 - 20002);
  const totals = bookBalances(book.company, trialBalance(book.company, book.vouchers, FROM, TO).rows);
  assert.equal(totals.debtorCredit, 10001);
  assert.equal(totals.creditorDebit, 20002);
  assert.equal(totals.partyReceivable, 20002);
  assert.equal(totals.partyPayable, 1_500_000 + 10001);
  assert.equal(totals.cashBank, 26_700_000 - 30003);
});

test("report and transfer totals reject values beyond exact integer paise", () => {
  const book = makeBook();
  book.company.ledgers = Array.from({ length: 11 }, (_, index) => ({ id: `l-big-${index}`, name: `Large ledger ${index}`, groupId: "g-cash", opening: { dc: "Dr", paise: 900_000_000_000_000 } }));
  book.vouchers = [];
  assert.throws(() => validateTransfer(book), /totals exceed/);
  assert.throws(() => exportXml(book.company, [], "trial-balance", FROM, TO), /totals exceed/);
  assert.throws(() => cashBankBook(book.company, [], FROM, TO), /totals exceed/);
});

test("integrated HTTP reports, native download headers, and backup roundtrip", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "financer-book-api-"));
  const server = await start({ port: 0, dataDir: dir });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const created = await post("/api/specimen", {});
    assert.equal(created.status, 201);
    const book = await created.json();
    const api = `/api/companies/${book.company.id}`;
    const query = `?from=${book.company.booksFrom}&to=${book.company.booksFrom.slice(0, 4)}-11-07`;
    for (const name of ["group-summary", "cash-bank", "outstanding"]) {
      const response = await fetch(base + api + "/reports/" + name + query);
      assert.equal(response.status, 200);
      const report = await response.json();
      if (name === "outstanding") assert.equal(report.payable, 1_500_000);
      if (name === "cash-bank") assert.equal(report.rows.length, 2);
      if (name === "group-summary") assert.equal(report.debit, report.credit);
    }
    for (const name of ["daybook", "trial-balance", "vouchers"]) {
      const response = await fetch(base + api + "/export/" + name + query);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /application\/xml/);
      assert.match(response.headers.get("content-disposition"), /^attachment; filename="[a-z0-9-]+\.xml"$/);
      assert.match(await response.text(), /<FinancerXmlTcpEnvelope/);
    }
    const backupResponse = await fetch(base + api + "/backup");
    assert.match(backupResponse.headers.get("content-disposition"), /attachment; filename=/);
    const backup = await backupResponse.json();
    const importedResponse = await post("/api/import", backup);
    assert.equal(importedResponse.status, 201);
    const imported = await importedResponse.json();
    assert.notEqual(imported.company.id, book.company.id);
    assert.deepEqual(imported.vouchers, book.vouchers);
    const expectedTrial = await (await fetch(base + api + "/reports/trial-balance" + query)).json();
    const importedTrial = await (await fetch(`${base}/api/companies/${imported.company.id}/reports/trial-balance${query}`)).json();
    assert.deepEqual(importedTrial, expectedTrial);
    const malformed = structuredClone(backup);
    malformed.company.groups[0].nature = "Income";
    assert.equal((await post("/api/import", malformed)).status, 400);
    assert.equal((await (await fetch(base + "/api/companies")).json()).companies.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});


test("large safe opening balances exported by the app remain importable", () => {
  const book = makeBook();
  book.company.ledgers = [
    { id: "l-big-cash", name: "Large cash", groupId: "g-cash", opening: { dc: "Dr", paise: Number.MAX_SAFE_INTEGER } },
    { id: "l-big-capital", name: "Large capital", groupId: "g-capital", opening: { dc: "Cr", paise: Number.MAX_SAFE_INTEGER } },
  ];
  book.vouchers = [];
  assert.equal(validateTransfer(companyBackup(book.company, [])).company.ledgers[0].opening.paise, Number.MAX_SAFE_INTEGER);
  const totals = bookBalances(book.company, trialBalance(book.company, [], FROM, TO).rows);
  assert.equal(totals.cashBank, Number.MAX_SAFE_INTEGER);
});
