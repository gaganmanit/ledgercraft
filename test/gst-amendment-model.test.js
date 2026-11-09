import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AMENDMENT_SOURCES, buildOutwardAmendment, buildAmendmentEvent, activeOutwardAmendments, assertOutwardAmendments, outwardDocumentSnapshot, outwardAmendmentState, normalizeReportedSnapshot } from '../lib/gst-outward-amendments.js';
import { gstinCheckDigit } from '../lib/gst.js';
import { handleAmendmentRoute } from '../lib/gst-amendment-routes.js';
import { createStore } from '../lib/store.js';
import { companyBackup, validateTransfer } from '../lib/transfer.js';

const gstin = prefix => prefix + gstinCheckDigit(prefix);
const zero = () => ({ igstPaise: 0, cgstPaise: 0, sgstPaise: 0, utgstPaise: 0, cessPaise: 0 });
let count = 0;
function fixture(options = {}) {
  const registration = { id: 'reg', name: 'Public registration', gstin: gstin('23ABCDE1234F1Z'), stateCode: '23' };
  const company = { id: 'synthetic-amendments', name: 'Public amendment fixture', booksFrom: '2026-04-01', gst: { registrations: [registration] } };
  const item = { itemId: 'goods', name: 'Public goods', kind: 'goods', hsnSac: '85414090', unit: 'NOS', quantity: '1', gstRateBps: 1800, supplyStatus: 'taxable', taxablePaise: 1000, ...zero(), cgstPaise: 90, sgstPaise: 90, taxPaise: 180, totalPaise: 1180 };
  const invoice = { id: 'actual', voucherId: 'actual', number: 'ACTUAL/1', date: '2026-04-10', type: 'Sales', direction: 'sales', registrationId: 'reg', registration,
    partyId: 'recipient', party: { id: 'recipient', name: 'Public recipient', gstin: gstin('23LMNOP1234Q1Z') }, placeOfSupply: '23', supplyCategory: 'domestic', exportMode: null, reverseCharge: false, stockEffect: 'quantity', items: [item],
    totals: { taxablePaise: 1000, ...zero(), cgstPaise: 90, sgstPaise: 90, taxPaise: 180, totalPaise: 1180 }, ...options };
  const vouchers = [{ id: invoice.id, date: invoice.date, type: invoice.type, number: invoice.number, gst: invoice, lines: [{ ledgerId: 'unchanged', dc: 'Dr', paise: 1180 }, { ledgerId: 'other', dc: 'Cr', paise: 1180 }] }];
  return { company, vouchers, invoice };
}
function inputFor(f, overrides = {}) {
  const actual = outwardDocumentSnapshot(f.invoice, f.vouchers);
  const { hsnRows, ...prior } = actual;
  return { invoiceId: f.invoice.id, date: '2026-06-01', filingDate: '2026-06-11', amendmentPeriod: '2026-05', originalPeriod: '2026-04', revision: f.company.gst.outwardAmendments?.revision || 0,
    requestId: `public-amendment-${String(++count).padStart(8, '0')}`, originalReported: { ...prior, number: 'filed/old' },
    originalFiling: { form: 'GSTR-1', reference: 'PUBLIC-FILED-APRIL', filedDate: '2026-05-11', confirmedFiled: true },
    evidence: { basis: 'Public reporting mistake; posted books are accurate', documentReference: 'PUBLIC-RECON-1', accurateBooksConfirmed: true, reportedSnapshotConfirmed: true }, annualReturnStatus: 'not-filed', ...overrides };
}
function prepare(f, input = inputFor(f)) {
  const preview = buildOutwardAmendment(f.company, f.vouchers, input, { preview: true });
  return { ...input, previewHash: preview.previewHash };
}
function save(f, input = prepare(f)) {
  const result = buildOutwardAmendment(f.company, f.vouchers, input);
  if (!result.replayed) {
    f.company.gst.outwardAmendments ||= { version: 1, revision: 0, records: [] };
    f.company.gst.outwardAmendments.records.push(result.record);
    f.company.gst.outwardAmendments.revision = result.revision;
    assert.equal(assertOutwardAmendments(f.company, f.vouchers), true);
  }
  return result;
}
function scalePrior(snapshot, factor) {
  const result = structuredClone(snapshot);
  delete result.hsnRows;
  result.rates = result.rates.map(row => ({ ...row, ...Object.fromEntries(['taxablePaise', ...Object.keys(zero())].map(field => [field, row[field] * factor])) }));
  result.invoiceValuePaise *= factor;
  return result;
}

test('the filed comparator is independent of accurate books, carries full revised values, and creates no accounting entry', () => {
  const f = fixture(); const before = JSON.stringify(f.vouchers);
  const input = inputFor(f); input.originalReported = scalePrior(input.originalReported, 2);
  const result = save(f, prepare(f, input));
  assert.equal(JSON.stringify(f.vouchers), before);
  assert.equal(f.vouchers.length, 1);
  assert.equal(result.record.originalReported.rates[0].taxablePaise, 2000);
  assert.equal(result.record.revised.rates[0].taxablePaise, 1000);
  assert.equal(result.record.delta.taxablePaise, -1000);
  assert.equal(result.record.delta.cgstPaise, -90);
  assert.equal(result.record.section, 'b2ba');
  assert.equal(result.record.status, 'prepared');
  assert.equal(result.record.hsnAttribution, 'missing');
  assert.equal(Object.hasOwn(result, 'voucher'), false);
});

test('original number case is retained for export/provenance but folded for identity collisions', () => {
  const f = fixture(); const original = inputFor(f);
  const first = save(f, prepare(f, original));
  assert.equal(first.record.originalReported.number, 'filed/old');
  f.vouchers.push({ ...structuredClone(f.vouchers[0]), id: 'other', gst: { ...structuredClone(f.invoice), id: 'other', voucherId: 'other', number: 'OTHER/1' } });
  const next = { ...inputFor(f), invoiceId: 'other', originalReported: { ...original.originalReported, number: 'FILED/OLD' }, revision: 1 };
  assert.throws(() => prepare(f, next), /already assigned/);
});

test('preview binds actual invoice identity, input and evidence independently of the amendment revision', () => {
  const f = fixture(); const input = prepare(f);
  f.invoice.number = 'ACTUAL/2';
  assert.throws(() => save(f, input), /changed after preview/);
  f.invoice.number = 'ACTUAL/1'; input.evidence.documentReference = 'DIFFERENT';
  assert.throws(() => save(f, input), /changed after preview/);
  assert.throws(() => buildOutwardAmendment(f.company, f.vouchers, inputFor(f)), /preview it again/);
});

test('filing evidence, exact source reference and explicit confirmation are required without retaining source bytes', () => {
  const f = fixture(); const input = inputFor(f);
  input.originalFiling.confirmedFiled = false;
  assert.throws(() => prepare(f, input), /Confirm the original filed/);
  input.originalFiling.confirmedFiled = true;
  input.originalFiling.source = { fileName: 'public-return.json', sha256: 'a'.repeat(64), bytes: 500, documentKey: 'PUBLIC|1', section: 'b2b', sourcePeriod: '2026-04' };
  input.sourceFileBase64 = 'QUJDRA==';
  const result = save(f, prepare(f, input));
  assert.equal(result.record.originalFiling.source.bytes, 500);
  assert.equal(JSON.stringify(result.record).includes('QUJDRA=='), false);
  assert.equal(Object.hasOwn(result.record.request, 'sourceFileBase64'), false);
  const other = fixture(); const bad = inputFor(other); bad.originalFiling.source = { ...input.originalFiling.source, fileName: '../private.json' };
  assert.throws(() => prepare(other, bad), /filename/);
});

test('the model requires separate evidence for reported particulars and accurate accounting facts', () => {
  const f = fixture(); const input = inputFor(f);
  input.evidence.reportedSnapshotConfirmed = false;
  assert.throws(() => prepare(f, input), /separately/);
  input.evidence.reportedSnapshotConfirmed = true; input.evidence.accurateBooksConfirmed = false;
  assert.throws(() => prepare(f, input), /separately/);
});

test('period ordering, document financial year, ordinary cutoff and earlier annual return prevent unsupported filing', () => {
  const f = fixture();
  assert.throws(() => prepare(f, inputFor(f, { amendmentPeriod: '2026-04' })), /earlier reported/);
  assert.throws(() => prepare(f, inputFor(f, { filingDate: '2026-05-15' })), /filing dates|period end/);
  assert.throws(() => prepare(f, inputFor(f, { date: '2027-11-01', amendmentPeriod: '2027-11', filingDate: '2027-12-11' })), /outside section 37/);
  assert.throws(() => prepare(f, inputFor(f, { annualReturnStatus: 'filed', annualReturnFiledDate: '2026-06-11' })), /outside section 37/);
  const wrongFy = inputFor(f); wrongFy.originalReported.date = '2025-04-10';
  assert.throws(() => prepare(f, wrongFy), /Cross-financial-year/);
  const valid = save(f, prepare(f, inputFor(f, { date: '2027-11-01', amendmentPeriod: '2027-10', filingDate: '2027-11-30' })));
  assert.equal(valid.record.cutoff.ordinaryDate, '2027-11-30');
});

test('save identifiers are idempotent, revisions reject stale writers, and a posted document is amended once', () => {
  const f = fixture(); const input = prepare(f); const first = save(f, input);
  assert.equal(save(f, input).replayed, true);
  assert.equal(f.company.gst.outwardAmendments.records.length, 1);
  const wrong = { ...input, evidence: { ...input.evidence, basis: 'Different basis' } };
  assert.throws(() => save(f, wrong), /different reporting correction/);
  assert.throws(() => prepare(f, { ...inputFor(f), revision: 0 }), /register changed/);
  assert.throws(() => prepare(f, inputFor(f)), /already saved/);
  assert.equal(first.revision, 1);
});

test('literal invoice value may include legitimate amounts outside the rate tax totals', () => {
  const f = fixture(); const input = inputFor(f);
  input.originalReported.invoiceValuePaise = 1200;
  const result = save(f, prepare(f, input));
  assert.equal(result.record.originalReported.invoiceValuePaise, 1200);
  assert.equal(result.record.reconciliation.originalInvoiceValueDifferencePaise, 20);
  assert.equal(result.record.delta.totalPaise, -20);
});

test('explicit per-document HSN attribution preserves codes/quantities and must reconcile every rate and head', () => {
  const f = fixture(); const input = inputFor(f);
  input.originalReported.hsnRows = [{ hsnSac: '01012100', uqc: 'NOS', quantity: '0.250001', gstRateBps: 1800, taxablePaise: 1000, ...zero(), cgstPaise: 90, sgstPaise: 90, totalPaise: 1180 }];
  const result = save(f, prepare(f, input));
  assert.equal(result.record.hsnAttribution, 'known');
  assert.equal(result.record.originalReported.hsnRows[0].hsnSac, '01012100');
  assert.equal(result.record.originalReported.hsnRows[0].quantity, '0.250001');
  const g = fixture(); const bad = inputFor(g); bad.originalReported.hsnRows = structuredClone(input.originalReported.hsnRows); bad.originalReported.hsnRows[0].cgstPaise = 89;
  assert.throws(() => prepare(g, bad), /every rate and tax head/);
  bad.originalReported.hsnRows[0].cgstPaise = 90; bad.originalReported.hsnRows[0].quantity = '0.0000001';
  assert.throws(() => prepare(g, bad), /six decimal/);
});

test('B2CL, exports and registered/unregistered notes use the corresponding amendment section', () => {
  const b = fixture({ party: { name: 'Public consumer', gstin: '' }, placeOfSupply: '27' });
  b.invoice.items[0] = { ...b.invoice.items[0], taxablePaise: 10000000, ...zero(), igstPaise: 1800000, taxPaise: 1800000, totalPaise: 11800000 };
  b.invoice.totals = { ...b.invoice.items[0] };
  assert.equal(save(b, prepare(b)).record.section, 'b2cla');
  for (const note of [false, true]) for (const mode of ['lut', 'with-payment']) {
    const e = fixture({ party: { name: 'Public foreign buyer', gstin: '' }, supplyCategory: 'export', exportMode: mode, placeOfSupply: '96', type: note ? 'Debit Note' : 'Sales' });
    e.invoice.items[0] = { ...e.invoice.items[0], supplyStatus: 'zero-rated', ...zero(), igstPaise: mode === 'lut' ? 0 : 180, taxPaise: mode === 'lut' ? 0 : 180, totalPaise: mode === 'lut' ? 1000 : 1180 };
    e.invoice.totals = { ...e.invoice.items[0] };
    const record = save(e, prepare(e)).record;
    assert.equal(record.section, note ? 'cdnura' : 'expa');
    if (note) assert.equal(record.revised.urType, mode === 'lut' ? 'EXPWOP' : 'EXPWP');
  }
  for (const type of ['Credit Note', 'Debit Note']) {
    const n = fixture({ type, originalDate: '2026-04-01' });
    const input = inputFor(n); input.originalReported = scalePrior(input.originalReported, 2);
    const record = save(n, prepare(n, input)).record;
    assert.equal(record.section, 'cdnra');
    assert.equal(record.delta.cgstPaise, type === 'Credit Note' ? 90 : -90);
  }
});

test('normal outward RCM and SEZ preserve classification and tax-head treatment', () => {
  const r = fixture({ reverseCharge: true });
  assert.equal(save(r, prepare(r)).record.revised.reverseCharge, true);
  const g = fixture({ reverseCharge: true }); const bad = inputFor(g); bad.originalReported.reverseCharge = false;
  assert.throws(() => prepare(g, bad), /classification is locked/);
  for (const mode of ['lut', 'with-payment']) {
    const s = fixture({ supplyCategory: 'sez', exportMode: mode, placeOfSupply: '27' });
    s.invoice.items[0] = { ...s.invoice.items[0], supplyStatus: 'zero-rated', ...zero(), igstPaise: mode === 'lut' ? 0 : 180, taxPaise: mode === 'lut' ? 0 : 180, totalPaise: mode === 'lut' ? 1000 : 1180 };
    s.invoice.totals = { ...s.invoice.items[0] };
    assert.equal(save(s, prepare(s)).record.revised.invoiceType, mode === 'lut' ? 'SEZ supplies without payment' : 'SEZ supplies with payment');
  }
});

test('EXPA can add explicitly evidenced shipping details with zero liability change and immutable accounting', () => {
  const e = fixture({ party: { name: 'Public foreign buyer', gstin: '' }, supplyCategory: 'export', exportMode: 'with-payment', placeOfSupply: '96' });
  e.invoice.items[0] = { ...e.invoice.items[0], supplyStatus: 'zero-rated', ...zero(), igstPaise: 180, taxPaise: 180 };
  e.invoice.totals = { ...e.invoice.items[0] };
  const input = inputFor(e); input.originalReported = outwardDocumentSnapshot(e.invoice, e.vouchers); delete input.originalReported.hsnRows;
  input.shippingUpdate = { portCode: 'inbom1', shippingBillNumber: '1234567', shippingBillDate: '2026-05-20', documentReference: 'PUBLIC-CUSTOMS-EVIDENCE' };
  const before = JSON.stringify(e.vouchers);
  const result = save(e, prepare(e, input));
  assert.equal(result.record.delta.taxPaise, 0);
  assert.equal(result.record.section, 'expa');
  assert.equal(result.record.revised.portCode, 'INBOM1');
  assert.equal(result.record.revised.shippingBillNumber, '1234567');
  assert.equal(result.record.shippingUpdate.documentReference, 'PUBLIC-CUSTOMS-EVIDENCE');
  assert.equal(JSON.stringify(e.vouchers), before);
  assert.equal(assertOutwardAmendments(JSON.parse(JSON.stringify(e.company)), JSON.parse(before)), true);
  const other = fixture(); const invalid = inputFor(other); invalid.shippingUpdate = input.shippingUpdate;
  assert.throws(() => prepare(other, invalid), /only be updated through EXPA/);
});

test('shipping-only updates need customs evidence, complete particulars and a date no later than intended filing', () => {
  const e = fixture({ party: { name: 'Public foreign buyer', gstin: '' }, supplyCategory: 'export', exportMode: 'lut', placeOfSupply: '96' });
  e.invoice.items[0] = { ...e.invoice.items[0], supplyStatus: 'zero-rated', ...zero(), taxPaise: 0, totalPaise: 1000 };
  e.invoice.totals = { ...e.invoice.items[0] };
  const input = inputFor(e);
  input.shippingUpdate = { portCode: 'INBOM1', shippingBillNumber: '7654321', shippingBillDate: '2026-06-12', documentReference: 'PUBLIC-CUSTOMS' };
  assert.throws(() => prepare(e, input), /after the intended/);
  input.shippingUpdate.shippingBillDate = '2026-05-20'; delete input.shippingUpdate.documentReference;
  assert.throws(() => prepare(e, input), /customs evidence/);
  input.shippingUpdate.documentReference = 'PUBLIC-CUSTOMS'; delete input.shippingUpdate.portCode;
  assert.throws(() => prepare(e, input), /together/);
});

test('tax-reducing credit-note corrections also respect the earlier original supply-year cutoff', () => {
  const f = fixture({ type: 'Credit Note', originalDate: '2025-12-10' });
  const input = inputFor(f, { date: '2026-11-01', amendmentPeriod: '2026-10', filingDate: '2026-11-30' });
  input.originalReported = scalePrior(input.originalReported, 0.5);
  const result = save(f, prepare(f, input));
  assert.equal(result.record.cutoff.basis, 'section34(2)');
  assert.equal(result.record.cutoff.ordinaryDate, '2026-11-30');
  const g = fixture({ type: 'Credit Note', originalDate: '2025-12-10' });
  const late = inputFor(g, { date: '2027-01-01', amendmentPeriod: '2026-12', filingDate: '2027-01-11' });
  late.originalReported = scalePrior(late.originalReported, 0.5);
  assert.throws(() => prepare(g, late), /outside section 37/);
});

test('unsupported recipient, section, tax-head, export mode and note-kind reclassifications are blocked', () => {
  const f = fixture(); const recipient = inputFor(f); recipient.originalReported.recipientGstin = gstin('23PQRST1234N1Z');
  assert.throws(() => prepare(f, recipient), /GSTIN is locked/);
  const heads = inputFor(f); heads.originalReported.rates = [{ gstRateBps: 1800, taxablePaise: 1000, ...zero(), igstPaise: 180 }];
  assert.throws(() => prepare(f, heads), /tax-head treatment is locked/);
  const n = fixture({ type: 'Debit Note' }); const wrongType = inputFor(n); wrongType.originalReported.noteType = 'C';
  assert.throws(() => prepare(n, wrongType), /note kind/);
  const taxable = inputFor(f); taxable.originalReported.rates[0].supplyStatus = 'exempt';
  assert.throws(() => prepare(f, taxable), /Nil-rated, exempt/);
});

test('cross-month corrected document dates retain one immutable books identity and a separate original return period', () => {
  const f = fixture({ date: '2026-05-02' }); const input = inputFor(f); input.originalReported.date = '2026-04-29';
  const result = save(f, prepare(f, input));
  assert.equal(result.record.originalPeriod, '2026-04');
  assert.equal(result.record.revised.date, '2026-05-02');
  assert.equal(f.vouchers.length, 1); assert.equal(f.vouchers[0].date, '2026-05-02');
  assert.equal(outwardAmendmentState(f.company, f.vouchers, { registrationId: 'reg', month: '2026-05' }).periodRecords.length, 1);
});

test('restore detects altered source books, prior figures, metadata, duplicate records and missing locked identity', () => {
  const f = fixture(); save(f);
  const restored = JSON.parse(JSON.stringify(f));
  assert.equal(assertOutwardAmendments(restored.company, restored.vouchers), true);
  restored.company.gst.outwardAmendments.records[0].originalReported.rates[0].taxablePaise += 1;
  assert.throws(() => assertOutwardAmendments(restored.company, restored.vouchers), /reconciliation trace changed/);
  const altered = structuredClone(f); altered.vouchers[0].gst.number = 'CHANGED';
  assert.throws(() => assertOutwardAmendments(altered.company, altered.vouchers), /changed after preview/);
  const duplicate = structuredClone(f); duplicate.company.gst.outwardAmendments.records.push(duplicate.company.gst.outwardAmendments.records[0]); duplicate.company.gst.outwardAmendments.revision++;
  assert.throws(() => assertOutwardAmendments(duplicate.company, duplicate.vouchers), /duplicate outward amendment|history sequence/);
});

test('safe paise arithmetic, positive quantities and literal source shipping are preserved or rejected explicitly', () => {
  const f = fixture(); const unsafe = inputFor(f); unsafe.originalReported.rates[0].cgstPaise = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => prepare(f, unsafe), /safe integer paise/);
  const unknownSource = inputFor(f); unknownSource.originalReported.portCode = 'INBOM1';
  assert.throws(() => prepare(f, unknownSource), /shipping details/);
  assert.throws(() => normalizeReportedSnapshot({ ...inputFor(f).originalReported, invoiceValuePaise: -1 }), /nonnegative/);
});

test('routes separate pure preview from serial company-only save', async () => {
  const f = fixture(); const input = inputFor(f); let sent, called;
  const store = { snapshot: async () => f, saveGstAmendment: async (...args) => { called = args; return { record: { id: 'public' }, revision: 1 }; } };
  const parts = ['api', 'companies', f.company.id, 'gst', 'amendments'];
  const shared = { res: {}, url: new URL('http://localhost/?registration=reg&month=2026-05'), store, send: (_res, status, body) => { sent = { status, body }; }, readBody: async () => input };
  const before = JSON.stringify(f.company);
  await handleAmendmentRoute({ ...shared, parts: [...parts, 'preview'], req: { method: 'POST' } });
  assert.match(sent.body.previewHash, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(f.company), before);
  await handleAmendmentRoute({ ...shared, parts: [...parts, 'save'], req: { method: 'POST' } });
  assert.deepEqual(called, [f.company.id, input]); assert.equal(sent.status, 201);
  await handleAmendmentRoute({ ...shared, parts, req: { method: 'GET' }, url: new URL('http://localhost/?mode=desk&registration=reg&month=2026-05&invoice=actual&offset=0&historyOffset=0') });
  assert.equal(sent.body.mode, 'desk'); assert.equal(sent.body.documents.length, 1);
  assert.equal(sent.body.documents[0].actual, undefined); assert.ok(sent.body.selected.actual);
  await assert.rejects(handleAmendmentRoute({ ...shared, parts, req: { method: 'GET' }, url: new URL('http://localhost/?mode=desk&registration=reg&offset=-1') }), /page offset/);
});

test('normal company backup and restore retain a saved reporting correction with no extra voucher', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'financer-amendment-model-'));
  try {
    const store = createStore(scratch);
    const { company } = await store.create({ name: 'Public amendment backup test', booksFrom: '2026-04-01' });
    const { registration } = await store.saveGstMaster(company.id, 'registration', { name: 'Public registration', gstin: gstin('23ABCDE1234F1Z'), stateCode: '23', address: 'Public fixture address' });
    const { party } = await store.saveGstMaster(company.id, 'party', { name: 'Public recipient', kind: 'customer', gstin: gstin('23LMNOP1234Q1Z'), stateCode: '23', address: 'Public buyer address' });
    const { item } = await store.saveGstMaster(company.id, 'item', { name: 'Public goods', kind: 'goods', hsnSac: '8541', unit: 'NOS', gstRateBps: 1800, pricePaise: 1000 });
    const { invoice } = await store.passGstInvoice(company.id, { type: 'Sales', date: '2026-04-10', registrationId: registration.id, partyId: party.id, placeOfSupply: '23', items: [{ itemId: item.id, quantity: '1' }] });
    const original = await store.get(company.id); const f = { ...original, invoice };
    const saved = await store.saveGstAmendment(company.id, prepare(f, inputFor(f)));
    const book = await store.get(company.id);
    assert.equal(book.vouchers.length, 1);
    const restored = validateTransfer(companyBackup(book.company, book.vouchers));
    assert.equal(restored.company.gst.outwardAmendments.records[0].id, saved.record.id);
    assert.equal(assertOutwardAmendments(restored.company, restored.vouchers), true);
    const bad = companyBackup(book.company, book.vouchers); bad.company.gst.outwardAmendments.records[0].delta.cgstPaise += 1;
    assert.throws(() => validateTransfer(bad), /reconciliation trace changed/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

function disposition(f, action, record, overrides = {}) {
  const input = { amendmentId: record.id, revision: f.company.gst.outwardAmendments.revision,
    requestId: `public-disposition-${String(++count).padStart(8, '0')}`, date: '2026-06-15', reference: 'PUBLIC-DISPOSITION', basis: 'Public reviewed disposition',
    ...(action === 'withdraw' ? { confirmedUnfiled: true } : { filing: { form: 'GSTR-1', period: record.amendmentPeriod, reference: 'PUBLIC-CORRECTION-FILED', filedDate: '2026-06-11', confirmedFiled: true } }), ...overrides };
  const result = buildAmendmentEvent(f.company, f.vouchers, action, input);
  if (!result.replayed) {
    f.company.gst.outwardAmendments.events ||= [];
    f.company.gst.outwardAmendments.events.push(result.event);
    f.company.gst.outwardAmendments.revision = result.revision;
    assert.equal(assertOutwardAmendments(f.company, f.vouchers), true);
  }
  return { ...result, input };
}

test('an unfiled preparation can be withdrawn without losing history, then replaced once', () => {
  const f = fixture(); const original = save(f).record; const before = JSON.stringify(f.vouchers);
  const withdrawn = disposition(f, 'withdraw', original);
  assert.equal(withdrawn.event.sequence, 2);
  assert.equal(withdrawn.event.afterSequence, 1);
  assert.equal(activeOutwardAmendments(f.company, f.vouchers).length, 0);
  assert.equal(f.company.gst.outwardAmendments.records.length, 1);
  const report = outwardAmendmentState(f.company, f.vouchers, { registrationId: 'reg', month: '2026-05' });
  assert.equal(report.withdrawnRecords.length, 1); assert.equal(report.periodRecords.length, 0);
  assert.equal(report.records[0].effectiveStatus, 'withdrawn');
  const replacement = save(f, prepare(f, inputFor(f))).record;
  assert.equal(replacement.sequence, 3);
  assert.equal(activeOutwardAmendments(f.company)[0].id, replacement.id);
  assert.equal(JSON.stringify(f.vouchers), before);
});

test('confirmed external filing is recorded with exact evidence and prevents withdrawal or duplicate replacement', () => {
  const f = fixture(); const record = save(f).record;
  const filed = disposition(f, 'record-filing', record);
  assert.equal(activeOutwardAmendments(f.company)[0].effectiveStatus, 'filed');
  assert.equal(activeOutwardAmendments(f.company)[0].filing.reference, 'PUBLIC-CORRECTION-FILED');
  assert.throws(() => disposition(f, 'withdraw', record), /Only an active unfiled/);
  assert.throws(() => prepare(f, inputFor(f)), /already saved/);
  assert.equal(buildAmendmentEvent(f.company, f.vouchers, 'record-filing', filed.input).replayed, true);
});

test('dispositions require explicit unfiled/filed evidence and enforce actual filing cutoff instead of asserting success', () => {
  const f = fixture(); const record = save(f).record;
  assert.throws(() => disposition(f, 'withdraw', record, { confirmedUnfiled: false }), /Confirm that this preparation has not been filed/);
  assert.throws(() => disposition(f, 'record-filing', record, { filing: { form: 'GSTR-1A', period: record.amendmentPeriod, reference: 'OTHER', filedDate: '2026-06-11', confirmedFiled: true } }), /externally filed GSTR-1 correction/);
  assert.throws(() => disposition(f, 'record-filing', record, { date: '2028-01-01', filing: { form: 'GSTR-1', period: record.amendmentPeriod, reference: 'LATE', filedDate: '2027-12-01', confirmedFiled: true } }), /outside the supported standard/);
  assert.equal(f.company.gst.outwardAmendments.events?.length || 0, 0);
});

test('mixed record/event restore uses global sequence and detects altered withdrawal and reused save identities', () => {
  const f = fixture(); const record = save(f).record;
  const withdrawal = disposition(f, 'withdraw', record);
  save(f, prepare(f, inputFor(f)));
  const restored = JSON.parse(JSON.stringify(f));
  assert.equal(assertOutwardAmendments(restored.company, restored.vouchers), true);
  restored.company.gst.outwardAmendments.events[0].confirmedUnfiled = false;
  assert.throws(() => assertOutwardAmendments(restored.company, restored.vouchers), /reconciliation trace changed/);
  const stale = { ...withdrawal.input, requestId: `public-disposition-${String(++count).padStart(8, '0')}`, revision: 1 };
  assert.throws(() => buildAmendmentEvent(f.company, f.vouchers, 'withdraw', stale), /history changed/);
  const reused = { ...inputFor(f), requestId: withdrawal.event.requestId };
  assert.throws(() => prepare(f, reused), /belongs to an amendment disposition/);
});

test('pre-FY2021-22 documents and original credit-note supplies go to legacy review rather than inherit a November deadline', () => {
  assert.equal(AMENDMENT_SOURCES.some(source => source.url === 'https://www.pib.gov.in/PressReleasePage.aspx?PRID=1865179'), true);
  const f = fixture({ date: '2020-04-10' }); f.company.booksFrom = '2020-04-01';
  const input = inputFor(f, { originalPeriod: '2020-04', amendmentPeriod: '2020-05', date: '2020-06-01', filingDate: '2020-06-11', originalFiling: { form: 'GSTR-1', reference: 'PUBLIC-LEGACY-FILING', filedDate: '2020-05-11', confirmedFiled: true } });
  assert.throws(() => prepare(f, input), /legacy statutory review/);
  const note = fixture({ type: 'Credit Note', originalDate: '2020-12-10' });
  const prior = inputFor(note); prior.originalReported = scalePrior(prior.originalReported, 0.5);
  assert.throws(() => prepare(note, prior), /legacy credit-note cutoff review/);
});

test('a correction cannot claim an accurate document was already issued before its own preparation date', () => {
  const f = fixture({ date: '2026-07-10' });
  const input = inputFor(f, { amendmentPeriod: '2026-07', filingDate: '2026-08-11' });
  input.originalReported.date = '2026-04-10';
  assert.throws(() => prepare(f, input), /already issued document/);
});

test('desk pages are bounded and all documents/history remain reachable, including a selected record outside search or period', () => {
  const f = fixture();
  for (let index = 1; index < 160; index++) {
    const voucher = structuredClone(f.vouchers[0]);
    voucher.id = 'actual-' + index; voucher.number = 'ACTUAL/' + index;
    voucher.gst.id = voucher.id; voucher.gst.voucherId = voucher.id; voucher.gst.number = voucher.number;
    f.vouchers.push(voucher);
  }
  const saved = [];
  for (let index = 0; index < 55; index++) {
    const doc = { ...f, invoice: f.vouchers[index].gst };
    const input = inputFor(doc); input.originalReported.number = 'Filed/' + index;
    saved.push(save(f, prepare(f, input)).record);
  }
  disposition(f, 'withdraw', saved[0]);
  disposition(f, 'record-filing', saved[1]);
  const options = { registrationId: 'reg', month: '2026-05', mode: 'desk' };
  const first = outwardAmendmentState(f.company, f.vouchers, options);
  assert.equal(first.documents.length, 50); assert.equal(first.documentPage.total, 160);
  assert.equal(first.documents[0].invoiceId, 'actual-159');
  assert.equal(first.documents.some(row => Object.hasOwn(row, 'actual')), false);
  assert.equal(first.selected.invoiceId, 'actual-159'); assert.equal(first.selected.actual.number, 'ACTUAL/159');
  const ids = new Set();
  for (const offset of [0, 50, 100, 150]) {
    const report = outwardAmendmentState(f.company, f.vouchers, { ...options, offset });
    for (const doc of report.documents) ids.add(doc.invoiceId);
  }
  assert.equal(ids.size, 160);
  const historyIds = new Set();
  for (const historyOffset of [0, 20, 40]) {
    const report = outwardAmendmentState(f.company, f.vouchers, { ...options, historyOffset });
    assert.ok(report.records.length <= 20);
    for (const record of report.records) historyIds.add(record.id);
  }
  assert.equal(historyIds.size, 55);
  const pinned = outwardAmendmentState(f.company, f.vouchers, { ...options, invoice: f.vouchers[1].id, q: 'ACTUAL/159' });
  assert.equal(pinned.selected.invoiceId, f.vouchers[1].id); assert.equal(pinned.selected.activeRecordId, saved[1].id);
  assert.equal(pinned.selected.effectiveStatus, 'filed');
  assert.equal(pinned.records.some(record => record.id === saved[1].id), true);
  assert.ok(pinned.records.length <= 21);
  const crossMonth = outwardAmendmentState(f.company, f.vouchers, { ...options, month: '2026-08', q: 'Filed/0' });
  assert.equal(crossMonth.historyPage.total, 1); assert.equal(crossMonth.records[0].effectiveStatus, 'withdrawn');
  assert.equal(crossMonth.documents[0].invoiceId, f.invoice.id);
  const outsidePage = outwardAmendmentState(f.company, f.vouchers, { ...options, invoice: f.invoice.id, offset: 0 });
  assert.equal(outsidePage.selected.invoiceId, f.invoice.id); assert.equal(outsidePage.selected.actual.number, f.invoice.number);
  assert.equal(outsidePage.selected.effectiveStatus, 'withdrawn');
  assert.equal(outsidePage.documents.some(row => row.invoiceId === f.invoice.id), false);
  assert.throws(() => outwardAmendmentState(f.company, f.vouchers, { ...options, invoice: 'unknown' }), /not in this registration/);
  assert.throws(() => outwardAmendmentState(f.company, f.vouchers, { ...options, offset: -1 }), /page offset/);
  assert.equal(assertOutwardAmendments(f.company, f.vouchers), true);
  f.company.gst.outwardAmendments.records[40].delta.cgstPaise += 1;
  assert.throws(() => assertOutwardAmendments(f.company, f.vouchers), /reconciliation trace changed/);
});
