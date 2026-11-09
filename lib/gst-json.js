// GSTR-1 upload JSON in the GSTN Returns Offline Tool / portal format.
//
// The JSON is built from the same return working sheets as the Excel export
// (returnWorkbook), so every section carries exactly the documents, rates and
// taxable values of the workbook for the month. The sheets hold only taxable
// value and cess per rate; the GSTN JSON also needs the IGST, CGST and SGST
// amounts. Those come from the booked lines (or the declared amendment
// snapshots) and are reconciled back to the sheet row before use. When only a
// workbook is supplied, the tax heads are derived from rate and taxable value
// the way the Offline Tool computes them for an imported Excel file.
import { readFileSync } from "node:fs";
import { returnWorkbook, columns } from "./gst-returns.js";
import { activeOutwardAmendments } from "./gst-outward-amendments.js";
import { isLargeB2c } from "./gst.js";

const masters = JSON.parse(readFileSync(new URL("./resources/gstr1-masters.json", import.meta.url), "utf8"));
/** Version string the GSTN Returns Offline Tool writes into its generated JSON. */
export const GSTR1_JSON_VERSION = "GST3.2.4";
/** Return period from which Table 12 is split into B2B and B2C tabs (GSTN advisory, Phase-3). */
export const HSN_SPLIT_FROM = "2025-05";
const INVOICE_TYPES = { "Regular B2B": "R", "SEZ supplies with payment": "SEWP", "SEZ supplies without payment": "SEWOP", "Deemed Exp": "DE" };
const ZERO_TAX_TYPES = new Set(["SEWOP"]);
const NIL_TYPES = {
  "Inter-State supplies to registered persons": "INTRB2B", "Intra-State supplies to registered persons": "INTRAB2B",
  "Inter-State supplies to unregistered persons": "INTRB2C", "Intra-State supplies to unregistered persons": "INTRAB2C",
};
const DOCUMENT_CODES = new Map(masters.documents.map((name, index) => [name, index + 1]));
const MONTHS = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
const HEADS = ["taxablePaise", "igstPaise", "cgstPaise", "sgstPaise", "cessPaise"];
export const GSTR1_JSON_SECTIONS = ["b2b", "b2ba", "b2cl", "b2cla", "b2cs", "cdnr", "cdnra", "cdnur", "cdnura", "exp", "expa"];
const zero = () => Object.fromEntries(HEADS.map(key => [key, 0]));

function exact(n) {
  if (!Number.isSafeInteger(n)) throw new Error("GSTR-1 JSON amounts exceed the exact paise limit");
  return n;
}
function add(target, source, sign = 1) {
  for (const key of HEADS) target[key] = exact(target[key] + sign * (source[key] || 0));
  return target;
}
/** Worksheet rupee text such as "-1180.50" to integer paise. */
function paise(value) {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? "").trim() || "0");
  if (!match) throw new Error(`A GSTR-1 worksheet amount is not exact rupees: ${value}`);
  const n = Number(match[2]) * 100 + Number((match[3] || "").padEnd(2, "0"));
  return exact(match[1] ? -n : n);
}
/** Integer paise to rupees as a JSON number with at most two decimals. */
function rupees(value) {
  exact(value);
  const abs = Math.abs(value);
  return Number((value < 0 ? "-" : "") + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0"));
}
function bpsOf(rate) {
  const bps = Math.round(Number(rate) * 100);
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10000) throw new Error(`A GSTR-1 worksheet rate is invalid: ${rate}`);
  return bps;
}
const percent = bps => bps / 100;
/** Worksheet date "01-Jun-2026" to ISO. */
function isoDate(text) {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(String(text));
  if (!match || !MONTHS[match[2].toLowerCase()]) throw new Error(`A GSTR-1 worksheet date is invalid: ${text}`);
  return `${match[3]}-${MONTHS[match[2].toLowerCase()]}-${match[1]}`;
}
/** ISO date to the GSTN JSON DD-MM-YYYY form. */
const gstnDate = iso => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const stateCode = text => {
  const code = String(text ?? "").slice(0, 2);
  if (!/^\d{2}$/.test(code)) throw new Error(`A GSTR-1 place of supply is invalid: ${text}`);
  return code;
};
function invoiceType(text) {
  const code = INVOICE_TYPES[text];
  if (!code) throw new Error(`The invoice type ${text} has no GSTR-1 JSON code`);
  return code;
}
function rowReader(section) {
  const fields = columns[section];
  return (row, label) => {
    const index = fields.indexOf(label);
    if (index < 0) throw new Error(`The ${section} worksheet has no ${label} column`);
    return row[index];
  };
}
export function returnPeriod(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) throw new Error("Choose a valid return month");
  return month.slice(5, 7) + month.slice(0, 4);
}
export function gstr1JsonFileName(gstin, month) { return `GSTR1_${gstin}_${returnPeriod(month)}.json`; }

// ---------------------------------------------------------------- tax sources
function rateHeads(rows) {
  const rates = new Map();
  for (const row of rows) {
    const target = rates.get(row.gstRateBps) || zero();
    add(target, { taxablePaise: row.taxablePaise, igstPaise: row.igstPaise, cgstPaise: row.cgstPaise, sgstPaise: (row.sgstPaise || 0) + (row.utgstPaise || 0), cessPaise: row.cessPaise });
    rates.set(row.gstRateBps, target);
  }
  return rates;
}
// Only taxable and zero-rated lines form rate rows; nil, exempt and non-GST lines go to Table 8.
const reportedLines = doc => doc.items.filter(line => line.supplyStatus === "taxable" || line.supplyStatus === "zero-rated");
const docKind = doc => doc.type === "Credit Note" ? "C" : doc.type === "Debit Note" ? "D" : "inv";
const key = (kind, number, date) => JSON.stringify([kind, number, date]);

function taxSources(book, context) {
  // Declared prior reports are keyed by their reported section: several may share a number.
  const documents = new Map(), comparators = new Map(), amended = new Map();
  for (const record of book.amendments?.comparators || []) {
    const snapshot = record.originalReported;
    comparators.set(key(snapshot.section, snapshot.number, snapshot.date), rateHeads(snapshot.rates));
  }
  for (const record of (book.amendments?.rows || []).filter(row => !row.heldReason)) {
    const snapshot = record.revised;
    amended.set(key(record.section, snapshot.number, snapshot.date), rateHeads(snapshot.rates));
  }
  let b2cs = null;
  if (context) {
    const { company, vouchers } = context, registrationId = book.registration.id, month = book.month;
    const all = new Map(vouchers.filter(v => v.gst).map(v => [v.gst.id, v.gst]));
    const amendedIds = new Set(activeOutwardAmendments(company, vouchers).filter(record => record.registrationId === registrationId).map(record => record.invoiceId));
    const held = new Set(book.creditReviews.filter(row => !row.eligible).map(row => row.id));
    const docs = vouchers.filter(v => v.gst?.registrationId === registrationId && v.date.startsWith(month) && v.gst.direction === "sales").map(v => v.gst);
    b2cs = new Map();
    for (const doc of docs) {
      documents.set(key(docKind(doc), doc.number, doc.date), rateHeads(reportedLines(doc)));
      if (amendedIds.has(doc.id) || held.has(doc.id) || doc.party.gstin || doc.supplyCategory !== "domestic") continue;
      const original = docKind(doc) === "inv" ? doc : all.get(doc.originalInvoiceId);
      if (!original || isLargeB2c(original)) continue;
      const sign = doc.type === "Credit Note" ? -1 : 1;
      for (const [bps, amount] of rateHeads(reportedLines(doc))) {
        const group = JSON.stringify([doc.placeOfSupply, bps]);
        b2cs.set(group, add(b2cs.get(group) || zero(), amount, sign));
      }
    }
  }
  return { documents: context ? documents : null, comparators, amended, b2cs };
}

// Offline Tool derivation for an imported workbook row: tax = taxable x rate,
// rounded half away from zero to the paisa, each of CGST and SGST at half rate.
function derive(taxable, bps, inter, zeroTax) {
  const share = divisor => {
    const product = BigInt(Math.abs(taxable)) * BigInt(bps), d = BigInt(divisor);
    const rounded = Number((product * 2n + d) / (2n * d));
    return taxable < 0 ? -rounded : rounded;
  };
  if (zeroTax) return { igstPaise: 0, cgstPaise: 0, sgstPaise: 0 };
  return inter ? { igstPaise: share(10000), cgstPaise: 0, sgstPaise: 0 } : { igstPaise: 0, cgstPaise: share(20000), sgstPaise: share(20000) };
}

function resolveHeads({ source, label, bps, taxable, cess, inter, zeroTax }) {
  let heads;
  if (source) {
    const booked = source.get(bps);
    if (!booked || booked.taxablePaise !== taxable || booked.cessPaise !== cess) {
      throw new Error(`${label}: the booked ${percent(bps)}% amounts do not reconcile with the GSTR-1 worksheet row; refresh the return before exporting JSON`);
    }
    heads = booked;
    if (inter ? heads.cgstPaise || heads.sgstPaise : heads.igstPaise) {
      throw new Error(`${label}: the booked tax heads do not match an ${inter ? "inter" : "intra"}-State supply at ${percent(bps)}%; correct the place of supply or tax heads before exporting JSON`);
    }
  } else heads = derive(taxable, bps, inter, zeroTax);
  return { taxablePaise: taxable, igstPaise: inter ? heads.igstPaise : 0, cgstPaise: inter ? 0 : heads.cgstPaise, sgstPaise: inter ? 0 : heads.sgstPaise, cessPaise: cess };
}

// ------------------------------------------------------------------ builders
function itemDetail(bps, amounts, inter) {
  const detail = { rt: percent(bps), txval: rupees(amounts.taxablePaise) };
  if (inter) detail.iamt = rupees(amounts.igstPaise);
  else { detail.camt = rupees(amounts.cgstPaise); detail.samt = rupees(amounts.sgstPaise); }
  detail.csamt = rupees(amounts.cessPaise);
  return detail;
}
function totalsSlot() { return { documents: 0, items: 0, invoiceValuePaise: 0, ...zero() }; }

/** Groups worksheet rows by document identity and renders the GSTN shape. */
function documentSection({ rows, identity, group, render, heads, totals }) {
  const parents = new Map(), output = [], documents = new Map();
  for (const row of rows) {
    const id = identity(row);
    let doc = documents.get(id.key);
    if (!doc) {
      doc = { ...id, items: [] };
      documents.set(id.key, doc);
      totals.documents++;
      totals.invoiceValuePaise = exact(totals.invoiceValuePaise + id.valuePaise);
      const parentKey = group ? group.key(row) : null;
      if (group) {
        let parent = parents.get(parentKey);
        if (!parent) { parent = group.create(row); parents.set(parentKey, parent); output.push(parent); }
        parent[group.list].push(doc);
      } else output.push(doc);
    }
    const amounts = heads(row, doc);
    add(totals, amounts);
    totals.items++;
    doc.items.push({ bps: amounts.bps, amounts, inter: doc.inter });
  }
  // Swap the working documents for their rendered JSON objects.
  const rendered = new Map([...documents.values()].map(doc => [doc, render(doc, doc.items)]));
  if (group) for (const parent of output) parent[group.list] = parent[group.list].map(doc => rendered.get(doc));
  return group ? output : output.map(doc => rendered.get(doc));
}
const numbered = items => items.map((item, index) => ({ num: index + 1, itm_det: itemDetail(item.bps, item.amounts, item.inter) }));
const exportItems = items => items.map(item => ({ txval: rupees(item.amounts.taxablePaise), rt: percent(item.bps), iamt: rupees(item.amounts.igstPaise), csamt: rupees(item.amounts.cessPaise) }));
function shippingFields(port, number, date, problems, label) {
  const fields = {};
  if (port) fields.sbpcode = String(port);
  if (number) {
    fields.sbnum = String(number);
    // GSTN schema: sbnum is 3 to 7 digits. Older books may hold a reference typed before this rule.
    if (!/^\d{3,7}$/.test(fields.sbnum)) problems.push({ number: label, reason: `Shipping bill number ${fields.sbnum} must be 3 to 7 digits for the GSTN upload` });
  }
  if (date) fields.sbdt = gstnDate(isoDate(date));
  return fields;
}

function buildSections(book, sources, home) {
  const problems = [];
  const totals = Object.fromEntries(GSTR1_JSON_SECTIONS.map(name => [name, totalsSlot()]));
  const sections = {};
  // With books, a missing source is an error; with a workbook alone, the heads are derived.
  const lookupRegular = (section, kind, number, iso) => sources.comparators.get(key(section, number, iso)) ||
    (sources.documents ? sources.documents.get(key(kind, number, iso)) || new Map() : null);
  const lookupAmended = (section, number, iso) => sources.amended.get(key(section, number, iso)) || new Map();
  const heads = (lookup, label) => (row, doc, read) => {
    const bps = bpsOf(read(row, "Rate"));
    const amounts = resolveHeads({ source: lookup, label, bps, taxable: paise(read(row, "Taxable Value")), cess: paise(read(row, "Cess Amount")), inter: doc.inter, zeroTax: doc.zeroTax });
    return { ...amounts, bps };
  };
  const pick = (section, worksheet, options) => {
    const read = rowReader(worksheet);
    const rows = book.sheets[worksheet] || [];
    const result = documentSection({ rows, totals: totals[section],
      identity: row => options.identity(row, read),
      group: options.group && { list: options.group.list, key: row => options.group.key(row, read), create: row => options.group.create(row, read) },
      render: options.render,
      heads: (row, doc) => heads(options.lookup(doc), doc.label)(row, doc, read) });
    if (result.length) sections[section] = result;
  };
  // B2B, SEZ and deemed exports (Table 4).
  pick("b2b", "b2b,sez,de", {
    identity: (row, read) => {
      const iso = isoDate(read(row, "Invoice date")), number = String(read(row, "Invoice Number")), type = invoiceType(read(row, "Invoice Type"));
      const pos = stateCode(read(row, "Place Of Supply"));
      return { key: JSON.stringify([read(row, "GSTIN/UIN of Recipient"), number, iso]), number, iso, label: number, valuePaise: paise(read(row, "Invoice Value")),
        pos, rchrg: read(row, "Reverse Charge") === "Y" ? "Y" : "N", type, inter: type !== "R" || pos !== home, zeroTax: ZERO_TAX_TYPES.has(type) };
    },
    lookup: doc => lookupRegular("b2b", "inv", doc.number, doc.iso),
    group: { list: "inv", key: (row, read) => read(row, "GSTIN/UIN of Recipient"), create: (row, read) => ({ ctin: read(row, "GSTIN/UIN of Recipient"), inv: [] }) },
    render: (doc, items) => ({ inum: doc.number, idt: gstnDate(doc.iso), val: rupees(doc.valuePaise), pos: doc.pos, rchrg: doc.rchrg, inv_typ: doc.type, itms: numbered(items) }),
  });
  pick("b2ba", "b2ba", {
    identity: (row, read) => {
      const iso = isoDate(read(row, "Revised Invoice date")), number = String(read(row, "Revised Invoice Number")), type = invoiceType(read(row, "Invoice Type"));
      const pos = stateCode(read(row, "Place Of Supply"));
      return { key: JSON.stringify([read(row, "GSTIN/UIN of Recipient"), read(row, "Original Invoice Number"), number, iso]), number, iso, label: number,
        original: String(read(row, "Original Invoice Number")), originalIso: isoDate(read(row, "Original Invoice date")), valuePaise: paise(read(row, "Invoice Value")),
        pos, rchrg: read(row, "Reverse Charge") === "Y" ? "Y" : "N", type, inter: type !== "R" || pos !== home, zeroTax: ZERO_TAX_TYPES.has(type) };
    },
    lookup: doc => lookupAmended("b2ba", doc.number, doc.iso),
    group: { list: "inv", key: (row, read) => read(row, "GSTIN/UIN of Recipient"), create: (row, read) => ({ ctin: read(row, "GSTIN/UIN of Recipient"), inv: [] }) },
    render: (doc, items) => ({ oinum: doc.original, oidt: gstnDate(doc.originalIso), inum: doc.number, idt: gstnDate(doc.iso), val: rupees(doc.valuePaise), pos: doc.pos, rchrg: doc.rchrg, inv_typ: doc.type, itms: numbered(items) }),
  });

  // B2C large (Table 5): always inter-State.
  pick("b2cl", "b2cl", {
    identity: (row, read) => {
      const iso = isoDate(read(row, "Invoice date")), number = String(read(row, "Invoice Number"));
      return { key: JSON.stringify([number, iso]), number, iso, label: number, valuePaise: paise(read(row, "Invoice Value")), pos: stateCode(read(row, "Place Of Supply")), inter: true };
    },
    lookup: doc => lookupRegular("b2cl", "inv", doc.number, doc.iso),
    group: { list: "inv", key: (row, read) => stateCode(read(row, "Place Of Supply")), create: (row, read) => ({ pos: stateCode(read(row, "Place Of Supply")), inv: [] }) },
    render: (doc, items) => ({ inum: doc.number, idt: gstnDate(doc.iso), val: rupees(doc.valuePaise), itms: numbered(items) }),
  });
  pick("b2cla", "b2cla", {
    identity: (row, read) => {
      const iso = isoDate(read(row, "Revised Invoice date")), number = String(read(row, "Revised Invoice Number"));
      return { key: JSON.stringify([read(row, "Original Invoice Number"), number, iso]), number, iso, label: number, original: String(read(row, "Original Invoice Number")),
        originalIso: isoDate(read(row, "Original Invoice date")), valuePaise: paise(read(row, "Invoice Value")), inter: true };
    },
    lookup: doc => lookupAmended("b2cla", doc.number, doc.iso),
    group: { list: "inv", key: (row, read) => stateCode(read(row, "Original Place Of Supply")), create: (row, read) => ({ pos: stateCode(read(row, "Original Place Of Supply")), inv: [] }) },
    render: (doc, items) => ({ oinum: doc.original, oidt: gstnDate(doc.originalIso), inum: doc.number, idt: gstnDate(doc.iso), val: rupees(doc.valuePaise), itms: numbered(items) }),
  });

  // Registered credit and debit notes (Table 9B).
  pick("cdnr", "cdnr", {
    identity: (row, read) => {
      const iso = isoDate(read(row, "Note Date")), number = String(read(row, "Note Number")), type = invoiceType(read(row, "Note Supply Type"));
      const pos = stateCode(read(row, "Place Of Supply")), ntty = read(row, "Note Type");
      return { key: JSON.stringify([read(row, "GSTIN/UIN of Recipient"), ntty, number, iso]), number, iso, ntty, label: number, valuePaise: paise(read(row, "Note Value")),
        pos, rchrg: read(row, "Reverse Charge") === "Y" ? "Y" : "N", type, inter: type !== "R" || pos !== home, zeroTax: ZERO_TAX_TYPES.has(type) };
    },
    lookup: doc => lookupRegular("cdnr", doc.ntty, doc.number, doc.iso),
    group: { list: "nt", key: (row, read) => read(row, "GSTIN/UIN of Recipient"), create: (row, read) => ({ ctin: read(row, "GSTIN/UIN of Recipient"), nt: [] }) },
    render: (doc, items) => ({ ntty: doc.ntty, nt_num: doc.number, nt_dt: gstnDate(doc.iso), val: rupees(doc.valuePaise), pos: doc.pos, rchrg: doc.rchrg, inv_typ: doc.type, itms: numbered(items) }),
  });
  pick("cdnra", "cdnra", {
    identity: (row, read) => {
      const iso = isoDate(read(row, "Revised Note Date")), number = String(read(row, "Revised Note Number")), type = invoiceType(read(row, "Note Supply Type"));
      const pos = stateCode(read(row, "Place Of Supply")), ntty = read(row, "Note Type");
      return { key: JSON.stringify([read(row, "GSTIN/UIN of Recipient"), read(row, "Original Note Number"), ntty, number, iso]), number, iso, ntty, label: number,
        original: String(read(row, "Original Note Number")), originalIso: isoDate(read(row, "Original Note Date")), valuePaise: paise(read(row, "Note Value")),
        pos, rchrg: read(row, "Reverse Charge") === "Y" ? "Y" : "N", type, inter: type !== "R" || pos !== home, zeroTax: ZERO_TAX_TYPES.has(type) };
    },
    lookup: doc => lookupAmended("cdnra", doc.number, doc.iso),
    group: { list: "nt", key: (row, read) => read(row, "GSTIN/UIN of Recipient"), create: (row, read) => ({ ctin: read(row, "GSTIN/UIN of Recipient"), nt: [] }) },
    render: (doc, items) => ({ ntty: doc.ntty, ont_num: doc.original, ont_dt: gstnDate(doc.originalIso), nt_num: doc.number, nt_dt: gstnDate(doc.iso), val: rupees(doc.valuePaise), pos: doc.pos, rchrg: doc.rchrg, inv_typ: doc.type, itms: numbered(items) }),
  });

  // Unregistered notes (Table 9B): B2CL or export notes, always inter-State.
  const urFields = (doc) => doc.typ === "B2CL" ? { pos: doc.pos } : {};
  pick("cdnur", "cdnur", {
    identity: (row, read) => {
      const iso = isoDate(read(row, "Note Date")), number = String(read(row, "Note Number")), typ = read(row, "UR Type"), ntty = read(row, "Note Type");
      if (!masters.urTypes.includes(typ)) throw new Error(`${number}: the unregistered note type ${typ} has no GSTR-1 JSON code`);
      return { key: JSON.stringify([typ, ntty, number, iso]), number, iso, ntty, typ, label: number, valuePaise: paise(read(row, "Note Value")), pos: stateCode(read(row, "Place Of Supply")), inter: true, zeroTax: typ === "EXPWOP" };
    },
    lookup: doc => lookupRegular("cdnur", doc.ntty, doc.number, doc.iso),
    render: (doc, items) => ({ typ: doc.typ, ntty: doc.ntty, nt_num: doc.number, nt_dt: gstnDate(doc.iso), val: rupees(doc.valuePaise), ...urFields(doc), itms: numbered(items) }),
  });
  pick("cdnura", "cdnura", {
    identity: (row, read) => {
      const iso = isoDate(read(row, "Revised Note Date")), number = String(read(row, "Revised Note Number")), typ = read(row, "UR Type"), ntty = read(row, "Note Type");
      if (!masters.urTypes.includes(typ)) throw new Error(`${number}: the unregistered note type ${typ} has no GSTR-1 JSON code`);
      return { key: JSON.stringify([typ, read(row, "Original Note Number"), ntty, number, iso]), number, iso, ntty, typ, label: number, original: String(read(row, "Original Note Number")),
        originalIso: isoDate(read(row, "Original Note Date")), valuePaise: paise(read(row, "Note Value")), pos: stateCode(read(row, "Place Of Supply")), inter: true, zeroTax: typ === "EXPWOP" };
    },
    lookup: doc => lookupAmended("cdnura", doc.number, doc.iso),
    render: (doc, items) => ({ typ: doc.typ, ntty: doc.ntty, ont_num: doc.original, ont_dt: gstnDate(doc.originalIso), nt_num: doc.number, nt_dt: gstnDate(doc.iso), val: rupees(doc.valuePaise), ...urFields(doc), itms: numbered(items) }),
  });

  // Exports (Table 6A): IGST only; without payment carries zero tax.
  const exportGroup = { list: "inv", key: (row, read) => read(row, "Export Type"), create: (row, read) => {
    const type = read(row, "Export Type");
    if (type !== "WPAY" && type !== "WOPAY") throw new Error(`The export type ${type} has no GSTR-1 JSON code`);
    return { exp_typ: type, inv: [] };
  } };
  pick("exp", "exp", {
    identity: (row, read) => {
      const iso = isoDate(read(row, "Invoice date")), number = String(read(row, "Invoice Number"));
      return { key: JSON.stringify([read(row, "Export Type"), number, iso]), number, iso, label: number, valuePaise: paise(read(row, "Invoice Value")), inter: true, zeroTax: read(row, "Export Type") === "WOPAY",
        shipping: shippingFields(read(row, "Port Code"), read(row, "Shipping Bill Number"), read(row, "Shipping Bill Date"), problems, number) };
    },
    lookup: doc => lookupRegular("exp", "inv", doc.number, doc.iso),
    group: exportGroup,
    render: (doc, items) => ({ inum: doc.number, idt: gstnDate(doc.iso), val: rupees(doc.valuePaise), ...doc.shipping, itms: exportItems(items) }),
  });
  pick("expa", "expa", {
    identity: (row, read) => {
      const iso = isoDate(read(row, "Revised Invoice date")), number = String(read(row, "Revised Invoice Number"));
      return { key: JSON.stringify([read(row, "Export Type"), read(row, "Original Invoice Number"), number, iso]), number, iso, label: number, original: String(read(row, "Original Invoice Number")),
        originalIso: isoDate(read(row, "Original Invoice date")), valuePaise: paise(read(row, "Invoice Value")), inter: true, zeroTax: read(row, "Export Type") === "WOPAY",
        shipping: shippingFields(read(row, "Port Code"), read(row, "Shipping Bill Number"), read(row, "Shipping Bill Date"), problems, number) };
    },
    lookup: doc => lookupAmended("expa", doc.number, doc.iso),
    group: exportGroup,
    render: (doc, items) => ({ oinum: doc.original, oidt: gstnDate(doc.originalIso), inum: doc.number, idt: gstnDate(doc.iso), val: rupees(doc.valuePaise), ...doc.shipping, itms: exportItems(items) }),
  });

  // B2C small (Table 7): one row per place of supply and rate.
  const readB2cs = rowReader("b2cs");
  const b2cs = [];
  for (const row of book.sheets.b2cs || []) {
    const pos = stateCode(readB2cs(row, "Place Of Supply")), bps = bpsOf(readB2cs(row, "Rate")), inter = pos !== home;
    const booked = sources.b2cs?.get(JSON.stringify([pos, bps]));
    const amounts = resolveHeads({ source: sources.b2cs ? new Map(booked ? [[bps, booked]] : []) : null,
      label: `B2CS ${pos} at ${percent(bps)}%`, bps, taxable: paise(readB2cs(row, "Taxable Value")), cess: paise(readB2cs(row, "Cess Amount")), inter, zeroTax: false });
    add(totals.b2cs, amounts); totals.b2cs.documents++; totals.b2cs.items++;
    const entry = { sply_ty: inter ? "INTER" : "INTRA", pos, typ: readB2cs(row, "Type") || "OE", rt: percent(bps), txval: rupees(amounts.taxablePaise) };
    if (inter) entry.iamt = rupees(amounts.igstPaise);
    else { entry.camt = rupees(amounts.cgstPaise); entry.samt = rupees(amounts.sgstPaise); }
    entry.csamt = rupees(amounts.cessPaise);
    b2cs.push(entry);
  }
  if (b2cs.length) sections.b2cs = b2cs;
  return { sections, totals, problems };
}

/** GSTN's HSN table takes quantities with at most two decimals; round half away from zero and note any change. */
function hsnQuantity(row, notes) {
  const value = Number(row.quantity);
  const rounded = Math.sign(value) * Math.round(Math.abs(value) * 100 + 1e-9) / 100;
  if (rounded !== value) notes.push({ hsn: row.code, uqc: row.uqc, from: row.quantityText, to: rounded.toFixed(2), message: `HSN ${row.code} quantity ${row.quantityText} ${row.uqc} is reported as ${rounded.toFixed(2)}; GSTN accepts two decimals` });
  return rounded;
}

function hsnSection(book) {
  const notes = [];
  const read = rowReader("hsn(b2b)");
  const rows = side => (book.sheets[`hsn(${side})`] || []).map(row => {
    const uqc = String(read(row, "UQC") || "");
    return { code: String(read(row, "HSN")), desc: String(read(row, "Description") || ""), uqc: uqc === "NA" ? "NA" : uqc.split("-")[0],
      quantity: Number(read(row, "Total Quantity") || 0), bps: bpsOf(read(row, "Rate")),
      taxablePaise: paise(read(row, "Taxable Value")), igstPaise: paise(read(row, "Integrated Tax Amount")), cgstPaise: paise(read(row, "Central Tax Amount")),
      sgstPaise: paise(read(row, "State/UT Tax Amount")), cessPaise: paise(read(row, "Cess Amount")), quantityText: String(read(row, "Total Quantity") || "0") };
  });
  const totals = side => side.reduce((sum, row) => add(sum, row), { rows: side.length, ...zero() });
  // GSTN's HSN description field takes at most 30 characters.
  const render = list => list.map((row, index) => ({ num: index + 1, hsn_sc: row.code, ...(row.desc ? { desc: row.desc.slice(0, 30).trim() } : {}), uqc: row.uqc,
    qty: row.uqc === "NA" ? 0 : hsnQuantity(row, notes), rt: percent(row.bps), txval: rupees(row.taxablePaise), iamt: rupees(row.igstPaise), camt: rupees(row.cgstPaise),
    samt: rupees(row.sgstPaise), csamt: rupees(row.cessPaise) }));
  const b2b = rows("b2b"), b2c = rows("b2c");
  const summary = { layout: book.month >= HSN_SPLIT_FROM ? "split" : "combined", b2b: totals(b2b), b2c: totals(b2c) };
  if (summary.layout === "split") {
    const hsn = {};
    if (b2b.length) hsn.hsn_b2b = render(b2b);
    if (b2c.length) hsn.hsn_b2c = render(b2c);
    return { hsn: b2b.length || b2c.length ? hsn : null, summary, notes };
  }
  // Before the Phase-3 split, Table 12 is a single list keyed by HSN, UQC and rate.
  const merged = new Map();
  for (const row of [...b2b, ...b2c]) {
    const id = JSON.stringify([row.code, row.uqc, row.bps]);
    const target = merged.get(id);
    if (!target) { merged.set(id, { ...row }); continue; }
    add(target, row);
    target.quantity = Number(formatMicros(micros(target.quantityText) + micros(row.quantityText)));
    target.quantityText = formatMicros(micros(target.quantityText) + micros(row.quantityText));
  }
  return { hsn: merged.size ? { data: render([...merged.values()]) } : null, summary, notes };
}
function micros(text) {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) throw new Error(`An HSN quantity is invalid: ${text}`);
  const n = BigInt(match[2]) * 1000000n + BigInt((match[3] || "").padEnd(6, "0"));
  return match[1] ? -n : n;
}
function formatMicros(value) {
  const sign = value < 0n ? "-" : "", abs = value < 0n ? -value : value;
  const fraction = String(abs % 1000000n).padStart(6, "0").replace(/0+$/, "");
  return `${sign}${abs / 1000000n}${fraction ? "." + fraction : ""}`;
}

function docIssueSection(book) {
  const read = rowReader("docs");
  const categories = new Map();
  const summary = { categories: 0, ranges: 0, documents: 0, cancelled: 0, netIssued: 0 };
  for (const row of book.sheets.docs || []) {
    const name = read(row, "Nature of Document"), code = DOCUMENT_CODES.get(name);
    if (!code) throw new Error(`The document type ${name} has no GSTR-1 Table 13 code`);
    const totnum = Number(read(row, "Total Number")), cancel = Number(read(row, "Cancelled") || 0);
    if (!Number.isSafeInteger(totnum) || !Number.isSafeInteger(cancel) || cancel > totnum) throw new Error(`The ${name} range counts are invalid`);
    if (!categories.has(code)) categories.set(code, []);
    const docs = categories.get(code);
    docs.push({ num: docs.length + 1, from: String(read(row, "Sr. No. From")), to: String(read(row, "Sr. No. To")), totnum, cancel, net_issue: totnum - cancel });
    summary.ranges++; summary.documents += totnum; summary.cancelled += cancel; summary.netIssued += totnum - cancel;
  }
  summary.categories = categories.size;
  const doc_det = [...categories].sort((a, b) => a[0] - b[0]).map(([doc_num, docs]) => ({ doc_num, docs }));
  return { doc_issue: doc_det.length ? { doc_det } : null, summary };
}

function nilSection(book) {
  const read = rowReader("exemp");
  const summary = { rows: 0, nilPaise: 0, exemptPaise: 0, nonGstPaise: 0 };
  const inv = [];
  for (const row of book.sheets.exemp || []) {
    const label = read(row, "Description"), sply_ty = NIL_TYPES[label];
    if (!sply_ty) throw new Error(`The Table 8 description ${label} has no GSTR-1 JSON supply type`);
    const nil = paise(read(row, "Nil Rated Supplies")), exempt = paise(read(row, "Exempted(other than nil rated/non GST supply)")), nonGst = paise(read(row, "Non-GST Supplies"));
    summary.rows++; summary.nilPaise = exact(summary.nilPaise + nil); summary.exemptPaise = exact(summary.exemptPaise + exempt); summary.nonGstPaise = exact(summary.nonGstPaise + nonGst);
    inv.push({ sply_ty, expt_amt: rupees(exempt), nil_amt: rupees(nil), ngsup_amt: rupees(nonGst) });
  }
  const order = Object.values(NIL_TYPES);
  inv.sort((a, b) => order.indexOf(a.sply_ty) - order.indexOf(b.sply_ty));
  return { nil: inv.length ? { inv } : null, summary };
}

function warnings(json) {
  const found = [];
  const negative = (value, path) => {
    if (typeof value === "number" && value < 0) found.push({ path, value, message: "GSTN rejects negative amounts in this field; net the credit against an earlier period or report it as a credit note" });
    else if (Array.isArray(value)) value.forEach((entry, index) => negative(entry, `${path}[${index}]`));
    else if (value && typeof value === "object") for (const [name, entry] of Object.entries(value)) negative(entry, path ? `${path}.${name}` : name);
  };
  for (const section of ["b2cs", "hsn", "nil"]) if (json[section]) negative(json[section], section);
  return found;
}

function prepare(args) {
  const [first, second, registrationId, month, directory] = args;
  if (first && typeof first === "object" && first.sheets && first.registration && typeof first.month === "string") {
    if (second !== undefined && second !== null && (!second.company || !Array.isArray(second.vouchers))) throw new Error("Pass the company and its vouchers with the return workbook");
    return { book: first, context: second || null };
  }
  if (!Array.isArray(second)) throw new Error("Pass the company vouchers to build the GSTR-1 JSON");
  return { book: returnWorkbook(first, second, registrationId, month, directory), context: { company: first, vouchers: second } };
}

/**
 * Builds the GSTR-1 upload JSON and its summary.
 * Call as gstr1Export(company, vouchers, registrationId, month, directory)
 * or gstr1Export(returnWorkbookResult, { company, vouchers }?).
 */
export function gstr1Export(...args) {
  const { book, context } = prepare(args);
  const gstin = book.registration.gstin;
  if (!/^[0-9A-Z]{15}$/.test(gstin || "")) throw new Error("The GST registration needs a 15-character GSTIN before exporting JSON");
  const registration = context?.company.gst?.registrations.find(row => row.id === book.registration.id);
  const home = registration?.stateCode || gstin.slice(0, 2);
  const sources = taxSources(book, context);
  const { sections, totals, problems } = buildSections(book, sources, home);
  const hsn = hsnSection(book), docIssue = docIssueSection(book), nil = nilSection(book);
  const json = { gstin, fp: returnPeriod(book.month), version: GSTR1_JSON_VERSION, hash: "hash", gt: 0, cur_gt: 0 };
  for (const name of ["b2b", "b2ba", "b2cl", "b2cla", "b2cs", "cdnr", "cdnra", "cdnur", "cdnura", "exp", "expa"]) if (sections[name]) json[name] = sections[name];
  if (hsn.hsn) json.hsn = hsn.hsn;
  if (docIssue.doc_issue) json.doc_issue = docIssue.doc_issue;
  if (nil.nil) json.nil = nil.nil;
  const sectionTotals = Object.fromEntries(Object.entries(totals).map(([name, value]) => [name, { ...value, taxPaise: exact(value.igstPaise + value.cgstPaise + value.sgstPaise + value.cessPaise) }]));
  const summary = { gstin, fp: json.fp, month: book.month, version: GSTR1_JSON_VERSION, fileName: gstr1JsonFileName(gstin, book.month),
    registration: book.registration, taxHeads: context ? "booked" : "derived", sections: sectionTotals, hsn: hsn.summary, docIssue: docIssue.summary, nil: nil.summary,
    issues: [...book.issues, ...problems], hsnComplete: book.hsnCheck.complete, warnings: warnings(json), notes: hsn.notes };
  summary.ready = !summary.issues.length && summary.hsnComplete && !summary.warnings.length;
  return { json, summary, fileName: summary.fileName, book };
}
/** The GSTR-1 upload JSON object. Same arguments as gstr1Export. */
export function gstr1Json(...args) { return gstr1Export(...args).json; }
/** Section counts and paise totals for review before download. Same arguments as gstr1Export. */
export function gstr1JsonSummary(...args) { return gstr1Export(...args).summary; }
