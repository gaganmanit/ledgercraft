import { originalFiledSource } from "./lib/gst-statement-library.js";
import { handleAmendmentRoute } from "./lib/gst-amendment-routes.js";
import { handleItcRoute } from "./lib/gst-itc-routes.js";
import { signedQrSvg } from "./lib/signed-qr.js";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
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

const staticFiles = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/tally-bridge.ps1": ["tally-bridge.ps1", "application/octet-stream"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
  "/voucher-entry.js": [path.join(root, "lib", "voucher-entry.js"), "text/javascript; charset=utf-8"],
  "/money.js": [path.join(root, "lib", "money.js"), "text/javascript; charset=utf-8"],
};

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function fail(res, error) {
  const missing = /Unknown company|ENOENT/i.test(error.message);
  send(res, missing ? 404 : 400, { error: missing ? "That company is not on this machine" : error.message });
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

function serveStatic(res, urlPath) {
  let spec = Object.hasOwn(staticFiles, urlPath) ? staticFiles[urlPath] : null;
  if (["/book-tools.js", "/finder.js", "/gst-ui.js", "/gst-exchange.js", "/reconciliation-ui.js", "/gst-returns-ui.js", "/gst-2b-ui.js", "/gst-rcm-ui.js", "/stock-ui.js", "/gst-itc-ui.js", "/gst-amendment-ui.js", "/gst-amendment-disposition.js", "/gst-filed-source-ui.js", "/gst-filed-source-worker.js", "/gst-filed-source.js", "/tally-tools.js", "/tally-gst-ui.js", "/tally-invoice-references.js"].includes(urlPath)) spec = [urlPath.slice(1), "text/javascript; charset=utf-8"];
  if (["/desk.css", "/book-tools.css", "/gst-ui.css", "/gst-exchange.css", "/gst-rcm-ui.css", "/stock-ui.css", "/gst-itc-ui.css", "/gst-amendment-ui.css", "/reconciliation-ui.css", "/tally-tools.css", "/tally-gst-ui.css"].includes(urlPath)) spec = [urlPath.slice(1), "text/css; charset=utf-8"];
  if (/^\/fonts\/(Newsreader(?:-Italic)?|SourceSans3|IBMPlexMono-Regular)\.ttf$/.test(urlPath)) {
    spec = [path.join(publicDir, urlPath.slice(1)), "font/ttf"];
  }
  if (!spec) return false;
  const filePath = spec[0].includes(`${path.sep}`) || path.isAbsolute(spec[0]) ? spec[0] : path.join(publicDir, spec[0]);
  res.writeHead(200, {
    "content-type": spec[1],
    "cache-control": "no-cache",
  });
  createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
  return true;
}

function reportRange(company, url) {
  const from = url.searchParams.get("from") || company.booksFrom;
  const to = url.searchParams.get("to") || company.booksFrom;
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) throw new Error("Choose a valid report period");
  return { from, to };
}

export async function start({ port = 0, dataDir, home, seedFolder } = {}) {
  const defaultDir = dataDir || (home ? path.join(home, "data") : path.join(root, "data"));
  const station = await openWorkstation(home || defaultDir, defaultDir, seedFolder);
  dataDir = station.get().dataDirectory;
  const store = createStore(dataDir);

  const server = http.createServer(async (req, res) => {
    try {
      const port = req.socket.localPort;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      const origin = req.headers.origin;
      if (!allowedHosts.includes(req.headers.host) || (origin && origin !== "http://" + req.headers.host) ||
          req.headers["sec-fetch-site"] === "cross-site") {
        send(res, 403, { error: "Open Ledgercraft on this Mac" });
        return;
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
      const url = new URL(req.url, "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      if (req.method === "GET" && serveStatic(res, url.pathname)) return;

      if (req.method === "GET" && url.pathname === "/api/health") {
        return send(res, 200, { app: "financer", instance: process.env.FINANCER_INSTANCE || null });
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
      fail(res, error);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const port = Number(process.env.PORT || 4173);
  const home = process.env.LEDGERCRAFT_HOME || process.env.FINANCER_HOME || path.join(root, ".ledgercraft");
  const seedFolder = path.join(root, "data", "companies", "specimen-8fe3bf");
  const server = await start({ port, home, seedFolder });
  const shutdown = () => { server.close(() => process.exit(0)); server.closeIdleConnections(); };
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
  console.log(`Ledgercraft is open at http://127.0.0.1:${address.port}`);
  await access(publicDir);
}
