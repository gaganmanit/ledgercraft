import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStockBook, stockOpening, stockPeriod, stockState } from '../lib/stock-engine.js';

function books(method = 'fifo', openingQuantity = '0', openingValuePaise = 0) {
  return { id: 'synthetic-stock', booksFrom: '2026-04-01', gst: { items: [
    { id: 'goods', name: 'Public synthetic goods', unit: 'NOS', kind: 'goods', openingQuantity },
    { id: 'service', name: 'Public synthetic service', unit: 'OTH', kind: 'service', openingQuantity: '100' },
  ] }, stock: { version: 1, godowns: [{ id: 'annex', name: 'Annex' }], items: { goods: { costingMethod: method, openingValuePaise } }, journals: [] } };
}
function gst(id, date, direction, qty, value, options = {}) {
  const { type = direction === 'purchase' ? 'Purchase' : 'Sales', stockEffect = 'quantity', originalInvoiceId = null, taxPaise = 0, itcEligibility = 'eligible', metadata, ...extra } = options;
  return { id, date, number: id, gst: { id, date, number: id, type, direction, stockEffect, originalInvoiceId, itcEligibility,
    items: [{ itemId: 'goods', kind: 'goods', quantity: qty, taxablePaise: value, taxPaise }], ...extra }, ...(metadata ? { stock: { version: 1, ...metadata } } : {}) };
}
const state = (company, vouchers, to = '2026-04-30') => stockState(company, vouchers, { to });
const item = report => report.items.find(item => item.itemId === 'goods');
function journal(company, entry) { company.stock.journals.push(entry); }

test('explicit opening values appear before first-day movements, without pricing services or using current rates', () => {
  const company = books('fifo', '10', 1000);
  company.gst.items[0].purchasePricePaise = 999999;
  const vouchers = [gst('sale', '2026-04-01', 'sales', '2', 9000)];
  const period = stockPeriod(company, vouchers, { from: '2026-04-01', to: '2026-04-01' });
  assert.equal(period.opening.items.length, 1);
  assert.equal(item(period.opening).quantity, '10');
  assert.equal(period.financial.openingValuePaise, 1000);
  assert.equal(period.financial.closingValuePaise, 800);
  assert.equal(period.financial.costOfGoodsSoldPaise, 200);
  assert.equal(state(company, vouchers, '2026-03-31').totals.valuePaise, 0);
});

test('perpetual FIFO and moving weighted average produce different independently calculated costs', () => {
  const vouchers = [gst('buy', '2026-04-02', 'purchase', '10', 2000), gst('sell', '2026-04-03', 'sales', '12', 99999)];
  for (const [method, closing, cogs] of [['fifo', 1600, 1400], ['moving-average', 1200, 1800]]) {
    const company = books(method, '10', 1000);
    const period = stockPeriod(company, vouchers, { from: '2026-04-01', to: '2026-04-30' });
    assert.equal(item(period.closing).quantity, '8');
    assert.equal(period.financial.closingValuePaise, closing);
    assert.equal(period.financial.netPurchasesPaise, 2000);
    assert.equal(period.financial.costOfGoodsSoldPaise, cogs);
    assert.equal(period.financial.complete, true);
  }
});

test('unpriced openings and pending-tax purchases expose incomplete values rather than fabricated zero cost', () => {
  const company = books('fifo', '5', null);
  const result = state(company, []);
  assert.equal(item(result).quantity, '5');
  assert.equal(result.totals.valuePaise, null);
  assert.equal(result.issues[0].code, 'unpriced-opening');
  assert.equal(assertStockBook(company, []), true);
  const pending = state(books(), [gst('pending', '2026-04-02', 'purchase', '1', 1000, { taxPaise: 180, itcEligibility: 'pending' })]);
  assert.equal(pending.totals.valuePaise, null);
  assert.equal(pending.issues[0].code, 'pending-tax-cost');
  assert.equal(state(books(), [gst('blocked', '2026-04-02', 'purchase', '1', 1000, { taxPaise: 180, itcEligibility: 'ineligible' })]).totals.valuePaise, 1180);
});

test('dated negative stock remains a cost gap even when a later receipt fills the quantity shortage', () => {
  const company = books();
  const vouchers = [gst('sale', '2026-04-02', 'sales', '2', 9000), gst('buy', '2026-04-03', 'purchase', '3', 600)];
  const before = item(state(company, vouchers, '2026-04-02'));
  assert.equal(before.quantity, '-2'); assert.equal(before.valuePaise, null);
  const after = item(state(company, vouchers));
  assert.equal(after.quantity, '1'); assert.equal(after.knownValuePaise, 200);
  assert.equal(after.valuePaise, null);
  assert.equal(after.issues[0].code, 'negative-stock');
});

test('six-decimal quantities and paise remainder conservation survive repeated partial FIFO issues', () => {
  const company = books('fifo', '0.000003', 2);
  const vouchers = [gst('a', '2026-04-02', 'sales', '0.000001', 900), gst('b', '2026-04-03', 'sales', '0.000001', 900), gst('c', '2026-04-04', 'sales', '0.000001', 900)];
  const result = item(state(company, vouchers));
  assert.equal(result.quantity, '0'); assert.equal(result.valuePaise, 0);
  assert.deepEqual(result.movements.slice(1).map(row => row.valuePaise), [-1, -1, 0]);
  assert.equal(stockPeriod(company, vouchers, { to: '2026-04-30' }).financial.costOfGoodsSoldPaise, 2);
});

test('FIFO remains perpetual across financial years and later-period opening uses all earlier activity', () => {
  const company = books('fifo', '10', 1000);
  const vouchers = [gst('old', '2026-05-01', 'purchase', '10', 2000), gst('next', '2027-04-01', 'sales', '12', 9000)];
  const result = stockPeriod(company, vouchers, { from: '2027-04-01', to: '2027-04-30' });
  assert.equal(result.financial.openingValuePaise, 3000);
  assert.equal(result.financial.closingValuePaise, 1600);
  assert.equal(result.financial.costOfGoodsSoldPaise, 1400);
  assert.equal(result.financial.netPurchasesPaise, 0);
});

test('linked sales returns restore original issued cost even after a later purchase changes the average', () => {
  for (const method of ['fifo', 'moving-average']) {
    const company = books(method, '2', 200);
    const vouchers = [gst('sale', '2026-04-02', 'sales', '2', 9000), gst('new-buy', '2026-04-03', 'purchase', '2', 1000),
      gst('return', '2026-04-04', 'sales', '1', 4500, { type: 'Credit Note', originalInvoiceId: 'sale' })];
    const result = item(state(company, vouchers));
    assert.equal(result.quantity, '3'); assert.equal(result.valuePaise, 1100);
    const returned = result.movements.at(-1);
    assert.equal(returned.valuePaise, 100);
    assert.equal(returned.originalSourceId, 'sale');
    assert.equal(returned.lineage[0].sourceId, 'sale');
  }
});

test('linked purchase return removes original purchase basis rather than the selling or current average price', () => {
  const vouchers = [gst('buy', '2026-04-02', 'purchase', '2', 400), gst('return', '2026-04-03', 'purchase', '1', 200, { type: 'Credit Note', originalInvoiceId: 'buy' })];
  for (const method of ['fifo', 'moving-average']) {
    const company = books(method, '2', 200);
    const result = stockPeriod(company, vouchers, { to: '2026-04-30' });
    assert.equal(item(result.closing).quantity, '3'); assert.equal(result.financial.closingValuePaise, 400);
    assert.equal(result.financial.netPurchasesPaise, 200);
    assert.equal(result.financial.costOfGoodsSoldPaise, 0);
    assert.equal(item(result.closing).movements.at(-1).valuePaise, -200);
  }
});

test('unlinked returns, excessive return quantities, and price-only purchase notes remain explicit cost gaps', () => {
  const unlinked = state(books(), [gst('return', '2026-04-02', 'sales', '1', 900, { type: 'Credit Note' })]);
  assert.equal(unlinked.totals.valuePaise, null);
  assert.equal(unlinked.issues[0].code, 'unlinked-return-cost');
  const tooMany = state(books('fifo', '1', 100), [gst('sale', '2026-04-02', 'sales', '1', 900), gst('return', '2026-04-03', 'sales', '2', 1800, { type: 'Credit Note', originalInvoiceId: 'sale' })]);
  assert.equal(tooMany.totals.complete, false);
  const notes = state(books('fifo', '2', 200), [gst('note', '2026-04-03', 'purchase', '1', 100, { type: 'Credit Note', stockEffect: 'none' })]);
  assert.equal(item(notes).quantity, '2'); assert.equal(notes.issues[0].code, 'financial-note-cost-allocation');
});

test('explicit return cost requires a recorded basis and can value an external original sale', () => {
  const metadata = { lines: [{ lineIndex: 0, costValuePaise: 123, costBasisReason: 'Synthetic original cost record' }] };
  const voucher = gst('external-return', '2026-04-03', 'sales', '1', 900, { type: 'Credit Note', metadata });
  assert.equal(state(books(), [voucher]).totals.valuePaise, 123);
  delete voucher.stock.lines[0].costBasisReason;
  assert.throws(() => state(books(), [voucher]), /cost basis reason/);
});

test('debit-note quantities follow their direction and financial-only sales notes do not move stock', () => {
  const company = books('fifo', '5', 500);
  const vouchers = [gst('buy-note', '2026-04-02', 'purchase', '2', 400, { type: 'Debit Note' }), gst('sell-note', '2026-04-03', 'sales', '1', 900, { type: 'Debit Note' }), gst('financial', '2026-04-04', 'sales', '1', 900, { type: 'Credit Note', stockEffect: 'none' })];
  const result = item(state(company, vouchers));
  assert.equal(result.quantity, '6'); assert.equal(result.valuePaise, 800);
  assert.equal(result.movements.length, 3);
});

test('explicit godown openings and split invoice allocations conserve cost and expose source lineage', () => {
  const company = books('fifo', '3', 301);
  company.stock.items.goods.openingAllocations = [{ godownId: 'main', quantity: '1' }, { godownId: 'annex', quantity: '2' }];
  const vouchers = [gst('sale', '2026-04-02', 'sales', '1.5', 9900, { metadata: { lines: [{ lineIndex: 0, allocations: [{ godownId: 'main', quantity: '0.5' }, { godownId: 'annex', quantity: '1' }] }] } })];
  const result = item(state(company, vouchers));
  assert.equal(result.quantity, '1.5'); assert.equal(result.valuePaise, 150);
  assert.deepEqual(result.godowns.map(row => row.quantity), ['0.5', '1']);
  assert.equal(result.movements.at(-1).lineage[0].sourceId, 'opening:goods');
  assert.equal(result.movements.at(-1).runningValuePaise, 100);
});

test('transfers carry source cost and do not create purchases, sales, or inventory value', () => {
  for (const method of ['fifo', 'moving-average']) {
    const company = books(method, '10', 1000);
    journal(company, { id: 'transfer', number: 'ST-1', date: '2026-04-02', type: 'transfer', lines: [{ itemId: 'goods', quantity: '3', fromGodownId: 'main', toGodownId: 'annex' }] });
    const report = stockPeriod(company, [], { to: '2026-04-30' });
    assert.equal(report.financial.closingValuePaise, 1000);
    assert.equal(report.financial.netPurchasesPaise, 0); assert.equal(report.financial.costOfGoodsSoldPaise, 0);
    assert.deepEqual(item(report.closing).godowns.map(row => [row.quantity, row.valuePaise]), [['7', 700], ['3', 300]]);
    assert.equal(item(report.closing).movements.at(-1).lineage[0].sourceId, 'opening:goods');
  }
});

test('item-wide moving average reweights godowns after a receipt and transfer still carries that cost', () => {
  const company = books('moving-average', '2', 200);
  const vouchers = [gst('buy', '2026-04-02', 'purchase', '2', 600, { metadata: { lines: [{ lineIndex: 0, allocations: [{ godownId: 'annex', quantity: '2' }] }] } }), gst('sale', '2026-04-04', 'sales', '1', 900)];
  journal(company, { id: 'transfer', number: 'ST', date: '2026-04-03', type: 'transfer', lines: [{ itemId: 'goods', quantity: '1', fromGodownId: 'annex', toGodownId: 'main' }] });
  const result = item(state(company, vouchers));
  assert.equal(result.valuePaise, 600);
  assert.deepEqual(result.godowns.map(row => [row.quantity, row.valuePaise]), [['2', 400], ['1', 200]]);
});

test('physical counts turn into dated gains or losses; gains require their actual added-stock value', () => {
  const company = books('fifo', '10', 1000);
  journal(company, { id: 'count-loss', number: 'PC1', date: '2026-04-02', type: 'physical', lines: [{ itemId: 'goods', godownId: 'main', quantity: '8' }] });
  journal(company, { id: 'count-gain', number: 'PC2', date: '2026-04-03', type: 'physical', lines: [{ itemId: 'goods', godownId: 'main', quantity: '9', valuePaise: 150 }] });
  const report = stockPeriod(company, [], { to: '2026-04-30' });
  assert.equal(item(report.closing).quantity, '9'); assert.equal(report.financial.closingValuePaise, 950);
  assert.equal(report.financial.netAdjustmentsPaise, -50);
  assert.equal(report.financial.costOfGoodsSoldPaise, 0);
  delete company.stock.journals[1].lines[0].valuePaise;
  assert.equal(state(company, []).totals.complete, false);
});

test('source-native Tally-style stock masters and purchase/sale/return journals work without GST fabrication', () => {
  const company = { booksFrom: '2026-04-01', stock: { version: 1, masters: [{ id: 'native', name: 'Public source item', unit: 'KG', openingQuantity: '0' }], items: { native: { costingMethod: 'fifo' } }, journals: [
    { id: 'purchase', number: 'P1', date: '2026-04-01', type: 'receipt', financialKind: 'purchase', sourceRef: 'public-record', lines: [{ itemId: 'native', quantity: '5', valuePaise: 500, godownId: 'main' }] },
    { id: 'sale', number: 'S1', date: '2026-04-02', type: 'issue', financialKind: 'sale', lines: [{ itemId: 'native', quantity: '2', godownId: 'main' }] },
    { id: 'return', number: 'CN1', date: '2026-04-03', type: 'receipt', financialKind: 'sales-return', originalSourceId: 'sale', lines: [{ itemId: 'native', quantity: '1' }] },
  ] } };
  const report = stockPeriod(company, [], { to: '2026-04-30' });
  assert.equal(report.closing.items[0].quantity, '4'); assert.equal(report.financial.closingValuePaise, 400);
  assert.equal(report.financial.costOfGoodsSoldPaise, 100);
  assert.equal(report.closing.items[0].movements[0].sourceRef, 'public-record');
  assert.equal(assertStockBook(company, []), true);
});

test('dated replay ignores future movements, accepts unsorted dates, and honors explicit same-day sequence', () => {
  const company = books();
  const vouchers = [gst('sale', '2026-04-02', 'sales', '1', 900, { metadata: { sequence: 2, lines: [] } }), gst('purchase', '2026-04-02', 'purchase', '2', 200, { metadata: { sequence: 1, lines: [] } }), gst('future', '2026-05-01', 'sales', '1', 900)];
  assert.equal(state(company, vouchers).totals.valuePaise, 100);
  assert.equal(item(state(company, vouchers)).quantity, '1');
  const opening = stockPeriod(company, vouchers, { from: '2026-04-02', to: '2026-04-02' });
  assert.equal(opening.financial.openingValuePaise, 0);
  assert.equal(opening.financial.costOfGoodsSoldPaise, 100);
});

test('old unsequenced sources run before sequenced events, preserving old source order', () => {
  const company = books();
  const vouchers = [gst('z-buy', '2026-04-02', 'purchase', '1', 100), gst('a-sell', '2026-04-02', 'sales', '1', 900)];
  journal(company, { id: 'gain', number: 'G', date: '2026-04-02', sequence: 1, type: 'adjustment', lines: [{ itemId: 'goods', quantity: '1', direction: 'in', valuePaise: 200 }] });
  assert.equal(state(company, vouchers).totals.valuePaise, 200);
});

test('strict metadata validation rejects unknown locations, mismatched quantities and invalid original line indices', () => {
  const company = books('fifo', '1', 100);
  const voucher = gst('s', '2026-04-02', 'sales', '1', 900, { metadata: { lines: [{ lineIndex: 0, allocations: [{ godownId: 'missing', quantity: '1' }] }] } });
  assert.throws(() => state(company, [voucher]), /missing godown/);
  voucher.stock.lines[0].allocations = [{ godownId: 'main', quantity: '0.5' }];
  assert.throws(() => state(company, [voucher]), /must equal/);
  voucher.stock.lines[0].lineIndex = 9;
  assert.throws(() => state(company, [voucher]), /invalid invoice goods line/);
  company.stock.items.goods.openingAllocations = [{ godownId: 'main', quantity: '2', valuePaise: 100 }];
  assert.throws(() => state(company, []), /Opening godown quantities/);
});

test('invalid journals, duplicate identities, valuation methods, unsafe paise and micro quantities are rejected', () => {
  const company = books();
  company.stock.items.goods.costingMethod = 'last-selling-price';
  assert.throws(() => state(company, []), /fifo or moving-average/);
  company.stock.items.goods.costingMethod = 'fifo';
  company.stock.items.goods.openingValuePaise = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => state(company, []), /safe integer paise/);
  company.stock.items.goods.openingValuePaise = 0;
  assert.throws(() => state(company, [gst('bad', '2026-04-02', 'purchase', '0.0000001', 100)]), /six decimal/);
  assert.throws(() => state(company, [gst('same', '2026-04-02', 'purchase', '1', 100), gst('same', '2026-04-03', 'purchase', '1', 100)]), /Duplicate stock source/);
  journal(company, { id: 'bad-transfer', number: 'T', date: '2026-04-02', type: 'transfer', lines: [{ itemId: 'goods', quantity: '1', fromGodownId: 'main', toGodownId: 'annex' }] });
  assert.throws(() => assertStockBook(company, []), /transfer exceeds/);
  delete company.stock.journals[0].lines[0].fromGodownId;
  assert.throws(() => assertStockBook(company, []), /source godown/);
});

test('input books remain unchanged and report aggregates reject unsafe totals', () => {
  const company = books('fifo', '2', 200); const vouchers = [gst('p', '2026-04-02', 'purchase', '1', 100)];
  const before = JSON.stringify({ company, vouchers });
  state(company, vouchers); assert.equal(JSON.stringify({ company, vouchers }), before);
  company.stock.items.goods.openingValuePaise = Number.MAX_SAFE_INTEGER;
  assert.throws(() => state(company, vouchers), /supported paise limit/);
});

test('moving-average issue cost uses the whole item pool even when a godown holds the rounding remainder', () => {
  const company = books('moving-average', '2', 3);
  company.stock.items.goods.openingAllocations = [{ godownId: 'main', quantity: '1' }, { godownId: 'annex', quantity: '1' }];
  const sale = gst('rounding-sale', '2026-04-02', 'sales', '1', 900, { metadata: { lines: [{ lineIndex: 0, allocations: [{ godownId: 'annex', quantity: '1' }] }] } });
  const result = item(state(company, [sale]));
  assert.equal(result.valuePaise, 1);
  assert.equal(result.movements.at(-1).valuePaise, -2);
});

test('a purchase return without original basis never displays the current average as its known return cost', () => {
  const result = item(state(books('moving-average', '2', 200), [gst('unknown-return', '2026-04-02', 'purchase', '1', 100, { type: 'Credit Note' })]));
  assert.equal(result.complete, false);
  assert.equal(result.movements.at(-1).valuePaise, null);
  assert.equal(result.movements.at(-1).lineage[0].valuePaise, null);
});

test('unsupported source inventory cannot report a complete understated closing balance', () => {
  const company = books('fifo', '2', 200);
  company.stock.tally = { hasSourceGaps: true, sourceGaps: [{ code: 'source-batch-omitted', reference: 'public-source-1', message: 'A source batch was not projected.' }] };
  const report = stockPeriod(company, [], { to: '2026-04-30' });
  assert.equal(report.closing.totals.complete, false);
  assert.equal(report.closing.totals.valuePaise, null);
  assert.equal(report.closing.totals.knownValuePaise, 200);
  assert.equal(report.financial.complete, false);
  assert.equal(report.closing.issues[0].code, 'source-batch-omitted');
  company.gst.items = [];
  company.stock.items = {};
  assert.equal(state(company, []).totals.complete, false);
});

test('book opening reads valued master allocations and source gaps without replaying dated journals', () => {
  const company = books('fifo', '2', 200);
  company.stock.journals = [{ id: 'unrelated-invalid-day-entry', type: 'transfer', lines: [] }];
  const original = JSON.stringify(company);
  const opening = stockOpening(company);
  assert.equal(opening.totals.valuePaise, 200);
  assert.equal(opening.items[0].quantity, '2');
  assert.equal(opening.items[0].movements.every(row => row.sourceType === 'opening'), true);
  assert.equal(JSON.stringify(company), original);
  company.stock.tally = { hasSourceGaps: true, sourceGaps: [{ code: 'source-godown', message: 'A source godown was omitted.' }] };
  assert.equal(stockOpening(company).totals.complete, false);
});
