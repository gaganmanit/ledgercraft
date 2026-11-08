# Ledgercraft interface design

Ledgercraft is a local-first accounting workstation for Indian small businesses and the accountants who look after their books. The interface is built like a ledger: a dark cloth cover on the left, white ruled pages on the right, and figures that always sit in ruled money columns. Everything else stays quiet.

## Who it is for

Owner-operators of trading, manufacturing and service firms who pass their own vouchers, and chartered accountants who review those books, prepare GST returns and reconcile banks. Both groups read figures all day. Both want speed on the keyboard and certainty on screen.

## The one bold element: ruled money columns

Real ledger paper has pale horizontal feint rules and red vertical rules that frame the amount columns. Every table in Ledgercraft carries that ruling. A cell with the `figure` class is a money cell: right-aligned, tabular numerals, a soft red hairline on its left edge. Total rows close with an ink rule above and a double red rule below. This ruling is information, not decoration: wherever the eye meets red hairlines, that is where the money is.

Nothing else competes with it. No cards, no gradients, no shadows beyond the finder dialog, no icons in navigation, no capitalised labels, no numbered markers unless the content is a sequence.

## Tokens

Defined once in `public/ledgercraft.css` under `:root`, with a dark set under `prefers-color-scheme: dark` and `[data-theme="dark"]`.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--sheet` | `#FCFCFA` | `#17191C` | Page surface the books are written on |
| `--desk` | `#E6E8E6` | `#0F1113` | Area around the page |
| `--field` | `#F4F5F2` | `#1F2226` | Input backgrounds, hover rows |
| `--ink` | `#1C1F22` | `#E7E8E5` | Text |
| `--ink-2` | `#4F565C` | `#AEB4BA` | Secondary text |
| `--ink-3` | `#687079` | `#7D858D` | Hints, disabled text (both meet 4.5:1 on the sheet) |
| `--rule` | `#D5DEE9` | `#2B3540` | Feint horizontal row rules |
| `--rule-2` | `#AFC0D6` | `#3D4C5E` | Stronger rules, input borders |
| `--red` | `#A51D2D` | `#EA7B84` | Totals, the spine, destructive actions |
| `--red-rule` | `#E4B7BC` | `#5B2A31` | The hairline on the left of every money column |
| `--red-soft` | `#F6E3E5` | `#3A1F23` | Error backgrounds |
| `--blue` | `#1D4F9E` | `#86ACEF` | Links, focus, selection |
| `--blue-soft` | `#E3ECF9` | `#1C2A42` | Selected rows, info backgrounds |
| `--green`, `--green-soft` | `#1B7A45`, `#E1F2E8` | `#5CC088`, `#17301F` | Balanced, matched, posted |
| `--amber`, `--amber-soft` | `#9A5B00`, `#FBEFD9` | `#E0A33B`, `#3A2A0F` | Needs attention |
| `--blue-soft` | `#E3ECF9` | `#1C2A42` | Selected rows, informational notes |
| `--cover` | `#2B1A1E` | `#141012` | Navigation rail (the book's cloth cover) |
| `--cover-ink` | `#F2ECE6` | `#F2ECE6` | Text on the cover |
| `--cover-ink-2` | `#B9A9A8` | `#9C8E8E` | Secondary text on the cover |

Legacy aliases (`--paper`, `--inset`, `--line`, `--line-strong`, `--vermilion`, `--ink-soft`, `--serif`, `--sans`, `--gutter`) remain mapped to these tokens so that module stylesheets keep working while they are ported. New code uses the new names.

## Type

One family, two faces, both bundled under the SIL Open Font License:

- **IBM Plex Sans** 400, 500, 600 and 400 italic for everything readers see. Figures use `font-variant-numeric: tabular-nums` so columns of amounts align digit for digit. Plex Sans has clearly distinct 0, O, 1, l and I, which matters when the number is the content.
- **IBM Plex Mono** 400 and 500 only for identifiers that people compare character by character: voucher numbers, GSTINs, HSN/SAC codes, IRNs, file hashes. Not for labels, not for amounts.

Scale: body 15px/1.45. Page title 26px/600 with tight tracking. Section heading 18px/600. Sub-heading 15px/600. Table text 14px. Small text 13px. Printed documents use the same family.

Labels are sentence case. No tracked-out capitals, no eyebrow labels, no middle dots between facts. Write facts as short sentences or separate them with spacing.

## Shared components

Module screens compose a small set of classes defined once in `ledgercraft.css`: `table-scroll` for wide tables, `toolbar` for filter rows, `form-grid` with `wide` for two-column forms, `check` for checkbox rows, `subsection` for a titled block separated by a rule, `summary-strip` for a row of headline figures, `kv` for label/value pairs, `pill` with `ok`, `warn`, `bad` or `info` for a state word, `attention-rule` for a list of things needing review, `doc` with `doc-head`, `doc-parties`, `doc-totals` and `doc-signature` for printed statutory documents, and `form-message` for a message that belongs to one form. Buttons are primary by default, `ghost` for secondary actions, `danger` for destructive ones and `link` for inline text actions.

## Layout

```
┌──────────┬────────────────────────────────────────────────────────┐
│ cover    │ North Mill Traders ▾   FY 2026–27   Period 01-04 to 08-11   Find ⌘K │
│          ├────────────────────────────────────────────────────────┤
│ Workspace│                                                        │
│  Owner   │  Trial balance                                          │
│  Day book│  Opening is everything before the period…               │
│ GST      │                                                        │
│  …       │  Ledger            ‖ Opening ‖  Debit ‖ Credit ‖ Closing │
│ Books    │  Cash                1,80,000   25,000   8,000  1,97,000 │
│          │  ─────────────────────────────────────────────────────  │
│ ● Local  │  Totals            ════════════════════════════════════  │
└──────────┴────────────────────────────────────────────────────────┘
```

- The cover (navigation rail) is 232px wide, sticky, with a 3px red spine on its right edge. Groups are headed in sentence case. The current page has a cream bar on its left.
- The top bar belongs to the company: the company switcher, the financial year, the reporting period (one control that every statement follows), and the finder. It is the only place the period is set.
- The sheet is left-aligned prose and tables on a white page with a hairline edge. It fills the available width up to 1280px. Tables may extend to the sheet's edge; prose wraps at 70 characters.
- Controls are 36px tall in toolbars and 40px tall in forms, with a 4px radius. Primary buttons are ink on paper. Secondary buttons are outlined. Destructive buttons are outlined in red.
- Breakpoints: below 1000px the cover narrows; below 760px the cover becomes a horizontal strip and tables scroll horizontally inside the sheet.

## States and words

- A voucher is **balanced** or **off by ₹x**; the difference line says which side is over. Green means balanced. Amber means attention. Red is reserved for the ruling and for errors.
- Buttons say what happens: "Pass voucher", "Save ledger", "Match statement", not "Submit" or "OK".
- An empty table says what to do next, in one sentence, with the action nearby.
- Errors explain what went wrong and how to fix it, in the interface's voice. They do not apologise.
- Keyboard shortcuts are shown inside the control they trigger (`⌘K`, `⌘↩`, `⌥↩`), never in a separate legend.

## Motion

Only in response to the person: dialogs open with a short fade, the difference line changes colour when the voucher balances, a row briefly highlights after it is saved. Nothing animates on load. `prefers-reduced-motion` disables all of it.

## Print

Printing removes the cover and top bar and prints the sheet at full width on white with the ruling intact. Documents such as tax invoices are laid out for A4 with addresses, the item table, totals, and the signatory block kept together.

## Keyboard, export, paging and review (pass 3)

- **Ledger picker.** Each voucher line keeps its `<select name="ledger">` as the value the form submits, hidden with `sr` and taken out of the tab order. In front of it sits a combobox (`.ledger-picker`, `public/ledger-picker.js`): a text field with `role="combobox"`, `aria-expanded`, `aria-controls` and `aria-activedescendant`, and a listbox on `--sheet` with `--shadow`. Each option shows the ledger name, its group path in `.quiet`, and its closing balance as `.figure` text with Dr or Cr. The active option is `--blue-soft`. Name-prefix matches come first. The last option is "Create a ledger named …" when the typed text is not an existing ledger; it opens a small form inside the line with its error in `.form-message.alert`. Setting the select from code updates the field, so drafts, duplicates and browser checks keep working.
- **Download CSV** is a ghost button beside Print in `.sheet-tools` (and beside the search on Ledgers). It exports the first table in the sheet, or the statement lines on profit & loss and balance sheet. A money cell becomes a plain number column plus a Dr/Cr column. Files are named `company-page-from-to.csv` in lower case with dd-mm-yyyy dates. The button does not print.
- **Shortcuts.** Hints still sit inside the control they trigger (`⌘K`, `⌘↩`, `⌥↩`, and `⌥P` beside Payment in the New voucher menu). The `?` dialog (`.shortcuts`, built like the finder, with a short fade that reduced motion turns off) is the complete reference, not a substitute for those hints. Single-key and Option-letter shortcuts never fire while focus is in an input, select or text area, and voucher keys use `event.code` so Option characters on a Mac do not matter.
- **Paging.** Long tables render 200 rows, then a `.table-more` row with a quiet "Showing 200 of 1,240 rows" and a ghost "Show 200 more rows". Filters, counts and footer totals always cover every matching row. Printing and CSV include every row.
- **Needs attention** on Owner review is an `ul.attention-rule` without bullets. Each item is one sentence whose link names the thing to settle. Each check fails on its own, and a failed check is named once in a quiet line instead of being shown as "nothing to do". When everything is clear, one quiet sentence says so.

## Settings and records (pass 4)

- **Books settings** (`#/c/<company>/settings`, `public/settings-ui.js`) holds the numbering series and the period locks. Numbering is one ruled table with a row per voucher type: prefix and suffix in `.code` inputs, a width select, a restart-each-year `.check`, an optional next number, and the next voucher number as the server reports it. The preview never guesses; edited rows say "Changes show after saving". The two locks sit side by side in `.two`, each its own form with the current lock as a `.kv`, a required reason, a primary lock button and, when locked, a `danger` Unlock that asks first. Every change names its effect in one sentence and is written to the edit log.
- **Edit log** (`#/c/<company>/audit`, `public/audit-ui.js`) reads the hash-chained log newest first. A `.toolbar` filters by dates, entry type and words, applied 250 ms after typing stops. A `.pill.ok` "Chain verified" or `.pill.bad` "Chain broken at line N" with the problems in an `.attention-rule` heads the table. Actions are pills: created `ok`, altered `info`, deleted `bad`, locked and unlocked `warn`, restored and imported plain. Vouchers, GST documents and ledgers link to their pages. Paging uses `.table-more` with "Showing n of total entries". Printing drops the toolbar and keeps the pills.
- **Party statements** (`#/c/<company>/parties`, `public/party-ui.js`) lists sundry debtors, then creditors, with closing balance, overdue amount and ageing buckets as `.figure` columns, MSME as `.pill.warn`, and receivable and payable totals in the footer. A statement (`parties/<ledgerId>`) shows the party as a `.kv`, a `.summary-strip` of closing balance, overdue, credit days and oldest open item, the lines with an opening row and a closing total, and the open items in a `.details-list`. Printing keeps the company letterhead, the party block and the lines only. Download CSV is a ghost link to the server's statement file.
- Ledger forms show **Credit days** for ledgers under Sundry Debtors or Sundry Creditors and an **MSME** `.check` for creditors; the ledgers table repeats them as a quiet second line. The ledger report links to the party statement for those ledgers. On a new voucher the suggested number follows the date, so a series that restarts each financial year gets the right number for a date in another year.
