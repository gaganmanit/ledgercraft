import { supplierDocumentDate } from "./gst-document-identity.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fyStart, isIsoDate } from "./money.js";
import { gstinType, invoiceValuePaise, supplierDocDate } from "./gst.js";
import { attachIms, rule37Watch } from "./gst-ims.js";

function readPaise(value, required = false) {
  if ((value === undefined || value === null) && !required) return 0;
  const text = String(value);
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) throw new Error("The statement contains an invalid amount");
  const [whole, fraction = ""] = text.replace("-", "").split(".");
  const amount = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2,"0"))) * (text.startsWith("-") ? -1 : 1);
  if (!Number.isSafeInteger(amount)) throw new Error("The statement amount is too large");
  return amount;
}
function documentDate(value) {
  if (typeof value !== "string") throw new Error("Missing GSTR-2B document date");
  const date = /^\d{2}-\d{2}-\d{4}$/.test(value) ? value.split("-").reverse().join("-") : value;
  if (!isIsoDate(date)) throw new Error("Invalid GSTR-2B document date");
  return date;
}
function key(gstin, type, number, date) {
  return [gstin,type,number.trim().toUpperCase(),fyStart(date)].join("|");
}
function append(index, id, row) {
  if (!index.has(id)) index.set(id, []);
  index.get(id).push(row);
}

const noteTypes = { C: "Credit Note", D: "Debit Note" };
const sections = new Set(["b2b", "b2ba", "cdnr", "cdnra"]);
const taxFields = { txval: "taxable", igst: "igst", cgst: "cgst", sgst: "sgst", cess: "cess" };
const comparisonFields = ["type", "number", "date", "taxable", "cgst", "sgst", "igst", "cess", "total", "placeOfSupply", "reverseCharge"];

function documentNumber(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("A supplier document has no number");
  return value.trim();
}
function statementDocument(section, gstin, d) {
  const invoice = section.startsWith("b2b");
  const amended = section.endsWith("a");
  const type = invoice ? "Purchase" : noteTypes[d.typ];
  if (!type) throw new Error("Unknown supplier note type");
  const number = documentNumber(invoice ? d.inum : d.ntnum), date = documentDate(d.dt);
  const row = { section, number, date, gstin, type, available: d.itcavl, reason: d.rsn || "", imsStatus: d.imsStatus || "",
    total: readPaise(d.val, true), placeOfSupply: d.pos, reverseCharge: d.rev };
  if (d.rev !== undefined && !["Y", "N"].includes(d.rev)) throw new Error("Unknown reverse-charge flag in GSTR-2B");
  if (amended) {
    const originalType = invoice ? "Purchase" : noteTypes[d.onttyp];
    if (!originalType) throw new Error("An amended note is missing its original type");
    row.original = { type: originalType, number: documentNumber(invoice ? d.oinum : d.ontnum), date: documentDate(invoice ? d.oidt : d.ontdt) };
  }
  const lines = Array.isArray(d.items) && d.items.length ? d.items : [d];
  for (const [source, field] of Object.entries(taxFields)) {
    const amount = lines.reduce((sum, l) => sum + BigInt(readPaise(l[source], source === "txval")), 0n);
    row[field] = Number(amount);
    if (!Number.isSafeInteger(row[field])) throw new Error("Statement total is too large");
  }
  return row;
}
function sameValue(field, a, b) {
  return field === "number" ? a.toUpperCase() === b.toUpperCase() : a === b;
}
function amountPairs(book, portal) {
  return Object.fromEntries(comparisonFields.map(field => [field, { book: book?.[field], portal: portal?.[field] }]));
}
function statementParts(input, reg, month) {
  const files = Array.isArray(input) ? input : [input];
  if (!files.length || files.length > 100) throw new Error("Choose between 1 and 100 GSTR-2B files");
  const parts = [], seen = new Set();
  let expectedCount = null, complete = false;
  for (const file of files) {
    let statement = file;
    for (let level = 0; level < 4 && !statement?.gstin && statement?.data; level++) statement = statement.data;
    if (!reg || statement?.gstin !== reg.gstin) throw new Error("The GSTR-2B GSTIN must match the selected registration");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || statement.rtnprd !== month.slice(5) + month.slice(0,4)) throw new Error("The statement period must match the selected month");
    if (!statement.docdata && statement.fc !== undefined) {
      if (expectedCount !== null) throw new Error("Choose one GSTR-2B file-count summary");
      expectedCount = Number(statement.fc);
      if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) throw new Error("Invalid GSTR-2B file count");
      continue;
    }
    if (!statement.docdata || typeof statement.docdata !== "object" || Array.isArray(statement.docdata)) throw new Error("Select a GSTR-2B document-details JSON file");
    const fingerprint = createHash("sha256").update(JSON.stringify(statement.docdata)).digest("hex");
    if (seen.has(fingerprint)) throw new Error("The same GSTR-2B document page was selected twice");
    seen.add(fingerprint);
    if (statement.itcsumm || statement.cpsumm) complete = true;
    parts.push(statement);
  }
  if (expectedCount !== null && parts.length !== expectedCount) throw new Error(`The summary expects ${expectedCount} document file(s). You selected ${parts.length}.`);
  if (!parts.length) throw new Error("Choose the statement’s document-details files");
  if (complete && files.length > 1) throw new Error("Choose one full statement, or the split document files and their file-count summary");
  return { parts, partial: !complete && expectedCount === null };
}
/*
 * Matching tolerance. GSTN and CBIC prescribe no rounding tolerance for GSTR-2B matching;
 * section 170 CGST Act rounds tax to the nearest rupee, and supplier and recipient systems
 * round line tax differently, so small differences are expected. Defaults: 100 paise on the
 * taxable value and on each tax head, the invoice value within the sum of those, and a
 * supplier document date within 3 days. Settings are saved in company.gst.reconciliation2B.
 */
export const DEFAULT_TOLERANCE = Object.freeze({ taxablePaise: 100, igstPaise: 100, cgstPaise: 100, sgstPaise: 100, cessPaise: 100 });
export const DEFAULT_DATE_TOLERANCE_DAYS = 3;
export const TOLERANCE_LIMITS = Object.freeze({ maxPaise: 10000, maxDays: 30 });
const toleranceHeads = ["taxable", "igst", "cgst", "sgst", "cess"];
function tolerancePaise(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > TOLERANCE_LIMITS.maxPaise) throw new Error("Use a matching tolerance from 0 to 10000 paise (Rs 100) for each amount");
  return value;
}
/** A number applies to every head; an object sets heads by name (taxable or taxablePaise, and so on). */
export function checkedTolerance(value, base = DEFAULT_TOLERANCE) {
  if (typeof value === "number") return Object.fromEntries(toleranceHeads.map(head => [head + "Paise", tolerancePaise(value)]));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Choose the matching tolerance for each amount");
  const result = { ...DEFAULT_TOLERANCE, ...base };
  for (const [field, amount] of Object.entries(value)) {
    const head = field.replace(/Paise$/, "");
    if (!toleranceHeads.includes(head)) throw new Error(`Unknown matching tolerance ${field}`);
    result[head + "Paise"] = tolerancePaise(amount);
  }
  return result;
}
export function checkedDateTolerance(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > TOLERANCE_LIMITS.maxDays) throw new Error("Use a supplier date tolerance from 0 to 30 days");
  return value;
}
/** Request options win over saved settings, which win over the defaults. */
export function reconciliationSettings(company, options = {}) {
  const saved = company.gst?.reconciliation2B;
  let tolerance = { ...DEFAULT_TOLERANCE }, dateToleranceDays = DEFAULT_DATE_TOLERANCE_DAYS, source = "default";
  if (saved !== undefined) {
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Invalid saved GSTR-2B matching settings");
    if (saved.tolerance !== undefined) tolerance = checkedTolerance(saved.tolerance);
    if (saved.dateToleranceDays !== undefined) dateToleranceDays = checkedDateTolerance(saved.dateToleranceDays);
    source = "saved";
  }
  if (options?.tolerancePaise !== undefined) { tolerance = checkedTolerance(options.tolerancePaise, tolerance); source = "request"; }
  if (options?.dateToleranceDays !== undefined) { dateToleranceDays = checkedDateTolerance(options.dateToleranceDays); source = "request"; }
  return { tolerance, dateToleranceDays, source };
}
export function toleranceView(company) {
  return { ...reconciliationSettings(company), defaults: { tolerance: { ...DEFAULT_TOLERANCE }, dateToleranceDays: DEFAULT_DATE_TOLERANCE_DAYS }, limits: { ...TOLERANCE_LIMITS } };
}
const rupeeText = paise => (paise / 100).toFixed(2);
/** Saving the tolerance: the caller applies `update`, writes and logs `entry` unless replayed. */
export function buildToleranceChange(company, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Choose the GSTR-2B matching tolerance");
  if (input.requestId !== undefined && (typeof input.requestId !== "string" || !/^[A-Za-z0-9-]{16,80}$/.test(input.requestId))) throw new Error("Invalid tolerance save identifier");
  if (!company.gst?.registrations?.length) throw new Error("Add a GST registration before setting the GSTR-2B matching tolerance");
  const current = reconciliationSettings(company);
  if (input.expected !== undefined && (!input.expected || !isDeepStrictEqual(input.expected.tolerance, current.tolerance) || input.expected.dateToleranceDays !== current.dateToleranceDays)) {
    throw new Error("The matching tolerance changed while you were editing. Reopen it to review the latest settings");
  }
  const tolerance = input.tolerance === undefined ? current.tolerance : checkedTolerance(input.tolerance, current.tolerance);
  const dateToleranceDays = input.dateToleranceDays === undefined ? current.dateToleranceDays : checkedDateTolerance(input.dateToleranceDays);
  const saved = company.gst?.reconciliation2B;
  if (saved && isDeepStrictEqual(tolerance, current.tolerance) && dateToleranceDays === current.dateToleranceDays) return { replayed: true, lockDates: [], result: { settings: toleranceView(company), replayed: true } };
  const next = { version: 1, tolerance, dateToleranceDays, updatedAt: new Date().toISOString(), ...(input.requestId ? { requestId: input.requestId } : {}) };
  return {
    replayed: false, lockDates: [],
    update(target) { target.gst.reconciliation2B = structuredClone(next); },
    entry: { action: saved ? "alter" : "create", entity: "gst-master", id: "reconciliation-2b-tolerance",
      summary: `GSTR-2B matching tolerance set to Rs ${rupeeText(tolerance.taxablePaise)} on taxable value, Rs ${rupeeText(tolerance.igstPaise)} IGST, Rs ${rupeeText(tolerance.cgstPaise)} CGST, Rs ${rupeeText(tolerance.sgstPaise)} SGST, Rs ${rupeeText(tolerance.cessPaise)} cess and ${dateToleranceDays} day(s) on supplier dates.`,
      before: { tolerance: current.tolerance, dateToleranceDays: current.dateToleranceDays }, after: { tolerance, dateToleranceDays }, requestId: input.requestId },
    get result() { return { settings: { ...toleranceView({ gst: { reconciliation2B: next } }) }, replayed: false }; },
  };
}
const DAY_MS = 86400000;
const dayDifference = (from, to) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / DAY_MS);
const shiftDays = (iso, days) => new Date(Date.parse(iso + "T00:00:00Z") + days * DAY_MS).toISOString().slice(0, 10);
const amountFields = ["taxable", "igst", "cgst", "sgst", "cess"];
function tolerated(field, book, row, settings) {
  if (amountFields.includes(field)) return Math.abs(row[field] - book[field]) <= settings.tolerance[field + "Paise"];
  if (field === "total") return Math.abs(row.total - book.total) <= amountFields.reduce((sum, head) => sum + settings.tolerance[head + "Paise"], 0);
  if (field === "date") return Math.abs(dayDifference(book.date, row.date)) <= settings.dateToleranceDays;
  return false;
}
const MATCH_CODES = { "Matched": "matched", "Matched within tolerance": "matched-within-tolerance", "Mismatch": "mismatch", "Duplicate": "duplicate", "Ambiguous": "ambiguous",
  "Only in 2B": "only-in-2b", "Only in books": "only-in-books", "Absent from selected pages": "absent-from-selected-pages" };
function safeRule37(company, vouchers, asOf, registrationId) {
  try { return rule37Watch(company, vouchers, asOf, { registrationId }); }
  catch (error) { return { asOf, rows: [], approaching: [], totals: null, issues: [{ message: `The rule 37 watch could not be prepared: ${error.message}` }] }; }
}

export function reconcile2B(company, vouchers, registrationId, month, input, options = {}) {
  const reg = company.gst?.registrations.find(r => r.id === registrationId);
  const { parts, partial } = statementParts(input, reg, month);
  const settings = reconciliationSettings(company, options);
  const books = new Map(), portal = [], counts = new Map(), exceptions = [];
  for (const { gst: doc } of vouchers) {
    if (!doc || doc.registrationId !== reg.id || doc.direction !== "purchase" || !doc.party.gstin || gstinType(doc.party.gstin) === "oidar") continue;
    // GSTR-2B carries the supplier's document date, which may precede the book date.
    const supplierDate = supplierDocDate(doc);
    if (supplierDate.slice(0,7) > month) continue;
    const id = key(doc.party.gstin, doc.type, doc.supplierInvoiceNumber, supplierDate), t = doc.totals;
    append(books, id, { id: doc.id, number: doc.supplierInvoiceNumber, gstin: doc.party.gstin, type: doc.type, date: supplierDate, bookDate: doc.date,
      taxable: t.taxablePaise, igst: t.igstPaise, cgst: t.cgstPaise, sgst: t.sgstPaise+t.utgstPaise, cess: t.cessPaise,
      total: invoiceValuePaise(doc), placeOfSupply: doc.placeOfSupply, reverseCharge: doc.reverseCharge ? "Y" : "N" });
  }
  for (const statement of parts) for (const [section, groups] of Object.entries(statement.docdata)) {
    if (!Array.isArray(groups)) { if (groups != null) exceptions.push(section + " needs separate review"); continue; }
    if (!sections.has(section)) {
      if (groups.length) exceptions.push(section + " contains " + groups.length + " group(s) for separate review");
      continue;
    }
    for (const group of groups) {
      const docs = section.startsWith("b2b") ? group.inv : group.nt;
      if (!Array.isArray(docs) || !group.ctin) throw new Error("A statement group is missing supplier or document details");
      for (const d of docs) {
        const row = statementDocument(section, group.ctin, d);
        const identities = [row.original, row].filter(Boolean).map(identity => key(row.gstin, identity.type, identity.number, identity.date));
        const keys = [...new Set(identities)];
        for (const id of keys) counts.set(section + "|" + id, (counts.get(section + "|" + id) || 0) + 1);
        portal.push({ row, keys });
      }
    }
  }
  if (parts.some(statement=>statement.docRejdata && Object.values(statement.docRejdata).some(s=>Array.isArray(s) && s.length))) exceptions.push("Rejected IMS documents are present in this statement and need separate review.");
  const results = [], referenced = new Set();
  for (const {row, keys} of portal) {
    const candidates = keys.flatMap(id => books.get(id) || []);
    // A supplier date within the date tolerance can fall in the other financial year (31 March
    // and 1 April); those books are candidates only when their date is within the tolerance.
    if (settings.dateToleranceDays) for (const identity of [row.original, row].filter(Boolean)) {
      const nearby = new Set([-settings.dateToleranceDays, settings.dateToleranceDays].map(days => key(row.gstin, identity.type, identity.number, shiftDays(identity.date, days))));
      for (const id of nearby) if (!keys.includes(id)) for (const book of books.get(id) || []) {
        if (Math.abs(dayDifference(book.date, identity.date)) <= settings.dateToleranceDays && !candidates.includes(book)) candidates.push(book);
      }
    }
    for (const candidate of candidates) referenced.add(candidate.id);
    const book = candidates.length === 1 ? candidates[0] : undefined;
    const differences = book ? comparisonFields.filter(f => row[f] !== undefined && !sameValue(f, book[f], row[f])) : [];
    const within = book ? differences.filter(f => tolerated(f, book, row, settings)) : [];
    let status = "Matched";
    if (keys.some(id => counts.get(row.section + "|" + id) > 1)) status = "Duplicate";
    else if (candidates.length > 1) status = "Ambiguous";
    else if (!book) status = "Only in 2B";
    else if (differences.some(f => !within.includes(f))) status = "Mismatch";
    else if (within.length) status = "Matched within tolerance";
    const notes = [];
    if (within.includes("date")) notes.push("date-differs");
    if (within.some(f => f !== "date")) notes.push("amount-within-tolerance");
    results.push({ number: row.number, date: row.date, type: row.type, gstin: row.gstin, section: row.section, original: row.original, bookId: book?.id, ...(book && book.bookDate !== book.date ? { bookDate: book.bookDate } : {}),
      candidates: candidates.map(({id, number, date, type})=>({id, number, date, type})), differences, status, values: amountPairs(book, row),
      statementITC: row.available || "", reason: row.reason, imsStatus: row.imsStatus, bookValue: book?.total, portalValue: row.total,
      matchCode: MATCH_CODES[status], tolerated: within, notes,
      ...(book ? { amountDifferences: Object.fromEntries([...amountFields, "total"].map(f => [f, row[f] - book[f]])) } : {}),
      ...(book && book.date !== row.date ? { dateDifferenceDays: dayDifference(book.date, row.date) } : {}) });
  }
  for (const entries of books.values()) for (const book of entries) {
    if (referenced.has(book.id) || !book.bookDate.startsWith(month)) continue;
    const status = entries.length > 1 ? "Duplicate" : partial ? "Absent from selected pages" : "Only in books";
    results.push({ number: book.number, gstin: book.gstin, date: book.date, type: book.type, section: "", bookId: book.id, differences: [],
      status, values: amountPairs(book), statementITC: "", reason: "", imsStatus: "", bookValue: book.total, matchCode: MATCH_CODES[status], tolerated: [], notes: [] });
  }
  const matchCounts = {};
  for (const row of results) matchCounts[row.matchCode] = (matchCounts[row.matchCode] || 0) + 1;
  const periodEnd = month + "-" + String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate()).padStart(2, "0");
  const report = { results, exceptions, month, gstin: reg.gstin, partial, pageCount: parts.length, tolerance: settings, matchCounts };
  attachIms(report, company, reg.id);
  // Internal replays (evidence checks, restore) pass rule37: false to skip the watch.
  if (options?.rule37 !== false) report.rule37 = safeRule37(company, vouchers, periodEnd, reg.id);
  return report;
}
