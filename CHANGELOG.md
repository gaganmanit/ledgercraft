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
