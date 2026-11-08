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

Cancelled, optional and recognised non-accounting order or inventory records are retained without accounting postings. Cost centres, payroll, bank allocations, extension fields and unsupported policies remain source details unless a specific operational workflow supports them.

Missing masters, unknown groups, conflicting identities, unsupported accounting types, contradictory signs, unbalanced postings and amounts outside the safe paise range can block creation. A debit/credit sign disagreement requires a reviewed interpretation that still passes the voucher's accounting rules.

## Preview and overlap decisions

Import preview reconciles source and proposed posting counts, debit and credit totals, excluded records, duplicates and exceptions. Referenced ledger groups can be reviewed when a transaction workbook does not contain full masters. A transaction-only workbook exposes its missing opening-balance scope; movements from a selected starting date do not establish the company's complete historical closing balances.

Identical source copies are deduplicated. Distinct records in separate exports that share a voucher type, date and number require an authoritative-source choice or an explicit decision that they are separate transactions. Changing files, dates, names or review choices invalidates the prior confirmation. An obsolete preview response cannot restore that confirmation.

Import creates a new company. Repeating a valid confirmation token returns that imported company rather than posting the same import again.

## Stock, quantities and costing

Supported stock masters use simple units with declared precision of zero to six decimal places. Opening quantities, values and godown allocations must reconcile to their item. Supported sales, purchases and quantity stock-journal transfers can create linked native stock movements.

Actual quantities drive physical movement. Billed quantities remain separately identifiable. If a workbook supplies only billed quantities, the operator can explicitly confirm that they represent the physical quantities; otherwise that physical quantity remains unresolved. A GST reporting-only choice does not invent a stock movement.

Ledgercraft supports perpetual FIFO and moving-average costing. Source FIFO Perpetual items can use the native FIFO policy. An omitted source costing policy is a disclosed gap. Annual FIFO, LIFO, standard-cost schedules and other unsupported valuation methods remain source exceptions. Selling price does not supply outgoing inventory cost.

Compound or alternate units, named batches, inconsistent location breakups, allocated additional costs, manufacturing transformations, order/receipt workflows and nested-location rollups need further coverage. Source price schedules and bills of materials can be retained without becoming active operational rules. Omitted stock remains an explicit limitation in the stock and financial working figures.

New imports save supported stock projections. Earlier imports can review activation in **Tally source**. Activation checks the original accounting linkage and preserves independent operator settings and unrelated stock records.

## GST facts and activation

Imported tax ledger postings form part of the accounting book. Creating a native GST document is a separate reviewed action. The current source-GST workflow supports reconciled domestic forward-charge goods sales; unsupported document types, classifications, adjustments or tax components remain blocked or retained for review.

The source review shows seller and buyer GSTINs, HSN, GST rates and tax classification facts from supported invoice fields and companion masters. Provenance identifies the source record, field and effective date. Future or conflicting master facts are distinguished from facts applicable to the invoice date.

Link the seller registration, customer registration, source item and original posting accounts. Applicable historical HSN and rates can supply the invoice snapshot even when the current item master has changed. Choosing a different local value requires an explicit correction reason and supporting evidence. The review preserves the source value, local-master value and chosen basis. Saving a mapping does not rewrite the source file.

Activation checks item values, tax components, total consideration, party linkage and the exact accounting posting. It preserves the imported voucher and supported original stock linkage. Confirmed invoices then feed the supported GST returns and HSN workings. Search and pages limit the review to the displayed rows; unsaved drafts survive page changes and selections apply only to the displayed page.

Source IRNs, acknowledgement numbers, e-way bill numbers and transport particulars remain source references. A repeated number or a supplied identifier does not establish an authenticated government acknowledgement. The document exchange workflow records separately imported acknowledgement evidence.

## Bills and banking

Supported New Ref, Agst Ref and dated opening bill references reconcile to the party posting before activation. The native bill register supports due dates and partial settlements. Deliberately removed links stay removed when the source is reviewed again.

Ambiguous references, unsupported credit terms, contradictory allocation signs, mixed opening directions and named advances can remain source exceptions or on-account balances. Bank references are retained. Ledgercraft's bank reconciliation can compare a separately imported statement with the accounting postings; Tally's own reconciliation state is not activated by that source import.

## Exports and restoration

**All Masters** exports supported account groups, ledger openings, source-native stock items, simple units and flat godowns with their opening allocations. **Day Book** exports the supported accounting vouchers and linked inventory; supported quantity transfers export as Stock Journals. Unsupported export policies are reported explicitly.

The original-file download reproduces the captured source bytes. Accounting XML represents the current accounting book. A full Tally archive carries both, together with import decisions and source metadata. The normal company-backup action includes this full source archive for an imported company.

Restore verifies compressed payloads, file hashes, parsed source records, reviewed mappings and linked operational identities. Later edits to the accounting book are distinguished from its original source snapshot. Ordinary and full-source restoration have automated regression coverage.

## Public examples and tests

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
