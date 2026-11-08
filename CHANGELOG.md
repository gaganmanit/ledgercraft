# Changelog

All notable changes to Ledgercraft are recorded here. Dates are dd-mm-yyyy.

## Unreleased

### Interface
- New design system (`public/ledgercraft.css`, `docs/DESIGN.md`): a dark cloth cover for navigation with a red spine, white ruled pages, a red hairline on every money column and a double rule under totals. IBM Plex Sans and Plex Mono replace the previous serif and sans faces; bundled fonts shrink from 1.7 MB of TTF to about 360 KB of WOFF2.
- Light and dark pages. The choice follows the system until you pick one with the button at the foot of the cover.
- One reporting period for the whole book, set in the top bar; every statement follows it.
- Voucher entry: Return moves to the next field, ⌘ Return passes the voucher, ⌥ Return adds or fills a line; a half-entered voucher is kept as a draft and restored when you come back.
- Errors appear next to the form they belong to and are read out to assistive technology; a failed page offers "Try again" instead of a dead end.
- The finder is a proper combobox with listbox results.
- Companies page without numbering; the ledger report and day book show dd-mm-yyyy dates everywhere.
- Ledger picker in voucher entry: type any part of a ledger name or its group path and pick from a list that shows each ledger's group and current closing balance with Dr or Cr. Arrow keys move, Return chooses and moves to the amount, Escape closes. When nothing matches, "Create a ledger named …" opens a small form in the line, saves the ledger and selects it without leaving the voucher.
- Download CSV beside Print on every statement with a period (day book, ledger, trial balance, profit & loss, balance sheet, cash & bank, outstanding, invoice register) and on the Ledgers page. Amounts come out as plain numbers with a separate Dr/Cr column, totals included, in UTF-8 with a byte-order mark so that Excel shows ₹ correctly.
- Keyboard shortcuts list on ? and from the cover. Option (Alt) with C, P, R, J, S, U, D or N opens a new Contra, Payment, Receipt, Journal, Sales, Purchase, Debit note or Credit note when you are not typing in a field; the New voucher menu shows each key.
- Day book, ledger report and trial balance show 200 rows at a time with "Show 200 more rows". Search, counts and totals still cover every matching row, printing shows them all, and the CSV holds them all.
- Owner review lists what needs attention: GSTR-1 and GSTR-3B due dates for the latest completed month with GST documents, receivables more than 30 days overdue, bank statement rows without a match, purchase credit awaiting claim or review, and stock items needing review. Each line links to the screen that settles it; the review itself appears first and this block fills in when its checks finish.
- Bank reconciliation opens the most recent imported statement when none is chosen.

- A book that opened from its backup copy shows the server's warning on every page until the next clean save. Deleting a voucher, ledger or group sends the copy you were looking at, so a stale delete is refused.
- The profit and loss and balance sheet pages explain the financial-year rule in their introductions.
- Books settings under Books: numbering series for each voucher type (prefix, suffix with the {fy} token, width, restart each financial year and an optional next number) with the next number shown as the server will issue it, and books and GST period locks that each need a reason to set or lift. Every change is written to the edit log.
- Edit log under Books: every change to the books, newest first, filtered by dates, entry type and words, with a verified or broken chain shown at the top, action pills, links to the vouchers, GST documents and ledgers involved, and 100 entries at a time.
- Party statements under Books: sundry debtors and creditors with closing balance, amount overdue more than 30 days, ageing in six buckets, MSME marks and footer totals, plus a printable statement of account per party with running balance, due dates, overdue days, open items and a CSV download. The ledger report links to it for party ledgers.
- The ledger form takes credit days for sundry debtors and creditors and an MSME mark for creditors (45-day payment rule), and the ledgers table shows them.
- On a new voucher the suggested number follows the voucher date, so yearly series give the right number for a date in another financial year.

### Books
- Income and expense ledgers start every financial year at nil in the trial balance, ledger report and group summary. Earlier years' profit appears as one brought-forward row under Capital, and the balance sheet shows retained profit separately from the current year's profit.
- A profit and loss statement that starts at the books beginning includes the opening balances of income and expense ledgers, so a mid-year migration reconciles with the balance sheet.
- The group summary rolls subgroups into their parents; drilling into a group lists its subgroups with totals above its own ledgers.
- Every save is fsynced and keeps a rolling `.bak` beside `company.json` and `vouchers.json`. A book whose primary file is damaged opens from the backup and reports a warning.
- Same-day vouchers sort naturally (RCT-9 before RCT-10). Deletes honour an out-of-date copy when the request carries one.

### GST
- A sales credit note that reduces tax and is dated after the Section 34(2) cutoff is refused. The message gives the cutoff date and points to a financial credit note without GST.
- Purchases and purchase notes record the supplier's invoice date. The Section 16(4) deadline, GSTR-2B matching and the ITC screen follow it. The same supplier document booked on either side of 1 April is a duplicate.
- SEZ supplies need the recipient's GSTIN and can never fall into B2CS or B2CL.
- TDS, TCS, UIN, non-resident and OIDAR identifiers are accepted on parties with their roles; TDS and UIN holders are B2B customers.
- Reverse-charge reversals marked time-barred stay in the 4(C) working. Rates outside the notified slabs are refused unless an item is marked as a special rate. Services report UQC NA. Invoices may carry a round-off of up to 50 paise to a Round Off ledger.

### Stock, Tally and bank
- Stock opening values follow Tally's sign convention on import and export, so real TallyPrime exports project into active stock.
- Within a day, receipts are processed before issues. A shortage filled later by a priced receipt no longer blanks the year's closing stock, cost of goods sold and gross profit.
- A godown transfer short of stock becomes an item issue instead of aborting the stock replay.
- Bank statement import understands HDFC, SBI, ICICI and Axis layouts: preamble and footer lines, semicolon or tab separators, two-digit years, named months, timestamps and Rs./INR/₹ prefixes. Validation runs once per ledger and statement, so matching answers in milliseconds on a year of data. The reconciliation section may grow to 32 MiB.
- The Windows bridge refuses a start date after the books beginning and also exports Company.xml; when TrialBalance.xml is supplied the importer reconciles every ledger's closing balance. Payroll and non-accounting voucher types and custom primary groups no longer block an import. Exported masters carry party GSTIN, state, address and PIN.
- `npm run demo` (tools/seed-demo.mjs) builds the Saraswati Traders demonstration company through the public API.

### Server
- A per-workstation session token gates the local API. The server prints a start link once; the Mac app opens it automatically. Other programs on the same computer can no longer read or change the books over loopback without it.
- Static files are served from `public/` with path-traversal protection, correct MIME types, ETags and long-lived caching for fonts.
- Navigations from other pages are allowed again; cross-site fetches are still refused.
- Errors are mapped by kind: a missing company is 404, a missing reference file explains how to install it, internal faults return a reference id and are logged; validation messages stay 400.
- `/api/health` reports the app name, version and whether the GSTN reference resources are installed; the server warns at start when they are missing.
- Stricter response headers: no inline styles in the content security policy, no referrer, same-origin resource and opener policies. Same-site fetches from other local ports are refused like cross-site ones.
- The browser runner picks the next free port when 4173 is busy and prints the one it chose; the Mac app keeps its fixed port. Shutdown no longer waits forever on open connections.
- Tests that need downloaded resources skip with the file name instead of failing; a GitHub Actions workflow (tools/ci/github-tests.yml, to be enabled) runs the suite on macOS and Linux.
- `lib/money.js` gains `numberInWords` and `rupeesInWords` (crore, lakh, thousand) for printed documents.

## 1.4.0 — 08-11-2026
- First public release on GitHub: company books, GST billing and returns, stock, reconciliation, Tally migration and the Mac app.
