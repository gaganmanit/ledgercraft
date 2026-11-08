import { originalFiledSource } from "./lib/gst-statement-library.js";
import { handleAmendmentRoute } from "./lib/gst-amendment-routes.js";
import { handleItcRoute } from "./lib/gst-itc-routes.js";
import { signedQrSvg } from "./lib/signed-qr.js";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkstation } from "./lib/workstation.js";
import { ownerReview, findEntries } from "./lib/review.js";
import { isIsoDate } from "./lib/money.js";
import { handleReturnRoute } from "./lib/gst-return-routes.js";
import { handleStockRoute } from "./lib/stock-routes.js";
import { handleRcmRoute } from "./lib/gst-rcm-routes.js";
import { handleGstExchangeRoute } from "./lib/gst-exchange-routes.js";
import { handleReconciliationRoute } from "./lib/reconciliation-routes.js";
import { handleGstRoute } from "./lib/gst-store-routes.js";
import { handleTallyRoute } from "./lib/tally-routes.js";
import { searchHSN } from "./lib/hsn-directory.js";
import { handleBookRoute } from "./lib/book-routes.js";
import { createStore } from "./lib/store.js";
import { balanceSheet, dayBook, ledgerReport, profitAndLoss, trialBalance } from "./lib/engine.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".ps1": "application/octet-stream",
};
const browserModules = {
  "/voucher-entry.js": path.join(root, "lib", "voucher-entry.js"),
  "/money.js": path.join(root, "lib", "money.js"),
};
const immutable = /\.(woff2|ttf|png)$/;

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

let requestSerial = 0;

function fail(req, res, error) {
  const message = String(error?.message || error || "Unknown error");
  const companyMissing = /Unknown company|not on this machine/i.test(message) ||
    (error?.code === "ENOENT" && /[\\/]companies[\\/]/.test(String(error.path || "")));
  if (companyMissing) return send(res, 404, { error: "That company is not on this machine" });
  const id = `r${(++requestSerial).toString(36)}`;
  if (error?.code === "ENOENT") {
    const file = path.basename(String(error.path || ""));
    console.error(`[${id}] ${req.method} ${req.url} missing file: ${error.path}`);
    const resource = /hsn-sac\.json|GSTR1_Excel_Workbook_Template/.test(file);
    return send(res, 500, { error: resource
      ? `The reference file ${file} is not installed. Run "npm run setup" in the Ledgercraft folder, then reload. (${id})`
      : `A file Ledgercraft needs is missing: ${file || "unknown"}. (${id})`, requestId: id });
  }
  const internal = error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError || (error instanceof SyntaxError && !/JSON/i.test(message));
  if (internal) {
    console.error(`[${id}] ${req.method} ${req.url} internal error:`, error?.stack || error);
    return send(res, 500, { error: `Ledgercraft hit an internal error and did not save anything. Reference ${id}.`, requestId: id });
  }
  send(res, 400, { error: message });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  const route = req.url.split("?")[0];
  let limit = 1_000_000;
  if (route === "/api/tally/preview" || route === "/api/import") limit = 96 * 1024 * 1024;
  else if (route.endsWith("/gst-returns/statements") || route.endsWith("/gst/amendments/save")) limit = 44 * 1024 * 1024;
  else if (route.endsWith("/reconcile-2b")) limit = 32 * 1024 * 1024;
  else if (/\/reconciliation\/(csv-columns|bank-preview|import-statement)$/.test(route)) limit = 8 * 1024 * 1024;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("That request is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("The request was not valid JSON");
  }
}

const referenceResources = {
  hsnDirectory: path.join(root, "lib", "resources", "hsn-sac.json"),
  gstr1Template: path.join(root, "lib", "resources", "GSTR1_Excel_Workbook_Template_V2.2.xlsx"),
};

async function resourceStatus() {
  const status = {};
  for (const [name, file] of Object.entries(referenceResources)) {
    status[name] = await access(file).then(() => true, () => false);
  }
  return status;
}

const SESSION_COOKIE = "ledgercraft_session";

function cookieValue(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function sameToken(given, expected) {
  if (typeof given !== "string" || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A stable per-workstation secret so that only pages opened from the start link, or the Mac app, can use the API. */
export async function workstationToken(home, provided) {
  if (provided) return provided;
  const file = path.join(home, "session-token");
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (/^[a-f0-9]{48}$/.test(existing)) return existing;
  } catch { /* first start */ }
  const token = randomBytes(24).toString("hex");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(file, token + "\n", { mode: 0o600 });
  return token;
}

function lockedPage(port) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ledgercraft</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#e6e8e6;color:#1c1f22;font:15px/1.5 system-ui,sans-serif}main{max-width:34rem;background:#fcfcfa;border:1px solid #d5dee9;border-left:3px solid #a51d2d;padding:28px 32px;border-radius:2px}h1{font-size:22px;margin:0 0 8px}p{margin:8px 0}code{font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#f4f5f2;padding:2px 6px;border-radius:3px}</style></head>
<body><main><h1>Open Ledgercraft from its start link</h1><p>This copy of Ledgercraft only answers pages opened from the link it printed when it started, so that other programs on this computer cannot read the books.</p><p>Look in the terminal where you ran <code>npm start</code> for a line like <code>http://127.0.0.1:${port}/?token=…</code> and open that link once. Your browser remembers it afterwards.</p><p>The Mac app does this for you.</p></main></body></html>`;
}

function staticPath(urlPath) {
  if (urlPath === "/") return path.join(publicDir, "index.html");
  if (Object.hasOwn(browserModules, urlPath)) return browserModules[urlPath];
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes("\0") || decoded.split("/").some(part => part === ".." || part.startsWith("."))) return null;
  const file = path.resolve(publicDir, "." + path.posix.normalize(decoded));
  if (!file.startsWith(publicDir + path.sep)) return null;
  if (!Object.hasOwn(MIME, path.extname(file))) return null;
  return file;
}

async function serveStatic(req, res, urlPath) {
  const file = staticPath(urlPath);
  if (!file) return false;
  let info;
  try { info = await stat(file); } catch { return false; }
  if (!info.isFile()) return false;
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    "content-type": MIME[path.extname(file)] || MIME[".html"],
    "cache-control": immutable.test(file) ? "public, max-age=31536000, immutable" : "no-cache",
    "etag": etag,
    "last-modified": info.mtime.toUTCString(),
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  headers["content-length"] = info.size;
  res.writeHead(200, headers);
  if (req.method === "HEAD") { res.end(); return true; }
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
  return true;
}

function reportRange(company, url) {
  const from = url.searchParams.get("from") || company.booksFrom;
  const to = url.searchParams.get("to") || company.booksFrom;
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) throw new Error("Choose a valid report period");
  return { from, to };
}

export async function start({ port = 0, dataDir, home, seedFolder, fallbackPorts = 0, token = null } = {}) {
  const defaultDir = dataDir || (home ? path.join(home, "data") : path.join(root, "data"));
  const station = await openWorkstation(home || defaultDir, defaultDir, seedFolder);
  dataDir = station.get().dataDirectory;
  const store = createStore(dataDir);

  const server = http.createServer(async (req, res) => {
    try {
      const port = req.socket.localPort;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      const origin = req.headers.origin;
      const navigation = req.method === "GET" && req.headers["sec-fetch-mode"] === "navigate";
      if (!allowedHosts.includes(req.headers.host) || (origin && origin !== "http://" + req.headers.host) ||
          (["cross-site", "same-site"].includes(req.headers["sec-fetch-site"]) && !navigation)) {
        send(res, 403, { error: "Open Ledgercraft on this Mac" });
        return;
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      const url = new URL(req.url, "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      if (token) {
        const bearer = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || "")?.[1];
        const authorised = sameToken(cookieValue(req, SESSION_COOKIE), token) || sameToken(bearer, token);
        if (url.pathname === "/" && url.searchParams.has("token")) {
          if (!sameToken(url.searchParams.get("token"), token)) {
            res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            res.end(lockedPage(port));
            return;
          }
          // Serve the app directly rather than redirecting: a cookie set on a redirect is not always
          // replayed on the follow-up request when the navigation started from another app or site.
          res.setHeader("set-cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 90}`);
          res.setHeader("cache-control", "no-store");
          const html = await readFile(path.join(publicDir, "index.html"));
          res.writeHead(200, { "content-type": MIME[".html"], "content-length": html.length });
          res.end(html);
          return;
        }
        if (!authorised) {
          if (url.pathname === "/" || url.pathname === "/index.html") {
            res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            res.end(lockedPage(port));
            return;
          }
          if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health") {
            return send(res, 401, { error: "Open Ledgercraft from the start link shown when it started." });
          }
        }
      }
      if ((req.method === "GET" || req.method === "HEAD") && await serveStatic(req, res, url.pathname)) return;

      if (req.method === "GET" && url.pathname === "/api/health") {
        return send(res, 200, { app: "financer", name: "Ledgercraft", version, instance: process.env.FINANCER_INSTANCE || null, resources: await resourceStatus() });
      }
      if (url.pathname === "/api/workstation") {
        if (req.method === "GET") return send(res, 200, station.get());
        if (req.method === "PUT") {
          const input = await readBody(req);
          const changes = {};
          for (const field of ["defaultCompany", "lastCompany"]) {
            if (!(field in input)) continue;
            if (input[field] !== null && !(await store.list()).some(c => c.id === input[field])) throw new Error("Unknown company");
            changes[field] = input[field];
          }
          if ("loadLastCompany" in input) {
            if (typeof input.loadLastCompany !== "boolean") throw new Error("Invalid startup preference");
            changes.loadLastCompany = input.loadLastCompany;
          }
          return send(res, 200, await station.update(changes));
        }
      }
      if (req.method === "GET" && url.pathname === "/api/hsn") {
        return send(res, 200, await searchHSN(url.searchParams.get("q"),{kind:url.searchParams.get("kind") || "",selectable:url.searchParams.get("selectable")==="1",offset:Number(url.searchParams.get("offset") || 0),limit:Number(url.searchParams.get("limit") || 30)}));
      }
      if (req.method === "GET" && parts.length === 6 && parts[0] === "api" && parts[1] === "companies" && parts[3] === "gst-exchange" && parts[5] === "qr.svg") {
        const state = await store.getGstExchange(decodeURIComponent(parts[2]), decodeURIComponent(parts[4]));
        if (!state.display?.signedQRCode) return send(res, 404, { error: "No bound signed QR is available" });
        const svg = signedQrSvg(state.display.signedQRCode);
        res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
        res.end(svg);
        return;
      }
      if (req.method === "POST" && parts.length === 7 && parts[0] === "api" && parts[1] === "companies" && parts[3] === "gst" && parts[4] === "amendments" && parts[5] === "events" && ["withdraw","record-filing"].includes(parts[6])) {
        const result = await store.saveGstAmendmentEvent(decodeURIComponent(parts[2]),parts[6],await readBody(req));
        return send(res,201,result);
      }
      if (req.method === "GET" && parts.length === 5 && parts[0] === "api" && parts[1] === "companies" && parts[3] === "gst-filed-source") {
        const { company } = await store.snapshot(decodeURIComponent(parts[2]));
        const { name, raw } = await originalFiledSource(path.join(dataDir,"companies",company.id),company,parts[4]);
        res.writeHead(200, { "content-type":"application/json", "cache-control":"no-store", "content-disposition":"attachment; filename*=UTF-8''" + encodeURIComponent(name).replace(/'/g,"%27") });
        res.end(raw);
        return;
      }
      const context = { req, res, url, parts, store, dataDir, readBody, send };
      if (await handleAmendmentRoute(context) || await handleReconciliationRoute(context) || await handleGstExchangeRoute(context) || await handleStockRoute(context) || await handleRcmRoute(context) || await handleItcRoute(context) || await handleGstRoute(context) || await handleTallyRoute(context) || await handleReturnRoute(context)) return;
      if (await handleBookRoute(context)) return;
      if (req.method === "GET" && url.pathname === "/api/companies") {
        send(res, 200, { companies: await store.list() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/companies") {
        send(res, 201, await store.create(await readBody(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/specimen") {
        send(res, 201, await store.specimen());
        return;
      }

      if (parts[0] === "api" && parts[1] === "companies" && parts[2]) {
        const id = decodeURIComponent(parts[2]);
        if (req.method === "GET" && parts.length === 4) {
          const section = parts[3];
          if (section === "meta") {
            const { company } = await store.snapshot(id);
            return send(res, 200, { company: { id: company.id, name: company.name, booksFrom: company.booksFrom } });
          }
          if (section === "owner-review" || section === "find" || section === "masters") {
            const { company, vouchers, nextNumbers } = await store.snapshot(id);
            if (section === "masters") {
              const usedLedgerIds = new Set();
              for (const v of vouchers) for (const line of v.lines) usedLedgerIds.add(line.ledgerId);
              return send(res, 200, { company, nextNumbers, usedLedgerIds: [...usedLedgerIds] });
            }
            if (section === "find") return send(res, 200, { matches: findEntries(company, vouchers, url.searchParams.get("q") || "") });
            const { from, to } = reportRange(company, url);
            return send(res, 200, ownerReview(company, vouchers, from, to));
          }
        }
        if (parts.length === 3 && req.method === "GET") {
          send(res, 200, await store.snapshot(id));
          return;
        }
        if (["groups", "ledgers"].includes(parts[3]) && parts[4] && parts.length === 5) {
          const masterId = decodeURIComponent(parts[4]);
          if (req.method === "PUT") {
            const method = parts[3] === "groups" ? "updateGroup" : "updateLedger";
            send(res, 200, await store[method](id, masterId, await readBody(req)));
            return;
          }
          if (req.method === "DELETE") {
            const method = parts[3] === "groups" ? "removeGroup" : "removeLedger";
            send(res, 200, await store[method](id, masterId));
            return;
          }
        }
        if (parts[3] === "groups" && req.method === "POST") {
          send(res, 201, await store.addGroup(id, await readBody(req)));
          return;
        }
        if (parts[3] === "ledgers" && req.method === "POST") {
          send(res, 201, await store.addLedger(id, await readBody(req)));
          return;
        }
        if (parts[3] === "vouchers" && req.method === "POST" && parts.length === 4) {
          send(res, 201, await store.passVoucher(id, await readBody(req)));
          return;
        }
        if (parts[3] === "vouchers" && parts.length === 5 && req.method === "GET") {
          const { company, vouchers, nextNumbers } = await store.snapshot(id);
          const voucher = vouchers.find(v => v.id === decodeURIComponent(parts[4]));
          if (!voucher) throw new Error("That voucher is not in this company");
          return send(res, 200, { company, voucher, nextNumbers });
        }
        if (parts[3] === "vouchers" && parts[4] && req.method === "PUT") {
          send(res, 200, await store.passVoucher(id, await readBody(req), decodeURIComponent(parts[4])));
          return;
        }
        if (parts[3] === "vouchers" && parts[4] && req.method === "DELETE") {
          send(res, 200, await store.removeVoucher(id, decodeURIComponent(parts[4])));
          return;
        }
        if (parts[3] === "reports" && req.method === "GET") {
          const { company, vouchers } = await store.snapshot(id);
          const { from, to } = reportRange(company, url);
          if (parts[4] === "trial-balance") {
            send(res, 200, trialBalance(company, vouchers, from, to));
            return;
          }
          if (parts[4] === "profit-loss") {
            send(res, 200, profitAndLoss(company, vouchers, from, to));
            return;
          }
          if (parts[4] === "balance-sheet") {
            send(res, 200, balanceSheet(company, vouchers, to));
            return;
          }
          if (parts[4] === "daybook") {
            send(res, 200, { from, to, rows: dayBook(company, vouchers, from, to) });
            return;
          }
          if (parts[4] === "ledger" && parts[5]) {
            send(res, 200, ledgerReport(company, vouchers, decodeURIComponent(parts[5]), from, to));
            return;
          }
        }
      }

      send(res, 404, { error: "Not found" });
    } catch (error) {
      fail(req, res, error);
    }
  });

  const listen = (candidate) => new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener("listening", onListening); reject(error); };
    const onListening = () => { server.removeListener("error", onError); resolve(server); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(candidate, "127.0.0.1");
  });
  if (!fallbackPorts) return listen(port);
  let last;
  for (let attempt = 0; attempt <= fallbackPorts; attempt += 1) {
    try { return await listen(port + attempt); }
    catch (error) {
      if (error.code !== "EADDRINUSE" || attempt === fallbackPorts) throw error;
      last = error;
    }
  }
  throw last;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const desktop = process.env.FINANCER_DESKTOP === "1";
  const port = Number(process.env.PORT || 4173);
  // The Mac wrapper sets FINANCER_HOME and must win over a LEDGERCRAFT_HOME inherited from the shell.
  const home = (desktop && process.env.FINANCER_HOME) || process.env.LEDGERCRAFT_HOME || process.env.FINANCER_HOME || path.join(root, ".ledgercraft");
  const seedFolder = path.join(root, "data", "companies", "specimen-8fe3bf");
  const token = await workstationToken(home, process.env.LEDGERCRAFT_TOKEN);
  let server;
  try {
    server = await start({ port, home, seedFolder, token, fallbackPorts: process.env.PORT || desktop ? 0 : 20 });
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Close the other program, or start Ledgercraft with PORT=<number> npm start.`);
      process.exit(1);
    }
    throw error;
  }
  const shutdown = () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 3000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  const parent = Number(process.env.FINANCER_PARENT_PID);
  if (process.env.FINANCER_DESKTOP === "1" && Number.isInteger(parent) && parent > 1) {
    setInterval(() => {
      try { process.kill(parent, 0); }
      catch (error) { if (error.code === "ESRCH") shutdown(); }
    }, 1000).unref();
  }
  const address = server.address();
  if (address.port !== port) console.warn(`Port ${port} was busy; using ${address.port} instead.`);
  console.log(desktop
    ? `Ledgercraft ${version} is open at http://127.0.0.1:${address.port} (books in ${home})`
    : `Ledgercraft ${version} is open. Books are in ${home}.\nOpen this link once in your browser: http://127.0.0.1:${address.port}/?token=${token}`);
  await access(publicDir);
  const resources = await resourceStatus();
  const missing = Object.entries(resources).filter(([, present]) => !present).map(([name]) => name);
  if (missing.length) console.warn(`Reference resources not installed (${missing.join(", ")}). GST returns and HSN search need them: run "npm run setup".`);
}
