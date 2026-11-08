import assert from "node:assert/strict";
import test from "node:test";
import { previewTally, restoreTallyArchive } from "../lib/tally-import.js";

// Synthetic books. Tally's books begin on 1 Apr 2026 unless a test says otherwise.
const options = { companyName: "Synthetic Trial Traders", booksFrom: "2026-04-01" };
const file = (name, text) => ({ name, base64: Buffer.from(text).toString("base64") });
const envelope = body => `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${body}</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
const masters = (company = "") => file("Masters.xml", envelope(`${company}
<LEDGER NAME="Cash"><PARENT>Cash-in-Hand</PARENT><OPENINGBALANCE>-10000.00</OPENINGBALANCE></LEDGER>
<LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>10000.00</OPENINGBALANCE></LEDGER>
<LEDGER NAME="Sales"><PARENT>Sales Accounts</PARENT></LEDGER>
<LEDGER NAME="Salary"><PARENT>Indirect Expenses</PARENT></LEDGER>
<LEDGER NAME="Salary Payable"><PARENT>Current Liabilities</PARENT></LEDGER>`));
const receipt = (guid, date, number, paise) => `<VOUCHER VCHTYPE="Receipt"><GUID>${guid}</GUID><DATE>${date}</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>${number}</VOUCHERNUMBER>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${paise}</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${paise}</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>`;
const daybook = (...vouchers) => file("DayBook.xml", envelope(vouchers.join("\n")));
// The layout of Tally's Trial Balance XML export: a DSPACCNAME line followed by its
// DSPACCINFO closing amounts, groups and (with Show Detailed) their ledgers. Debits are negative.
const line = (name, debit, credit) => `<DSPACCNAME><DSPDISPNAME>${name}</DSPDISPNAME></DSPACCNAME><DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>${debit ? "-" + debit : ""}</DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA>${credit || ""}</DSPCLCRAMTA></DSPCLCRAMT></DSPACCINFO>`;
const trialBalance = (...lines) => file("TrialBalance.xml", `<ENVELOPE>${lines.join("\n")}</ENVELOPE>`);
const archiveOf = preview => ({ format: "financer-tally-archive", version: 1, company: preview.company, vouchers: preview.vouchers, sources: preview.sources, records: preview.records, sourceBookHash: null });

test("a supplied Tally trial balance is reconciled ledger by ledger and travels with the archive", () => {
  const preview = previewTally([masters(), daybook(receipt("tb-r1", "20260405", "R1", "500.00")),
    trialBalance(line("Capital Account", "", "10000.00"), line("Capital", "", "10000.00"), line("Current Assets", "10500.00", ""), line("Cash", "10500.00", ""), line("Sales Accounts", "", "500.00"), line("Sales", "", "500.00"))], options);
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
  assert.deepEqual(preview.summary.trialBalanceCheck, { file: "TrialBalance.xml", lines: 6, ledgersCompared: 5, differences: 0, unmatchedNames: 0 });
  assert.equal(preview.sources.length, 3, "The trial balance is retained as an original source file");
  const restored = restoreTallyArchive(archiveOf(preview));
  assert.equal(restored.vouchers.length, 1);
});

test("a partial-period export is blocked when ledger closings differ from Tally's trial balance", () => {
  // Masters carry openings as at the books beginning; the Day Book was cut at a later
  // date, so an earlier Rs 2,000 receipt is missing and Cash and Sales close too low.
  const preview = previewTally([masters(), daybook(receipt("tb-r2", "20260405", "R2", "500.00")),
    trialBalance(line("Capital", "", "10000.00"), line("Cash", "12500.00", ""), line("Sales", "", "2500.00"))], options);
  assert.equal(preview.canCommit, false);
  const differences = preview.issues.filter(issue => issue.code === "trial-balance-difference");
  assert.deepEqual(differences.map(issue => issue.message.split(":")[0]).sort(), ["Cash", "Sales"]);
  assert.match(differences.find(issue => issue.message.startsWith("Cash")).message, /Dr ₹12500\.00 .* Dr ₹10500\.00/);
  assert.equal(preview.summary.trialBalanceCheck.differences, 2);
  // A ledger with a balance that Tally's trial balance omits (a zero closing there) differs too.
  const omitted = previewTally([masters(), daybook(receipt("tb-r3", "20260405", "R3", "500.00")), trialBalance(line("Capital", "", "10000.00"), line("Cash", "10500.00", ""))], options);
  assert.deepEqual(omitted.issues.filter(issue => issue.code === "trial-balance-difference").map(issue => issue.message.split(":")[0]), ["Sales"]);
});

test("a group-only trial balance is reported for review and unknown lines are listed", () => {
  const groups = previewTally([masters(), daybook(receipt("tb-r4", "20260405", "R4", "500.00")), trialBalance(line("Capital Account", "", "10000.00"), line("Current Assets", "10500.00", ""), line("Sales Accounts", "", "500.00"))], options);
  assert.equal(groups.canCommit, true);
  assert.ok(groups.issues.some(issue => issue.code === "trial-balance-not-ledgerwise" && issue.severity === "review"));
  const unknown = previewTally([masters(), daybook(receipt("tb-r5", "20260405", "R5", "500.00")), trialBalance(line("Capital", "", "10000.00"), line("Cash", "10500.00", ""), line("Sales", "", "500.00"), line("Opening Stock", "", ""))], options);
  assert.equal(unknown.canCommit, true, JSON.stringify(unknown.issues));
  assert.match(unknown.issues.find(issue => issue.code === "trial-balance-unmatched").message, /Opening Stock/);
  const broken = previewTally([masters(), daybook(receipt("tb-r6", "20260405", "R6", "500.00")), file("TrialBalance.xml", "<ENVELOPE><DSPACCNAME><DSPDISPNAME>Cash</DSPDISPNAME></DSPACCNAME></ENVELOPE>")], options);
  assert.equal(broken.canCommit, false);
  assert.match(broken.issues.find(issue => issue.code === "unreadable-exchange").message, /no closing amounts/);
});

test("an import start later than Tally's books beginning date is refused", () => {
  const company = `<COMPANY NAME="Synthetic Trial Traders"><NAME>Synthetic Trial Traders</NAME><BOOKSFROM TYPE="Date">20190401</BOOKSFROM></COMPANY>`;
  const later = previewTally([masters(company), daybook(receipt("tb-r7", "20260405", "R7", "500.00"))], options);
  assert.equal(later.canCommit, false);
  assert.match(later.issues.find(issue => issue.code === "books-from-after-source").message, /begin on 2019-04-01/);
  const same = previewTally([masters(company), daybook(receipt("tb-r8", "20260405", "R8", "500.00"))], { ...options, booksFrom: "2019-04-01" });
  assert.equal(same.canCommit, true, JSON.stringify(same.issues));
  const fromSource = previewTally([masters(company), daybook(receipt("tb-r9", "20260405", "R9", "500.00"))], { companyName: options.companyName });
  assert.equal(fromSource.company.booksFrom, "2019-04-01");
  assert.equal(fromSource.canCommit, true);
});

test("payroll posts as a journal while attendance, job-work and material vouchers are skipped with a reason", () => {
  const typed = (type, guid, entries = "") => `<VOUCHER VCHTYPE="${type}"><GUID>${guid}</GUID><DATE>20260410</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${guid}</VOUCHERNUMBER>${entries}</VOUCHER>`;
  const salary = `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Salary</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1500.00</AMOUNT></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Salary Payable</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1500.00</AMOUNT></ALLLEDGERENTRIES.LIST>`;
  const types = file("VoucherTypes.xml", envelope(`<VOUCHERTYPE NAME="Staff Attendance"><PARENT>Attendance</PARENT></VOUCHERTYPE><VOUCHERTYPE NAME="Monthly Payroll"><PARENT>Payroll</PARENT></VOUCHERTYPE>`));
  const preview = previewTally([masters(), types, daybook(
    typed("Attendance", "att-1"), typed("Staff Attendance", "att-2"), typed("Material In", "mat-in-1"), typed("Material Out", "mat-out-1"),
    typed("Job Work In Order", "jw-in-1"), typed("Job Work Out Order", "jw-out-1"), typed("Payroll", "pay-1", salary), typed("Monthly Payroll", "pay-2", salary), typed("Payroll", "pay-empty"))], options);
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues.filter(issue => issue.severity === "blocking")));
  const skipped = preview.issues.filter(issue => issue.code === "nonposting-voucher");
  assert.equal(skipped.length, 7);
  assert.match(skipped.find(issue => issue.message.startsWith("Attendance")).message, /attendance and production quantities/);
  assert.match(skipped.find(issue => issue.message.startsWith("Material In")).message, /job-work material received/);
  assert.match(skipped.find(issue => issue.message.startsWith("Job Work Out Order")).message, /job-work order/);
  assert.match(skipped.find(issue => issue.message.startsWith("Payroll pay-empty")).message, /payroll voucher with no ledger amounts/);
  assert.equal(preview.vouchers.length, 2);
  assert.deepEqual(preview.vouchers.map(voucher => voucher.type), ["Journal", "Journal"]);
  assert.equal(preview.issues.filter(issue => issue.code === "payroll-as-journal").length, 2);
  assert.equal(preview.summary.reconciliation.excludedVouchers, 7);
});

test("books committed before the books-beginning guard still rebuild, and stock-in-hand differences are only flagged", () => {
  const company = `<COMPANY NAME="Synthetic Trial Traders"><NAME>Synthetic Trial Traders</NAME><BOOKSFROM TYPE="Date">20190401</BOOKSFROM></COMPANY>`;
  const source = [masters(company), daybook(receipt("tb-r10", "20260405", "R10", "500.00"))];
  // An archive accepted under the older rules carries its later start date.
  const replayed = previewTally(source, { ...options, replay: true });
  assert.equal(replayed.canCommit, true, JSON.stringify(replayed.issues));
  assert.equal(restoreTallyArchive(archiveOf(replayed)).company.booksFrom, "2026-04-01");
  const stock = file("Masters.xml", envelope(`<LEDGER NAME="Cash"><PARENT>Cash-in-Hand</PARENT><OPENINGBALANCE>-10000.00</OPENINGBALANCE></LEDGER>
<LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>12000.00</OPENINGBALANCE></LEDGER>
<LEDGER NAME="Stock Ledger"><PARENT>Stock-in-Hand</PARENT><OPENINGBALANCE>-2000.00</OPENINGBALANCE></LEDGER>`));
  const flagged = previewTally([stock, trialBalance(line("Cash", "10000.00", ""), line("Capital", "", "12000.00"), line("Stock Ledger", "2500.00", ""))], options);
  assert.equal(flagged.canCommit, true, JSON.stringify(flagged.issues));
  assert.match(flagged.issues.find(issue => issue.code === "trial-balance-stock-ledger").message, /Stock Ledger/);
});

test("custom primary groups are placed under the reserved head matching their Tally nature instead of blocking", () => {
  const groups = file("Masters.xml", envelope(`<GROUP NAME="Partners Funds"><PARENT></PARENT><NATURE>Liabilities</NATURE><ISREVENUE>No</ISREVENUE></GROUP>
<GROUP NAME="Project Costs"><PARENT>&#4; Primary</PARENT><ISREVENUE>Yes</ISREVENUE><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AFFECTSGROSSPROFIT>Yes</AFFECTSGROSSPROFIT></GROUP>
<GROUP NAME="Site Machinery"><PARENT>Primary</PARENT><ISREVENUE>No</ISREVENUE><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></GROUP>
<GROUP NAME="Partner Current Accounts"><PARENT>Partners Funds</PARENT></GROUP>
<LEDGER NAME="Cash"><PARENT>Cash-in-Hand</PARENT><OPENINGBALANCE>-1000.00</OPENINGBALANCE></LEDGER>
<LEDGER NAME="Partner A"><PARENT>Partner Current Accounts</PARENT><OPENINGBALANCE>1000.00</OPENINGBALANCE></LEDGER>
<LEDGER NAME="Site labour"><PARENT>Project Costs</PARENT></LEDGER>
<LEDGER NAME="Excavator"><PARENT>Site Machinery</PARENT></LEDGER>`));
  const preview = previewTally([groups], options);
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues.filter(issue => issue.severity === "blocking")));
  const parentOf = name => preview.company.groups.find(group => group.id === preview.company.groups.find(row => row.name === name).parentId).id;
  assert.equal(parentOf("Partners Funds"), "g-capital");
  assert.equal(parentOf("Project Costs"), "g-direct-exp");
  assert.equal(parentOf("Site Machinery"), "g-fixed");
  assert.equal(preview.issues.filter(issue => issue.code === "primary-group-placed").length, 3);
  const unknown = previewTally([file("Masters.xml", envelope(`<GROUP NAME="Mystery Head"><PARENT/></GROUP><LEDGER NAME="Cash"><PARENT>Cash-in-Hand</PARENT></LEDGER>`))], options);
  assert.equal(unknown.canCommit, false);
  assert.match(unknown.issues.find(issue => issue.code === "unmapped-group").message, /primary group in Tally, but its nature/);
});

test("a Company.xml beside a masters file that also names the company is a reviewed duplicate, not a conflict", () => {
  const withName = masters(`<COMPANY NAME="Synthetic Trial Traders"><NAME>Synthetic Trial Traders</NAME><BASECURRENCYSYMBOL>₹</BASECURRENCYSYMBOL></COMPANY>`);
  const companyFile = file("Company.xml", `<ENVELOPE><BODY><DATA><COLLECTION><COMPANY NAME="Synthetic Trial Traders"><NAME>Synthetic Trial Traders</NAME><BOOKSFROM TYPE="Date">20260401</BOOKSFROM></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>`);
  const preview = previewTally([withName, companyFile, daybook(receipt("tb-r11", "20260405", "R11", "500.00"))], { companyName: options.companyName });
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues.filter(issue => issue.severity === "blocking")));
  assert.equal(preview.company.booksFrom, "2026-04-01", "the books beginning date is read from whichever company record carries it");
  assert.equal(preview.issues.find(issue => issue.code === "conflicting-record").severity, "review");
  const clash = file("Company.xml", `<ENVELOPE><COMPANY NAME="Synthetic Trial Traders"><BOOKSFROM>20250401</BOOKSFROM></COMPANY></ENVELOPE>`);
  const conflicting = previewTally([masters(`<COMPANY NAME="Synthetic Trial Traders"><BOOKSFROM>20260401</BOOKSFROM></COMPANY>`), clash], options);
  assert.equal(conflicting.canCommit, false);
});
