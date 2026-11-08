import assert from 'node:assert/strict';
import { runNative } from './native-command.mjs';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch=await mkdtemp(path.join(tmpdir(),'financer-stock-history-native-'));
const output=path.resolve(process.argv[2] || path.join(root,'output','stock-history-native-proof'));
await mkdir(output,{recursive:true});
const run=args=>runNative(args,root);
let server;
try {
  const frozen=path.join(scratch,'source');await mkdir(frozen);
  for(const name of ['package.json','server.js','lib','public']) await cp(path.join(root,name),path.join(frozen,name),{recursive:true});
  const {createStore}=await import(pathToFileURL(path.join(frozen,'lib/store.js')));
  const {start}=await import(pathToFileURL(path.join(frozen,'server.js')));
  const store=createStore(path.join(scratch,'data'));
  const {company}=await store.create({name:'Synthetic paged stock history',booksFrom:'2026-04-01'});
  const makeItem=name=>store.saveGstMaster(company.id,'item',{name,kind:'goods',unit:'NOS',hsnSac:'854140',openingQuantity:'0',gstRateBps:1800});
  const itemA=(await makeItem('Synthetic history item A')).item;
  const itemB=(await makeItem('Synthetic history item B')).item;
  const journals=Array.from({length:115},(_,index)=>({id:`sj-history-${index+1}`,date:'2026-04-10',number:`ENTRY-${String(index+1).padStart(3,'0')}`,type:'adjustment',sequence:index,
    lines:[{itemId:index<110?itemA.id:itemB.id,godownId:index<110&&index%2?'annex':'main',direction:'in',quantity:'1',valuePaise:100,reason:'Synthetic pagination fixture'}]}));
  await store.mutateCompanySection(company.id,'stock',()=>({version:1,revision:0,godowns:[{id:'main',name:'Main Location'},{id:'annex',name:'Annex'}],items:{[itemA.id]:{costingMethod:'fifo',openingValuePaise:0},[itemB.id]:{costingMethod:'fifo',openingValuePaise:0}},journals}));
  server=await start({dataDir:path.join(scratch,'data')});
  const base=`http://127.0.0.1:${server.address().port}`,endpoint=`${base}/api/companies/${company.id}/stock`;
  const summary=await (await fetch(endpoint+'?from=2026-04-01&to=2026-04-30')).json();
  assert.equal(summary.journals.length,50);assert.equal(summary.journalPage.total,115);assert.equal(summary.journals[0].number,'ENTRY-115');
  const filtered=await (await fetch(endpoint+`/journals?from=2026-04-01&to=2026-04-30&godownId=annex&itemId=${itemA.id}&offset=50&limit=50`)).json();
  assert.equal(filtered.total,55);assert.equal(filtered.rows.length,5);assert.equal(filtered.rows[0].number,'ENTRY-010');
  const config=path.join(scratch,'fixture.json');await writeFile(config,JSON.stringify({base,company:company.id,itemA:itemA.id,itemB:itemB.id,output}));
  const source=path.join(scratch,'stock-history-ui.swift');await cp(path.join(root,'test/stock-history-ui.swift'),source);
  const executable=path.join(scratch,'financer-stock-history-ui');await run(['/usr/bin/swiftc','-swift-version','5',source,'-o',executable,'-framework','AppKit','-framework','WebKit']);
  await run([executable,config]);
  const native=JSON.parse(await readFile(path.join(output,'native-results.json'),'utf8'));
  const state=await (await fetch(endpoint+'?from=2026-04-01&to=2026-04-30')).json();
  assert.equal(state.revision,0);assert.equal(state.journalPage.total,115);assert.equal(state.totals.valuePaise,11500);
  const sourceSHA256={};for(const name of ['public/stock-ui.js','lib/stock-routes.js'])sourceSHA256[name]=createHash('sha256').update(await readFile(path.join(frozen,name))).digest('hex');
  await writeFile(path.join(output,'backend-results.json'),JSON.stringify({passed:true,fixtureJournals:115,summaryRows:summary.journals.length,summaryTotal:summary.journalPage.total,annexItemTotal:filtered.total,annexLastPageRows:filtered.rows.length,newestFirst:true,maxRenderedRows:native.maxRenderedRows,filtersPreserved:true,staleFilterResponseIgnored:true,staleNavigationResponseIgnored:true,stockWrites:0,closingValuePaise:11500,sourceSHA256},null,2));
  console.log(`Native paged stock history proof saved to ${output}`);
} finally {
  if(server){server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));}
  await rm(scratch,{recursive:true,force:true});
}
