import assert from "node:assert/strict";
import test from "node:test";
import { reservedGroups } from "../lib/groups.js";
import { assertReconciliation, bankReport, mutateReconciliation, parseBankCsv, previewBankStatement } from "../lib/reconciliation.js";
import { statementDate } from "../lib/reconciliation-bank.js";
import { signedMoney } from "../lib/reconciliation-common.js";

// Synthetic books: one receipt (RCT-001, Rs 60) and one payment (PAY-001, Rs 40) through the bank.
function books() {
  const company = { id: "csv-books", name: "Synthetic CSV books", booksFrom: "2026-04-01", groups: reservedGroups(), ledgers: [
    { id: "l-bank", name: "Synthetic Bank", groupId: "g-bank", opening: { dc: "Dr", paise: 100000 } },
    { id: "l-party", name: "Synthetic Party", groupId: "g-debtors", opening: { dc: "Dr", paise: 0 } }] };
  const vouchers = [
    { id: "v-receipt", type: "Receipt", number: "RCT-001", date: "2026-04-05", narration: "", lines: [{ ledgerId: "l-bank", dc: "Dr", paise: 6000 }, { ledgerId: "l-party", dc: "Cr", paise: 6000 }] },
    { id: "v-payment", type: "Payment", number: "PAY-001", date: "2026-04-06", narration: "", lines: [{ ledgerId: "l-party", dc: "Dr", paise: 4000 }, { ledgerId: "l-bank", dc: "Cr", paise: 4000 }] },
  ];
  return { company, vouchers };
}
const statement = (csv, mapping, extra = {}) => ({ ledgerId: "l-bank", name: "April", from: "2026-04-01", to: "2026-04-30", openingPaise: 100000, closingPaise: 102000, csv, mapping, dateFormat: "dd/mm/yyyy", ...extra });

// Synthetic statements laid out like the downloads of four Indian banks.
const HDFC = [
  "HDFC BANK Ltd.,,,,,,",
  "Statement of account,,,,,,",
  "Account No :,50100012345678,,,,,",
  "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
  "********,********,********,********,********,********,********",
  "05/04/26,NEFT CR-SYNTHETIC CUSTOMER A,RCT-001,05/04/26,,60.00,1060.00",
  "06/04/26,UPI-SYNTHETIC SUPPLIER,PAY-001,06/04/26,40.00,,1020.00",
  "********,********,********,********,********,********,********",
  "STATEMENT SUMMARY :-,,,,,,",
  "Opening Balance,Dr Count,Cr Count,Debits,Credits,Closing Bal,",
  "\"1,000.00\",1,1,40.00,60.00,\"1,020.00\",",
  "Generated On: 08/11/2026 10:15:00",
].join("\n");
const SBI = [
  "Account Name\t:\tSYNTHETIC TRADERS",
  "Address\t:\tTEST ROAD",
  "Account Number\t:\t00000012345678901",
  "",
  "Txn Date\tValue Date\tDescription\tRef No./Cheque No.\tDebit\tCredit\tBalance",
  "5 Apr 2026\t5 Apr 2026\tBY TRANSFER-NEFT SYNTHETIC CUSTOMER A\tRCT-001\t\t60.00\t1,060.00",
  "6 Apr 2026\t6 Apr 2026\tTO TRANSFER-UPI SYNTHETIC SUPPLIER\tPAY-001\t40.00\t\t1,020.00",
  "**This is a computer generated statement and does not require a signature.",
].join("\r\n");
const ICICI = [
  "DETAILED STATEMENT,,,,,,,",
  "Transactions List - SYNTHETIC TRADERS (INR) - 000000000000,,,,,,,",
  "S No.,Value Date,Transaction Date,Cheque Number,Transaction Remarks,Withdrawal Amount (INR ),Deposit Amount (INR ),Balance (INR )",
  "1,05-Apr-2026,05-Apr-2026,RCT-001,NEFT-SYNTHETIC CUSTOMER A,0.00,60.00,\"1,060.00\"",
  "2,06-Apr-2026,06-Apr-2026,PAY-001,UPI-SYNTHETIC SUPPLIER,40.00,0.00,\"1,020.00\"",
  "Legends Used in Account Statement,,,,,,,",
  "\"NEFT - National Electronic Funds Transfer, UPI - Unified Payments Interface\",,,,,,,",
].join("\n");
const AXIS = [
  "Name :- SYNTHETIC TRADERS",
  "Statement of Account No - 000000000000 for the period (From : 01-04-2026 To : 30-04-2026)",
  "",
  "Tran Date;CHQNO;PARTICULARS;DR;CR;BAL;SOL",
  "05-04-2026 10:15:22;RCT-001;NEFT/SYNTHETIC CUSTOMER A;;Rs. 60.00;Rs. 1,060.00;1234",
  "06-04-2026 11:02:09;PAY-001;UPI/SYNTHETIC SUPPLIER;INR 40.00;;INR 1,020.00;1234",
  ";;;;;;",
  "Unless the constituent notifies the bank immediately of any discrepancy, the statement is treated as correct.",
].join("\n");

const layouts = [
  ["HDFC delimited (dd/mm/yy, preamble, separator and summary rows)", HDFC, { date: "Date", narration: "Narration", reference: "Chq./Ref.No.", debit: "Withdrawal Amt.", credit: "Deposit Amt." }, "Date", [6, 7]],
  ["SBI tab-separated (dd MMM yyyy, account details, footer)", SBI, { date: 0, narration: 2, reference: 3, debit: 4, credit: 5 }, "Txn Date", [5, 6]],
  ["ICICI detailed statement (dd-MMM-yyyy, legends)", ICICI, { date: 2, narration: 4, reference: 3, debit: 5, credit: 6 }, "S No.", [4, 5]],
  ["Axis semicolon export (timestamps, Rs./INR prefixes)", AXIS, { date: 0, narration: 2, reference: 1, debit: 3, credit: 4 }, "Tran Date", [4, 5]],
];

// Source rows count the non-empty CSV rows from 1, as statement row numbers always have.
for (const [name, csv, mapping, firstHeader, sourceRows] of layouts) {
  test(`bank CSV: ${name} imports, reconciles and revalidates`, () => {
    const { company, vouchers } = books();
    const parsed = parseBankCsv(csv, { mapping });
    assert.equal(parsed.headers[0], firstHeader);
    assert.equal(parsed.records.length >= 2, true);
    const preview = previewBankStatement(company, vouchers, statement(csv, mapping));
    assert.deepEqual(preview.rows.map(row => [row.date, row.amountPaise, row.reference]), [["2026-04-05", 6000, "RCT-001"], ["2026-04-06", -4000, "PAY-001"]]);
    assert.deepEqual(preview.rows.map(row => row.sourceRow), sourceRows);
    assert.equal(preview.computedClosingPaise, 102000);
    assert.ok(preview.ignoredRows.length > 0, "Rows around the table are listed, not silently dropped");
    assert.ok(preview.ignoredRows.every(row => Number.isSafeInteger(row.sourceRow) && /statement|movement/i.test(row.reason)));
    assert.ok(preview.csvLayout && [",", ";", "\t"].includes(preview.csvLayout.delimiter));
    const imported = mutateReconciliation(null, { company, vouchers }, "import-statement", { ...statement(csv, mapping), requestId: crypto.randomUUID(), revision: 0 });
    const saved = imported.section;
    assertReconciliation({ ...company, reconciliation: saved }, vouchers);
    const report = bankReport(saved, company, vouchers, imported.result.id);
    assert.equal(report.rows[0].candidateKind, "amount-date-reference");
    assert.equal(report.totals.differencePaise, 0);
    const tampered = structuredClone(saved);
    tampered.statements[0].ignoredRows.pop();
    assert.throws(() => assertReconciliation({ ...company, reconciliation: tampered }, vouchers), /bank statement source/);
  });
}

test("bank CSV: already-supported plain files keep their exact reading and saved statements without a layout still validate", () => {
  const { company, vouchers } = books();
  const csv = 'Date,Details,Reference,Debit,Credit\r\n05/04/2026,"Customer, A",RCT-001,,60.00\r\n06/04/2026,Supplier,PAY-001,40.00,\r\n';
  const mapping = { date: 0, narration: 1, reference: 2, debit: 3, credit: 4 };
  const parsed = parseBankCsv(csv);
  assert.deepEqual(parsed.headers, ["Date", "Details", "Reference", "Debit", "Credit"]);
  assert.deepEqual(parsed.records[0], ["05/04/2026", "Customer, A", "RCT-001", "", "60.00"]);
  const preview = previewBankStatement(company, vouchers, statement(csv, mapping));
  assert.deepEqual(preview.rows.map(row => row.sourceRow), [2, 3]);
  assert.deepEqual(preview.ignoredRows, []);
  const imported = mutateReconciliation(null, { company, vouchers }, "import-statement", { ...statement(csv, mapping), requestId: crypto.randomUUID(), revision: 0 });
  const legacy = structuredClone(imported.section);
  delete legacy.statements[0].csvLayout;
  assertReconciliation({ ...company, reconciliation: legacy }, vouchers);
  // The legacy reading stays as strict as before: a preamble cannot be reinterpreted.
  assert.throws(() => parseBankCsv(HDFC, { legacy: true }), /same number of columns/);
  // Rows with the wrong width inside the table still stop the import.
  assert.throws(() => parseBankCsv("Date,Amount\n2026-04-05,1.00\n2026-04-06\n2026-04-07,2.00\n"), /CSV row 3 has 1 columns/);
  // A mistyped date inside the table is still an error, never an ignored row.
  assert.throws(() => previewBankStatement(company, vouchers, statement("Date,Debit,Credit\n05/04/2026,,60.00\n31/04/2026,40.00,\n", { date: 0, debit: 1, credit: 2 })), /CSV row 3. Enter a valid statement date/);
});

test("bank CSV: Indian date layouts, two-digit years and times of day", () => {
  const cases = [
    ["05/04/26", "dd/mm/yyyy", "2026-04-05"], ["05-04-26", "dd-mm-yyyy", "2026-04-05"], ["05/04/75", "dd/mm/yyyy", "1975-04-05"],
    ["01-Apr-2024", "dd/mm/yyyy", "2024-04-01"], ["01 Apr 2024", "dd/mm/yyyy", "2024-04-01"], ["1 April 2024", "dd-mm-yyyy", "2024-04-01"],
    ["01-Sept-24", "dd/mm/yyyy", "2024-09-01"], ["Apr 01, 2024", "mm/dd/yyyy", "2024-04-01"], ["04/01/2024", "mm/dd/yyyy", "2024-04-01"],
    ["01/04/2024 10:15:22", "dd/mm/yyyy", "2024-04-01"], ["01-04-2024 10:15 AM", "dd-mm-yyyy", "2024-04-01"], ["01.04.2024", "dd/mm/yyyy", "2024-04-01"],
    ["2024-04-01T10:00:00Z", "yyyy-mm-dd", "2024-04-01"], ["2024-04-01 23:59:59", "yyyy-mm-dd", "2024-04-01"], ["2024-04-01", "dd/mm/yyyy", "2024-04-01"],
  ];
  for (const [input, format, expected] of cases) assert.equal(statementDate(input, format), expected, `${input} as ${format}`);
  for (const [input, format] of [["31/04/2026", "dd/mm/yyyy"], ["32-Apr-2024", "dd/mm/yyyy"], ["01-Foo-2024", "dd/mm/yyyy"], ["Total", "dd/mm/yyyy"], ["2024/13/01", "yyyy-mm-dd"]]) {
    assert.throws(() => statementDate(input, format), /statement date|date format/, `${input} as ${format}`);
  }
});

test("bank CSV: currency prefixes, suffixes and thousands separators in amounts", () => {
  for (const [input, paise] of [["INR 1,234.50", 123450], ["Rs. 60.00", 6000], ["Rs 60", 6000], ["₹ 1,23,456.00", 12345600], ["INR -40.00", -4000], ["-INR 40.00", -4000],
    ["(Rs. 40.00)", -4000], ["40.00 Dr", -4000], ["1,000.00 INR", 100000], ["₹60", 6000], ["", 0]]) assert.equal(signedMoney(input), paise, input);
  assert.throws(() => signedMoney("-40.00 Dr"), /one sign format/);
  assert.throws(() => signedMoney("USD 40.00"), /amount in rupees/);
});
