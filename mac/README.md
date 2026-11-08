# Ledgercraft for Mac

The native app wraps the local accounting server in AppKit and WebKit. It bundles Node, fonts and the book interface, with native printing, file selection, save dialogs and Mac editing shortcuts. Build on macOS 13 or later with Xcode Command Line Tools, Node.js 24 or later, and Python 3 on your PATH.

## Build a candidate

From the repository root, prepare the pinned public resources and build:

```sh
python3 tools/prepare-resources.py --fetch --tests
bash mac/build.sh
```

The result is `dist/Ledgercraft.app`, signed locally with an ad hoc signature. The build does not install or launch it. For another output path, pass that `.app` path as the first argument. An existing destination is left untouched; choose a fresh path for the next candidate. Set `LEDGERCRAFT_NODE` to select another Node executable. Use a standalone Node.js distribution: the build rejects executables that depend on libraries outside macOS system directories. Both a matching single-architecture Node binary and a universal binary are supported; the app contains the architecture of the build machine.

## Verify the candidate

The packaged suite needs the same Python test dependencies as `npm test`; see the repository README. Run:

```sh
bash tools/verify-packaged-app.sh "$PWD/dist/Ledgercraft.app" "$PWD/verification/local"
```

This verifies the bundle signature, runs the accounting tests with the bundled Node and source, exercises the public Tally fixtures, and launches the actual native executable with temporary books and an unused loopback port. It checks the Ledgercraft window and menu, starter company, packaged modules and icon, then removes that temporary workstation. Results go to `verification/local`. `LEDGERCRAFT_PYTHON` selects a Python executable, including one in a virtual environment.

The Windows bridge replay is optional in ordinary tests. Set `FINANCER_TEST_PWSH` to an installed PowerShell 7 executable to include it. The stricter `tools/verified-mac-install.py` installer requires every packaged test to pass without skips and binds installation to `tested-build.json` and the native launch receipt. Its launcher fingerprint excludes the code signature on a temporary copy, while the whole bundle's signature is checked separately.

## Install locally

After reviewing the candidate and verification results, explicitly install it:

```sh
python3 mac/install.py "$PWD/dist/Ledgercraft.app" "$HOME/Applications/Ledgercraft.app"
```

The installer moves the candidate to the target. Updates use a same-volume atomic exchange and preserve the assets used by an open session. The preceding build stays under `~/Library/Application Support/Ledgercraft/Previous Release`. Quit and reopen to use the updated build. Building a distributable signed and notarized release is a separate release step.

## Optional interface checks

The native checks compile local Swift harnesses and use separate synthetic books. These commands do not install an app:

```sh
node tools/verify-ledgercraft-branding-native.mjs
node tools/verify-tally-gst-native.mjs
node tools/verify-itc-native.mjs
node tools/verify-rcm-native.mjs
node tools/verify-stock-history-native.mjs
```

`node tools/verify-stock-native.mjs` also parses a printed PDF and needs PyMuPDF in the selected Python environment. Python browser checks need Playwright and an already installed compatible browser; set `LEDGERCRAFT_TEST_BROWSER` to its executable or use `--browser` with `tools/verify-voucher-ui.py`. They do not download browsers. Optional independent workbook recalculation needs LibreOffice: set `FINANCER_TEST_RECALCULATE=1`, with `LEDGERCRAFT_SOFFICE` if `soffice` is not on your PATH.

## Local storage and compatibility

The public app uses bundle identifier `org.ledgercraft.desktop`, saves its window frame as `LedgercraftMainWindow`, and keeps books and the local service log under `~/Library/Application Support/Ledgercraft`. The File menu opens that folder. It does not migrate another application's installation or data folder.

The internal `FINANCER_*` environment variables, `FinancerBookResources` and `FinancerRuntimeResources` bundle keys, backup formats, health response, WebKit bridge names and native browser marker remain compatible technical interfaces. The launcher starts a loopback server, checks the matching instance at `/api/health`, and drains pending writes when quitting. The deterministic North Mill Traders starter book is bundled for first launch.
