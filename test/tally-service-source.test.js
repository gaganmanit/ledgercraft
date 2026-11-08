import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { previewTally } from '../lib/tally-import.js';
import { tallyGstFactIndex, sourceTaxFacts } from '../lib/tally-gst-facts.js';
import { sourceTallyServiceLines, tallyServiceSourceLookups } from '../lib/tally-service-source.js';
import { children, keyName, value } from '../lib/tally-format.js';

const xml = await readFile(new URL('./fixtures/tally-service-cycle.xml', import.meta.url), 'utf8');
const parse = (transform = text => text) => {
  const result = previewTally([{ name: 'tally-service-cycle.xml', base64: Buffer.from(transform(xml)).toString('base64') }], { companyName: 'Synthetic Services', booksFrom: '2026-04-01' });
  assert.equal(result.canCommit, true, JSON.stringify(result.issues));
  return result;
};
function source(book, number, options = {}) {
  const voucher = book.vouchers.find(row => row.source.originalNumber === number);
  const record = book.records.find(row => row.recordId === voucher.source.recordId);
  const index = tallyGstFactIndex(book.records);
  const result = sourceTallyServiceLines(book.company, voucher, record, index, options);
  return { ...result, voucher, record, index };
}
const node = (tag, text = '', entries = []) => ({ tag, attrs: {}, text, children: entries });
const master = (book, name) => book.records.find(row => row.type === 'LEDGER' && row.node.attrs.NAME === name).node;

test('public synthetic four-flow fixture retains exact service rows and independently balanced accounts', () => {
  const book = parse(), before = structuredClone(book);
  const expected = [
    ['SV-101', ['Consulting Income', 'Support Income'], [100000, 50000], [1, 2], 177000],
    ['PV-201', ['Professional Fees', 'Maintenance Expense'], [60000, 40000], [1, 2], 118000],
    ['MS-102', ['Consulting Income', 'Support Income'], [30000, 20000], [2, 3], 177000],
    ['MP-202', ['Professional Fees'], [20000], [2], 165200],
  ];
  for (const [number, names, amounts, indexes, total] of expected) {
    const result = source(book, number);
    assert.deepEqual(result.items.map(row => row.sourceName), names);
    assert.deepEqual(result.items.map(row => row.valuePaise), amounts);
    assert.deepEqual(result.items.map(row => row.sourcePostingIndexes[0]), indexes);
    assert.deepEqual(result.items.map(row => row.sourceLineId), indexes.map(index => `ledger-entry:${index}`));
    assert.equal(result.candidates.length, 0); assert.equal(result.issues.length, 0);
    assert.equal(result.voucher.lines.reduce((sum, row) => sum + (row.dc === 'Dr' ? row.paise : -row.paise), 0), 0);
    assert.equal(result.voucher.lines[0].paise, total);
    for (const item of result.items) {
      assert.equal(item.kind, 'service'); assert.equal(item.sourceKind, 'ledger');
      assert.equal(item.quantityBasis, 'amount-only'); assert.equal(item.quantity, '1'); assert.equal(item.unit, 'OTH');
      assert.equal(item.actualQuantity, null); assert.equal(item.actualBasis, 'not-applicable'); assert.equal(item.stockEffect, 'none');
      assert.equal(item.classificationStatus, 'supplied'); assert.equal(item.classificationRequired, false);
      assert.equal(item.sourceLedgerId, result.voucher.lines[item.sourcePostingIndexes[0]].ledgerId);
      assert.match(item.amountEvidence.fieldPath, /VOUCHER\/ALLLEDGERENTRIES\[\d+\]\/AMOUNT\[0\]/);
    }
  }
  assert.deepEqual(book, before, 'Extracting service evidence creates no journal or master mutation');
});

test('goods remain first and service SAC, type, tax and supplier document date remain exact source facts', () => {
  const book = parse();
  for (const number of ['SV-101', 'PV-201', 'MS-102', 'MP-202']) {
    const result = source(book, number), date = number === 'PV-201' ? '2026-04-06' : number === 'MP-202' ? '2026-04-09' : result.voucher.date;
    const goods = number.startsWith('M') ? [{ sourceName: 'Widget' }] : [];
    const facts = sourceTaxFacts(result.index, result.record, date, [...goods, ...result.items], '23');
    assert.equal(facts.sellerGstin.status, 'supplied'); assert.equal(facts.buyerGstin.status, 'supplied');
    if (goods.length) { assert.equal(facts.items[0].hsnSac.value, '8541'); assert.equal(facts.items[0].supplyType.value, 'goods'); }
    const services = facts.items.slice(goods.length);
    assert.deepEqual(services.map(row => row.sourceLineId), result.items.map(row => row.sourceLineId));
    for (const item of services) {
      assert.equal(item.hsnSac.status, 'supplied'); assert.match(item.hsnSac.value, /^99\d{4}$/);
      assert.equal(item.gstRateBps.value, 1800); assert.equal(item.supplyType.value, 'service'); assert.equal(item.taxability.value, 'taxable');
      assert.ok(item.gstRateBps.superseded.some(proof => proof.effectiveFrom === '2027-04-01'));
      assert.match(item.gstRateBps.evidence[0].fieldPath, /^LEDGER\/GSTDETAILS\[0\]/);
    }
    if (number.includes('201') || number.includes('202')) {
      assert.match(value(result.record.node, 'REFERENCE'), /^SUP-/);
      assert.equal(value(result.record.node, 'REFERENCEDATE'), date.replaceAll('-', ''));
    }
  }
});

test('effective ledger SAC/rates and per-entry overrides do not borrow future or unrelated values', () => {
  const book = parse(), service = master(book, 'Consulting Income');
  service.children.push(node('HSNDETAILS.LIST', '', [node('APPLICABLEFROM', '20270401'), node('HSNCODE', '998314')]));
  let result = source(book, 'SV-101');
  let facts = sourceTaxFacts(result.index, result.record, '2026-04-05', result.items, '23');
  assert.equal(facts.items[0].hsnSac.value, '998313'); assert.equal(facts.items[0].gstRateBps.value, 1800);
  facts = sourceTaxFacts(result.index, result.record, '2027-04-05', result.items, '23');
  assert.equal(facts.items[0].hsnSac.value, '998314'); assert.equal(facts.items[0].gstRateBps.value, 1200);
  const entry = children(result.record.node, 'ALLLEDGERENTRIES')[1];
  entry.children.push(node('HSNCODE', '998315'));
  result = source(book, 'SV-101'); facts = sourceTaxFacts(result.index, result.record, '2026-04-05', result.items, '23');
  assert.equal(facts.items[0].hsnSac.value, '998315'); assert.equal(facts.items[1].hsnSac.value, '998713');
  assert.match(facts.items[0].hsnSac.evidence[0].fieldPath, /^VOUCHER\/ALLLEDGERENTRIES\[1\]/);
  assert.equal(facts.items[0].hsnSac.evidence[0].effectiveFrom, '2026-04-05');
});

test('generic posting ledgers require explicit per-row classification and never silently become services', () => {
  const book = parse(), ledger = master(book, 'Consulting Income');
  ledger.children = ledger.children.filter(row => !/GST|HSN/.test(keyName(row.tag)));
  const result = source(book, 'SV-101');
  assert.deepEqual(result.items.map(row => row.sourceName), ['Support Income']);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].classificationStatus, 'absent'); assert.equal(result.candidates[0].classificationRequired, true);
  const confirmed = source(book, 'SV-101', { reviewedSourceLineIds: [result.candidates[0].sourceLineId] });
  assert.equal(confirmed.items[0].serviceClassification, 'reviewed');
  assert.throws(() => source(book, 'SV-101', { reviewedSourceLineIds: ['ledger-entry:999'] }), /missing or unsupported/);
  // A bad classification is not the absence of source evidence.
  ledger.children.push(node('GSTTYPEOFSUPPLY', 'Unresolved custom supply'));
  const conflict = source(book, 'SV-101').candidates[0];
  assert.equal(conflict.classificationStatus, 'conflict'); assert.ok(conflict.issues.length);
});

test('conflicting, undated or goods-classified tax details remain review facts rather than service suggestions', () => {
  const book = parse(), ledger = master(book, 'Consulting Income');
  const first = children(ledger, 'GSTDETAILS')[0]; first.children = first.children.filter(row => keyName(row.tag) !== 'APPLICABLEFROM');
  let result = source(book, 'SV-101'), facts = sourceTaxFacts(result.index, result.record, result.voucher.date, result.items, '23');
  assert.equal(facts.items[0].gstRateBps.status, 'conflict'); assert.match(facts.items[0].gstRateBps.issues.join(' '), /Undated/);
  ledger.children.push(node('GSTTYPEOFSUPPLY', 'Goods'));
  result = source(book, 'SV-101'); assert.equal(result.candidates[0].classificationStatus, 'conflict');
  const wrong = parse(); master(wrong, 'Consulting Income').children = [node('PARENT', 'Sales Accounts'), node('GSTTYPEOFSUPPLY', 'Goods')];
  assert.throws(() => source(wrong, 'SV-101', { reviewedSourceLineIds: ['ledger-entry:1'] }), /goods-classified/);
});

test('repeated service ledgers retain distinct rows and zero postings do not shift source posting identities', () => {
  const book = parse(), base = source(book, 'SV-101');
  const entries = children(base.record.node, 'ALLLEDGERENTRIES');
  entries[2].children.find(row => keyName(row.tag) === 'LEDGERNAME').text = 'Consulting Income';
  base.voucher.lines[2].ledgerId = base.voucher.lines[1].ledgerId;
  const zero = node('ALLLEDGERENTRIES.LIST', '', [node('LEDGERNAME', 'Support Income'), node('AMOUNT', '0.00')]);
  base.record.node.children.splice(base.record.node.children.indexOf(entries[1]), 0, zero);
  const result = source(book, 'SV-101');
  assert.deepEqual(result.items.map(row => row.sourceName), ['Consulting Income', 'Consulting Income']);
  assert.deepEqual(result.items.map(row => row.sourceLineId), ['ledger-entry:2', 'ledger-entry:3']);
  assert.deepEqual(result.items.map(row => row.sourcePostingIndexes), [[1], [2]]);
  assert.deepEqual(result.items.map(row => row.valuePaise), [100000, 50000]);
});

test('mixed goods allocation is distinct even when its ledger also has a separate service posting', () => {
  const book = parse(), base = source(book, 'MS-102'), entries = children(base.record.node, 'ALLLEDGERENTRIES');
  const allocation = children(children(base.record.node, 'ALLINVENTORYENTRIES')[0], 'ACCOUNTINGALLOCATIONS')[0];
  allocation.children.find(row => keyName(row.tag) === 'LEDGERNAME').text = 'Consulting Income';
  entries[1].children.find(row => keyName(row.tag) === 'LEDGERNAME').text = 'Consulting Income';
  base.voucher.lines[1].ledgerId = base.voucher.lines[2].ledgerId;
  const result = source(book, 'MS-102');
  assert.deepEqual(result.items.map(row => row.valuePaise), [30000, 20000]);
  assert.deepEqual(result.items.map(row => row.sourcePostingIndexes), [[2], [3]]);
  assert.equal(result.issues.length, 0);
  // Contradictory source allocations are held, not subtracted to invent a service.
  allocation.children.find(row => keyName(row.tag) === 'AMOUNT').text = '900.00';
  assert.ok(source(book, 'MS-102').issues.some(row => /unambiguously/.test(row.message)));
});

test('tax, settlement and contradictory direction rows cannot acquire service status through grouping', () => {
  const book = parse(), base = source(book, 'SV-101');
  for (const name of ['CGST', 'Service Buyer']) book.company.ledgers.find(row => row.name === name).groupId = 'g-sales';
  assert.deepEqual(source(book, 'SV-101').items.map(row => row.sourceName), ['Consulting Income', 'Support Income']);
  const entry = children(base.record.node, 'ALLLEDGERENTRIES')[1];
  entry.children.find(row => keyName(row.tag) === 'ISDEEMEDPOSITIVE').text = 'Yes';
  const result = source(book, 'SV-101');
  assert.ok(result.issues.some(row => /direction/.test(row.message))); assert.equal(result.items.length, 1);
});

test('old goods financial legs without inventory allocations do not become service candidates', () => {
  const book = parse(text => text.replace(/<ACCOUNTINGALLOCATIONS\.LIST>[\s\S]*?<\/ACCOUNTINGALLOCATIONS\.LIST>/g, ''));
  for (const name of ['Goods Sales', 'Goods Purchases']) master(book, name).children = master(book, name).children.filter(row => keyName(row.tag) !== 'GSTTYPEOFSUPPLY');
  for (const number of ['MS-102', 'MP-202']) {
    const result = source(book, number);
    assert.equal(result.candidates.length, 0);
    assert.equal(result.items.length, number === 'MS-102' ? 2 : 1);
  }
  const base = source(book, 'MS-102'), entries = children(base.record.node, 'ALLLEDGERENTRIES');
  // Turn this row into the shape of an old pure-goods invoice: one exact goods
  // base, party and taxes, without inventing a service from that financial leg.
  base.record.node.children = base.record.node.children.filter(row => !entries.slice(2, 4).includes(row));
  base.voucher.lines.splice(2, 2);
  assert.equal(source(book, 'MS-102').candidates.length, 0);
  assert.equal(source(book, 'MS-102').items.length, 0);
  // A near match is unresolved; subtracting it would invent a service amount.
  entries[1].children.find(row => keyName(row.tag) === 'AMOUNT').text = '999.00'; base.voucher.lines[1].paise = 99900;
  assert.equal(source(book, 'MS-102').candidates.length, 1);
});

test('Tally-native nested goods allocations keep direct services separate during reimport', () => {
  const book = parse(text => text.replaceAll('ALLLEDGERENTRIES', 'LEDGERENTRIES').replace(/<LEDGERENTRIES\.LIST><LEDGERNAME>Goods (?:Sales|Purchases)<\/LEDGERNAME>[\s\S]*?<\/LEDGERENTRIES\.LIST>/g, ''));
  for (const number of ['MS-102', 'MP-202']) {
    const result = source(book, number);
    assert.equal(result.record.accountingMode, 'ledger-plus-inventory-accounting-allocations');
    assert.equal(result.issues.length, 0); assert.equal(result.candidates.length, 0);
    assert.deepEqual(result.items.map(row => row.sourcePostingIndexes[0]), number === 'MS-102' ? [1, 2] : [1]);
    assert.equal(result.voucher.lines.at(-1).paise, number === 'MS-102' ? 100000 : 120000);
  }
  const sale = source(book, 'MS-102'), allocation = children(children(sale.record.node, 'ALLINVENTORYENTRIES')[0], 'ACCOUNTINGALLOCATIONS')[0];
  allocation.children.find(row => keyName(row.tag) === 'LEDGERNAME').text = 'Consulting Income';
  sale.voucher.lines.at(-1).ledgerId = sale.voucher.lines[1].ledgerId;
  const shared = source(book, 'MS-102');
  assert.equal(shared.issues.length, 0);
  assert.deepEqual(shared.items.map(row => row.valuePaise), [30000, 20000]);
  assert.deepEqual(shared.items.map(row => row.sourcePostingIndexes), [[1], [2]]);
});

test('service tax facts use the supplier document date across a rate change, independently of accounting and receipt dates', () => {
  const book = parse(), ledger = master(book, 'Professional Fees');
  const changed = structuredClone(children(ledger, 'GSTDETAILS')[0]);
  children(changed, 'APPLICABLEFROM')[0].text = '20260407';
  const rateRows = children(children(changed, 'STATEWISEDETAILS')[0], 'RATEDETAILS');
  for (const row of rateRows) children(row, 'GSTRATE')[0].text = value(row, 'GSTRATEDUTYHEAD') === 'Integrated Tax' ? '12' : '6';
  ledger.children.push(changed);
  const result = source(book, 'PV-201', { date: '2026-04-06', direction: 'purchase' });
  const invoice = sourceTaxFacts(result.index, result.record, '2026-04-06', result.items, '23', false, { direction: 'purchase' });
  const accounting = sourceTaxFacts(result.index, result.record, '2026-04-08', result.items, '23', false, { direction: 'purchase' });
  assert.equal(invoice.items[0].gstRateBps.value, 1800); assert.equal(accounting.items[0].gstRateBps.value, 1200);
  assert.equal(result.voucher.date, '2026-04-08');
  assert.ok(invoice.items[0].gstRateBps.superseded.some(row => row.effectiveFrom === '2026-04-07'));
});

test('service workbook facts are bound to the original ledger row rather than unrelated invoice rows', () => {
  const book = parse(), base = source(book, 'SV-101'), entries = children(base.record.node, 'ALLLEDGERENTRIES');
  entries[1].children.push(node('XLSXROWNUMBER', '2')); entries[2].children.push(node('XLSXROWNUMBER', '3'));
  const headers = ['Ledger Name', 'HSN/SAC', 'GST Rate', 'GST Type of Supply', 'Taxability'];
  const xlsxSource = node('XLSXSOURCE', '', [
    [2, ['Consulting Income', '998313', '5', 'Services', 'Taxable']],
    [3, ['Support Income', '998713', '12', 'Services', 'Taxable']],
    [4, ['Consulting Income', '998314', '28', 'Services', 'Taxable']],
    [5, ['Goods Sales', '8541', '18', 'Goods', 'Taxable']],
  ].map(([index, cells]) => ({ ...node('XLSXROW', '', cells.map((text, offset) => node('XLSXCELL', '', [node('HEADER', headers[offset]), node('VALUE', text), node('RAWVALUE', text), node('CELLREF', `${String.fromCharCode(65 + offset)}${index}`)]))), attrs: { INDEX: String(index) } })));
  xlsxSource.attrs.SHEET = 'Public Synthetic Services'; base.record.node.children.push(xlsxSource);
  const result = sourceTallyServiceLines(book.company, base.voucher, base.record, tallyGstFactIndex(book.records));
  const facts = sourceTaxFacts(tallyGstFactIndex(book.records), base.record, base.voucher.date, result.items, '23');
  assert.deepEqual(facts.items.map(row => [row.hsnSac.value, row.gstRateBps.value]), [['998313', 500], ['998713', 1200]]);
  assert.equal(facts.items[0].hsnSac.evidence[0].fieldPath, 'XLSX:Public Synthetic Services!B2');
  assert.equal(facts.items[1].hsnSac.evidence[0].fieldPath, 'XLSX:Public Synthetic Services!B3');
});

test('one plan shares service lookups without changing generic candidates or rescanning all company ledgers', () => {
  const book = parse(), ledger = master(book, 'Consulting Income');
  ledger.children = ledger.children.filter(row => !/GST|HSN/.test(keyName(row.tag)));
  const expected = ['SV-101', 'PV-201', 'MS-102', 'MP-202'].map(number => {
    const { items, candidates, issues } = source(book, number); return { items, candidates, issues };
  });
  let ledgerScans = 0, groupScans = 0;
  const counted = (array, onMap) => new Proxy(array, { get(target, property, receiver) { return property === 'map' ? callback => { onMap(); return target.map(callback); } : Reflect.get(target, property, receiver); } });
  book.company.ledgers = counted(book.company.ledgers, () => ledgerScans++);
  book.company.groups = counted(book.company.groups, () => groupScans++);
  const lookups = tallyServiceSourceLookups(book.company), index = tallyGstFactIndex(book.records);
  const actual = ['SV-101', 'PV-201', 'MS-102', 'MP-202'].map(number => {
    const voucher = book.vouchers.find(row => row.number === number), record = book.records.find(row => row.recordId === voucher.source.recordId);
    return sourceTallyServiceLines(book.company, voucher, record, index, { lookups });
  });
  assert.deepEqual(actual, expected);
  assert.equal(actual[0].candidates[0].classificationStatus, 'absent');
  assert.equal(ledgerScans, 1); assert.equal(groupScans, 1);
  const changed = structuredClone({ ...book.company, groups: [...book.company.groups], ledgers: [...book.company.ledgers] });
  changed.ledgers.find(row => row.name === 'Support Income').groupId = 'g-current-assets';
  const voucher = book.vouchers.find(row => row.number === 'SV-101'), record = book.records.find(row => row.recordId === voucher.source.recordId);
  const fresh = sourceTallyServiceLines(changed, voucher, record, tallyGstFactIndex(book.records), { lookups: tallyServiceSourceLookups(changed) });
  assert.equal(fresh.items.length, 0, 'A fresh plan uses changed company grouping rather than a global cache');
});

test('plan-local service fact reuse is value-equivalent, independently mutable, and keyed by date and source identity', () => {
  const book = parse(), voucher = book.vouchers.find(row => row.number === 'SV-101'), record = book.records.find(row => row.recordId === voucher.source.recordId), index = tallyGstFactIndex(book.records);
  let selections = 0; const get = index.masterCache.get.bind(index.masterCache);
  index.masterCache.get = key => { selections++; return get(key); };
  const services = sourceTallyServiceLines(book.company, voucher, record, index, { registrationState: '23' }).items;
  assert.equal(selections, 2);
  const first = sourceTaxFacts(index, record, voucher.date, services, '23');
  assert.equal(selections, 2, 'Final construction reuses discovery service facts');
  first.items[0].hsnSac.value = 'Changed by caller';
  const again = sourceTaxFacts(index, record, voucher.date, services, '23');
  assert.equal(again.items[0].hsnSac.value, '998313', 'Caller mutations cannot poison cached facts');
  const future = sourceTaxFacts(index, record, '2027-04-05', services, '23');
  assert.equal(selections, 4); assert.equal(future.items[0].gstRateBps.value, 1200);
  const renamedId = sourceTaxFacts(index, record, voucher.date, [{ ...services[0], sourceLineId: 'ledger-entry:rekeyed' }], '23');
  assert.equal(selections, 5); assert.equal(renamedId.items[0].sourceLineId, 'ledger-entry:rekeyed');
  children(children(master(book, 'Consulting Income'), 'HSNDETAILS')[0], 'HSNCODE')[0].text = '998399';
  const fresh = sourceTaxFacts(tallyGstFactIndex(book.records), record, voucher.date, services, '23');
  assert.equal(fresh.items[0].hsnSac.value, '998399', 'A fresh source snapshot invalidates the old plan cache');
});
