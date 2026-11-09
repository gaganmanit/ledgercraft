import path from "node:path";
import { attachStatementFiles } from "./gst-statement-library.js";
import { cashBankBook, exportXml, groupSummary, outstanding, reportPeriod } from "./report-tools.js";
import { attachAuditLog, companyBackup, importCompany, importEntry } from "./transfer.js";
import { checkedAuditBackup } from "./audit-log.js";
import { importTallyArchive, tallyArchive } from "./tally-routes.js";
import { dayBookPage, ledgerReportPage, pageQuery, pageRows } from "./engine.js";
import { isIsoDate } from "./money.js";

function download(res, contentType, filename, content) {
  res.writeHead(200, { "content-type": contentType, "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" });
  res.end(content);
}

// Same period rule as the server's other reports: from and to default to the day the books begin.
function reportRange(company, url) {
  const from = url.searchParams.get("from") || company.booksFrom;
  const to = url.searchParams.get("to") || company.booksFrom;
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) throw new Error("Choose a valid report period");
  return { from, to };
}

/**
 * The GST invoice register as the Invoice register screen shows it: documents in the
 * period, newest first, filtered by document type and by words in the number, party,
 * GSTIN or narration. totals cover every matching document, not only the page; they are
 * plain sums of the figures shown (credit notes are not netted against invoices).
 */
export function gstRegister(company, vouchers, { from = "", to = "", type = "", q = "", page = null } = {}) {
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to)) || (from && to && from > to)) throw new Error("Choose a valid register period");
  const needle = String(q).toLowerCase().trim();
  const matched = vouchers.filter((voucher) => voucher.gst).map((voucher) => voucher.gst)
    .filter((invoice) => (!from || invoice.date >= from) && (!to || invoice.date <= to) && (!type || invoice.type === type))
    .filter((invoice) => !needle || [invoice.number, invoice.party?.name, invoice.party?.gstin, invoice.narration].join(" ").toLowerCase().includes(needle))
    .sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
  const rows = matched.map((invoice) => ({
    id: invoice.id, voucherId: invoice.voucherId, date: invoice.date, number: invoice.number, type: invoice.type,
    direction: invoice.direction, registrationId: invoice.registrationId, reverseCharge: Boolean(invoice.reverseCharge),
    party: { id: invoice.party?.id ?? null, name: invoice.party?.name ?? "", gstin: invoice.party?.gstin ?? "" },
    taxablePaise: invoice.totals?.taxablePaise ?? 0, taxPaise: invoice.totals?.taxPaise ?? 0, totalPaise: invoice.totals?.totalPaise ?? 0,
    amountDuePaise: invoice.partyDuePaise ?? invoice.totals?.totalPaise ?? 0,
  }));
  const totals = { taxablePaise: 0, taxPaise: 0, amountDuePaise: 0 };
  for (const row of rows) for (const key of Object.keys(totals)) totals[key] += row[key];
  return { company: { id: company.id, name: company.name, booksFrom: company.booksFrom }, from: from || null, to: to || null, ...pageRows(rows, page), totals };
}

// A slim write answers with the changed record instead of the whole book:
// {company:{id,name,booksFrom}, voucher|ledger|group, nextNumbers, revision, removed?, replayed?}.
function wantsSlim(url, body) {
  return url.searchParams.get("slim") === "1" || body?.slim === true;
}

function slimBook(result, kind) {
  const { company, nextNumbers, revision } = result;
  return { company: { id: company.id, name: company.name, booksFrom: company.booksFrom }, [kind]: result[kind] ?? null, nextNumbers, revision,
    ...(result.removed ? { removed: true } : {}), ...(result.replayed ? { replayed: true } : {}) };
}

async function readInput(req, readBody) {
  const body = await readBody(req);
  const { slim, ...input } = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  return { body, input };
}

// Groups, ledgers and vouchers: the same writes the server always had, with slim answers
// and the signed-in user as the actor of the edit-log entries.
//   POST /api/companies/<id>/groups | ledgers | vouchers          -> 201
//   PUT|DELETE /api/companies/<id>/groups/<gid> | ledgers/<lid> | vouchers/<vid> -> 200
async function handleMasterWrite({ req, res, url, parts, store, readBody, send, actor }) {
  if (!["POST", "PUT", "DELETE"].includes(req.method) || !["groups", "ledgers", "vouchers"].includes(parts[3])) return false;
  const id = decodeURIComponent(parts[2]);
  const books = actor ? store.as(actor) : store;
  const kind = { groups: "group", ledgers: "ledger", vouchers: "voucher" }[parts[3]];
  const reply = (status, result, body) => { send(res, status, wantsSlim(url, body) ? slimBook(result, kind) : result); return true; };
  if (req.method === "POST" && parts.length === 4) {
    const { body, input } = await readInput(req, readBody);
    const method = { groups: "addGroup", ledgers: "addLedger", vouchers: "passVoucher" }[parts[3]];
    return reply(201, await books[method](id, input), body);
  }
  if (parts.length !== 5) return false;
  const recordId = decodeURIComponent(parts[4]);
  const { body, input } = await readInput(req, readBody);
  if (req.method === "PUT") {
    if (kind === "voucher") return reply(200, await books.passVoucher(id, input, recordId), body);
    return reply(200, await books[kind === "group" ? "updateGroup" : "updateLedger"](id, recordId, input), body);
  }
  const method = { group: "removeGroup", ledger: "removeLedger", voucher: "removeVoucher" }[kind];
  return reply(200, await books[method](id, recordId, input.expected), body);
}

// Long registers with optional paging: ?offset=&limit= (limit at most 500; without either
// the whole list comes back as before). Answers carry {rows, total, offset, limit}.
//   GET /api/companies/<id>/reports/daybook?from=&to=      -> {from, to, rows, total, offset, limit, totalPaise}
//   GET /api/companies/<id>/reports/ledger/<lid>?from=&to= -> ledger report + {rows, total, offset, limit, totals, pageOpening?}
//   GET /api/companies/<id>/gst-register?from=&to=&type=&q= -> {company, from, to, rows, total, offset, limit, totals}
async function handlePagedReport({ req, res, url, parts, store, send }) {
  if (req.method !== "GET") return false;
  const daybook = parts.length === 5 && parts[3] === "reports" && parts[4] === "daybook";
  const ledger = parts.length === 6 && parts[3] === "reports" && parts[4] === "ledger" && parts[5];
  const register = parts.length === 4 && parts[3] === "gst-register";
  if (!daybook && !ledger && !register) return false;
  const { company, vouchers } = await store.snapshot(decodeURIComponent(parts[2]));
  const page = pageQuery(url.searchParams);
  if (register) {
    const query = Object.fromEntries(["from", "to", "type", "q"].map((key) => [key, url.searchParams.get(key) || ""]));
    send(res, 200, gstRegister(company, vouchers, { ...query, page }));
    return true;
  }
  const { from, to } = reportRange(company, url);
  if (daybook) send(res, 200, dayBookPage(company, vouchers, from, to, page));
  else send(res, 200, ledgerReportPage(company, vouchers, decodeURIComponent(parts[5]), from, to, page));
  return true;
}

// Statutory controls: edit log, period locks and numbering series.
//   GET /api/companies/<id>/audit?from=&to=&entity=&q=&user=&offset=&limit=
//       entries carry user: {id, name} (null for token-only use or older entries)
//   GET|PUT /api/companies/<id>/locks
//   GET|PUT /api/companies/<id>/numbering
async function handleControlRoute({ req, res, url, parts, store, readBody, send, actor }) {
  const id = decodeURIComponent(parts[2]);
  const section = parts[3];
  const books = actor ? store.as(actor) : store;
  if (section === "audit" && req.method === "GET") {
    const query = Object.fromEntries(["from", "to", "entity", "q", "user", "offset", "limit"].map((key) => [key, url.searchParams.get(key) || ""]));
    send(res, 200, await store.auditTrail(id, query));
    return true;
  }
  if (section === "locks") {
    if (req.method === "GET") { send(res, 200, await store.locks(id)); return true; }
    if (req.method === "PUT") { send(res, 200, await books.setLocks(id, await readBody(req))); return true; }
  }
  if (section === "numbering") {
    if (req.method === "GET") { send(res, 200, await store.numbering(id, url.searchParams.get("date") || "")); return true; }
    if (req.method === "PUT") { send(res, 200, await books.setNumbering(id, await readBody(req))); return true; }
  }
  return false;
}

export async function handleBookRoute({ req, res, url, parts, store, dataDir, readBody, send, actor = null }) {
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
  if (parts.length === 4 && await handleControlRoute({ req, res, url, parts, store, readBody, send, actor })) return true;
  if (await handleMasterWrite({ req, res, url, parts, store, readBody, send, actor })) return true;
  if (await handlePagedReport({ req, res, url, parts, store, send })) return true;
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
