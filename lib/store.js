import { applyCreditReview, assertCreditReviews } from "./gst-credit-review.js";
import { saveTallyGstMapping, activateTallyGstPromotion, assertTallyGstBook } from "./tally-gst.js";
import { buildAmendmentEvent, buildOutwardAmendment } from "./gst-outward-amendments.js";
import { ensureItcAccounts, buildItcAction, assertItcBook, itcAccountIds } from "./gst-itc.js";
import { commitBook, keepBackup, recoverBook, replaceJson, syncDirectory } from "./book-transaction.js";
import { recordStatement, verifyItcStatement, saveFiledSource } from "./gst-statement-library.js";
import { tallyStockPostingHash } from "./tally-stock.js";
import { assertStockBook } from "./stock-engine.js";
import { invoiceStockMetadata, stockLocations } from "./stock-entry.js";
import { saveIrpPolicy } from "./gst-irp-policy.js";
import { saveTurnover } from "./gst-turnover.js";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isIsoDate, todayISO } from "./money.js";
import { emptyCashLedger, reservedGroups } from "./groups.js";
import { nextNumbers, numberingView, checkedSeries, crossYearDuplicate, numberingConfig } from "./numbering.js";
import { appendAudit, assertPeriodOpen, auditExists, balanceText, checkedLockRequest, dmy, groupSnapshot, ledgerSnapshot, lockEntry, lockGuard, locksOf, checkedAuditBackup, queryAuditLog, rupees, sha256, voucherEntry, writeAuditLines, voucherSnapshot } from "./audit-log.js";
import { assertVoucher } from "./engine.js";
import { buildSpecimen } from "./specimen.js";
import { assertBookAmounts } from "./transfer.js";
import { assertRcmBook, buildRcmAction, ensureRcmAccounts, rcmAccountIds } from "./gst-rcm.js";
import { assertReconciliation, guardReconciledLedger, guardReconciledVoucher } from "./reconciliation.js";
import { acknowledgementRecord, exchangeView, invoiceFingerprint, normalizePreparation } from "./gst-exchange.js";
import { assertGstSnapshot, buildGstInvoice, gstAccountIds, gstRequestHash, gstState, gstVoucher, saveItem, saveParty, saveRegistration } from "./gst.js";

const ID_RE = /^[a-z0-9-]{1,48}$/;
const pendingWrites = new Map();
const MEBIBYTE = 1024 * 1024;
// Largest serialised size of each mutable company section. Reconciliation history
// grows with every match and import, so it shares the stock register's ceiling.
const SECTION_LIMITS = { reconciliation: 32 * MEBIBYTE, stock: 32 * MEBIBYTE };
const byteCount = new Intl.NumberFormat("en-IN");

function registrationLabel(company, registrationId) {
  const registration = company.gst?.registrations?.find((entry) => entry.id === registrationId);
  return registration?.gstin || registrationId || "";
}

// GST masters are small records; keep them whole but drop nested history arrays.
function compactMaster(saved) {
  if (!saved || typeof saved !== "object") return saved ?? null;
  const text = JSON.stringify(saved);
  return text.length <= 16_384 ? structuredClone(saved) : { id: saved.id, name: saved.name, gstin: saved.gstin, sha256: sha256(saved) };
}

function journalSnapshot(journal) {
  return { date: journal.date, number: journal.number, kind: journal.kind ?? journal.type, lines: (journal.lines || []).length, sha256: sha256(journal) };
}

// One entry per stock journal created, altered or deleted; settings changes as one entry.
function stockEntries(before, after) {
  const prior = new Map((before?.journals || []).map((journal) => [journal.id, journal]));
  const next = new Map((after?.journals || []).map((journal) => [journal.id, journal]));
  const entries = [];
  for (const [id, journal] of next) {
    const old = prior.get(id);
    if (!old) entries.push({ action: "create", entity: "stock-journal", id, number: journal.number, summary: `Stock journal ${journal.number || id} dated ${dmy(journal.date)} recorded.`, after: journalSnapshot(journal) });
    else if (!isDeepStrictEqual(old, journal)) entries.push({ action: "alter", entity: "stock-journal", id, number: journal.number, summary: `Stock journal ${journal.number || id} dated ${dmy(journal.date)} altered.`, before: journalSnapshot(old), after: journalSnapshot(journal) });
  }
  for (const [id, journal] of prior) if (!next.has(id)) entries.push({ action: "delete", entity: "stock-journal", id, number: journal.number, summary: `Stock journal ${journal.number || id} dated ${dmy(journal.date)} deleted.`, before: journalSnapshot(journal) });
  // The revision counter moves with every change; only real settings changes are logged here.
  const { journals: a, revision: ra, operationReceipts: oa, ...restBefore } = before || {};
  const { journals: b, revision: rb, operationReceipts: ob, ...restAfter } = after || {};
  if (!isDeepStrictEqual(restBefore, restAfter)) {
    entries.push({ action: before ? "alter" : "create", entity: "stock-journal", id: "stock-settings", summary: "Stock register settings changed (godowns, items, valuation or source links).", before: before ? { sha256: sha256(restBefore), revision: before.revision ?? null } : null, after: { sha256: sha256(restAfter), revision: after.revision ?? null } });
  }
  const receipts = after?.operationReceipts || [];
  const requestId = receipts.length > (before?.operationReceipts || []).length ? receipts.at(-1)?.requestId : undefined;
  return entries.map((entry) => ({ ...entry, ...(requestId ? { requestId } : {}), revision: after?.revision }));
}

function reconciliationEntries(before, after) {
  const seen = new Set((before?.audit || []).map((row) => row.id));
  const rows = (after?.audit || []).filter((row) => !seen.has(row.id));
  if (!rows.length) {
    return isDeepStrictEqual(before, after) ? [] : [{ action: "alter", entity: "reconciliation", id: "reconciliation", summary: "Reconciliation records changed.", after: { revision: after?.revision ?? null }, revision: after?.revision }];
  }
  return rows.map((row) => ({ action: /^(unmatch|remove|unallocate)/.test(row.action) ? "delete" : "create", entity: "reconciliation", id: row.id, summary: `Reconciliation ${String(row.action || "change").replace(/-/g, " ")} recorded.`, after: { action: row.action, at: row.at }, requestId: row.requestId, revision: after.revision }));
}

export function createStore(dataDir) {
  const root = path.join(dataDir, "companies");

  async function ensure() {
    await mkdir(root, { recursive: true });
  }

  function dir(id) {
    if (!ID_RE.test(id)) throw new Error("Unknown company");
    return path.join(root, id);
  }

  function serial(id, operation) {
    const key = path.resolve(root, id);
    const prior = pendingWrites.get(key) || Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    pendingWrites.set(key, next);
    next.finally(() => {
      if (pendingWrites.get(key) === next) pendingWrites.delete(key);
    }).catch(() => {});
    return next;
  }

  // Primary files that failed to parse on the last load and were opened from `.bak`.
  // Their next save must not rotate the damaged primary over the good backup.
  const damaged = new Set();

  // Durable save: the previous version becomes the rolling `.bak`, the new content is
  // fsynced before it replaces the primary, and the directory is fsynced after.
  async function writeJson(file, value) {
    if (!damaged.has(file)) await keepBackup(file);
    await replaceJson(file, value);
    await syncDirectory(path.dirname(file));
    damaged.delete(file);
  }

  async function commit(id, company, vouchers) {
    const folder = dir(id);
    const files = ["company.json", "vouchers.json"];
    await commitBook(folder, company, vouchers, { backup: files.filter((name) => !damaged.has(path.join(folder, name))) });
    for (const name of files) damaged.delete(path.join(folder, name));
  }

  // Read a primary file, falling back to its `.bak` when the primary cannot be parsed
  // (for example a save cut short by a power loss). The original error surfaces when
  // the backup is missing or unreadable too.
  async function readBookFile(file) {
    let text;
    try {
      text = await readFile(file, "utf8");
      const value = JSON.parse(text);
      damaged.delete(file);
      return { value };
    } catch (error) {
      if (text === undefined) throw error;
      let value;
      try { value = JSON.parse(await readFile(`${file}.bak`, "utf8")); }
      catch { throw error; }
      damaged.add(file);
      const name = path.basename(file);
      return { value, warning: `${name} could not be read, so Ledgercraft opened the previous saved copy (${name}.bak). Check the most recent entries; the next save writes a fresh ${name}.` };
    }
  }

  async function load(id) {
    const folder = dir(id);
    await recoverBook(folder);
    const company = await readBookFile(path.join(folder, "company.json"));
    const vouchers = await readBookFile(path.join(folder, "vouchers.json"));
    const warnings = [company.warning, vouchers.warning].filter(Boolean);
    return { company: company.value, vouchers: vouchers.value, ...(warnings.length ? { warning: warnings.join(" ") } : {}) };
  }

  function bundle(company, vouchers) {
    return { company, vouchers, nextNumbers: nextNumbers(company, vouchers, todayISO()) };
  }

  // Statutory edit log: appended inside the serialised write, after the data write.
  async function log(id, entries) {
    await appendAudit(dir(id), Array.isArray(entries) ? entries : [entries]);
  }

  async function list() {
    await ensure();
    const names = await readdir(root, { withFileTypes: true });
    const companies = [];
    for (const entry of names) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      try {
        const { value: company } = await readBookFile(path.join(root, entry.name, "company.json"));
        companies.push({
          id: company.id,
          name: company.name,
          booksFrom: company.booksFrom,
        });
      } catch {
        // A half-written folder is skipped until the next save.
      }
    }
    companies.sort((a, b) => a.name.localeCompare(b.name));
    return companies;
  }

  function cleanName(name) {
    const value = String(name ?? "").trim().replace(/\s+/g, " ");
    if (value.length < 2 || value.length > 80) throw new Error("Use a name between 2 and 80 characters");
    return value;
  }

  function assertCurrent(current, expected, fields) {
    if (expected === undefined) return;
    if (!expected || typeof expected !== "object" || !fields.every((field) => isDeepStrictEqual(current[field], expected[field]))) {
      throw new Error("This entry changed while you were editing. Reopen it to review the latest version");
    }
  }

  async function create({ name, booksFrom }) {
    await ensure();
    const companyName = cleanName(name);
    if (!isIsoDate(booksFrom)) throw new Error("Enter the date these books begin");
    const id = `${companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "book"}-${randomBytes(3).toString("hex")}`;
    const company = {
      id,
      name: companyName,
      booksFrom,
      groups: reservedGroups(),
      ledgers: [emptyCashLedger()],
    };
    const folder = dir(id);
    await mkdir(folder, { recursive: true });
    await writeJson(path.join(folder, "company.json"), company);
    await writeJson(path.join(folder, "vouchers.json"), []);
    await log(id, { action: "create", entity: "company", id, summary: `Company ${companyName} created with books beginning ${dmy(booksFrom)}.`, after: { name: companyName, booksFrom } });
    return bundle(company, []);
  }

  async function get(id) {
    const { company, vouchers, warning } = await load(id);
    return warning ? { ...bundle(company, vouchers), warning } : bundle(company, vouchers);
  }

  // Report readers may share a parsed, read-only book. Writers always load their own copy.
  let recent = null;
  async function revision(folder) {
    const files = await Promise.all(["company.json", "vouchers.json"].map(name =>
      stat(path.join(folder, name), { bigint: true })));
    return {
      key: files.map(f => [f.ino, f.size, f.mtimeNs, f.ctimeNs].join(":")).join("/"),
      bytes: files[0].size + files[1].size
    };
  }
  async function snapshot(id) {
    const folder = dir(id);
    await recoverBook(folder);
    const stamp = await revision(folder);
    if (recent?.id === id && recent.key === stamp.key) return recent.book;
    const book = await get(id);
    if ((await revision(folder)).key !== stamp.key) throw new Error("Company files changed while opening. Open the book again.");
    if (stamp.bytes <= 32n * 1024n * 1024n) recent = { id, key: stamp.key, book };
    return book;
  }

  async function addGroup(id, input) {
    const { company, vouchers } = await load(id);
    const name = cleanName(input.name);
    const parent = company.groups.find((group) => group.id === input.parentId);
    if (!parent) throw new Error("Choose the group this sits under");
    if (company.groups.some((group) => group.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("A group with that name already exists");
    }
    const group = {
      id: `g-${randomBytes(4).toString("hex")}`,
      name,
      parentId: parent.id,
      nature: null,
      gross: false,
      cashBank: false,
      reserved: false,
    };
    company.groups.push(group);
    await writeJson(path.join(dir(id), "company.json"), company);
    await log(id, { action: "create", entity: "group", id: group.id, summary: `Group ${name} created under ${parent.name}.`, after: groupSnapshot(group) });
    return bundle(company, vouchers);
  }

  /* Credit terms used by the ageing reports: MSME status (Section 43B(h)) and credit days for due dates. */
  function ledgerTerms(input) {
    const terms = {};
    if (input.msme !== undefined && input.msme !== null) {
      if (typeof input.msme !== "boolean") throw new Error("MSME is yes or no");
      terms.msme = input.msme;
    }
    if (input.creditDays !== undefined) {
      if (input.creditDays === null || input.creditDays === "") terms.creditDays = null;
      else {
        const days = Number(input.creditDays);
        if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error("Credit days are a whole number of days from 0 to 3650");
        terms.creditDays = days;
      }
    }
    return terms;
  }
  function applyTerms(ledger, terms) {
    if ("msme" in terms) { if (terms.msme) ledger.msme = true; else delete ledger.msme; }
    if ("creditDays" in terms) { if (terms.creditDays === null) delete ledger.creditDays; else ledger.creditDays = terms.creditDays; }
  }
  async function addLedger(id, input) {
    const { company, vouchers } = await load(id);
    const name = cleanName(input.name);
    const group = company.groups.find((item) => item.id === input.groupId);
    if (!group) throw new Error("Choose a group");
    if (company.ledgers.some((ledger) => ledger.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("A ledger with that name already exists");
    }
    const paise = input.openingPaise ?? 0;
    if (!Number.isSafeInteger(paise) || paise < 0) throw new Error("Opening balance must be zero or more");
    if (input.openingDc !== "Dr" && input.openingDc !== "Cr") throw new Error("Opening balance is debit or credit");
    const ledger = {
      id: `l-${randomBytes(4).toString("hex")}`,
      name,
      groupId: group.id,
      opening: { dc: input.openingDc, paise },
    };
    applyTerms(ledger, ledgerTerms(input));
    company.ledgers.push(ledger);
    if (paise > 0) assertBookAmounts(company, vouchers);
    if (paise > 0) assertPeriodOpen(company, "books", company.booksFrom);
    await writeJson(path.join(dir(id), "company.json"), company);
    await log(id, { action: "create", entity: "ledger", id: ledger.id, summary: `Ledger ${name} created under ${group.name} with opening balance ${balanceText(ledger.opening)}.`, after: ledgerSnapshot(ledger) });
    return bundle(company, vouchers);
  }

  async function updateGroup(id, groupId, input) {
    const { company, vouchers } = await load(id);
    const group = company.groups.find((item) => item.id === groupId);
    if (!group) throw new Error("That group is not in this company");
    if (group.reserved) throw new Error("Reserved groups keep their original names");
    assertCurrent(group, input.expected, ["name"]);
    const name = cleanName(input.name);
    if (company.groups.some((item) => item.id !== groupId && item.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("A group with that name already exists");
    }
    const before = groupSnapshot(group);
    group.name = name;
    await writeJson(path.join(dir(id), "company.json"), company);
    if (before.name !== name) await log(id, { action: "alter", entity: "group", id: group.id, summary: `Group ${before.name} renamed to ${name}.`, before, after: groupSnapshot(group) });
    return bundle(company, vouchers);
  }

  async function removeGroup(id, groupId, expected) {
    const { company, vouchers } = await load(id);
    const group = company.groups.find((item) => item.id === groupId);
    if (!group) throw new Error("That group is not in this company");
    if (group.reserved) throw new Error("Reserved groups belong to the chart of accounts");
    assertCurrent(group, expected, ["name"]);
    if (company.groups.some((item) => item.parentId === groupId) || company.ledgers.some((item) => item.groupId === groupId)) {
      throw new Error("Move this group's ledgers and child groups before removing it");
    }
    company.groups = company.groups.filter((item) => item.id !== groupId);
    await writeJson(path.join(dir(id), "company.json"), company);
    await log(id, { action: "delete", entity: "group", id: groupId, summary: `Group ${group.name} deleted.`, before: groupSnapshot(group) });
    return bundle(company, vouchers);
  }

  async function updateLedger(id, ledgerId, input) {
    const { company, vouchers } = await load(id);
    const ledger = company.ledgers.find((item) => item.id === ledgerId);
    if (!ledger) throw new Error("That ledger is not in this company");
    const originalLedger = structuredClone(ledger);
    assertCurrent(ledger, input.expected, ["name", "groupId", "opening"]);
    const name = cleanName(input.name);
    if (company.ledgers.some((item) => item.id !== ledgerId && item.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("A ledger with that name already exists");
    }
    if (!company.groups.some((item) => item.id === input.groupId)) throw new Error("Choose a group");
    const paise = input.openingPaise ?? ledger.opening.paise;
    const dc = input.openingDc ?? ledger.opening.dc;
    if (!Number.isSafeInteger(paise) || paise < 0) throw new Error("Opening balance must be zero or more");
    if (dc !== "Dr" && dc !== "Cr") throw new Error("Opening balance is debit or credit");
    let reason = "";
    if (input.reason !== undefined && input.reason !== null && input.reason !== "") {
      reason = typeof input.reason === "string" ? input.reason.trim().replace(/\s+/g, " ") : "";
      if (reason.length < 10 || reason.length > 240) throw new Error("Give a reason for the opening-balance correction in 10 to 240 characters");
    }
    const used = vouchers.some((voucher) => voucher.lines.some((line) => line.ledgerId === ledgerId));
    if (used && !reason && (paise !== ledger.opening.paise || (paise > 0 && dc !== ledger.opening.dc))) {
      throw new Error("An opening balance can change only before a voucher uses this ledger. Give a reason for the correction (10 to 240 characters) to change it now; the change is kept in the edit log");
    }
    const openingChanged = paise !== ledger.opening.paise || dc !== ledger.opening.dc;
    if (openingChanged && (paise > 0 || ledger.opening.paise > 0)) assertPeriodOpen(company, "books", company.booksFrom);
    const groupChanged = ledger.groupId !== input.groupId;
    if ((groupChanged || openingChanged) && itcAccountIds(company).has(ledgerId)) throw new Error("Reviewed input-tax ledgers keep their original group and opening balance");
    if (groupChanged && (gstAccountIds(company).has(ledgerId) || rcmAccountIds(company).has(ledgerId) || itcAccountIds(company).has(ledgerId))) throw new Error("GST posting ledgers keep their account groups. Change the GST master instead");
    ledger.name = name;
    ledger.groupId = input.groupId;
    ledger.opening = { dc, paise };
    applyTerms(ledger, ledgerTerms(input));
    guardReconciledLedger(company, originalLedger, ledger);
    if (groupChanged) {
      for (const voucher of vouchers) {
        if (voucher.lines.some((line) => line.ledgerId === ledgerId)) {
          // A ledger move cannot create number clashes. Recheck the affected voucher rules only.
          assertVoucher(company, voucher, [], voucher.id);
        }
      }
    }
    if (openingChanged) assertBookAmounts(company, vouchers);
    await writeJson(path.join(dir(id), "company.json"), company);
    const before = ledgerSnapshot(originalLedger);
    const after = ledgerSnapshot(ledger);
    if (!isDeepStrictEqual(before, after)) {
      const changes = [];
      if (before.name !== after.name) changes.push(`renamed from ${before.name}`);
      if (Boolean(before.msme) !== Boolean(after.msme)) changes.push(after.msme ? "marked as an MSME supplier" : "MSME mark removed");
      if (before.creditDays !== after.creditDays) changes.push(`credit days ${before.creditDays ?? 0} to ${after.creditDays ?? 0}`);
      if (groupChanged) changes.push(`moved from ${company.groups.find((item) => item.id === before.groupId)?.name || before.groupId} to ${company.groups.find((item) => item.id === after.groupId)?.name || after.groupId}`);
      if (before.opening.paise !== after.opening.paise || (before.opening.dc !== after.opening.dc && (before.opening.paise || after.opening.paise))) changes.push(`opening balance ${used ? "corrected" : "changed"} from ${balanceText(before.opening)} to ${balanceText(after.opening)}`);
      const summary = `Ledger ${after.name} altered${changes.length ? `: ${changes.join("; ")}` : ""}.${reason ? ` Reason: ${reason}` : ""}`;
      await log(id, { action: "alter", entity: "ledger", id: ledgerId, summary, before, after, ...(reason ? { reason } : {}) });
    }
    return bundle(company, vouchers);
  }

  async function removeLedger(id, ledgerId, expected) {
    const { company, vouchers } = await load(id);
    const ledger = company.ledgers.find((item) => item.id === ledgerId);
    if (!ledger) throw new Error("That ledger is not in this company");
    assertCurrent(ledger, expected, ["name", "groupId", "opening"]);
    if (gstAccountIds(company).has(ledgerId) || rcmAccountIds(company).has(ledgerId) || itcAccountIds(company).has(ledgerId)) throw new Error("This ledger belongs to a GST master and is required for invoice posting");
    if (vouchers.some((voucher) => voucher.lines.some((line) => line.ledgerId === ledgerId))) {
      throw new Error("This ledger has vouchers. Move those entries before removing it");
    }
    guardReconciledLedger(company, company.ledgers.find(ledger => ledger.id === ledgerId), null);
    if (ledger.opening.paise > 0) assertPeriodOpen(company, "books", company.booksFrom);
    company.ledgers = company.ledgers.filter((item) => item.id !== ledgerId);
    await writeJson(path.join(dir(id), "company.json"), company);
    await log(id, { action: "delete", entity: "ledger", id: ledgerId, summary: `Ledger ${ledger.name} deleted.`, before: ledgerSnapshot(ledger) });
    return bundle(company, vouchers);
  }

  async function passVoucher(id, input, voucherId) {
    const { company, vouchers } = await load(id);
    const guard = lockGuard(company, vouchers);
    const original = voucherId ? vouchers.find((voucher) => voucher.id === voucherId) : null;
    if (voucherId && !original) throw new Error("That voucher is not in this company");
    if (original?.gstItc || input.gstItc) throw new Error("This journal belongs to a purchase credit review. Use the ITC review workflow");
    if (original?.gstRcm || input.gstRcm) throw new Error("RCM settlement entries keep their tax and cash linkage. Use the RCM reversal workflow");
    if (original?.gst || input.gst) throw new Error("GST invoices are linked to tax and stock records. Correct them with a GST credit or debit note");
    if (original) assertCurrent(original, input.expected, ["type", "date", "number", "narration", "lines"]);
    const requestId = input.requestId;
    if (requestId !== undefined && (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId))) {
      throw new Error("Invalid voucher save identifier");
    }
    const prior = !voucherId && requestId ? vouchers.find((voucher) => voucher.requestId === requestId) : null;
    const saved = assertVoucher(company, input, vouchers, original?.id || prior?.id || `v-${randomBytes(5).toString("hex")}`);
    if (saved.lines.some(line=>itcAccountIds(company).has(line.ledgerId))) throw new Error("Use purchase ITC review to post to its control ledgers");
    if (prior) {
      const { requestId: priorRequestId, ...priorEntry } = prior;
      if (!isDeepStrictEqual(saved, priorEntry)) throw new Error("That save identifier already belongs to a different voucher");
      return { ...bundle(company, vouchers), voucher: prior, replayed: true };
    }
    if (original && company.stock?.journals?.some(j=>j.accountingVoucherId === original.id) && tallyStockPostingHash(saved) !== tallyStockPostingHash(original)) {
      throw new Error("This Tally voucher is linked to an active stock movement. Record a correction in the accounts and inventory.");
    }
    guardReconciledVoucher(company, original, saved);
    if (original?.requestId || requestId) saved.requestId = original?.requestId || requestId;
    if (original?.source) saved.source = structuredClone(original.source);
    const index = vouchers.findIndex((voucher) => voucher.id === saved.id);
    const before = index === -1 ? null : structuredClone(vouchers[index]);
    if (index === -1) vouchers.push(saved);
    else vouchers[index] = saved;
    if (!original || !isDeepStrictEqual(saved.lines, original.lines)) assertBookAmounts(company, vouchers);
    guard.check(vouchers);
    await writeJson(path.join(dir(id), "vouchers.json"), vouchers);
    if (!before) await log(id, voucherEntry("create", null, saved, { requestId: saved.requestId }));
    else if (!isDeepStrictEqual(voucherSnapshot(before), voucherSnapshot(saved))) await log(id, voucherEntry("alter", before, saved, { requestId: input.requestId }));
    return { ...bundle(company, vouchers), voucher: saved };
  }

  async function removeVoucher(id, voucherId, expected) {
    const { company, vouchers } = await load(id);
    const existing = vouchers.find((voucher) => voucher.id === voucherId);
    if (existing) assertCurrent(existing, expected, ["type", "date", "number", "narration", "lines"]);
    if (vouchers.find(voucher => voucher.id === voucherId)?.gstItc) throw new Error("This journal belongs to a purchase credit review and cannot be deleted");
    if (vouchers.find(voucher => voucher.id === voucherId)?.gstRcm) throw new Error("RCM settlement entries keep their tax and cash linkage. Use the RCM reversal workflow");
    if (vouchers.find(voucher => voucher.id === voucherId)?.gst) throw new Error("GST invoices keep their tax and stock linkage. Use a GST credit note to reverse the supply");
    if (company.stock?.journals?.some(j=>j.accountingVoucherId === voucherId)) throw new Error("This Tally voucher is linked to an active stock movement and cannot be deleted");
    guardReconciledVoucher(company, vouchers.find(voucher => voucher.id === voucherId), null);
    const next = vouchers.filter((voucher) => voucher.id !== voucherId);
    if (next.length === vouchers.length) throw new Error("That voucher is not in this company");
    lockGuard(company, vouchers).check(next);
    await writeJson(path.join(dir(id), "vouchers.json"), next);
    await log(id, voucherEntry("delete", existing, null));
    return bundle(company, next);
  }

  async function gstRcmAction(id, action, input) {
    const { company, vouchers } = await load(id);
    if (action === "setup") {
      const before = structuredClone(company.gst ?? null);
      const ledgerCount = company.ledgers.length;
      const accounts = ensureRcmAccounts(company, input.registrationId);
      assertRcmBook(company, vouchers);
      await writeJson(path.join(dir(id), "company.json"), company);
      if (ledgerCount !== company.ledgers.length || !isDeepStrictEqual(before, company.gst ?? null)) {
        await log(id, { action: "alter", entity: "gst-master", id: String(input.registrationId || "rcm"), summary: `Reverse-charge posting ledgers set up for registration ${registrationLabel(company, input.registrationId)}.`, after: { accounts } });
      }
      return { accounts };
    }
    const guard = lockGuard(company, vouchers);
    const result = buildRcmAction(company, vouchers, action, input);
    if (result.replayed) return result;
    assertPeriodOpen(company, "gst", result.record.date);
    const voucher = { ...assertVoucher(company, result.voucher, vouchers, result.voucher.id), gstRcm: result.record };
    vouchers.push(voucher);
    assertBookAmounts(company, vouchers);
    assertRcmBook(company, vouchers);
    guard.check(vouchers);
    await writeJson(path.join(dir(id), "vouchers.json"), vouchers);
    const invoice = vouchers.find((item) => item.id === result.record.invoiceId);
    await log(id, { action: "create", entity: "gst-document", id: result.record.id, number: voucher.number, summary: `Reverse-charge ${action} recorded on ${dmy(voucher.date)} for ${invoice?.number || result.record.invoiceId}: ${rupees(voucher.lines.reduce((sum, line) => sum + (line.dc === "Dr" ? line.paise : 0), 0))}.`, after: voucherSnapshot(voucher), requestId: input.requestId });
    return { ...result, voucher };
  }

  async function getGstExchange(id, invoiceId) {
    const { company, vouchers } = await snapshot(id);
    const voucher = vouchers.find(value => value.id === invoiceId && value.gst);
    if (!voucher) throw new Error("Choose an existing GST invoice");
    return exchangeView(voucher.gst, voucher.gstExchange, company);
  }

  async function saveGstExchange(id, invoiceId, action, input) {
    const { company, vouchers } = await load(id);
    const voucher = vouchers.find(value => value.id === invoiceId && value.gst);
    if (!voucher) throw new Error("Choose an existing GST invoice");
    const history = voucher.gstExchange || { version: 1, preparations: [], acknowledgements: [] };
    if (action === "preparation") {
      const fields = normalizePreparation(voucher.gst, input);
      if (isDeepStrictEqual(history.preparations.at(-1)?.fields, fields)) return { ...exchangeView(voucher.gst, history, company), replayed: true };
      if (history.preparations.length >= 100) throw new Error("This invoice has reached its preparation-history limit");
      history.preparations.push({ id: `prep-${randomUUID()}`, savedAt: new Date().toISOString(), invoiceFingerprint: invoiceFingerprint(voucher.gst), fields });
    } else if (action === "acknowledgement") {
      const record = acknowledgementRecord(voucher.gst, input, Date.now(), history.acknowledgements);
      for (const other of vouchers) {
        const existing = other.gstExchange?.acknowledgements.find(value => value.kind === record.kind && value.reference === record.reference);
        if (!existing) continue;
        if (other.id === voucher.id && existing.rawSHA256 === record.rawSHA256) return { ...exchangeView(voucher.gst, history, company), acknowledgement: existing, replayed: true };
        throw new Error("This acknowledgement is already linked to a different record or response");
      }
      if (history.acknowledgements.length >= 100) throw new Error("This invoice has reached its acknowledgement-history limit");
      history.acknowledgements.push(record);
    } else throw new Error("Unknown invoice exchange action");
    voucher.gstExchange = history;
    await writeJson(path.join(dir(id), "vouchers.json"), vouchers);
    const label = action === "preparation" ? "E-invoice details prepared" : `IRP ${history.acknowledgements.at(-1)?.kind || "acknowledgement"} recorded`;
    await log(id, { action: "alter", entity: "gst-document", id: voucher.id, number: voucher.number, summary: `${label} for invoice ${voucher.number} dated ${dmy(voucher.date)}.`, after: voucherSnapshot(voucher).gstExchange });
    return exchangeView(voucher.gst, history, company);
  }

  async function mutateCompanySection(id, section, transform) {
    if (!["reconciliation","stock"].includes(section)) throw new Error("Unknown mutable company metadata section");
    const { warning, ...book } = await load(id);
    const guard = lockGuard(book.company, book.vouchers);
    const current = structuredClone(book.company[section] ?? null);
    const previous = structuredClone(current);
    const updated = await transform(current, structuredClone(book));
    if (!updated || typeof updated !== "object" || Array.isArray(updated)) throw new Error(`Invalid ${section} section`);
    const bytes = Buffer.byteLength(JSON.stringify(updated));
    const limit = SECTION_LIMITS[section];
    if (bytes > limit) throw new Error(`The ${section} section is oversized at ${byteCount.format(bytes)} bytes; the limit is ${byteCount.format(limit)} bytes`);
    book.company[section] = updated;
    if (section === "stock") assertStockBook(book.company, book.vouchers);
    else assertReconciliation(book.company, book.vouchers);
    if (section === "stock") guard.checkStock(updated);
    await writeJson(path.join(dir(id), "company.json"), book.company);
    await log(id, section === "stock" ? stockEntries(previous, updated) : reconciliationEntries(previous, updated));
    return bundle(book.company, book.vouchers);
  }

  async function reviewTallyGst(id, action, records, input) {
    const {company,vouchers} = await load(id);
    const apply = action==="mapping" ? saveTallyGstMapping : activateTallyGstPromotion;
    const guard = lockGuard(company, vouchers);
    const change=apply(company,vouchers,records,input);
    if (!change.replayed) {
      assertTallyGstBook(change.company,change.vouchers);
      assertBookAmounts(change.company,change.vouchers);
      assertStockBook(change.company,change.vouchers);
      guard.check(change.vouchers);
      if (action==="mapping") await writeJson(path.join(dir(id),"company.json"),change.company);
      else await commit(id,change.company,change.vouchers);
      await log(id, { action: action === "mapping" ? "alter" : "import", entity: "gst-document", id: `tally-gst-${action}`, summary: action === "mapping" ? "Tally GST mapping saved for review." : "Tally GST documents promoted into the GST register.", after: { revision: change.report?.revision ?? null }, requestId: input?.requestId, revision: change.report?.revision });
    }
    return {result:change.result,report:change.report,revision:change.report.revision,replayed:change.replayed===true};
  }

  async function gstItcAction(id,action,input) {
    const {company,vouchers}=await load(id);
    const invoice=vouchers.find(v=>v.gst?.id===input?.invoiceId)?.gst;
    if (!invoice || invoice.direction!=="purchase" || invoice.reverseCharge) throw new Error("Choose a forward-charge purchase document");
    ensureItcAccounts(company,invoice.registrationId);
    const result=buildItcAction(company,vouchers,action,input);
    if (result.replayed) return result;
    await verifyItcStatement(dir(id),company,vouchers,invoice.id,input.evidence?.statement);
    const record=result.record;
    assertPeriodOpen(company,"gst",record.date);
    const guard=lockGuard(company,vouchers);
    company.gst.itc.records.push(record);
    if (result.voucher) {
      const checked={...assertVoucher(company,result.voucher,vouchers,result.voucher.id),gstItc:record};
      vouchers.push(checked);
      result.voucher=checked;
    }
    assertItcBook(company,vouchers);
    assertBookAmounts(company,vouchers);
    assertStockBook(company,vouchers);
    guard.check(vouchers);
    if (result.voucher) await commit(id,company,vouchers);
    else await writeJson(path.join(dir(id),"company.json"),company);
    await log(id,{action:"create",entity:"gst-document",id:record.id,number:result.voucher?.number,summary:`Input tax credit ${action} recorded on ${dmy(record.date)} for purchase ${invoice.number}${invoice.supplierInvoiceNumber ? ` (supplier invoice ${invoice.supplierInvoiceNumber})` : ""}.`,after:{action:record.action,date:record.date,invoiceId:record.invoiceId,voucherId:record.voucherId ?? null},requestId:input.requestId});
    return result;
  }

  async function saveCreditReview(id, input) {
    const { company, vouchers } = await load(id);
    const result = applyCreditReview(company, vouchers, input);
    if (!result.replayed) {
      assertPeriodOpen(company, "gst", result.record.declarationDate);
      assertCreditReviews(result.company, vouchers);
      await writeJson(path.join(dir(id), "company.json"), result.company);
      const note = vouchers.find((voucher) => voucher.id === result.record.invoiceId);
      await log(id, { action: "create", entity: "gst-document", id: result.record.id, number: note?.number, summary: `Credit-note output-tax review recorded for ${note?.number || result.record.invoiceId} with proposed declaration on ${dmy(result.record.declarationDate)}.`, after: { invoiceId: result.record.invoiceId, declarationDate: result.record.declarationDate, recipientBasis: result.record.recipientBasis, adjustmentGround: result.record.adjustmentGround }, requestId: result.record.requestId, revision: result.revision });
    }
    return { record: result.record, revision: result.revision, replayed: result.replayed, status: result.status };
  }

  async function saveGstAmendment(id, input) {
    const { company, vouchers } = await load(id);
    const result = buildOutwardAmendment(company,vouchers,input);
    if (result.replayed) return result;
    assertPeriodOpen(company, "gst", result.record.date);
    const amendments = company.gst.outwardAmendments ??= {version:1, revision:0, records:[]};
    amendments.records.push(result.record);
    amendments.revision = result.revision;
    // Only this company-file append changes state. Publish linked evidence before the reference.
    await saveFiledSource(dir(id),company,result.record,input.sourceFileBase64);
    await writeJson(path.join(dir(id),"company.json"),company);
    const amended = vouchers.find((voucher) => voucher.id === result.record.invoiceId);
    await log(id, { action: "create", entity: "gst-document", id: result.record.id, number: amended?.number, summary: `Outward amendment prepared on ${dmy(result.record.date)} for ${amended?.number || result.record.invoiceId}, correcting period ${result.record.originalPeriod} in period ${result.record.amendmentPeriod}.`, after: { invoiceId: result.record.invoiceId, date: result.record.date, originalPeriod: result.record.originalPeriod, amendmentPeriod: result.record.amendmentPeriod }, requestId: input.requestId, revision: result.revision });
    return result;
  }

  async function saveGstAmendmentEvent(id, action, input) {
    const {company,vouchers} = await load(id);
    const result = buildAmendmentEvent(company,vouchers,action,input);
    if (result.replayed) return result;
    assertPeriodOpen(company, "gst", result.event.date);
    const amendments = company.gst.outwardAmendments;
    (amendments.events ??= []).push(result.event);
    amendments.revision = result.revision;
    await writeJson(path.join(dir(id),"company.json"),company);
    await log(id, { action: "alter", entity: "gst-document", id: result.event.amendmentId, summary: `Outward amendment ${action === "withdraw" ? "withdrawn" : "filing recorded"} on ${dmy(result.event.date)}.`, after: { event: result.event.id, action, date: result.event.date }, requestId: input.requestId, revision: result.revision });
    return result;
  }

  async function saveGstStatement(id,reg,month,input) {
    const {company,vouchers}=await load(id);
    const result=await recordStatement(dir(id),company,vouchers,reg,month,input);
    if (!result.replayed) {
      await writeJson(path.join(dir(id),"company.json"),company);
      await log(id,{action:"import",entity:"gst-document",id:`statement-${reg}-${month}`,summary:`GST statement for ${month} saved for registration ${registrationLabel(company,reg)}.`,after:{registrationId:reg,month},requestId:input?.requestId});
    }
    return result;
  }

  async function saveGstMaster(id, kind, input) {
    const { company, vouchers } = await load(id);
    const methods = { registration: saveRegistration, party: saveParty, item: saveItem, turnover: saveTurnover, irpPolicy: saveIrpPolicy };
    if (!methods[kind]) throw new Error("Unknown GST master");
    if (kind === "item" && input.id && company.stock?.journals?.some(j=>j.lines.some(l=>l.itemId===input.id))) {
      const previous = company.gst?.items?.find(i=>i.id===input.id);
      if (previous && (previous.kind !== input.kind || previous.unit !== input.unit)) throw new Error("A stock journal uses this item's unit and kind");
    }
    const collection = { registration: "registrations", party: "parties", item: "items" }[kind];
    const previous = collection && input?.id ? structuredClone(company.gst?.[collection]?.find((entry) => entry.id === input.id) ?? null) : structuredClone(kind === "turnover" || kind === "irpPolicy" ? company.gst?.[kind] ?? null : null);
    const saved = methods[kind](company, input, vouchers);
    if (kind === "item" && company.stock) assertStockBook(company,vouchers);
    if (kind === "registration") ensureRcmAccounts(company, saved.id);
    assertRcmBook(company, vouchers);
    await writeJson(path.join(dir(id), "company.json"), company);
    const label = { registration: "GST registration", party: "GST party", item: "GST item", turnover: "Aggregate turnover", irpPolicy: "E-invoice policy" }[kind];
    const title = saved?.gstin || saved?.name || saved?.legalName || saved?.id || "";
    if (!isDeepStrictEqual(previous, saved)) await log(id, { action: previous ? "alter" : "create", entity: "gst-master", id: String(saved?.id || kind), summary: `${label}${title ? ` ${title}` : ""} ${previous ? "altered" : "saved"}.`, before: previous, after: compactMaster(saved), requestId: input?.requestId });
    return { ...gstState(company, vouchers), [kind]: saved };
  }

  async function previewGstInvoice(id, input) {
    const { company, vouchers } = await load(id);
    const invoice = buildGstInvoice(company, vouchers, input, "preview");
    invoiceStockMetadata(company, invoice, input, vouchers);
    return { invoice };
  }

  async function passGstInvoice(id, input) {
    const { company, vouchers } = await load(id);
    const guard = lockGuard(company, vouchers);
    if (input.requestId !== undefined && (typeof input.requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId))) throw new Error("Invalid invoice save identifier");
    const prior = input.requestId ? vouchers.find(voucher => voucher.gst?.requestId === input.requestId) : null;
    if (prior) {
      if (prior.gst.requestHash !== gstRequestHash(input)) throw new Error("That invoice save identifier belongs to a different request");
      return { invoice: prior.gst, voucher: prior, replayed: true };
    }
    const invoice = buildGstInvoice(company, vouchers, input);
    const source = gstVoucher(invoice);
    const voucher = { ...assertVoucher(company, source, vouchers, source.id), gst: invoice };
    const locations = invoiceStockMetadata(company,invoice,input,vouchers);
    if (locations) voucher.stock = locations;
    assertGstSnapshot(company, voucher);
    vouchers.push(voucher);
    if (locations || company.stock) assertStockBook(company,vouchers);
    assertBookAmounts(company, vouchers);
    assertRcmBook(company, vouchers);
    guard.check(vouchers);
    await writeJson(path.join(dir(id), "vouchers.json"), vouchers);
    await log(id, { action: "create", entity: "gst-document", id: voucher.id, number: invoice.number, summary: `GST ${invoice.direction === "purchase" ? "purchase" : "sales"} ${invoice.type} ${invoice.number} dated ${dmy(invoice.date)} for ${rupees(invoice.totals?.totalPaise ?? 0)} recorded${invoice.party?.name ? ` for ${invoice.party.name}` : ""}.`, after: voucherSnapshot(voucher), requestId: input.requestId });
    return { invoice, voucher };
  }

  async function setLocks(id, input) {
    const { company } = await load(id);
    if (input?.expected !== undefined && !isDeepStrictEqual(locksOf(company), input.expected)) {
      throw new Error("The locks changed while you were editing. Reopen Books settings to review the latest version");
    }
    const { locks, changes } = checkedLockRequest(company, input);
    if (!changes.length) return { locks: locksOf(company), replayed: true };
    company.locks = locks;
    await writeJson(path.join(dir(id), "company.json"), company);
    await log(id, changes.map(lockEntry));
    return { locks: locksOf(company), replayed: false };
  }

  async function setNumbering(id, input) {
    const { company, vouchers } = await load(id);
    const source = input?.numbering ?? input;
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Choose the voucher numbering to save");
    const requestId = input?.requestId;
    if (requestId !== undefined && (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId))) throw new Error("Invalid numbering save identifier");
    const before = numberingConfig(company);
    if (input?.expected !== undefined && !isDeepStrictEqual(before, input.expected)) {
      throw new Error("The numbering changed while you were editing. Reopen it to review the latest version");
    }
    const types = Object.keys(source).filter((key) => !(input?.numbering === undefined && ["requestId", "expected"].includes(key)));
    if (!types.length) throw new Error("Choose the voucher numbering to save");
    const saved = { ...(company.numbering || {}) };
    for (const type of types) {
      const series = checkedSeries(type, source[type]);
      if (before[type].restartEachFY && !series.restartEachFY) {
        const repeated = crossYearDuplicate(vouchers, type);
        if (repeated) throw new Error(`${type} number ${repeated} is used in more than one financial year. Keep restarting each year, or renumber those vouchers first`);
      }
      saved[type] = series;
    }
    const after = numberingConfig({ numbering: saved });
    const changed = types.filter((type) => !isDeepStrictEqual(before[type], after[type]));
    if (!changed.length) return { ...numberingView(company, vouchers), replayed: true };
    company.numbering = saved;
    await writeJson(path.join(dir(id), "company.json"), company);
    const preview = nextNumbers(company, vouchers, todayISO());
    await log(id, changed.map((type) => ({ action: "alter", entity: "numbering", id: type, summary: `${type} numbering changed; the next number is ${preview[type]}.`, before: before[type], after: after[type], requestId })));
    return { ...numberingView(company, vouchers), replayed: false };
  }

  async function auditTrail(id, query) {
    // A missing company surfaces as "not on this machine"; the books are not parsed.
    await stat(path.join(dir(id), "company.json"));
    return queryAuditLog(dir(id), query);
  }

  // A restored company (for example a full Tally archive) carries the edit log of the
  // backup it came from. The lines are adopted only into a company without a log yet,
  // then a "restore" entry is appended. History is never truncated.
  async function adoptAuditLog(id, auditLog, entry) {
    const folder = dir(id);
    await load(id);
    if (await auditExists(folder)) return false;
    const carried = checkedAuditBackup(auditLog);
    if (carried.length) await writeAuditLines(folder, carried);
    await log(id, entry);
    return true;
  }

  async function specimen() {
    await ensure();
    const { company, vouchers } = buildSpecimen();
    company.id = `specimen-${randomBytes(3).toString("hex")}`;
    const folder = dir(company.id);
    await mkdir(folder, { recursive: true });
    await writeJson(path.join(folder, "company.json"), company);
    await writeJson(path.join(folder, "vouchers.json"), vouchers);
    await log(company.id, { action: "create", entity: "company", id: company.id, summary: `Specimen company ${company.name} created with ${vouchers.length} sample vouchers.`, after: { name: company.name, booksFrom: company.booksFrom, vouchers: vouchers.length } });
    return bundle(company, vouchers);
  }

  return {
    snapshot: (id) => serial(id, () => snapshot(id)),
    gstState: (id, date) => serial(id, async () => { const { company, vouchers } = await snapshot(id); return { ...gstState(company, vouchers, date), godowns:stockLocations(company) }; }),
    reviewTallyGst:(id,action,records,input)=>serial(id,()=>reviewTallyGst(id,action,records,input)),
    saveGstAmendmentEvent:(id,action,input)=>serial(id,()=>saveGstAmendmentEvent(id,action,input)),
    saveGstAmendment:(id,input)=>serial(id,()=>saveGstAmendment(id,input)),
    saveCreditReview:(id,input)=>serial(id,()=>saveCreditReview(id,input)),
    gstItcAction:(id,action,input)=>serial(id,()=>gstItcAction(id,action,input)),
    gstRcmAction: (id, action, input) => serial(id, () => gstRcmAction(id, action, input)),
    saveGstStatement: (id,reg,month,input) => serial(id,()=>saveGstStatement(id,reg,month,input)),
    getGstExchange: (id, invoiceId) => serial(id, () => getGstExchange(id, invoiceId)),
    saveGstExchange: (id, invoiceId, action, input) => serial(id, () => saveGstExchange(id, invoiceId, action, input)),
    mutateCompanySection: (id, section, transform) => serial(id, () => mutateCompanySection(id, section, transform)),
    saveGstMaster: (id, kind, input) => serial(id, () => saveGstMaster(id, kind, input)),
    previewGstInvoice: (id, input) => serial(id, () => previewGstInvoice(id, input)),
    passGstInvoice: (id, input) => serial(id, () => passGstInvoice(id, input)),
    list, create, specimen,
    get: (id) => serial(id, () => get(id)),
    addGroup: (id, input) => serial(id, () => addGroup(id, input)),
    addLedger: (id, input) => serial(id, () => addLedger(id, input)),
    updateGroup: (id, groupId, input) => serial(id, () => updateGroup(id, groupId, input)),
    removeGroup: (id, groupId, expected) => serial(id, () => removeGroup(id, groupId, expected)),
    updateLedger: (id, ledgerId, input) => serial(id, () => updateLedger(id, ledgerId, input)),
    removeLedger: (id, ledgerId, expected) => serial(id, () => removeLedger(id, ledgerId, expected)),
    passVoucher: (id, input, voucherId) => serial(id, () => passVoucher(id, input, voucherId)),
    setLocks: (id, input) => serial(id, () => setLocks(id, input)),
    locks: (id) => serial(id, async () => ({ locks: locksOf((await load(id)).company) })),
    setNumbering: (id, input) => serial(id, () => setNumbering(id, input)),
    numbering: (id, date) => serial(id, async () => { const { company, vouchers } = await load(id); return numberingView(company, vouchers, date && isIsoDate(date) ? date : todayISO()); }),
    auditTrail: (id, query) => serial(id, () => auditTrail(id, query)),
    adoptAuditLog: (id, auditLog, entry) => serial(id, () => adoptAuditLog(id, auditLog, entry)),
    removeVoucher: (id, voucherId, expected) => serial(id, () => removeVoucher(id, voucherId, expected)),
  };
}
