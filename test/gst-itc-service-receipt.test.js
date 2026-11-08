import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureItcAccounts, buildItcAction, assertItcBook, itcState, itcStockReviews, ITC_COMPONENTS } from '../lib/gst-itc.js';
import { reservedGroups } from '../lib/groups.js';

const zero = () => Object.fromEntries(ITC_COMPONENTS.map(head => [`${head}Paise`, 0]));
let requests = 0;
const evidence = overrides => ({ basis: 'Synthetic section 16 review', documentReference: 'PUBLIC-SERVICE-ITC-1', invoiceHeld: true, received: true, businessUse: true, notBlocked: true, supplierReported: true, supplierTaxPaid: true, returnFurnished: true, paymentReview: true, noTaxDepreciation: true, annualReturnStatus: 'not-filed', ...overrides });
const request = overrides => ({ invoiceId: 'purchase', date: '2026-04-21', reference: 'Synthetic selected-line credit review', requestId: `synthetic-service-itc-${String(++requests).padStart(8, '0')}`, evidence: evidence(), ...overrides });
const allocation = (lineIndex, cgstPaise, sgstPaise = cgstPaise) => ({ lineIndex, ...zero(), cgstPaise, sgstPaise });
const receipt = overrides => ({ lineIndex: 1, sourceLineId: 'ledger-entry:2', sourceLedgerId: 'service-expense', received: true, date: '2026-04-20', reference: 'PUBLIC-SERVICE-ACCEPTANCE-1', ...overrides });

function fixture(completion = { status: 'pending' }) {
  const company = { id: 'synthetic-service-itc', name: 'Synthetic service ITC', booksFrom: '2026-04-01', groups: reservedGroups(), gst: { registrations: [] }, ledgers: [] };
  const accounts = { purchase: 'goods-purchase', nonCreditTax: 'noncredit', ...Object.fromEntries(ITC_COMPONENTS.map(head => [`input-${head}`, `input-${head}`])) };
  const registration = { id: 'registration', invoicePrefix: 'SVC', accounts }; company.gst.registrations.push(registration);
  for (const id of Object.values(accounts)) company.ledgers.push({ id, name: id, groupId: ['goods-purchase', 'noncredit'].includes(id) ? 'g-purchase' : 'g-current-assets', opening: { dc: 'Dr', paise: 0 } });
  company.ledgers.push({ id: 'service-expense', name: 'Professional Fees', groupId: 'g-indirect-exp', opening: { dc: 'Dr', paise: 0 } }, { id: 'supplier', name: 'Synthetic Supplier', groupId: 'g-creditors', opening: { dc: 'Dr', paise: 0 } });
  const line = (itemId, kind, taxablePaise, tax) => ({ itemId, kind, name: itemId, quantity: '1', unit: kind === 'service' ? 'OTH' : 'NOS', taxablePaise, ...zero(), cgstPaise: tax, sgstPaise: tax, taxPaise: tax * 2, totalPaise: taxablePaise + tax * 2, gstRateBps: 1800, cessRateBps: 0, supplyStatus: 'taxable' });
  const invoice = { id: 'purchase', type: 'Purchase', direction: 'purchase', date: '2026-04-08', supplierInvoiceDate: '2026-04-06', supplierInvoiceNumber: 'SUP-SVC-1', number: 'PV-1', receivedDate: '2026-04-07', purchaseIdentityVersion: 2,
    registrationId: registration.id, registration, partyId: 'supplier', party: { name: 'Synthetic Supplier' }, itcEligibility: 'pending', stockEffect: 'quantity', reverseCharge: false,
    items: [line('goods', 'goods', 1000, 90), line('service', 'service', 500, 45)], totals: { taxablePaise: 1500, ...zero(), cgstPaise: 135, sgstPaise: 135, taxPaise: 270, totalPaise: 1770 },
    tallyOrigin: { version: 4, accounts: Object.fromEntries(ITC_COMPONENTS.map(head => [head, accounts[`input-${head}`]])), serviceItems: [{ invoiceLineIndex: 1, itemId: 'service', sourceLineId: 'ledger-entry:2', sourceLedgerId: 'service-expense', completionReview: completion }], source: { items: [{ sourceName: 'goods' }, { sourceLineId: 'ledger-entry:2', sourceLedgerName: 'Professional Fees', kind: 'service' }] } } };
  const vouchers = [{ id: invoice.id, type: invoice.type, number: invoice.number, date: invoice.date, narration: '', lines: [{ ledgerId: 'goods-purchase', dc: 'Dr', paise: 1000 }, { ledgerId: 'service-expense', dc: 'Dr', paise: 500 }, { ledgerId: 'input-cgst', dc: 'Dr', paise: 135 }, { ledgerId: 'input-sgst', dc: 'Dr', paise: 135 }, { ledgerId: 'supplier', dc: 'Cr', paise: 1770 }], gst: invoice }];
  ensureItcAccounts(company, registration.id);
  const act = (action, input) => {
    const result = buildItcAction(company, vouchers, action, input);
    if (!result.replayed) { company.gst.itc.records.push(result.record); if (result.voucher) vouchers.push(result.voucher); }
    assert.equal(assertItcBook(company, vouchers), true);
    return result;
  };
  return { company, vouchers, invoice, act };
}

test('goods can be claimed independently while an accrued service remains unreceived', () => {
  const f = fixture({ status: 'confirmed', date: '2026-04-20', reference: 'PUBLIC-FUTURE-COMPLETION' });
  const before = structuredClone(f.vouchers[0]);
  const goods = f.act('claim', request({ date: '2026-04-10', lineAllocations: [allocation(0, 90)] }));
  assert.equal(goods.record.components.cgstPaise, 90); assert.equal(goods.record.evidence.serviceReceipts, undefined);
  assert.deepEqual(f.vouchers[0], before);
  const service = itcState(f.company, f.vouchers, '2026-04-10').documents[0].lines[1];
  assert.equal(service.balances.unreviewed.cgstPaise, 45); assert.equal(service.serviceReceipt.date, '2026-04-20');
  assert.throws(() => f.act('claim', request({ date: '2026-04-19', lineAllocations: [allocation(1, 45)] })), /cannot precede.*receipt/);
  const included = f.act('claim', request({ date: '2026-04-20', lineAllocations: [allocation(1, 45)] }));
  assert.equal(included.record.evidence.serviceReceipts[0].reference, 'PUBLIC-FUTURE-COMPLETION');
});

test('a pending service needs explicit dated acceptance tied to the selected source line and ledger', () => {
  for (const bad of [undefined, [receipt({ received: false })], [receipt({ sourceLineId: 'ledger-entry:99' })], [receipt({ sourceLedgerId: 'goods-purchase' })], [receipt({ date: '2026-04-22' })], [receipt({ reference: '' })], [receipt(), receipt()]]) {
    const f = fixture(), before = structuredClone({ company: f.company, vouchers: f.vouchers });
    assert.throws(() => f.act('claim', request({ lineAllocations: [allocation(1, 45)], evidence: evidence(bad === undefined ? {} : { serviceReceipts: bad }) })), /service|receipt|selected/i);
    assert.deepEqual({ company: f.company, vouchers: f.vouchers }, before);
  }
  const f = fixture(), input = request({ lineAllocations: [allocation(1, 45)], evidence: evidence({ serviceReceipts: [receipt()] }) });
  const saved = f.act('claim', input);
  assert.deepEqual(saved.record.evidence.serviceReceipts, [receipt()]);
  assert.equal(f.act('claim', input).replayed, true);
  const reported = itcState(f.company, f.vouchers, input.date).documents[0].lines[1].serviceReceipt;
  assert.equal(reported.status, 'confirmed'); assert.equal(reported.basis, 'itc-review'); assert.equal(reported.ledgerName, 'Professional Fees');
});

test('a later partial claim or reclaim reuses its saved service receipt without changing that evidence', () => {
  const f = fixture();
  const first = f.act('claim', request({ lineAllocations: [allocation(1, 20)], evidence: evidence({ serviceReceipts: [receipt()] }) }));
  assert.throws(() => f.act('claim', request({ date: '2026-04-22', lineAllocations: [allocation(1, 25)], evidence: evidence({ serviceReceipts: [receipt({ date: '2026-04-19' })] }) })), /Preserve.*receipt/);
  const second = f.act('claim', request({ date: '2026-04-22', lineAllocations: [allocation(1, 25)] }));
  assert.deepEqual(second.record.evidence.serviceReceipts, first.record.evidence.serviceReceipts);
  f.act('temporary', request({ date: '2026-04-23', reasonCode: 'rule37', lineAllocations: [allocation(1, 45)], evidence: evidence({ expectedRecoverable: true }) }));
  const reclaimed = f.act('reclaim', request({ date: '2026-04-24', lineAllocations: [allocation(1, 45)], evidence: evidence({ conditionsNowMet: true }) }));
  assert.deepEqual(reclaimed.record.evidence.serviceReceipts, first.record.evidence.serviceReceipts);
  const copy = JSON.parse(JSON.stringify({ company: f.company, vouchers: f.vouchers }));
  assert.equal(assertItcBook(copy.company, copy.vouchers), true);
  copy.company.gst.itc.records[1].evidence.serviceReceipts[0].reference = 'Tampered receipt';
  assert.throws(() => assertItcBook(copy.company, copy.vouchers), /facts|evidence|differ/);
});

test('historical claim evidence cannot backdate credit before confirmed or previously established service receipt', () => {
  const f = fixture({ status: 'confirmed', date: '2026-04-20', reference: 'PUBLIC-CONFIRMED-RECEIPT' });
  const prior = priorClaimDate => request({ date: '2026-04-30', lineAllocations: [allocation(1, 45)], evidence: evidence({ priorClaimDate, priorClaimVerified: true, priorReturnReference: 'PUBLIC-FILED-RETURN' }) });
  assert.throws(() => f.act('prior-claim', prior('2026-04-19')), /cannot precede.*receipt/);
  assert.equal(f.act('prior-claim', prior('2026-04-20')).record.returnRows.length, 0);
  const pending = fixture(); pending.act('claim', request({ lineAllocations: [allocation(1, 20)], evidence: evidence({ serviceReceipts: [receipt()] }) }));
  assert.throws(() => pending.act('prior-claim', request({ date: '2026-04-30', lineAllocations: [allocation(1, 25)], evidence: evidence({ priorClaimDate: '2026-04-19', priorClaimVerified: true, priorReturnReference: 'PUBLIC-FILED-RETURN' }) })), /cannot precede.*receipt/);
  assert.throws(() => pending.act('claim', request({ date: '2026-04-19', lineAllocations: [allocation(1, 10)], evidence: evidence({ serviceReceipts: [receipt({ date: '2026-04-18' })] }) })), /Preserve.*receipt/);
});

test('gross reporting cannot bypass service receipt and ordinary cost review keeps service expense outside goods cost', () => {
  const f = fixture();
  const gross = request({ date: '2026-04-19', reasonCode: 'rule37', reportingMode: 'gross-and-reversal', lineAllocations: [allocation(1, 45)], evidence: evidence({ expectedRecoverable: true, grossIncluded: true, grossReference: 'PUBLIC-GROSS-RETURN' }) });
  assert.throws(() => f.act('temporary', gross), /dated receipt/);
  const cost = f.act('permanent', request({ date: '2026-04-19', reasonCode: 'section17(5)', lineAllocations: [allocation(0, 90), allocation(1, 45)] }));
  assert.deepEqual(cost.voucher.lines.filter(row => row.dc === 'Dr').map(row => [row.ledgerId, row.paise]).sort(), [['noncredit', 180], ['service-expense', 90]]);
  assert.equal(itcStockReviews(f.company, f.vouchers).length, 1);
  assert.equal(itcStockReviews(f.company, f.vouchers)[0].itemId, 'goods');
});

test('receipt evidence for an unselected service cannot be smuggled through a goods-only or cost decision', () => {
  for (const action of ['claim', 'permanent']) {
    const f = fixture();
    assert.throws(() => f.act(action, request({ lineAllocations: [allocation(0, 90)], ...(action === 'permanent' ? { reasonCode: 'section17(5)' } : {}), evidence: evidence({ serviceReceipts: [receipt()] }) })), /selected service line/);
  }
});
