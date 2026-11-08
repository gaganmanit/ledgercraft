import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { previewTally, restoreTallyArchive } from '../lib/tally-import.js';
import { saveRegistration, saveParty, saveItem, buildGstInvoice, gstVoucher } from '../lib/gst.js';
import { planTallyGstPromotion, saveTallyGstMapping, activateTallyGstPromotion } from '../lib/tally-gst.js';
import { stockState, stockPeriod, unresolvedTallyStockGaps } from '../lib/stock-engine.js';
import { ensureItcAccounts, buildItcAction, itcStockReviews } from '../lib/gst-itc.js';
import { openingStockControl } from '../lib/stock-accounts.js';
import { exportTallyDayBook, exportTallyMasters } from '../lib/tally-export.js';
import { parseTallyXml, tallyRecords, value, children, findNodes } from '../lib/tally-format.js';

const fixture = await readFile(new URL('fixtures/tally-note-cycle.xml', import.meta.url), 'utf8');
const source = (name, text) => ({ name, base64: Buffer.from(text).toString('base64') });
function initial(text = fixture, prefix = 'N16') {
  const book = typeof text === 'string' ? previewTally([source('synthetic-note-cycle.xml', text)], { companyName: 'Synthetic note cycle', booksFrom: '2026-04-01' }) : text;
  assert.equal(book.canCommit, true, JSON.stringify(book.issues));
  const { company, vouchers } = book, ledger = name => company.ledgers.find(row => row.name === name).id;
  const registration = saveRegistration(company, { name: 'Synthetic note-cycle company', gstin: '23ABCDE1234F1Z8', stateCode: '23', address: 'Synthetic fixture address', invoicePrefix: prefix }, vouchers);
  const supplier = saveParty(company, { name: 'Deccan Fixture Vendor', gstin: '27PQRST5678L1Z0', stateCode: '27', address: 'Synthetic supplier address', kind: 'supplier', supplierLedgerId: ledger('Deccan Fixture Vendor') }, vouchers);
  const customer = saveParty(company, { name: 'Central Fixture Customer', gstin: '23LMNOP1234Q1ZE', stateCode: '23', address: 'Synthetic customer address', kind: 'customer', customerLedgerId: ledger('Central Fixture Customer') }, vouchers);
  const master = company.stock.masters[0];
  const item = saveItem(company, { ...master, stockItemId: master.id, name: master.name, kind: 'goods', hsnSac: '8541', gstRateBps: 1800, unit: 'NOS' }, vouchers);
  return { ...book, registration, supplier, customer, item };
}
function activate(book, number, noteReview) {
  const { company, vouchers } = book, record = book.records.find(row => row.type === 'VOUCHER' && row.disposition === 'voucher' && value(row.node, 'VOUCHERNUMBER') === number);
  const voucher = vouchers.find(row => row.id === record.voucherId), purchase = ['P-48', 'PD-5', 'PC-6'].includes(number), party = purchase ? book.supplier : book.customer;
  const ledger = name => company.ledgers.find(row => row.name === name).id;
  const accounts = purchase ? { party: party.supplierLedgerId, purchase: ledger('Purchase'), igst: ledger('Input IGST') } : { party: party.customerLedgerId, sales: ledger('Domestic Sales'), cgst: ledger('Output CGST'), sgst: ledger('Output SGST') };
  const mapping = { recordId: record.recordId, registrationId: book.registration.id, partyId: party.id, items: ['DN-7', 'PC-6'].includes(number) ? [] : [{ sourceName: book.item.name, itemId: book.item.id }], accounts,
    ...(number === 'P-48' ? { purchaseReview: { receivedDate: '2026-04-02', itcEligibility: 'pending' } } : {}), ...(noteReview ? { noteReview } : {}), evidence: { name: 'Independent synthetic cycle evidence', reference: `Synthetic ${number} original invoice and statutory document checked in local fixture` } };
  const saved = saveTallyGstMapping(company, vouchers, book.records, { ...mapping, revision: company.gst.tallyPromotion?.revision || 0, requestId: `note-stock-save-${number}-0001` });
  const plan = planTallyGstPromotion(saved.company, saved.vouchers, book.records), row = plan.rows.find(row => row.recordId === record.recordId);
  assert.equal(row.status, 'ready', JSON.stringify(row));
  const result = activateTallyGstPromotion(saved.company, saved.vouchers, book.records, { revision: plan.revision, reviewHash: plan.reviewHash, recordIds: [record.recordId], requestId: `note-stock-activate-${number}-0001` });
  assert.equal(result.vouchers.find(row => row.id === voucher.id).id, voucher.id);
  return { ...book, ...result };
}
function originals(book = initial()) {
  book = activate(book, 'P-48'); book = activate(book, 'S-10');
  return book;
}
function review(book, number) {
  const purchase = ['PD-5', 'PC-6'].includes(number), physical = ['CN-2', 'PD-5'].includes(number);
  const original = book.vouchers.find(row => row.source.originalNumber === (purchase ? 'P-48' : 'S-10')).gst;
  return { direction: purchase ? 'purchase' : 'sales', originalInvoiceId: original.id, originalNumber: purchase ? original.supplierInvoiceNumber : original.number, originalDate: purchase ? original.supplierInvoiceDate : original.date,
    stockEffect: physical ? 'quantity' : 'none', ...(purchase ? { supplierDocumentConfirmed: true, supplierNoteNumber: number === 'PD-5' ? 'SCN/9' : 'SDN/1', supplierNoteDate: number === 'PD-5' ? '2026-04-09' : '2026-04-11' } : {}),
    lines: physical ? [{ sourceLineIndex: 0, originalLineIndex: 0 }] : [{ originalLineIndex: 0, quantity: '1', unitPricePaise: number === 'DN-7' ? 1000 : 2000, discountBps: 0 }] };
}
function cycle(book = originals()) { for (const number of ['CN-2', 'DN-7', 'PD-5', 'PC-6']) book = activate(book, number, review(book, number)); return book; }
const archive = book => ({ format: 'financer-tally-archive', version: 1, company: book.company, vouchers: book.vouchers, records: book.records, sources: book.sources, sourceBookHash: null });

test('reviewed source note movements restore original cost once, resolve only their old gaps and preserve the baseline', () => {
  const base = originals(), baseline = structuredClone(base.company.stock.tally), originalPostings = base.vouchers.map(({ gst, ...voucher }) => voucher);
  assert.equal(baseline.sourceGaps.length, 2);
  assert.equal(unresolvedTallyStockGaps(base.company, base.vouchers).length, 2);
  const book = cycle(base), state = stockState(book.company, book.vouchers, { to: '2026-04-30' });
  assert.deepEqual(book.company.stock.tally, baseline);
  assert.deepEqual(book.vouchers.map(({ gst, ...voucher }) => voucher), originalPostings);
  assert.equal(book.company.stock.journals.length, 4);
  assert.equal(unresolvedTallyStockGaps(book.company, book.vouchers).length, 0);
  assert.equal(openingStockControl(book.company, book.vouchers).reason, '');
  assert.equal(state.items[0].quantity, '1');
  assert.equal(state.items[0].knownValuePaise, 6667);
  const cn = book.vouchers.find(row => row.source.originalNumber === 'CN-2'), pd = book.vouchers.find(row => row.source.originalNumber === 'PD-5');
  const returned = state.items[0].movements.find(row => row.sourceId === cn.id), issued = state.items[0].movements.find(row => row.sourceId === pd.id);
  assert.equal(returned.financialKind, 'sales-return'); assert.equal(returned.valuePaise, 6667); assert.notEqual(returned.valuePaise, 15000);
  assert.equal(issued.financialKind, 'purchase-return'); assert.equal(issued.originalSourceId, book.vouchers.find(row => row.source.originalNumber === 'P-48').id);
  assert.equal(issued.quantity, '-1');
  assert.ok(!state.issues.some(row => row.code === 'tally-stock-source-exception' || row.code === 'unlinked-return-cost'));
  assert.ok(state.issues.some(row => row.code === 'pending-tax-cost'));
  assert.equal(stockState(book.company, book.vouchers, { to: '2026-04-02' }).items[0].quantity, '3');
  assert.equal(stockState(book.company, book.vouchers, { to: '2026-04-03' }).items[0].quantity, '1');
  assert.equal(stockState(book.company, book.vouchers, { to: '2026-04-07' }).items[0].quantity, '2');
  const restored = restoreTallyArchive(archive(book)); assert.deepEqual(restored.vouchers, book.vouchers); assert.deepEqual(restored.company.stock, book.company.stock);
});

test('sales returns use the original issued COGS despite a later high-price receipt or current average cost', () => {
  const book = cycle();
  const changed = structuredClone(book);
  changed.company.stock.items[book.item.id].costingMethod = 'moving-average';
  changed.company.stock.journals.push({ id: 'sj-independent-price-shock', date: '2026-04-05', number: 'PRICE-SHOCK', type: 'receipt', financialKind: 'purchase', lines: [{ itemId: book.item.id, quantity: '1', valuePaise: 90000 }] });
  const state = stockState(changed.company, changed.vouchers, { to: '2026-04-30' }), cn = book.vouchers.find(row => row.source.originalNumber === 'CN-2');
  const returned = state.items[0].movements.find(row => row.sourceId === cn.id);
  assert.equal(returned.valuePaise, 6667); assert.notEqual(returned.valuePaise, 90000); assert.equal(state.items[0].quantity, '2');
});

test('pre-1.6 source notes remain an unchanged source-only baseline through restore', () => {
  const book = initial(), before = structuredClone(book.company.stock), restored = restoreTallyArchive(archive(book));
  assert.equal(before.tally.version, 1); assert.equal(before.journals.length, 2); assert.equal(before.tally.sourceGaps.length, 2);
  assert.deepEqual(restored.company.stock, before); assert.ok(restored.vouchers.every(row => !row.gst));
});


const ledgerTotals = book => {
  const names = new Map(book.company.ledgers.map(row => [row.id, row.name])), amounts = new Map();
  for (const voucher of book.vouchers) for (const line of voucher.lines) {
    const key = [voucher.source.originalNumber, names.get(line.ledgerId), line.dc].join('|');
    amounts.set(key, (amounts.get(key) || 0) + line.paise);
  }
  return [...amounts].sort(([a], [b]) => a.localeCompare(b));
};

test('full note cycle XML reimports and reactivates original purchases, linked sales and four statutory note identities', () => {
  const book = cycle();
  const masters = exportTallyMasters(book.company, book.vouchers), daybook = exportTallyDayBook(book.company, book.vouchers, '2026-04-01', '2026-04-30');
  const nodes = tallyRecords(parseTallyXml(daybook)).filter(row => row.type === 'VOUCHER').map(row => row.node);
  assert.equal(nodes.length, 6);
  const byNumber = number => nodes.find(node => value(node, 'VOUCHERNUMBER') === number);
  assert.equal(value(byNumber('S-10'), 'CMPGSTIN'), '23ABCDE1234F1Z8');
  assert.equal(value(children(byNumber('S-10'), 'ALLINVENTORYENTRIES')[0], 'RATE'), '150.00/nos');
  assert.equal(value(byNumber('CN-2'), 'VOUCHERTYPENAME'), 'Credit Note');
  assert.equal(value(byNumber('PD-5'), 'VOUCHERTYPENAME'), 'Debit Note');
  assert.equal(value(byNumber('PD-5'), 'REFERENCE'), 'SCN/9'); assert.equal(value(byNumber('PD-5'), 'REFERENCEDATE'), '20260409');
  assert.equal(value(byNumber('PD-5'), 'ORIGINALINVOICENO'), 'INV/3103'); assert.equal(value(byNumber('PD-5'), 'ORIGINALINVOICEDATE'), '20260331');
  assert.equal(value(byNumber('PC-6'), 'VOUCHERTYPENAME'), 'Credit Note'); assert.equal(value(byNumber('PC-6'), 'REFERENCE'), 'SDN/1');
  for (const number of ['DN-7', 'PC-6']) assert.equal(findNodes(byNumber(number), 'ALLINVENTORYENTRIES').length, 0, 'A financial-only note must not invent an inventory row');
  assert.equal(value(children(byNumber('CN-2'), 'ALLINVENTORYENTRIES')[0], 'AMOUNT'), '-150.00');
  assert.equal(value(children(byNumber('PD-5'), 'ALLINVENTORYENTRIES')[0], 'AMOUNT'), '100.00');
  const imported = previewTally([source('Masters.xml', masters), source('DayBook.xml', daybook), source('Same-DayBook.xml', daybook)], { companyName: 'Reimported note cycle', booksFrom: '2026-04-01' });
  assert.equal(imported.canCommit, true, JSON.stringify(imported.issues)); assert.equal(imported.vouchers.length, 6);
  assert.deepEqual(ledgerTotals(imported), ledgerTotals(book));
  const after = cycle(originals(initial(imported, 'R16')));
  assert.equal(after.company.stock.journals.length, 4); assert.deepEqual(ledgerTotals(after), ledgerTotals(book));
  for (const number of ['P-48', 'S-10', 'CN-2', 'DN-7', 'PD-5', 'PC-6']) {
    const before = book.vouchers.find(row => row.source.originalNumber === number).gst, returned = after.vouchers.find(row => row.source.originalNumber === number).gst;
    assert.equal(returned.type, before.type); assert.equal(returned.direction, before.direction); assert.deepEqual(returned.totals, before.totals);
    assert.equal(returned.supplierInvoiceNumber, before.supplierInvoiceNumber); assert.equal(returned.supplierInvoiceDate, before.supplierInvoiceDate);
  }
  const state = stockState(after.company, after.vouchers, { to: '2026-04-30' });
  assert.equal(state.items[0].quantity, '1'); assert.equal(state.items[0].knownValuePaise, 6667);
  assert.equal(unresolvedTallyStockGaps(after.company, after.vouchers).length, 0);
  assert.deepEqual(restoreTallyArchive(archive(after)).company.stock, after.company.stock);
});

test('only activated represented note gaps resolve; unrelated original gaps remain visible', () => {
  const extra = '<STOCKITEM NAME="Unsupported Fixture Item"><NAME>Unsupported Fixture Item</NAME><BASEUNITS>nos</BASEUNITS><ADDITIONALUNITS>box</ADDITIONALUNITS></STOCKITEM>';
  const base = originals(initial(fixture.replace('</TALLYMESSAGE>', extra + '</TALLYMESSAGE>')));
  const once = activate(base, 'CN-2', review(base, 'CN-2'));
  const pending = unresolvedTallyStockGaps(once.company, once.vouchers);
  assert.equal(pending.length, 2); assert.ok(pending.some(row => /Unsupported Fixture Item/.test(row.message)));
  const after = cycleRemaining(once, ['DN-7', 'PD-5', 'PC-6']);
  assert.equal(unresolvedTallyStockGaps(after.company, after.vouchers).length, 1);
  assert.match(openingStockControl(after.company, after.vouchers).reason, /Unsupported Fixture Item/);
  assert.ok(stockState(after.company, after.vouchers, { to: '2026-04-30' }).issues.some(row => /Unsupported Fixture Item/.test(row.message)));
});
function cycleRemaining(book, numbers) { for (const number of numbers) book = activate(book, number, review(book, number)); return book; }


test('native financial-only purchase debit note ITC claim changes no physical layer or pending stock tax', () => {
  const book = originals(), original = book.vouchers.find(row => row.source.originalNumber === 'P-48').gst;
  const invoice = buildGstInvoice(book.company, book.vouchers, { type: 'Debit Note', direction: 'purchase', registrationId: book.registration.id, partyId: book.supplier.id, originalInvoiceId: original.id, number: 'NATIVE-DN-1', supplierInvoiceNumber: 'ND/1', supplierInvoiceDate: '2026-04-12', date: '2026-04-13', placeOfSupply: '23', stockEffect: 'none', itcEligibility: 'pending', items: [{ itemId: book.item.id, quantity: '1', unitPricePaise: 2000 }] });
  book.vouchers.push(gstVoucher(invoice)); ensureItcAccounts(book.company, book.registration.id);
  const before = stockState(book.company, book.vouchers, { to: '2026-04-30' });
  assert.ok(!before.issues.some(row => row.sourceId === invoice.id && row.code === 'pending-tax-cost'));
  assert.ok(before.issues.some(row => row.sourceId === invoice.id && row.code === 'financial-note-cost-allocation'));
  const result = buildItcAction(book.company, book.vouchers, 'claim', { invoiceId: invoice.id, date: '2026-04-16', reference: 'Synthetic financial note claim', requestId: 'native-no-quantity-claim-0001', evidence: { basis: 'Synthetic evidence review', documentReference: 'ND/1', invoiceHeld: true, received: true, businessUse: true, notBlocked: true, supplierReported: true, supplierTaxPaid: true, returnFurnished: true, paymentReview: true, noTaxDepreciation: true, annualReturnStatus: 'not-filed' } });
  book.company.gst.itc.records.push(result.record); if (result.voucher) book.vouchers.push(result.voucher);
  assert.ok(itcStockReviews(book.company, book.vouchers).filter(row => row.originSourceId === invoice.id).every(row => !row.pendingReduction && !row.costDelta));
  const after = stockState(book.company, book.vouchers, { to: '2026-04-30' });
  assert.equal(after.items[0].quantity, before.items[0].quantity); assert.equal(after.items[0].knownValuePaise, before.items[0].knownValuePaise);
  assert.ok(after.issues.some(row => row.sourceId === invoice.id && row.code === 'financial-note-cost-allocation'));
});


test('note and linked-original allocations that lack a faithful serializer retain an explicit exact-archive fallback', () => {
  for (const amount of ['177.00', '-354.00']) {
    const changed = fixture.replace(`<AMOUNT>${amount}</AMOUNT>`, `<AMOUNT>${amount}</AMOUNT><BANKALLOCATIONS.LIST><BANKNAME>Synthetic source bank</BANKNAME><AMOUNT>${amount}</AMOUNT></BANKALLOCATIONS.LIST>`);
    const book = cycle(originals(initial(changed))), saved = structuredClone(book);
    assert.throws(() => exportTallyDayBook(book.company, book.vouchers, '2026-04-01', '2026-04-30'), /BANKALLOCATIONS.*full source archive/);
    assert.deepEqual(book, saved); assert.deepEqual(restoreTallyArchive(archive(book)).sources, book.sources);
  }
});

test('unrelated promoted Sales keep their existing accounting export path', () => {
  const book = originals(), daybook = exportTallyDayBook(book.company, book.vouchers, '2026-04-01', '2026-04-30');
  const sale = tallyRecords(parseTallyXml(daybook)).find(row => row.type === 'VOUCHER' && value(row.node, 'VOUCHERNUMBER') === 'S-10').node;
  assert.equal(value(sale, 'ISINVOICE'), 'No'); assert.equal(value(children(sale, 'ALLINVENTORYENTRIES')[0], 'RATE'), '');
});


test('financial-only review cannot hide positive nested physical quantities and ambiguous outbound lines stay source-only', () => {
  const change = '<ACTUALQTY>0 nos</ACTUALQTY><BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><ACTUALQTY>1 nos</ACTUALQTY><BILLEDQTY>1 nos</BILLEDQTY><AMOUNT>-150.00</AMOUNT></BATCHALLOCATIONS.LIST>';
  const hidden = originals(initial(fixture.replace('<ACTUALQTY>1 nos</ACTUALQTY>', change)));
  const wrong = { ...review(hidden, 'CN-2'), stockEffect: 'none' };
  assert.throws(() => activate(hidden, 'CN-2', wrong), /financial-only note cannot discard a supplied physical quantity/);
  const zero = originals(initial(fixture.replace('<ACTUALQTY>1 nos</ACTUALQTY>', '<ACTUALQTY>0 nos</ACTUALQTY>')));
  const financial = activate(zero, 'CN-2', { ...review(zero, 'CN-2'), stockEffect: 'none' });
  assert.throws(() => exportTallyDayBook(financial.company, financial.vouchers, '2026-04-01', '2026-04-30'), /Financial-only note XML.*full source archive/);
  const split = originals(), splitReview = review(split, 'DN-7');
  splitReview.lines = [{ originalLineIndex: 0, quantity: '0.5', unitPricePaise: 1000 }, { originalLineIndex: 0, quantity: '0.5', unitPricePaise: 1000 }];
  const multiple = activate(split, 'DN-7', splitReview);
  assert.throws(() => exportTallyDayBook(multiple.company, multiple.vouchers, '2026-04-01', '2026-04-30'), /Financial-only note XML.*full source archive/);
});


test('native quantity notes bind identical item returns to the GST-selected original line and reject conflicting stock metadata', () => {
  const company = { id: 'native-selected-note-line', booksFrom: '2026-04-01', gst: { items: [{ id: 'same-item', name: 'Same synthetic item', kind: 'goods', unit: 'NOS', openingQuantity: '0' }] }, stock: { version: 1, items: { 'same-item': { openingValuePaise: 0 } }, journals: [] } };
  const line = value => ({ itemId: 'same-item', kind: 'goods', quantity: '1', taxablePaise: value, taxPaise: 0 });
  const doc = (id, date, direction, items, extra = {}) => ({ id, date, number: id, gst: { id, date, number: id, direction, type: direction === 'sales' ? 'Sales' : 'Purchase', stockEffect: 'quantity', itcEligibility: 'eligible', items, ...extra } });
  const buy = doc('native-two-costs', '2026-04-02', 'purchase', [line(10000), line(90000)]);
  const sale = doc('native-identical-sale', '2026-04-03', 'sales', [line(50000), line(50000)]);
  for (const direction of ['sales', 'purchase']) {
    const original = direction === 'sales' ? sale : buy;
    const note = doc('native-selected-return', '2026-04-04', direction, [line(direction === 'sales' ? 50000 : 90000)], { type: 'Credit Note', originalInvoiceId: original.id, noteLinkVersion: 1, originalLineMap: [1] });
    const vouchers = direction === 'sales' ? [buy, sale, note] : [buy, note];
    const report = stockState(company, vouchers, { to: '2026-04-30' }), movement = report.items[0].movements.find(row => row.sourceId === note.id);
    assert.equal(movement.valuePaise, direction === 'sales' ? 90000 : -90000);
    assert.equal(report.items[0].quantity, '1'); assert.equal(report.items[0].knownValuePaise, direction === 'sales' ? 90000 : 10000);
    const conflict = structuredClone(vouchers); conflict.at(-1).stock = { version: 1, lines: [{ lineIndex: 0, originalLineIndex: 0 }] };
    assert.throws(() => stockState(company, conflict, { to: '2026-04-30' }), /Stock original line metadata differs from the GST note allocation/);
  }
});
