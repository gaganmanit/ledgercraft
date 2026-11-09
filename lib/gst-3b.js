// GSTR-3B working: the figures a CA types or uploads for one return, ending in
// the cash payable. Supply and credit buckets come from the same month working
// as the GSTR-1 export (returnWorkbook), so the two never disagree.
//
// Statutory basis, by table:
//  - Form GSTR-3B under rule 61 of the CGST Rules, 2017; table labels as revised
//    by GSTN's advisory of 02-09-2022 and CBIC Circular 170/02/2022-GST.
//  - Table 6 utilisation: section 49(5) and section 49A of the CGST Act, and
//    rule 88A of the CGST Rules (Notification 16/2019-Central Tax). Reverse-charge
//    tax is paid in cash only: section 49(4) read with the definition of output tax
//    in section 2(82), which excludes tax payable on reverse charge.
//  - Interest: section 50(1) (18% a year, Notification 13/2017-Central Tax), on the
//    portion paid through the electronic cash ledger (proviso to section 50(1),
//    rule 88B(1)); amounts credited to the cash ledger by the due date and lying
//    there until debit are excluded (proviso to rule 88B(1), Notification
//    12/2024-Central Tax, from 10-07-2024). Section 50(3) interest on credit
//    wrongly availed and utilised runs at 18%, not 24%: Notification 13/2017 was
//    amended with effect from 01-07-2017 by section 116 of the Finance Act, 2022
//    (in force through Notification 9/2022-Central Tax); period under rule 88B(3).
//  - Late fee: section 47(1) with Notification 19/2021-Central Tax (tax periods from
//    June 2021): Rs 25 CGST + Rs 25 SGST a day (Rs 10 + Rs 10 when the tax payable
//    is nil), capped per head at Rs 250 (nil), Rs 1,000 (preceding-year aggregate
//    turnover up to Rs 1.5 crore), Rs 2,500 (up to Rs 5 crore), Rs 5,000 (above).
//  - Due dates: section 39(1) with rule 61(5): the 20th of the following month for
//    monthly filers; for quarterly (QRMP) filers the 22nd or 24th of the month after
//    the quarter, by State group (Notification 82/2020-Central Tax).
//  - Interest, late fee and tax are rounded to the nearest rupee only where
//    section 170 requires it: interest and late fee here; tax stays in exact paise.
import { returnWorkbook } from "./gst-returns.js";
import { activeOutwardAmendments } from "./gst-outward-amendments.js";
import { turnoverFor } from "./gst-turnover.js";
import { gstinType, partyIdentifierType, GST_STATES } from "./gst.js";
import { isIsoDate } from "./money.js";

export const GSTR3B_HEADS = ["igst", "cgst", "sgst", "cess"];
const SUPPLY_FIELDS = ["taxablePaise", "igstPaise", "cgstPaise", "sgstPaise", "cessPaise"];
export const GSTR3B_SOURCES = [
  { title: "GSTN: GSTR-3B save/file API payload (sup_details, inter_sup, itc_elg, inward_sup, intr_ltfee)", url: "https://developer.sandbox.co.in/api-reference/gst/compliance/endpoints/taxpayer/gstr-3b/save" },
  { title: "GSTN: Changes in Table 4 of GSTR-3B (02-09-2022)", url: "https://tutorial.gst.gov.in/downloads/news/advisory_of_label_change_in_GSTR_3B_02_09_2022.pdf" },
  { title: "CBIC Circular 170/02/2022-GST: Table 4 reporting", url: "https://cbic-gst.gov.in/pdf/Circular-170-02-2022-GST.pdf" },
  { title: "CBIC Notification 19/2021-Central Tax: GSTR-3B late fee", url: "https://cbic-gst.gov.in/pdf/central-tax/2021/notfctn-19-central-tax-english-2021.pdf" },
  { title: "CBIC Notification 9/2022-Central Tax and Finance Act 2022 s.116: 18% under section 50(3)", url: "https://cbic-gst.gov.in/pdf/central-tax/2022/notfctn-09-central-tax-english-2022.pdf" },
  { title: "CBIC Notification 12/2024-Central Tax: proviso to rule 88B(1)", url: "https://cbic-gst.gov.in/pdf/central-tax/2024/notfctn-12-central-tax-english-2024.pdf" },
  { title: "CBIC Notification 82/2020-Central Tax: rule 61(5) QRMP due dates", url: "https://cbic-gst.gov.in/pdf/central-tax/2020/notfctn-82-central-tax-english-2020.pdf" },
];
// Proviso to rule 61(5) (Notification 82/2020-CT): QRMP GSTR-3B due on the 22nd
// for these States and UTs, and on the 24th for the rest. "Other Territory" (97)
// is in neither list; the earlier date is used so the fee is never understated.
const QRMP_22 = new Set(["22", "23", "24", "25", "26", "27", "29", "30", "31", "32", "33", "34", "35", "36", "37", "97"]);
const CASH_LEDGER_RELIEF_FROM = "2024-07-10";
const LATE_FEE_RULES_FROM = "2021-06";
const RATE_50_1_BPS = 1800, RATE_50_3_BPS = 1800;
const RUPEE = 100;
const stateNames = new Map(GST_STATES.map(s => [s.code, s.name]));

function exact(n) {
  if (!Number.isSafeInteger(n)) throw new Error("GSTR-3B amounts exceed the exact paise limit");
  return n;
}
export const heads = (source = {}) => Object.fromEntries(GSTR3B_HEADS.map(h => [h + "Paise", source[h + "Paise"] || 0]));
const supply = () => Object.fromEntries(SUPPLY_FIELDS.map(k => [k, 0]));
function add(target, source, sign = 1) {
  for (const key of Object.keys(target)) target[key] = exact(target[key] + sign * (source[key] || 0));
  return target;
}
const sumHeads = value => exact(GSTR3B_HEADS.reduce((s, h) => s + value[h + "Paise"], 0));
/** A workbook bucket (separate SGST and UTGST) as one GSTR-3B row; State/UT tax is one column. */
function bucket(source) {
  return { taxablePaise: source.taxablePaise, igstPaise: source.igstPaise, cgstPaise: source.cgstPaise, sgstPaise: exact(source.sgstPaise + source.utgstPaise), cessPaise: source.cessPaise };
}
function amountHeads(input, label, allowed = GSTR3B_HEADS) {
  const result = heads();
  if (input === undefined || input === null) return result;
  if (typeof input !== "object" || Array.isArray(input)) throw new Error(`Enter ${label} by tax head`);
  for (const [key, value] of Object.entries(input)) {
    const head = key.replace(/Paise$/, "");
    if (!GSTR3B_HEADS.includes(head)) throw new Error(`Unknown tax head in ${label}: ${key}`);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Enter ${label} as nonnegative whole paise`);
    if (value && !allowed.includes(head)) throw new Error(`${label} has no ${head.toUpperCase()} component`);
    result[head + "Paise"] = value;
  }
  return result;
}
function optionalDate(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (!isIsoDate(value)) throw new Error(`Enter ${label} as a valid date`);
  return value;
}
const dayNumber = iso => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000;
/** Days from `from` to `to`: the day after `from` is day one. Never negative. */
export const daysAfter = (from, to) => Math.max(0, dayNumber(to) - dayNumber(from));
function shiftMonth(month, by) {
  const n = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by;
  return `${Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, "0")}`;
}
/** Section 170: interest and fees are rounded to the nearest rupee, half up. */
const roundRupee = paise => exact(Math.floor((paise + RUPEE / 2) / RUPEE) * RUPEE);

/** Due date of GSTR-3B for `month` (the last month of the quarter when quarterly). */
export function gstr3bDueDate(month, frequency = "monthly", stateCode = "") {
  const next = shiftMonth(month, 1);
  if (frequency === "monthly") return next + "-20";
  return next + (QRMP_22.has(stateCode) ? "-22" : "-24");
}

/**
 * Table 6 utilisation of the electronic credit ledger against forward-charge
 * liability, following section 49(5), section 49A and rule 88A:
 *  1. IGST credit against IGST;
 *  2. the rest of the IGST credit against CGST and SGST/UTGST in any order and
 *     proportion (rule 88A), and fully before CGST or SGST credit is used (s.49A).
 *     The part of each head its own credit cannot meet is filled first, so the
 *     least cash is paid;
 *  3. CGST credit against CGST, SGST/UTGST credit against SGST/UTGST;
 *  4. CGST credit against IGST, then SGST/UTGST credit against IGST only where no
 *     CGST credit is left for it (proviso to s.49(5)(d));
 *  5. cess credit against cess only (section 11(2), GST (Compensation to States) Act).
 * CGST credit never pays SGST/UTGST and vice versa (s.49(5)(e), (f)).
 */
export function utiliseCredit(liability, credit) {
  const due = Object.fromEntries(GSTR3B_HEADS.map(h => [h, liability[h + "Paise"] || 0]));
  const left = Object.fromEntries(GSTR3B_HEADS.map(h => [h, credit[h + "Paise"] || 0]));
  for (const h of GSTR3B_HEADS) if (due[h] < 0 || left[h] < 0) throw new Error("Credit utilisation needs nonnegative liability and credit");
  const steps = [];
  const take = (from, to, limit = Infinity) => {
    const paise = Math.min(left[from], due[to], limit);
    if (paise <= 0) return;
    left[from] -= paise; due[to] -= paise;
    const prior = steps.find(s => s.from === from && s.to === to);
    if (prior) prior.paise += paise; else steps.push({ from, to, paise });
  };
  take("igst", "igst");
  take("igst", "cgst", Math.max(0, due.cgst - left.cgst));
  take("igst", "sgst", Math.max(0, due.sgst - left.sgst));
  take("igst", "cgst"); take("igst", "sgst");
  take("cgst", "cgst"); take("sgst", "sgst");
  take("cgst", "igst"); take("sgst", "igst");
  take("cess", "cess");
  const used = Object.fromEntries(GSTR3B_HEADS.map(from => [from, Object.fromEntries(GSTR3B_HEADS.map(to => [to + "Paise", steps.find(s => s.from === from && s.to === to)?.paise || 0]))]));
  return {
    steps,
    used,
    creditUsedPaise: heads(Object.fromEntries(GSTR3B_HEADS.map(h => [h + "Paise", (credit[h + "Paise"] || 0) - left[h]]))),
    paidByCreditPaise: heads(Object.fromEntries(GSTR3B_HEADS.map(h => [h + "Paise", (liability[h + "Paise"] || 0) - due[h]]))),
    cashPaise: heads(Object.fromEntries(GSTR3B_HEADS.map(h => [h + "Paise", due[h]]))),
    creditBalancePaise: heads(Object.fromEntries(GSTR3B_HEADS.map(h => [h + "Paise", left[h]]))),
  };
}

/** Simple interest per head in paise for `days` at `rateBps` a year on a 365-day year, rounded to the rupee (s.170). */
export function simpleInterest(basePaise, rateBps, days) {
  const result = heads();
  for (const h of GSTR3B_HEADS) {
    const base = BigInt(basePaise[h + "Paise"] || 0);
    if (base <= 0n || days <= 0) continue;
    const numerator = base * BigInt(rateBps) * BigInt(days);
    const denominator = 10000n * 365n;
    result[h + "Paise"] = roundRupee(Number((numerator * 2n + denominator) / (denominator * 2n)));
  }
  return result;
}

/**
 * Section 47 late fee for a GSTR-3B with Notification 19/2021-CT. `turnover`
 * is { paise } (exact preceding-year aggregate turnover) or { band } from the
 * saved turnover profile ("up-to-5cr", "above-5cr") or null.
 */
export function lateFeeUnderSection47({ month, dueDate, filingDate, nil, turnover }) {
  const base = { applicable: false, days: 0, nil, perDayPaise: { cgstPaise: 0, sgstPaise: 0 }, capPaise: { cgstPaise: 0, sgstPaise: 0 }, slab: null, cgstPaise: 0, sgstPaise: 0, totalPaise: 0, issues: [] };
  if (!filingDate) return { ...base, issues: ["Enter the filing date to compute the section 47 late fee"] };
  const days = daysAfter(dueDate, filingDate);
  if (!days) return { ...base, days };
  if (month < LATE_FEE_RULES_FROM) return { ...base, days, applicable: null, issues: ["Late fee for tax periods before June 2021 follows earlier waiver notifications and is not computed here"] };
  const issues = [];
  let slab;
  if (nil) slab = "nil";
  else if (turnover?.paise !== undefined) slab = turnover.paise <= 1_50_00_000 * RUPEE ? "up-to-1.5cr" : turnover.paise <= 5_00_00_000 * RUPEE ? "up-to-5cr" : "above-5cr";
  else if (turnover?.band === "above-5cr") slab = "above-5cr";
  else if (turnover?.band === "up-to-5cr") {
    slab = "up-to-5cr";
    issues.push("The saved turnover band does not show whether turnover was up to Rs 1.5 crore. The Rs 5,000 cap is used; enter the preceding year's aggregate turnover for the Rs 2,000 cap");
  } else {
    slab = "above-5cr";
    issues.push("No preceding-year aggregate turnover is recorded. The highest cap (Rs 10,000) is used until it is entered");
  }
  const perHeadDay = (nil ? 10 : 25) * RUPEE;
  const cap = { "nil": 250, "up-to-1.5cr": 1000, "up-to-5cr": 2500, "above-5cr": 5000 }[slab] * RUPEE;
  const each = Math.min(exact(perHeadDay * days), cap);
  return { applicable: true, days, nil, perDayPaise: { cgstPaise: perHeadDay, sgstPaise: perHeadDay }, capPaise: { cgstPaise: cap, sgstPaise: cap }, slab,
    cgstPaise: each, sgstPaise: each, totalPaise: exact(each * 2), issues };
}

function periodMonths(month, frequency) {
  if (frequency === "monthly") return [month];
  if (!["03", "06", "09", "12"].includes(month.slice(5))) throw new Error("A quarterly GSTR-3B is prepared for the last month of the quarter (June, September, December or March)");
  return [shiftMonth(month, -2), shiftMonth(month, -1), month];
}
const partyOf = (company, doc) => company.gst?.parties?.find(p => p.id === doc.partyId) || null;
// compositionDealer is a party-master flag (true for a recipient or supplier
// registered under section 10). It is read only; the party form owns saving it.
const isComposition = (company, doc) => Boolean(doc.party?.compositionDealer || partyOf(company, doc)?.compositionDealer);

/** Table 3.2: inter-State supplies of Table 3.1(a) to unregistered persons, composition taxable persons and UIN holders by place of supply. */
function table32Rows(company, vouchers, registration, months, books) {
  const groups = { unregistered: new Map(), composition: new Map(), uin: new Map() };
  const amended = activeOutwardAmendments(company, vouchers).filter(r => r.registrationId === registration.id);
  const amendedIds = new Set(amended.map(r => r.invoiceId));
  const held = new Set(books.flatMap(book => book.creditReviews.filter(r => r.eligible === false).map(r => r.id)));
  const docs = new Map(vouchers.filter(v => v.gst).map(v => [v.gst.id, v.gst]));
  const addTo = (kind, pos, taxablePaise, igstPaise) => {
    const map = groups[kind];
    if (!map.has(pos)) map.set(pos, { pos, posName: stateNames.get(pos) || pos, taxablePaise: 0, igstPaise: 0 });
    const row = map.get(pos);
    row.taxablePaise = exact(row.taxablePaise + taxablePaise); row.igstPaise = exact(row.igstPaise + igstPaise);
  };
  const recipientKind = (gstin, doc) => {
    if (!gstin) return "unregistered";
    if ((doc && partyIdentifierType(doc.party) === "uin") || gstinType(gstin) === "uin") return "uin";
    if (doc && isComposition(company, doc)) return "composition";
    return null;
  };
  for (const v of vouchers) {
    const doc = v.gst;
    if (!doc || doc.registrationId !== registration.id || doc.direction !== "sales" || !months.some(m => v.date.startsWith(m))) continue;
    if (doc.reverseCharge || doc.supplyCategory !== "domestic" || doc.placeOfSupply === registration.stateCode) continue;
    if (amendedIds.has(doc.id) || held.has(doc.id)) continue;
    const kind = recipientKind(doc.party?.gstin, doc);
    if (!kind) continue;
    const sign = doc.type === "Credit Note" ? -1 : 1;
    for (const line of doc.items) if (line.supplyStatus === "taxable") addTo(kind, doc.placeOfSupply, sign * line.taxablePaise, sign * line.igstPaise);
  }
  // Declared prior-filed figures replace the book document in its original period;
  // an amendment period carries the signed difference, as in Table 3.1(a).
  const addSnapshot = (snapshot, effect, invoiceId) => {
    if (snapshot.reverseCharge || snapshot.section === "exp" || snapshot.invoiceType?.startsWith("SEZ ") || snapshot.placeOfSupply === registration.stateCode) return;
    const kind = recipientKind(snapshot.recipientGstin, docs.get(invoiceId));
    if (!kind) return;
    const sign = effect * (snapshot.noteType === "C" ? -1 : 1);
    addTo(kind, snapshot.placeOfSupply, sign * snapshot.totals.taxablePaise, sign * snapshot.totals.igstPaise);
  };
  for (const book of books) {
    for (const record of amended.filter(r => r.originalPeriod === book.month)) addSnapshot(record.originalReported, 1, record.invoiceId);
    for (const row of book.amendments.rows.filter(r => !r.heldReason)) { addSnapshot(row.originalReported, -1, row.invoiceId); addSnapshot(row.revised, 1, row.invoiceId); }
  }
  const list = map => [...map.values()].filter(r => r.taxablePaise || r.igstPaise).sort((a, b) => a.pos.localeCompare(b.pos));
  const result = { unregistered: list(groups.unregistered), composition: list(groups.composition), uin: list(groups.uin) };
  result.totals = Object.fromEntries(Object.entries(result).map(([k, rows]) => [k, rows.reduce((s, r) => ({ taxablePaise: exact(s.taxablePaise + r.taxablePaise), igstPaise: exact(s.igstPaise + r.igstPaise) }), { taxablePaise: 0, igstPaise: 0 })]));
  return result;
}

/** Table 5: inward exempt, nil-rated and non-GST supplies, and all supplies from composition suppliers. */
function table5Rows(company, vouchers, registration, months) {
  const rows = { gst: { interPaise: 0, intraPaise: 0 }, nonGst: { interPaise: 0, intraPaise: 0 } };
  const documents = [];
  for (const v of vouchers) {
    const doc = v.gst;
    if (!doc || doc.registrationId !== registration.id || doc.direction !== "purchase" || doc.reverseCharge || !months.some(m => v.date.startsWith(m))) continue;
    const master = partyOf(company, doc);
    const supplierState = doc.party?.stateCode || master?.stateCode || doc.party?.gstin?.slice(0, 2) || "";
    const inter = supplierState ? supplierState !== doc.placeOfSupply : doc.placeOfSupply !== registration.stateCode;
    const composition = isComposition(company, doc), sign = doc.type === "Credit Note" ? -1 : 1;
    let counted = 0;
    for (const line of doc.items) {
      const row = line.supplyStatus === "non-gst" ? rows.nonGst : composition || ["exempt", "nil-rated"].includes(line.supplyStatus) ? rows.gst : null;
      if (!row) continue;
      // A composition supplier's bill of supply carries no tax; its value is the line total.
      const value = sign * (composition ? line.totalPaise : line.taxablePaise);
      row[inter ? "interPaise" : "intraPaise"] = exact(row[inter ? "interPaise" : "intraPaise"] + value);
      counted = exact(counted + value);
    }
    if (counted) documents.push({ id: doc.id, number: doc.number, date: doc.date, party: doc.party?.name, inter, composition, valuePaise: counted });
  }
  return { ...rows, totals: { interPaise: exact(rows.gst.interPaise + rows.nonGst.interPaise), intraPaise: exact(rows.gst.intraPaise + rows.nonGst.intraPaise) }, documents };
}

export function normalizeGstr3bOptions(options = {}) {
  const frequency = options.frequency || "monthly";
  if (!["monthly", "quarterly"].includes(frequency)) throw new Error("Choose a monthly or quarterly GSTR-3B");
  const aggregateTurnoverPaise = options.aggregateTurnoverPaise ?? null;
  if (aggregateTurnoverPaise !== null && (!Number.isSafeInteger(aggregateTurnoverPaise) || aggregateTurnoverPaise < 0)) throw new Error("Enter the preceding year's aggregate turnover in whole paise");
  return {
    frequency,
    dueDate: optionalDate(options.dueDate, "the extended due date"),
    paymentDate: optionalDate(options.paymentDate, "the payment date"),
    filingDate: optionalDate(options.filingDate, "the filing date"),
    cashLedgerDate: optionalDate(options.cashLedgerDate, "the date the cash ledger balance was credited"),
    openingCashLedgerPaise: amountHeads(options.openingCashLedgerPaise, "the electronic cash ledger balance"),
    openingCreditLedgerPaise: amountHeads(options.openingCreditLedgerPaise, "the electronic credit ledger balance"),
    itcReversalPaise: amountHeads(options.itcReversalPaise, "the wrongly availed and utilised credit"),
    itcUtilisedDate: optionalDate(options.itcUtilisedDate, "the date the wrongly availed credit was utilised"),
    itcReversalDate: optionalDate(options.itcReversalDate, "the date the wrongly availed credit was reversed"),
    itcImportGoodsPaise: amountHeads(options.itcImportGoodsPaise, "credit on imported goods", ["igst", "cess"]),
    itcIsdPaise: amountHeads(options.itcIsdPaise, "credit from an input service distributor"),
    aggregateTurnoverPaise,
  };
}

export function gstr3bWorking(company, vouchers, registrationId, month, rawOptions = {}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) throw new Error("Choose a valid return month");
  const registration = company.gst?.registrations?.find(r => r.id === registrationId);
  if (!registration) throw new Error("Select a GST registration for this company");
  const options = normalizeGstr3bOptions(rawOptions);
  const months = periodMonths(month, options.frequency);
  const books = months.map(m => returnWorkbook(company, vouchers, registrationId, m));
  const issues = [];
  const seen = new Set();
  const issue = entry => { const key = JSON.stringify(entry); if (!seen.has(key)) { seen.add(key); issues.push(entry); } };
  for (const book of books) for (const entry of [...book.issues, ...book.itc.issues]) issue(entry);

  const totals = {};
  for (const key of ["outwardTaxable", "zeroRated", "nilExempt", "nonGst", "inwardRcm", "rcmImportCredit", "rcmDomesticCredit", "rcmPermanentReversals", "rcmTemporaryReversals", "rcmReviewReversals"]) {
    totals[key] = supply();
    for (const book of books) add(totals[key], bucket(book.summary[key]));
  }
  const itcTable = {};
  for (const key of ["4A(5)", "4B(1)", "4B(2)", "4D(1)", "4D(2)"]) {
    itcTable[key] = heads();
    for (const book of books) add(itcTable[key], heads(bucket({ ...book.itc.table4[key], taxablePaise: 0 })));
  }

  const row = (label, value) => ({ label, ...value });
  const table31 = {
    a: row("Outward taxable supplies (other than zero rated, nil rated and exempted)", totals.outwardTaxable),
    b: row("Outward taxable supplies (zero rated)", totals.zeroRated),
    c: row("Other outward supplies (nil rated, exempted)", totals.nilExempt),
    d: row("Inward supplies (liable to reverse charge)", totals.inwardRcm),
    e: row("Non-GST outward supplies", totals.nonGst),
  };
  const table32 = table32Rows(company, vouchers, registration, months, books);
  if (books.some(book => book.amendments.rows.some(r => r.heldReason))) issue({ reason: "A held outward amendment is left out of Table 3.2 until its credit review is complete" });

  const A = {
    importGoods: row("(1) Import of goods", options.itcImportGoodsPaise),
    importServices: row("(2) Import of services", heads(totals.rcmImportCredit)),
    inwardRcm: row("(3) Inward supplies liable to reverse charge (other than 1 and 2)", heads(totals.rcmDomesticCredit)),
    isd: row("(4) Inward supplies from ISD", options.itcIsdPaise),
    allOther: row("(5) All other ITC", itcTable["4A(5)"]),
  };
  const B = {
    rules: row("(1) As per rules 38, 42 and 43 of CGST Rules and section 17(5)", add(heads(itcTable["4B(1)"]), heads(totals.rcmPermanentReversals))),
    others: row("(2) Others", add(add(heads(itcTable["4B(2)"]), heads(totals.rcmTemporaryReversals)), heads(totals.rcmReviewReversals))),
  };
  const totalA = Object.values(A).reduce((s, r) => add(s, heads(r)), heads());
  const totalB = Object.values(B).reduce((s, r) => add(s, heads(r)), heads());
  const net = add(heads(totalA), totalB, -1);
  const table4 = {
    A: { ...A, total: totalA }, B: { ...B, total: totalB },
    C: row("Net ITC available (A) - (B)", net),
    D: {
      reclaimed: row("(1) ITC reclaimed which was reversed under Table 4(B)(2) in earlier tax period", itcTable["4D(1)"]),
      restricted: row("(2) Ineligible ITC under section 16(4) and ITC restricted due to PoS rules", itcTable["4D(2)"]),
    },
    provisional: books.some(book => book.itc.provisional),
  };
  if (table4.provisional) issue({ reason: "Unclassified reverse-charge reversals are treated as Table 4(B)(2) reversals until classified" });
  const table5 = table5Rows(company, vouchers, registration, months);

  // Table 6.1. Forward-charge liability is 3.1(a) and 3.1(b); a negative net
  // credit in 4(C) is payable as liability of that head (GSTN advisory on negative
  // ITC, 02-09-2022). Negative liability cannot be carried here; it is reported.
  const forward = add(heads(totals.outwardTaxable), heads(totals.zeroRated));
  const negativeItc = heads(Object.fromEntries(GSTR3B_HEADS.map(h => [h + "Paise", Math.max(0, -net[h + "Paise"])])));
  const forwardDue = add(heads(forward), negativeItc);
  const negativeLiability = heads();
  const reverseCharge = heads(totals.inwardRcm);
  for (const h of GSTR3B_HEADS) {
    const key = h + "Paise";
    if (forwardDue[key] < 0) { negativeLiability[key] = -forwardDue[key]; forwardDue[key] = 0; }
    if (reverseCharge[key] < 0) { negativeLiability[key] = exact(negativeLiability[key] - reverseCharge[key]); reverseCharge[key] = 0; }
  }
  if (sumHeads(negativeLiability)) issue({ reason: "Credit notes exceed this period's liability for a tax head. The excess is not set off here; carry it in the GSTN negative liability statement" });
  const creditAvailable = add(heads(options.openingCreditLedgerPaise), heads(Object.fromEntries(GSTR3B_HEADS.map(h => [h + "Paise", Math.max(0, net[h + "Paise"])]))));
  const use = utiliseCredit(forwardDue, creditAvailable);
  const cashTax = add(heads(use.cashPaise), reverseCharge);
  const cashToDeposit = heads(Object.fromEntries(GSTR3B_HEADS.map(h => [h + "Paise", Math.max(0, cashTax[h + "Paise"] - options.openingCashLedgerPaise[h + "Paise"])])));
  const table6 = {
    liability: { forwardCharge: forward, negativeItc, forwardDue, reverseCharge, total: add(heads(forwardDue), reverseCharge), negativeLiability },
    creditAvailable, openingCreditLedger: options.openingCreditLedgerPaise, utilisation: use.steps, creditUtilised: use.used,
    paidByCredit: use.paidByCreditPaise, cashTax: { forwardCharge: use.cashPaise, reverseCharge, total: cashTax },
    openingCashLedger: options.openingCashLedgerPaise, cashToDeposit, creditBalanceCarried: use.creditBalancePaise,
  };

  const dueDate = options.dueDate || gstr3bDueDate(month, options.frequency, registration.stateCode);
  const paidOn = options.paymentDate || options.filingDate;
  const days = paidOn ? daysAfter(dueDate, paidOn) : 0;
  if (!paidOn) issue({ reason: "Enter the payment or filing date to compute interest and late fee" });
  // Proviso to rule 88B(1): cash credited by the due date and lying in the ledger
  // until debited earns no interest. Applied to filings from 10-07-2024 only; the
  // GSTAT has treated the proviso as prospective.
  const relief = Boolean(options.cashLedgerDate && options.cashLedgerDate <= dueDate && (options.filingDate || paidOn || "") >= CASH_LEDGER_RELIEF_FROM);
  if (options.cashLedgerDate && !relief && sumHeads(options.openingCashLedgerPaise)) issue({ reason: "The cash ledger balance was not credited by the due date or the return precedes 10-07-2024, so it does not reduce interest" });
  const interestBase = heads(Object.fromEntries(GSTR3B_HEADS.map(h => [h + "Paise", relief ? Math.max(0, cashTax[h + "Paise"] - options.openingCashLedgerPaise[h + "Paise"]) : cashTax[h + "Paise"]])));
  const late = simpleInterest(interestBase, RATE_50_1_BPS, days);
  const reversalFrom = options.itcUtilisedDate || options.filingDate || dueDate;
  const reversalTo = options.itcReversalDate || options.paymentDate || options.filingDate;
  const reversalDays = sumHeads(options.itcReversalPaise) && reversalTo ? daysAfter(reversalFrom, reversalTo) : 0;
  if (sumHeads(options.itcReversalPaise) && !reversalTo) issue({ reason: "Enter the date the wrongly availed credit was reversed to compute section 50(3) interest" });
  const wrongCredit = simpleInterest(options.itcReversalPaise, RATE_50_3_BPS, reversalDays);
  const interestTotal = add(heads(late), wrongCredit);
  const interest = {
    section50_1: { rateBps: RATE_50_1_BPS, dueDate, paymentDate: paidOn || null, days, cashLedgerRelief: relief, basePaise: interestBase, interestPaise: late },
    section50_3: { rateBps: RATE_50_3_BPS, fromDate: sumHeads(options.itcReversalPaise) ? reversalFrom : null, toDate: sumHeads(options.itcReversalPaise) ? reversalTo || null : null, days: reversalDays, basePaise: options.itcReversalPaise, interestPaise: wrongCredit },
    totalPaise: interestTotal, total: sumHeads(interestTotal),
  };

  const totalLiability = add(add(heads(forward), heads(totals.inwardRcm)), negativeItc);
  const nil = GSTR3B_HEADS.every(h => totalLiability[h + "Paise"] <= 0);
  const profile = turnoverFor(company, registration, month + "-01");
  const fee = lateFeeUnderSection47({ month, dueDate, filingDate: options.filingDate, nil,
    turnover: options.aggregateTurnoverPaise !== null ? { paise: options.aggregateTurnoverPaise } : profile ? { band: profile.band } : null });
  for (const reason of fee.issues) issue({ reason });
  const { issues: _feeIssues, ...lateFee } = fee;
  lateFee.turnoverBasis = options.aggregateTurnoverPaise !== null ? "entered" : profile ? "saved-band" : "none";

  const cashTaxTotal = sumHeads(cashTax), interestSum = interest.total;
  const depositTax = sumHeads(cashToDeposit);
  const summary = {
    liabilityPaise: sumHeads(table6.liability.total), itcUtilisedPaise: sumHeads(use.paidByCreditPaise),
    cashTaxPaise: cashTaxTotal, interestPaise: interestSum, lateFeePaise: lateFee.totalPaise,
    cashPayableTotalPaise: exact(cashTaxTotal + interestSum + lateFee.totalPaise),
    depositRequiredPaise: exact(depositTax + interestSum + lateFee.totalPaise),
    creditCarriedForwardPaise: sumHeads(use.creditBalancePaise),
    nil,
  };
  return {
    registration: { id: registration.id, name: registration.name, gstin: registration.gstin, stateCode: registration.stateCode },
    month, frequency: options.frequency, months, returnPeriod: month.slice(5) + month.slice(0, 4),
    dueDate, filingDate: options.filingDate, paymentDate: options.paymentDate,
    table31, table32, table4, table5, table6, interest, lateFee, summary, issues, sources: GSTR3B_SOURCES,
  };
}

/** Integer paise to rupees as a JSON number with at most two decimals. */
function rupees(value) {
  exact(value);
  const abs = Math.abs(value);
  return Number((value < 0 ? "-" : "") + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0"));
}
const taxJson = (value, fields = ["txval", "iamt", "camt", "samt", "csamt"]) => {
  const map = { txval: "taxablePaise", iamt: "igstPaise", camt: "cgstPaise", samt: "sgstPaise", csamt: "cessPaise" };
  return Object.fromEntries(fields.map(f => [f, rupees(value[map[f]] || 0)]));
};

/**
 * GSTN GSTR-3B upload JSON. Field names follow the GSTN GSTR-3B save payload as
 * published in the GSTN API (mirrored by GSP documentation, e.g.
 * developer.sandbox.co.in "Save GSTR-3B" and the ReBIT gstr1_3b schema): sup_details,
 * inter_sup, eco_dtls, itc_elg (itc_avl IMPG/IMPS/ISRC/ISD/OTH, itc_rev RUL/OTH,
 * itc_net, itc_inelg RUL/OTH), inward_sup (isup_details GST/NONGST) and intr_ltfee.
 * Table 6 (tx_pmt) is computed by the portal at offset and is not uploaded.
 */
export function gstr3bExport(working) {
  const t31 = working.table31, t4 = working.table4, t5 = working.table5;
  const supplyRows = rows => rows.map(r => ({ pos: r.pos, txval: rupees(r.taxablePaise), iamt: rupees(r.igstPaise) }));
  const itc = (ty, value) => ({ ty, ...taxJson(value, ["iamt", "camt", "samt", "csamt"]) });
  const json = {
    gstin: working.registration.gstin,
    ret_period: working.returnPeriod,
    sup_details: {
      osup_det: taxJson(t31.a),
      osup_zero: taxJson(t31.b, ["txval", "iamt", "csamt"]),
      osup_nil_exmp: taxJson(t31.c, ["txval"]),
      isup_rev: taxJson(t31.d),
      osup_nongst: taxJson(t31.e, ["txval"]),
    },
    inter_sup: { unreg_details: supplyRows(working.table32.unregistered), comp_details: supplyRows(working.table32.composition), uin_details: supplyRows(working.table32.uin) },
    // Table 3.1.1 (section 9(5) e-commerce supplies) is not recorded in these books.
    eco_dtls: { eco_sup: taxJson(supply()), eco_reg_sup: taxJson(supply(), ["txval"]) },
    itc_elg: {
      itc_avl: [itc("IMPG", t4.A.importGoods), itc("IMPS", t4.A.importServices), itc("ISRC", t4.A.inwardRcm), itc("ISD", t4.A.isd), itc("OTH", t4.A.allOther)],
      itc_rev: [itc("RUL", t4.B.rules), itc("OTH", t4.B.others)],
      itc_net: taxJson(t4.C, ["iamt", "camt", "samt", "csamt"]),
      // GSTN kept the RUL/OTH codes when Table 4(D) was relabelled on 02-09-2022:
      // RUL is now 4(D)(1) and OTH is 4(D)(2).
      itc_inelg: [itc("RUL", t4.D.reclaimed), itc("OTH", t4.D.restricted)],
    },
    inward_sup: { isup_details: [
      { ty: "GST", inter: rupees(t5.gst.interPaise), intra: rupees(t5.gst.intraPaise) },
      { ty: "NONGST", inter: rupees(t5.nonGst.interPaise), intra: rupees(t5.nonGst.intraPaise) },
    ] },
    intr_ltfee: {
      intr_details: taxJson(working.interest.totalPaise, ["iamt", "camt", "samt", "csamt"]),
      ltfee_details: { camt: rupees(working.lateFee.cgstPaise), samt: rupees(working.lateFee.sgstPaise) },
    },
  };
  const warnings = [];
  (function walk(value, path) {
    if (typeof value === "number" && value < 0) warnings.push({ path, message: "GSTN does not accept a negative value here" });
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}${Array.isArray(value) ? `[${key}]` : `.${key}`}` : key);
  })(json, "");
  return { json, fileName: `GSTR3B_${working.registration.gstin}_${working.returnPeriod}.json`, warnings };
}

export function gstr3bJson(company, vouchers, registrationId, month, options) {
  return gstr3bExport(gstr3bWorking(company, vouchers, registrationId, month, options));
}

/** Query string to working options. Amounts are rupees ("1500.50"); see the route notes. */
export function gstr3bOptionsFromQuery(params, parseRupees) {
  const paise = name => {
    const raw = params.get(name);
    return raw === null || raw === "" ? 0 : parseRupees(raw);
  };
  const group = (prefix, list = GSTR3B_HEADS) => Object.fromEntries(list.map(h => [h + "Paise", paise(prefix + h[0].toUpperCase() + h.slice(1))]));
  const value = name => params.get(name) || undefined;
  return {
    frequency: value("frequency"), dueDate: value("dueDate"), paymentDate: value("paymentDate"), filingDate: value("filingDate"), cashLedgerDate: value("cashDate"),
    openingCreditLedgerPaise: group("credit"), openingCashLedgerPaise: group("cash"), itcReversalPaise: group("reversal"),
    itcUtilisedDate: value("reversalUtilisedDate"), itcReversalDate: value("reversalDate"),
    itcImportGoodsPaise: group("importGoods", ["igst", "cess"]), itcIsdPaise: group("isd"),
    aggregateTurnoverPaise: params.get("turnover") ? parseRupees(params.get("turnover")) : null,
  };
}
