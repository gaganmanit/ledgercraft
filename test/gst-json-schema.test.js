// GSTR-1 upload JSON: independent structural check against the published GSTN
// "GSTR1 - Save GSTR1 data" schema, hand-encoded in lib/resources/gstr1-json-schema.json.
// This is a structural check against the published specification, not a portal upload.
import test from "node:test";
import assert from "node:assert/strict";
import { exportShippingFields } from "../lib/gst-export-particulars.js";
import { readFileSync } from "node:fs";
import { applyCreditReview } from "../lib/gst-credit-review.js";
import { gstinCheckDigit } from "../lib/gst.js";
import { buildOutwardAmendment, outwardDocumentSnapshot } from "../lib/gst-outward-amendments.js";
import { gstr1Json, gstr1Export } from "../lib/gst-json.js";

const schema = JSON.parse(readFileSync(new URL("../lib/resources/gstr1-json-schema.json", import.meta.url), "utf8"));

// ---------------------------------------------------------------- validator
const kind = value => Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
function decimals(value) {
  const text = String(value);
  if (/e/i.test(text)) return Math.round(value * 100) / 100 === value ? 0 : Infinity;
  return (text.split(".")[1] || "").length;
}
/** Walks value against a schema node and returns every violation as { path, message }. */
function validateGstr1(value, node = schema.root, path = "$", out = []) {
  const spec = typeof node === "string" ? schema.types[node] : node;
  if (!spec) throw new Error(`Unknown schema type ${node} at ${path}`);
  const fail = message => out.push({ path, message });
  const actual = kind(value);
  if (spec.type === "integer" ? !Number.isInteger(value) : spec.type === "number" ? actual !== "number" || !Number.isFinite(value) : actual !== spec.type) {
    fail(`expected ${spec.type}, found ${actual === "number" ? value : actual}`);
    return out;
  }
  if (spec.enum && !spec.enum.includes(value)) fail(`${JSON.stringify(value)} is not one of ${JSON.stringify(spec.enum)}`);
  if (actual === "string") {
    if (spec.minLength !== undefined && value.length < spec.minLength) fail(`${JSON.stringify(value)} is shorter than ${spec.minLength}`);
    if (spec.maxLength !== undefined && value.length > spec.maxLength) fail(`${JSON.stringify(value)} is longer than ${spec.maxLength}`);
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) fail(`${JSON.stringify(value)} does not match ${spec.pattern}`);
  }
  if (actual === "number") {
    if (spec.decimals !== undefined && decimals(value) > spec.decimals) fail(`${value} has more than ${spec.decimals} decimals`);
    if (spec.minimum !== undefined && value < spec.minimum) fail(`${value} is below ${spec.minimum}`);
    if (spec.maximum !== undefined && value > spec.maximum) fail(`${value} is above ${spec.maximum}`);
  }
  if (actual === "array") {
    if (spec.minItems !== undefined && value.length < spec.minItems) fail(`needs at least ${spec.minItems} entries`);
    value.forEach((entry, index) => validateGstr1(entry, spec.items, `${path}[${index}]`, out));
  }
  if (actual === "object") {
    const properties = spec.properties || {};
    for (const name of spec.required || []) if (!(name in value)) fail(`missing required ${name}`);
    for (const [name, entry] of Object.entries(value)) {
      if (properties[name]) validateGstr1(entry, properties[name], `${path}.${name}`, out);
      else if (spec.closed) out.push({ path: `${path}.${name}`, message: "is not a field of this record in the published schema" });
    }
    for (const rule of spec.conditions || []) {
      if (!Object.entries(rule.when).every(([name, values]) => values.includes(value[name]))) continue;
      for (const name of rule.required || []) if (!(name in value)) fail(`missing ${name}, required when ${JSON.stringify(rule.when)}`);
      for (const name of rule.forbidden || []) if (name in value) fail(`${name} is not allowed when ${JSON.stringify(rule.when)}`);
    }
    if (spec.requireOneGroup) {
      const present = spec.requireOneGroup.filter(group => group.some(name => name in value));
      if (present.length !== 1) fail(`needs exactly one of the layouts ${JSON.stringify(spec.requireOneGroup)}, found ${present.length}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- fixtures
// Smallest copies of the synthetic books in test/gst-returns.test.js and
// test/gst-json-amendments.test.js, plus unregistered debit notes for CDNUR.
const registration = { id: "reg", name: "Synthetic company", gstin: "23ABCDE1234F1Z8", stateCode: "23" };
const company = { gst: { registrations: [registration] } };
const jsonParty = (name, gstin) => ({ name, gstin });
function jsonLine(gstRateBps, taxablePaise, { inter = false, zeroTax = false, supplyStatus = "taxable", hsnSac = "8541", name = "Solar cell", unit = "NOS", quantity = "1", kind = "goods" } = {}) {
  const tax = zeroTax || supplyStatus !== "taxable" && supplyStatus !== "zero-rated" ? 0 : taxablePaise * gstRateBps / 10000;
  const igstPaise = inter ? tax : 0, cgstPaise = inter ? 0 : tax / 2, sgstPaise = inter ? 0 : tax / 2;
  return { itemId: "item-" + hsnSac, kind, name, hsnSac, unit, gstRateBps, supplyStatus, quantity, taxablePaise, igstPaise, cgstPaise, sgstPaise, utgstPaise: 0, cessPaise: 0, taxPaise: tax, totalPaise: taxablePaise + tax };
}
function jsonDoc(number, date, party, placeOfSupply, items, changes = {}) {
  const id = number.toLowerCase();
  const totals = Object.fromEntries(["taxablePaise", "igstPaise", "cgstPaise", "sgstPaise", "utgstPaise", "cessPaise", "taxPaise", "totalPaise"].map(k => [k, items.reduce((s, l) => s + l[k], 0)]));
  return { id, date, type: changes.type || "Sales", number, gst: { id, date, number, type: "Sales", direction: "sales", registration, registrationId: "reg", partyId: "p-" + (party.gstin || party.name), party, placeOfSupply, supplyCategory: "domestic", stockEffect: "quantity", items, totals, ...changes } };
}
function juneBooks() {
  const local = jsonParty("Local dealer", "23AAACL1234C1Z5"), outer = jsonParty("Mumbai dealer", "27ABCDE1234F1Z0"), consumer = jsonParty("Consumer", ""), overseas = jsonParty("Overseas buyer", "");
  const debit = original => ({ type: "Debit Note", originalInvoiceId: original.toLowerCase(), originalNumber: original, stockEffect: "none" });
  const vouchers = [
    jsonDoc("SI-1", "2026-06-01", local, "23", [jsonLine(1800, 10000), jsonLine(500, 2000, { hsnSac: "8501", name: "Motor" })]),
    jsonDoc("SI-2", "2026-06-02", outer, "27", [jsonLine(1800, 50000, { inter: true })]),
    jsonDoc("SI-3", "2026-06-03", consumer, "27", [jsonLine(1800, 10000000, { inter: true })]),
    jsonDoc("SI-4", "2026-06-04", consumer, "23", [jsonLine(1200, 3000, { hsnSac: "8504", name: "Inverter" }), jsonLine(0, 1000, { supplyStatus: "nil-rated", hsnSac: "0401", name: "Milk", unit: "LTR" })]),
    jsonDoc("SI-5", "2026-06-05", consumer, "27", [jsonLine(1800, 4000, { inter: true })]),
    jsonDoc("SI-6", "2026-06-06", consumer, "23", [jsonLine(1200, 2000, { hsnSac: "8504", name: "Inverter" })]),
    jsonDoc("SI-9", "2026-06-09", local, "23", [jsonLine(0, 1500, { supplyStatus: "exempt", hsnSac: "9983", kind: "service", name: "Consulting" })]),
    jsonDoc("CN-1", "2026-06-20", outer, "27", [jsonLine(1800, 5000, { inter: true })], { type: "Credit Note", originalInvoiceId: "si-2", originalNumber: "SI-2", originalDate: "2026-06-02", stockEffect: "none" }),
    jsonDoc("EX-1", "2026-06-10", overseas, "96", [jsonLine(1800, 20000, { inter: true, supplyStatus: "zero-rated" })], { supplyCategory: "export", exportMode: "payment", portCode: "INNSA1", shippingBillNumber: "1234567", shippingBillDate: "2026-06-12" }),
    jsonDoc("EX-2", "2026-06-11", overseas, "96", [jsonLine(1800, 30000, { inter: true, zeroTax: true, supplyStatus: "zero-rated" })], { supplyCategory: "export", exportMode: "lut" }),
    jsonDoc("SZ-1", "2026-06-12", jsonParty("SEZ unit", "23AAACS1234C1Z9"), "23", [jsonLine(1800, 7000, { inter: true, zeroTax: true, supplyStatus: "zero-rated" })], { supplyCategory: "sez", exportMode: "lut" }),
    jsonDoc("SZ-2", "2026-06-13", jsonParty("SEZ developer", "27AAACS1234C1Z2"), "27", [jsonLine(1800, 8000, { inter: true, supplyStatus: "zero-rated" })], { supplyCategory: "sez", exportMode: "payment" }),
    jsonDoc("DN-1", "2026-06-21", consumer, "27", [jsonLine(1800, 100000, { inter: true })], debit("SI-3")),
    jsonDoc("DN-2", "2026-06-22", overseas, "96", [jsonLine(1800, 2000, { inter: true, supplyStatus: "zero-rated" })], { ...debit("EX-1"), supplyCategory: "export", exportMode: "payment" }),
  ];
  const note = vouchers.find(v => v.number === "CN-1").gst;
  const books = { gst: { registrations: [registration], turnoverByYear: [{ pan: "ABCDE1234F", year: "2026", band: "up-to-5cr" }] } };
  const reviewed = applyCreditReview(books, vouchers, { invoiceId: note.id, revision: 0, requestId: "synthetic-schema-credit-001", declarationDate: "2026-07-10",
    annualReturnStatus: "not-filed", recipientBasis: "reversed", adjustmentGround: "excess-value-or-tax", groundConfirmed: true, reference: "Synthetic recipient reversal evidence" }).company;
  return { company: reviewed, vouchers };
}

// Amendment sections (9A/9C), as in test/gst-json-amendments.test.js.
const checked = prefix => prefix + gstinCheckDigit(prefix);
function amendedBooks() {
  const reg = { id: "reg", name: "Synthetic registration", gstin: checked("23ABCDE1234F1Z"), stateCode: "23" };
  const heads = ["taxablePaise", "igstPaise", "cgstPaise", "sgstPaise", "utgstPaise", "cessPaise", "totalPaise"];
  const f = { company: { id: "synthetic-json-schema", booksFrom: "2026-04-01", ledgers: [], gst: { registrations: [reg] } }, vouchers: [] };
  let sequence = 0;
  const document = (number, changes = {}, taxable = 20000) => {
    const id = number.toLowerCase().replaceAll("/", "-"), inter = changes.placeOfSupply !== "23", withoutTax = changes.exportMode === "lut";
    const items = [500, 1800].map((rate, index) => {
      const amount = taxable / 2, tax = withoutTax ? 0 : amount * rate / 10000;
      return { itemId: "item-" + index, kind: "goods", name: "Synthetic goods", hsnSac: index ? "85414090" : "010121", unit: "NOS", quantity: "1", gstRateBps: rate,
        supplyStatus: changes.supplyCategory && changes.supplyCategory !== "domestic" ? "zero-rated" : "taxable", taxablePaise: amount,
        igstPaise: inter ? tax : 0, cgstPaise: inter ? 0 : tax / 2, sgstPaise: inter ? 0 : tax / 2, utgstPaise: 0, cessPaise: 0, taxPaise: tax, totalPaise: amount + tax };
    });
    const totals = Object.fromEntries([...heads, "taxPaise"].map(key => [key, items.reduce((sum, row) => sum + row[key], 0)]));
    const invoice = { id, voucherId: id, number, date: "2026-04-10", type: "Sales", direction: "sales", registrationId: reg.id, registration: reg,
      party: { name: "Synthetic customer", gstin: checked("27LMNOP1234Q1Z") }, placeOfSupply: "27", supplyCategory: "domestic", reverseCharge: false, stockEffect: "quantity", items, totals, ...changes };
    f.vouchers.push({ id, date: invoice.date, type: invoice.type, number: invoice.number, gst: invoice, lines: [] });
    return invoice;
  };
  const save = invoice => {
    if (invoice.type === "Credit Note" && !invoice.originalInvoiceId) {
      const original = document("ORIGINAL/1", { date: invoice.originalDate });
      invoice.originalInvoiceId = original.id; invoice.originalNumber = original.number;
      f.company = applyCreditReview(f.company, f.vouchers, { invoiceId: invoice.id, revision: 0, requestId: "synthetic-credit-review-" + invoice.id, declarationDate: "2026-06-11",
        annualReturnStatus: "not-filed", recipientBasis: "not-availed", adjustmentGround: "excess-value-or-tax", groundConfirmed: true, reference: "Synthetic recipient and credit calculation" }).company;
    }
    const prior = structuredClone(outwardDocumentSnapshot(invoice, f.vouchers));
    prior.number = "0001"; prior.date = "2026-04-09"; prior.invoiceValuePaise *= .5;
    for (const row of prior.rates) for (const key of heads.filter(key => key !== "totalPaise")) row[key] *= .5;
    for (const row of prior.hsnRows) { for (const key of heads) row[key] *= .5; row.quantity = String(Number(row.quantity) * .5); }
    const input = { invoiceId: invoice.id, date: "2026-06-01", filingDate: "2026-06-11", amendmentPeriod: "2026-05", originalPeriod: "2026-04",
      revision: f.company.gst.outwardAmendments?.revision || 0, requestId: "synthetic-json-schema-" + String(++sequence).padStart(8, "0"),
      originalReported: prior, originalFiling: { form: "GSTR-1", reference: "SYNTHETIC-APRIL", filedDate: "2026-05-11", confirmedFiled: true },
      annualReturnStatus: "not-filed", evidence: { basis: "Synthetic reporting discrepancy", documentReference: "SYNTHETIC-RECON", accurateBooksConfirmed: true, reportedSnapshotConfirmed: true } };
    input.previewHash = buildOutwardAmendment(f.company, f.vouchers, input, { preview: true }).previewHash;
    const result = buildOutwardAmendment(f.company, f.vouchers, input);
    f.company.gst.outwardAmendments ||= { version: 1, revision: 0, records: [], events: [] };
    f.company.gst.outwardAmendments.records.push(result.record); f.company.gst.outwardAmendments.revision = result.revision;
  };
  const consumer = { name: "Synthetic consumer", gstin: "" };
  const large = document("LARGE/1", { party: consumer }, 20000000);
  for (const invoice of [document("B2B/1"), large,
    document("EXPORT/1", { party: consumer, supplyCategory: "export", exportMode: "igst", placeOfSupply: "96", portCode: "INBOM1", shippingBillNumber: "0000123", shippingBillDate: "2026-04-10" }),
    document("CREDIT/1", { type: "Credit Note", stockEffect: "none", originalDate: "2026-04-01" }),
    document("UNREG/1", { party: consumer, type: "Debit Note", stockEffect: "none", originalInvoiceId: large.id })]) save(invoice);
  return f;
}

const format = violations => violations.map(v => `${v.path}: ${v.message}`).join("\n");

// ---------------------------------------------------------------- tests
test("the hand-encoded GSTN schema resolves every named type and records its sources", () => {
  const comment = schema.$comment.join("\n");
  assert.match(comment, /09-11-2026/);
  assert.match(comment, /developer\.gst\.gov\.in\/pages\/apiportal\/data\/Returns\/GSTR1%20-%20Save%20GSTR1%20data\/v4\.1\//);
  assert.match(comment, /not a portal upload/);
  const names = [];
  const collect = node => {
    if (typeof node === "string") { names.push(node); return; }
    if (node.items) collect(node.items);
    for (const entry of Object.values(node.properties || {})) collect(entry);
  };
  collect(schema.root);
  for (const type of Object.values(schema.types)) collect(type);
  for (const name of names) assert.ok(schema.types[name], `type ${name} is defined`);
  for (const section of ["b2b", "b2ba", "b2cl", "b2cla", "b2cs", "b2csa", "cdnr", "cdnra", "cdnur", "cdnura", "exp", "expa", "at", "txpd", "hsn", "nil", "doc_issue"]) assert.ok(schema.root.properties[section], section);
});

test("June GSTR-1 JSON with B2B, SEZ, B2CL, B2CS, CDNR, CDNUR, exports, split HSN, Table 8 and Table 13 matches the published structure", () => {
  const { company: c, vouchers } = juneBooks();
  const json = gstr1Json(c, vouchers, "reg", "2026-06");
  for (const section of ["b2b", "b2cl", "b2cs", "cdnr", "cdnur", "exp", "hsn", "doc_issue", "nil"]) assert.ok(json[section], `${section} is present`);
  assert.deepEqual(json.cdnur.map(n => [n.typ, n.ntty, n.nt_num, n.pos]).toSorted(), [["B2CL", "D", "DN-1", "27"], ["EXPWP", "D", "DN-2", undefined]]);
  assert.ok(json.hsn.hsn_b2b && json.hsn.hsn_b2c);
  assert.deepEqual(validateGstr1(json), [], format(validateGstr1(json)));
});

test("April 2025 GSTR-1 JSON with the single pre-split HSN list matches the published structure", () => {
  const april = [jsonDoc("A-1", "2025-04-02", jsonParty("Local dealer", "23AAACL1234C1Z5"), "23", [jsonLine(1800, 10000)]),
    jsonDoc("A-2", "2025-04-03", jsonParty("Consumer", ""), "23", [jsonLine(1800, 2000)])];
  const json = gstr1Json(company, april, "reg", "2025-04");
  assert.ok(json.hsn.data);
  assert.deepEqual(validateGstr1(json), [], format(validateGstr1(json)));
});

test("amendment-period and original-period JSON (B2BA, B2CLA, CDNRA, CDNURA, EXPA) match the published structure", () => {
  const f = amendedBooks();
  const may = gstr1Json(f.company, f.vouchers, "reg", "2026-05");
  for (const section of ["b2ba", "b2cla", "cdnra", "cdnura", "expa"]) assert.ok(may[section], `${section} is present`);
  assert.deepEqual(validateGstr1(may), [], format(validateGstr1(may)));
  const april = gstr1Json(f.company, f.vouchers, "reg", "2026-04");
  assert.deepEqual(validateGstr1(april), [], format(validateGstr1(april)));
});

test("the validator is live: each single-field mutation is reported at that field's JSON path only", () => {
  const { company: c, vouchers } = juneBooks();
  const json = gstr1Json(c, vouchers, "reg", "2026-06");
  const b2b = json.b2b.findIndex(p => p.inv[0].itms[0].itm_det.camt !== undefined);
  const cases = [
    [`$.b2b[${b2b}].inv[0].inum`, j => { j.b2b[b2b].inv[0].inum = "INV/2026-27/00001"; }, /longer than 16/],
    [`$.b2b[${b2b}].inv[0].itms[0].itm_det.txval`, j => { j.b2b[b2b].inv[0].itms[0].itm_det.txval = 100.125; }, /more than 2 decimals/],
    [`$.b2b[${b2b}].inv[0].itms[0].itm_det.camt`, j => { j.b2b[b2b].inv[0].itms[0].itm_det.camt = -9; }, /below 0/],
    [`$.b2b[${b2b}].inv[0].idt`, j => { j.b2b[b2b].inv[0].idt = "2026-06-01"; }, /does not match/],
    [`$.b2b[${b2b}].inv[0].pos`, j => { j.b2b[b2b].inv[0].pos = "99"; }, /does not match/],
    [`$.b2b[${b2b}].inv[0].rchrg`, j => { j.b2b[b2b].inv[0].rchrg = "No"; }, /not one of/],
    [`$.b2b[${b2b}].inv[0].inv_typ`, j => { j.b2b[b2b].inv[0].inv_typ = "B2B"; }, /not one of/],
    [`$.b2b[${b2b}].inv[0].itms[0].num`, j => { j.b2b[b2b].inv[0].itms[0].num = "1"; }, /expected integer/],
    [`$.b2b[${b2b}].inv[0].itms[0].itm_det.rt`, j => { j.b2b[b2b].inv[0].itms[0].itm_det.rt = 17; }, /not one of/],
    [`$.b2b[${b2b}].ctin`, j => { j.b2b[b2b].ctin = "23AAACL1234C0Z5"; }, /does not match/],
    ["$.gstin", j => { j.gstin = "23abcde1234f1z!"; }, /does not match/],
    ["$.fp", j => { j.fp = "132026"; }, /does not match/],
    ["$.hash", j => { j.hash = "abc"; }, /not one of/],
    ["$.b2cl[0].pos", j => { j.b2cl[0].pos = "96"; }, /does not match/],
    ["$.b2cs[0].sply_ty", j => { j.b2cs[0].sply_ty = "INTRASTATE"; }, /not one of/],
    ["$.b2cs[0].typ", j => { j.b2cs[0].typ = "O"; }, /not one of/],
    ["$.cdnr[0].nt[0].ntty", j => { j.cdnr[0].nt[0].ntty = "X"; }, /not one of/],
    ["$.cdnr[0].nt[0].p_gst", j => { j.cdnr[0].nt[0].p_gst = "N"; }, /not a field/],
    ["$.cdnur[0]", j => { const b2cl = j.cdnur.find(n => n.typ === "B2CL"); j.cdnur = [b2cl]; delete b2cl.pos; }, /missing pos/],
    ["$.cdnur[0]", j => { const exp = j.cdnur.find(n => n.typ === "EXPWP"); j.cdnur = [exp]; exp.pos = "27"; }, /pos is not allowed/],
    ["$.exp[0].exp_typ", j => { j.exp[0].exp_typ = "LUT"; }, /not one of/],
    ["$.exp[0].inv[0].sbnum", j => { const inv = j.exp.find(e => e.exp_typ === "WPAY").inv[0]; j.exp = [{ exp_typ: "WPAY", inv: [inv] }]; inv.sbnum = "12345678"; }, /longer than 7/],
    ["$.hsn.hsn_b2b[0].qty", j => { j.hsn.hsn_b2b[0].qty = 1.125; }, /more than 2 decimals/],
    ["$.hsn.hsn_b2b[0].hsn_sc", j => { j.hsn.hsn_b2b[0].hsn_sc = "8541X"; }, /does not match/],
    ["$.hsn", j => { j.hsn.data = j.hsn.hsn_b2b; }, /exactly one of the layouts/],
    ["$.nil.inv[0].sply_ty", j => { j.nil.inv[0].sply_ty = "INTRA"; }, /not one of/],
    ["$.nil.inv[0]", j => { delete j.nil.inv[0].ngsup_amt; }, /missing required ngsup_amt/],
    ["$.doc_issue.doc_det[0].doc_num", j => { j.doc_issue.doc_det[0].doc_num = 13; }, /above 12/],
    ["$.doc_issue.doc_det[0].docs[0].cancel", j => { j.doc_issue.doc_det[0].docs[0].cancel = 0.5; }, /expected integer/],
    ["$.doc_issue.doc_det[0].docs[0].from", j => { j.doc_issue.doc_det[0].docs[0].from = "0000"; }, /does not match/],
  ];
  for (const [path, mutate, message] of cases) {
    const copy = structuredClone(json);
    mutate(copy);
    const found = validateGstr1(copy);
    assert.ok(found.length > 0, `${path}: the mutation is reported`);
    assert.deepEqual([...new Set(found.map(v => v.path))], [path], format(found));
    assert.ok(found.some(v => message.test(v.message)), `${path}: ${format(found)}`);
  }
});

// Fields the published schema bounds more tightly than the books: quantities
// are rounded to two decimals with a disclosed note, and shipping bill numbers
// are refused at input and flagged as an issue when an older book holds one.
function singleSale(changes, line) {
  const pos = changes.placeOfSupply || "23";
  const item = { ...jsonLine(1800, 10000, { inter: pos !== "23", supplyStatus: changes.supplyCategory ? "zero-rated" : "taxable" }), ...line };
  return [jsonDoc("GAP-1", "2026-06-02", changes.party || jsonParty("Local dealer", "23AAACL1234C1Z5"), pos, [item], changes)];
}
test("HSN quantities are written with at most two decimals (hsnqty multipleOf 0.01) and the rounding is disclosed", () => {
  const { json, summary } = gstr1Export(company, singleSale({}, { unit: "KGS", quantity: "1.125" }), "reg", "2026-06");
  assert.deepEqual(validateGstr1(json), [], format(validateGstr1(json)));
  const rows = json.hsn.hsn_b2b || json.hsn.data;
  assert.equal(rows[0].qty, 1.13);
  assert.equal(summary.notes.length, 1);
  assert.match(summary.notes[0].message, /1\.125 KGS is reported as 1\.13/);
  assert.equal(summary.issues.length, 0, "rounding a quantity is disclosed, never an issue");
});
test("export shipping bill numbers are 3 to 7 digits (sbnum ^[0-9]{3,7}$): refused at input, flagged when an older book holds one", () => {
  const exportSale = number => singleSale({ party: jsonParty("Overseas buyer", ""), placeOfSupply: "96", supplyCategory: "export", exportMode: "payment",
    portCode: "INNSA1", shippingBillNumber: number, shippingBillDate: "2026-06-03" });
  assert.throws(() => exportShippingFields({ portCode: "INNSA1", shippingBillNumber: "SB/2026-0001", shippingBillDate: "2026-06-03" }), /3 to 7 digits/);
  assert.deepEqual(exportShippingFields({ portCode: "INNSA1", shippingBillNumber: "0001234", shippingBillDate: "2026-06-03" }), { portCode: "INNSA1", shippingBillNumber: "0001234", shippingBillDate: "2026-06-03" });
  const good = gstr1Export(company, exportSale("0001234"), "reg", "2026-06");
  assert.deepEqual(validateGstr1(good.json), [], format(validateGstr1(good.json)));
  assert.equal(good.json.exp[0].inv[0].sbnum, "0001234");
  // A document saved before the digits rule still exports, but the summary names it so the book can be corrected first.
  const legacy = gstr1Export(company, exportSale("SB/2026-0001"), "reg", "2026-06");
  assert.ok(legacy.summary.issues.some(issue => issue.number === "GAP-1" && /3 to 7 digits/.test(issue.reason)));
  assert.equal(legacy.summary.ready, false);
});
