// GSTR-1 upload JSON: amendment sections (9A/9C) and original-period reported rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCreditReview } from '../lib/gst-credit-review.js';
import { gstinCheckDigit } from '../lib/gst.js';
import { buildOutwardAmendment, outwardDocumentSnapshot } from '../lib/gst-outward-amendments.js';
import { returnWorkbook, columns } from '../lib/gst-returns.js';
import { gstr1Export, gstr1Json } from '../lib/gst-json.js';

const gstin = prefix => prefix + gstinCheckDigit(prefix);
const registration = { id: 'reg', name: 'Synthetic registration', gstin: gstin('23ABCDE1234F1Z'), stateCode: '23' };
const heads = ['taxablePaise','igstPaise','cgstPaise','sgstPaise','utgstPaise','cessPaise','totalPaise'];
let sequence = 0;
function fixture() { return { company: { id: 'synthetic-json-amendments', booksFrom: '2026-04-01', ledgers: [], gst: { registrations: [registration] } }, vouchers: [] }; }
function document(f, number, changes = {}, taxable = 20000) {
  const id = number.toLowerCase().replaceAll('/', '-');
  const inter = changes.placeOfSupply !== '23';
  const withoutTax = changes.exportMode === 'lut';
  const items = [500, 1800].map((rate, index) => {
    const amount = taxable / 2, tax = withoutTax ? 0 : amount * rate / 10000;
    return { itemId: 'item-' + index, kind: 'goods', name: 'Synthetic goods', hsnSac: index ? '85414090' : '010121', unit: 'NOS', quantity: '1', gstRateBps: rate,
      supplyStatus: changes.supplyCategory && changes.supplyCategory !== 'domestic' ? 'zero-rated' : 'taxable', taxablePaise: amount,
      igstPaise: inter ? tax : 0, cgstPaise: inter ? 0 : tax / 2, sgstPaise: inter ? 0 : tax / 2, utgstPaise: 0, cessPaise: 0, taxPaise: tax, totalPaise: amount + tax };
  });
  const totals = Object.fromEntries([...heads, 'taxPaise'].map(key => [key, items.reduce((sum, row) => sum + row[key], 0)]));
  const invoice = { id, voucherId: id, number, date: '2026-04-10', type: 'Sales', direction: 'sales', registrationId: registration.id, registration,
    party: { name: 'Synthetic customer', gstin: gstin('27LMNOP1234Q1Z') }, placeOfSupply: '27', supplyCategory: 'domestic', reverseCharge: false,
    stockEffect: 'quantity', items, totals, ...changes };
  f.vouchers.push({ id, date: invoice.date, type: invoice.type, number: invoice.number, gst: invoice, lines: [] });
  return invoice;
}
function priorFor(f, invoice, factor = .5) {
  const prior = structuredClone(outwardDocumentSnapshot(invoice, f.vouchers));
  prior.number = '0001'; prior.date = '2026-04-09'; prior.invoiceValuePaise *= factor;
  for (const row of prior.rates) for (const key of heads.filter(key => key !== 'totalPaise')) row[key] *= factor;
  for (const row of prior.hsnRows) { for (const key of heads) row[key] *= factor; row.quantity = String(Number(row.quantity) * factor); }
  return prior;
}
function save(f, invoice) {
  if (invoice.type === 'Credit Note' && !invoice.originalInvoiceId) {
    const original = document(f, 'ORIGINAL/1', { date: invoice.originalDate });
    invoice.originalInvoiceId = original.id; invoice.originalNumber = original.number;
    f.company = applyCreditReview(f.company, f.vouchers, { invoiceId: invoice.id, revision: 0, requestId: 'synthetic-credit-review-' + invoice.id, declarationDate: '2026-06-11',
      annualReturnStatus: 'not-filed', recipientBasis: 'not-availed', adjustmentGround: 'excess-value-or-tax', groundConfirmed: true, reference: 'Synthetic recipient and credit calculation' }).company;
  }
  const input = { invoiceId: invoice.id, date: '2026-06-01', filingDate: '2026-06-11', amendmentPeriod: '2026-05', originalPeriod: '2026-04',
    revision: f.company.gst.outwardAmendments?.revision || 0, requestId: 'synthetic-json-' + String(++sequence).padStart(8, '0'),
    originalReported: priorFor(f, invoice), originalFiling: { form: 'GSTR-1', reference: 'SYNTHETIC-APRIL', filedDate: '2026-05-11', confirmedFiled: true },
    annualReturnStatus: 'not-filed', evidence: { basis: 'Synthetic reporting discrepancy', documentReference: 'SYNTHETIC-RECON', accurateBooksConfirmed: true, reportedSnapshotConfirmed: true } };
  input.previewHash = buildOutwardAmendment(f.company, f.vouchers, input, { preview: true }).previewHash;
  const result = buildOutwardAmendment(f.company, f.vouchers, input);
  f.company.gst.outwardAmendments ||= { version: 1, revision: 0, records: [], events: [] };
  f.company.gst.outwardAmendments.records.push(result.record); f.company.gst.outwardAmendments.revision = result.revision;
  return result.record;
}
function amendedBooks() {
  const f = fixture(), consumer = { name: 'Synthetic consumer', gstin: '' };
  const large = document(f, 'LARGE/1', { party: consumer }, 20000000);
  const documents = [document(f, 'B2B/1'), large,
    document(f, 'EXPORT/1', { party: consumer, supplyCategory: 'export', exportMode: 'igst', placeOfSupply: '96', portCode: 'INBOM1', shippingBillNumber: '0000123', shippingBillDate: '2026-04-10' }),
    document(f, 'CREDIT/1', { type: 'Credit Note', stockEffect: 'none', originalDate: '2026-04-01' }),
    document(f, 'UNREG/1', { party: consumer, type: 'Debit Note', stockEffect: 'none', originalInvoiceId: large.id })];
  for (const invoice of documents) save(f, invoice);
  return f;
}
const toPaise = n => Math.round(n * 100);
const sum = (list, field) => list.reduce((total, item) => total + toPaise(item[field] || 0), 0);
const sheetSum = (book, sheet, header) => book.sheets[sheet].reduce((total, row) => total + toPaise(Number(row[columns[sheet].indexOf(header)])), 0);
const details = docs => docs.flatMap(doc => doc.itms.map(item => item.itm_det || item));

test('GSTR-1 JSON writes the amendment sections with original and revised identities and the revised tax heads', () => {
  const f = amendedBooks();
  const book = returnWorkbook(f.company, f.vouchers, 'reg', '2026-05');
  const { json, summary } = gstr1Export(f.company, f.vouchers, 'reg', '2026-05');
  const docs = { b2ba: json.b2ba.flatMap(p => p.inv), b2cla: json.b2cla.flatMap(p => p.inv), cdnra: json.cdnra.flatMap(p => p.nt), cdnura: json.cdnura, expa: json.expa.flatMap(p => p.inv) };
  for (const [section, list] of Object.entries(docs)) {
    assert.equal(list.length, 1, section);
    assert.equal(sum(details(list), 'txval'), sheetSum(book, section, 'Taxable Value'), section);
    assert.equal(summary.sections[section].taxablePaise, sheetSum(book, section, 'Taxable Value'), section);
    assert.equal(summary.sections[section].documents, 1);
  }
  assert.deepEqual(json.b2ba, [{ ctin: gstin('27LMNOP1234Q1Z'), inv: [{ oinum: '0001', oidt: '09-04-2026', inum: 'B2B/1', idt: '10-04-2026', val: 223, pos: '27', rchrg: 'N', inv_typ: 'R',
    itms: [{ num: 1, itm_det: { rt: 5, txval: 100, iamt: 5, csamt: 0 } }, { num: 2, itm_det: { rt: 18, txval: 100, iamt: 18, csamt: 0 } }] }] }]);
  assert.equal(json.b2cla[0].pos, '27'); assert.equal(docs.b2cla[0].oinum, '0001'); assert.equal(docs.b2cla[0].inum, 'LARGE/1');
  assert.deepEqual(Object.keys(docs.cdnra[0]), ['ntty', 'ont_num', 'ont_dt', 'nt_num', 'nt_dt', 'val', 'pos', 'rchrg', 'inv_typ', 'itms']);
  assert.equal(docs.cdnra[0].ntty, 'C'); assert.equal(docs.cdnra[0].nt_num, 'CREDIT/1');
  assert.deepEqual([docs.cdnura[0].typ, docs.cdnura[0].ntty, docs.cdnura[0].ont_num, docs.cdnura[0].pos], ['B2CL', 'D', '0001', '27']);
  assert.equal(json.expa[0].exp_typ, 'WPAY');
  assert.deepEqual([docs.expa[0].sbpcode, docs.expa[0].sbnum, docs.expa[0].sbdt], ['INBOM1', '0000123', '10-04-2026']);
  assert.deepEqual(details(docs.expa), [{ txval: 100, rt: 5, iamt: 5, csamt: 0 }, { txval: 100, rt: 18, iamt: 18, csamt: 0 }]);
  assert.equal(json.b2b, undefined);
  // A workbook alone already carries the declared snapshots, so its amendment heads are identical.
  assert.deepEqual(gstr1Json(book), json);
});

test('the original return period reports the declared prior figures, not the posted documents', () => {
  const f = amendedBooks();
  const book = returnWorkbook(f.company, f.vouchers, 'reg', '2026-04');
  const json = gstr1Json(f.company, f.vouchers, 'reg', '2026-04');
  const b2b = json.b2b.flatMap(p => p.inv);
  const reported = b2b.find(doc => doc.inum === '0001');
  assert.deepEqual(reported.itms, [{ num: 1, itm_det: { rt: 5, txval: 50, iamt: 2.5, csamt: 0 } }, { num: 2, itm_det: { rt: 18, txval: 50, iamt: 9, csamt: 0 } }]);
  assert.equal(sum(details(b2b), 'txval'), sheetSum(book, 'b2b,sez,de', 'Taxable Value'));
  assert.equal(sum(details(json.exp.flatMap(p => p.inv)), 'iamt'), toPaise(11.5));
  assert.ok(!b2b.some(doc => doc.inum === 'B2B/1'));
  // Issued-document counts still follow the books.
  assert.equal(json.doc_issue.doc_det.flatMap(d => d.docs).reduce((n, r) => n + r.totnum, 0), book.sheets.docs.reduce((n, r) => n + r[3], 0));
});
