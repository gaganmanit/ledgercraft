import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { parseTallyXml, tallyRecords, children, value } from '../lib/tally-format.js';
import { tallyGstFactIndex, sourceTaxFacts } from '../lib/tally-gst-facts.js';
import { gstinCheckDigit } from '../lib/gst.js';
import { readTallyZip } from '../lib/tally-zip.js';
import { parseTallyXlsx, tallyXlsxRows } from '../lib/tally-xlsx.js';
import { workbookReferences, workbookBasis } from '../lib/tally-workbook-references.js';
import { previewTally, restoreTallyArchive } from '../lib/tally-import.js';

const gstin = (state, pan = 'ABCDE1234F') => { const prefix = `${state}${pan}1Z`; return prefix + gstinCheckDigit(prefix); };
const buyer = gstin('23'), supplier = gstin('27', 'PQRST5678L');
const recordsOf = tree => tallyRecords(tree).map((record, index) => ({ ...record, recordId: `r-${index}`, file: 'synthetic-purchase.xml' }));
const sourceItems = [{ sourceName: 'Widget' }];
const rate = (state, percent, from = '20230401') => `<GSTDETAILS.LIST><APPLICABLEFROM>${from}</APPLICABLEFROM><TAXABILITY>Taxable</TAXABILITY><SUPPLYTYPE>Goods</SUPPLYTYPE><STATEWISEDETAILS.LIST><STATENAME>${state}</STATENAME><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE><GSTRATE>${percent}</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>`;
function native({ type = 'Purchase', voucherFields = '', partyFields = `<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20230401</APPLICABLEFROM><GSTREGISTRATIONNUMBER>${supplier}</GSTREGISTRATIONNUMBER></LEDGSTREGDETAILS.LIST>`, companyFields = `<GSTREGISTRATIONDETAILS.LIST><APPLICABLEFROM>20230401</APPLICABLEFROM><GSTREGISTRATIONNUMBER>${buyer}</GSTREGISTRATIONNUMBER></GSTREGISTRATIONDETAILS.LIST>`, stockFields = '' } = {}) {
  const tree = parseTallyXml(`<ENVELOPE><TALLYMESSAGE><COMPANY NAME="Buyer">${companyFields}</COMPANY><LEDGER NAME="Supplier"><PARENT>Sundry Creditors</PARENT>${partyFields}</LEDGER><STOCKITEM NAME="Widget">${stockFields}</STOCKITEM><VOUCHER VCHTYPE="${type}"><DATE>20230412</DATE><VOUCHERNUMBER>1520</VOUCHERNUMBER><REFERENCE>SUP/007</REFERENCE><REFERENCEDATE>20230408</REFERENCEDATE><PARTYLEDGERNAME>Supplier</PARTYLEDGERNAME>${voucherFields}<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Widget</STOCKITEMNAME></ALLINVENTORYENTRIES.LIST></VOUCHER></TALLYMESSAGE></ENVELOPE>`);
  const records = recordsOf(tree), record = records.find(row => row.type === 'VOUCHER');
  return { records, record, index: tallyGstFactIndex(records) };
}

test('Purchase selects purchasing company as buyer and dated creditor registration as supplier', () => {
  const book = native({ partyFields: `<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20230401</APPLICABLEFROM><GSTREGISTRATIONNUMBER>${supplier}</GSTREGISTRATIONNUMBER></LEDGSTREGDETAILS.LIST><LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20230410</APPLICABLEFROM><GSTREGISTRATIONNUMBER>${gstin('29')}</GSTREGISTRATIONNUMBER></LEDGSTREGDETAILS.LIST>` });
  const facts = sourceTaxFacts(book.index, book.record, '2023-04-08', sourceItems, '23');
  assert.equal(facts.sellerGstin.value, supplier);
  assert.equal(facts.buyerGstin.value, buyer);
  assert.match(facts.sellerGstin.evidence[0].fieldPath, /LEDGER\/LEDGSTREGDETAILS\[0\]\/GSTREGISTRATIONNUMBER/);
  assert.equal(facts.sellerGstin.evidence[0].effectiveFrom, '2023-04-01');
  assert.ok(facts.sellerGstin.superseded.some(proof => proof.effectiveFrom === '2023-04-10' && proof.reason === 'future-effective'));
  assert.equal(value(book.record.node, 'VOUCHERNUMBER'), '1520');
  assert.equal(value(book.record.node, 'REFERENCE'), 'SUP/007');
  const sales = native({ type: 'Sales' });
  const saleFacts = sourceTaxFacts(sales.index, sales.record, '2023-04-12', sourceItems, '23');
  assert.equal(saleFacts.sellerGstin.value, buyer);
  assert.equal(saleFacts.buyerGstin.value, supplier);
});

test('Purchase voucher overrides retain supplier-document date and exact source field proof', () => {
  const book = native({ voucherFields: `<CMPGSTIN>${buyer}</CMPGSTIN><PARTYGSTIN>${supplier}</PARTYGSTIN>` });
  const facts = sourceTaxFacts(book.index, book.record, '2023-04-08', sourceItems, '23');
  assert.equal(facts.sellerGstin.value, supplier);
  assert.equal(facts.buyerGstin.value, buyer);
  assert.match(facts.sellerGstin.evidence[0].fieldPath, /VOUCHER\/PARTYGSTIN/);
  assert.match(facts.buyerGstin.evidence[0].fieldPath, /VOUCHER\/CMPGSTIN/);
  assert.equal(facts.sellerGstin.evidence[0].effectiveFrom, '2023-04-08');
  assert.match(facts.sellerGstin.evidence[0].effectiveFieldPath, /REFERENCEDATE/);
  assert.equal(facts.sellerGstin.evidence[0].effectiveBasis, 'document-date');
});

test('Purchase state-specific rate uses supplier state, correction or source state rather than buyer state', () => {
  const stockFields = rate('Maharashtra', 18).replace('</GSTDETAILS.LIST>', [rate('Madhya Pradesh', 5), rate('Karnataka', 12)].map(text => text.match(/<STATEWISEDETAILS[\s\S]*<\/STATEWISEDETAILS.LIST>/)[0]).join('') + '</GSTDETAILS.LIST>');
  const book = native({ stockFields });
  assert.equal(sourceTaxFacts(book.index, book.record, '2023-04-08', sourceItems, '23').items[0].gstRateBps.value, 1800);
  const corrected = sourceTaxFacts(book.index, book.record, '2023-04-08', sourceItems, '23', true, { direction: 'purchase', supplierState: '29' });
  assert.equal(corrected.items[0].gstRateBps.value, 1200);
  const noGstin = native({ stockFields, partyFields: '<LEDSTATENAME>Maharashtra</LEDSTATENAME>' });
  assert.equal(sourceTaxFacts(noGstin.index, noGstin.record, '2023-04-08', sourceItems, '23').items[0].gstRateBps.value, 1800);
  const absent = native({ stockFields, partyFields: '' });
  const absentFacts = sourceTaxFacts(absent.index, absent.record, '2023-04-08', sourceItems, '23');
  assert.equal(absentFacts.sellerGstin.status, 'absent');
  assert.equal(absentFacts.items[0].gstRateBps.status, 'conflict');
});

// Store-only ZIP writer keeps this source-level regression independent of third-party XLSX writers.
function zip(entries) {
  const parts = [], directory = []; let offset = 0;
  for (const [name, bytes] of entries) {
    const filename = Buffer.from(name), header = Buffer.alloc(30), central = Buffer.alloc(46), crc = crc32(bytes);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    parts.push(header, filename, bytes); directory.push(central, filename); offset += header.length + filename.length + bytes.length;
  }
  const end = Buffer.alloc(22), central = Buffer.concat(directory); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
async function purchaseWorkbook(referenceDate = '2023-04-08T00:00:00.000Z') {
  const outer = readTallyZip(await readFile(new URL('fixtures/tally-xlsx/Tally-Sales-GST-Template.zip', import.meta.url)));
  const entries = readTallyZip([...outer.values()][0]);
  const headers = ['Voucher Date', 'Voucher Type Name', 'Voucher Number', 'Ledger Name', 'Ledger Amount', 'Ledger Amount Dr/Cr', 'Reference No.', 'Reference Date', 'Company GSTIN', 'Buyer/Supplier - GSTIN/UIN'];
  const rows = [headers, ['2023-04-12', 'Purchase', '1520', 'Supplier', '118', 'Cr', 'SUP/007', referenceDate, buyer, supplier], ['', '', '', 'Purchases', '100', 'Dr'], ['', '', '', 'IGST', '18', 'Dr']];
  const sheet = `<worksheet><sheetData>${rows.map((cells, i) => `<row r="${i + 1}">${cells.map((text, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${escape(text)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const path = [...entries.keys()].find(name => /worksheets\/sheet1\.xml$/.test(name)); entries.set(path, Buffer.from(sheet));
  return zip(entries);
}

test('Purchase XLSX preserves supplier reference separately, interprets its date and retains original cells', async () => {
  const bytes = await purchaseWorkbook(), parsed = parseTallyXlsx(bytes), records = recordsOf(parsed.tree).map(record => ({ ...record, sourceFormat: 'xlsx' }));
  assert.equal(parsed.issues.filter(issue => issue.severity === 'blocking').length, 0, JSON.stringify(parsed.issues));
  const record = records.find(row => row.type === 'VOUCHER');
  assert.equal(value(record.node, 'VOUCHERNUMBER'), '1520'); assert.equal(value(record.node, 'DATE'), '20230412');
  assert.equal(value(record.node, 'REFERENCE'), 'SUP/007'); assert.equal(value(record.node, 'REFERENCEDATE'), '2023-04-08T00:00:00.000Z');
  assert.equal(tallyXlsxRows(record.node)[0].cells.find(cell => cell.header === 'Reference Date').value, '2023-04-08T00:00:00.000Z');
  const facts = sourceTaxFacts(tallyGstFactIndex(records), record, '2023-04-08', []);
  assert.equal(facts.sellerGstin.value, supplier); assert.equal(facts.buyerGstin.value, buyer);
  assert.match(facts.buyerGstin.evidence[0].fieldPath, /^XLSX:/);
  const references = workbookReferences(records), basis = workbookBasis(records, references, [{ id: 'g-creditors' }, { id: 'g-purchase' }, { id: 'g-duties' }], {});
  assert.equal(basis.rows.find(row => row.sourceName === 'Supplier').groupId, 'g-creditors');
  assert.equal(basis.rows.find(row => row.sourceName === 'Purchases').groupId, 'g-purchase');
  assert.deepEqual(basis.stored, { version: 1, accountGroupMappings: {}, useBilledAsActual: false });
  assert.equal(basis.gstReadiness.sourcePurchases, 1); assert.equal(basis.gstReadiness.purchaseTaxPaise, 1800);
  assert.equal(basis.gstReadiness.sourceSales, 0); assert.equal(basis.gstReadiness.taxPaise, 0);
  assert.ok(children(record.node, 'ALLLEDGERENTRIES').every(entry => value(entry, 'ISDEEMEDPOSITIVE') === (value(entry, 'LEDGERNAME') === 'Supplier' ? 'No' : 'Yes')));
});

test('Purchase XLSX with a non-midnight reference date needs source review', async () => {
  const parsed = parseTallyXlsx(await purchaseWorkbook('2023-04-08T12:00:00.000Z'));
  const records = recordsOf(parsed.tree), record = records.find(row => row.type === 'VOUCHER');
  record.node.children.push({ tag: 'PARTYGSTIN', attrs: {}, text: supplier, children: [] });
  const facts = sourceTaxFacts(tallyGstFactIndex(records), record, '2023-04-08', []);
  assert.equal(facts.sellerGstin.status, 'conflict');
  assert.ok(facts.sellerGstin.issues.some(issue => /effective date/.test(issue)));
});

test('existing v1 Sales workbook basis survives archive restore unchanged', async () => {
  const bytes = await readFile(new URL('fixtures/tally-xlsx/Tally-Sales-GST-Template.zip', import.meta.url));
  const preview = previewTally([{ name: 'Tally-Sales-GST-Template.zip', base64: bytes.toString('base64') }], { companyName: 'Public existing v1 archive', booksFrom: '2023-04-01', useBilledAsActual: false });
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
  const basis = structuredClone(preview.company.tallyWorkbook);
  assert.deepEqual(Object.keys(basis).sort(), ['accountGroupMappings', 'openingScope', 'overlapChoices', 'useBilledAsActual', 'version']);
  assert.equal(basis.version, 1);
  assert.equal(Object.hasOwn(basis, 'gstReadiness'), false);
  const restored = restoreTallyArchive({ format: 'financer-tally-archive', version: 1, company: preview.company, vouchers: preview.vouchers, records: preview.records, sources: preview.sources, sourceBookHash: null });
  assert.deepEqual(restored.company.tallyWorkbook, basis);
});


test('v1 mixed workbook archive retains accounting-only Purchase without requiring GST or stock evidence', async () => {
  const sale = await readFile(new URL('fixtures/tally-xlsx/Tally-Sales-GST-Template.zip', import.meta.url));
  const purchase = await purchaseWorkbook();
  const preview = previewTally([{ name: 'sales.zip', base64: sale.toString('base64') }, { name: 'purchase.xlsx', base64: purchase.toString('base64') }], { companyName: 'Public v1 mixed archive', booksFrom: '2023-04-01', useBilledAsActual: false });
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
  assert.equal(preview.vouchers.filter(voucher => voucher.type === 'Purchase').length, 1);
  assert.ok(preview.vouchers.every(voucher => !voucher.gst));
  const original = structuredClone(preview.company.tallyWorkbook);
  assert.equal(original.version, 1); assert.equal(Object.hasOwn(original, 'gstReadiness'), false);
  const restored = restoreTallyArchive({ format: 'financer-tally-archive', version: 1, company: preview.company, vouchers: preview.vouchers, records: preview.records, sources: preview.sources, sourceBookHash: null });
  assert.deepEqual(restored.company.tallyWorkbook, original);
  assert.deepEqual(restored.vouchers, preview.vouchers);
});

test('explicitly reviewed supplier date selects rate cutoff while retaining the invalid raw date evidence', () => {
  const book = native({ voucherFields: `<CMPGSTIN>${buyer}</CMPGSTIN><PARTYGSTIN>${supplier}</PARTYGSTIN>`, stockFields: rate('Maharashtra', 18) + rate('Maharashtra', 12, '20230410') });
  book.record.node.children.find(node => node.tag === 'REFERENCEDATE').text = '2023-04-08T12:00:00.000Z';
  const index = tallyGstFactIndex(book.records);
  const unreviewed = sourceTaxFacts(index, book.record, '2023-04-08', sourceItems, '23');
  assert.equal(unreviewed.sellerGstin.status, 'conflict');
  const early = sourceTaxFacts(index, book.record, '2023-04-08', sourceItems, '23', false, { direction: 'purchase', documentDate: '2023-04-08' });
  assert.equal(early.sellerGstin.value, supplier); assert.equal(early.buyerGstin.value, buyer);
  assert.equal(early.items[0].gstRateBps.value, 1800);
  assert.ok(early.items[0].gstRateBps.superseded.some(proof => proof.effectiveFrom === '2023-04-10' && proof.reason === 'future-effective'));
  const proof = early.sellerGstin.evidence[0];
  assert.equal(proof.effectiveSourceValue, '2023-04-08T12:00:00.000Z');
  assert.match(proof.effectiveFieldPath, /REFERENCEDATE/);
  assert.equal(proof.effectiveFrom, '2023-04-08'); assert.equal(proof.reviewedDocumentDate, '2023-04-08');
  assert.equal(proof.effectiveBasis, 'reviewed-document-date');
  const boundary = sourceTaxFacts(index, book.record, '2023-04-10', sourceItems, '23', false, { direction: 'purchase', documentDate: '2023-04-10' });
  assert.equal(boundary.items[0].gstRateBps.value, 1200);
  assert.equal(value(book.record.node, 'REFERENCEDATE'), '2023-04-08T12:00:00.000Z');
  const rawAfterReview = sourceTaxFacts(index, book.record, '2023-04-08', sourceItems, '23');
  assert.equal(rawAfterReview.sellerGstin.status, 'conflict', 'Review scope must not leak through the shared fact index');
});
