# Ledgercraft

Ledgercraft is a local accounting app for company books, Indian GST billing and Tally data migration. It keeps ledgers, double-entry vouchers, stock movements and supporting source files together. A browser interface and a native macOS wrapper use the same accounting engine.

## Download for Mac

[Download Ledgercraft 1.4.0 for Apple Silicon](https://github.com/gaganmanit/ledgercraft/releases/download/v1.4.0/Ledgercraft-1.4.0-macOS-arm64.dmg). The image includes the app and an Applications shortcut. It runs on macOS 13.5 or later. The app is ad hoc signed and has no Apple notarization.

## Get started

Use Node.js 24 or later and Python 3. From the repository root:

```sh
npm run setup
npm start
```

Open [127.0.0.1:4173](http://127.0.0.1:4173). Setup prepares the reference resources and public test fixtures. Once those resources are available, normal book entry and reports run locally.

A fresh workspace includes a synthetic specimen company. Use the company chooser to create your own books. Set the books-beginning date before entering opening balances. Each company has its own masters, vouchers and reporting period.

To build the native Mac app:

```sh
bash mac/build.sh
```

The build creates `dist/Ledgercraft.app`. It requires macOS 13 or later and Xcode Command Line Tools, and bundles the selected Node runtime, interface and fonts. See [Mac build instructions](mac/README.md) for installation and verification.

## Daily books

The company review shows cash and bank, receivables, payables, period profit and recent vouchers. Click a balance to open the corresponding statement. The sidebar opens the day book, ledgers, trial balance, profit and loss, balance sheet and group summaries.

Create account groups and ledgers before passing entries. Ledgercraft supports Receipt, Payment, Contra, Journal, Sales, Purchase, Debit Note and Credit Note vouchers. Amounts are stored in paise, and every posted voucher must balance. Opening balances and dated vouchers feed the same reports.

On Mac, use ⌘K to find a ledger, voucher number, narration or page. ⌘N opens a new receipt. In voucher entry, Option+Return adds a line when the voucher balances or fills the missing amount when it does not. A row with a debit locks its credit field until the debit is cleared, and vice versa. ⌘Return posts a valid balanced entry.

Open a saved voucher from the day book to alter, duplicate or print it. Changes that would invalidate the posted books are rejected.

## GST billing and review

Start in **GST setup**. Save the business registration, customer or supplier, and goods or service masters. The local HSN/SAC directory supports code and description search. An item carries its classification, unit and explicit tax rate.

**New invoice** creates itemised sales, purchases and supported linked notes. Registration, place of supply, tax treatment and dated document particulars determine the posting. The invoice register opens the stored document, its print view and associated accounting entry.

**GST returns** provides GSTR-1 and GSTR-3B working figures, HSN summaries and GSTN-format CSV/XLSX exports. Import a GSTR-2B file to compare supplier documents with the purchase register. Saved statement originals and reviewed matches stay linked to their source.

**Purchase ITC review** records dated claims, reversals, reclaims and permanent cost decisions against a purchase and its evidence. **Reverse charge** separates liability, cash discharge and credit decisions. **Return corrections** preserves the posted transaction while recording supported corrections to previously reported particulars, including their original filing reference and evidence.

The document exchange screens prepare supported IRP and e-way bill payloads and accept acknowledgement files. Portal submission and filing take place through the relevant external service. Source references, prepared payloads and recorded acknowledgements have separate statuses in Ledgercraft.

## Stock and reconciliation

**Stock summary** opens items, godowns, opening values and stock journals. Record transfers, adjustments or physical counts, and inspect quantities and values by item and location. The stock engine supports perpetual FIFO and moving-average costing.

To include stock values in the financial statements, reconcile opening item values to the Stock-in-Hand ledger controls, then enable **Integrate accounts with inventory**. Selling prices and outgoing inventory costs remain separate.

**Bank reconciliation** maps a local CSV statement to a bank ledger and reviews proposed matches. **Bill-wise ageing** follows supported opening bills, invoice references and partial settlements. Imported Tally bank and bill details are reviewed according to the [compatibility guide](TALLY-COMPATIBILITY.md).

## Import from Tally

Select XML masters and vouchers, native JSON exchange files, a supported TallyPrime default Excel workbook, or its single-workbook ZIP. Review the import before creating a separate company. The preview shows postings, source exceptions, ledger mappings, opening-balance scope and possible overlaps between exports.

For a workbook containing billed quantities without actual quantities, physical stock movement needs an explicit quantity decision. The imported company's **Tally source** area retains original files, spreadsheet cells, source fields and transport references.

**GST from Tally** links supported sales to the business registration, customer registration, source stock items and original posting accounts. It shows supplied GST facts with their field and date basis. Applicable historical source classifications and rates can be used for the document while the current master stays unchanged; a correction records its own reason and supporting evidence. Search and paged review retain unsaved mapping drafts. Activation applies only to selected invoices on the displayed page.

Read [Tally compatibility](TALLY-COMPATIBILITY.md) before a migration. A native Tally company folder or proprietary backup needs an export from a compatible licensed Tally installation. The included Windows companion performs read-only exports through an open company's local HTTP service.

## Save and restore

Under **Import & export**, download a company backup or select a backup to restore it as a separate company. The importer also accepts `company.json` and `vouchers.json` selected together. The company backup limit is 64 MB.

A backup contains the current books and retained supporting data. Imported Tally companies include their original source files; saved GST statement and filing-source files travel with their associated review history. Original-file downloads reproduce the stored source bytes. Accounting XML exports describe the current accounting book.

The browser runner stores its working data in the gitignored `.ledgercraft/data/` directory by default. Set `LEDGERCRAFT_HOME` to choose a different workspace. Native Mac books and workstation preferences live under `~/Library/Application Support/Ledgercraft`; the File menu opens that location. Keep backups outside the working data directory when you want a separate copy.

## Tests and development

The workbook checks use Python and openpyxl. Prepare an isolated test environment, then run the automated suite:

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements-test.txt
npm test
```

The suite covers accounting, storage, reconciliation, stock, GST preparation, migration and backup restoration. Test books are synthetic or come from documented public examples. The fixture READMEs and source manifests describe their origins. Optional integration checks use PowerShell, LibreOffice or macOS WebKit when their prerequisites are available; the core test run does not prove a licensed Tally round trip or portal acceptance.

The project uses JavaScript modules and Node's built-in test runner. The main directories are:

| Directory | Purpose |
| --- | --- |
| `lib/` | Accounting, storage, GST, stock and import/export rules |
| `public/` | Browser interface, local fonts and Windows export companion |
| `mac/` | Native wrapper and app build |
| `test/` | Automated tests and documented fixtures |
| `tools/` | Resource preparation, verification and benchmarks |

Ledgercraft currently runs as a single-machine workspace bound to loopback. Shared-server access controls and coordinated multi-user editing are future work. The [roadmap](ROADMAP.md) records the remaining product scope.

## License

Ledgercraft's application code is available under the [MIT license](LICENSE). Third-party components, fonts and downloaded reference data retain their own licenses and attribution; see [third-party notices](THIRD-PARTY.md).
