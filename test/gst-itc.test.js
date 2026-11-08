import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureItcAccounts, buildItcAction, assertItcBook, itcState, itcReturnRows, itcClaimDeadline, itcAccountIds, ITC_COMPONENTS } from '../lib/gst-itc.js';
import { gstVoucher } from '../lib/gst.js';
import { reservedGroups } from '../lib/groups.js';
import { assertVoucher, closeLedger } from '../lib/engine.js';
import { stockState, stockPeriod } from '../lib/stock-engine.js';
import { handleItcRoute } from '../lib/gst-itc-routes.js';

const zero = () => Object.fromEntries(ITC_COMPONENTS.map(key => [key + 'Paise', 0]));
let requests = 0;
const review = (overrides = {}) => ({ invoiceId: 'purchase', date: '2026-04-20', reference: 'PUBLIC-REVIEW', requestId: `public-itc-review-${String(++requests).padStart(8, '0')}`, evidence: { basis: 'Synthetic section 16 and 17 review', documentReference: 'PUBLIC-DOC-1', invoiceHeld: true, received: true, businessUse: true, notBlocked: true, supplierReported: true, supplierTaxPaid: true, returnFurnished: true, paymentReview: true, noTaxDepreciation: true, annualReturnStatus: 'not-filed' }, ...overrides });
function fixture(eligibility = 'pending', options = {}) {
  const accounts = { sales: 'sales', purchase: 'purchase-account', nonCreditTax: 'expense', ...Object.fromEntries(ITC_COMPONENTS.map(key => ['input-' + key, 'input-' + key])) };
  const registration = { id: 'registration', invoicePrefix: 'P1', accounts };
  const company = { id: 'public-itc', name: 'Public ITC test', booksFrom: '2026-04-01', groups: reservedGroups(),
    ledgers: Object.entries(accounts).map(([key, id]) => ({ id, name: key, groupId: key === 'sales' ? 'g-sales' : ['purchase', 'nonCreditTax'].includes(key) ? 'g-purchase' : 'g-current-assets', opening: { dc: 'Dr', paise: 0 } })),
    gst: { registrations: [registration], items: [{ id: 'goods', name: 'Public goods', kind: 'goods', unit: 'NOS', openingQuantity: '0' }] },
    stock: { version: 1, items: { goods: { openingValuePaise: 0 } } } };
  company.ledgers.push({ id: 'supplier', name: 'Supplier', groupId: 'g-creditors', opening: { dc: 'Dr', paise: 0 } });
  const party = { id: 'party', name: 'Public supplier', supplierLedgerId: 'supplier', customerLedgerId: 'supplier' };
  function source(id, sourceOptions = {}) {
    const type = sourceOptions.type || 'Purchase';
    const sourceItems = sourceOptions.items || [{ itemId: 'goods', name: 'Public goods', kind: 'goods', quantity: '1', taxablePaise: 1000, ...zero(), cgstPaise: 90, sgstPaise: 90, taxPaise: 180, totalPaise: 1180, gstRateBps: 1800, cessRateBps: 0 }];
    const totals = { ...zero(), taxablePaise: 0, taxPaise: 0, totalPaise: 0 };
    for (const item of sourceItems) for (const key of Object.keys(totals)) totals[key] += item[key] || 0;
    const invoice = { id, date: sourceOptions.date || '2026-04-10', number: id, supplierInvoiceNumber: id, type, direction: sourceOptions.direction || 'purchase', stockEffect: sourceOptions.stockEffect || 'quantity',
      registrationId: registration.id, registration, partyId: party.id, party, items: sourceItems, totals, itcEligibility: sourceOptions.itcEligibility || eligibility,
      reverseCharge: false, originalInvoiceId: sourceOptions.originalInvoiceId || null, narration: '', ...sourceOptions };
    return gstVoucher(invoice);
  }
  const vouchers = [source('purchase', options)];
  ensureItcAccounts(company, registration.id);
  function act(action, input = review()) {
    const result = buildItcAction(company, vouchers, action, input);
    if (!result.replayed) {
      company.gst.itc.records.push(result.record);
      if (result.voucher) { assertVoucher(company, result.voucher, vouchers, result.voucher.id); vouchers.push(result.voucher); }
      assert.equal(assertItcBook(company, vouchers), true);
    }
    return result;
  }
  return { company, vouchers, source, act, accounts, registration };
}
const tables = rows => rows.map(row => [row.table, row.sign, row.cgstPaise, row.sgstPaise]);

test('pending and marked-eligible purchases are unclaimed until a dated evidenced claim; invoices remain immutable', () => {
  for (const eligibility of ['pending', 'eligible']) {
    const f = fixture(eligibility); const before = JSON.stringify(f.vouchers[0]);
    assert.equal(itcReturnRows(f.company, f.vouchers, '2026-04-01', '2026-04-30').length, 0);
    const result = f.act('claim');
    assert.equal(JSON.stringify(f.vouchers[0]), before);
    assert.deepEqual(tables(result.record.returnRows), [['4A(5)', 1, 90, 90]]);
    assert.equal(result.voucher.lines.reduce((sum, line) => sum + (line.dc === 'Dr' ? line.paise : -line.paise), 0), 0);
    assert.equal(closeLedger(f.company.ledgers.find(ledger => ledger.id === f.accounts['input-cgst']), f.vouchers).paise, 0);
    const reviewed = f.company.gst.itc.accountsByRegistration.registration['claimable-cgst'];
    assert.deepEqual(closeLedger(f.company.ledgers.find(ledger => ledger.id === reviewed), f.vouchers), { dc: 'Dr', paise: 90 });
    assert.throws(() => f.act('claim'), /No unclaimed/);
    assert.equal(itcState(f.company, f.vouchers, '2026-04-19').records.length, 0);
  }
});

test('a 2B match alone cannot establish eligibility and missing explicit conditions block accounting', () => {
  const f = fixture(); const input = review();
  input.evidence = { basis: 'Matched supplier document', documentReference: 'PUBLIC-2B', statement: { id: 'a'.repeat(64), sha256: 'b'.repeat(64), rowKey: 'PUBLIC|INV|1', period: '2026-04', matchStatus: 'Matched', availability: 'Y' } };
  assert.throws(() => f.act('claim', input), /eligibility condition/);
  input.evidence = { ...review().evidence, statement: { ...input.evidence.statement, availability: 'N', reason: '16(4)' } };
  assert.throws(() => f.act('claim', input), /not available/);
  input.evidence.statement.reason = 'P';
  assert.throws(() => f.act('claim', input), /not available/);
  assert.equal(f.company.gst.itc.records.length, 0);
});

test('dated permanent cost resolves stock only on and after review, and records actual expense reclassification', () => {
  const f = fixture();
  assert.equal(stockState(f.company, f.vouchers, { to: '2026-04-19' }).totals.valuePaise, null);
  const result = f.act('permanent', review({ reasonCode: 'section17(5)' }));
  assert.equal(result.record.returnRows.length, 0);
  assert.equal(closeLedger(f.company.ledgers.find(ledger => ledger.id === 'expense'), f.vouchers).paise, 180);
  const before = stockState(f.company, f.vouchers, { to: '2026-04-19' });
  const after = stockState(f.company, f.vouchers, { to: '2026-04-20' });
  assert.equal(before.totals.valuePaise, null); assert.equal(after.totals.valuePaise, 1180);
  assert.equal(after.items[0].movements[0].costReviewedOn, '2026-04-20');
  assert.equal(stockPeriod(f.company, f.vouchers, { from: '2026-04-20', to: '2026-04-20' }).opening.totals.complete, false);
  assert.equal(stockPeriod(f.company, f.vouchers, { from: '2026-04-01', to: '2026-04-30' }).financial.costOfGoodsSoldPaise, 0);
});

test('temporary unclaimed hold has no phantom reversal and remains available for its first claim', () => {
  const f = fixture();
  const evidence = { ...review().evidence, expectedRecoverable: true };
  const hold = f.act('temporary', review({ reasonCode: 'section16(2)(c)', evidence }));
  assert.equal(hold.record.returnRows.length, 0);
  assert.equal(stockState(f.company, f.vouchers, { to: '2026-04-20' }).totals.valuePaise, 1000);
  assert.throws(() => f.act('reclaim', review({ date: '2026-05-01', evidence: { ...review().evidence, conditionsNowMet: true } })), /No unclaimed/);
  const claimed = f.act('claim', review({ date: '2026-05-01' }));
  assert.deepEqual(tables(claimed.record.returnRows), [['4A(5)', 1, 90, 90]]);
});

test('a genuine claim, temporary reversal and reclaim use 4A5, 4B2 and A5+D1 exactly once', () => {
  const f = fixture(); f.act('claim');
  const reversed = f.act('temporary', review({ date: '2026-05-01', reasonCode: 'rule37', evidence: { ...review().evidence, expectedRecoverable: true } }));
  assert.deepEqual(tables(reversed.record.returnRows), [['4B(2)', 1, 90, 90]]);
  const reclaimed = f.act('reclaim', review({ date: '2028-01-01', evidence: { ...review().evidence, conditionsNowMet: true } }));
  assert.deepEqual(tables(reclaimed.record.returnRows), [['4A(5)', 1, 90, 90], ['4D(1)', 1, 90, 90]]);
  assert.throws(() => f.act('reclaim', review({ date: '2028-01-02', evidence: { ...review().evidence, conditionsNowMet: true } })), /No unclaimed/);
  assert.deepEqual(tables(itcReturnRows(f.company, f.vouchers, '2026-05-01', '2026-05-31')), [['4B(2)', 1, 90, 90]]);
});

test('gross auto-populated initial ITC plus reversal needs explicit context and cannot bypass first-claim deadline', () => {
  const f = fixture();
  const input = review({ reportingMode: 'gross-and-reversal', reasonCode: 'section16(2)(b)', evidence: { ...review().evidence, expectedRecoverable: true } });
  assert.throws(() => f.act('temporary', input), /gross Table/);
  input.evidence.grossIncluded = true; input.evidence.grossReference = 'PUBLIC-3B-GROSS';
  const temporary = f.act('temporary', input);
  assert.deepEqual(tables(temporary.record.returnRows), [['4A(5)', 1, 90, 90], ['4B(2)', 1, 90, 90]]);
  assert.throws(() => f.act('reclaim', review({ date: '2028-01-01', evidence: { ...review().evidence, conditionsNowMet: true } })), /outside section 16/);
  assert.deepEqual(tables(f.act('reclaim', review({ date: '2026-05-01', evidence: { ...review().evidence, conditionsNowMet: true } })).record.returnRows), [['4A(5)', 1, 90, 90], ['4D(1)', 1, 90, 90]]);
});

test('permanent reversals affect 4B1 only for real claimed or explicitly gross-reported tax', () => {
  const f = fixture(); f.act('claim');
  assert.deepEqual(tables(f.act('permanent', review({ date: '2026-05-01', reasonCode: 'section17(5)' })).record.returnRows), [['4B(1)', 1, 90, 90]]);
  const g = fixture();
  const result = g.act('permanent', review({ reasonCode: 'section17(5)', reportingMode: 'gross-and-reversal', evidence: { ...review().evidence, grossIncluded: true, grossReference: 'PUBLIC-GROSS' } }));
  assert.deepEqual(tables(result.record.returnRows), [['4A(5)', 1, 90, 90], ['4B(1)', 1, 90, 90]]);
});

test('already expensed ineligible purchases are not expensed twice; section16(4) and PoS detail stays informational', () => {
  for (const reasonCode of ['section16(4)', 'pos-restriction']) {
    const f = fixture('ineligible');
    const originalExpense = closeLedger(f.company.ledgers.find(ledger => ledger.id === 'expense'), f.vouchers).paise;
    const result = f.act('permanent', review({ reasonCode }));
    assert.equal(result.voucher, null);
    assert.equal(closeLedger(f.company.ledgers.find(ledger => ledger.id === 'expense'), f.vouchers).paise, originalExpense);
    assert.deepEqual(tables(result.record.returnRows), [['4D(2)', 1, 90, 90]]);
    assert.throws(() => f.act('permanent', review({ reasonCode })), /No unclaimed/);
  }
});

test('first claim uses the document FY deadline and earlier annual return; debit note has its own clock', () => {
  const f = fixture('pending', { date: '2026-04-10' });
  assert.equal(itcClaimDeadline(f.vouchers[0].gst).ordinary, '2027-11-30');
  assert.throws(() => f.act('claim', review({ date: '2027-12-01' })), /outside section 16/);
  assert.throws(() => f.act('claim', review({ date: '2026-09-01', evidence: { ...review().evidence, annualReturnStatus: 'filed', annualReturnFiledDate: '2026-09-01' } })), /outside section 16/);
  f.vouchers.push(f.source('debit', { date: '2027-04-01', type: 'Debit Note', originalInvoiceId: 'purchase' }));
  assert.equal(itcClaimDeadline(f.vouchers[1].gst).ordinary, '2028-11-30');
  assert.equal(f.act('claim', review({ invoiceId: 'debit', date: '2028-11-30' })).record.action, 'claim');
});

test('a documented historical claim baseline does not report that claim again', () => {
  const f = fixture('eligible');
  const result = f.act('prior-claim', review({ date: '2026-06-01', evidence: { ...review().evidence, priorClaimDate: '2026-04-20', priorReturnReference: 'PUBLIC-FILED-APRIL', priorClaimVerified: true } }));
  assert.equal(result.record.returnRows.length, 0);
  assert.equal(itcReturnRows(f.company, f.vouchers, '2026-04-01', '2026-06-30').length, 0);
  assert.throws(() => f.act('claim', review({ date: '2026-06-02' })), /No unclaimed/);
});

test('credit note reduces actual reviewed account and previously availed A5 only once', () => {
  const f = fixture(); f.act('claim');
  f.vouchers.push(f.source('credit', { date: '2026-05-01', type: 'Credit Note', originalInvoiceId: 'purchase', itcEligibility: 'pending' }));
  const result = f.act('credit-note', review({ invoiceId: 'credit', date: '2026-05-02' }));
  assert.deepEqual(tables(result.record.returnRows), [['4A(5)', -1, 90, 90]]);
  const claimed = f.company.gst.itc.accountsByRegistration.registration['claimable-cgst'];
  assert.equal(closeLedger(f.company.ledgers.find(ledger => ledger.id === claimed), f.vouchers).paise, 0);
  assert.equal(closeLedger(f.company.ledgers.find(ledger => ledger.id === 'input-cgst'), f.vouchers).paise, 0);
  assert.throws(() => f.act('credit-note', review({ invoiceId: 'credit', date: '2026-05-03' })), /already been reviewed/);
});

test('never-availed and already-reversed credit-note tax is not reversed a second time', () => {
  for (const mode of ['pending', 'ineligible', 'temporary']) {
    const f = fixture(mode === 'ineligible' ? 'ineligible' : 'pending');
    if (mode === 'temporary') {
      f.act('claim');
      f.act('temporary', review({ date: '2026-04-25', reasonCode: 'rule37', evidence: { ...review().evidence, expectedRecoverable: true } }));
    }
    f.vouchers.push(f.source('credit', { date: '2026-05-01', type: 'Credit Note', originalInvoiceId: 'purchase', itcEligibility: mode === 'ineligible' ? 'ineligible' : 'pending' }));
    const result = f.act('credit-note', review({ invoiceId: 'credit', date: '2026-05-02' }));
    assert.equal(result.record.returnRows.length, 0);
    if (mode !== 'temporary') assert.equal(result.voucher, null);
    assert.equal(stockState(f.company, f.vouchers, { to: '2026-05-02' }).totals.valuePaise, 0);
  }
});

test('unreviewed credit notes prevent a later first claim from ignoring the supplier reduction', () => {
  const f = fixture();
  f.vouchers.push(f.source('credit', { date: '2026-04-15', type: 'Credit Note', originalInvoiceId: 'purchase' }));
  assert.throws(() => f.act('claim'), /credit notes before/);
  f.act('credit-note', review({ invoiceId: 'credit' }));
  assert.throws(() => f.act('claim'), /No unclaimed/);
});

test('partial line reviews leave remaining tax pending and reject overclaims or wrong tax heads', () => {
  const f = fixture();
  const selected = [{ lineIndex: 0, fromBucket: 'unreviewed', cgstPaise: 45, sgstPaise: 45 }];
  f.act('claim', review({ lineAllocations: selected }));
  assert.equal(stockState(f.company, f.vouchers, { to: '2026-04-20' }).totals.complete, false);
  assert.throws(() => f.act('claim', review({ lineAllocations: [{ lineIndex: 0, fromBucket: 'unreviewed', igstPaise: 1 }] })), /exceeds/);
  f.act('permanent', review({ date: '2026-04-21', reasonCode: 'section17(5)', lineAllocations: [{ lineIndex: 0, fromBucket: 'unreviewed', cgstPaise: 45, sgstPaise: 45 }] }));
  assert.equal(stockState(f.company, f.vouchers, { to: '2026-04-21' }).totals.valuePaise, 1090);
  assert.equal(itcState(f.company, f.vouchers, '2026-04-21').documents[0].balances.claimable.cgstPaise, 45);
});

test('idempotent saves, account protection metadata and restore validation reject altered evidence or postings', () => {
  const f = fixture(); const input = review(); const result = f.act('claim', input);
  assert.equal(f.act('claim', input).replayed, true);
  assert.throws(() => f.act('claim', { ...input, reference: 'OTHER' }), /different ITC review/);
  assert.equal(itcAccountIds(f.company).size, 10);
  const original = result.record.evidence.basis;
  result.record.evidence.basis = 'Altered after saving';
  assert.throws(() => assertItcBook(f.company, f.vouchers), /differ from their saved calculation/);
  result.record.evidence.basis = original;
  result.voucher.lines = structuredClone(result.voucher.lines);
  result.voucher.lines[0].paise += 1;
  assert.throws(() => assertItcBook(f.company, f.vouchers), /accounting entry/);
});

test('builder is pure, evidence-only records stay persisted, and the route uses the serial store method', async () => {
  const f = fixture(); const before = JSON.stringify(f.company);
  const input = review(); buildItcAction(f.company, f.vouchers, 'claim', input);
  assert.equal(JSON.stringify(f.company), before);
  let sent, invoked;
  const store = { snapshot: async () => ({ company: f.company, vouchers: f.vouchers }), gstItcAction: async (...args) => { invoked = args; return { record: { id: 'public' }, voucher: null }; } };
  const send = (_res, status, body) => { sent = { status, body }; };
  const parts = ['api', 'companies', f.company.id, 'gst', 'itc'];
  assert.equal(await handleItcRoute({ req: { method: 'GET' }, res: {}, url: new URL('http://localhost/?to=2026-04-30'), parts, store, send }), true);
  assert.equal(sent.body.documents.length, 1);
  await handleItcRoute({ req: { method: 'POST' }, res: {}, url: new URL('http://localhost/'), parts: [...parts, 'claim'], store, readBody: async () => input, send });
  assert.deepEqual(invoked, [f.company.id, 'claim', input]); assert.equal(sent.status, 201);
});

test('dated inventory bridge capitalizes the remaining tax after a partial supplier return without repricing returned units', () => {
  for (const method of ['fifo', 'moving-average']) {
    const f = fixture();
    f.company.stock.items.goods.costingMethod = method;
    const half = { ...f.vouchers[0].gst.items[0], quantity: '0.5', taxablePaise: 500, cgstPaise: 45, sgstPaise: 45, taxPaise: 90, totalPaise: 590 };
    f.vouchers.push(f.source('credit-half', { date: '2026-04-15', type: 'Credit Note', originalInvoiceId: 'purchase', items: [half] }));
    f.act('credit-note', review({ invoiceId: 'credit-half', date: '2026-04-16' }));
    f.act('permanent', review({ reasonCode: 'section17(5)' }));
    assert.equal(stockState(f.company, f.vouchers, { to: '2026-04-19' }).totals.valuePaise, null);
    const stock = stockState(f.company, f.vouchers, { to: '2026-04-20' });
    assert.equal(stock.items[0].quantity, '0.5');
    assert.equal(stock.totals.valuePaise, 590);
    assert.equal(stockPeriod(f.company, f.vouchers, { to: '2026-04-20' }).financial.netPurchasesPaise, 590);
    assert.equal(closeLedger(f.company.ledgers.find(ledger => ledger.id === 'expense'), f.vouchers).paise, 90);
  }
});

test('a permanent decision before a partial return carries tax into the returned basis without a second cost adjustment', () => {
  for (const method of ['fifo', 'moving-average']) {
    const f = fixture(); f.company.stock.items.goods.costingMethod = method;
    f.act('permanent', review({ date: '2026-04-12', reasonCode: 'section17(5)' }));
    const half = { ...f.vouchers[0].gst.items[0], quantity: '0.5', taxablePaise: 500, cgstPaise: 45, sgstPaise: 45, taxPaise: 90, totalPaise: 590 };
    f.vouchers.push(f.source('credit-half', { date: '2026-04-15', type: 'Credit Note', originalInvoiceId: 'purchase', items: [half] }));
    f.act('credit-note', review({ invoiceId: 'credit-half', date: '2026-04-16' }));
    const period = stockPeriod(f.company, f.vouchers, { to: '2026-04-30' });
    assert.equal(period.closing.totals.valuePaise, 590);
    assert.equal(period.financial.netPurchasesPaise, 590);
    assert.equal(period.financial.costOfGoodsSoldPaise, 0);
    assert.equal(closeLedger(f.company.ledgers.find(ledger => ledger.id === 'expense'), f.vouchers).paise, 90);
  }
});

test('the dated bridge splits tax between remaining inventory and units already sold, without moving the review date', () => {
  for (const method of ['fifo', 'moving-average']) for (const sold of ['0.5', '1']) {
    const f = fixture(); f.company.stock.items.goods.costingMethod = method;
    const sale = { ...f.vouchers[0].gst.items[0], quantity: sold, taxablePaise: 2000, cgstPaise: 0, sgstPaise: 0, taxPaise: 0, totalPaise: 2000 };
    f.vouchers.push(f.source('sale', { date: '2026-04-15', type: 'Sales', direction: 'sales', items: [sale] }));
    f.act('permanent', review({ reasonCode: 'section17(5)' }));
    const closing = stockState(f.company, f.vouchers, { to: '2026-04-20' });
    assert.equal(closing.totals.valuePaise, sold === '1' ? 0 : 590);
    const bridge = closing.items[0].movements.find(row => row.sourceType === 'itc-review');
    assert.equal(bridge.date, '2026-04-20');
    assert.deepEqual(bridge.costBridge, { taxCostPaise: 180, inventoryCostPaise: sold === '1' ? 0 : 90, realisedCostPaise: sold === '1' ? 180 : 90 });
    assert.equal(stockState(f.company, f.vouchers, { to: '2026-04-19' }).totals.valuePaise, null);
  }
});

test('tax cost follows transferred FIFO lineage after a partial return and reaches the remaining godown', () => {
  const f = fixture();
  f.company.stock.godowns = [{ id: 'annex', name: 'Annex' }];
  f.company.stock.journals = [{ id: 'transfer', date: '2026-04-12', number: 'PUBLIC-ST', type: 'transfer', lines: [{ itemId: 'goods', quantity: '0.5', fromGodownId: 'main', toGodownId: 'annex' }] }];
  const half = { ...f.vouchers[0].gst.items[0], quantity: '0.5', taxablePaise: 500, cgstPaise: 45, sgstPaise: 45, taxPaise: 90, totalPaise: 590 };
  f.vouchers.push(f.source('credit-half', { date: '2026-04-15', type: 'Credit Note', originalInvoiceId: 'purchase', items: [half] }));
  f.act('credit-note', review({ invoiceId: 'credit-half', date: '2026-04-16' }));
  f.act('permanent', review({ reasonCode: 'section17(5)' }));
  const closing = stockState(f.company, f.vouchers, { to: '2026-04-20' });
  assert.equal(closing.totals.valuePaise, 590);
  assert.deepEqual(closing.items[0].godowns.map(row => [row.quantity, row.valuePaise]), [['0', 0], ['0.5', 590]]);
});

test('moving-average cost lineage retains a source contribution after its physical lot has been issued', () => {
  const f = fixture(); f.company.stock.items.goods.costingMethod = 'moving-average';
  const second = { ...f.vouchers[0].gst.items[0], taxablePaise: 2000, ...zero(), taxPaise: 0, totalPaise: 2000 };
  f.vouchers.push(f.source('second-purchase', { date: '2026-04-12', items: [second], itcEligibility: 'eligible' }));
  const sale = { ...second, taxablePaise: 3000, totalPaise: 3000 };
  f.vouchers.push(f.source('sale', { date: '2026-04-15', type: 'Sales', direction: 'sales', items: [sale] }));
  f.act('permanent', review({ reasonCode: 'section17(5)' }));
  const period = stockPeriod(f.company, f.vouchers, { to: '2026-04-20' });
  assert.equal(period.closing.totals.valuePaise, 1590);
  assert.equal(period.financial.costOfGoodsSoldPaise, 1590);
  assert.deepEqual(period.closing.items[0].movements.find(row => row.sourceType === 'itc-review').costBridge, { taxCostPaise: 180, inventoryCostPaise: 90, realisedCostPaise: 90 });
});

test('sales returns after a dated cost review restore their original issued cost including the reviewed tax', () => {
  for (const method of ['fifo', 'moving-average']) {
    const f = fixture(); f.company.stock.items.goods.costingMethod = method;
    const sale = { ...f.vouchers[0].gst.items[0], taxablePaise: 2000, ...zero(), taxPaise: 0, totalPaise: 2000 };
    f.vouchers.push(f.source('sale', { date: '2026-04-15', type: 'Sales', direction: 'sales', items: [sale] }));
    f.act('permanent', review({ reasonCode: 'section17(5)' }));
    const returned = { ...sale, quantity: '0.5', taxablePaise: 1000, totalPaise: 1000 };
    f.vouchers.push(f.source('sales-return', { date: '2026-04-25', type: 'Credit Note', direction: 'sales', originalInvoiceId: 'sale', items: [returned] }));
    assert.equal(stockState(f.company, f.vouchers, { to: '2026-04-25' }).totals.valuePaise, 590);
  }
});

test('long moving-average histories retain exact paise decisions with bounded working lineage denominators', () => {
  const f = fixture();
  f.company.gst.items[0].openingQuantity = '9';
  f.company.stock.items.goods = { openingValuePaise: 9000, costingMethod: 'moving-average' };
  f.company.stock.journals = [];
  for (let index = 0; index < 1500; index++) for (const inward of [false, true]) {
    f.company.stock.journals.push({ id: `${inward ? 'receipt' : 'issue'}-${index}`, number: `J${index}${inward ? 'I' : 'O'}`, date: '2026-04-15', type: inward ? 'receipt' : 'issue', financialKind: inward ? 'purchase' : 'sale', lines: [{ itemId: 'goods', quantity: '1', ...(inward ? { valuePaise: 1000 } : {}) }] });
  }
  f.act('permanent', review({ reasonCode: 'section17(5)' }));
  const closing = stockState(f.company, f.vouchers, { to: '2026-04-20' });
  assert.equal(closing.totals.valuePaise, 10000);
  assert.equal(closing.items[0].quantity, '10');
  assert.deepEqual(closing.items[0].movements.find(row => row.sourceType === 'itc-review').costBridge, { taxCostPaise: 180, inventoryCostPaise: 0, realisedCostPaise: 180 });
});

test('bounded lineage falls back to exact arithmetic at a half-paise boundary after pooled sales and returns', () => {
  const f = fixture();
  f.company.stock.items.goods.costingMethod = 'moving-average';
  const original = f.vouchers[0].gst.items[0];
  original.quantity = '2'; original.taxablePaise = 2000; original.totalPaise = 2180;
  f.vouchers[0].gst.totals.taxablePaise = 2000; f.vouchers[0].gst.totals.totalPaise = 2180;
  f.company.stock.journals = [];
  const sales = [];
  const untaxed = { ...original, quantity: '1', taxablePaise: 1000, ...zero(), taxPaise: 0, totalPaise: 1000 };
  for (let index = 0; index < 250; index++) {
    const id = 'sale-' + index;
    sales.push(id);
    f.vouchers.push(f.source(id, { date: '2026-04-15', type: 'Sales', direction: 'sales', items: [{ ...untaxed }] }));
    // Explicit sequence interleaves source invoices and native replenishment.
    f.vouchers.at(-1).stock = { version: 1, sequence: index * 2 + 1, lines: [] };
    f.company.stock.journals.push({ id: 'receipt-' + index, number: 'R' + index, date: '2026-04-15', sequence: index * 2 + 2, type: 'receipt', financialKind: 'purchase', lines: [{ itemId: 'goods', quantity: '1', valuePaise: 1000 }] });
  }
  for (const id of sales) f.vouchers.push(f.source('return-' + id, { date: '2026-04-17', type: 'Credit Note', direction: 'sales', originalInvoiceId: id, items: [{ ...untaxed }] }));
  f.vouchers.push(f.source('half-pool-sale', { date: '2026-04-18', type: 'Sales', direction: 'sales', items: [{ ...untaxed, quantity: '126', taxablePaise: 126000, totalPaise: 126000 }] }));
  f.act('permanent', review({ reasonCode: 'section17(5)', lineAllocations: [{ lineIndex: 0, fromBucket: 'unreviewed', cgstPaise: 1 }] }));
  f.act('claim', review({ date: '2026-04-21' }));
  const closing = stockState(f.company, f.vouchers, { to: '2026-04-21' });
  assert.equal(closing.items[0].quantity, '126');
  assert.equal(closing.totals.valuePaise, 126001);
});
