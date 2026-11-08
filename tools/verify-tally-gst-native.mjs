import assert from 'node:assert/strict';
import { runNative } from './native-command.mjs';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourceRoot=path.resolve(process.env.FINANCER_NATIVE_BOOK_RESOURCES||process.env.FINANCER_VERIFY_SOURCE||root);
const output=path.resolve(process.argv[2]||path.join(root,'output','tally-gst-native-proof'));
const scratch=await mkdtemp(path.join(tmpdir(),'financer-tally-gst-native-'));
await mkdir(output,{recursive:true});
const run=args=>runNative(args,root);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
let server;
try {
  const frozen=path.join(scratch,'source');await mkdir(frozen);
  for(const name of ['package.json','server.js','lib','public']) await cp(path.join(sourceRoot,name),path.join(frozen,name),{recursive:true});
  const {start}=await import(pathToFileURL(path.join(frozen,'server.js')));
  const {gstinCheckDigit}=await import(pathToFileURL(path.join(frozen,'lib/gst.js')));
  const makeGstin=stem=>stem+gstinCheckDigit(stem);
  const source=path.join(root,'test/fixtures/tally-xlsx/Tally-Sales-GST-Template.zip');
  const overlapXml='<ENVELOPE><TALLYMESSAGE><VOUCHER VCHTYPE="Sales"><GUID>synthetic-native-overlap-101</GUID><DATE>20230401</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>101</VOUCHERNUMBER><PARTYLEDGERNAME>National Traders</PARTYLEDGERNAME><NARRATION>Synthetic overlapping export to test explicit source review</NARRATION>'+[['National Traders','-3540','Yes'],['Sales','3000','No'],['Tax - CGST @ 9 %','270','No'],['Tax - SGST @ 9 %','270','No']].map(([name,amount,dr])=>`<ALLLEDGERENTRIES.LIST><LEDGERNAME>${name}</LEDGERNAME><AMOUNT>${amount}</AMOUNT><ISDEEMEDPOSITIVE>${dr}</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST>`).join('')+'</VOUCHER></TALLYMESSAGE></ENVELOPE>';
  const overlapSource=path.join(scratch,'Synthetic-overlap.xml');await writeFile(overlapSource,overlapXml);
  const supportingSource=path.join(root,'test','fixtures','tally-gst-support.xml');await readFile(supportingSource);
  const original=await readFile(source);
  assert.equal(digest(original),'957fe0f8c5ac9082b6fb02525f66b388d79a2977719359a0fa84628a73b9fc61');
  server=await start({dataDir:path.join(scratch,'data')});
  const base=`http://127.0.0.1:${server.address().port}`;
  const config=path.join(scratch,'fixture.json');
  await writeFile(config,JSON.stringify({base,source,overlapSource,supportingSource,output,sellerGstin:makeGstin('06ABCDE1234F1Z'),buyer0:makeGstin('06PQRST5678L1Z'),buyer1:makeGstin('06PQRST5678L2Z'),buyer2:makeGstin('07PQRST5678L3Z'),buyer3:makeGstin('07PQRST5678L4Z')}));
  const nativeSource=path.join(scratch,'tally-gst-ui.swift');await cp(path.join(root,'test/tally-gst-ui.swift'),nativeSource);
  const executable=path.join(scratch,'financer-tally-gst-ui');
  await run(['/usr/bin/swiftc','-swift-version','5',nativeSource,'-o',executable,'-framework','AppKit','-framework','WebKit']);
  await run([executable,config]);
  const native=JSON.parse(await readFile(path.join(output,'native-results.json'),'utf8'));
  const get=async route=>{const response=await fetch(base+route);const data=await response.json();assert.equal(response.ok,true,JSON.stringify(data));return data;};
  const saved=await get(`/api/companies/${native.company}`),restored=await get(`/api/companies/${native.restoredCompany}`);
  assert.equal(saved.vouchers.length,4);assert.equal(saved.vouchers.filter(v=>v.gst?.tallyOrigin).length,4);
  assert.equal(saved.vouchers.reduce((n,v)=>n+v.gst.items.length,0),10);
  assert.equal(saved.vouchers.reduce((n,v)=>n+v.gst.totals.taxablePaise,0),2720000);
  assert.equal(saved.vouchers.reduce((n,v)=>n+v.gst.totals.taxPaise,0),489600);
  assert.deepEqual(restored.vouchers,saved.vouchers);
  assert.deepEqual(restored.company.gst.tallyPromotion,saved.company.gst.tallyPromotion);
  assert.deepEqual(restored.company.stock,saved.company.stock);
  assert.deepEqual(await readFile(path.join(output,'source-original-1.zip')),original);
  const review=await get(`/api/tally/companies/${native.restoredCompany}/gst`);
  assert.equal(review.summary.active,4);assert.equal(review.summary.taxablePaise,2720000);assert.equal(review.summary.taxPaise,489600);
  const hashes={};for(const name of ['public/tally-tools.js','public/tally-tools.css','public/tally-gst-ui.js','public/tally-gst-ui.css','lib/tally-import.js','lib/tally-xlsx.js','lib/tally-gst.js'])hashes[name]=digest(await readFile(path.join(frozen,name)));
  await writeFile(path.join(output,'backend-results.json'),JSON.stringify({passed:true,packagedResources:Boolean(process.env.FINANCER_NATIVE_BOOK_RESOURCES),runtime:process.version,source:'TallyPrime public default GST sales workbook in intact official ZIP',sourceSHA256:digest(original),syntheticMissingMasterEvidence:true,vouchers:4,itemLines:10,taxablePaise:2720000,taxPaise:489600,restoredVoucherSnapshotsExact:true,restoredPromotionAuditExact:true,restoredStockExact:true,restoredSourceBytesExact:true,sourceSHA256ByFile:hashes},null,2));
  console.log(`Native Tally Excel/GST proof saved to ${output}`);
} finally {
  if(server){server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));}
  await rm(scratch,{recursive:true,force:true});
}
