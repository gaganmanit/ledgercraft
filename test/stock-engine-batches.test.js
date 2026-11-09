import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStockBook, stockState } from '../lib/stock-engine.js';
import { changeStock } from '../lib/stock-entry.js';

// Synthetic native stock books: batches, expiry and alternate units on source-native masters.
function books(method = 'fifo', extra = {}) {
  return { id: 'synthetic-batches', booksFrom: '2026-04-01', stock: { version: 1, godowns: [{ id: 'annex', name: 'Annex' }],
    masters: [{ id: 'syrup', name: 'Synthetic syrup', unit: 'nos', openingQuantity: '10', ...extra }],
    items: { syrup: { costingMethod: method, openingValuePaise: 1120, openingAllocations: [
      { godownId: 'main', quantity: '4', valuePaise: 400, batch: 'B1', expiryDate: '2026-12-31' },
      { godownId: 'main', quantity: '6', valuePaise: 720, batch: 'B2', expiryDate: '2027-02-28', manufacturedDate: '2026-02-01' },
    ] } }, journals: [] } };
}
const state = (company, to = '2026-04-30') => stockState(company, [], { to });
const item = report => report.items.find(row => row.itemId === 'syrup');
const issue = (date, number, lines) => ({ id: 'sj-' + number, date, number, type: 'issue', financialKind: 'sale', lines });
const receipt = (date, number, lines) => ({ id: 'sj-' + number, date, number, type: 'receipt', financialKind: 'purchase', lines });

test('a movement naming a batch consumes only that batch; an unnamed movement uses FIFO across batches by date', () => {
  const company = books();
  company.stock.journals.push(receipt('2026-04-02', 'R1', [{ itemId: 'syrup', quantity: '5', valuePaise: 650, godownId: 'main', batch: 'B3', expiryDate: '2027-06-30' }]));
  company.stock.journals.push(issue('2026-04-03', 'I1', [{ itemId: 'syrup', quantity: '3', godownId: 'main', batch: 'B2' }]));
  company.stock.journals.push(issue('2026-04-04', 'I2', [{ itemId: 'syrup', quantity: '5', godownId: 'main' }]));
  const result = item(state(company));
  assert.deepEqual(result.movements.filter(row => row.financialKind === 'sale').map(row => [row.number, row.valuePaise]), [['I1', -360], ['I2', -520]]);
  assert.equal(result.valuePaise, 890);
  assert.deepEqual(result.batches, [
    { name: 'B2', quantity: '2', valuePaise: 240, knownValuePaise: 240, expiry: '2027-02-28', manufactured: '2026-02-01' },
    { name: 'B3', quantity: '5', valuePaise: 650, knownValuePaise: 650, expiry: '2027-06-30' },
  ]);
  assert.equal(assertStockBook(company, []), true);
});

test('a batch shortage is not filled from another batch and a later receipt of the same batch prices it', () => {
  const company = books();
  company.stock.journals.push(issue('2026-04-03', 'I1', [{ itemId: 'syrup', quantity: '6', godownId: 'main', batch: 'B1' }]));
  const short = item(state(company));
  assert.ok(short.issues.some(row => row.code === 'negative-stock'));
  assert.deepEqual(short.batches.map(row => [row.name, row.quantity, row.valuePaise]), [['B1', '-2', null], ['B2', '6', null]]);
  // A receipt of a different batch leaves the B1 shortage open.
  company.stock.journals.push(receipt('2026-04-04', 'R1', [{ itemId: 'syrup', quantity: '2', valuePaise: 260, godownId: 'main', batch: 'B3' }]));
  assert.ok(item(state(company)).issues.some(row => row.code === 'negative-stock'));
  company.stock.journals.push(receipt('2026-04-05', 'R2', [{ itemId: 'syrup', quantity: '2', valuePaise: 220, godownId: 'main', batch: 'B1' }]));
  const settled = item(state(company));
  assert.ok(!settled.issues.length, JSON.stringify(settled.issues));
  assert.ok(settled.notes.some(row => row.code === 'negative-stock-resolved'));
  assert.equal(settled.movements.find(row => row.number === 'I1').valuePaise, -620);
  assert.deepEqual(settled.batches.map(row => [row.name, row.quantity, row.valuePaise]), [['B2', '6', 720], ['B3', '2', 260]]);
});

test('a same-day receipt of the named batch is valued before the issue it supplies', () => {
  const company = books();
  company.stock.journals.push(issue('2026-04-03', 'I1', [{ itemId: 'syrup', quantity: '6', godownId: 'main', batch: 'B1' }]));
  company.stock.journals.push(receipt('2026-04-03', 'R1', [{ itemId: 'syrup', quantity: '2', valuePaise: 220, godownId: 'main', batch: 'B1' }]));
  const result = item(state(company));
  assert.ok(!result.issues.length, JSON.stringify(result.issues));
  assert.equal(result.movements.find(row => row.number === 'I1').valuePaise, -620);
});

test('transfers keep each lot batch and moving average values batch quantities from the pooled cost', () => {
  const company = books();
  company.stock.journals.push({ id: 'sj-T1', date: '2026-04-02', number: 'T1', type: 'transfer', lines: [{ itemId: 'syrup', quantity: '3', fromGodownId: 'main', toGodownId: 'annex', batch: 'B2' }] });
  const moved = item(state(company));
  assert.deepEqual(moved.lots.map(lot => [lot.godownId, lot.batch, lot.quantity, lot.valuePaise]), [['main', 'B1', '4', 400], ['main', 'B2', '3', 360], ['annex', 'B2', '3', 360]]);
  assert.deepEqual(moved.batches.map(row => [row.name, row.quantity, row.valuePaise]), [['B1', '4', 400], ['B2', '6', 720]]);
  const average = books('moving-average');
  average.stock.journals.push(issue('2026-04-03', 'I1', [{ itemId: 'syrup', quantity: '5', godownId: 'main', batch: 'B2' }]));
  const pooled = item(state(average));
  assert.equal(pooled.movements.find(row => row.number === 'I1').valuePaise, -560);
  assert.equal(pooled.valuePaise, 560);
  assert.deepEqual(pooled.batches.map(row => [row.name, row.quantity]), [['B1', '4'], ['B2', '1']]);
});

test('stock lines given in a declared alternate unit convert exactly; an unknown unit is rejected', () => {
  const company = books('fifo', { alternateUnits: [{ name: 'Box', factorNumerator: 25, factorDenominator: 2 }] });
  company.stock.journals.push(receipt('2026-04-02', 'R1', [{ itemId: 'syrup', quantity: '2', unit: 'box', valuePaise: 2500, godownId: 'main', batch: 'B3' }]));
  const result = item(state(company));
  assert.equal(result.quantity, '35');
  assert.deepEqual(result.alternateUnits, [{ name: 'Box', factorNumerator: 25, factorDenominator: 2 }]);
  const inexact = books('fifo', { alternateUnits: [{ name: 'Box', factorNumerator: 1, factorDenominator: 3 }] });
  inexact.stock.journals.push(receipt('2026-04-02', 'R1', [{ itemId: 'syrup', quantity: '1', unit: 'Box', valuePaise: 100, godownId: 'main' }]));
  assert.throws(() => state(inexact), /does not convert exactly/);
  const unknown = books('fifo', { alternateUnits: [{ name: 'Box', factorNumerator: 12, factorDenominator: 1 }] });
  unknown.stock.journals.push(receipt('2026-04-02', 'R1', [{ itemId: 'syrup', quantity: '1', unit: 'crate', valuePaise: 100, godownId: 'main' }]));
  assert.throws(() => state(unknown), /crate is neither the base unit nos nor a declared alternate unit/);
  const invalid = books('fifo', { alternateUnits: [{ name: 'Box', factorNumerator: 0, factorDenominator: 1 }] });
  assert.throws(() => state(invalid), /alternate unit/i);
});

test('opening allocations may repeat a godown for distinct batches but not for the same batch, and dates are validated', () => {
  const duplicate = books();
  duplicate.stock.items.syrup.openingAllocations[1].batch = 'B1';
  duplicate.stock.items.syrup.openingAllocations[1].expiryDate = '2026-12-31';
  assert.throws(() => state(duplicate), /Combine duplicate opening/);
  const badDate = books();
  badDate.stock.items.syrup.openingAllocations[0].expiryDate = '31-12-2026';
  assert.throws(() => state(badDate), /expiry/i);
  const badName = books();
  badName.stock.items.syrup.openingAllocations[0].batch = ' ';
  assert.throws(() => state(badName), /batch/i);
});

test('native stock journals keep the batch, dates and unit fields they are given', () => {
  const company = books();
  const book = { company, vouchers: [] };
  const saved = changeStock(structuredClone(company.stock), book, 'journals', null, { requestId: 'batch-journal-0001', revision: 0, type: 'adjustment', date: '2026-04-02', number: 'ADJ-1',
    lines: [{ itemId: 'syrup', godownId: 'main', direction: 'in', quantity: '1', unit: 'nos', valuePaise: 100, batch: 'B4', expiryDate: '2027-01-31', manufacturedDate: '2026-03-01', reason: 'Found' }] });
  const line = saved.section.journals[0].lines[0];
  assert.deepEqual([line.batch, line.expiryDate, line.manufacturedDate, line.unit], ['B4', '2027-01-31', '2026-03-01', 'nos']);
  const result = item(state({ ...company, stock: saved.section }));
  assert.deepEqual(result.batches.find(row => row.name === 'B4'), { name: 'B4', quantity: '1', valuePaise: 100, knownValuePaise: 100, expiry: '2027-01-31', manufactured: '2026-03-01' });
});

test('saving item settings keeps the opening batch identity and dates', () => {
  const company = books();
  const saved = changeStock(structuredClone(company.stock), { company, vouchers: [] }, 'items', 'syrup', { requestId: 'batch-settings-0001', revision: 0,
    costingMethod: 'moving-average', openingValuePaise: 1120, openingAllocations: company.stock.items.syrup.openingAllocations });
  assert.deepEqual(saved.section.items.syrup.openingAllocations, company.stock.items.syrup.openingAllocations);
  assert.deepEqual(item(state({ ...company, stock: saved.section })).batches.map(row => [row.name, row.quantity, row.valuePaise]), [['B1', '4', 448], ['B2', '6', 672]]);
});
