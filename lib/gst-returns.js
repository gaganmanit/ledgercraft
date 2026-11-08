import { supplierDocumentDate } from "./gst-document-identity.js";
import { assertOutwardAmendments, activeOutwardAmendments, AMENDMENT_SOURCES } from "./gst-outward-amendments.js";
import { itcReturnRows, itcState } from "./gst-itc.js";
import { rcmPeriod } from "./gst-rcm-returns.js";
import { turnoverFor, minimumHsnDigits } from "./gst-turnover.js";
import { readFileSync } from "node:fs";
import { formatQuantity, quantityMicros } from "./gst.js";
const readResource = name => JSON.parse(readFileSync(new URL("./resources/" + name, import.meta.url), "utf8"));
export const columns = readResource("gstr1-columns.json");
const masters = readResource("gstr1-masters.json");
const posNames = new Map(masters.states.map(s => [s.slice(0, 2), s]));
const units = new Map(masters.uqc.map(s => [s.split("-")[0], s]));
const amounts = ["taxablePaise", "igstPaise", "cgstPaise", "sgstPaise", "utgstPaise", "cessPaise", "totalPaise"];
const zero = () => Object.fromEntries(amounts.map(k => [k,0]));
function accumulate(target, source, sign = 1) {
  for (const key of amounts) {
    const n = target[key] + sign * source[key];
    if (!Number.isSafeInteger(n)) throw new Error("GST totals exceed the exact paise limit");
    target[key] = n;
  }
}
function aggregate(map, key, fields) {
  if (!map.has(key)) map.set(key, { ...zero(), ...fields });
  return map.get(key);
}
function rupees(paise) {
  if (!Number.isSafeInteger(paise)) throw new Error("GST worksheet amount exceeds the supported paise limit");
  const n=BigInt(Math.abs(paise));
  return (paise<0 ? "-" : "")+(n/100n)+"."+String(n%100n).padStart(2,"0");
}
function hsnReconciliation(sheets, amendmentDetail = { b2b: 0, b2c: 0 }) {
  const detail={b2b:0n,b2c:0n}, hsn={b2b:0n,b2c:0n};
  const amount=text=>BigInt(text.replace(".",""));
  for (const section of ["b2b,sez,de","b2cl","b2cs","exp","cdnr","cdnur"]) {
    const target=(section==="b2b,sez,de" || section==="cdnr") ? "b2b" : "b2c";
    const column=columns[section].indexOf("Taxable Value"), note=columns[section].indexOf("Note Type");
    for (const row of sheets[section]) detail[target]+= (row[note]==="C" ? -1n : 1n)*amount(row[column]);
  }
  for (const row of sheets.exemp) {
    const target=row[0].endsWith("to registered persons") ? "b2b" : "b2c";
    detail[target]+=row.slice(1).reduce((sum,n)=>sum+amount(n),0n);
  }
  return ["b2b","b2c"].map(type=>{
    detail[type] += BigInt(amendmentDetail[type]);
    for (const row of sheets["hsn("+type+")"]) hsn[type]+=amount(row[5]);
    const values=[detail[type],hsn[type],hsn[type]-detail[type]].map(Number);
    if (!values.every(Number.isSafeInteger)) throw new Error("HSN reconciliation exceeds the exact paise limit");
    return {type,supplyPaise:values[0],hsnPaise:values[1],differencePaise:values[2]};
  });
}
const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
// GSTN's Returns Offline Tool requires four-digit years in worksheet date fields.
function csvDate(date) { return date.slice(8) + "-" + months[Number(date.slice(5,7))-1] + "-" + date.slice(0,4); }
function amendmentBucket(snapshot) {
  if (snapshot.reverseCharge) return "outwardRcm";
  return snapshot.section === "exp" || snapshot.urType?.startsWith("EXP") || snapshot.invoiceType?.startsWith("SEZ ") ? "zeroRated" : "outwardTaxable";
}
function amendmentSign(snapshot) { return snapshot.noteType === "C" ? -1 : 1; }
function amendmentWorksheet(record) {
  const original = record.originalReported, revised = record.revised;
  const oldDate = csvDate(original.date), date = csvDate(revised.date);
  const pos = posNames.get(revised.placeOfSupply) || revised.placeOfSupply;
  const rc = revised.reverseCharge ? "Y" : "N", val = rupees(revised.invoiceValuePaise);
  return revised.rates.map(row => {
    const rate = row.gstRateBps / 100, taxable = rupees(row.taxablePaise), cess = rupees(row.cessPaise);
    if (record.section === "b2ba") return [revised.recipientGstin,revised.recipientName,original.number,oldDate,revised.number,date,val,pos,rc,"",revised.invoiceType,"",rate,taxable,cess];
    if (record.section === "b2cla") return [original.number,oldDate,posNames.get(original.placeOfSupply) || original.placeOfSupply,revised.number,date,val,"",rate,taxable,cess,""];
    if (record.section === "expa") return [revised.exportType,original.number,oldDate,revised.number,date,val,revised.portCode || "",revised.shippingBillNumber || "",revised.shippingBillDate ? csvDate(revised.shippingBillDate) : "",rate,taxable,cess];
    if (record.section === "cdnra") return [revised.recipientGstin,revised.recipientName,original.number,oldDate,revised.number,date,revised.noteType,pos,rc,revised.invoiceType,val,"",rate,taxable,cess];
    if (record.section === "cdnura") return [revised.urType,original.number,oldDate,revised.number,date,revised.noteType,pos,val,"",rate,taxable,cess];
    throw new Error("This outward amendment worksheet is not supported");
  });
}
function reportedWorksheet(snapshot) {
  const record = { originalReported: snapshot, revised: snapshot, section: { b2b: "b2ba", b2cl: "b2cla", exp: "expa", cdnr: "cdnra", cdnur: "cdnura" }[snapshot.section] };
  return amendmentWorksheet(record).map(row => {
    if (snapshot.section === "b2b" || snapshot.section === "cdnr") return [...row.slice(0, 2), ...row.slice(4)];
    if (snapshot.section === "b2cl") return [row[3],row[4],row[5],row[2],...row.slice(6)];
    return [row[0],...row.slice(3)];
  });
}
const isNote = i => i.type === "Credit Note" || i.type === "Debit Note";
const signed = i => i.type === "Credit Note" ? -1 : 1;
function largeB2C(i) {
  const threshold = i.date < "2024-08-01" ? 25000000 : 10000000;
  return i.registration.stateCode !== i.placeOfSupply && i.totals.totalPaise > threshold;
}

export function returnWorkbook(company, vouchers, registrationId, month, directory) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Choose a valid return month");
  assertOutwardAmendments(company, vouchers);
  const registration = company.gst?.registrations.find(r => r.id === registrationId);
  if (!registration) throw new Error("Select a GST registration for this company");
  const docs = vouchers.filter(v => v.gst?.registrationId === registrationId && v.date.startsWith(month)).map(v => v.gst);
  const all = new Map(vouchers.filter(v => v.gst).map(v => [v.gst.id, v.gst]));
  const records = activeOutwardAmendments(company, vouchers).filter(record => record.registrationId === registrationId);
  const amendedIds = new Set(records.map(record => record.invoiceId));
  const sheets = Object.fromEntries(Object.keys(columns).map(k => [k, []]));
  const issues = [];
  // Ordinary accounting entries do not establish a GST supply, place of supply or ITC eligibility.
  for (const v of vouchers.filter(v => !v.gst && v.date.startsWith(month) && ["Sales","Purchase","Credit Note","Debit Note"].includes(v.type))) {
    issues.push({ number: v.number, reason: "Accounting voucher has no GST classification", voucherId: v.id, type: v.type });
  }
  const profile = turnoverFor(company, registration, month + "-01");
  const minDigits = minimumHsnDigits(profile, month + "-01");
  const checks = [];
  const seenChecks = new Set();
  function check(doc, code, message) {
    const unique = [doc.id, code, message].join("|");
    if (seenChecks.has(unique)) return;
    seenChecks.add(unique);
    checks.push({ id: doc.id, number: doc.number, code, message });
  }
  const summary = { outwardTaxable: zero(), zeroRated: zero(), nilExempt: zero(), nonGst: zero(), purchases: zero(), eligibleInput: zero(), pendingInput: zero(), ineligibleInput: zero(), inwardRcm: zero(), outwardRcm: zero(), rcmDomesticCredit: zero(), rcmImportCredit: zero(), rcmPermanentReversals: zero(), rcmTemporaryReversals: zero(), rcmReviewReversals: zero() };
  const b2cs = new Map(), hsn = new Map(), exempt = new Map(), series = new Map();
  const evidence = [];
  function recordSeries(docType, number) {
    const serial = /^(.*?)(\d+)$/.exec(number);
    const seriesKey = docType + "|" + (serial ? serial[1] : number);
    const range = series.get(seriesKey) || { docType, numbers: [] };
    range.numbers.push(number);
    series.set(seriesKey, range);
  }
  const rcm = rcmPeriod(company, vouchers, registrationId, month);
  issues.push(...rcm.issues);
  for (const row of rcm.rows) {
    const amount = { ...zero(), ...row };
    amount.totalPaise = amount.taxablePaise + amount.igstPaise + amount.cgstPaise + amount.sgstPaise + amount.utgstPaise + amount.cessPaise;
    accumulate(summary[row.bucket], amount, row.sign || 1);
  }
  const table4 = Object.fromEntries(["4A(5)","4B(1)","4B(2)","4D(1)","4D(2)"].map(key=>[key,zero()]));
  const periodEnd=month+"-"+new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).getUTCDate();
  const itcRows = company.gst?.itc?.records?.length ? itcReturnRows(company,vouchers,month+"-01",periodEnd).filter(row=>row.registrationId===registrationId) : [];
  for (const row of itcRows) accumulate(table4[row.table],{...zero(), ...row},row.sign);
  const reviewedNet=zero();
  for (const bucket of [table4["4A(5)"],summary.rcmImportCredit,summary.rcmDomesticCredit]) accumulate(reviewedNet,bucket);
  for (const bucket of [table4["4B(1)"],table4["4B(2)"],summary.rcmPermanentReversals,summary.rcmTemporaryReversals]) accumulate(reviewedNet,bucket,-1);
  const itc = { table4, reviewedNet, rows:itcRows.map(row=>({...row,number:all.get(row.invoiceId)?.number})), issues:[] };
  if (company.gst?.itc?.records?.length) {
    itc.issues=itcState(company,vouchers,periodEnd).issues.filter(i=>all.get(i.invoiceId)?.registrationId===registrationId);
  }
  for (const { gstRcm: r } of vouchers) {
    if (r?.registrationId === registrationId && r.action === "supplier-payment" && (r.documentDate || r.date).startsWith(month)) recordSeries("Payment Voucher",r.number);
  }
  for (const doc of docs) {
    const sign = signed(doc);
    evidence.push({ id: doc.id, type: doc.type, number: doc.number, direction: doc.direction, date: doc.date, party: doc.party.name,
      ...(doc.direction === "purchase" ? { supplierInvoiceNumber: doc.supplierInvoiceNumber, supplierInvoiceDate: supplierDocumentDate(doc) } : {}),
      taxablePaise: doc.totals.taxablePaise * sign, taxPaise: doc.totals.taxPaise * sign, totalPaise: doc.totals.totalPaise * sign });
    if (doc.direction === "purchase") {
      accumulate(summary.purchases, doc.totals, sign);
      if (doc.reverseCharge) {
        if (doc.rcm?.selfInvoiceRequired) recordSeries("Invoices for inward supply from unregistered person",doc.rcm.selfInvoiceNumber);
        continue;
      }
      const inputKey = { eligible: "eligibleInput", ineligible: "ineligibleInput" }[doc.itcEligibility] || "pendingInput";
      accumulate(summary[inputKey], doc.totals, sign);
      continue;
    }
    const docType = isNote(doc) ? doc.type : "Invoices for outward supply";
    recordSeries(docType,doc.number);
    for (const line of doc.items) {
      const section = line.supplyStatus === "non-gst" ? "nonGst" : ["exempt","nil-rated"].includes(line.supplyStatus) ? "nilExempt" : line.supplyStatus === "zero-rated" ? "zeroRated" : "outwardTaxable";
      accumulate(summary[doc.reverseCharge ? "outwardRcm" : section], line, sign);
    }
    // The actual entry remains in books and the issued-document series. Its
    // return allocation comes from the confirmed prior report below.
    if (amendedIds.has(doc.id)) continue;
    const registered = Boolean(doc.party.gstin), inter = registration.stateCode !== doc.placeOfSupply;
    const exportSale = doc.supplyCategory === "export", sez = doc.supplyCategory === "sez";
    const exportType = doc.exportMode === "lut" ? "WOPAY" : "WPAY";
    const invoiceType = sez ? (doc.exportMode === "lut" ? "SEZ supplies without payment" : "SEZ supplies with payment") : "Regular B2B";
    const pos = posNames.get(doc.placeOfSupply) || doc.placeOfSupply;
    const rates = new Map();
    for (const line of doc.items) {
      const entry = directory?.get(line.kind + ":" + line.hsnSac);
      if (directory && !entry) check(doc, line.hsnSac, "Check this code against the current GST directory");
      if (minDigits && line.hsnSac.length < minDigits) check(doc, line.hsnSac, `The preceding year's turnover band requires ${minDigits} digits`);
      if (!profile && month >= "2021-04" && line.hsnSac.length < 6) check(doc, line.hsnSac, "Record the preceding year's turnover band to check the required HSN length");
      const key = line.supplyStatus, exemptKey = { exempt: "exempt", "nil-rated": "nil", "non-gst": "nongst" }[key];
      const uqc = units.get(line.unit) || (line.kind === "service" ? "NA" : "");
      if (!uqc) issues.push({ number: doc.number, reason: "UQC needs an official unit code: " + line.unit, id: doc.id });
      const hKey = JSON.stringify([registered, line.hsnSac, uqc || line.unit, line.gstRateBps]);
      const h = aggregate(hsn, hKey, { registered, code: line.hsnSac, name: entry?.description || line.name, uqc: uqc || line.unit, rate: line.gstRateBps, quantity: 0n });
      accumulate(h, line, sign);
      if (!isNote(doc) || doc.stockEffect === "quantity") h.quantity += BigInt(sign) * quantityMicros(line.quantity);
      if (exemptKey) {
        const label = (inter ? "Inter-State" : "Intra-State") + " supplies to " + (registered ? "registered" : "unregistered") + " persons";
        const bucket = exempt.get(label) || { nil: 0, exempt: 0, nongst: 0 };
        bucket[exemptKey] += line.taxablePaise * sign;
        exempt.set(label, bucket);
      } else {
        const rate = aggregate(rates, line.gstRateBps, { rate: line.gstRateBps });
        accumulate(rate, line);
      }
    }
    for (const r of rates.values()) {
      const rate = r.rate / 100, val = rupees(doc.totals.totalPaise), taxable = rupees(r.taxablePaise), cess = rupees(r.cessPaise);
      const date = csvDate(doc.date), noteType = doc.type === "Credit Note" ? "C" : "D", rc = doc.reverseCharge ? "Y" : "N";
      if (registered && isNote(doc)) sheets.cdnr.push([doc.party.gstin,doc.party.name,doc.number,date,noteType,pos,rc,invoiceType,val,"",rate,taxable,cess]);
      else if (registered) sheets["b2b,sez,de"].push([doc.party.gstin,doc.party.name,doc.number,date,val,pos,rc,"",invoiceType,"",rate,taxable,cess]);
      else if (exportSale && !isNote(doc)) sheets.exp.push([exportType,doc.number,date,val,doc.portCode || "",doc.shippingBillNumber || "",doc.shippingBillDate ? csvDate(doc.shippingBillDate) : "",rate,taxable,cess]);
      else if (exportSale && isNote(doc)) sheets.cdnur.push([exportType === "WOPAY" ? "EXPWOP" : "EXPWP",doc.number,date,noteType,pos,val,"",rate,taxable,cess]);
      else {
        const orig = isNote(doc) ? all.get(doc.originalInvoiceId) : doc;
        if (!orig) {
          issues.push({ number: doc.number, reason: "Link the unregistered original invoice to classify this note", id: doc.id });
          continue;
        }
        if (largeB2C(orig)) {
          if (isNote(doc)) sheets.cdnur.push(["B2CL",doc.number,date,noteType,pos,val,"",rate,taxable,cess]);
          else sheets.b2cl.push([doc.number,date,val,pos,"",rate,taxable,cess,""]);
        } else {
          const rsum = aggregate(b2cs, pos + "|" + rate, { pos, rate });
          accumulate(rsum, r, sign);
        }
      }
    }
  }
  // Keep chronological accurate books separate from the return working rows.
  // Prior reported values belong to the original return period; only the signed
  // correction belongs to the later amendment period.
  const bookSummary = structuredClone(summary);
  for (const doc of docs.filter(doc => amendedIds.has(doc.id))) {
    const snapshot = records.find(record => record.invoiceId === doc.id).revised;
    accumulate(summary[amendmentBucket(snapshot)], snapshot.totals, -amendmentSign(snapshot));
  }
  const trace = record => ({ id: record.id, status: record.effectiveStatus || record.status, effectiveStatus: record.effectiveStatus || record.status, filing: record.filing, invoiceId: record.invoiceId, number: record.revised.number, section: record.section,
    originalPeriod: record.originalPeriod, amendmentPeriod: record.amendmentPeriod, originalReported: record.originalReported,
    revised: record.revised, delta: record.delta, originalFiling: record.originalFiling, evidence: record.evidence, hsnAttribution: record.hsnAttribution });
  const amendmentBuckets = { outwardTaxable: zero(), zeroRated: zero(), outwardRcm: zero() };
  const amendments = { rows: records.filter(record => record.amendmentPeriod === month).map(trace),
    comparators: records.filter(record => record.originalPeriod === month).map(trace),
    difference: zero(), liabilityDifference: zero(), buckets: amendmentBuckets, hsnIssues: [],
    sources: [...AMENDMENT_SOURCES, { title: "GSTN Table 12 validation: amendment differentials", url: "https://tutorial.gst.gov.in/downloads/news/updated_advisory_hsn_table12_25042025.pdf" },
      { title: "GSTN Returns Offline Tool v2.2 CSV and workbook templates", url: "https://tutorial.gst.gov.in/offlineutilities/returns/gst_offline_tool.zip" }] };
  const amendmentDetail = { b2b: 0, b2c: 0 }, amendmentHsn = new Map();
  const hsnSide = snapshot => ["b2b", "cdnr"].includes(snapshot.section) ? "b2b" : "b2c";
  function addAmendmentHsn(snapshot, effect, doc) {
    for (const row of snapshot.hsnRows) {
      const entry = directory?.get("goods:" + row.hsnSac) || directory?.get("service:" + row.hsnSac);
      if (directory && !entry) check(doc, row.hsnSac, "Check the reported amendment HSN against the GST directory");
      if (minDigits && row.hsnSac.length < minDigits) check(doc, row.hsnSac, `The amendment HSN requires ${minDigits} digits for this return period`);
      const uqc = units.get(row.uqc) || row.uqc;
      if (!masters.uqc.includes(uqc)) check(doc, row.hsnSac, "Use an official UQC for the amendment HSN evidence: " + row.uqc);
      const registered = hsnSide(snapshot) === "b2b", key = JSON.stringify([registered, row.hsnSac, uqc, row.gstRateBps]);
      const group = aggregate(amendmentHsn, key, { registered, code: row.hsnSac, name: entry?.description || row.description || row.hsnSac, uqc, rate: row.gstRateBps, quantity: 0n });
      accumulate(group, { ...zero(), ...row }, effect);
      group.quantity += BigInt(effect) * quantityMicros(row.quantity, true);
    }
  }
  for (const record of records.filter(row => row.originalPeriod === month)) {
    const snapshot = record.originalReported, doc = all.get(record.invoiceId);
    const section = snapshot.section === "b2b" ? "b2b,sez,de" : snapshot.section;
    sheets[section].push(...reportedWorksheet(snapshot));
    accumulate(summary[amendmentBucket(snapshot)], snapshot.totals, amendmentSign(snapshot));
    if (snapshot.hsnRows?.length) addAmendmentHsn(snapshot, amendmentSign(snapshot), doc);
    else {
      const review = { id: record.invoiceId, invoiceId: record.invoiceId, number: snapshot.number, code: "original-hsn-evidence", amendmentId: record.id,
        message: "Supply the explicit per-document originally reported HSN, UQC, quantities and values before reconciling this original return allocation in Table 12." };
      amendments.hsnIssues.push(review); checks.push(review);
    }
  }
  for (const record of records.filter(row => row.amendmentPeriod === month)) {
    sheets[record.section].push(...amendmentWorksheet(record));
    const original = record.originalReported, revised = record.revised, doc = all.get(record.invoiceId);
    for (const [snapshot, multiplier] of [[original, -1], [revised, 1]]) {
      const effect = multiplier * amendmentSign(snapshot);
      accumulate(amendmentBuckets[amendmentBucket(snapshot)], snapshot.totals, effect);
      const side = hsnSide(snapshot);
      const expected = amendmentDetail[side] + effect * snapshot.totals.taxablePaise;
      if (!Number.isSafeInteger(expected)) throw new Error("Amendment HSN reconciliation exceeds exact paise");
      amendmentDetail[side] = expected;
    }
    if (!original.hsnRows?.length || !revised.hsnRows?.length) {
      const review = { id: record.invoiceId, invoiceId: record.invoiceId, number: revised.number, code: "amendment-hsn-evidence", amendmentId: record.id,
        message: "Supply the explicit per-document originally reported HSN, UQC, quantities and values before reconciling this amendment in Table 12. A zero liability difference does not establish unchanged HSN particulars." };
      amendments.hsnIssues.push(review); checks.push(review);
    } else {
      addAmendmentHsn(original, -amendmentSign(original), doc);
      addAmendmentHsn(revised, amendmentSign(revised), doc);
    }
  }
  for (const [key, change] of amendmentHsn) {
    if (change.quantity === 0n && amounts.every(field => change[field] === 0)) continue;
    const group = aggregate(hsn, key, { registered: change.registered, code: change.code, name: change.name, uqc: change.uqc, rate: change.rate, quantity: 0n });
    accumulate(group, change); group.quantity += change.quantity;
  }
  for (const [bucket, difference] of Object.entries(amendmentBuckets)) {
    accumulate(summary[bucket], difference); accumulate(amendments.difference, difference);
    if (bucket !== "outwardRcm") accumulate(amendments.liabilityDifference, difference);
  }
  for (const value of [amendments.difference, amendments.liabilityDifference, ...Object.values(amendmentBuckets)]) {
    value.taxPaise = value.igstPaise + value.cgstPaise + value.sgstPaise + value.utgstPaise + value.cessPaise;
    if (!Number.isSafeInteger(value.taxPaise)) throw new Error("Amendment tax exceeds exact paise");
  }
  for (const r of b2cs.values()) sheets.b2cs.push(["OE",r.pos,r.rate,"",rupees(r.taxablePaise),rupees(r.cessPaise),""]);
  for (const [label,b] of exempt) sheets.exemp.push([label,rupees(b.nil),rupees(b.exempt),rupees(b.nongst)]);
  for (const h of hsn.values()) sheets[h.registered ? "hsn(b2b)" : "hsn(b2c)"].push([h.code,h.name,h.uqc,formatQuantity(h.quantity),rupees(h.totalPaise),rupees(h.taxablePaise),rupees(h.igstPaise),rupees(h.cgstPaise),rupees(h.sgstPaise+h.utgstPaise),rupees(h.cessPaise),h.rate/100]);
  for (const {docType,numbers} of series.values()) {
    numbers.sort((a,b)=>a.localeCompare(b,"en",{numeric:true}));
    let start = 0;
    for (let index = 1; index <= numbers.length; index++) {
      const previous = numbers[index-1].match(/\d+$/)?.[0], next = numbers[index]?.match(/\d+$/)?.[0];
      if (previous && next && BigInt(next) === BigInt(previous) + 1n) continue;
      sheets.docs.push([docType,numbers[start],numbers[index-1],index-start,0]);
      start = index;
    }
  }
  const reconciliation = hsnReconciliation(sheets, amendmentDetail);
  return { month, itc, amendments, bookSummary, hsnCheck: { complete: !checks.length && !amendments.hsnIssues.length && reconciliation.every(row => row.differencePaise === 0),
    reconciliation, amendmentDifference: amendmentDetail, yearBand: profile?.band || null, minimumDigits: minDigits, checks }, rcmRows: rcm.rows,
    registration: { id: registration.id, name: registration.name, gstin: registration.gstin }, summary, evidence, issues, sheets };
}

export function worksheetCsv(name, sheet) {
  const fields = columns[name];
  if (!fields || !Array.isArray(sheet)) throw new Error("Unknown GST worksheet");
  function cell(value) {
    let text = String(value ?? "");
    if (/^[=+@\t\r]/.test(text) || (/^-/.test(text) && !/^-\d+(\.\d+)?$/.test(text))) text = "'" + text;
    return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"','""') + '"' : text;
  }
  return [fields,...sheet].map(row=>row.map(cell).join(",")).join("\r\n") + "\r\n";
}
