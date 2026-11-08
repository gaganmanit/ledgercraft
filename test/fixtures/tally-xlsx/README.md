# Official TallyPrime default workbook fixtures

The public source checkout contains the URLs and SHA-256 hashes in `SOURCES.json`, not the publisher's ZIP archives. Run `python3 tools/prepare-resources.py --fetch --tests` from the repository root to download and verify the four original public workbooks from [TallyHelp](https://help.tallysolutions.com/tally-prime/download-sample-excel-files-with-data-for-import/). After setup, they remain intact local fixtures for offline regression tests and are ignored by source control. Pins were checked on 08-11-2026.

The sales fixture contains four dated vouchers and ten item lines. Its formula cells are independently calculated by the local reader. All four vouchers reuse one IRN, acknowledgement number and e-way bill number; the reader exposes those repeats as source diagnostics. The workbook contains no signed portal response and establishes no authenticated acknowledgement.

The ledger fixture supplies fifteen ledger masters, four opening bill allocations and multiline addresses. The two stock fixtures supply four item names/units each, with price-list or dated standard-cost/price fields. Tests check source retention of those schedules; they do not activate price schedules, BoM, or advanced stock policies.

The downloaded workbooks contain the publisher's sample company/contact identifiers and original document-author metadata. They are public examples, not private customer exports or fabricated Ledgercraft identities. Their availability for download does not place them under Ledgercraft's source licence; this checkout makes no redistribution claim for them.
