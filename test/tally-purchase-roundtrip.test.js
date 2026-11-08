import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { previewTally, restoreTallyArchive } from '../lib/tally-import.js';
import { saveRegistration, saveParty, saveItem, gstinCheckDigit } from '../lib/gst.js';
import { planTallyGstPromotion, saveTallyGstMapping, activateTallyGstPromotion } from '../lib/tally-gst.js';
import { exportTallyMasters, exportTallyDayBook } from '../lib/tally-export.js';
import { parseTallyXml, tallyRecords, value, children, findNodes, attribute } from '../lib/tally-format.js';
import { trialBalance } from '../lib/engine.js';
import { stockState, stockPeriod } from '../lib/stock-engine.js';
import { returnWorkbook } from '../lib/gst-returns.js';
import { itcState } from '../lib/gst-itc.js';

const original = await readFile(new URL('fixtures/tally-purchase-gst.xml', import.meta.url), 'utf8');
const source = (name, text) => ({ name, base64: Buffer.from(text).toString('base64') });
function input(change = text => text) {
  const text = change(original);
  const preview = previewTally([source('independent-purchase.xml', text)], { companyName: 'Purchase roundtrip fixture', booksFrom: '2026-04-01' });
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
  return preview;
}
function promote(preview, prefix = 'SRC', supplierDate = '2026-03-31', stockMode = 'source') {
  const { company, vouchers } = preview, ledger = name => company.ledgers.find(row => row.name === name).id;
  const record = preview.records.find(row => row.type === 'VOUCHER');
  const buyerGstin = value(record.node, 'CMPGSTIN'), supplierGstin = value(record.node, 'PARTYGSTIN');
  const registration = saveRegistration(company, { name: 'Synthetic fixture buyer', gstin: buyerGstin, stateCode: buyerGstin.slice(0, 2), address: 'Synthetic fixture buyer address', invoicePrefix: prefix }, vouchers);
  const party = saveParty(company, { name: 'Deccan Fixture Vendor', gstin: supplierGstin, stateCode: supplierGstin.slice(0, 2), address: 'Synthetic fixture supplier address', kind: 'supplier', supplierLedgerId: ledger('Deccan Fixture Vendor') }, vouchers);
  const master = company.stock.masters.find(row => row.name === 'Copper Test Part');
  const item = saveItem(company, { ...master, stockItemId: master.id, name: master.name, kind: 'goods', hsnSac: '8541', unit: 'NOS', gstRateBps: 1800 }, vouchers);
  const mapping = { stockMode, recordId: record.recordId, registrationId: registration.id, partyId: party.id, items: [{ sourceName: master.name, itemId: item.id }], accounts: { party: ledger('Deccan Fixture Vendor'), purchase: ledger('Purchase'), ...Object.fromEntries(['cgst', 'sgst', 'utgst', 'igst'].filter(head => company.ledgers.some(row => row.name === 'Input ' + head.toUpperCase())).map(head => [head, ledger('Input ' + head.toUpperCase())])) }, purchaseReview: { receivedDate: '2026-04-01', itcEligibility: 'pending' }, evidence: { name: 'Independent synthetic fixture evidence', reference: 'Printed supplier INV/3103 and native GST/physical source facts; synthetic test only' } };
  const saved = saveTallyGstMapping(company, vouchers, preview.records, { ...mapping, revision: 0, requestId: `roundtrip-save-${prefix}-00001` });
  const plan = planTallyGstPromotion(saved.company, saved.vouchers, preview.records);
  assert.equal(plan.summary.ready, 1, JSON.stringify(plan.rows));
  const activated = activateTallyGstPromotion(saved.company, saved.vouchers, preview.records, { revision: plan.revision, reviewHash: plan.reviewHash, recordIds: [record.recordId], requestId: `roundtrip-activate-${prefix}-00001` });
  assert.equal(activated.vouchers[0].gst.supplierInvoiceDate, supplierDate);
  return { ...preview, ...activated, registration, party, item };
}
function exchange(book) {
  const masters = exportTallyMasters(book.company, book.vouchers), daybook = exportTallyDayBook(book.company, book.vouchers, '2026-04-01', '2026-04-30');
  const preview = previewTally([source('Masters.xml', masters), source('DayBook.xml', daybook)], { companyName: 'Purchase exchange reimport', booksFrom: '2026-04-01' });
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
  return { masters, daybook, preview };
}
const postings = book => {
  const ledgers = new Map(book.company.ledgers.map(row => [row.id, row.name])), amounts = new Map();
  for (const voucher of book.vouchers) for (const line of voucher.lines) {
    const key = `${ledgers.get(line.ledgerId)}:${line.dc}`; amounts.set(key, (amounts.get(key) || 0) + line.paise);
  }
  return [...amounts].sort(([a], [b]) => a.localeCompare(b));
};
const trial = book => trialBalance(book.company, book.vouchers, '2026-04-01', '2026-04-30').rows.filter(row => row.periodDr || row.periodCr || row.opening.paise).map(({ name, opening, periodDr, periodCr, closing }) => ({ name, opening, periodDr, periodCr, closing })).sort((a, b) => a.name.localeCompare(b.name));
const archive = book => ({ format: 'financer-tally-archive', version: 1, company: book.company, vouchers: book.vouchers, records: book.records, sources: book.sources, sourceBookHash: null });

test('promoted interstate Purchase XML reimports and reactivates once with independent source identities, prices and tax facts', () => {
  const book = promote(input()), invoice = book.vouchers[0].gst;
  // The exported document must use its historical reviewed facts, even after a current master edit.
  saveItem(book.company, { ...book.item, hsnSac: '8542', gstRateBps: 1200 }, book.vouchers);
  const { masters, daybook, preview } = exchange(book);
  const node = tallyRecords(parseTallyXml(daybook)).find(row => row.type === 'VOUCHER').node;
  assert.equal(attribute(node, 'VCHTYPE'), 'Purchase'); assert.equal(value(node, 'VOUCHERNUMBER'), 'P-48');
  assert.equal(value(node, 'DATE'), '20260402'); assert.equal(value(node, 'REFERENCE'), 'INV/3103'); assert.equal(value(node, 'REFERENCEDATE'), '20260331');
  assert.equal(value(node, 'CMPGSTIN'), '23ABCDE1234F1Z8'); assert.equal(value(node, 'PARTYGSTIN'), '27PQRST5678L1Z0');
  assert.equal(value(node, 'PARTYSTATENAME'), 'Maharashtra'); assert.equal(value(node, 'PLACEOFSUPPLY'), 'Madhya Pradesh');
  assert.equal(value(node, 'PERSISTEDVIEW'), 'Invoice Voucher View'); assert.equal(value(node, 'ISINVOICE'), 'Yes');
  assert.equal(children(node, 'ALLLEDGERENTRIES').length, 0);
  assert.equal(children(node, 'LEDGERENTRIES').length, 2);
  assert.ok(children(node, 'LEDGERENTRIES').every(row => value(row, 'LEDGERNAME') !== 'Purchase'));
  const stock = children(node, 'ALLINVENTORYENTRIES'); assert.equal(stock.length, 1);
  assert.equal(value(stock[0], 'ACTUALQTY'), '3 nos'); assert.equal(value(stock[0], 'BILLEDQTY'), '2 nos');
  assert.equal(value(stock[0], 'RATE'), '100.00/nos'); assert.equal(value(stock[0], 'AMOUNT'), '-200.00');
  assert.equal(value(stock[0], 'GSTHSNNAME'), '8541');
  assert.equal(value(children(stock[0], 'RATEDETAILS')[0], 'GSTRATE'), '18.00');
  assert.equal(children(stock[0], 'ACCOUNTINGALLOCATIONS').length, 1);
  assert.equal(value(children(stock[0], 'ACCOUNTINGALLOCATIONS')[0], 'AMOUNT'), '-200.00');
  assert.equal(value(findNodes(parseTallyXml(masters), 'LEDGER').find(row => attribute(row, 'NAME') === 'Input IGST'), 'GSTDUTYHEAD'), 'Integrated Tax');
  assert.match(daybook, new RegExp(invoice.tallyOrigin.mappingHash));
  assert.equal(findNodes(node, 'IRN').length + findNodes(node, 'IRNACKNO').length + findNodes(node, 'EWAYBILLNUMBER').length, 0);
  assert.equal(preview.vouchers.length, 1); assert.equal(preview.company.stock.journals.length, 1);
  assert.equal(preview.company.stock.journals[0].type, 'receipt');
  assert.deepEqual(postings(preview), postings(book));
  assert.deepEqual(trial(preview), trial(book));
  const reactivated = promote(preview, 'DST');
  assert.deepEqual(postings(reactivated), postings(book));
  const recovered = reactivated.vouchers[0].gst;
  assert.equal(recovered.supplierInvoiceNumber, invoice.supplierInvoiceNumber); assert.equal(recovered.supplierInvoiceDate, invoice.supplierInvoiceDate);
  assert.equal(recovered.number, invoice.number); assert.deepEqual(recovered.totals, invoice.totals);
  assert.equal(recovered.items[0].hsnSac, '8541'); assert.equal(recovered.items[0].gstRateBps, 1800);
  assert.equal(recovered.tallyOrigin.source.taxFacts.items[0].hsnSac.value, '8541');
  assert.equal(recovered.tallyOrigin.source.taxFacts.items[0].gstRateBps.value, 1800);
  assert.match(recovered.tallyOrigin.source.taxFacts.items[0].hsnSac.evidence[0].fieldPath, /GSTHSNNAME/);
  const physical = stockState(reactivated.company, reactivated.vouchers, { to: '2026-04-30' });
  assert.equal(physical.items[0].quantity, '3'); assert.equal(physical.items[0].knownValuePaise, 20000);
  assert.equal(stockPeriod(reactivated.company, reactivated.vouchers, { from: '2026-04-01', to: '2026-04-30' }).financial.netPurchasesPaise, 20000);
  assert.equal(reactivated.company.stock.journals.length, 1);
  const returns = returnWorkbook(reactivated.company, reactivated.vouchers, reactivated.registration.id, '2026-04', new Map());
  assert.equal(returns.summary.purchases.taxablePaise, 20000); assert.equal(returns.summary.pendingInput.igstPaise, 3600);
  assert.equal(returns.itc.reviewedNet.igstPaise, 0);
  assert.equal(itcState(reactivated.company, reactivated.vouchers, '2026-04-30').documents[0].initialEligibility, 'pending');
});

test('godown splits rejoin original invoice lines without changing actual, billed or allocated receipt costs', () => {
  const book = promote(input(text => text.replace('<UNIT NAME=', '<GODOWN NAME="Workshop"><NAME>Workshop</NAME><PARENT>Primary</PARENT></GODOWN><UNIT NAME=').replace('<RATE>100.00/nos</RATE><AMOUNT>-200.00</AMOUNT>', '<RATE>100.00/nos</RATE><AMOUNT>-200.00</AMOUNT><BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><ACTUALQTY>1 nos</ACTUALQTY><BILLEDQTY>1 nos</BILLEDQTY><AMOUNT>-100</AMOUNT></BATCHALLOCATIONS.LIST><BATCHALLOCATIONS.LIST><GODOWNNAME>Workshop</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><ACTUALQTY>2 nos</ACTUALQTY><BILLEDQTY>1 nos</BILLEDQTY><AMOUNT>-100</AMOUNT></BATCHALLOCATIONS.LIST>')));
  const { daybook, preview } = exchange(book), node = findNodes(parseTallyXml(daybook), 'VOUCHER')[0];
  assert.equal(children(node, 'ALLINVENTORYENTRIES').length, 1);
  assert.equal(findNodes(node, 'BATCHALLOCATIONS').length, 2);
  const after = promote(preview, 'GOD'), receipt = after.company.stock.journals[0];
  assert.deepEqual(receipt.lines.map(row => [row.quantity, row.billedQuantity, row.valuePaise]), [['1', '1', 10000], ['2', '1', 10000]]);
  assert.equal(stockState(after.company, after.vouchers, { to: '2026-04-30' }).items[0].quantity, '3');
  assert.deepEqual(postings(after), postings(book));
});

test('custom source Purchase voucher types and percentage discounts retain their source series and prices', () => {
  const book = promote(input(text => text.replace('<VOUCHER VCHTYPE="Purchase">', '<VOUCHERTYPE NAME="Domestic Purchases"><NAME>Domestic Purchases</NAME><PARENT>Purchase</PARENT></VOUCHERTYPE><VOUCHER VCHTYPE="Domestic Purchases">').replace('<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>', '<VOUCHERTYPENAME>Domestic Purchases</VOUCHERTYPENAME>').replace('<AMOUNT>236.00</AMOUNT>', '<AMOUNT>212.40</AMOUNT>').replaceAll('<AMOUNT>-200.00</AMOUNT>', '<AMOUNT>-180.00</AMOUNT>').replace('<AMOUNT>-36.00</AMOUNT>', '<AMOUNT>-32.40</AMOUNT>').replace('<RATE>100.00/nos</RATE>', '<RATE>100.00/nos</RATE><DISCOUNT>10%</DISCOUNT>')));
  const { daybook, masters, preview } = exchange(book), node = findNodes(parseTallyXml(daybook), 'VOUCHER')[0];
  assert.equal(value(node, 'VOUCHERTYPENAME'), 'Domestic Purchases');
  assert.equal(value(findNodes(parseTallyXml(masters), 'VOUCHERTYPE')[0], 'PARENT'), 'Purchase');
  assert.equal(value(findNodes(node, 'ALLINVENTORYENTRIES')[0], 'DISCOUNT'), '10.00');
  const after = promote(preview, 'DISC');
  assert.equal(after.vouchers[0].gst.items[0].discountBps, 1000); assert.equal(after.vouchers[0].gst.items[0].unitPricePaise, 10000);
  assert.equal(after.vouchers[0].gst.totals.taxablePaise, 18000); assert.deepEqual(postings(after), postings(book));
});

const bill = '<BILLALLOCATIONS.LIST><NAME>INV/3103</NAME><BILLTYPE>New Ref</BILLTYPE><BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD><AMOUNT>236.00</AMOUNT></BILLALLOCATIONS.LIST>';
const addPartyAllocation = (text, allocation) => text.replace('<AMOUNT>236.00</AMOUNT></ALLLEDGERENTRIES.LIST>', `<AMOUNT>236.00</AMOUNT>${allocation}</ALLLEDGERENTRIES.LIST>`);

test('activated source New Ref bills and their original credit period survive Purchase XML roundtrip', () => {
  const book = promote(input(text => addPartyAllocation(text, bill)));
  assert.equal(book.company.reconciliation.bills.length, 1);
  const { daybook, masters, preview } = exchange(book);
  const supplier = findNodes(parseTallyXml(masters), 'LEDGER').find(node => attribute(node, 'NAME') === 'Deccan Fixture Vendor');
  assert.equal(value(supplier, 'ISBILLWISEON'), 'Yes');
  const node = findNodes(parseTallyXml(daybook), 'BILLALLOCATIONS')[0];
  assert.equal(value(node, 'NAME'), 'INV/3103'); assert.equal(value(node, 'BILLCREDITPERIOD'), '30 Days');
  assert.equal(preview.company.reconciliation.bills.length, 1);
  assert.deepEqual(preview.company.reconciliation.bills.map(row => [row.reference, row.date, row.dueDate, row.amountPaise]), book.company.reconciliation.bills.map(row => [row.reference, row.date, row.dueDate, row.amountPaise]));
  promote(preview, 'BILL');
});

test('unrepresentable source allocations fail explicitly and leave exact full archive bytes available', () => {
  const book = promote(input(text => addPartyAllocation(text, '<BANKALLOCATIONS.LIST><BANKNAME>Synthetic Source Bank</BANKNAME><AMOUNT>236.00</AMOUNT></BANKALLOCATIONS.LIST>')));
  const before = structuredClone(book);
  assert.throws(() => exportTallyDayBook(book.company, book.vouchers, '2026-04-01', '2026-04-30'), /BANKALLOCATIONS.*full source archive/);
  assert.deepEqual(book, before);
  const restored = restoreTallyArchive(archive(book));
  assert.deepEqual(restored.sources, book.sources); assert.deepEqual(restored.vouchers, book.vouchers);
});


const taxEntry = (head, amount) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>Input ${head}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${amount}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
const checksum = (state, pan) => { const prefix = `${state}${pan}1Z`; return prefix + gstinCheckDigit(prefix); };
for (const territory of [false, true]) test(`${territory ? 'UTGST' : 'CGST/SGST'} Purchase keeps split tax heads on export and reactivation`, () => {
  const state = territory ? '04' : '23', name = territory ? 'Chandigarh' : 'Madhya Pradesh', other = territory ? 'UTGST' : 'SGST';
  const book = promote(input(text => text.replaceAll('23ABCDE1234F1Z8', checksum(state, 'ABCDE1234F')).replaceAll('27PQRST5678L1Z0', checksum(state, 'PQRST5678L')).replaceAll('Maharashtra', name).replaceAll('Madhya Pradesh', name)
    .replace('<LEDGER NAME="Input IGST"><PARENT>Duties &amp; Taxes</PARENT></LEDGER>', `<LEDGER NAME="Input CGST"><PARENT>Duties &amp; Taxes</PARENT></LEDGER><LEDGER NAME="Input ${other}"><PARENT>Duties &amp; Taxes</PARENT></LEDGER>`)
    .replace('<ALLLEDGERENTRIES.LIST><LEDGERNAME>Input IGST</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-36.00</AMOUNT></ALLLEDGERENTRIES.LIST>', taxEntry('CGST', '18.00') + taxEntry(other, '18.00'))));
  const { daybook, preview } = exchange(book), rates = findNodes(parseTallyXml(daybook), 'RATEDETAILS');
  assert.deepEqual(rates.map(node => [value(node, 'GSTRATEDUTYHEAD'), value(node, 'GSTRATE')]), [['Central Tax', '9.00'], [territory ? 'UT Tax' : 'State Tax', '9.00']]);
  const after = promote(preview, territory ? 'UT' : 'SPLT');
  assert.equal(after.vouchers[0].gst.totals.cgstPaise, 1800); assert.equal(after.vouchers[0].gst.totals[other.toLowerCase() + 'Paise'], 1800);
  assert.deepEqual(postings(after), postings(book));
});

test('repeated source items retain original invoice line grouping and are not duplicated by identical exports', () => {
  const book = promote(input(text => {
    const entry = text.match(/<ALLINVENTORYENTRIES.LIST>[\s\S]*?<\/ALLINVENTORYENTRIES.LIST>/)[0];
    return text.replace(entry, entry + entry).replace('<AMOUNT>236.00</AMOUNT>', '<AMOUNT>472.00</AMOUNT>').replace('<AMOUNT>-200.00</AMOUNT></ALLLEDGERENTRIES.LIST>', '<AMOUNT>-400.00</AMOUNT></ALLLEDGERENTRIES.LIST>').replace('<AMOUNT>-36.00</AMOUNT>', '<AMOUNT>-72.00</AMOUNT>');
  }));
  const { daybook, masters } = exchange(book);
  assert.equal(findNodes(parseTallyXml(daybook), 'ALLINVENTORYENTRIES').length, 2);
  const preview = previewTally([source('Masters.xml', masters), source('DayBook.xml', daybook), source('Same-DayBook.xml', daybook)], { companyName: 'Deduped purchase', booksFrom: '2026-04-01' });
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues)); assert.equal(preview.vouchers.length, 1);
  const after = promote(preview, 'REP');
  assert.equal(after.vouchers[0].gst.items.length, 2); assert.equal(after.company.stock.journals.length, 1);
  assert.equal(stockState(after.company, after.vouchers, { to: '2026-04-30' }).items[0].quantity, '6');
  assert.equal(after.vouchers[0].gst.totals.taxablePaise, 40000); assert.deepEqual(postings(after), postings(book));
});

test('raw supplier reference casing and unverified portal references remain distinguishable', () => {
  const book = promote(input(text => text.replace('<REFERENCE>INV/3103</REFERENCE>', '<REFERENCE>inv/3103</REFERENCE><IRN>raw-source-only-irn</IRN><IRNACKNO>123456789012345</IRNACKNO>')));
  const { daybook, preview } = exchange(book), node = findNodes(parseTallyXml(daybook), 'VOUCHER')[0];
  assert.equal(value(node, 'REFERENCE'), 'inv/3103');
  assert.equal(value(node, 'IRN'), ''); assert.equal(value(node, 'IRNACKNO'), '');
  assert.equal(book.vouchers[0].gst.tallyOrigin.source.transport.IRN, 'raw-source-only-irn');
  assert.equal(book.vouchers[0].gst.tallyOrigin.sourceReferenceStatus, 'source-unverified');
  assert.equal(promote(preview, 'CASE').vouchers[0].gst.supplierInvoiceNumber, 'INV/3103');
});

test('source ledger credit defaults retain their reconciled bill due date in matching exchange', () => {
  const withoutTerm = bill.replace('<BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD>', '');
  const book = promote(input(text => addPartyAllocation(text.replace('<PARENT>Sundry Creditors</PARENT>', '<PARENT>Sundry Creditors</PARENT><BILLCREDITPERIOD>45 Days</BILLCREDITPERIOD>'), withoutTerm)));
  const { daybook, preview } = exchange(book);
  assert.equal(value(findNodes(parseTallyXml(daybook), 'BILLALLOCATIONS')[0], 'DUEDATE'), '20260517');
  assert.equal(preview.company.reconciliation.bills[0].dueDate, '2026-05-17');
});

test('source bill edits and split purchase-account postings require the exact archive fallback', () => {
  const changedBill = promote(input(text => addPartyAllocation(text, bill)));
  changedBill.company.reconciliation.bills[0].dueDate = '2026-05-03';
  assert.throws(() => exportTallyDayBook(changedBill.company, changedBill.vouchers, '2026-04-01', '2026-04-30'), /unchanged activated source New Ref bill.*full source archive/);
  const split = promote(input(text => text.replace('<ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchase</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-200.00</AMOUNT></ALLLEDGERENTRIES.LIST>', '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchase</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-100.00</AMOUNT></ALLLEDGERENTRIES.LIST>'.repeat(2))));
  assert.throws(() => exportTallyDayBook(split.company, split.vouchers, '2026-04-01', '2026-04-30'), /split source purchase-account postings.*full source archive/);
});

test('nonparty source bill allocations are never silently dropped behind the inventory allocation', () => {
  const book = promote(input(text => text.replace('<AMOUNT>-200.00</AMOUNT></ALLLEDGERENTRIES.LIST>', '<AMOUNT>-200.00</AMOUNT><BILLALLOCATIONS.LIST><NAME>NONPARTY</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-200.00</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>')));
  assert.throws(() => exportTallyDayBook(book.company, book.vouchers, '2026-04-01', '2026-04-30'), /unrepresented source bill allocation.*full source archive/);
});

test('readable source bill credit periods preserve supported Tally date attributes', () => {
  const book = promote(input(text => addPartyAllocation(text, bill.replace('<BILLCREDITPERIOD>', '<BILLCREDITPERIOD JD="46202" P="30 Days">'))));
  const { daybook, preview } = exchange(book), term = findNodes(parseTallyXml(daybook), 'BILLCREDITPERIOD')[0];
  assert.equal(attribute(term, 'JD'), '46202'); assert.equal(attribute(term, 'P'), '30 Days');
  assert.equal(term.text, '30 Days'); assert.equal(preview.company.reconciliation.bills[0].dueDate, '2026-05-02');
});


test('report-only Purchase export cannot manufacture physical stock from its billed quantity', () => {
  const book = promote(input(text => text.replace('<ACTUALQTY>3 nos</ACTUALQTY>', '')), 'RPT', '2026-03-31', 'report-only');
  assert.equal(book.company.stock.journals.length, 0);
  assert.throws(() => exportTallyDayBook(book.company, book.vouchers, '2026-04-01', '2026-04-30'), /represented source receipt.*full source archive/);
  assert.equal(book.company.stock.journals.length, 0);
  assert.deepEqual(restoreTallyArchive(archive(book)).vouchers, book.vouchers);
});
