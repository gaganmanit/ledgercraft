import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyCreditReview, buildCreditReview, creditReviewStatus, creditReviewContext, assertCreditReviews } from '../lib/gst-credit-review.js';
import { createStore } from '../lib/store.js';
import { gstinCheckDigit } from '../lib/gst.js';
import { companyBackup, importCompany, validateTransfer } from '../lib/transfer.js';
import { handleReturnRoute } from '../lib/gst-return-routes.js';
const fixture = (changes = {}) => {
  const company = { id: 'review-fixture', gst: { registrations: [{ id: 'reg' }] } };
  const original = { id: 'original', type: 'Sales', direction: 'sales', supplyCategory: 'domestic', registrationId: 'reg', registration: { gstin: 'SYNTHETIC-COMPANY' }, partyId: 'customer', party: { gstin: 'SYNTHETIC-REGISTERED' }, number: 'INV/1', date: '2026-04-01', reverseCharge: false, items: [{ supplyStatus: 'taxable' }] };
  const doc = { ...structuredClone(original), id: 'credit', type: 'Credit Note', number: 'CN/1', date: '2026-04-07', originalInvoiceId: 'original', originalNumber: original.number, originalDate: original.date, totals: { taxPaise: 180 }, ...changes };
  return { company, original, doc, vouchers: [{ gst: original }, { gst: doc }] };
};
let count = 0;
const request = overrides => ({ invoiceId: 'credit', declarationDate: '2026-05-10', annualReturnStatus: 'not-filed', recipientBasis: 'reversed', adjustmentGround: 'goods-returned', groundConfirmed: true, reference: 'Synthetic recipient reversal and returned goods evidence', requestId: `credit-review-test-${String(++count).padStart(8, '0')}`, revision: 0, ...overrides });
function save(f, input = request()) { const result = applyCreditReview(f.company, f.vouchers, input); f.company = result.company; return result; }

test('outward tax reduction requires a dated immutable review; append is pure and retries are exact', () => {
  const f = fixture(), before = structuredClone(f.company), input = request();
  assert.equal(creditReviewStatus(f.company, f.doc, f.original).eligible, false);
  const result = applyCreditReview(f.company, f.vouchers, input);
  assert.deepEqual(f.company, before); assert.equal(result.status.eligible, true); assert.equal(result.record.kind, 'proposed-declaration-review');
  f.company = result.company; assert.equal(assertCreditReviews(f.company, f.vouchers), true);
  assert.equal(buildCreditReview(f.company, f.vouchers, input).replayed, true);
  assert.throws(() => buildCreditReview(f.company, f.vouchers, { ...input, reference: 'Changed evidence' }), /save identifier/);
  assert.equal(creditReviewStatus(f.company, { ...f.doc, type: 'Debit Note' }, f.original), null);
});

test('November cutoff, monthly period close and earlier annual furnishing are all enforced', () => {
  const f = fixture(); f.original.date = '2025-04-01'; f.doc.originalDate = f.original.date;
  assert.equal(save(f, request({ declarationDate: '2026-11-30' })).status.eligible, true);
  const late = fixture(); late.original.date = '2025-04-01'; late.doc.originalDate = late.original.date;
  assert.equal(save(late, request({ declarationDate: '2026-12-01' })).status.eligible, false);
  const month = fixture({ date: '2026-11-30', originalDate: '2025-04-01' }); month.original.date = '2025-04-01';
  assert.match(save(month, request({ declarationDate: '2026-11-30' })).status.reason, /monthly return/);
  const annual = fixture(); annual.original.date = '2025-04-01'; annual.doc.originalDate = annual.original.date;
  const result = save(annual, request({ declarationDate: '2026-05-10', annualReturnStatus: 'filed', annualReturnDate: '2026-05-10' }));
  assert.equal(result.status.eligible, false); assert.equal(result.status.annualReturnDate, '2026-05-10');
});

test('correction and explicit evidence withdrawal are append-only and stale revisions do not mutate', () => {
  const f = fixture(), first = save(f), prior = structuredClone(f.company);
  assert.throws(() => save(f, request()), /register changed/); assert.deepEqual(f.company, prior);
  const correction = request({ revision: 1, supersedes: first.record.id, correctionReason: 'Recipient evidence withdrawn pending clarification', recipientBasis: 'unconfirmed' });
  const held = save(f, correction); assert.equal(held.status.eligible, false); assert.equal(f.company.gst.creditReviews.records.length, 2);
  assert.equal(assertCreditReviews(f.company, f.vouchers), true); assert.equal(buildCreditReview(f.company, f.vouchers, correction).replayed, true);
  assert.throws(() => save(f, request({ revision: 2, supersedes: first.record.id, correctionReason: 'Wrong prior review' })), /current review/);
});

test('historical provisos, unregistered incidence and supported discount evidence have separate gates', () => {
  const old = fixture({ date: '2025-08-01', originalDate: '2025-04-01' }); old.original.date = '2025-04-01';
  assert.equal(save(old, request({ declarationDate: '2025-09-10', recipientBasis: 'incidence-not-passed' })).status.eligible, true);
  const transition = fixture({ date: '2025-09-20', originalDate: '2025-04-01' }); transition.original.date = '2025-04-01';
  assert.match(save(transition, request({ declarationDate: '2025-10-10' })).status.reason, /transitional/);
  const historical = fixture({ date: '2021-08-01', originalDate: '2020-04-01' }); historical.original.date = '2020-04-01';
  assert.match(save(historical, request({ declarationDate: '2021-09-10', recipientBasis: 'incidence-not-passed' })).status.reason, /September-return/);
  const unregistered = fixture(); unregistered.original.party.gstin = ''; unregistered.doc.party.gstin = '';
  assert.equal(save(unregistered, request({ recipientBasis: 'incidence-not-passed' })).status.eligible, true);
  const discount = fixture(); assert.equal(save(discount, request({ adjustmentGround: 'post-supply-discount' })).status.eligible, false);
  const supported = fixture(); assert.equal(save(supported, request({ adjustmentGround: 'post-supply-discount', discountAgreementConfirmed: true, discountInvoiceLinked: true })).status.eligible, true);
});

test('cross-register actual annual filing evidence cannot be loosened and later evidence holds prior reviews', () => {
  const f = fixture(); f.original.date = '2025-04-01'; f.doc.originalDate = f.original.date;
  save(f, request());
  f.company.gst.outwardAmendments = { records: [{ id: 'known-filing', registrationId: 'reg', cutoff: { financialYear: '2025-04-01', annualReturnFiledDate: '2026-05-01' } }] };
  const status = creditReviewStatus(creditReviewContext(f.company, f.vouchers), f.doc, f.original);
  assert.equal(status.eligible, false); assert.equal(status.deadline, '2026-05-01');
  assert.throws(() => save(f, request({ revision: 1, supersedes: f.company.gst.creditReviews.records[0].id, correctionReason: 'Attempt to ignore earlier annual filing' })), /earlier annual/i);
  assert.equal(assertCreditReviews(f.company, f.vouchers), true, 'Later annual facts do not rewrite historical evidence');
});

test('restore validator rejects changed evidence, indexes, documents and linked originals', () => {
  const f = fixture(); save(f);
  for (const change of [copy => { copy.company.gst.creditReviews.records[0].reference = 'Tampered'; }, copy => { copy.company.gst.creditReviews.byInvoiceId.credit = 5; }, copy => { copy.doc.date = '2026-04-08'; }, copy => { copy.original.number = 'OTHER'; }]) {
    const copy = structuredClone(f); copy.doc = copy.vouchers[1].gst; copy.original = copy.vouchers[0].gst; change(copy);
    assert.throws(() => assertCreditReviews(copy.company, copy.vouchers));
  }
});

test('store saves serialize retries and corrections, preserve journals, and survive restart and backup restore', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ledgercraft-credit-review-'));
  try {
    const store = createStore(dataDir), second = createStore(dataDir);
    const { company } = await store.create({ name: 'Synthetic credit review books', booksFrom: '2026-04-01' });
    const gstin = pan => { const prefix = `23${pan}1Z`; return prefix + gstinCheckDigit(prefix); };
    const registration = (await store.saveGstMaster(company.id, 'registration', { name: 'Synthetic registrant', legalName: 'Synthetic registrant', gstin: gstin('ABCDE1234F'), stateCode: '23', address: 'Synthetic address', pincode: '462001' })).registration;
    const party = (await store.saveGstMaster(company.id, 'party', { name: 'Synthetic recipient', gstin: gstin('PQRST5678L'), stateCode: '23', address: 'Synthetic recipient address', kind: 'customer' })).party;
    const item = (await store.saveGstMaster(company.id, 'item', { name: 'Synthetic service', kind: 'service', hsnSac: '998599', pricePaise: 10000, gstRateBps: 1800, supplyStatus: 'taxable' })).item;
    const base = { registrationId: registration.id, partyId: party.id, placeOfSupply: '23', pricing: 'exclusive', items: [{ itemId: item.id, quantity: '1', unitPricePaise: 10000 }] };
    const original = (await store.passGstInvoice(company.id, { ...base, type: 'Sales', date: '2026-04-01' })).invoice;
    const note = (await store.passGstInvoice(company.id, { ...base, type: 'Credit Note', direction: 'sales', date: '2026-04-07', originalInvoiceId: original.id })).invoice;
    const before = await store.snapshot(company.id), voucherFile = path.join(dataDir, 'companies', company.id, 'vouchers.json');
    const journalBytes = await readFile(voucherFile, 'utf8'), input = request({ invoiceId: note.id });
    const results = await Promise.all([store.saveCreditReview(company.id, input), second.saveCreditReview(company.id, input)]);
    assert.equal(results.filter(row => row.replayed).length, 1);
    assert.equal(results[0].record.id, results[1].record.id);
    assert.equal(results[0].status.eligible, true);
    const correction = request({ invoiceId: note.id, revision: 1, supersedes: results[0].record.id, correctionReason: 'Synthetic recipient evidence withdrawn', recipientBasis: 'unconfirmed' });
    const competing = await Promise.allSettled([store.saveCreditReview(company.id, correction), second.saveCreditReview(company.id, request({ ...correction, requestId: 'competing-credit-review-0001' }))]);
    assert.equal(competing.filter(row => row.status === 'fulfilled').length, 1);
    assert.match(competing.find(row => row.status === 'rejected').reason.message, /register changed/);
    const after = await createStore(dataDir).snapshot(company.id);
    assert.equal(after.company.gst.creditReviews.revision, 2);
    assert.equal(creditReviewStatus(after.company, note, original).eligible, false);
    assert.equal(await readFile(voucherFile, 'utf8'), journalBytes);
    const withoutReviews = structuredClone(after.company); delete withoutReviews.gst.creditReviews;
    assert.deepEqual(withoutReviews, before.company);
    const backup = companyBackup(after.company, after.vouchers), restored = validateTransfer(backup);
    assert.deepEqual(restored.company.gst.creditReviews, after.company.gst.creditReviews);
    assert.deepEqual(restored.vouchers, before.vouchers);
    const imported = await importCompany(dataDir, backup);
    assert.equal(assertCreditReviews(imported.company, imported.vouchers), true);
    assert.equal((await createStore(dataDir).snapshot(imported.company.id)).company.gst.creditReviews.revision, 2);
    const tampered = structuredClone(backup); tampered.company.gst.creditReviews.records[1].recipientBasis = 'reversed';
    assert.throws(() => validateTransfer(tampered), /credit review/);
    const retry = await second.saveCreditReview(company.id, correction);
    assert.equal(retry.replayed, true); assert.equal(retry.revision, 2);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('the dedicated return route saves review evidence and returns its current status', async () => {
  const f = fixture(), input = request(); let response;
  const handled = await handleReturnRoute({ req: { method: 'POST' }, res: {}, parts: ['api', 'companies', f.company.id, 'gst-returns', 'credit-review'], url: new URL('http://localhost/'), dataDir: '/synthetic',
    store: { snapshot: async () => f, saveCreditReview: async (id, payload) => { assert.equal(id, f.company.id); assert.deepEqual(payload, input); return save(f, payload); } },
    readBody: async () => input, send: (_res, code, body) => { response = { code, body }; } });
  assert.equal(handled, true); assert.equal(response.code, 201); assert.equal(response.body.status.eligible, true);
  assert.equal(response.body.revision, 1);
});

test('replay validates a thousand independent saved reviews and still detects the final altered record', () => {
  const f = fixture(), records = [], vouchers = [], byInvoiceId = {};
  for (let index = 0; index < 1000; index++) {
    const original = { ...f.original, id: `original-${index}`, number: `INV/${index}` };
    const doc = { ...f.doc, id: `credit-${index}`, number: `CN/${index}`, originalInvoiceId: original.id, originalNumber: original.number };
    const { record } = buildCreditReview(f.company, [{ gst: original }, { gst: doc }], request({ invoiceId: doc.id }));
    // Independent records become one ordered import fixture; replay must rebuild
    // every sequence and optimistic revision against the preceding history.
    record.sequence = index + 1; record.request.revision = index;
    records.push(record); vouchers.push({ gst: original }, { gst: doc }); byInvoiceId[doc.id] = index;
  }
  f.company.gst.creditReviews = { version: 1, revision: records.length, records, byInvoiceId, annualReturnDates: {} };
  const started = performance.now();
  assert.equal(assertCreditReviews(f.company, vouchers), true);
  const elapsed = performance.now() - started;
  records.at(-1).reference = 'Changed final evidence';
  assert.throws(() => assertCreditReviews(f.company, vouchers), /evidence/);
  console.log(`Section 34 replay: 1000 reviews / 2000 documents validated in ${elapsed.toFixed(1)} ms`);
});
