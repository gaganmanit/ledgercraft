import { supplierDocumentDate } from "./gst-document-identity.js";
import { createHash } from "node:crypto";
import { fyStart, isIsoDate } from "./money.js";
import { gstinType, invoiceValuePaise, supplierDocDate } from "./gst.js";

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
export function reconcile2B(company, vouchers, registrationId, month, input) {
  const reg = company.gst?.registrations.find(r => r.id === registrationId);
  const { parts, partial } = statementParts(input, reg, month);
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
    for (const candidate of candidates) referenced.add(candidate.id);
    const book = candidates.length === 1 ? candidates[0] : undefined;
    const differences = book ? comparisonFields.filter(f => row[f] !== undefined && !sameValue(f, book[f], row[f])) : [];
    let status = "Matched";
    if (keys.some(id => counts.get(row.section + "|" + id) > 1)) status = "Duplicate";
    else if (candidates.length > 1) status = "Ambiguous";
    else if (!book) status = "Only in 2B";
    else if (differences.length) status = "Mismatch";
    results.push({ number: row.number, date: row.date, type: row.type, gstin: row.gstin, section: row.section, original: row.original, bookId: book?.id, ...(book && book.bookDate !== book.date ? { bookDate: book.bookDate } : {}),
      candidates: candidates.map(({id, number, date, type})=>({id, number, date, type})), differences, status, values: amountPairs(book, row),
      statementITC: row.available || "", reason: row.reason, imsStatus: row.imsStatus, bookValue: book?.total, portalValue: row.total });
  }
  for (const entries of books.values()) for (const book of entries) {
    if (referenced.has(book.id) || !book.bookDate.startsWith(month)) continue;
    results.push({ number: book.number, gstin: book.gstin, date: book.date, type: book.type, section: "", bookId: book.id, differences: [],
      status: entries.length > 1 ? "Duplicate" : partial ? "Absent from selected pages" : "Only in books", values: amountPairs(book), statementITC: "", reason: "", imsStatus: "", bookValue: book.total });
  }
  return { results, exceptions, month, gstin: reg.gstin, partial, pageCount: parts.length };
}
