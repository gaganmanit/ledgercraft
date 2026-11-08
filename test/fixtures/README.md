# Test fixture provenance

`tally/*.xml`, `tally-gst-support.xml`, `tally-purchase-gst.xml` and `reconciliation-ui-server.mjs` are independently authored synthetic fixtures. Company names, ledger balances, bank references and GST test identities in them are fictional test inputs. No private company export is included. The Tally XML fixtures follow the documented exchange structure; their descriptions distinguish invented prerequisite quantities and costs from arithmetic taken from public examples.

`tally/official/` and `tally-xlsx/` hold provenance files in source control. Their publisher ZIP/XML fixtures are absent from a fresh checkout. Prepare them with `python3 tools/prepare-resources.py --fetch --tests`; the setup downloads from the named public sources, verifies fixed SHA-256 pins and writes ignored local files. It performs no network request without `--fetch`.

Runtime resource setup also installs the pinned official GSTR-1 XLSX and recreates `lib/resources/hsn-sac.json` from GSTN's pinned `HSN_SAC.xlsx`. The generated JSON reproduces all 22,616 release rows and the exact release hash, including leading-zero code restoration, OOXML carriage-return escapes and whitespace normalization. These public reference resources carry no private customer data; the downloaded publisher material is not relicensed by the project's source licence.

Keep runtime workstations, imported books, backup archives, logs, screenshots and generated verification evidence outside a public source package. A sample workstation can be recreated by `lib/specimen.js`.
