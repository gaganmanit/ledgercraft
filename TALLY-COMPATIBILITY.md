# Tally compatibility

Ledgercraft imports an accounting projection from supported Tally exchange files and keeps the original source with the new company. Accounting postings, activated operational data and retained reference details are separate. A retained field is available for inspection; it does not by itself become an active stock, GST, payroll or reconciliation record.

## Accepted inputs

| Input | Current treatment |
| --- | --- |
| TallyPrime or Tally.ERP 9 XML masters and vouchers | Standard and custom account groups, ledger openings, supported accounting voucher types and invoice accounting allocations |
| Tally native JSON exchange objects and collections | The same accounting mapping used for XML |
| TallyPrime default Excel templates | Header-based accounting voucher, ledger and stock-item projections; a ZIP may contain one supported workbook |
| Full Ledgercraft Tally archive | Current books, retained source files and recorded import decisions restored into a new company |
| Proprietary company files or native backups | Export through a compatible licensed Tally installation before import |

XML input supports UTF-8 and the supported UTF-16 byte orders. Source bytes and SHA-256 hashes are preserved independently of the parsed records. The workbook reader retains cell references, raw values, formula text, cached values and formatting where supplied; unsupported or unresolved cells remain visible.

## Accounting projection

The importer maps the standard account-group tree and supported custom child groups, ledger opening balances and eight accounting voucher types: Receipt, Payment, Contra, Journal, Sales, Purchase, Debit Note and Credit Note. A custom voucher type can inherit a supported exported parent.

Invoice inventory accounting allocations can complete the accounting posting when the source uses that structure. The original type, date, number and source identity remain available when Ledgercraft needs to disambiguate an internal voucher number.

Cancelled, optional and recognised non-accounting order or inventory records are retained without accounting postings. Attendance, Material In and Out and Job Work order vouchers are skipped with a listed reason rather than blocking the import; Payroll vouchers post as journals. Custom primary groups are mapped from their Tally nature flags into a top-level group. Cost centres, bank allocations, extension fields and unsupported policies remain source details unless a specific operational workflow supports them.

Missing masters, unknown groups, conflicting identities, unsupported accounting types, contradictory signs, unbalanced postings and amounts outside the safe paise range can block creation. A debit/credit sign disagreement requires a reviewed interpretation that still passes the voucher's accounting rules.

## Preview and overlap decisions

Import preview reconciles source and proposed posting counts, debit and credit totals, excluded records, duplicates and exceptions. When the export includes TrialBalance.xml, the preview compares every ledger's closing balance with the source and blocks on any difference; the Windows bridge exports it, together with Company.xml, and refuses a start date after the books beginning so that opening balances cannot be misstated by a partial period. Referenced ledger groups can be reviewed when a transaction workbook does not contain full masters. A transaction-only workbook exposes its missing opening-balance scope; movements from a selected starting date do not establish the company's complete historical closing balances.

Identical source copies are deduplicated. Distinct records in separate exports that share a voucher type, date and number require an authoritative-source choice or an explicit decision that they are separate transactions. Changing files, dates, names or review choices invalidates the prior confirmation. An obsolete preview response cannot restore that confirmation.

Import creates a new company. Repeating a valid confirmation token returns that imported company rather than posting the same import again.

## Stock, quantities and costing

Supported stock masters use simple units with declared precision of zero to six decimal places. Opening quantities, values and godown allocations must reconcile to their item. Supported sales, purchases and quantity stock-journal transfers can create linked native stock movements.

Actual quantities drive physical movement. Billed quantities remain separately identifiable. If a workbook supplies only billed quantities, the operator can explicitly confirm that they represent the physical quantities; otherwise that physical quantity remains unresolved. A GST reporting-only choice does not invent a stock movement.

Ledgercraft supports perpetual FIFO and moving-average costing. Source FIFO Perpetual items can use the native FIFO policy. Stock opening values follow Tally's sign convention on import and export: a negative OPENINGVALUE is the normal debit stock value, and a positive one is flagged for review. Within one day, receipts are processed before issues, so a sale entered before the same day's purchase does not leave the year's valuation incomplete. An omitted source costing policy is a disclosed gap. Annual FIFO, LIFO, standard-cost schedules and other unsupported valuation methods remain source exceptions. Selling price does not supply outgoing inventory cost.

Compound or alternate units, named batches, inconsistent location breakups, allocated additional costs, manufacturing transformations, order/receipt workflows and nested-location rollups need further coverage. Source price schedules and bills of materials can be retained without becoming active operational rules. Omitted stock remains an explicit limitation in the stock and financial working figures.

New imports save supported stock projections. Earlier imports can review activation in **Tally source**. Activation checks the original accounting linkage and preserves independent operator settings and unrelated stock records.

## GST facts and activation

Imported tax ledger postings form part of the accounting book. Creating a native GST document is a separate reviewed action. The current source-GST workflow supports reconciled domestic forward-charge taxable goods sales, purchases and supported linked credit and debit notes. Other document types, classifications and tax components remain available for review.

The source review shows seller and buyer GSTINs, HSN, GST rates and tax classification facts from supported invoice fields and companion masters. Provenance identifies the source record, field and effective date. Future or conflicting master facts are distinguished from facts applicable to the invoice date.

Select the business registration, the corresponding customer or supplier ledger, the stock item and the original posting accounts. Applicable historical HSN and rates can supply the invoice snapshot even when the current item master has changed. Choosing a different local value requires an explicit correction reason and supporting evidence. The review preserves the source value, local-master value and chosen basis. Saving a mapping does not rewrite the source file.

Activation checks item values, tax components, total consideration, party linkage and the exact accounting posting. It preserves the imported voucher and supported original stock linkage. Confirmed invoices then feed the supported GST returns and HSN workings. Search and pages limit the review to the displayed rows; unsaved drafts survive page changes and selections apply only to the displayed page.

On a regular purchase the supplier GSTIN comes from the creditor and the buyer GSTIN from the company. The stock receipt carries actual quantity and cost, while invoice lines use billed quantity. The booking date, supplier invoice date and reviewed goods-received date are separate. A missing supplier reference or date requires supporting evidence before activation. Input tax remains pending until a dated review. A later match to a saved GSTR-2B file uses the supplier number and document date. Supported outward invoices keep their previous source representation.

### Credit and debit notes

Choose the role of the party, the verified original invoice and the affected original lines. Search the original-invoice list by number or party. Each note retains its Tally voucher type, number, posting accounts and source evidence. An outward credit note reduces the customer balance. A buyer's debit note can represent a supplier's statutory credit note, and a buyer's credit note can represent a supplier's statutory debit note. These inward cases require confirmation of the supplier's document. GSTR-2B matching uses its number and date.

For a physical return, reconcile the actual and billed quantities and the original cost. For a price adjustment without a source inventory row, allocate the adjustment to original invoice lines. Both flows retain the original HSN, rate and unit. A purchase cost adjustment whose allocation to stock is unresolved remains visible as a valuation issue. A dated ITC review records the effect of an inward note on credit already claimed.

The reduced output tax from a domestic taxable sales credit note needs a separate section 34 review in **GST returns**. An issued note and its original posting remain accessible while the reduction is held. The working return checks the proposed declaration against the original supply year, reported annual-return filing date and recipient evidence.

The automated round trip imports synthetic source documents, exports the supported notes and originals in Tally XML and reactivates them in Ledgercraft. Unsupported allocations can be recovered from the original source archive. The public regression suite exercises Ledgercraft's importer and exporter. Licensed TallyPrime and GST Portal acceptance remain open. [Tally sales returns](https://help.tallysolutions.com/sales-return-tally/) · [Tally purchase returns](https://help.tallysolutions.com/tally-prime/purchase-process/purchase-returns-tally/) · [CGST Act, section 34](https://taxinformation.cbic.gov.in/content-page/explore-act/1000304/1000001)

Source IRNs, acknowledgement numbers, e-way bill numbers and transport particulars remain source references. A repeated number or a supplied identifier does not establish an authenticated government acknowledgement. The document exchange workflow records separately imported acknowledgement evidence.

## Bills and banking

Supported New Ref, Agst Ref and dated opening bill references reconcile to the party posting before activation. The native bill register supports due dates and partial settlements. Deliberately removed links stay removed when the source is reviewed again.

Ambiguous references, unsupported credit terms, contradictory allocation signs, mixed opening directions and named advances can remain source exceptions or on-account balances. Bank references are retained. Ledgercraft's bank reconciliation can compare a separately imported statement with the accounting postings; Tally's own reconciliation state is not activated by that source import.

## Exports and restoration

**All Masters** exports supported account groups, ledger openings, source-native stock items, simple units and flat godowns with their opening allocations. **Day Book** exports the supported accounting vouchers and linked inventory; supported quantity transfers export as Stock Journals. Unsupported export policies are reported explicitly.

For supported activated purchases the Day Book XML includes the source voucher identity, supplier invoice reference and date, GST registrations, place of supply, item HSN and rates, input-tax postings and physical/billed quantities. Pair it with the All Masters export when reimporting into empty books. An unsupported allocation needs the full original archive. The export is tested by reimport into Ledgercraft.

The original-file download reproduces the captured source bytes. Accounting XML represents the current accounting book. A full Tally archive carries both, together with import decisions and source metadata. The normal company-backup action includes this full source archive for an imported company.

Restore verifies compressed payloads, file hashes, parsed source records, reviewed mappings and linked operational identities. Later edits to the accounting book are distinguished from its original source snapshot. Ordinary and full-source restoration have automated regression coverage.

## Public examples and tests

TallyHelp’s general default voucher workbook posts purchase 1520 for ₹22,000 against Titan Corporation. It contains no item or tax breakdown. A separate synthetic interstate invoice tests ₹200 taxable and ₹36 IGST, three units received against two billed, a March supplier invoice booked in April, an explicitly reviewed credit claim and source restoration. [Fixture sources](test/fixtures/tally-xlsx/SOURCES.json) and [purchase workflow test](test/tally-purchase-workflow.test.js).

The regression suite includes synthetic XML books and documented TallyHelp examples. Public Excel fixtures cover GST sales, ledger masters, price schedules and standard-cost fields. The GST sales workbook has four vouchers and ten item lines, totalling ₹27,200 of item value and ₹4,896 of tax. Its missing seller/HSN details, invalid buyer identifiers and repeated transport references are retained as source gaps or diagnostics. Synthetic supporting masters used in tests are labelled separately from published facts.

After `npm run setup`, these focused checks are available:

```sh
node --test test/tally.test.js test/tally-export.test.js test/tally-bills.test.js test/tally-stock.test.js
node --test test/tally-xlsx.test.js test/tally-workbook-import.test.js test/tally-gst.test.js
node tools/verify-tally-public-examples.mjs
```

The fixture documentation records which inputs are synthetic and which are downloaded public examples. These tests establish the supported projection and restore behavior for those inputs. A migration's final reconciliation requires the source company's trial balance, stock reports and statutory workings from its Tally installation.

## Publisher references

- [Export masters and transactions](https://help.tallysolutions.com/how-to-export-import-entire-data-masters-transactions-to-a-new-company/)
- [Tally sample XML](https://help.tallysolutions.com/sample-xml/)
- [Tally native JSON exchange](https://help.tallysolutions.com/tally-prime-integration-using-json-1/)
- [TallyPrime sample Excel workbooks](https://help.tallysolutions.com/tally-prime/download-sample-excel-files-with-data-for-import/)
- [Stock and batch object reference](https://help.tallysolutions.com/developer-reference/tally-definition-language/appendix/)
