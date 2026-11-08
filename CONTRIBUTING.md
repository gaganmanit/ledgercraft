# Contributing to Ledgercraft

Thank you for looking at the books with us. Ledgercraft is a zero-dependency Node 24 application: the server is plain `node:http`, the browser code is plain ES modules, and tests use `node --test`.

## Set up

```sh
git clone https://github.com/gaganmanit/ledgercraft.git
cd ledgercraft
npm run setup      # downloads and verifies the public reference resources and test fixtures
npm test
npm start          # http://127.0.0.1:4173
```

`npm run setup` needs Python 3 and network access to the GSTN and Tally help sites; the downloads are pinned by SHA-256. Tests that depend on those resources are skipped when the files are absent, so the rest of the suite still runs on a clean machine.

To try the interface with a lived-in book, create a demonstration company:

```sh
node tools/seed-demo.mjs --home .ledgercraft
```

## How the code is organised

- `server.js` routes JSON requests to handlers in `lib/*-routes.js` and serves `public/`.
- `lib/engine.js`, `lib/store.js` and `lib/groups.js` hold the double-entry core. Money is always integer paise.
- `lib/gst*.js`, `lib/stock-*.js`, `lib/reconciliation-*.js` and `lib/tally-*.js` are the domain modules; each has a matching `public/*-ui.js` screen.
- `public/ledgercraft.css` is the design system; `docs/DESIGN.md` explains its decisions. Module stylesheets hold only rules specific to one screen.
- `test/` mirrors `lib/`. Fixtures live in `test/fixtures`; public Tally and GSTN files are fetched by `npm run setup`, never committed.

## Making a change

1. Keep a change to one workflow. Add or adjust a test first when you touch accounting, GST or import behaviour: the test should state the rule in business terms (what the trial balance, return table or stock value must be).
2. Preserve saved-file compatibility. Existing `company.json` and `vouchers.json` files must keep loading; add fields rather than renaming them.
3. Follow the design contract for anything a person sees: sentence case, no decoration, money in `.figure` cells, actions named by what they do, errors next to the form they belong to.
4. Run `npm test` and start the app once to click through the screen you changed.
5. Write the commit message as a short statement of what changed and why. Do not add generated attribution trailers.

## Statutory rules

GST behaviour follows the CGST Act, rules, notifications and GSTN formats current at the time of the change. When you rely on a section, rule, circular or advisory, name it in the code comment or the test so the next person can check it when the law moves.
