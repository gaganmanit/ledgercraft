import assert from "node:assert/strict";
import test from "node:test";
import { trialBalance } from "../lib/engine.js";
import { reservedGroups } from "../lib/groups.js";
import { exportTallyDayBook, exportTallyMasters, tallyRupees } from "../lib/tally-export.js";
import { previewTally } from "../lib/tally-import.js";
import { attribute, children, findNodes, parseTallyXml, value } from "../lib/tally-format.js";

function publicBooks() {
  const company = {
    id: "public-accounting-example", name: "Public <Accounting> & Books", booksFrom: "2026-04-01", groups: reservedGroups(),
    ledgers: [
      ["cash", "Cash", "g-cash", "Dr", 1_000_050], ["capital", "Capital", "g-capital", "Cr", 1_000_050],
      ["bank", "Bank", "g-bank", "Dr", 0], ["rent", "Office & admin", "g-admin", "Dr", 0],
      ["sales", "Sales", "g-sales", "Dr", 0], ["customer", "Customer", "g-debtors", "Dr", 0],
      ["supplier", "Supplier", "g-creditors", "Dr", 0], ["purchase", "Purchases", "g-purchase", "Dr", 0],
    ].map(([id, name, groupId, dc, paise]) => ({ id: `l-${id}`, name, groupId, opening: { dc, paise } })),
  };
  company.groups.push({ id: "g-admin", name: "Administration & facilities", parentId: "g-indirect-exp", nature: null, gross: false, cashBank: false, reserved: false });
  const postings = [
    ["Receipt", "cash", "sales", 10050], ["Payment", "rent", "cash", 5025], ["Contra", "bank", "cash", 10000],
    ["Journal", "rent", "supplier", 100], ["Sales", "customer", "sales", 12500], ["Purchase", "purchase", "supplier", 7500],
    ["Debit Note", "supplier", "purchase", 1500], ["Credit Note", "sales", "customer", 2500],
  ];
  const vouchers = postings.map(([type, dr, cr, paise], index) => ({
    id: `v-public-${index}`, type, date: `2026-04-${String(index + 2).padStart(2, "0")}`, number: `BOOK-${index + 1}`, narration: 'Public "example" <posting> & exact paise',
    lines: [{ ledgerId: `l-${dr}`, dc: "Dr", paise }, { ledgerId: `l-${cr}`, dc: "Cr", paise }],
  }));
  return { company, vouchers };
}

test("Tally-compatible accounting Masters and Day Book roundtrip every core voucher type", () => {
  const { company, vouchers } = publicBooks();
  const masters = exportTallyMasters(company);
  const daybook = exportTallyDayBook(company, vouchers, "2026-04-01", "2026-04-30");
  const source = [{ name: "Masters.xml", base64: Buffer.from(masters).toString("base64") }, { name: "DayBook.xml", base64: Buffer.from(daybook).toString("base64") }];
  const restored = previewTally(source, { companyName: company.name, booksFrom: company.booksFrom });
  assert.equal(restored.canCommit, true, JSON.stringify(restored.issues));
  assert.deepEqual(restored.vouchers.map((voucher) => voucher.type), vouchers.map((voucher) => voucher.type));
  const simplify = (trial) => trial.rows.map(({ name, groupName, opening, periodDr, periodCr, closing }) => ({ name, groupName, opening, periodDr, periodCr, closing }));
  assert.deepEqual(simplify(trialBalance(restored.company, restored.vouchers, "2026-04-01", "2026-04-30")), simplify(trialBalance(company, vouchers, "2026-04-01", "2026-04-30")));
  assert.equal(restored.summary.reconciliation.failedVouchers, 0);
  assert.equal(restored.summary.reconciliation.sourceDebitPaise, restored.summary.reconciliation.postedDebitPaise);
  assert.ok(masters.includes("Administration &amp; facilities"));
  assert.ok(daybook.includes("&quot;example&quot; &lt;posting&gt; &amp; exact paise"));
});

test("exchange elements and signed decimal amounts follow the documented Tally contract", () => {
  const { company, vouchers } = publicBooks();
  const masters = parseTallyXml(exportTallyMasters(company));
  const daybook = parseTallyXml(exportTallyDayBook(company, vouchers, "2026-04-01", "2026-04-30"));
  assert.equal(findNodes(masters, "TALLYREQUEST")[0].text, "Import Data");
  assert.equal(findNodes(masters, "REPORTNAME")[0].text, "All Masters");
  assert.equal(findNodes(masters, "SVCURRENTCOMPANY")[0].text, company.name);
  assert.equal(findNodes(masters, "GROUP").length, 1);
  assert.equal(findNodes(masters, "LEDGER").length, 8);
  const cash = findNodes(masters, "LEDGER").find((node) => attribute(node, "NAME") === "Cash");
  const capital = findNodes(masters, "LEDGER").find((node) => attribute(node, "NAME") === "Capital");
  assert.equal(value(cash, "OPENINGBALANCE"), "-10000.50");
  assert.equal(value(capital, "OPENINGBALANCE"), "10000.50");
  for (const voucher of findNodes(daybook, "VOUCHER")) {
    assert.equal(attribute(voucher, "OBJVIEW"), "Accounting Voucher View");
    assert.equal(value(voucher, "ISCANCELLED"), "No");
    assert.equal(value(voucher, "ISOPTIONAL"), "No");
    assert.equal(value(voucher, "ISINVOICE"), "No");
    assert.match(value(voucher, "DATE"), /^\d{8}$/);
    for (const line of children(voucher, "ALLLEDGERENTRIES")) {
      const amount = value(line, "AMOUNT");
      assert.match(amount, /^-?\d+\.\d{2}$/);
      assert.equal(amount.startsWith("-"), value(line, "ISDEEMEDPOSITIVE") === "Yes");
    }
  }
});

test("large safe paise retain all decimals and export periods select only matching vouchers", () => {
  assert.equal(tallyRupees(Number.MAX_SAFE_INTEGER, "Dr"), "-90071992547409.91");
  assert.equal(tallyRupees(101, "Cr"), "1.01");
  const { company, vouchers } = publicBooks();
  const xml = parseTallyXml(exportTallyDayBook(company, vouchers, "2026-04-02", "2026-04-02"));
  assert.equal(findNodes(xml, "VOUCHER").length, 1);
  assert.equal(value(findNodes(xml, "VOUCHER")[0], "VOUCHERTYPENAME"), "Receipt");
  assert.throws(() => exportTallyDayBook(company, vouchers, "2026-04-30", "2026-04-01"), /period/);
});
