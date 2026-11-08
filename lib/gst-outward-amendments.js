import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizeGstin, GST_STATES, quantityMicros, formatQuantity, correctionCutoff, isBeyondCorrectionCutoff, isLargeB2c, gstRequestHash, invoiceValuePaise } from './gst.js';
import { fyStart, isIsoDate } from './money.js';
import { exportShippingFields } from './gst-export-particulars.js';

export const AMENDMENT_SOURCES = [
  { title: 'GSTN Returns Offline Tool: 9A/9C amendment fields and identity restrictions', url: 'https://tutorial.gst.gov.in/downloads/invoiceuploadofflineutility.pdf' },
  { title: 'CGST Act section 37: correction cutoff', url: 'https://taxinformation.cbic.gov.in/content-page/explore-act/1000307/1000001' },
  { title: 'CGST Act section 34: credit-note tax reduction cutoff', url: 'https://taxinformation.cbic.gov.in/content-page/explore-act/1000304/1000001' },
  { title: 'Finance Ministry: November deadline applies from FY 2021-22', url: 'https://www.pib.gov.in/PressReleasePage.aspx?PRID=1865179' },
  { title: 'GSTN GSTR-1A FAQ: earlier-period corrections belong in later GSTR-1', url: 'https://tutorial.gst.gov.in/downloads/news/creative_faqs_on_gstr1a_fo_cr25785.pdf' },
];
export const AMENDMENT_SECTIONS = { b2b: 'b2ba', b2cl: 'b2cla', exp: 'expa', cdnr: 'cdnra', cdnur: 'cdnura' };
const HEADS = ['igstPaise', 'cgstPaise', 'sgstPaise', 'utgstPaise', 'cessPaise'];
const AMOUNTS = ['taxablePaise', ...HEADS];
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const REPLAY_INDEX = Symbol('outwardAmendmentReplayIndex');
const zeros = () => Object.fromEntries(AMOUNTS.map(field => [field, 0]));
function exact(value) { if (value > MAX || value < -MAX) throw new Error('The amendment exceeds exact paise'); return Number(value); }
function paise(value) { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Enter amendment amounts in nonnegative safe integer paise'); return value; }
function text(value, label, max = 240, optional = false) {
  if (optional && (value === null || value === undefined)) return '';
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error(`Enter ${label} within ${max} characters`);
  return value.trim();
}
function month(value) { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value || '')) throw new Error('Enter a GST return period as YYYY-MM'); return value; }
function date(value, label) { if (!isIsoDate(value)) throw new Error(`Enter ${label}`); return value; }
function endOfMonth(value) { const end = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)), 0)); return end.toISOString().slice(0, 10); }
function number(value) { const result = text(value, 'the reported document number', 16); if (!/^[A-Za-z0-9][A-Za-z0-9/-]{0,15}$/.test(result)) throw new Error('Use a valid GST document number'); return result; }
function state(value) { const result = String(value || '').padStart(2, '0'); if (!GST_STATES.some(row => row.code === result)) throw new Error('Choose the reported place of supply'); return result; }
function aggregate(target, source, sign = 1) { for (const field of AMOUNTS) target[field] = exact(BigInt(target[field]) + BigInt(source[field] || 0) * BigInt(sign)); return target; }
// Same canonical SHA-256 as invoice request hashes, so saved correction hashes are unchanged.
const digest = gstRequestHash;
const credit = snapshot => snapshot.noteType === 'C' ? -1 : 1;
function rate(value) { if (!Number.isSafeInteger(value) || value < 0 || value > 10000) throw new Error('Enter the reported GST rate in basis points'); return value; }
function normalizeRates(input) {
  if (!Array.isArray(input) || !input.length || input.length > 500) throw new Error('Enter the originally reported rate breakup');
  const rates = new Map();
  for (const row of input) {
    if (row.supplyStatus !== undefined && !['taxable', 'zero-rated'].includes(row.supplyStatus)) throw new Error('Nil-rated, exempt and non-GST reported lines need separate amendment allocations');
    const gstRateBps = rate(row.gstRateBps);
    if (row.taxablePaise === undefined) throw new Error('Enter the reported taxable value for every rate');
    const amounts = Object.fromEntries(AMOUNTS.map(field => [field, paise(row[field] ?? 0)]));
    const target = rates.get(gstRateBps) || { gstRateBps, ...zeros() };
    aggregate(target, amounts); rates.set(gstRateBps, target);
  }
  return [...rates.values()].sort((a, b) => a.gstRateBps - b.gstRateBps);
}
function totals(rates, invoiceValuePaise) {
  const amounts = rates.reduce((sum, row) => aggregate(sum, row), zeros());
  const taxPaise = exact(HEADS.reduce((sum, field) => sum + BigInt(amounts[field]), 0n));
  return { ...amounts, taxPaise, totalPaise: invoiceValuePaise };
}
function normalizeHsn(input, rates, invoiceValuePaise, roundOffPaise = 0) {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input) || !input.length || input.length > 500) throw new Error('Enter explicit per-document reported HSN allocations or leave them unknown');
  const rows = new Map();
  for (const source of input) {
    const hsnSac = text(source.hsnSac, 'the reported HSN/SAC', 8);
    if (!/^(\d{4}|\d{6}|\d{8})$/.test(hsnSac)) throw new Error('Enter a 4, 6 or 8 digit reported HSN/SAC');
    const uqc = text(source.uqc, 'the reported UQC', 16).toUpperCase();
    const gstRateBps = rate(source.gstRateBps);
    const quantity = quantityMicros(source.quantity, true);
    const key = JSON.stringify([hsnSac, uqc, gstRateBps]);
    const row = rows.get(key) || { hsnSac, uqc, gstRateBps, description: text(source.description || '', 'the HSN description', 500, true), _quantity: 0n, ...zeros(), totalPaise: 0 };
    row._quantity += quantity;
    if (row._quantity > MAX) throw new Error('The reported HSN quantity exceeds supported exact micro units');
    aggregate(row, Object.fromEntries(AMOUNTS.map(field => [field, paise(source[field] ?? 0)])));
    row.totalPaise = exact(BigInt(row.totalPaise) + BigInt(paise(source.totalPaise)));
    rows.set(key, row);
  }
  const byRate = new Map();
  for (const row of rows.values()) {
    const sum = byRate.get(row.gstRateBps) || { gstRateBps: row.gstRateBps, ...zeros() };
    aggregate(sum, row); byRate.set(row.gstRateBps, sum);
  }
  if (!isDeepStrictEqual([...byRate.values()].sort((a, b) => a.gstRateBps - b.gstRateBps), rates)) throw new Error('Reported HSN allocations must reconcile to every rate and tax head');
  // HSN total values exclude any declared invoice round-off.
  if (exact([...rows.values()].reduce((sum, row) => sum + BigInt(row.totalPaise), 0n) + BigInt(roundOffPaise)) !== invoiceValuePaise) throw new Error('Reported HSN total values must reconcile to the full reported invoice value');
  return [...rows.values()].sort((a, b) => a.hsnSac.localeCompare(b.hsnSac) || a.uqc.localeCompare(b.uqc) || a.gstRateBps - b.gstRateBps).map(({ _quantity, ...row }) => ({ ...row, quantity: formatQuantity(_quantity) }));
}

export function normalizeReportedSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(AMENDMENT_SECTIONS, input.section)) throw new Error('Choose a supported original reported section');
  const section = input.section;
  const registered = ['b2b', 'cdnr'].includes(section), note = ['cdnr', 'cdnur'].includes(section);
  const recipientGstin = normalizeGstin(input.recipientGstin || '', registered);
  if (!registered && recipientGstin) throw new Error('An unregistered/export reported section cannot contain a recipient GSTIN');
  if (input.reverseCharge !== undefined && typeof input.reverseCharge !== 'boolean') throw new Error('Enter the original reverse-charge flag explicitly');
  if (input.supplyStatus !== undefined && !['taxable', 'zero-rated'].includes(input.supplyStatus)) throw new Error('Nil-rated, exempt and non-GST reports need separate amendment allocations');
  if (input.ecommerceGstin || input.applicableTaxRateBps !== undefined && input.applicableTaxRateBps !== null && input.applicableTaxRateBps !== 10000) throw new Error('E-commerce and differential-rate amendments need a separately supported return treatment');
  const exportType = section === 'exp' ? input.exportType : section === 'cdnur' && /^EXP/.test(input.urType || '') ? input.exportType || (input.urType === 'EXPWP' ? 'WPAY' : 'WOPAY') : null;
  if (exportType !== null && !['WPAY', 'WOPAY'].includes(exportType)) throw new Error('Choose the reported export payment type');
  const urType = section === 'cdnur' ? input.urType : null;
  if (section === 'cdnur' && !['B2CL', 'EXPWP', 'EXPWOP'].includes(urType)) throw new Error('Choose the original unregistered note supply type');
  if (urType?.startsWith('EXP') && exportType !== (urType === 'EXPWP' ? 'WPAY' : 'WOPAY')) throw new Error('Export note supply type and payment type differ');
  const noteType = note ? input.noteType : null;
  if (note && !['C', 'D'].includes(noteType)) throw new Error('Choose the original credit or debit note type');
  const invoiceType = registered ? input.invoiceType || 'Regular B2B' : null;
  if (registered && !['Regular B2B', 'SEZ supplies with payment', 'SEZ supplies without payment'].includes(invoiceType)) throw new Error('Choose a supported regular or SEZ invoice type');
  if (input.reverseCharge === true && (!registered || invoiceType !== 'Regular B2B')) throw new Error('Reverse charge requires the regular registered outward classification');
  const rates = normalizeRates(input.rates);
  const invoiceValuePaise = paise(input.invoiceValuePaise);
  const roundOffPaise = input.roundOffPaise ?? 0;
  if (!Number.isSafeInteger(roundOffPaise) || roundOffPaise < -50 || roundOffPaise > 50) throw new Error('Enter the reported invoice round-off in paise between -50 and +50');
  const result = { section, number: number(input.number), date: date(input.date, 'the original reported document date'),
    recipientGstin, recipientName: text(input.recipientName || '', 'the originally reported recipient name', 240, true),
    placeOfSupply: state(input.placeOfSupply), reverseCharge: input.reverseCharge === true, invoiceType, exportType, urType, noteType, invoiceValuePaise, rates,
    portCode: text(input.portCode || '', 'the reported port code', 20, true), shippingBillNumber: text(input.shippingBillNumber || '', 'the reported shipping bill number', 30, true),
    shippingBillDate: input.shippingBillDate ? date(input.shippingBillDate, 'the reported shipping bill date') : '', totals: totals(rates, invoiceValuePaise) };
  if (exportType === 'WOPAY' && rates.some(row => HEADS.some(field => row[field]))) throw new Error('Export without payment cannot carry reported tax');
  if (exportType !== null && rates.some(row => row.cgstPaise || row.sgstPaise || row.utgstPaise)) throw new Error('Export corrections cannot contain domestic tax heads');
  if (invoiceType === 'SEZ supplies without payment' && rates.some(row => HEADS.some(field => row[field]))) throw new Error('SEZ without payment cannot carry reported tax');
  if (invoiceType?.startsWith('SEZ') && rates.some(row => row.cgstPaise || row.sgstPaise || row.utgstPaise)) throw new Error('SEZ reporting requires interstate tax treatment');
  if (roundOffPaise) result.roundOffPaise = roundOffPaise;
  const hsnRows = normalizeHsn(input.hsnRows, rates, invoiceValuePaise, roundOffPaise);
  if (hsnRows !== undefined) result.hsnRows = hsnRows;
  return result;
}


function outwardClassification(invoice, vouchers, invoiceIndex) {
  if (!invoice || invoice.direction !== 'sales' || !['Sales', 'Credit Note', 'Debit Note'].includes(invoice.type)) throw new Error('Choose an accurate posted outward GST invoice or note');
  if (invoice.ecommerceGstin || invoice.applicableTaxRateBps !== undefined && invoice.applicableTaxRateBps !== null && invoice.applicableTaxRateBps !== 10000) throw new Error('This supply needs a separately supported outward amendment treatment');
  if (!invoice.items?.length || invoice.items.some(item => !['taxable', 'zero-rated'].includes(item.supplyStatus))) throw new Error('Mixed exempt, nil-rated and non-GST invoice amendments need separate section allocations');
  const registered = Boolean(invoice.party.gstin), note = invoice.type !== 'Sales', exported = invoice.supplyCategory === 'export';
  let section, urType = null;
  if (registered) section = note ? 'cdnr' : 'b2b';
  else if (exported) { section = note ? 'cdnur' : 'exp'; if (note) urType = invoice.exportMode === 'lut' ? 'EXPWOP' : 'EXPWP'; }
  else {
    const original = note ? invoiceIndex ? invoiceIndex.get(invoice.originalInvoiceId) : vouchers.find(voucher => voucher.gst?.id === invoice.originalInvoiceId)?.gst : invoice;
    if (!original || !isLargeB2c(original)) throw new Error('B2CS aggregate reporting cannot be corrected with an invoice-level 9A/9C amendment');
    section = note ? 'cdnur' : 'b2cl'; if (note) urType = 'B2CL';
  }
  return { section, urType, note, exported };
}

export function outwardDocumentSnapshot(invoice, vouchers = [], invoiceIndex) {
  const { section, urType, note, exported } = outwardClassification(invoice, vouchers, invoiceIndex);
  const rates = normalizeRates(invoice.items.map(item => ({ gstRateBps: item.gstRateBps, ...Object.fromEntries(AMOUNTS.map(field => [field, item[field]])) })));
  const hsnRows = invoice.items.map(item => ({ hsnSac: item.hsnSac, uqc: item.unit, quantity: note && invoice.stockEffect === 'none' ? '0' : item.quantity,
    gstRateBps: item.gstRateBps, description: item.name, totalPaise: item.totalPaise, ...Object.fromEntries(AMOUNTS.map(field => [field, item[field]])) }));
  return normalizeReportedSnapshot({ section, number: invoice.number, date: invoice.date, recipientGstin: invoice.party.gstin || '', recipientName: invoice.party.name,
    placeOfSupply: invoice.placeOfSupply, invoiceType: invoice.supplyCategory === 'sez' ? invoice.exportMode === 'lut' ? 'SEZ supplies without payment' : 'SEZ supplies with payment' : 'Regular B2B', reverseCharge: invoice.reverseCharge,
    exportType: exported ? invoice.exportMode === 'lut' ? 'WOPAY' : 'WPAY' : null, urType, noteType: note ? invoice.type === 'Credit Note' ? 'C' : 'D' : null,
    invoiceValuePaise: invoiceValuePaise(invoice), ...(invoice.roundOffPaise ? { roundOffPaise: invoice.roundOffPaise } : {}), rates, hsnRows, portCode: invoice.portCode, shippingBillNumber: invoice.shippingBillNumber, shippingBillDate: invoice.shippingBillDate });
}

function originalKey(registrationId, snapshot) {
  const identity = ['b2b', 'cdnr'].includes(snapshot.section) ? [snapshot.recipientGstin, snapshot.number, snapshot.date]
    : snapshot.section === 'b2cl' ? [snapshot.number, snapshot.date, snapshot.placeOfSupply]
      : snapshot.section === 'exp' ? [snapshot.exportType, snapshot.number, snapshot.date] : [snapshot.urType, snapshot.number, snapshot.date];
  return JSON.stringify([registrationId, snapshot.section, ...identity.map(value => typeof value === 'string' ? value.toUpperCase() : value)]);
}
function deltaBetween(reported, revised) {
  const sign = credit(revised);
  const delta = Object.fromEntries([...AMOUNTS, 'taxPaise', 'totalPaise'].map(field => [field, exact((BigInt(revised.totals[field]) - BigInt(reported.totals[field])) * BigInt(sign))]));
  delta.invoiceValuePaise = delta.totalPaise;
  delta.rates = [...new Set([...reported.rates, ...revised.rates].map(row => row.gstRateBps))].sort((a, b) => a - b).map(gstRateBps => {
    const before = reported.rates.find(row => row.gstRateBps === gstRateBps) || zeros();
    const after = revised.rates.find(row => row.gstRateBps === gstRateBps) || zeros();
    return { gstRateBps, ...Object.fromEntries(AMOUNTS.map(field => [field, exact((BigInt(after[field]) - BigInt(before[field])) * BigInt(sign))])) };
  });
  return delta;
}
function evidence(input) {
  if (!input || input.accurateBooksConfirmed !== true || input.reportedSnapshotConfirmed !== true) throw new Error('Confirm the accurate posted document and the originally filed particulars separately');
  return { basis: text(input.basis, 'the reporting-correction basis', 1000), documentReference: text(input.documentReference, 'the reconciliation evidence reference', 500), accurateBooksConfirmed: true, reportedSnapshotConfirmed: true };
}
function filing(input, originalPeriod, reportedSection) {
  if (!input || input.form !== 'GSTR-1' || input.confirmedFiled !== true) throw new Error('Confirm the original filed GSTR-1 and its evidence reference');
  const result = { form: 'GSTR-1', confirmedFiled: true, reference: text(input.reference, 'the original filing reference'), filedDate: date(input.filedDate, 'the original filing date') };
  if (result.filedDate < endOfMonth(originalPeriod)) throw new Error('The original filing date precedes the reported tax period end');
  if (input.source !== undefined) {
    const source = input.source;
    const fileName = text(source?.fileName, 'the original source filename');
    if (/[\\/\r\n\t]/.test(fileName) || ['.', '..'].includes(fileName) || !/^[a-f0-9]{64}$/.test(source.sha256 || '') || !Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > 32 * 1024 * 1024) throw new Error('Invalid original return source filename, digest or size');
    if (source.sourcePeriod !== originalPeriod || source.section !== reportedSection) throw new Error('Original source period or section differs from the declared filing');
    result.source = { fileName, sha256: source.sha256, bytes: source.bytes, documentKey: text(source.documentKey, 'the original source document key', 1000), section: reportedSection, sourcePeriod: originalPeriod };
  }
  return result;
}
function comparable(snapshot) {
  const { recipientName, totals, hsnRows, ...rest } = snapshot;
  return rest;
}

function dispositions(company) {
  const master = company.gst?.outwardAmendments;
  const status = new Map((master?.records || []).map(record => [record.id, { effectiveStatus: 'prepared', filing: null, disposition: null }]));
  for (const event of [...(master?.events || [])].sort((a, b) => a.sequence - b.sequence)) {
    const state = status.get(event.amendmentId);
    if (!state) throw new Error('An amendment disposition references a missing preparation');
    if (!['withdraw', 'record-filing'].includes(event.action)) throw new Error('Invalid outward amendment disposition');
    state.effectiveStatus = event.action === 'withdraw' ? 'withdrawn' : 'filed';
    state.filing = event.filing || null; state.disposition = event;
  }
  return status;
}

export function activeOutwardAmendments(company, _vouchers) {
  const status = dispositions(company);
  return (company.gst?.outwardAmendments?.records || []).filter(record => status.get(record.id).effectiveStatus !== 'withdrawn').map(record => ({ ...record, ...status.get(record.id) }));
}

export function buildOutwardAmendment(company, vouchers, input, identity = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter an outward reporting correction');
  const master = company.gst?.outwardAmendments || { version: 1, revision: 0, records: [] };
  if (master.version !== 1 || !Number.isSafeInteger(master.revision) || master.revision < 0 || !Array.isArray(master.records) || master.events !== undefined && !Array.isArray(master.events) || master.revision !== master.records.length + (master.events || []).length) throw new Error('Invalid outward amendment register');
  const index = identity[REPLAY_INDEX];
  const invoice = index ? index.invoices.get(input.invoiceId) : vouchers.find(voucher => voucher.id === input.invoiceId)?.gst;
  if (!invoice || invoice.id !== input.invoiceId) throw new Error('Choose a posted outward GST document');
  const registration = index ? index.registrations.get(invoice.registrationId) : company.gst?.registrations?.find(row => row.id === invoice.registrationId);
  if (!registration || registration.gstin !== invoice.registration.gstin) throw new Error('The amendment registration differs from its posted document');
  let revised = outwardDocumentSnapshot(invoice, vouchers, index?.invoices);
  const originalReported = normalizeReportedSnapshot(input.originalReported);
  if (fyStart(originalReported.date) < '2021-04-01' || fyStart(revised.date) < '2021-04-01') throw new Error('Pre-FY2021-22 reported documents need legacy statutory review; the later November cutoff is not automatically applicable');
  const originalPeriod = month(input.originalPeriod), amendmentPeriod = month(input.amendmentPeriod);
  const preparationDate = date(input.date, 'the correction preparation date');
  const filingDate = date(input.filingDate, 'the intended correction filing date');
  let shippingUpdate;
  if (input.shippingUpdate !== undefined) {
    if (revised.section !== 'exp') throw new Error('Shipping particulars can only be updated through EXPA');
    const fields = exportShippingFields(input.shippingUpdate);
    if (!fields.portCode || !fields.shippingBillNumber || !fields.shippingBillDate) throw new Error('Enter the port, shipping bill number and date together for this customs update');
    if (fields.shippingBillDate > filingDate) throw new Error('The shipping bill date is after the intended amendment filing date');
    shippingUpdate = { ...fields, documentReference: text(input.shippingUpdate.documentReference, 'the shipping customs evidence reference', 500) };
    revised = { ...revised, ...fields };
  }
  const originalFiling = filing(input.originalFiling, originalPeriod, originalReported.section);
  const review = evidence(input.evidence);
  if (preparationDate < company.booksFrom || filingDate < preparationDate || originalFiling.filedDate > preparationDate || originalFiling.filedDate >= filingDate) throw new Error('Review the original, preparation and intended filing dates');
  if (originalReported.date.slice(0, 7) > originalPeriod || amendmentPeriod <= originalPeriod || revised.date.slice(0, 7) > amendmentPeriod || revised.date > preparationDate) throw new Error('The amendment must correct an earlier reported period and include an already issued document');
  if (filingDate < endOfMonth(amendmentPeriod)) throw new Error('The intended filing date precedes the correction return period end');
  if (fyStart(originalReported.date) !== fyStart(revised.date)) throw new Error('Cross-financial-year document-date corrections need a separately reviewed filing identity and cutoff');
  if (originalReported.section !== revised.section) throw new Error('Changes between reported return sections need separate supported correction treatment');
  if (originalReported.reverseCharge !== revised.reverseCharge || originalReported.invoiceType !== revised.invoiceType) throw new Error('The original RCM, regular or SEZ classification is locked for this amendment');
  const inter = snapshot => snapshot.section === 'exp' || snapshot.urType?.startsWith('EXP') || snapshot.invoiceType?.startsWith('SEZ') || snapshot.placeOfSupply !== registration.stateCode;
  if (inter(originalReported) !== inter(revised)) throw new Error('The original interstate or domestic supply treatment is locked for this amendment');
  if (originalReported.rates.some(row => row.igstPaise) && revised.rates.some(row => row.cgstPaise || row.sgstPaise || row.utgstPaise) || originalReported.rates.some(row => row.cgstPaise || row.sgstPaise || row.utgstPaise) && revised.rates.some(row => row.igstPaise)) throw new Error('The original interstate or domestic tax-head treatment is locked for this amendment');
  if (['b2b', 'cdnr'].includes(revised.section) && originalReported.recipientGstin !== revised.recipientGstin) throw new Error('The recipient GSTIN is locked for this offline amendment section');
  if (revised.section === 'b2cl' && originalReported.placeOfSupply !== revised.placeOfSupply) throw new Error('The original B2CL place-of-supply identity is locked for this amendment');
  if (revised.section === 'exp' && originalReported.exportType !== revised.exportType) throw new Error('The export payment type is locked for this amendment');
  if (['cdnr', 'cdnur'].includes(revised.section) && (originalReported.noteType !== revised.noteType || originalReported.urType !== revised.urType || originalReported.placeOfSupply !== revised.placeOfSupply)) throw new Error('The original note kind, supply category and place-of-supply identity are locked');
  if (['portCode', 'shippingBillNumber', 'shippingBillDate'].some(field => originalReported[field] && !revised[field])) throw new Error('Original shipping details are not represented in the accurate posted document; retain and review them before amending');
  const delta = deltaBetween(originalReported, revised);
  let cutoffYear = fyStart(revised.date), cutoffBasis = 'section37(3)';
  if (revised.noteType === 'C' && delta.taxPaise < 0) {
    const sourceSupplyDate = invoice.originalDate || (index ? index.invoices.get(invoice.originalInvoiceId) : vouchers.find(voucher => voucher.gst?.id === invoice.originalInvoiceId)?.gst)?.date;
    if (!isIsoDate(sourceSupplyDate)) throw new Error('A tax-reducing credit-note correction needs its original supply date to review section 34(2)');
    if (fyStart(sourceSupplyDate) < '2021-04-01') throw new Error('Pre-FY2021-22 original supplies need legacy credit-note cutoff review; no later November filing permission is inferred');
    if (fyStart(sourceSupplyDate) < cutoffYear) { cutoffYear = fyStart(sourceSupplyDate); cutoffBasis = 'section34(2)'; }
  }
  if (!['filed', 'not-filed'].includes(input.annualReturnStatus)) throw new Error('Review the relevant annual return status');
  const annualReturnFiledDate = input.annualReturnStatus === 'filed' ? date(input.annualReturnFiledDate, 'the relevant annual return filing date') : null;
  if (input.annualReturnStatus === 'not-filed' && input.annualReturnFiledDate) throw new Error('Annual return status and filing date differ');
  const knownAnnualDate = index ? index.annualDates.get(`${invoice.registrationId}:${cutoffYear}`) : master.records.filter(record => record.registrationId === invoice.registrationId && record.cutoff.financialYear === cutoffYear && record.cutoff.annualReturnFiledDate).map(record => record.cutoff.annualReturnFiledDate).sort()[0];
  if (knownAnnualDate && (!annualReturnFiledDate || annualReturnFiledDate > knownAnnualDate)) throw new Error('The saved annual-return filing evidence already establishes an earlier cutoff');
  const cutoff = correctionCutoff(cutoffYear, annualReturnFiledDate), ordinaryDate = cutoff.ordinaryDate;
  if (isBeyondCorrectionCutoff(filingDate, cutoff)) throw new Error('The intended correction filing is outside section 37(3): 30 November following the document financial year or the relevant annual return, whichever is earlier');
  if (isDeepStrictEqual(comparable(originalReported), comparable(revised)) && (!originalReported.hsnRows || isDeepStrictEqual(originalReported.hsnRows, revised.hsnRows))) throw new Error('The declared prior report already matches the posted document; no reporting correction is needed');
  const requestId = text(input.requestId, 'a correction save identifier', 80);
  if (!/^[A-Za-z0-9-]{16,80}$/.test(requestId)) throw new Error('Invalid correction save identifier');
  const request = { invoiceId: invoice.id, date: preparationDate, filingDate, amendmentPeriod, originalPeriod, originalReported, originalFiling, evidence: review,
    annualReturnStatus: input.annualReturnStatus, ...(annualReturnFiledDate ? { annualReturnFiledDate } : {}), ...(shippingUpdate ? { shippingUpdate } : {}) };
  const sourceInvoiceHash = digest(invoice);
  const previewHash = digest({ sourceInvoiceHash, request });
  const requestHash = digest({ request, requestId });
  if (index ? index.eventRequests.has(requestId) : (master.events || []).some(event => event.requestId === requestId)) throw new Error('This save identifier belongs to an amendment disposition');
  const existing = index ? index.recordRequests.get(requestId) : master.records.find(record => record.requestId === requestId);
  if (existing) {
    if (existing.requestHash !== requestHash) throw new Error('This save identifier already belongs to a different reporting correction');
    if (existing.sourceInvoiceHash !== sourceInvoiceHash) throw new Error('The posted document changed after the saved correction');
    return { record: existing, revision: master.revision, previewHash: existing.previewHash, replayed: true };
  }
  if (!Number.isSafeInteger(input.revision) || input.revision !== master.revision) throw new Error('The outward amendment register changed; refresh and preview again');
  if (!identity.preview && input.previewHash !== previewHash) throw new Error('The posted document or correction changed after preview; preview it again before saving');
  const active = index ? null : activeOutwardAmendments(company);
  if (index ? index.activeInvoices.has(invoice.id) : active.some(record => record.invoiceId === invoice.id)) throw new Error('A reporting correction for this posted document is already saved');
  const originalReportKey = originalKey(invoice.registrationId, originalReported);
  if (index ? index.activeOriginals.has(originalReportKey) : active.some(record => record.originalReportKey === originalReportKey)) throw new Error('The original filed document is already assigned to another reporting correction');
  const rateTotals = originalReported.totals;
  const record = { version: 1, id: identity.id || `amend-${randomBytes(10).toString('hex')}`, status: 'prepared', sequence: master.revision + 1,
    invoiceId: invoice.id, registrationId: invoice.registrationId, sourceInvoiceHash, originalReportKey, section: AMENDMENT_SECTIONS[revised.section],
    date: preparationDate, filingDate, amendmentPeriod, originalPeriod, originalReported, revised,
    ...(shippingUpdate ? { shippingUpdate } : {}),
    delta, rawDelta: Object.fromEntries([...AMOUNTS, 'taxPaise', 'totalPaise'].map(field => [field, exact(BigInt(revised.totals[field]) - BigInt(originalReported.totals[field]))])),
    cutoff: { ordinaryDate, annualReturnFiledDate, latestFilingDate: cutoff.latestDate, basis: cutoffBasis, financialYear: cutoffYear },
    originalFiling, evidence: review, hsnAttribution: originalReported.hsnRows ? 'known' : 'missing',
    reconciliation: { originalInvoiceValueDifferencePaise: exact(BigInt(originalReported.invoiceValuePaise) - BigInt(rateTotals.taxablePaise) - BigInt(rateTotals.taxPaise)),
      revisedInvoiceValueDifferencePaise: exact(BigInt(revised.invoiceValuePaise) - BigInt(revised.totals.taxablePaise) - BigInt(revised.totals.taxPaise)) },
    previewHash, requestId, requestHash, request: { ...request, requestId, revision: input.revision, previewHash }, sources: structuredClone(AMENDMENT_SOURCES) };
  return { record, previewHash, revision: master.revision + 1 };
}

export function buildAmendmentEvent(company, vouchers, action, input, identity = {}) {
  if (!['withdraw', 'record-filing'].includes(action)) throw new Error('Choose withdrawal or external filing confirmation');
  const master = company.gst?.outwardAmendments;
  if (!master || master.version !== 1 || !Array.isArray(master.records) || master.events !== undefined && !Array.isArray(master.events) || master.revision !== master.records.length + (master.events || []).length) throw new Error('Invalid outward amendment register');
  const index = identity[REPLAY_INDEX];
  const record = index ? index.records.get(input?.amendmentId) : master.records.find(record => record.id === input?.amendmentId);
  if (!record) throw new Error('Choose a saved outward reporting correction');
  const requestId = text(input.requestId, 'a disposition save identifier', 80);
  if (!/^[A-Za-z0-9-]{16,80}$/.test(requestId)) throw new Error('Invalid amendment disposition save identifier');
  if (index ? index.recordRequests.has(requestId) : master.records.some(record => record.requestId === requestId)) throw new Error('This save identifier belongs to a reporting correction');
  const eventDate = date(input.date, 'the disposition record date');
  if (eventDate < record.date) throw new Error('The disposition date precedes its preparation');
  const request = { amendmentId: record.id, date: eventDate, reference: text(input.reference, 'the disposition evidence reference', 500), basis: text(input.basis, 'the disposition basis', 1000) };
  let reportedFiling;
  if (action === 'withdraw') {
    if (input.confirmedUnfiled !== true) throw new Error('Confirm that this preparation has not been filed');
    request.confirmedUnfiled = true;
  } else {
    const filing = input.filing;
    if (!filing || filing.form !== 'GSTR-1' || filing.confirmedFiled !== true || filing.period !== record.amendmentPeriod) throw new Error('Confirm the externally filed GSTR-1 correction and its exact period');
    const filedDate = date(filing.filedDate, 'the actual correction filing date');
    if (filedDate < endOfMonth(record.amendmentPeriod) || filedDate <= record.originalFiling.filedDate || filedDate > eventDate) throw new Error('Review the actual correction filing date and original filing');
    const knownAnnualDate = index ? index.annualDates.get(`${record.registrationId}:${record.cutoff.financialYear}`) : master.records.filter(row => row.registrationId === record.registrationId && row.cutoff.financialYear === record.cutoff.financialYear && row.cutoff.annualReturnFiledDate).map(row => row.cutoff.annualReturnFiledDate).sort()[0];
    if (isBeyondCorrectionCutoff(filedDate, { ordinaryDate: record.cutoff.ordinaryDate, annualReturnFiledDate: knownAnnualDate || null })) throw new Error('The declared filing is outside the supported standard correction cutoff; retain and review that external evidence separately');
    reportedFiling = { form: 'GSTR-1', period: record.amendmentPeriod, reference: text(filing.reference, 'the actual filed return reference', 500), filedDate, confirmedFiled: true };
    request.filing = reportedFiling;
  }
  const requestHash = digest({ action, request, requestId });
  const existing = index ? index.eventRequests.get(requestId) : (master.events || []).find(event => event.requestId === requestId);
  if (existing) {
    if (existing.requestHash !== requestHash) throw new Error('This save identifier already belongs to a different amendment disposition');
    return { event: existing, revision: master.revision, replayed: true };
  }
  if (!Number.isSafeInteger(input.revision) || input.revision !== master.revision) throw new Error('The amendment history changed; refresh before recording its disposition');
  if ((index ? index.status.get(record.id) : dispositions(company).get(record.id).effectiveStatus) !== 'prepared') throw new Error('Only an active unfiled preparation can be withdrawn or marked filed');
  const invoice = index ? index.invoices.get(record.invoiceId) : vouchers.find(voucher => voucher.id === record.invoiceId)?.gst;
  if (!invoice || digest(invoice) !== record.sourceInvoiceHash) throw new Error('The posted document linked to this preparation changed');
  const event = { version: 1, id: identity.id || `amend-event-${randomBytes(10).toString('hex')}`, action, amendmentId: record.id, registrationId: record.registrationId,
    sequence: master.revision + 1, afterSequence: master.records.length, date: eventDate, reference: request.reference, basis: request.basis,
    ...(action === 'withdraw' ? { confirmedUnfiled: true } : { filing: reportedFiling }),
    requestId, requestHash, request: { ...request, requestId, revision: input.revision } };
  return { event, revision: master.revision + 1 };
}

export function assertOutwardAmendments(company, vouchers) {
  const master = company.gst?.outwardAmendments;
  if (master === undefined) return true;
  if (master.version !== 1 || !Number.isSafeInteger(master.revision) || !Array.isArray(master.records) || master.events !== undefined && !Array.isArray(master.events) || master.revision !== master.records.length + (master.events || []).length) throw new Error('Invalid outward amendment register version or revision');
  const prior = { ...company, gst: { ...company.gst, outwardAmendments: { version: 1, revision: 0, records: [], events: [] } } };
  const seen = new Set();
  // This index exists only for this full validation call. Every entry is still
  // rebuilt and compared; no mutable book or earlier validation is cached.
  const index = { invoices: new Map(vouchers.filter(voucher => voucher.gst).map(voucher => [voucher.id, voucher.gst])),
    registrations: new Map((company.gst?.registrations || []).map(row => [row.id, row])),
    records: new Map(), recordRequests: new Map(), eventRequests: new Map(), status: new Map(), activeInvoices: new Map(), activeOriginals: new Map(), annualDates: new Map() };
  const history = [...master.records.map(record => ({ type: 'record', entry: record })), ...(master.events || []).map(event => ({ type: 'event', entry: event }))].sort((a, b) => a.entry.sequence - b.entry.sequence);
  for (const { type, entry } of history) {
    if (entry.sequence !== prior.gst.outwardAmendments.revision + 1) throw new Error('Invalid outward amendment history sequence');
    if (typeof entry.id !== 'string' || !(type === 'record' ? /^amend-[a-f0-9]{20}$/ : /^amend-event-[a-f0-9]{20}$/).test(entry.id) || seen.has(entry.id)) throw new Error('Invalid or duplicate outward amendment identity');
    seen.add(entry.id);
    const identity = { id: entry.id, [REPLAY_INDEX]: index };
    const expected = type === 'record' ? buildOutwardAmendment(prior, vouchers, entry.request, identity).record : buildAmendmentEvent(prior, vouchers, entry.action, entry.request, identity).event;
    if (!isDeepStrictEqual(expected, entry)) throw new Error('Outward amendment identity, reported particulars, revised books or reconciliation trace changed');
    prior.gst.outwardAmendments[type === 'record' ? 'records' : 'events'].push(entry); prior.gst.outwardAmendments.revision += 1;
    if (type === 'record') {
      index.records.set(entry.id, entry); index.recordRequests.set(entry.requestId, entry); index.status.set(entry.id, 'prepared');
      index.activeInvoices.set(entry.invoiceId, entry.id); index.activeOriginals.set(entry.originalReportKey, entry.id);
      if (entry.cutoff.annualReturnFiledDate) {
        const key = `${entry.registrationId}:${entry.cutoff.financialYear}`, previous = index.annualDates.get(key);
        if (!previous || entry.cutoff.annualReturnFiledDate < previous) index.annualDates.set(key, entry.cutoff.annualReturnFiledDate);
      }
    } else {
      index.eventRequests.set(entry.requestId, entry);
      index.status.set(entry.amendmentId, entry.action === 'withdraw' ? 'withdrawn' : 'filed');
      if (entry.action === 'withdraw') {
        const record = index.records.get(entry.amendmentId);
        index.activeInvoices.delete(record.invoiceId); index.activeOriginals.delete(record.originalReportKey);
      }
    }
  }
  return true;
}

function pageOffset(value, total, limit) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Choose a valid correction page offset');
  return total ? Math.min(value, Math.floor((total - 1) / limit) * limit) : 0;
}

function deskState(company, vouchers, registration, period, { invoice: selectedId, q = '', offset = 0, historyOffset = 0 }) {
  if (typeof q !== 'string' || q.length > 200) throw new Error('Enter a correction search within 200 characters');
  const words = q.trim().toLocaleLowerCase('en-IN').split(/\s+/).filter(Boolean);
  const master = company.gst?.outwardAmendments;
  const status = dispositions(company);
  const allRecords = (master?.records || []).filter(record => record.registrationId === registration.id).map(record => ({ ...record, ...status.get(record.id) }));
  const active = new Map(), latest = new Map(), priorSearch = new Map();
  const sequence = record => record.disposition?.sequence || record.sequence;
  for (const record of allRecords) {
    if (record.effectiveStatus !== 'withdrawn') active.set(record.invoiceId, record);
    if (!latest.has(record.invoiceId) || sequence(record) > sequence(latest.get(record.invoiceId))) latest.set(record.invoiceId, record);
    priorSearch.set(record.invoiceId, (priorSearch.get(record.invoiceId) || '') + ` ${record.originalReported.number} ${record.originalReported.date} ${record.originalFiling.reference} ${record.evidence.documentReference}`);
  }
  const invoices = new Map(vouchers.filter(voucher => voucher.gst).map(voucher => [voucher.id, voucher.gst]));
  const summaries = vouchers.flatMap((voucher, savedOrder) => {
    const invoice = voucher.gst;
    if (invoice?.direction !== 'sales' || invoice.registrationId !== registration.id) return [];
    let supported = true, reason;
    try {
      outwardClassification(invoice, vouchers, invoices);
      if (fyStart(invoice.date) < '2021-04-01') throw new Error('Pre-FY2021-22 documents need legacy statutory review');
    } catch (error) { supported = false; reason = error.message; }
    const summary = { invoiceId: invoice.id, number: invoice.number, date: invoice.date, type: invoice.type, partyName: invoice.party.name, supported,
      ...(reason ? { reason } : {}), effectiveStatus: active.get(invoice.id)?.effectiveStatus || latest.get(invoice.id)?.effectiveStatus || null };
    const search = `${invoice.id} ${invoice.number} ${invoice.date} ${invoice.type} ${invoice.party.name}${priorSearch.get(invoice.id) || ''}`.toLocaleLowerCase('en-IN');
    return [{ summary, savedOrder, matches: words.every(word => search.includes(word)) }];
  }).sort((a, b) => b.summary.date.localeCompare(a.summary.date) || b.savedOrder - a.savedOrder);
  const filtered = summaries.filter(row => row.matches);
  const documentOffset = pageOffset(offset, filtered.length, 50);
  const full = row => {
    if (!row) return null;
    const invoice = invoices.get(row.summary.invoiceId);
    let actual = null, supported = row.summary.supported, reason = row.summary.reason;
    try { actual = outwardDocumentSnapshot(invoice, vouchers, invoices); }
    catch (error) { supported = false; reason = error.message; }
    return { ...row.summary, actual, supported, ...(reason ? { reason } : {}), activeRecordId: active.get(invoice.id)?.id || null };
  };
  let selected;
  if (selectedId) {
    const row = summaries.find(row => row.summary.invoiceId === selectedId);
    if (!row) throw new Error('The selected correction document is not in this registration');
    selected = full(row);
  } else {
    const eligible = filtered.filter(row => row.summary.supported && !active.has(row.summary.invoiceId));
    for (const row of [...eligible, ...filtered.filter(row => row.summary.supported && active.has(row.summary.invoiceId))]) {
      const candidate = full(row);
      if (candidate.supported) { selected = candidate; break; }
    }
    selected ||= full(filtered[0]);
  }
  const history = allRecords.filter(record => {
    if (!words.length) return !period || record.amendmentPeriod === period;
    const invoice = invoices.get(record.invoiceId);
    const search = `${record.id} ${record.invoiceId} ${record.originalReported.number} ${record.originalReported.date} ${record.revised.number} ${record.revised.date} ${invoice?.party.name || ''} ${record.originalFiling.reference} ${record.evidence.documentReference} ${record.effectiveStatus}`.toLocaleLowerCase('en-IN');
    return words.every(word => search.includes(word));
  }).sort((a, b) => sequence(b) - sequence(a));
  const recordOffset = pageOffset(historyOffset, history.length, 20);
  const records = history.slice(recordOffset, recordOffset + 20);
  const selectedRecord = selected && active.get(selected.invoiceId);
  if (selectedRecord && !records.some(record => record.id === selectedRecord.id)) records.push(selectedRecord);
  return { company: { id: company.id, name: company.name, booksFrom: company.booksFrom }, registration: { id: registration.id, name: registration.name, gstin: registration.gstin },
    registrations: company.gst?.registrations || [], month: period || null, revision: master?.revision || 0, mode: 'desk',
    documents: filtered.slice(documentOffset, documentOffset + 50).map(row => row.summary), selected: selected || null, records,
    documentPage: { offset: documentOffset, limit: 50, total: filtered.length }, historyPage: { offset: recordOffset, limit: 20, total: history.length }, sources: AMENDMENT_SOURCES };
}

export function outwardAmendmentState(company, vouchers, options = {}) {
  const { registrationId, month: period, mode } = options;
  if (period !== undefined && period !== null) month(period);
  const registration = company.gst?.registrations?.find(row => row.id === registrationId);
  if (!registration) throw new Error('Choose a GST registration for reporting corrections');
  if (mode === 'desk') return deskState(company, vouchers, registration, period, options);
  if (mode !== undefined && mode !== null && mode !== '') throw new Error('Choose a supported correction view');
  const documents = vouchers.filter(voucher => voucher.gst?.direction === 'sales' && voucher.gst.registrationId === registrationId).map(voucher => {
    const invoice = voucher.gst;
    const base = { invoiceId: invoice.id, number: invoice.number, date: invoice.date, type: invoice.type, partyName: invoice.party.name };
    try { return { ...base, actual: outwardDocumentSnapshot(invoice, vouchers), supported: true }; }
    catch (error) { return { ...base, actual: null, supported: false, reason: error.message }; }
  });
  const master = company.gst?.outwardAmendments;
  const status = dispositions(company);
  const records = (master?.records || []).filter(record => record.registrationId === registrationId).map(record => ({ ...record, ...status.get(record.id) }));
  const active = records.filter(record => record.effectiveStatus !== 'withdrawn');
  return { company: { id: company.id, name: company.name, booksFrom: company.booksFrom }, registration: { id: registration.id, name: registration.name, gstin: registration.gstin },
    registrations: company.gst?.registrations || [], month: period || null, revision: master?.revision || 0, records, documents,
    periodRecords: active.filter(record => record.amendmentPeriod === period), originalRecords: active.filter(record => record.originalPeriod === period),
    withdrawnRecords: records.filter(record => record.effectiveStatus === 'withdrawn'), events: (master?.events || []).filter(event => event.registrationId === registrationId), sources: AMENDMENT_SOURCES };
}
