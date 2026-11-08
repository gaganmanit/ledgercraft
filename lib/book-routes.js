import path from "node:path";
import { attachStatementFiles } from "./gst-statement-library.js";
import { cashBankBook, exportXml, groupSummary, outstanding, reportPeriod } from "./report-tools.js";
import { attachAuditLog, companyBackup, importCompany, importEntry } from "./transfer.js";
import { checkedAuditBackup } from "./audit-log.js";
import { importTallyArchive, tallyArchive } from "./tally-routes.js";

function download(res, contentType, filename, content) {
  res.writeHead(200, { "content-type": contentType, "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" });
  res.end(content);
}

// Statutory controls: edit log, period locks and numbering series.
//   GET /api/companies/<id>/audit?from=&to=&entity=&q=&offset=&limit=
//   GET|PUT /api/companies/<id>/locks
//   GET|PUT /api/companies/<id>/numbering
async function handleControlRoute({ req, res, url, parts, store, readBody, send }) {
  const id = decodeURIComponent(parts[2]);
  const section = parts[3];
  if (section === "audit" && req.method === "GET") {
    const query = Object.fromEntries(["from", "to", "entity", "q", "offset", "limit"].map((key) => [key, url.searchParams.get(key) || ""]));
    send(res, 200, await store.auditTrail(id, query));
    return true;
  }
  if (section === "locks") {
    if (req.method === "GET") { send(res, 200, await store.locks(id)); return true; }
    if (req.method === "PUT") { send(res, 200, await store.setLocks(id, await readBody(req))); return true; }
  }
  if (section === "numbering") {
    if (req.method === "GET") { send(res, 200, await store.numbering(id, url.searchParams.get("date") || "")); return true; }
    if (req.method === "PUT") { send(res, 200, await store.setNumbering(id, await readBody(req))); return true; }
  }
  return false;
}

export async function handleBookRoute({ req, res, url, parts, store, dataDir, readBody, send }) {
  if (url.pathname === "/api/import" && req.method === "POST") {
    const input = await readBody(req);
    if (input.format === "financer-tally-archive") {
      checkedAuditBackup(input.auditLog);
      const restored = await importTallyArchive(dataDir, store, input);
      if (restored.tallyImport && !restored.tallyImport.alreadyImported && restored.company) {
        const carried = input.auditLog?.lines?.length || 0;
        await store.adoptAuditLog(restored.company.id, input.auditLog, importEntry(restored.company, restored.vouchers || [], input, carried));
      }
      send(res, 201, restored);
      return true;
    }
    const linkedSources = [input.company?.source,
      ...(Array.isArray(input.company?.groups) ? input.company.groups.map((group) => group.source) : []),
      ...(Array.isArray(input.company?.ledgers) ? input.company.ledgers.map((ledger) => ledger.source) : []),
      ...(Array.isArray(input.vouchers) ? input.vouchers.map((voucher) => voucher.source) : []),
    ].filter((source) => source?.system === "tally");
    if (linkedSources.length) {
      if (input.accountingOnly !== true && linkedSources.some((source) => source.archive !== "accounting-only")) throw new Error("This backup needs its original Tally source archive. Choose a full Tally company backup.");
      for (const source of linkedSources) source.archive = "accounting-only";
    }
    send(res, 201, await importCompany(dataDir, input));
    return true;
  }
  if (parts[0] !== "api" || parts[1] !== "companies" || !parts[2]) return false;
  if (parts.length === 4 && await handleControlRoute({ req, res, url, parts, store, readBody, send })) return true;
  if (req.method !== "GET") return false;
  const action = parts[3];
  const reportName = parts[4];
  if (!["reports", "export", "backup"].includes(action)) return false;
  if (action === "reports" && !["group-summary", "cash-bank", "outstanding"].includes(reportName)) return false;
  const { company, vouchers } = await store.snapshot(decodeURIComponent(parts[2]));
  if (action === "backup") {
    const isTally = company.source?.system === "tally";
    const accountingOnly = isTally && company.source.archive === "accounting-only";
    let backup;
    if (isTally && !accountingOnly) {
      try { backup = await tallyArchive(dataDir, store, company.id, { company, vouchers }); }
      catch (error) { if (error.code === "ENOENT") throw new Error("The original Tally source archive is missing. Restore a full Tally backup before exporting this company."); throw error; }
    } else backup = await attachStatementFiles(path.join(dataDir,"companies",company.id),{ ...companyBackup(company, vouchers), ...(accountingOnly ? { accountingOnly: true } : {}) });
    backup = await attachAuditLog(path.join(dataDir, "companies", company.id), backup);
    download(res, "application/json; charset=utf-8", `${company.id}-ledgercraft.json`, JSON.stringify(backup));
    return true;
  }
  const { from, to } = reportPeriod(company, url.searchParams.get("from") || company.booksFrom, url.searchParams.get("to") || company.booksFrom);
  if (action === "export") {
    download(res, "application/xml; charset=utf-8", `${company.id}-${reportName}.xml`, exportXml(company, vouchers, reportName, from, to));
    return true;
  }
  if (reportName === "group-summary") send(res, 200, groupSummary(company, vouchers, from, to, url.searchParams.get("group") || ""));
  if (reportName === "cash-bank") send(res, 200, cashBankBook(company, vouchers, from, to));
  if (reportName === "outstanding") send(res, 200, outstanding(company, vouchers, from, to));
  return true;
}
