import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fyStart, isIsoDate } from './money.js';
import { supplierDocumentDate } from './gst-document-identity.js';

export const CREDIT_REVIEW_SOURCES = [
  { title: 'CGST Act sections 34(1), 34(2) and commencement notes', url: 'https://taxinformation.cbic.gov.in/content-page/explore-act/1000304/1000001' },
  { title: 'Finance Ministry: November deadline applies from FY 2021–22', url: 'https://www.pib.gov.in/PressReleasePage.aspx?PRID=1865179' },
  { title: 'CGST Act section 15(3): post-supply discount conditions', url: 'https://taxinformation.cbic.gov.in/content-page/explore-act/1000284/1000001' },
];
const CONTEXT = Symbol('creditReviewAnnualContext');
const REPLAY = Symbol('creditReviewReplay');
const REPLAY_INDEX = Symbol('creditReviewReplayIndex');
const empty = () => ({ version: 1, revision: 0, records: [], byInvoiceId: {}, annualReturnDates: {} });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const annualKey = (registration, year) => `${registration}|${year}`;
const inScope = doc => doc?.type === 'Credit Note' && doc.direction === 'sales' && doc.supplyCategory === 'domestic' && doc.totals?.taxPaise > 0;
const str = (value, label, maximum = 240) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error(`Enter ${label} within ${maximum} characters`);
  return value.trim();
};
function master(company) {
  const value = company.gst?.creditReviews;
  if (value === undefined) return empty();
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.records) || value.records.length !== value.revision || !value.byInvoiceId || typeof value.byInvoiceId !== 'object' || Array.isArray(value.byInvoiceId) || !value.annualReturnDates || typeof value.annualReturnDates !== 'object' || Array.isArray(value.annualReturnDates)) throw new Error('Invalid Section 34 credit review register');
  return value;
}
function linked(doc, original) {
  return original?.type === 'Sales' && original.direction === 'sales' && original.supplyCategory === 'domestic' && doc.originalInvoiceId === original.id && doc.registrationId === original.registrationId && doc.partyId === original.partyId && doc.registration?.gstin === original.registration?.gstin && (doc.party?.gstin || '') === (original.party?.gstin || '') && doc.originalNumber === original.number && doc.originalDate === original.date && isIsoDate(original.date) && isIsoDate(doc.date) && original.date <= doc.date;
}
// Build once per workbook. Nothing is attached to or changed in the stored company.
export function creditReviewAnnualReturns(company, vouchers = []) {
  const result = {};
  const add = (registrationId, year, date, system, recordId) => {
    if (!registrationId || !/^\d{4}-04-01$/.test(year || '') || !isIsoDate(date)) return;
    const key = annualKey(registrationId, year), prior = result[key];
    if (!prior || date < prior.date) result[key] = { date, sources: [{ system, recordId }] };
    else if (date === prior.date) prior.sources.push({ system, recordId });
  };
  for (const record of company.gst?.creditReviews?.records || []) if (record.annualReturnStatus === 'filed') add(record.registrationId, record.supplyFinancialYear, record.annualReturnDate, 'credit-review', record.id);
  for (const record of company.gst?.outwardAmendments?.records || []) add(record.registrationId, record.cutoff?.financialYear, record.cutoff?.annualReturnFiledDate, 'outward-amendment', record.id);
  const invoices = new Map(vouchers.filter(row => row.gst).map(row => [row.gst.id, row.gst]));
  for (const record of company.gst?.itc?.records || []) {
    const invoice = invoices.get(record.invoiceId);
    if (invoice && isIsoDate(supplierDocumentDate(invoice))) add(record.registrationId, fyStart(supplierDocumentDate(invoice)), record.evidence?.annualReturnFiledDate, 'itc-review', record.id);
  }
  return result;
}
export function creditReviewContext(company, vouchers = []) { return { ...company, [CONTEXT]: creditReviewAnnualReturns(company, vouchers) }; }
function getReview(company, doc) {
  const value = master(company), index = value.byInvoiceId[doc.id];
  return Number.isSafeInteger(index) && index >= 0 && value.records[index]?.invoiceId === doc.id ? value.records[index] : null;
}
function status(company, doc, original, review) {
  if (!inScope(doc)) return null;
  let deadline = '', annualReturnDate = '';
  const hold = reason => ({ eligible: false, reason, deadline, annualReturnDate, review });
  if (!linked(doc, original)) return hold('Link the unchanged original outward invoice, registration and recipient before reviewing tax reduction.');
  const year = fyStart(original.date), ordinary = `${Number(year.slice(0, 4)) + 1}-11-30`;
  const known = company[CONTEXT]?.[annualKey(doc.registrationId, year)]?.date || master(company).annualReturnDates[annualKey(doc.registrationId, year)] || '';
  const annual = [known, review?.annualReturnStatus === 'filed' ? review.annualReturnDate : ''].filter(Boolean).sort()[0] || '';
  deadline = annual && annual < ordinary ? annual : ordinary; annualReturnDate = annual;
  if (year < '2021-04-01') { deadline = ''; return hold('Prior September-return deadlines and historical extensions require separate statutory review; the later November cutoff is not applied.'); }
  if (doc.reverseCharge || original.reverseCharge || !doc.items?.length || doc.items.some(row => row.supplyStatus !== 'taxable') || original.items?.some(row => row.supplyStatus !== 'taxable') || doc.ecommerceGstin || original.ecommerceGstin) return hold('This special or mixed supply needs separate Section 34 eligibility review.');
  if (!review) return hold('Record the proposed declaration date, adjustment ground and recipient evidence before reducing output tax.');
  if (review.invoiceHash !== hash(doc) || review.originalHash !== hash(original) || review.registrationId !== doc.registrationId || review.originalInvoiceId !== original.id) return hold('The note or linked original changed after this review; refresh the evidence.');
  if (review.declarationDate < doc.date || doc.date < original.date) return hold('The original, note and proposed declaration dates do not establish a valid sequence.');
  if (review.declarationDate < '2022-10-01') return hold('The earlier September-return declaration rule needs separate statutory review.');
  const periodEnd = new Date(Date.UTC(Number(doc.date.slice(0, 4)), Number(doc.date.slice(5, 7)), 0)).toISOString().slice(0, 10);
  if (review.declarationDate <= periodEnd) return hold('A normal monthly return declaration must follow the end of the credit-note month.');
  if (doc.date > ordinary || review.declarationDate > ordinary) return hold(`The note or proposed declaration is after the Section 34 deadline of ${ordinary}.`);
  if (annual && (doc.date >= annual || review.declarationDate >= annual)) return hold(`The relevant annual return was furnished on ${annual}; a later or same-day reduction is held for review.`);
  if (!review.groundConfirmed || review.adjustmentGround === 'unconfirmed') return hold('Confirm a supported Section 34(1) adjustment ground from the named evidence.');
  if (review.recipientBasis === 'unconfirmed') return hold('Recipient eligibility evidence is pending or withdrawn.');
  // Do not infer transitional permission where issuance and declaration straddle
  // the new proviso. A separate historical review can resolve such a case.
  if (doc.date < '2025-10-01' && review.declarationDate >= '2025-10-01') return hold('This note crosses the 01-10-2025 proviso change and needs separate transitional review.');
  if (review.declarationDate < '2025-10-01') {
    if (review.recipientBasis !== 'incidence-not-passed') return hold('The earlier proviso requires evidence that tax and interest incidence was not passed on.');
  } else if (doc.party?.gstin) {
    if (!['reversed', 'not-availed'].includes(review.recipientBasis)) return hold('Confirm that the registered recipient reversed the attributable ITC or did not avail it.');
  } else if (review.recipientBasis !== 'incidence-not-passed') return hold('Confirm that tax incidence was not passed on for the unregistered recipient.');
  if (review.adjustmentGround === 'post-supply-discount' && (!review.discountAgreementConfirmed || !review.discountInvoiceLinked || doc.party?.gstin && !['reversed', 'not-availed'].includes(review.recipientBasis))) return hold('Post-supply discount reduction needs its prior agreement, original invoice link and attributable ITC evidence under section 15(3).');
  return { eligible: true, reason: 'Reviewed for the proposed Section 34 declaration.', deadline, annualReturnDate, review };
}
export function creditReviewStatus(company, doc, original) { return status(company, doc, original, inScope(doc) ? getReview(company, doc) : null); }
function normalize(input) {
  const allowed = ['invoiceId', 'declarationDate', 'annualReturnStatus', 'annualReturnDate', 'recipientBasis', 'adjustmentGround', 'groundConfirmed', 'discountAgreementConfirmed', 'discountInvoiceLinked', 'reference', 'revision', 'requestId', 'supersedes', 'correctionReason'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Enter supported Section 34 declaration review fields');
  if (!isIsoDate(input.declarationDate) || !['filed', 'not-filed'].includes(input.annualReturnStatus) || !['reversed', 'not-availed', 'incidence-not-passed', 'unconfirmed'].includes(input.recipientBasis) || !['goods-returned', 'deficiency', 'excess-value-or-tax', 'post-supply-discount', 'unconfirmed'].includes(input.adjustmentGround)) throw new Error('Choose the declaration date, annual return status, adjustment ground and recipient evidence');
  if (input.annualReturnStatus === 'filed' ? !isIsoDate(input.annualReturnDate) : Boolean(input.annualReturnDate)) throw new Error('The actual annual return date and status must agree');
  for (const field of ['groundConfirmed', 'discountAgreementConfirmed', 'discountInvoiceLinked']) if (input[field] !== undefined && typeof input[field] !== 'boolean') throw new Error(`Confirm ${field} explicitly`);
  if (!/^[a-z0-9-]{1,48}$/.test(input.invoiceId || '')) throw new Error('Choose a valid credit note identity');
  return { invoiceId: str(input.invoiceId, 'the credit note identity', 48), declarationDate: input.declarationDate, annualReturnStatus: input.annualReturnStatus, annualReturnDate: input.annualReturnDate || '', recipientBasis: input.recipientBasis, adjustmentGround: input.adjustmentGround, groundConfirmed: input.groundConfirmed === true, discountAgreementConfirmed: input.discountAgreementConfirmed === true, discountInvoiceLinked: input.discountInvoiceLinked === true, reference: str(input.reference, 'the review evidence reference', 500), supersedes: input.supersedes ? str(input.supersedes, 'the prior review identity', 48) : null, correctionReason: input.correctionReason ? str(input.correctionReason, 'the correction reason', 500) : '' };
}
export function buildCreditReview(company, vouchers, input, identity = {}) {
  if (!identity[REPLAY]) assertCreditReviews(company, vouchers);
  const current = master(company), request = normalize(input), requestId = str(input.requestId, 'a review save identifier', 80);
  if (!/^[A-Za-z0-9-]{16,80}$/.test(requestId)) throw new Error('Invalid Section 34 review save identifier');
  const requestHash = hash({ ...request, requestId });
  const existing = identity[REPLAY_INDEX] ? identity[REPLAY_INDEX].requests.get(requestId) : current.records.find(row => row.requestId === requestId);
  if (existing) {
    if (existing.requestHash !== requestHash) throw new Error('This save identifier already belongs to different credit review evidence');
    const doc = vouchers.find(row => row.gst?.id === existing.invoiceId)?.gst, original = vouchers.find(row => row.gst?.id === doc?.originalInvoiceId)?.gst;
    return { record: existing, revision: current.revision, replayed: true, status: creditReviewStatus(creditReviewContext(company, vouchers), doc, original) };
  }
  if (!Number.isSafeInteger(input.revision) || input.revision !== current.revision) throw new Error('The credit review register changed; refresh before saving');
  const doc = identity[REPLAY_INDEX] ? identity[REPLAY_INDEX].invoices.get(request.invoiceId) : vouchers.find(row => row.gst?.id === request.invoiceId)?.gst;
  const original = identity[REPLAY_INDEX] ? identity[REPLAY_INDEX].invoices.get(doc?.originalInvoiceId) : vouchers.find(row => row.gst?.id === doc?.originalInvoiceId)?.gst;
  if (!inScope(doc) || !linked(doc, original)) throw new Error('Choose a taxable domestic outward Credit Note linked to the same verified original invoice and registration');
  if (!company.gst?.registrations?.some(row => row.id === doc.registrationId)) throw new Error('The credit review registration is missing from these books');
  if (request.declarationDate < doc.date) throw new Error('The proposed declaration cannot precede the credit note');
  const year = fyStart(original.date), yearEnd = `${Number(year.slice(0, 4)) + 1}-03-31`;
  if (request.annualReturnDate && request.annualReturnDate <= yearEnd) throw new Error('The relevant annual return filing must follow the original supply financial year');
  const prior = getReview(company, doc);
  if (prior ? request.supersedes !== prior.id || !request.correctionReason : request.supersedes !== null || Boolean(request.correctionReason)) throw new Error('A correction must name the current review and its correction reason');
  const known = identity[REPLAY] ? current.annualReturnDates[annualKey(doc.registrationId, year)] : creditReviewAnnualReturns(company, vouchers)[annualKey(doc.registrationId, year)]?.date;
  if (known && (request.annualReturnStatus !== 'filed' || request.annualReturnDate > known)) throw new Error('Earlier annual return filing evidence is already recorded; preserve that cutoff');
  const record = { version: 1, kind: 'proposed-declaration-review', id: identity.id || `credit-review-${randomBytes(10).toString('hex')}`, sequence: current.revision + 1, invoiceId: doc.id, originalInvoiceId: original.id, registrationId: doc.registrationId, supplyFinancialYear: year, invoiceHash: hash(doc), originalHash: hash(original), ...request, requestId, requestHash, request: { ...request, requestId, revision: input.revision }, recordedAt: identity.recordedAt || new Date().toISOString(), sources: structuredClone(CREDIT_REVIEW_SOURCES) };
  return { record, revision: current.revision + 1, replayed: false, status: identity[REPLAY] ? null : status(creditReviewContext(company, vouchers), doc, original, record) };
}
function append(company, result) {
  const registry = company.gst.creditReviews ??= empty(), record = result.record;
  registry.records.push(record); registry.revision = result.revision; registry.byInvoiceId[record.invoiceId] = registry.records.length - 1;
  if (record.annualReturnStatus === 'filed') {
    const key = annualKey(record.registrationId, record.supplyFinancialYear), prior = registry.annualReturnDates[key];
    if (!prior || record.annualReturnDate < prior) registry.annualReturnDates[key] = record.annualReturnDate;
  }
}
export function applyCreditReview(company, vouchers, input) {
  const next = structuredClone(company), result = buildCreditReview(next, vouchers, input);
  if (!result.replayed) append(next, result);
  return { company: next, vouchers, ...result };
}
export function assertCreditReviews(company, vouchers) {
  if (company.gst?.creditReviews === undefined) return true;
  const index = { invoices: new Map(vouchers.filter(row => row.gst).map(row => [row.gst.id, row.gst])), requests: new Map() };
  const value = master(company), prior = { ...company, gst: { ...company.gst, creditReviews: empty() } }, ids = new Set();
  for (const record of value.records) {
    if (!record || !/^credit-review-[a-f0-9]{20}$/.test(record.id) || ids.has(record.id) || record.sequence !== prior.gst.creditReviews.revision + 1 || typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt))) throw new Error('Invalid Section 34 credit review identity or history sequence');
    ids.add(record.id);
    const expected = buildCreditReview(prior, vouchers, record.request, { id: record.id, recordedAt: record.recordedAt, [REPLAY]: true, [REPLAY_INDEX]: index });
    if (expected.replayed || !isDeepStrictEqual(expected.record, record)) throw new Error('The credit review evidence, linked invoices or correction history changed');
    append(prior, expected); index.requests.set(record.requestId, record);
  }
  if (!isDeepStrictEqual(prior.gst.creditReviews, value)) throw new Error('The credit review indexes or annual return cutoff history changed');
  return true;
}
