import { legacySupplierConflicts, supplierDocumentDate } from "./gst-document-identity.js";
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fyStart, isIsoDate, todayISO } from './money.js';
import { correctionCutoff, gstRequestHash, supplierDocDate } from './gst.js';
import { imsEligible, portalImsAction } from './gst-ims.js';

export const ITC_COMPONENTS = ['cgst', 'sgst', 'utgst', 'igst', 'cess'];
export const ITC_SOURCES = [
  { title: 'CBIC Circular 170/02/2022: Table 4 reporting', url: 'https://cbic-gst.gov.in/pdf/Circular-170-02-2022-GST.pdf' },
  { title: 'GSTN: Changes in Table 4 of GSTR-3B', url: 'https://tutorial.gst.gov.in/downloads/news/advisory_of_label_change_in_GSTR_3B_02_09_2022.pdf' },
  { title: 'GSTN IMS FAQ: credit already reversed or never availed', url: 'https://tutorial.gst.gov.in/downloads/news/additional_faqs_ims_17_10_2024.pdf' },
  { title: 'CBIC Circular 237/31/2024: section 16 time limits', url: 'https://cbic-gst.gov.in/pdf/circular-237-31-2024-GST.pdf' },
  { title: 'GSTN reclaim statement advisory, 29-12-2025 (Maharashtra GST copy)', url: 'https://www.mahagst.gov.in/public/uploads/gstnadvisory/1768891569_389%20Advisory%20%20FAQ%20on%20Electronic%20Credit%20Reversal%20and%20Re-claimed%20Statement%20%20RCM%20Liability%20or%20ITC%20Statement.pdf' },
];
export const ITC_PERMANENT_REASONS = ['section17(5)', 'rule38', 'rule42', 'rule43', 'section16(4)', 'pos-restriction', 'other-permanent'];
export const ITC_TEMPORARY_REASONS = ['rule37', 'rule37A', 'section16(2)(b)', 'section16(2)(c)', 'clerical-correction', 'other-temporary'];
const BUCKETS = ['unreviewed', 'unclaimed', 'claimable', 'permanent', 'temporary-hold', 'temporary-reversed', 'temporary-gross', 'credited'];
const ACTIONS = ['claim', 'permanent', 'temporary', 'reclaim', 'prior-claim', 'credit-note'];
const REQUIRED_ELIGIBILITY = ['invoiceHeld', 'received', 'businessUse', 'notBlocked', 'supplierReported', 'supplierTaxPaid', 'returnFurnished', 'paymentReview', 'noTaxDepreciation'];
const zero = () => Object.fromEntries(ITC_COMPONENTS.map(key => [key + 'Paise', 0]));
function exact(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ITC exceeds the supported exact paise limit');
  return Number(value);
}
function amount(value) { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Enter nonnegative ITC amounts in safe integer paise'); return value; }
function components(source = {}) { return Object.fromEntries(ITC_COMPONENTS.map(key => [key + 'Paise', amount(source[key + 'Paise'] ?? 0)])); }
function total(source) { return exact(ITC_COMPONENTS.reduce((sum, key) => sum + BigInt(source[key + 'Paise'] || 0), 0n)); }
function add(target, source, sign = 1) { for (const key of ITC_COMPONENTS) target[key + 'Paise'] = exact(BigInt(target[key + 'Paise']) + BigInt(source[key + 'Paise'] || 0) * BigInt(sign)); return target; }
function text(value, label, max = 500) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Enter ${label} within ${max} characters`); return value.trim(); }
function date(value, label) { if (!isIsoDate(value)) throw new Error(`Enter ${label}`); return value; }
// Same canonical SHA-256 as invoice request hashes, so saved review hashes are unchanged.
const hash = gstRequestHash;
const positive = invoice => invoice.direction === 'purchase' && !invoice.reverseCharge && ['Purchase', 'Debit Note'].includes(invoice.type);
const forward = invoice => invoice?.direction === 'purchase' && !invoice.reverseCharge && ['Purchase', 'Debit Note', 'Credit Note'].includes(invoice.type);

export function ensureItcAccounts(company, registrationId) {
  const registration = company.gst?.registrations?.find(row => row.id === registrationId);
  if (!registration) throw new Error('Choose a saved GST registration');
  company.gst.itc ||= { version: 1, accountsByRegistration: {}, records: [] };
  company.gst.itc.accountsByRegistration ||= {};
  company.gst.itc.records ||= [];
  if (company.gst.itc.accountsByRegistration[registrationId]) return company.gst.itc.accountsByRegistration[registrationId];
  const accounts = {};
  for (const role of ['claimable', 'temporary']) for (const component of ITC_COMPONENTS) {
    const name = `${registration.invoicePrefix} Reviewed ${role === 'claimable' ? 'input credit' : 'temporary input credit'} ${component.toUpperCase()}`;
    if (company.ledgers.some(ledger => ledger.name.toLowerCase() === name.toLowerCase())) throw new Error('An ITC review posting ledger name already exists');
    const id = `l-itc-${randomBytes(8).toString('hex')}`;
    company.ledgers.push({ id, name, groupId: 'g-current-assets', opening: { dc: 'Dr', paise: 0 } });
    accounts[role + '-' + component] = id;
  }
  company.gst.itc.accountsByRegistration[registrationId] = accounts;
  return accounts;
}

export function itcAccountIds(company) {
  return new Set(Object.values(company.gst?.itc?.accountsByRegistration || {}).flatMap(accounts => Object.values(accounts)));
}

// Section 16(4) runs from the supplier's invoice date. Books saved before that
// date was captured fall back to the voucher date.
export function itcClaimDeadline(invoice, evidence = {}) {
  const annual = evidence.annualReturnFiledDate;
  if (annual !== undefined && annual !== '' && !isIsoDate(annual)) throw new Error('Enter the relevant annual return filing date');
  const cutoff = correctionCutoff(supplierDocDate(invoice), annual || null);
  return { ordinary: cutoff.ordinaryDate, annualReturnFiledDate: cutoff.annualReturnFiledDate, cutoff: cutoff.latestDate };
}

function normalizeEvidence(input, action, invoice, actionDate) {
  const evidence = structuredClone(input || {});
  evidence.basis = text(evidence.basis, 'the statutory review basis');
  evidence.documentReference = text(evidence.documentReference, 'the review evidence reference', 240);
  if (evidence.statement !== undefined) {
    const s = evidence.statement;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('Invalid local GSTR-2B evidence reference');
    text(s.id, 'the saved statement id', 240); text(s.rowKey, 'the saved statement document key', 500);
    if (!/^[a-f0-9]{64}$/.test(s.sha256 || '') || !/^\d{4}-(0[1-9]|1[0-2])$/.test(s.period || '')) throw new Error('Invalid saved statement hash or period');
  }
  if (['claim', 'reclaim', 'prior-claim'].includes(action)) {
    for (const key of REQUIRED_ELIGIBILITY) if (evidence[key] !== true) throw new Error(`Confirm the ${key} eligibility condition from evidence`);
    if (!['not-filed', 'filed'].includes(evidence.annualReturnStatus)) throw new Error('Review whether the relevant annual return has been filed');
    if (evidence.annualReturnStatus === 'filed') date(evidence.annualReturnFiledDate, 'the relevant annual return filing date');
    if (evidence.annualReturnStatus === 'not-filed' && evidence.annualReturnFiledDate) throw new Error('Annual return status and filing date differ');
    if (evidence.statement?.availability === 'N') throw new Error('This statement marks ITC not available; select corrected available evidence or separately document and review the restriction before claiming');
  }
  if (action === 'reclaim' && evidence.conditionsNowMet !== true) throw new Error('Confirm that the temporary reversal conditions have now been fulfilled');
  if (action === 'prior-claim') {
    date(evidence.priorClaimDate, 'the actual earlier claim date');
    if (evidence.priorClaimDate < supplierDocDate(invoice) || evidence.priorClaimDate > actionDate) throw new Error('The prior claim date must follow this supplier document and precede the review date');
    text(evidence.priorReturnReference, 'the earlier filed return evidence', 240);
    if (evidence.priorClaimVerified !== true) throw new Error('Confirm the historical claim against its filed return');
  }
  return evidence;
}

/*
 * IMS state of a matched GSTR-2B row: the action recorded in the books wins, otherwise the
 * portal status carried on the downloaded row. Section 38 CGST Act as substituted by the
 * Finance (No. 2) Act, 2024 and rule 60: a document rejected on IMS does not reach the
 * ITC-available part of GSTR-2B and a pending one is deferred, so neither can be claimed.
 */
export function itcImsState(row) {
  const recorded = row?.ims?.action;
  if (recorded !== undefined && recorded !== null) return { action: recorded, source: row.ims.source || 'recorded' };
  const portal = portalImsAction(row?.imsStatus);
  return { action: portal, source: portal ? 'portal' : 'none' };
}

export function assertItcImsClaim(action, row) {
  if (!['claim', 'reclaim', 'prior-claim'].includes(action) || imsEligible(row)) return;
  const state = itcImsState(row).action === 'reject' ? 'rejected' : 'pending';
  throw new Error(`This document is ${state} on IMS; accept it on the portal before claiming the credit`);
}

function enforceFirstClaimDeadline(invoice, evidence, claimDate) {
  const deadline = itcClaimDeadline(invoice, evidence);
  if (claimDate > deadline.ordinary || deadline.annualReturnFiledDate && claimDate >= deadline.annualReturnFiledDate) throw new Error('This first claim is outside section 16(4): 30 November following the document financial year or the relevant annual return, whichever is earlier; statutory exceptions need separate review');
  return deadline;
}

function serviceReceipt(invoice, lineIndex) {
  if (invoice.tallyOrigin?.version !== 4 || invoice.direction !== 'purchase' || invoice.items[lineIndex]?.kind !== 'service') return null;
  const matches = invoice.tallyOrigin.serviceItems?.filter(row => row.invoiceLineIndex === lineIndex) || [];
  const source = matches[0], completion = source?.completionReview;
  if (matches.length !== 1 || source.itemId !== invoice.items[lineIndex].itemId || !/^ledger-entry:\d+$/.test(source.sourceLineId || '') || typeof source.sourceLedgerId !== 'string' || !source.sourceLedgerId || !['confirmed', 'pending'].includes(completion?.status)) throw new Error('The service receipt review no longer identifies its original source line and ledger');
  const confirmed = completion.status === 'confirmed';
  if (confirmed) { date(completion.date, 'the confirmed service receipt date'); text(completion.reference, 'the confirmed service receipt evidence', 500); }
  else if (completion.date) throw new Error('A pending service receipt cannot carry a confirmed receipt date');
  const sourceLine = invoice.tallyOrigin.source?.items?.find(row => row.sourceLineId === source.sourceLineId);
  return { lineIndex, sourceLineId: source.sourceLineId, sourceLedgerId: source.sourceLedgerId, ledgerName: sourceLine?.sourceLedgerName || sourceLine?.sourceName || invoice.items[lineIndex].name || '',
    status: completion.status, date: confirmed ? completion.date : '', reference: confirmed ? completion.reference.trim() : '', basis: 'source-review' };
}

function normalizeServiceReceipts(company, document, transfers, evidence, action, actionDate, reportingMode) {
  if (document.invoice.tallyOrigin?.version !== 4 || document.invoice.direction !== 'purchase') return;
  const required = ['claim', 'prior-claim', 'reclaim'].includes(action) || reportingMode === 'gross-and-reversal';
  const submitted = evidence.serviceReceipts;
  if (submitted !== undefined && !Array.isArray(submitted)) throw new Error('Choose dated service receipt evidence for the selected lines');
  const selected = new Set(required ? transfers.filter(row => row.invoiceId === document.invoice.id && document.lines[row.lineIndex]?.serviceReceipt).map(row => row.lineIndex) : []);
  const provided = new Map();
  for (const row of submitted || []) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['lineIndex', 'sourceLineId', 'sourceLedgerId', 'received', 'date', 'reference'].includes(key)) || !Number.isSafeInteger(row.lineIndex) || !selected.has(row.lineIndex) || provided.has(row.lineIndex)) throw new Error('Service receipt evidence must identify each selected service line exactly once');
    provided.set(row.lineIndex, row);
  }
  if (!selected.size) { delete evidence.serviceReceipts; return; }
  const claimDate = action === 'prior-claim' ? evidence.priorClaimDate : actionDate;
  const proofs = [];
  for (const lineIndex of selected) {
    let established = document.lines[lineIndex].serviceReceipt;
    const supplied = provided.get(lineIndex);
    // A newly entered backdated decision must respect receipt evidence already
    // recorded later in the books as well as the decision-date replay position.
    if (established.status === 'pending') {
      const prior = orderedRecords(company).filter(row => row.invoiceId === document.invoice.id).flatMap(row => row.evidence?.serviceReceipts || []).find(row => row.lineIndex === lineIndex && row.sourceLineId === established.sourceLineId && row.sourceLedgerId === established.sourceLedgerId);
      if (prior) established = { ...established, status: 'confirmed', date: prior.date, reference: prior.reference };
    }
    if (supplied && (supplied.sourceLineId !== established.sourceLineId || supplied.sourceLedgerId !== established.sourceLedgerId || supplied.received !== true)) throw new Error('Confirm receipt against the selected service source line and original ledger');
    const normalize = row => ({ lineIndex, sourceLineId: established.sourceLineId, sourceLedgerId: established.sourceLedgerId, received: true, date: date(row.date, 'the service receipt date'), reference: text(row.reference, 'the service receipt evidence reference', 500) });
    let proof;
    if (established.status === 'confirmed') {
      proof = normalize(established);
      if (supplied && !isDeepStrictEqual(normalize(supplied), proof)) throw new Error('Preserve the previously documented service receipt date and evidence reference');
    } else {
      if (!supplied) throw new Error('Record dated receipt or completion evidence for each selected pending service line before claiming ITC');
      proof = normalize(supplied);
    }
    if (proof.date > claimDate) throw new Error('The actual ITC claim date cannot precede the selected service receipt or completion date');
    proofs.push(proof);
  }
  evidence.serviceReceipts = proofs.sort((a, b) => a.lineIndex - b.lineIndex);
}

function initialDocuments(vouchers, to, exclusive) {
  const documents = new Map();
  for (const voucher of vouchers) {
    const invoice = voucher.gst;
    if (!forward(invoice) || invoice.date > to || exclusive && invoice.date === to) continue;
    if (invoice.id !== voucher.id || invoice.date !== voucher.date) throw new Error('ITC source invoice identity or date differs from its journal');
    if (documents.has(invoice.id)) throw new Error('Duplicate ITC source invoice');
    const credit = invoice.type === 'Credit Note';
    const bucket = invoice.itcEligibility === 'ineligible' ? 'permanent' : invoice.itcEligibility === 'eligible' ? 'unclaimed' : 'unreviewed';
    const lines = invoice.items.map((line, lineIndex) => {
      const balances = Object.fromEntries(BUCKETS.map(key => [key, zero()]));
      if (!credit) balances[bucket] = components(line);
      return { lineIndex, originalLineIndex: invoice.type === "Purchase" ? lineIndex : invoice.originalLineMap?.[lineIndex] ?? null, itemId: line.itemId, kind: line.kind, name: line.name || '', gstRateBps: line.gstRateBps, cessRateBps: line.cessRateBps, supplyStatus: line.supplyStatus,
        original: components(line), balances,
        creditedByDisposition: { eligible: zero(), temporary: zero(), permanent: zero(), pending: zero() },
        expenseReviewed: zero(), reviewIds: [], costDates: [], ...(invoice.tallyOrigin?.version === 4 && line.kind === 'service' ? { serviceReceipt: serviceReceipt(invoice, lineIndex) } : {}) };
    });
    documents.set(invoice.id, { invoice, lines, credit, creditSettled: false, records: [] });
  }
  return documents;
}

function orderedRecords(company) {
  const source = company.gst?.itc?.records || [];
  if (!Array.isArray(source)) throw new Error('Invalid ITC review record list');
  return [...source].sort((a, b) => a.date.localeCompare(b.date) || a.sequence - b.sequence);
}

function applyRecord(documents, record) {
  const document = documents.get(record.invoiceId);
  if (!document) throw new Error('An ITC review references a missing forward-charge purchase document');
  for (const transfer of record.transfers || []) {
    const target = documents.get(transfer.invoiceId);
    const line = target?.lines[transfer.lineIndex];
    if (!line || !BUCKETS.includes(transfer.from) || !BUCKETS.includes(transfer.to)) throw new Error('Invalid source line or disposition in ITC review');
    const amounts = components(transfer);
    for (const component of ITC_COMPONENTS) {
      const key = component + 'Paise';
      if (amounts[key] > line.balances[transfer.from][key]) throw new Error('The ITC review exceeds its source line and tax-head balance');
    }
    add(line.balances[transfer.from], amounts, -1); add(line.balances[transfer.to], amounts);
    if (transfer.from === 'permanent' && transfer.to === 'permanent') add(line.expenseReviewed, amounts);
    line.reviewIds.push(record.id); line.costDates.push(record.date);
    if (record.action === 'credit-note') {
      const noteLine = document.lines[transfer.noteLineIndex];
      if (!noteLine) throw new Error('Invalid credit-note source line');
      const disposition = transfer.from === 'permanent' ? 'permanent' : transfer.from === 'unreviewed' ? 'pending' : transfer.from.startsWith('temporary') ? 'temporary' : 'eligible';
      add(noteLine.creditedByDisposition[disposition], amounts);
      add(line.creditedByDisposition[disposition], amounts);
      noteLine.reviewIds.push(record.id); noteLine.costDates.push(record.date);
    }
  }
  if (document.invoice.tallyOrigin?.version === 4) for (const receipt of record.evidence?.serviceReceipts || []) {
    const line = document.lines[receipt.lineIndex], prior = line?.serviceReceipt;
    if (!prior || receipt.sourceLineId !== prior.sourceLineId || receipt.sourceLedgerId !== prior.sourceLedgerId || receipt.received !== true || !record.transfers.some(row => row.invoiceId === document.invoice.id && row.lineIndex === receipt.lineIndex)) throw new Error('The saved service receipt proof differs from its selected source line');
    line.serviceReceipt = { ...prior, status: 'confirmed', date: receipt.date, reference: receipt.reference, basis: prior.status === 'confirmed' ? prior.basis : 'itc-review' };
  }
  if (record.action === 'credit-note') {
    if (document.creditSettled) throw new Error('This purchase credit note has already been reviewed');
    document.creditSettled = true;
  }
  document.records.push(record.id);
}

function replay(company, vouchers, to, exclusive = false) {
  const documents = initialDocuments(vouchers, to, exclusive);
  for (const record of orderedRecords(company)) {
    if (record.date > to || exclusive && record.date === to) continue;
    applyRecord(documents, record);
  }
  return documents;
}

function availableSources(action, evidence, reportExistingExpense) {
  if (action === 'claim' || action === 'prior-claim') return ['unreviewed', 'unclaimed', 'temporary-hold', ...(evidence.correctIneligibility === true ? ['permanent'] : [])];
  if (action === 'temporary') return ['claimable', 'unreviewed', 'unclaimed'];
  if (action === 'permanent') return ['claimable', 'unreviewed', 'unclaimed', 'temporary-hold', 'temporary-reversed', 'temporary-gross', ...(reportExistingExpense ? ['permanent'] : [])];
  if (action === 'reclaim') return ['temporary-reversed', 'temporary-gross'];
  return [];
}

function selections(document, action, input, evidence) {
  const allowed = availableSources(action, evidence, input.reportExistingExpense === true || action === 'permanent' && document.invoice.itcEligibility === 'ineligible');
  const available = (line, bucket) => {
    const result = { ...line.balances[bucket] };
    if (action === 'permanent' && bucket === 'permanent') for (const component of ITC_COMPONENTS) result[component + 'Paise'] = Math.max(0, result[component + 'Paise'] - line.expenseReviewed[component + 'Paise']);
    return result;
  };
  const selected = [];
  if (input.lineAllocations !== undefined) {
    if (!Array.isArray(input.lineAllocations) || !input.lineAllocations.length) throw new Error('Choose exact invoice line and tax-head allocations');
    const seen = new Set();
    for (const allocation of input.lineAllocations) {
      const line = document.lines[allocation.lineIndex];
      if (!Number.isSafeInteger(allocation.lineIndex) || !line) throw new Error('ITC allocation references an invalid source line');
      let from = allocation.fromBucket;
      if (!from) {
        const candidates = allowed.filter(bucket => total(available(line, bucket)) > 0);
        if (candidates.length !== 1) throw new Error('Choose the source disposition for this partial line review');
        from = candidates[0];
      }
      if (!allowed.includes(from)) throw new Error('That ITC source disposition does not support this action');
      const key = `${allocation.lineIndex}:${from}`;
      if (seen.has(key)) throw new Error('Duplicate source-line ITC allocation');
      seen.add(key);
      const amounts = components(allocation), remaining = available(line, from);
      if (!total(amounts)) throw new Error('Enter a positive ITC review allocation');
      for (const component of ITC_COMPONENTS) if (amounts[component + 'Paise'] > remaining[component + 'Paise']) throw new Error('ITC allocation exceeds the unreviewed or unreclaimed line tax head');
      selected.push({ invoiceId: document.invoice.id, lineIndex: allocation.lineIndex, from, ...amounts });
    }
  } else for (const line of document.lines) for (const from of allowed) {
    const amounts = available(line, from);
    if (total(amounts)) selected.push({ invoiceId: document.invoice.id, lineIndex: line.lineIndex, from, ...amounts });
  }
  if (!selected.length) throw new Error('No unclaimed or unreversed ITC remains for this action');
  return selected;
}

function creditSelections(documents, note, input) {
  if (!note.credit || !note.invoice.originalInvoiceId) throw new Error('Link a purchase credit note to its original purchase invoice');
  if (note.creditSettled) throw new Error('This purchase credit note has already been reviewed');
  const original = documents.get(note.invoice.originalInvoiceId);
  if (!original || !positive(original.invoice) || original.invoice.type !== 'Purchase' || original.invoice.registrationId !== note.invoice.registrationId || original.invoice.partyId !== note.invoice.partyId) throw new Error('The credit note must retain its original purchase party and registration');
  const family = [...documents.values()].filter(document => positive(document.invoice) && supplierDocumentDate(document.invoice) <= supplierDocumentDate(note.invoice) && (document.invoice.id === original.invoice.id || document.invoice.originalInvoiceId === original.invoice.id));
  let source = input.creditSources;
  if (source === undefined) {
    source = [];
    for (const noteLine of note.lines) {
      for (const component of ITC_COMPONENTS) {
        const field = component + 'Paise', value = noteLine.original[field];
        if (!value) continue;
        const candidates = family.flatMap(document => document.lines.filter(line => line.itemId === noteLine.itemId && (noteLine.originalLineIndex == null || noteLine.originalLineIndex === line.originalLineIndex) && line.gstRateBps === noteLine.gstRateBps && line.cessRateBps === noteLine.cessRateBps).flatMap(line => BUCKETS.filter(bucket => bucket !== 'credited' && line.balances[bucket][field] >= value).map(bucket => ({ invoiceId: document.invoice.id, lineIndex: line.lineIndex, bucket }))));
        if (candidates.length !== 1) throw new Error('Choose exact original line and disposition allocations for this credit note');
        const candidate = candidates[0];
        let allocation = source.find(row => row.noteLineIndex === noteLine.lineIndex && row.invoiceId === candidate.invoiceId && row.lineIndex === candidate.lineIndex && row.bucket === candidate.bucket);
        if (!allocation) { allocation = { noteLineIndex: noteLine.lineIndex, ...candidate, ...zero() }; source.push(allocation); }
        allocation[field] = value;
      }
    }
  }
  if (!Array.isArray(source) || !source.length) throw new Error('Choose credit-note tax allocations');
  const covered = note.lines.map(() => zero());
  const used = new Map();
  const selections = source.map(allocation => {
    const document = family.find(value => value.invoice.id === allocation.invoiceId);
    const line = document?.lines[allocation.lineIndex], noteLine = note.lines[allocation.noteLineIndex];
    const noteSource = note.invoice.items[allocation.noteLineIndex], sourceLine = document?.invoice.items[allocation.lineIndex];
    if (!line || !noteLine || !Number.isSafeInteger(allocation.lineIndex) || !Number.isSafeInteger(allocation.noteLineIndex) || line.itemId !== noteLine.itemId || (noteLine.originalLineIndex != null && line.originalLineIndex !== noteLine.originalLineIndex) || supplierDocumentDate(document.invoice) > supplierDocumentDate(note.invoice) || sourceLine.gstRateBps !== noteSource.gstRateBps || sourceLine.cessRateBps !== noteSource.cessRateBps || !BUCKETS.includes(allocation.bucket) || allocation.bucket === 'credited') throw new Error('Invalid linked source line, tax treatment or disposition for credit note');
    const amounts = components(allocation);
    if (!total(amounts)) throw new Error('Enter a positive credit-note tax allocation');
    const key = `${allocation.invoiceId}:${allocation.lineIndex}:${allocation.bucket}`;
    const cumulative = used.get(key) || zero(); add(cumulative, amounts); used.set(key, cumulative);
    for (const component of ITC_COMPONENTS) if (cumulative[component + 'Paise'] > line.balances[allocation.bucket][component + 'Paise']) throw new Error('The credit note exceeds its original line and disposition tax');
    add(covered[allocation.noteLineIndex], amounts);
    return { invoiceId: allocation.invoiceId, lineIndex: allocation.lineIndex, noteLineIndex: allocation.noteLineIndex, from: allocation.bucket, to: 'credited', ...amounts };
  });
  if (note.lines.some((line, index) => !isDeepStrictEqual(covered[index], line.original))) throw new Error('Credit-note allocations must cover every note line and tax head exactly once');
  return selections;
}

function ledgerFor(document, accounts, bucket, component, lineIndex) {
  if (bucket === 'permanent') return serviceReceipt(document.invoice, lineIndex)?.sourceLedgerId || document.invoice.registration.accounts.nonCreditTax;
  if (bucket === 'claimable') return accounts['claimable-' + component];
  if (bucket.startsWith('temporary')) return accounts['temporary-' + component];
  return document.invoice.tallyOrigin?.accounts[component] || document.invoice.registration.accounts['input-' + component];
}

function journalLines(documents, invoice, accounts, transfers, action) {
  const ledgerAmounts = new Map();
  const post = (ledgerId, paise, sign) => {
    if (!ledgerId) throw new Error('Missing ITC posting account');
    ledgerAmounts.set(ledgerId, (ledgerAmounts.get(ledgerId) || 0n) + BigInt(paise) * BigInt(sign));
  };
  for (const transfer of transfers) {
    const source = documents.get(transfer.invoiceId);
    for (const component of ITC_COMPONENTS) {
      const paise = transfer[component + 'Paise']; if (!paise) continue;
      if (action === 'credit-note') {
        // The immutable note has already credited its original posting account.
        // Undo that leg and reduce the account holding the actual reviewed tax.
        post(invoice.itcEligibility === 'ineligible' ? invoice.registration.accounts.nonCreditTax : invoice.tallyOrigin?.accounts[component] || invoice.registration.accounts['input-' + component], paise, 1);
        post(ledgerFor(source, accounts, transfer.from, component, transfer.lineIndex), paise, -1);
      } else {
        post(ledgerFor(source, accounts, transfer.from, component, transfer.lineIndex), paise, -1);
        post(ledgerFor(source, accounts, transfer.to, component, transfer.lineIndex), paise, 1);
      }
    }
  }
  return [...ledgerAmounts.entries()].filter(([, paise]) => paise).map(([ledgerId, paise]) => ({ ledgerId, dc: paise > 0n ? 'Dr' : 'Cr', paise: exact(paise > 0n ? paise : -paise) })).sort((a, b) => a.ledgerId.localeCompare(b.ledgerId));
}

function returnRows(invoice, record, transfers) {
  const grouped = new Map();
  const row = (table, transfer, sign = 1) => {
    const key = `${table}:${sign}`;
    if (!grouped.has(key)) grouped.set(key, { recordId: record.id, invoiceId: invoice.id, registrationId: invoice.registrationId, date: record.date, table, sign, reason: record.reasonCode || record.action, ...zero() });
    add(grouped.get(key), transfer);
  };
  for (const transfer of transfers) {
    if (record.action === 'claim') row('4A(5)', transfer);
    if (record.action === 'reclaim') { row('4A(5)', transfer); row('4D(1)', transfer); }
    if (record.action === 'temporary') {
      if (transfer.from === 'claimable') row('4B(2)', transfer);
      else if (record.reportingMode === 'gross-and-reversal') { row('4A(5)', transfer); row('4B(2)', transfer); }
    }
    if (record.action === 'permanent') {
      const d2 = ['section16(4)', 'pos-restriction'].includes(record.reasonCode);
      if (d2) row('4D(2)', transfer);
      if (transfer.from === 'claimable') row(d2 ? '4B(2)' : '4B(1)', transfer);
      else if (transfer.from === 'temporary-reversed' || transfer.from === 'temporary-gross') {
        row('4A(5)', transfer); row('4D(1)', transfer); row('4B(1)', transfer);
      } else if (record.reportingMode === 'gross-and-reversal' && !d2) { row('4A(5)', transfer); row('4B(1)', transfer); }
    }
    if (record.action === 'credit-note' && transfer.from === 'claimable') row('4A(5)', transfer, -1);
  }
  return [...grouped.values()];
}

export function buildItcAction(company, vouchers, action, input, identity = {}) {
  if (!ACTIONS.includes(action)) throw new Error('Choose a supported purchase ITC review action');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter a purchase ITC review');
  const requestId = text(input.requestId, 'a save identifier', 80);
  if (!/^[A-Za-z0-9-]{16,80}$/.test(requestId)) throw new Error('Invalid purchase ITC save identifier');
  const requestHash = hash({ action, input });
  const existing = orderedRecords(company).find(record => record.requestId === requestId);
  if (existing) {
    if (existing.requestHash !== requestHash) throw new Error('This save identifier already belongs to a different ITC review');
    return { record: existing, voucher: vouchers.find(voucher => voucher.id === existing.voucherId) || null, replayed: true };
  }
  const actionDate = date(input.date, 'the ITC review date');
  if (actionDate < company.booksFrom) throw new Error('The ITC review precedes these books');
  const documents = replay(company, vouchers, actionDate);
  const document = documents.get(input.invoiceId);
  if (!document) throw new Error('Choose a forward-charge purchase document dated on or before this review');
  const invoice = document.invoice;
  // Replay previously recorded decisions exactly; new credit must identify one source document.
  if (!identity.id && !invoice.purchaseIdentityVersion && ["claim", "reclaim", "prior-claim"].includes(action) && legacySupplierConflicts(vouchers).has(invoice.id)) {
    throw new Error("This supplier document occurs in multiple historical entries. Reconcile their source identities before claiming ITC");
  }
  const accounts = company.gst?.itc?.accountsByRegistration?.[invoice.registrationId];
  if (!accounts) throw new Error('Set up purchase ITC posting accounts before recording a review');
  const evidence = normalizeEvidence(input.evidence, action, invoice, actionDate);
  const reference = text(input.reference, 'the review reference', 160);
  if (action !== 'credit-note' && document.credit) throw new Error('Use the credit-note review for a purchase credit note');
  if (action !== 'credit-note') {
    const family = invoice.type === 'Debit Note' ? invoice.originalInvoiceId : invoice.id;
    if ([...documents.values()].some(value => value.credit && value.invoice.originalInvoiceId === family && !value.creditSettled)) throw new Error('Review the linked purchase credit notes before changing this invoice credit');
  }
  let transfers;
  const reasonCode = input.reasonCode || (action === 'claim' || action === 'prior-claim' ? 'section16' : action === 'credit-note' ? 'credit-note' : '');
  const reportingMode = input.reportingMode || (action === 'temporary' ? 'hold-only' : action === 'permanent' ? 'cost-only' : 'normal');
  if (!['normal', 'gross-and-reversal', 'hold-only', 'cost-only'].includes(reportingMode)) throw new Error('Choose the ITC reporting context');
  if (action === 'permanent' && !ITC_PERMANENT_REASONS.includes(reasonCode)) throw new Error('Choose the permanent ineligibility provision');
  if (action === 'temporary' && !ITC_TEMPORARY_REASONS.includes(reasonCode)) throw new Error('Choose the temporary reversal provision');
  if (action === 'temporary' && evidence.expectedRecoverable !== true) throw new Error('Confirm the basis for treating the temporarily held tax as recoverable');
  if (reportingMode === 'gross-and-reversal') {
    if (!['temporary', 'permanent'].includes(action) || ['section16(4)', 'pos-restriction'].includes(reasonCode)) throw new Error('This disposition cannot be reported as gross ITC plus reversal');
    if (evidence.grossIncluded !== true) throw new Error('Confirm that this exact tax is included in gross Table 4(A)(5) for this return period');
    text(evidence.grossReference, 'the gross ITC return or statement evidence', 240);
    if (!['not-filed', 'filed'].includes(evidence.annualReturnStatus)) throw new Error('Review the relevant annual return status before gross ITC reporting');
    if (evidence.annualReturnStatus === 'filed') date(evidence.annualReturnFiledDate, 'the relevant annual return filing date');
    enforceFirstClaimDeadline(invoice, evidence, actionDate);
  }
  if (action === 'credit-note') transfers = creditSelections(documents, document, input);
  else {
    transfers = selections(document, action, input, evidence).map(selection => {
      let to = action === 'permanent' ? 'permanent' : action === 'temporary' ? (selection.from === 'claimable' ? 'temporary-reversed' : reportingMode === 'gross-and-reversal' ? 'temporary-gross' : 'temporary-hold') : 'claimable';
      return { ...selection, to };
    });
    if (action === 'claim') enforceFirstClaimDeadline(invoice, evidence, actionDate);
    if (action === 'prior-claim') enforceFirstClaimDeadline(invoice, evidence, evidence.priorClaimDate);
    if (action === 'reclaim' && transfers.some(transfer => transfer.from === 'temporary-gross')) enforceFirstClaimDeadline(invoice, evidence, actionDate);
    if (action === 'permanent' && transfers.some(transfer => ['temporary-reversed', 'temporary-gross'].includes(transfer.from))) {
      if (['section16(4)', 'pos-restriction'].includes(reasonCode)) throw new Error('A previously reversed time-barred or PoS amount needs separate return correction review');
      if (evidence.reversalStatementReviewed !== true) throw new Error('Review the reversal statement before reclassifying temporary credit as permanent');
    }
  }
  normalizeServiceReceipts(company, document, transfers, evidence, action, actionDate, reportingMode);
  const id = identity.id || `itc-${randomBytes(10).toString('hex')}`;
  const sequence = identity.sequence ?? Math.max(0, ...orderedRecords(company).map(record => record.sequence)) + 1;
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid ITC review sequence');
  const stockSequence = identity.stockSequence ?? Math.max(0, ...vouchers.map(voucher => voucher.stock?.sequence || 0), ...(company.stock?.journals || []).map(journal => journal.sequence || 0), ...orderedRecords(company).map(record => record.stockSequence || 0)) + 1;
  if (!Number.isSafeInteger(stockSequence) || stockSequence < 1) throw new Error('Invalid ITC stock cost sequence');
  const lines = journalLines(documents, invoice, accounts, transfers, action);
  const record = { version: 1, id, voucherId: lines.length ? id : null, sequence, stockSequence, action, date: actionDate,
    invoiceId: invoice.id, registrationId: invoice.registrationId, reference, reasonCode, reportingMode,
    evidence, invoiceHash: hash(invoice), sourceHashes: Object.fromEntries([...new Set(transfers.map(transfer => transfer.invoiceId))].map(sourceId => [sourceId, hash(documents.get(sourceId).invoice)])),
    transfers, lineAllocations: transfers.map(({ invoiceId, lineIndex, from, to, noteLineIndex, ...amounts }) => ({ invoiceId, lineIndex, fromBucket: from, ...(noteLineIndex === undefined ? {} : { noteLineIndex }), ...amounts })),
    components: transfers.reduce((sum, transfer) => add(sum, transfer), zero()), accounts: structuredClone(accounts),
    postingLines: lines, requestId, requestHash, request: structuredClone(input), sources: structuredClone(ITC_SOURCES), returnRows: [] };
  record.returnRows = returnRows(invoice, record, transfers);
  if (evidence.statement?.availability === 'N' && record.returnRows.some(row => row.table === '4A(5)')) throw new Error('Statement ITC marked not available cannot enter gross Table 4(A)(5)');
  const number = `ITC/${fyStart(actionDate).slice(2, 4)}/${String(sequence).padStart(6, '0')}`;
  const voucher = lines.length ? { id, type: 'Journal', date: actionDate, number, narration: `Purchase ITC ${action} · ${invoice.number} · ${reference}`.slice(0, 280), lines, gstItc: record } : null;
  return { record, voucher };
}

export function itcState(company, vouchers, to = todayISO(), { exclusive = false } = {}) {
  date(to, 'the ITC review date');
  const documents = replay(company, vouchers, to, exclusive);
  const records = orderedRecords(company).filter(record => record.date < to || !exclusive && record.date === to);
  const issues = [];
  const priorDocuments = vouchers.filter(v => v.date < to || (!exclusive && v.date === to));
  for (const invoiceId of legacySupplierConflicts(priorDocuments)) {
    if (documents.has(invoiceId)) issues.push({ invoiceId, code: "duplicate-supplier-document", message: "Multiple historical entries share this supplier registration, document number and supplier financial year. Check the source documents before claiming credit." });
  }
  const rows = [...documents.values()].map(document => {
    const invoice = document.invoice;
    const balances = Object.fromEntries(BUCKETS.map(bucket => [bucket, document.lines.reduce((sum, line) => add(sum, line.balances[bucket]), zero())]));
    if (document.credit && !document.creditSettled && invoice.totals.taxPaise) issues.push({ invoiceId: invoice.id, code: 'credit-note-review', message: 'Review this credit note against the original tax dispositions before making further claims.' });
    for (const record of records.filter(record => record.invoiceId === invoice.id)) {
      if (record.action === 'permanent' && record.reportingMode === 'cost-only' && !['section16(4)', 'pos-restriction'].includes(record.reasonCode) && record.transfers.some(transfer => ['unreviewed', 'unclaimed', 'temporary-hold'].includes(transfer.from))) issues.push({ invoiceId: invoice.id, recordId: record.id, code: 'gross-return-context', message: 'The cost decision is recorded; reconcile the gross available ITC and permanent reversal in the return using its actual reporting context.' });
      if (record.action === 'credit-note' && record.transfers.some(transfer => ['temporary-reversed', 'temporary-gross'].includes(transfer.from))) issues.push({ invoiceId: invoice.id, recordId: record.id, code: 'cancelled-reclaim-balance', message: 'This note cancels previously reversed tax. Reconcile the remaining electronic reclaim statement without reversing that credit twice.' });
    }
    return { id: invoice.id, invoiceId: invoice.id, registrationId: invoice.registrationId, number: invoice.number, supplierInvoiceNumber: invoice.supplierInvoiceNumber, supplierInvoiceDate: supplierDocDate(invoice),
      type: invoice.type, date: invoice.date, partyName: invoice.party.name, partyId: invoice.partyId, originalInvoiceId: invoice.originalInvoiceId || null,
      initialEligibility: invoice.itcEligibility, totals: invoice.totals, balances, lines: document.lines, creditSettled: document.creditSettled,
      claimDeadline: itcClaimDeadline(invoice).ordinary, recordIds: document.records };
  });
  return { to, documents: rows, records, issues, sources: ITC_SOURCES, components: ITC_COMPONENTS };
}

export function itcReturnRows(company, vouchers, from, to) {
  date(from, 'the return period start'); date(to, 'the return period end');
  if (from > to) throw new Error('Choose a valid ITC reporting period');
  return itcState(company, vouchers, to).records.filter(record => record.date >= from).flatMap(record => record.returnRows);
}

export function itcCostByLine(company, vouchers, to, { exclusive = false } = {}) {
  if (!company.gst?.itc?.records?.length) return new Map();
  const documents = replay(company, vouchers, to, exclusive);
  const result = new Map();
  for (const document of documents.values()) for (const line of document.lines) {
    let unknown, permanent;
    if (document.credit && document.creditSettled) {
      // Tax cancelled by a supplier note is no longer held as either credit or
      // inventory cost, even when its original eligibility was still unreviewed.
      unknown = 0;
      permanent = total(line.creditedByDisposition.permanent);
    } else if (document.credit) {
      unknown = document.invoice.itcEligibility === 'pending' ? total(line.original) : 0;
      permanent = document.invoice.itcEligibility === 'ineligible' ? total(line.original) : 0;
    } else {
      unknown = total(line.balances.unreviewed);
      permanent = exact(BigInt(total(line.balances.permanent)) + BigInt(total(line.creditedByDisposition.permanent)));
    }
    result.set(`${document.invoice.id}:${line.lineIndex}`, { complete: unknown === 0, permanentTaxPaise: permanent, reviewIds: [...new Set(line.reviewIds)], reviewedOn: [...line.costDates].sort().at(-1) || null });
  }
  return result;
}

export function itcStockReviews(company, vouchers) {
  const invoices = new Map(vouchers.filter(voucher => forward(voucher.gst)).map(voucher => [voucher.id, voucher.gst]));
  const events = [];
  for (const record of orderedRecords(company)) {
    const target = invoices.get(record.invoiceId);
    for (const [index, transfer] of record.transfers.entries()) {
      const invoice = invoices.get(transfer.invoiceId), line = invoice?.items[transfer.lineIndex];
      if (!invoice || !line) throw new Error('Missing purchase line in dated ITC stock cost review');
      if (line.kind !== 'goods') continue;
      const tax = total(transfer);
      let costDelta = 0, purchaseFlowDelta = 0;
      if (record.action === 'credit-note') {
        purchaseFlowDelta = transfer.from === 'permanent' ? target.itcEligibility === 'ineligible' ? 0 : -tax : target.itcEligibility === 'ineligible' ? tax : 0;
      } else {
        costDelta = transfer.to === 'permanent' && transfer.from !== 'permanent' ? tax : transfer.from === 'permanent' && transfer.to !== 'permanent' ? -tax : 0;
        purchaseFlowDelta = costDelta;
      }
      const physicalSource = invoice.stockEffect === 'quantity';
      const physicalNote = record.action === 'credit-note' && target.stockEffect === 'quantity';
      if (!physicalSource) costDelta = 0;
      if (!physicalSource && !physicalNote && !purchaseFlowDelta) continue;
      events.push({ sourceId: record.id, sourceType: 'itc-review', number: `ITC/${record.sequence}`, date: record.date,
        sequence: record.stockSequence, lineIndex: index, itemId: line.itemId, kind: 'itc-cost',
        originSourceId: invoice.id, originLineIndex: transfer.lineIndex, pendingReduction: physicalSource && transfer.from === 'unreviewed' ? tax : 0,
        noteSourceId: record.action === 'credit-note' ? target.id : null,
        noteLineIndex: transfer.noteLineIndex, notePendingReduction: physicalNote && target.itcEligibility === 'pending' ? tax : 0,
        costDelta, purchaseFlowDelta, recordId: record.id });
    }
  }
  return events;
}

export function assertItcBook(company, vouchers) {
  const master = company.gst?.itc;
  if (master !== undefined) {
    if (master.version !== 1 || !master.accountsByRegistration || typeof master.accountsByRegistration !== 'object' || Array.isArray(master.accountsByRegistration) || !Array.isArray(master.records)) throw new Error('Invalid purchase ITC review configuration');
    const seen = new Set();
    for (const [registrationId, accounts] of Object.entries(master.accountsByRegistration)) {
      if (!company.gst.registrations.some(registration => registration.id === registrationId)) throw new Error('ITC review accounts reference a missing registration');
      for (const role of ['claimable', 'temporary']) for (const component of ITC_COMPONENTS) {
        const id = accounts[role + '-' + component];
        if (seen.has(id) || !company.ledgers.some(ledger => ledger.id === id && ledger.groupId === 'g-current-assets' && ledger.opening?.paise === 0)) throw new Error('Invalid ITC review posting account');
        seen.add(id);
      }
    }
  }
  const prior = structuredClone(company);
  if (prior.gst?.itc) prior.gst.itc.records = [];
  const ids = new Set(), requests = new Set(), sequences = new Set(), linked = new Set();
  for (const record of orderedRecords(company)) {
    if (ids.has(record.id) || requests.has(record.requestId) || sequences.has(record.sequence)) throw new Error('Duplicate ITC review identity, request or sequence');
    ids.add(record.id); requests.add(record.requestId); sequences.add(record.sequence);
    const expected = buildItcAction(prior, vouchers, record.action, record.request, { id: record.id, sequence: record.sequence, stockSequence: record.stockSequence });
    if (!isDeepStrictEqual(expected.record, record)) throw new Error('ITC review facts, allocations, evidence or return rows differ from their saved calculation');
    if (expected.voucher) {
      const actual = vouchers.find(voucher => voucher.id === record.voucherId);
      if (!actual || !isDeepStrictEqual(actual.gstItc, record) || ['type', 'date', 'number', 'narration', 'lines'].some(key => !isDeepStrictEqual(actual[key], expected.voucher[key]))) throw new Error('The ITC review accounting entry is missing or altered');
      linked.add(record.voucherId);
    } else if (record.voucherId !== null) throw new Error('An evidence-only ITC review cannot invent an accounting entry');
    prior.gst.itc.records.push(record);
  }
  if (vouchers.some(voucher => voucher.gstItc && !linked.has(voucher.id))) throw new Error('Orphaned purchase ITC accounting entry');
  return true;
}
