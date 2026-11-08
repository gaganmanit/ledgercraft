import assert from 'node:assert/strict';
import {runNative} from './native-command.mjs';
import {createHash} from 'node:crypto';
import {cp,mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourceRoot=path.resolve(process.env.LEDGERCRAFT_NATIVE_BOOK_RESOURCES||process.env.FINANCER_NATIVE_BOOK_RESOURCES||root);
const output=path.resolve(process.argv[2]||path.join(root,'output','tally-note-native-proof'));
const scratch=await mkdtemp(path.join(tmpdir(),'ledgercraft-note-native-'));
await mkdir(output,{recursive:true});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
let server;
try{
 const frozen=path.join(scratch,'source');await mkdir(frozen);
 for(const name of ['package.json','server.js','lib','public'])await cp(path.join(sourceRoot,name),path.join(frozen,name),{recursive:true});
 const {start}=await import(pathToFileURL(path.join(frozen,'server.js')));server=await start({dataDir:path.join(scratch,'data')});
 const base=`http://127.0.0.1:${server.address().port}`;
 const api=async(route,body,method='POST')=>{const r=await fetch(base+route,body?{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});const d=await r.json();assert.equal(r.ok,true,JSON.stringify(d));return d;};
 const fixture=await readFile(path.join(root,'test/fixtures/tally-note-cycle.xml'));
 const preview=await api('/api/tally/preview',{companyName:'Synthetic note UI preparation',booksFrom:'2025-04-01',files:[{name:'synthetic-note-cycle.xml',base64:fixture.toString('base64')}]});
 assert.equal(preview.canCommit,true,JSON.stringify(preview.issues));
 const created=await api('/api/tally/commit',{token:preview.token,acknowledge:true,compact:true}),id=created.company.id;
 const book=await api(`/api/companies/${id}`),gst=`/api/companies/${id}/gst`,migration=`/api/tally/companies/${id}`;
 const ledger=name=>book.company.ledgers.find(row=>row.name===name).id;
 const {registration}=await api(gst+'/settings',{name:'Meridian Fixture Books',legalName:'Meridian Fixture Books',gstin:'23ABCDE1234F1Z8',stateCode:'23',address:'Synthetic buyer and seller address, Madhya Pradesh'},'PUT');
 const {party:supplier}=await api(gst+'/parties',{name:'Deccan Fixture Vendor',kind:'supplier',supplierLedgerId:ledger('Deccan Fixture Vendor'),gstin:'27PQRST5678L1Z0',stateCode:'27',address:'Synthetic supplier address, Maharashtra'});
 const {party:customer}=await api(gst+'/parties',{name:'Central Fixture Customer',kind:'customer',customerLedgerId:ledger('Central Fixture Customer'),gstin:'23LMNOP1234Q1ZE',stateCode:'23',address:'Synthetic customer address, Madhya Pradesh'});
 const master=book.company.stock.masters[0];
 const {item}=await api(gst+'/items',{name:master.name,stockItemId:master.id,kind:'goods',hsnSac:'8541',unit:'NOS',gstRateBps:1800,cessRateBps:0});
 // Ordinary verified originals are fixture setup. Native proof imports this source-preserving
 // archive through the standard picker, then performs all note review/activation visibly.
 for(const [number,party,accounts,purchaseReview]of[
  ['P-48',supplier,{party:ledger('Deccan Fixture Vendor'),purchase:ledger('Purchase'),igst:ledger('Input IGST')},{receivedDate:'2026-04-02'}],
  ['S-10',customer,{party:ledger('Central Fixture Customer'),sales:ledger('Domestic Sales'),cgst:ledger('Output CGST'),sgst:ledger('Output SGST')},null]
 ]){
  const plan=await api(migration+'/gst'),row=plan.rows.find(row=>row.number===number);
  await api(migration+'/gst/mapping',{recordId:row.recordId,revision:plan.revision,requestId:`native-note-original-map-${number}`,registrationId:registration.id,partyId:party.id,items:[{sourceName:master.name,itemId:item.id}],accounts,...(purchaseReview?{purchaseReview}:{}),evidence:{name:'Synthetic verified original',reference:`Independent synthetic note fixture original ${number}`}});
  const ready=await api(migration+'/gst'),selected=ready.rows.find(candidate=>candidate.recordId===row.recordId);assert.equal(selected.status,'ready',JSON.stringify(selected.blockers));
  await api(migration+'/gst/activate',{revision:ready.revision,reviewHash:ready.reviewHash,recordIds:[row.recordId],requestId:`native-note-original-activate-${number}`});
 }
 await api(gst+'/items',{...item,hsnSac:'9999',gstRateBps:500,pricePaise:90000,purchasePricePaise:90000});
 const before=await api(`/api/companies/${id}`),archive=await api(migration+'/archive'),preparedArchive=path.join(scratch,'synthetic-verified-originals.json');await writeFile(preparedArchive,JSON.stringify(archive));
 const config=path.join(scratch,'fixture.json');await writeFile(config,JSON.stringify({base,preparedArchive,output}));
 const swift=path.join(scratch,'note-ui.swift'),executable=path.join(scratch,'note-ui');await cp(path.join(root,'test/tally-note-gst-ui.swift'),swift);
 await runNative(['/usr/bin/swiftc','-swift-version','5',swift,'-o',executable,'-framework','AppKit','-framework','WebKit'],root);await runNative([executable,config],root);
 const native=JSON.parse(await readFile(path.join(output,'native-results.json'),'utf8')),saved=await api(`/api/companies/${native.company}`),plan=await api(`/api/tally/companies/${native.company}/gst`);
 assert.equal(saved.vouchers.length,7);assert.equal(saved.vouchers.filter(v=>v.gst).length,4);assert.equal(native.activationRequests,1);assert.equal(native.mappingRequests.length,2);assert.equal(native.creditActionsPosted,0);assert.equal((saved.company.gst?.itc?.records||[]).length,0);
 const source=before.vouchers.find(v=>v.number==='PD-5'),posted=saved.vouchers.find(v=>v.number==='PD-5'),original=saved.vouchers.find(v=>v.number==='P-48');
 assert.equal(posted.type,'Debit Note');assert.deepEqual(posted.lines,source.lines);assert.equal(posted.gst.type,'Credit Note');assert.equal(posted.gst.direction,'purchase');assert.equal(posted.gst.itcEligibility,'pending');assert.equal(posted.gst.tallyOrigin.version,3);assert.equal(posted.gst.originalInvoiceId,original.id);assert.equal(posted.gst.originalNumber,'INV/3103');assert.equal(posted.gst.originalDate,'2026-03-31');assert.equal(posted.gst.supplierInvoiceNumber,'SCN/9');assert.equal(posted.gst.supplierInvoiceDate,'2026-04-09');
 assert.equal(posted.gst.totals.taxablePaise,10000);assert.equal(posted.gst.totals.igstPaise,1800);assert.equal(posted.gst.totals.totalPaise,11800);assert.equal(posted.gst.items[0].quantity,'1');
 const journals=saved.company.stock.journals.filter(j=>j.accountingVoucherId===posted.id);assert.equal(journals.length,1);assert.equal(journals[0].type,'issue');assert.equal(journals[0].financialKind,'purchase-return');assert.equal(journals[0].originalSourceId,original.id);assert.equal(journals[0].lines[0].quantity,'1');
 assert.equal(plan.rows.find(r=>r.number==='PD-5').status,'active');assert.equal(plan.rows.find(r=>r.number==='DN-7').status,'ready');assert.equal(saved.vouchers.find(v=>v.number==='DN-7').gst,undefined);assert.equal(saved.company.stock.journals.filter(j=>j.accountingVoucherId===saved.vouchers.find(v=>v.number==='DN-7').id).length,0);
 assert.equal(native.manualPreview.invoice.stockEffect,'none');assert.equal(native.manualPreview.invoice.type,'Credit Note');assert.equal(native.manualPreview.invoice.items[0].hsnSac,'8541');assert.equal(native.manualPreview.invoice.items[0].gstRateBps,1800);assert.equal(native.manualPreview.invoice.items[0].unit,'NOS');assert.equal(native.manualPreview.invoice.items[0].unitPricePaise,15000);assert.equal(native.manualPreview.invoice.totals.totalPaise,17700);assert.equal(native.manualInvoicesPosted,1);const manual=saved.vouchers.find(v=>v.id===native.manualCreditId);assert.equal(manual.gst.type,'Credit Note');assert.equal(manual.gst.stockEffect,'none');assert.equal(saved.company.stock.journals.filter(j=>j.accountingVoucherId===manual.id).length,0);const returns=await api(`/api/companies/${native.company}/gst-returns?registration=${manual.gst.registrationId}&month=2026-04`);const reviewed=returns.creditReviews.find(row=>row.id===manual.id);assert.equal(reviewed.eligible,true);assert.equal(reviewed.review.recipientBasis,'not-availed');assert.equal(reviewed.review.adjustmentGround,'excess-value-or-tax');assert.equal(reviewed.review.groundConfirmed,true);assert.equal(reviewed.review.declarationDate,'2026-05-10');assert.equal(returns.summary.outwardTaxable.taxablePaise,15000);assert.equal(returns.summary.outwardTaxable.cgstPaise,1350);assert.equal(returns.summary.outwardTaxable.sgstPaise,1350);
 const hashes={};for(const name of ['public/tally-gst-ui.js','public/tally-tools.js','public/gst-ui.js','lib/tally-gst.js','lib/tally-gst-notes.js','lib/tally-gst-facts.js','lib/gst.js','lib/gst-credit-review.js','lib/gst-returns.js','lib/gst-return-routes.js','public/gst-credit-review-ui.js','public/gst-returns-ui.js','lib/stock-engine.js','lib/tally-stock.js'])hashes[name]=digest(await readFile(path.join(frozen,name)));
 for(const name of ['test/tally-note-gst-ui.swift','tools/verify-tally-note-native.mjs'])hashes[name]=digest(await readFile(path.join(root,name)));
 await writeFile(path.join(output,'backend-results.json'),JSON.stringify({passed:true,fixture:'independently authored synthetic Tally note cycle',fixtureSHA256:digest(fixture),originalsPreparedViaAPI:2,normalNativeArchiveImport:true,vouchers:7,activeGstDocuments:4,nativeVoucherType:posted.type,statutoryGstType:posted.gst.type,supplierNoteNumber:posted.gst.supplierInvoiceNumber,supplierNoteDate:posted.gst.supplierInvoiceDate,originalNumber:posted.gst.originalNumber,originalDate:posted.gst.originalDate,unchangedPostings:true,stockJournals:journals,financialAllocationSavedWithoutStock:true,manualHistoricalCreditPreview:true,currentCatalog:{hsnSac:'9999',gstRateBps:500,pricePaise:90000},historicalPreview:{hsnSac:'8541',gstRateBps:1800,unit:'NOS',unitPricePaise:15000,stockEffect:'none',totalPaise:17700},manualDraftRestored:true,manualInvoicesPosted:1,manualStockJournals:0,section34:{eligible:reviewed.eligible,review:reviewed.review,before:native.section34.before,after:returns.summary.outwardTaxable},creditRecords:0,sourceSHA256ByFile:hashes},null,2));
 for(const name of ['failure.txt','failure.png'])await rm(path.join(output,name),{force:true});
 console.log(`Native imported GST note proof saved to ${output}`);
}finally{if(server){server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));}await rm(scratch,{recursive:true,force:true});}
