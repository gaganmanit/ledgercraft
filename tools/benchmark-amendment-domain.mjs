// Synthetic, fully replayed books; no production data or source-validation bypass.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/store.js';
import { gstinCheckDigit } from '../lib/gst.js';
import { buildOutwardAmendment, assertOutwardAmendments, outwardAmendmentState, outwardDocumentSnapshot } from '../lib/gst-outward-amendments.js';
import { returnWorkbook } from '../lib/gst-returns.js';
import { directoryEntries } from '../lib/hsn-directory.js';
import { validateTransfer, companyBackup } from '../lib/transfer.js';
import { start } from '../server.js';

const scratch = await mkdtemp(path.join(tmpdir(), 'financer-amendment-benchmark-'));
const output = process.argv[2] || path.resolve('output/amendment-domain-review.json');
const gstin = prefix => prefix + gstinCheckDigit(prefix);
const measure = async (name, fn, samples = 3) => {
  const durations = []; let result;
  for (let index = 0; index < samples; index++) { const begin = performance.now(); result = await fn(); durations.push(Math.round((performance.now() - begin) * 10) / 10); }
  return { name, samplesMs: durations, medianMs: [...durations].sort((a, b) => a - b)[Math.floor(samples / 2)], result };
};
let server;
try {
  const store = createStore(scratch);
  const created = await store.create({ name: 'Public amendment review benchmark', booksFrom: '2026-04-01' });
  const id = created.company.id;
  const { registration } = await store.saveGstMaster(id, 'registration', { name: 'Public registration', gstin: gstin('23ABCDE1234F1Z'), stateCode: '23', address: 'Synthetic address' });
  const { party } = await store.saveGstMaster(id, 'party', { name: 'Public buyer', kind: 'customer', gstin: gstin('23LMNOP1234Q1Z'), stateCode: '23', address: 'Synthetic buyer' });
  const { item } = await store.saveGstMaster(id, 'item', { name: 'Public goods', kind: 'goods', hsnSac: '85414090', unit: 'NOS', gstRateBps: 1800, pricePaise: 1000, openingQuantity: '5000' });
  const posted = await store.passGstInvoice(id, { type: 'Sales', date: '2026-04-10', registrationId: registration.id, partyId: party.id, placeOfSupply: '23', items: [{ itemId: item.id, quantity: '1' }] });
  const { company } = await store.get(id);
  company.stock = { version: 1, integrateAccounts: false, items: { [item.id]: { costingMethod: 'fifo', openingValuePaise: 5000000 } } };
  const vouchers = Array.from({ length: 5000 }, (_, index) => {
    const voucher = structuredClone(posted.voucher);
    voucher.id = `v-benchmark-${String(index).padStart(6, '0')}`;
    voucher.number = `B${String(index).padStart(6, '0')}`;
    voucher.gst = { ...voucher.gst, id: voucher.id, voucherId: voucher.id, number: voucher.number, requestId: null };
    return voucher;
  });
  company.gst.outwardAmendments = { version: 1, revision: 0, records: [] };
  for (let index = 0; index < 500; index++) {
    const invoice = vouchers[index].gst;
    const prior = outwardDocumentSnapshot(invoice, vouchers);
    prior.number = 'old' + invoice.number;
    for (const row of prior.rates) for (const key of ['taxablePaise', 'igstPaise', 'cgstPaise', 'sgstPaise', 'utgstPaise', 'cessPaise']) row[key] *= 2;
    prior.invoiceValuePaise *= 2;
    for (const row of prior.hsnRows) { row.quantity = '2'; for (const key of ['taxablePaise', 'totalPaise', 'igstPaise', 'cgstPaise', 'sgstPaise', 'utgstPaise', 'cessPaise']) row[key] *= 2; }
    const input = { invoiceId: invoice.id, revision: index, requestId: `public-benchmark-${String(index).padStart(8, '0')}`, date: '2026-06-01', filingDate: '2026-06-11', originalPeriod: '2026-04', amendmentPeriod: '2026-05', originalReported: prior,
      originalFiling: { form: 'GSTR-1', reference: 'PUBLIC-APRIL-RETURN', filedDate: '2026-05-11', confirmedFiled: true }, evidence: { accurateBooksConfirmed: true, reportedSnapshotConfirmed: true, basis: 'Synthetic mistaken filed figures', documentReference: 'PUBLIC-RECONCILIATION' }, annualReturnStatus: 'not-filed' };
    const preview = buildOutwardAmendment(company, vouchers, input, { preview: true });
    const result = buildOutwardAmendment(company, vouchers, { ...input, previewHash: preview.previewHash });
    company.gst.outwardAmendments.records.push(result.record); company.gst.outwardAmendments.revision = result.revision;
  }
  // Validate the real complete books once before timing; errors must not be timed as successes.
  validateTransfer(companyBackup(company, vouchers));
  const directory = await directoryEntries();
  const metrics = [];
  let measured = await measure('assertOutwardAmendments', () => assertOutwardAmendments(company, vouchers));
  assert.equal(measured.result, true); delete measured.result; metrics.push(measured);
  measured = await measure('outwardAmendmentState', () => outwardAmendmentState(company, vouchers, { registrationId: registration.id, month: '2026-05' }));
  assert.equal(measured.result.documents.length, 5000); assert.equal(measured.result.periodRecords.length, 500);
  measured.responseBytes = Buffer.byteLength(JSON.stringify(measured.result)); delete measured.result; metrics.push(measured);
  measured = await measure('outwardAmendmentState mode=desk', () => outwardAmendmentState(company, vouchers, { registrationId: registration.id, month: '2026-05', mode: 'desk' }));
  assert.equal(measured.result.documents.length, 50); assert.equal(measured.result.documentPage.total, 5000);
  assert.equal(measured.result.historyPage.total, 500); assert.ok(measured.result.records.length <= 21); assert.ok(measured.result.selected.actual);
  measured.responseBytes = Buffer.byteLength(JSON.stringify(measured.result)); delete measured.result; metrics.push(measured);
  for (const month of ['2026-04', '2026-05']) {
    measured = await measure('returnWorkbook ' + month, () => returnWorkbook(company, vouchers, registration.id, month, directory));
    assert.equal(measured.result.month, month);
    if (month === '2026-05') assert.equal(measured.result.sheets.b2ba.length, 500);
    measured.responseBytes = Buffer.byteLength(JSON.stringify(measured.result)); delete measured.result; metrics.push(measured);
  }
  const folder = path.join(scratch, 'companies', id);
  await writeFile(path.join(folder, 'company.json'), JSON.stringify(company));
  await writeFile(path.join(folder, 'vouchers.json'), JSON.stringify(vouchers));
  server = await start({ port: 0, dataDir: scratch });
  const base = `http://127.0.0.1:${server.address().port}/api/companies/${id}`;
  for (const [name, url] of [ ['GET amendments mode=desk', `${base}/gst/amendments?mode=desk&registration=${registration.id}&month=2026-05`], ['GET amendments', `${base}/gst/amendments?registration=${registration.id}&month=2026-05`], ['GET April returns', `${base}/gst-returns?registration=${registration.id}&month=2026-04`], ['GET May returns', `${base}/gst-returns?registration=${registration.id}&month=2026-05`] ]) {
    measured = await measure(name, async () => { const response = await fetch(url); const raw = await response.text(); assert.equal(response.status, 200, raw.slice(0, 1000)); const data = JSON.parse(raw); return { bytes: Buffer.byteLength(raw), count: data.documents?.length || data.sheets?.b2ba?.length || 0 }; });
    measured.responseBytes = measured.result.bytes; delete measured.result; metrics.push(measured);
  }
  const receipt = { documents: vouchers.length, corrections: company.gst.outwardAmendments.records.length, source: 'isolated synthetic valid company, standard store/server/report/restore paths', metrics };
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally { if (server) await new Promise(done => server.close(done)); await rm(scratch, { recursive: true, force: true }); }
