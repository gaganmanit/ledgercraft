import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNative } from './native-command.mjs';
import { createStore } from '../lib/store.js';
import { start } from '../server.js';
import { gstinCheckDigit } from '../lib/gst.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(path.join(tmpdir(), 'financer-rcm-native-'));
const output = path.resolve(process.argv[2] || path.join(root, 'output', 'rcm-native-proof'));
await mkdir(output, { recursive: true });
const run = args => runNative(args, root);
let server;
try {
  const executable = path.join(scratch, 'financer-rcm-ui');
  await run(['/usr/bin/swiftc', '-swift-version', '5', path.join(root, 'test/gst-rcm-ui.swift'), '-o', executable]);
  const store = createStore(path.join(scratch, 'data'));
  const { company } = await store.create({ name: 'Public RCM Native UI Test', booksFrom: '2026-04-01' });
  const prefix = '23ABCDE1234F1Z';
  const registration = (await store.saveGstMaster(company.id, 'registration', { name: 'Synthetic RCM Recipient', legalName: 'Synthetic RCM Recipient', gstin: prefix + gstinCheckDigit(prefix), stateCode: '23', address: 'Public test address', pincode: '462001' })).registration;
  const party = (await store.saveGstMaster(company.id, 'party', { name: 'Synthetic RCM Supplier', kind: 'supplier', gstin: '', stateCode: '23', address: 'Public supplier test address' })).party;
  const item = (await store.saveGstMaster(company.id, 'item', { name: 'Synthetic RCM Service', kind: 'service', hsnSac: '998599', unit: 'NOS', gstRateBps: 1800, cessRateBps: 0, pricePaise: 10000, purchasePricePaise: 10000, supplyStatus: 'taxable' })).item;
  server = await start({ port: 0, dataDir: path.join(scratch, 'data') });
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = path.join(scratch, 'fixture.json');
  await writeFile(config, JSON.stringify({ base, company: company.id, party: party.id, item: item.id, output }));
  await run([executable, config]);
  const state = await (await fetch(`${base}/api/companies/${company.id}/gst/rcm?to=2026-04-30`)).json();
  assert.equal(state.documents.length, 1);
  assert.equal(state.documents[0].claimed.cgstPaise, 450);
  assert.equal(state.documents[0].claimed.sgstPaise, 450);
  assert.equal(state.documents[0].paid.cgstPaise, 900);
  assert.equal(state.records.length, 5);
  assert.equal(state.records.find(record => record.action === 'itc-reversal').reversalReason, 'temporary-reversal');
  await writeFile(path.join(output, 'native-rcm-result.json'), JSON.stringify({ passed: true, backend: 'isolated synthetic books', browser: 'macOS WKWebView', actions: state.records.map(record => record.action), taxPaidPaise: 1800, netClaimedPaise: 900, paymentVoucherPdf: 'rcm-payment-voucher.pdf', screenshot: 'rcm-payment-voucher-native.png' }, null, 2));
  console.log(`Native RCM proof saved to ${output}`);
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
