# Ledgercraft roadmap

Ledgercraft brings company books, stock, Indian GST preparation and source-preserving migration into one local workspace. Its accounting engine is the common basis for the browser and Mac interfaces. Work is prioritised around complete, reconcilable workflows: a document or import should keep its original evidence, produce the intended posting and survive backup restoration.

## Current product

| Area | Available workflow |
| --- | --- |
| Books | Multiple companies, masters, balanced vouchers, search, printing and financial statements |
| GST | Itemised billing, return workings, HSN reporting, local statement matching, dated ITC and reverse-charge review, supported outward corrections and document exchange preparation |
| Stock | Quantities by godown, journals, physical counts, perpetual costing and optional financial-statement integration |
| Reconciliation | Bank CSV review, bill-wise references, partial settlements and ageing |
| Migration | Reviewed XML, JSON and supported Excel imports, source preservation, operational activation, accounting exports and portable company backups |

See [Tally compatibility](TALLY-COMPATIBILITY.md) for the boundaries between active postings, activated source data and retained reference details.

## Next priorities

### Broader GST reporting

Extend the supported return sections and correction workflows, including same-period corrections, aggregate amendments, additional schemes and e-commerce cases. Keep reported history, current book values and signed return differences traceable to each document. New coverage needs tests against the applicable published format and a restored company.

### More Tally workflows

Extend the reviewed domestic purchase and sales workflow to additional source document types and tax treatments, including services, mixed goods and services, reverse charge and notes with additional allocations. Add operational coverage for further voucher types, allocated costs, compound units, batches, manufacturing and order/receipt flows. Preserve unsupported source details until their posting and quantity effects can be reconciled explicitly.

### More inventory policies

Add source valuation methods and dated price/cost schedules where they can be represented faithfully. A new method needs clear opening controls, location treatment, returns, unknown-cost behavior and a reproducible comparison of quantities and values.

### Audit and shared access

Develop a consistent edit history, access roles and coordinated multi-user writes. The present runtime is a local single-machine workspace. Shared deployment needs an explicit authentication, authorization, backup and recovery design.

### Portable releases

Improve clean-machine setup, reproducible tests and platform packaging. Broaden the documented runtime matrix and establish distribution signing and release checks for supported platforms. Public fixtures, fonts and reference resources need recorded origins and reproducible preparation.

## Acceptance for a new workflow

A feature is ready when its normal user action produces the intended accounting or statutory working result, its rejected cases are visible, and its source and history restore correctly. Automated checks should cover amounts and identities as well as the screen action. Large datasets need bounded responses and usable navigation.

Government portal acceptance and licensed Tally round trips require separate integration evidence. They do not follow from an internal parser test or a balanced voucher. Future integration work will keep document preparation, submission and external acknowledgements distinct.

## Contributing

Start with the [README](README.md), prepare its Python test environment and run `npm run setup`, then `npm test`. Keep a proposed change scoped to one workflow and add a synthetic or clearly attributed public fixture for the behavior it changes. Use test books for development; private company exports and generated working data do not belong in the source tree.

Ledgercraft's code is released under the [MIT license](LICENSE). Keep third-party attribution with the components and reference data it describes.
