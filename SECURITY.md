# Security

Ledgercraft keeps a company's books as plain JSON files on the computer it runs on. The server listens on the loopback address only and refuses requests whose Host header is not the loopback address and port it was started with, requests with a foreign Origin header, and cross-site fetches. Top-level navigations are allowed so that a bookmark or a link from another page can open the app.

## The start link

Every workstation has a session token, stored as `session-token` (mode 0600) in its data home. The browser must present it once, through the link the server prints when it starts (`http://127.0.0.1:4173/?token=…`); the server then sets an HttpOnly, SameSite=Strict cookie that lasts 90 days. Requests under `/api/` without that cookie (or an `Authorization: Bearer` header carrying the token, used by the verification tools) are answered 401, and the page itself shows how to get in. `/api/health` and the static files stay open; they contain nothing private. The Mac app generates a fresh token for each launch and opens the link itself.

## What this does and does not protect

- The token stops other programs and other user accounts on the same computer from reading or changing the books through the loopback port unless they can read the token file or the browser's cookie store, which belong to the same user. It does not replace the operating system's user account or disk encryption. Keep the data directory inside the user's home folder with the default permissions, and use FileVault or an equivalent.
- Backups are unencrypted JSON and include the edit log. Treat them like the books themselves.
- The edit log (`audit.jsonl` in each company folder) is append-only and hash-chained. Ledgercraft never rewrites it; a restore that carries a broken chain is refused. Anyone with write access to the data folder can still delete the file, so keep backups elsewhere too.
- Reference resources (the GSTN HSN/SAC directory and the GSTR-1 workbook template) are downloaded only when you run `npm run setup`, are verified against pinned SHA-256 digests, and are never fetched at runtime.
- The Windows Tally bridge script talks to a Tally instance on the local network over the port Tally exposes. Run it only on a machine you trust, against a Tally you own.

## Reporting a problem

Open a private security advisory on the GitHub repository, or an issue if the problem is not sensitive. Include the version from `/api/health`, the steps to reproduce, and what you expected instead. Please do not include real company books in a report.
