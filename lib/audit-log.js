// Statutory edit log (Companies (Accounts) Rules 2014, rule 3(1) proviso): every
// change to the books is appended to data/companies/<id>/audit.jsonl, one JSON object
// per line, with the date and time of the change and compact before/after copies.
// The file is append-only and cannot be switched off. Each line carries the hash of
// the previous line, and its own hash covers the previous hash and the canonical JSON
// of the entry, so removing, reordering or editing any line breaks the chain.
import { open, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { formatINR, isIsoDate, todayISO } from "./money.js";
import { syncDirectory } from "./book-transaction.js";

export const AUDIT_FILE = "audit.jsonl";
export const GENESIS_HASH = "0".repeat(64);
export const AUDIT_ACTIONS = ["create", "alter", "delete", "lock", "unlock", "restore", "import"];
export const AUDIT_ENTITIES = ["voucher", "ledger", "group", "gst-document", "gst-master", "stock-journal", "reconciliation", "numbering", "lock", "company"];
const MAX_LINE = 4 * 1024 * 1024;
const MAX_LIMIT = 500;

// Who made a change. The server runs every request inside auditScope with a holder
// {actor}; the session gate fills in the signed-in user, so every entry appended during
// that request names the user. Token-only use (no users set up) records user: null.
// Rule 3(1) proviso of the Companies (Accounts) Rules 2014 asks for an edit log of each
// change with its date; the auditor reports on it under rule 11(g) of the Companies
// (Audit and Auditors) Rules 2014, and the ICAI Implementation Guide on rule 11(g)
// expects the trail to show who made the change, so a signed-in user is recorded.
export const auditScope = new AsyncLocalStorage();

/** The {id, name} recorded in an edit-log entry for an actor, or null. */
export function auditUser(actor) {
  if (!actor || typeof actor !== "object" || actor.id === undefined || actor.id === null || actor.id === "") return null;
  return { id: String(actor.id), name: String(actor.name ?? "") };
}

/** The actor of the current request scope, or null. */
export function currentActor() {
  return auditScope.getStore()?.actor ?? null;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function entryHash(prevHash, entry) {
  const { hash, ...body } = entry;
  return createHash("sha256").update(prevHash + canonicalJson(body)).digest("hex");
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

export function auditPath(dir) {
  return path.join(dir, AUDIT_FILE);
}

// The last complete line of the log, read from the end of the file.
async function lastLine(file) {
  let handle;
  try { handle = await open(file, "r"); }
  catch (error) { if (error.code === "ENOENT") return { exists: false, line: null, endsWithNewline: true }; throw error; }
  try {
    const { size } = await handle.stat();
    if (size === 0) return { exists: true, line: null, endsWithNewline: true };
    let chunk = 64 * 1024;
    for (;;) {
      const length = Math.min(size, chunk);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const text = buffer.toString("utf8");
      const endsWithNewline = text.endsWith("\n");
      const lines = text.split("\n").filter((line) => line.trim());
      // Skip a torn final line left by an interrupted append.
      for (let index = lines.length - 1; index >= (length === size ? 0 : 1); index -= 1) {
        try { return { exists: true, line: JSON.parse(lines[index]), endsWithNewline }; } catch { /* torn */ }
      }
      if (length === size) return { exists: true, line: null, endsWithNewline };
      if (chunk >= MAX_LINE * 2) throw new Error("The edit log ends with an unreadable entry");
      chunk *= 4;
    }
  } finally { await handle.close(); }
}

/**
 * Append entries to the company's edit log and fsync them. Each entry needs
 * action, entity, id and summary; number, before, after, requestId, revision and
 * reason are optional. `user` (an actor {id, name, role}) defaults to the actor of the
 * current request scope; entries record user: {id, name} or null. Returns the written lines.
 */
export async function appendAudit(dir, entries, { now = new Date(), user } = {}) {
  const items = entries.filter(Boolean);
  const who = auditUser(user !== undefined ? user : currentActor());
  if (!items.length) return [];
  const file = auditPath(dir);
  const tail = await lastLine(file);
  const written = [];
  let seq = tail.line?.seq ?? 0;
  let prevHash = tail.line?.hash ?? GENESIS_HASH;
  const queue = [];
  if (!tail.exists && !(items[0].entity === "company" && ["create", "import", "restore"].includes(items[0].action))) {
    queue.push({ action: "import", entity: "company", id: path.basename(dir), summary: "Edit log started for a book saved before Ledgercraft kept an edit log. Changes made before this entry are not in the log.", before: null, after: null });
  }
  queue.push(...items);
  const at = now.toISOString();
  let text = tail.endsWithNewline ? "" : "\n";
  for (const item of queue) {
    if (!AUDIT_ACTIONS.includes(item.action)) throw new Error(`Unknown edit-log action ${item.action}`);
    if (!AUDIT_ENTITIES.includes(item.entity)) throw new Error(`Unknown edit-log entity ${item.entity}`);
    const entry = {
      seq: ++seq,
      at,
      action: item.action,
      entity: item.entity,
      id: String(item.id ?? ""),
      ...(item.number !== undefined && item.number !== null && item.number !== "" ? { number: String(item.number) } : {}),
      summary: String(item.summary || ""),
      before: item.before ?? null,
      after: item.after ?? null,
      ...(item.requestId ? { requestId: String(item.requestId) } : {}),
      ...(item.revision !== undefined && item.revision !== null ? { revision: item.revision } : {}),
      ...(item.reason ? { reason: String(item.reason) } : {}),
      user: who,
      prevHash,
    };
    entry.hash = entryHash(prevHash, entry);
    prevHash = entry.hash;
    const line = JSON.stringify(entry);
    if (line.length > MAX_LINE) throw new Error("An edit-log entry is too large");
    text += line + "\n";
    written.push(entry);
  }
  const handle = await open(file, "a", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally { await handle.close(); }
  if (!tail.exists) await syncDirectory(dir);
  return written;
}

/** The sequence number of the last entry in the company's edit log (0 when there is none). */
export async function auditRevision(dir) {
  return (await lastLine(auditPath(dir))).line?.seq ?? 0;
}

/** Walk the hash chain of raw log text. */
export function verifyAuditText(text) {
  const problems = [];
  let prevHash = GENESIS_HASH;
  let seq = 0;
  const entries = [];
  const lines = String(text || "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (let index = 0; index < lines.length; index += 1) {
    let entry;
    try { entry = JSON.parse(lines[index]); }
    catch { problems.push({ line: index + 1, reason: "unreadable entry" }); continue; }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { problems.push({ line: index + 1, reason: "unreadable entry" }); continue; }
    if (entry.seq !== seq + 1) problems.push({ line: index + 1, reason: `sequence ${entry.seq} follows ${seq}` });
    if (entry.prevHash !== prevHash) problems.push({ line: index + 1, reason: "previous hash does not match" });
    if (entry.hash !== entryHash(entry.prevHash, entry)) problems.push({ line: index + 1, reason: "entry hash does not match its contents" });
    seq = Number.isSafeInteger(entry.seq) ? entry.seq : seq + 1;
    prevHash = typeof entry.hash === "string" ? entry.hash : prevHash;
    entries.push(entry);
  }
  return { verified: problems.length === 0, count: entries.length, lastHash: entries.length ? prevHash : null, problems, entries };
}

export async function readAuditText(dir) {
  try { return await readFile(auditPath(dir), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

/** Walk the chain of the company's edit log: {verified, count, lastHash, problems}. */
export async function verifyAuditLog(dir) {
  const { entries, ...result } = verifyAuditText(await readAuditText(dir));
  return result;
}

export async function auditExists(dir) {
  try { await stat(auditPath(dir)); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function localDate(at) {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : todayISO(date);
}

/** Filtered, newest-first page of the edit log: {entries, total, verified, problems}. */
export async function queryAuditLog(dir, query = {}) {
  const { entries, verified, problems } = verifyAuditText(await readAuditText(dir));
  const from = query.from || "";
  const to = query.to || "";
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to)) || (from && to && from > to)) throw new Error("Choose a valid edit-log period");
  const entity = query.entity || "";
  if (entity && !AUDIT_ENTITIES.includes(entity)) throw new Error("Choose a valid edit-log entry type");
  const words = String(query.q || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  const userId = String(query.user || "");
  const offset = Math.max(0, Math.trunc(Number(query.offset) || 0));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(Number(query.limit) || 100)));
  const matches = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entity && entry.entity !== entity) continue;
    if (userId && entry.user?.id !== userId) continue;
    if (from || to) {
      const day = localDate(entry.at);
      if ((from && day < from) || (to && day > to)) continue;
    }
    if (words.length) {
      const haystack = [entry.summary, entry.number, entry.id, entry.entity, entry.action, entry.requestId, entry.reason, entry.user?.name].filter(Boolean).join(" ").toLowerCase();
      if (!words.every((word) => haystack.includes(word))) continue;
    }
    matches.push(entry);
  }
  return { entries: matches.slice(offset, offset + limit), total: matches.length, offset, limit, verified, ...(problems.length ? { problems: problems.slice(0, 20) } : {}) };
}

// Compact snapshots and readable summaries --------------------------------------

export function dmy(iso) {
  return isIsoDate(iso) ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : String(iso ?? "");
}

export function rupees(paise) {
  return `₹${formatINR(paise)}`;
}

function voucherAmount(voucher) {
  return (voucher?.lines || []).reduce((sum, line) => sum + (line.dc === "Dr" ? line.paise : 0), 0);
}

export function voucherSnapshot(voucher) {
  if (!voucher) return null;
  const snap = { type: voucher.type, date: voucher.date, number: voucher.number, narration: voucher.narration, lines: (voucher.lines || []).map(({ ledgerId, dc, paise }) => ({ ledgerId, dc, paise })) };
  if (voucher.gst) snap.gst = { id: voucher.gst.id, direction: voucher.gst.direction, type: voucher.gst.type, number: voucher.gst.number, date: voucher.gst.date, totalPaise: voucher.gst.totals?.totalPaise };
  if (voucher.gstRcm) snap.gstRcm = { id: voucher.gstRcm.id, action: voucher.gstRcm.action, invoiceId: voucher.gstRcm.invoiceId };
  if (voucher.gstItc) snap.gstItc = { id: voucher.gstItc.id, action: voucher.gstItc.action, invoiceId: voucher.gstItc.invoiceId };
  if (voucher.gstExchange) snap.gstExchange = { preparations: voucher.gstExchange.preparations?.length || 0, acknowledgements: voucher.gstExchange.acknowledgements?.length || 0 };
  return snap;
}

export function voucherEntry(action, before, after, extra = {}) {
  const voucher = after || before;
  const verb = { create: "passed", alter: "altered", delete: "deleted" }[action];
  let summary = `${voucher.type} ${voucher.number} dated ${dmy(voucher.date)} for ${rupees(voucherAmount(voucher))} ${verb}.`;
  if (action === "alter" && before) {
    const changes = [];
    if (before.date !== after.date) changes.push(`date ${dmy(before.date)} to ${dmy(after.date)}`);
    if (before.number !== after.number) changes.push(`number ${before.number} to ${after.number}`);
    if (voucherAmount(before) !== voucherAmount(after)) changes.push(`amount ${rupees(voucherAmount(before))} to ${rupees(voucherAmount(after))}`);
    if (before.narration !== after.narration) changes.push("narration");
    if (JSON.stringify(before.lines) !== JSON.stringify(after.lines) && voucherAmount(before) === voucherAmount(after)) changes.push("ledger lines");
    if (changes.length) summary = `${voucher.type} ${voucher.number} dated ${dmy(voucher.date)} altered: ${changes.join(", ")}.`;
  }
  return { action, entity: "voucher", id: voucher.id, number: voucher.number, summary, before: voucherSnapshot(before), after: voucherSnapshot(after), ...extra };
}

export function ledgerSnapshot(ledger) {
  return ledger ? { name: ledger.name, groupId: ledger.groupId, opening: { dc: ledger.opening?.dc, paise: ledger.opening?.paise }, ...(ledger.msme ? { msme: true } : {}), ...(ledger.creditDays !== undefined ? { creditDays: ledger.creditDays } : {}) } : null;
}

export function groupSnapshot(group) {
  return group ? { name: group.name, parentId: group.parentId } : null;
}

export function balanceText(opening) {
  return `${rupees(opening?.paise ?? 0)} ${opening?.dc ?? "Dr"}`;
}

// Period locks --------------------------------------------------------------------
// company.locks = { books: {to, reason, at, requestId?} | null, gst: {...} | null }.
// A lock with `to: null` records an unlock and keeps its reason and time.

const LOCK_KINDS = ["books", "gst"];
const REQUEST_ID = /^[a-zA-Z0-9-]{16,80}$/;

export function locksOf(company) {
  return { books: company?.locks?.books ?? null, gst: company?.locks?.gst ?? null };
}

export function lockedTo(company, kind) {
  const lock = company?.locks?.[kind];
  return lock && isIsoDate(lock.to) ? lock.to : null;
}

export function lockMessage(kind, lock) {
  const reason = lock.reason ? ` (${lock.reason})` : "";
  return kind === "books"
    ? `The books are locked up to ${dmy(lock.to)}${reason}. Unlock them under Books settings to change this entry.`
    : `GST returns are locked up to ${dmy(lock.to)}${reason}. Unlock them under Books settings to change this entry.`;
}

/** Throw the lock message when `date` falls on or before the `kind` lock. */
export function assertPeriodOpen(company, kind, date) {
  const to = lockedTo(company, kind);
  if (to && isIsoDate(date) && date <= to) throw new Error(lockMessage(kind, company.locks[kind]));
}

const isGstDocument = (voucher) => Boolean(voucher.gst || voucher.gstRcm || voucher.gstItc);
// E-invoice transmission history (IRP preparation and acknowledgement) is not a change
// to the accounts or the return, so it stays open in locked periods.
function fingerprint(voucher) {
  const { gstExchange, ...rest } = voucher;
  return JSON.stringify(rest);
}

/**
 * Snapshot the locked part of the books before a change. `check(afterVouchers)` then
 * rejects any voucher or GST document created, altered or deleted on or before a lock.
 */
export function lockGuard(company, vouchers) {
  const booksTo = lockedTo(company, "books");
  const gstTo = lockedTo(company, "gst");
  if (!booksTo && !gstTo) return { check() {}, checkStock() {} };
  const books = new Map();
  const gst = new Map();
  for (const voucher of vouchers) {
    if (booksTo && voucher.date <= booksTo) books.set(voucher.id, fingerprint(voucher));
    if (gstTo && voucher.date <= gstTo && isGstDocument(voucher)) gst.set(voucher.id, fingerprint(voucher));
  }
  const journals = new Map();
  if (booksTo) for (const journal of company.stock?.journals || []) if (journal.date <= booksTo) journals.set(journal.id, JSON.stringify(journal));
  const fail = (kind) => { throw new Error(lockMessage(kind, company.locks[kind])); };
  return {
    check(after) {
      const seenBooks = new Set();
      const seenGst = new Set();
      for (const voucher of after) {
        const inBooks = booksTo && voucher.date <= booksTo;
        const inGst = gstTo && voucher.date <= gstTo && isGstDocument(voucher);
        if (!inBooks && !inGst) continue;
        const print = fingerprint(voucher);
        if (inBooks) { if (books.get(voucher.id) !== print) fail("books"); seenBooks.add(voucher.id); }
        if (inGst) { if (gst.get(voucher.id) !== print) fail("gst"); seenGst.add(voucher.id); }
      }
      for (const id of books.keys()) if (!seenBooks.has(id)) fail("books");
      for (const id of gst.keys()) if (!seenGst.has(id)) fail("gst");
    },
    checkStock(stock) {
      if (!booksTo) return;
      const seen = new Set();
      for (const journal of stock?.journals || []) {
        if (!(journal.date <= booksTo)) continue;
        if (journals.get(journal.id) !== JSON.stringify(journal)) fail("books");
        seen.add(journal.id);
      }
      for (const id of journals.keys()) if (!seen.has(id)) fail("books");
    },
  };
}

function checkedReason(value) {
  const reason = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!reason) throw new Error("Give a reason for this lock change");
  if (reason.length > 240) throw new Error("Keep the lock reason within 240 characters");
  return reason;
}

/** Validate a lock request against the current locks. Returns {locks, changes}. */
export function checkedLockRequest(company, input, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Choose the books or GST lock to change");
  const requestId = input.requestId;
  if (requestId !== undefined && (typeof requestId !== "string" || !REQUEST_ID.test(requestId))) throw new Error("Invalid lock save identifier");
  if (!LOCK_KINDS.some((kind) => input[kind] !== undefined)) throw new Error("Choose the books or GST lock to change");
  for (const key of Object.keys(input)) if (![...LOCK_KINDS, "requestId", "expected"].includes(key)) throw new Error(`Unknown lock setting ${key}`);
  const current = locksOf(company);
  const locks = { ...current };
  const changes = [];
  for (const kind of LOCK_KINDS) {
    const value = input[kind];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Choose the ${kind === "books" ? "books" : "GST"} lock date or unlock it`);
    const to = value.to ?? null;
    if (to !== null && !isIsoDate(to)) throw new Error(`Enter the ${kind === "books" ? "books" : "GST"} lock date`);
    const reason = checkedReason(value.reason);
    const previous = current[kind];
    if ((previous?.to ?? null) === to && previous?.reason === reason) continue;
    locks[kind] = { to, reason, at: now.toISOString(), ...(requestId ? { requestId } : {}) };
    changes.push({ kind, before: previous, after: locks[kind] });
  }
  return { locks, changes };
}

export function lockEntry({ kind, before, after }) {
  const label = kind === "books" ? "Books" : "GST returns";
  const summary = after.to
    ? `${label} locked up to ${dmy(after.to)}${before?.to ? ` (previously ${dmy(before.to)})` : ""}. Reason: ${after.reason}`
    : `${label} unlocked${before?.to ? ` (were locked up to ${dmy(before.to)})` : ""}. Reason: ${after.reason}`;
  return { action: after.to ? "lock" : "unlock", entity: "lock", id: kind, summary, before, after, requestId: after.requestId, reason: after.reason };
}

/** Validate saved locks on import. */
export function assertLocksShape(locks) {
  if (locks === undefined) return;
  if (!locks || typeof locks !== "object" || Array.isArray(locks)) throw new Error("Invalid period locks");
  for (const [kind, lock] of Object.entries(locks)) {
    if (!LOCK_KINDS.includes(kind)) throw new Error("Invalid period locks");
    if (lock === null) continue;
    if (typeof lock !== "object" || (lock.to !== null && !isIsoDate(lock.to)) || typeof lock.reason !== "string" || lock.reason.length > 240 || typeof lock.at !== "string") throw new Error("Invalid period locks");
  }
}

// Backups ---------------------------------------------------------------------------

/** The company's edit log as carried in a backup: {version, lines}. */
export async function auditBackup(dir) {
  const text = await readAuditText(dir);
  const lines = text.split("\n").filter((line) => line !== "");
  return { version: 1, lines };
}

/** Check the edit log carried by a backup. Returns its lines (possibly empty). */
export function checkedAuditBackup(value) {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.lines)) throw new Error("The edit log in this backup is not in a format Ledgercraft can restore");
  if (value.lines.length > 2_000_000 || value.lines.some((line) => typeof line !== "string" || !line || line.includes("\n") || line.length > MAX_LINE)) throw new Error("The edit log in this backup is not in a format Ledgercraft can restore");
  if (!value.lines.length) return [];
  const check = verifyAuditText(value.lines.join("\n") + "\n");
  if (!check.verified) throw new Error(`The edit log in this backup has been altered (line ${check.problems[0].line}: ${check.problems[0].reason}). Ledgercraft restores only an unbroken edit log`);
  return value.lines;
}

/** Write carried edit-log lines into a company folder that has no log yet (durable). */
export async function writeAuditLines(dir, lines) {
  const file = auditPath(dir);
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(lines.length ? lines.join("\n") + "\n" : "");
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(dir);
}
