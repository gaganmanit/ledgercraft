import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';
import { parseTallyXlsx, tallyXlsxRows } from '../lib/tally-xlsx.js';
import { readTallyZip } from '../lib/tally-zip.js';
import { tallyRecords, value, children, findNodes } from '../lib/tally-format.js';
import { tallyRecordView } from '../lib/tally-read.js';
import { previewTally, restoreTallyArchive, assertTallySourceRecords, hash, tallyAmount } from '../lib/tally-import.js';

const fixture = name => readFile(new URL('fixtures/tally-xlsx/'+name,import.meta.url));
const sampleName='Tally-Sales-GST-Template.zip';
const options={companyName:'Public Tally default workbook',booksFrom:'2023-04-01'};
function zip(entries) {
  const parts=[], directory=[]; let offset=0;
  for (const [name,input] of entries) {
    const filename=Buffer.from(name), bytes=Buffer.from(input), packed=deflateRawSync(bytes), crc=crc32(bytes);
    const header=Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);
    header.writeUInt32LE(crc,14);header.writeUInt32LE(packed.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(filename.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(8,10);
    central.writeUInt32LE(crc,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);
    parts.push(header,filename,packed);directory.push(central,filename);offset+=header.length+filename.length+packed.length;
  }
  const tail=Buffer.alloc(22), central=Buffer.concat(directory);tail.writeUInt32LE(0x06054b50);tail.writeUInt16LE(entries.length,8);tail.writeUInt16LE(entries.length,10);tail.writeUInt32LE(central.length,12);tail.writeUInt32LE(offset,16);
  return Buffer.concat([...parts,central,tail]);
}
const escape=text=>String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function col(index) { let result='';for(let n=index+1;n;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result;return result; }
function workbook(headers,rows,{date1904=false,sheet='Accounting Voucher',headerRow=1,extra=[],format='0000'}={}) {
  const rowXml=(values,row)=>`<row r="${row}">${values.map((cell,index)=>{
    if(cell===null||cell===undefined)return '';
    const ref=col(index)+row;
    if(typeof cell==='object')return `<c r="${ref}"${cell.s?` s="${cell.s}"`:''}>${cell.f?`<f>${escape(cell.f)}</f>`:''}${cell.n!==undefined?`<v>${cell.n}</v>`:''}</c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escape(cell)}</t></is></c>`;
  }).join('')}</row>`;
  return zip([
    ['[Content_Types].xml','<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'],
    ['_rels/.rels','<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml',`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="${date1904?'1':'0'}"/><sheets><sheet name="${escape(sheet)}" sheetId="1" r:id="r1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml',`<styleSheet><numFmts><numFmt numFmtId="165" formatCode="${escape(format)}"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="165"/></cellXfs></styleSheet>`],
    ['xl/worksheets/sheet1.xml',`<worksheet><sheetData>${rowXml(headers,headerRow)}${rows.map((values,index)=>rowXml(values,headerRow+index+1)).join('')}</sheetData></worksheet>`],...extra,
  ]);
}
const baseHeaders=['Voucher Date','Voucher Type Name','Voucher Number','Ledger Name','Ledger Amount','Ledger Amount Dr/Cr'];
const baseRows=()=>[['2023-04-01','Sales','0001','Public customer',{f:'SUM(E3:E4)'},'Dr'],[null,null,null,'Sales',{n:'100'},'Cr'],[null,null,null,'Tax',{f:'ROUND(0.18*E3,2)'},'Cr']];
const parsedRecords=bytes=>{const result=parseTallyXlsx(bytes);return {...result,records:tallyRecords(result.tree)};};
const blocking=result=>result.issues.filter(issue=>issue.severity==='blocking');

test('official GST sales workbook yields four exact balanced vouchers, ten items and source-linked allocations',async()=>{
  const bytes=await fixture(sampleName), p=parsedRecords(bytes);
  assert.equal(p.encoding,'xlsx-zip');assert.equal(blocking(p).length,0,JSON.stringify(p.issues));assert.equal(p.workbook.voucherCount,4);
  assert.deepEqual(p.records.map(record=>value(record.node,'DATE')),['20230401','20230402','20230403','20230404']);
  assert.deepEqual(p.records.map(record=>value(record.node,'VOUCHERNUMBER')),['101','102','103','104']);
  const expected=[354000,236000,1309800,1309800];let inventory=0;
  for(const [index,{node}] of p.records.entries()){
    const ledgers=children(node,'ALLLEDGERENTRIES'), amounts=ledgers.map(entry=>tallyAmount(value(entry,'AMOUNT')));
    assert.equal(amounts.reduce((sum,amount)=>sum+amount,0),0);assert.equal(-amounts[0],expected[index]);
    for(const item of children(node,'ALLINVENTORYENTRIES')){
      inventory++;assert.equal(value(item,'ACTUALQTY'),'');assert.match(value(item,'BILLEDQTY'),/ Nos$/);
      assert.equal(value(children(item,'ACCOUNTINGALLOCATIONS')[0],'LEDGERNAME'),'Sales');
      assert.equal(value(item,'AMOUNT'),value(children(item,'ACCOUNTINGALLOCATIONS')[0],'AMOUNT'));
    }
  }
  assert.equal(inventory,10);const first=p.records[0].node;
  assert.equal(value(first,'PARTYLEDGERNAME'),'National Traders');assert.equal(value(first,'PARTYSTATENAME'),'Haryana');
  assert.equal(value(first,'PARTYGSTIN'),'06AAADL0053A1ZA');assert.equal(value(first,'PLACEOFSUPPLY'),'Haryana');
  assert.deepEqual(children(first,'ADDRESS').map(node=>node.text),['House no 166','Sec 43, Gurugram']);
  assert.equal(value(first,'EWAYBILLNUMBER'),'151010155892');assert.equal(value(first,'IRNACKNO'),'112310157073481');
  assert.equal(value(first,'VEHICLENUMBER'),'KA43KH6555');assert.equal(value(first,'IRN').length,64);
  const source=tallyXlsxRows(first), formula=source.flatMap(row=>row.cells).find(cell=>cell.ref==='L2');
  assert.equal(formula.formula,'L3+L5+L6');assert.equal(formula.value,'3540');assert.equal(formula.type,'n');
  assert.ok(source.flatMap(row=>row.cells).some(cell=>cell.header==='Consignor Details (From) - Address-1'&&cell.value==='Bangalore'));
  assert.deepEqual(p.workbook.diagnostics.map(row=>row.field).sort(),['EWAYBILLNUMBER','IRN','IRNACKNO']);
  assert.ok(p.workbook.diagnostics.every(row=>row.vouchers.length===4&&row.code.startsWith('xlsx-duplicate-')));
  const view=tallyRecordView({...p.records[0],recordId:'public'});assert.deepEqual(view.spreadsheet,source);assert.equal(view.transport.IRN,value(first,'IRN'));
});

test('inner XLSX, supplier ZIP and renamed identical copies have identical normalized source records',async()=>{
  const bytes=await fixture(sampleName), [name,inner]=[...readTallyZip(bytes)][0];
  const outer=parsedRecords(bytes), plain=parseTallyXlsx(inner,{name}), renamed=parseTallyXlsx(inner,{name:'Renamed.xlsx'});
  assert.equal(plain.encoding,'xlsx');assert.deepEqual(plain.tree,outer.tree);assert.deepEqual(renamed.tree,plain.tree);
  assert.deepEqual(readTallyZip(bytes).get(name),inner);
});

test('official ledger master template preserves openings, four opening bills and multiline addresses',async()=>{
  const p=parsedRecords(await fixture('Tally-Ledgers-Template.zip'));assert.equal(blocking(p).length,0);assert.equal(p.records.length,15);
  const byName=new Map(p.records.map(record=>[record.node.attrs.NAME,record.node]));
  assert.equal(value(byName.get('National Traders'),'OPENINGBALANCE'),'-15200.00');
  assert.equal(value(byName.get('HDFC Bank'),'OPENINGBALANCE'),'-10200.00');
  const abc=byName.get('ABC Company Limited');assert.equal(children(abc,'BILLALLOCATIONS').length,3);
  assert.equal(value(children(abc,'BILLALLOCATIONS')[0],'BILLDATE'),'20230310');
  assert.deepEqual(children(abc,'ADDRESS').map(node=>node.text),['15 MG Road','Near LIC building','Bangalore']);
  assert.equal(value(byName.get('Sales'),'XLSXOPENINGUNKNOWN'),'Yes');
  assert.equal(p.records.flatMap(record=>findNodes(record.node,'BILLALLOCATIONS')).length,4);
});

test('official stock templates preserve base units and all price/cost schedule rows without activating schedules',async()=>{
  for(const filename of ['Tally-Stock-Price-Template.zip','Tally-Stock-Standard-Template.zip']){
    const p=parsedRecords(await fixture(filename));assert.equal(blocking(p).length,0);assert.equal(p.records.length,4);
    assert.ok(p.records.every(record=>record.type==='STOCKITEM'&&value(record.node,'BASEUNITS')==='Nos'));
    assert.ok(p.records.every(record=>value(record.node,'XLSXOPENINGUNKNOWN')==='Yes'));
    assert.ok(p.issues.some(issue=>issue.code==='xlsx-stock-schedules-retained'));
    assert.ok(tallyXlsxRows(p.records[0].node).length>=2);
    assert.ok(tallyXlsxRows(p.records[0].node).flatMap(row=>row.cells).some(cell=>/Rate/.test(cell.header)));
    assert.equal(p.records.filter(record=>record.type==='UNIT').length,0);
  }
});

test('headers drive reordered columns and later header rows instead of sample cell addresses',()=>{
  const headers=['Ledger Amount Dr/Cr','Ledger Name','Voucher Number','Voucher Date','Ledger Amount','Voucher Type Name'];
  const rows=[['Dr','Party','0042','2024-02-29',{n:'100.05'},'Receipt'],['Cr','Cash',null,null,{n:'100.05'}]];
  const p=parsedRecords(workbook(headers,rows,{headerRow:4,sheet:'My default voucher data'}));assert.equal(blocking(p).length,0);
  assert.equal(value(p.records[0].node,'DATE'),'20240229');assert.equal(value(p.records[0].node,'VOUCHERNUMBER'),'0042');
  assert.deepEqual(children(p.records[0].node,'ALLLEDGERENTRIES').map(node=>value(node,'AMOUNT')),['-100.05','100.05']);
  assert.equal(tallyXlsxRows(p.records[0].node)[0].row,5);
});

test('cache-less arithmetic, SUM and ROUND calculate exact paise and preserve formula and cached source values',()=>{
  const p=parsedRecords(workbook(baseHeaders,baseRows()));assert.equal(blocking(p).length,0,JSON.stringify(p.issues));
  assert.deepEqual(children(p.records[0].node,'ALLLEDGERENTRIES').map(node=>value(node,'AMOUNT')),['-118.00','100.00','18.00']);
  const stale=baseRows();stale[0][4]={f:'SUM(E3:E4)',n:'999'};
  const result=parsedRecords(workbook(baseHeaders,stale));assert.equal(value(children(result.records[0].node,'ALLLEDGERENTRIES')[0],'AMOUNT'),'-118.00');
  const cell=tallyXlsxRows(result.records[0].node)[0].cells.find(cell=>cell.ref==='E2');assert.equal(cell.raw,'999');assert.equal(cell.value,'118');
});

test('unsupported/external formulas, circular references and Excel errors block posting but retain source cells',()=>{
  for(const formula of ['WEBSERVICE("https://example.invalid/private")','[Other.xlsx]Sheet1!A1','E2','1/0']){
    const rows=baseRows();rows[0][4]={f:formula,n:'118'};
    const p=parsedRecords(workbook(baseHeaders,rows));assert.ok(blocking(p).some(issue=>issue.code==='xlsx-unresolved-cell'));
    const cell=tallyXlsxRows(p.records[0].node)[0].cells.find(cell=>cell.ref==='E2');assert.equal(cell.formula,formula);assert.equal(cell.raw,'118');assert.ok(cell.error);
  }
  const nested=baseRows();nested[0][4]={f:'('.repeat(200)+'118'+')'.repeat(200)};
  assert.ok(blocking(parsedRecords(workbook(baseHeaders,nested))).some(issue=>/nesting/.test(issue.message)));
});

test('Excel 1900/1904 dates, literal text and zero-masked identifiers are handled without losing identity',()=>{
  const rows=baseRows();rows[0][0]={n:'0',s:1};rows[0][2]={n:'7',s:2};
  const p=parsedRecords(workbook(baseHeaders,rows,{date1904:true}));assert.equal(blocking(p).length,0);
  assert.equal(value(p.records[0].node,'DATE'),'19040101');assert.equal(value(p.records[0].node,'VOUCHERNUMBER'),'0007');
  rows[0][0]={n:'60',s:1};assert.ok(blocking(parsedRecords(workbook(baseHeaders,rows))).length);
  rows[0][0]={n:'45017.5',s:1};assert.ok(blocking(parsedRecords(workbook(baseHeaders,rows))).length);
  rows[0][0]='2023-04-01';rows[0][2]={n:'12345678901234567'};assert.ok(blocking(parsedRecords(workbook(baseHeaders,rows))).some(issue=>/fifteen/.test(issue.message)));
});

test('status columns map explicitly; unknown or contradictory statuses never become ordinary posting vouchers',()=>{
  for(const [header,tag] of [['Cancelled','ISCANCELLED'],['Optional','ISOPTIONAL'],['Post-Dated','ISPOSTDATED'],['Deleted','ISDELETED']]){
    const rows=baseRows();rows[0].push('Yes');const p=parsedRecords(workbook([...baseHeaders,header],rows));assert.equal(value(p.records[0].node,tag),'Yes');
  }
  const rows=baseRows();rows[0].push('maybe');assert.ok(blocking(parsedRecords(workbook([...baseHeaders,'Optional'],rows))).length);
  rows[0][6]='No';rows[0].push('Yes');assert.ok(blocking(parsedRecords(workbook([...baseHeaders,'Optional','Is Optional'],rows))).length);
  assert.ok(blocking(parsedRecords(workbook([...baseHeaders,'Voucher Status'],rows.map(row=>row.slice(0,7))))).some(issue=>issue.code==='xlsx-unmapped-status'));
});

test('orphan rows, partial voucher identities, missing headers and repeated headers are explicit blockers',()=>{
  const orphan=baseRows();orphan[0][0]=null;orphan[0][1]=null;orphan[0][2]=null;
  assert.ok(blocking(parsedRecords(workbook(baseHeaders,orphan))).some(issue=>issue.code==='xlsx-orphan-row'));
  const partial=baseRows();partial[1][0]='2023-04-02';assert.ok(blocking(parsedRecords(workbook(baseHeaders,partial))).length);
  const noHeader=baseRows();noHeader[0].push('unheaded');assert.ok(blocking(parsedRecords(workbook(baseHeaders,noHeader))).some(issue=>issue.code==='xlsx-unheaded-data'));
  assert.ok(blocking(parsedRecords(workbook([...baseHeaders,'Ledger Amount'],baseRows()))).some(issue=>issue.code==='xlsx-duplicate-header'));
  const foreign=baseRows();foreign[0].push('USD');assert.ok(blocking(parsedRecords(workbook([...baseHeaders,'Ledger Currency'],foreign))).some(issue=>issue.code==='xlsx-currency-review'));
});

test('unrecognized worksheets and unreconciled item allocations are retained for review',()=>{
  const p=parsedRecords(workbook(['Foreign Field'],[['Retain me']],{sheet:'Custom layout'}));
  assert.equal(p.records[0].type,'XLSXWORKSHEET');assert.ok(p.issues.some(issue=>issue.code==='xlsx-unmapped-worksheet'));
  const headers=[...baseHeaders,'Item Name','Billed Quantity','Item Rate','Item Rate per','Item Amount'];
  const rows=[['2023-04-01','Sales','1','Party',{n:'118'},'Dr'],[null,null,null,'Sales',{n:'100'},'Cr','Item',{n:'1'},{n:'50'},'Nos',{n:'50'}],[null,null,null,'Tax',{n:'18'},'Cr']];
  const r=parsedRecords(workbook(headers,rows));assert.ok(r.issues.some(issue=>issue.code==='xlsx-item-account-unreconciled'));
  assert.equal(findNodes(r.records[0].node,'ACCOUNTINGALLOCATIONS').length,0);
  assert.equal(tallyXlsxRows(r.records[0].node)[1].cells.find(cell=>cell.header==='Item Amount').value,'50');
});

test('malformed portal identifiers are source diagnostics without an authenticated acknowledgement claim',()=>{
  const rows=baseRows();rows[0].push('not-an-irn','123','bad-ack');
  const p=parsedRecords(workbook([...baseHeaders,'e-Invoice - IRN','e-Way Bill No.','e-Invoice - Ack No.'],rows));
  assert.equal(blocking(p).length,0);assert.equal(p.workbook.diagnostics.length,3);
  assert.ok(p.workbook.diagnostics.every(row=>row.code.startsWith('xlsx-invalid-')));
  assert.equal(value(p.records[0].node,'IRN'),'not-an-irn');assert.equal(value(p.records[0].node,'IRNACKNO'),'bad-ack');
});

test('ZIP reader rejects traversal, duplicates, checksum changes, expansion bombs and multiple outer workbooks',()=>{
  assert.throws(()=>readTallyZip(zip([['../escape','x']])),/Unsafe/);
  assert.throws(()=>readTallyZip(zip([['same','a'],['same','b']])),/Duplicate/);
  const bytes=zip([['ok','abc']]), broken=Buffer.from(bytes);broken[32]^=1;
  assert.throws(()=>readTallyZip(broken),/decompressed|checksum/);
  const bomb=Buffer.from(bytes), central=bomb.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bomb.writeUInt32LE(17*1024*1024,central+24);
  assert.throws(()=>readTallyZip(bomb),/expanded content/);
  const normal=workbook(baseHeaders,baseRows());assert.throws(()=>parseTallyXlsx(zip([['a.xlsx',normal],['b.xlsx',normal]])),/exactly one/);
  assert.throws(()=>parseTallyXlsx(workbook(baseHeaders,baseRows(),{extra:[['xl/vbaProject.bin',Buffer.from('not executable')]]})),/Macro-enabled/);
});

test('real read path deduplicates source copies and reconstructs full XLSX source archive without changing bytes',async()=>{
  const bytes=await fixture(sampleName), file={name:sampleName,base64:bytes.toString('base64')};
  const p=previewTally([file],options);assert.equal(p.canCommit,true,JSON.stringify(p.issues));assert.equal(p.vouchers.length,4);
  assert.equal(p.summary.reconciliation.postedDebitPaise,3209600);assert.equal(p.summary.reconciliation.postedCreditPaise,3209600);
  assert.equal(p.sources[0].sha256,hash(bytes));assert.equal(p.sources[0].base64,file.base64);assert.equal(p.sources[0].encoding,'xlsx-zip');
  assertTallySourceRecords(p.sources,p.records);
  const duplicate=previewTally([file,{...file,name:'Second.zip'}],options);
  assert.equal(duplicate.canCommit,true,JSON.stringify(duplicate.issues));assert.equal(duplicate.vouchers.length,4);assert.equal(duplicate.summary.reconciliation.duplicateVouchers,4);
  const archive={format:'financer-tally-archive',version:1,company:p.company,vouchers:p.vouchers,sources:p.sources,records:p.records};
  const restored=restoreTallyArchive(JSON.parse(JSON.stringify(archive)));assert.deepEqual(restored.vouchers,p.vouchers);assert.deepEqual(restored.records,p.records);assert.deepEqual(Buffer.from(restored.sources[0].base64,'base64'),bytes);
  const bad=JSON.parse(JSON.stringify(archive));findNodes(bad.records.find(record=>record.type==='VOUCHER').node,'XLSXCELL')[0].children.find(node=>node.tag==='VALUE').text='changed';
  assert.throws(()=>restoreTallyArchive(bad),/source record differs/);
});

test('1,000 generated default vouchers parse and preview with measured work and no timing threshold',t=>{
  const headers=[...baseHeaders,'Item Name','Billed Quantity','Actual Quantity','Item Rate','Item Rate per','Item Amount','Buyer/Supplier - GSTIN/UIN','Buyer/Supplier - State','Buyer/Supplier - Place of Supply','e-Way Bill No.','e-Invoice - IRN'];
  const rows=[];
  for(let index=0;index<1000;index++){
    const row=2+index*5, day=String(index%28+1).padStart(2,'0');
    rows.push([`2023-04-${day}`,'Sales','S/'+String(index+1).padStart(6,'0'),'Public customer '+index%10,{f:`E${row+1}+E${row+3}+E${row+4}`},'Dr',null,null,null,null,null,null,'06AAADL0053A1ZA','Haryana','Haryana',String(151010100000+index),hash('public-irn-'+index)],
      [null,null,null,'Sales',{n:'300'},'Cr','Public item A',{n:'1'},{n:'1'},{n:'100'},'Nos',{n:'100'}],
      [null,null,null,null,null,null,'Public item B',{n:'2'},{n:'2'},{n:'100'},'Nos',{n:'200'}],
      [null,null,null,'Tax - CGST @ 9 %',{f:`0.09*E${row+1}`},'Cr'],
      [null,null,null,'Tax - SGST @ 9 %',{f:`0.09*E${row+1}`},'Cr']);
  }
  const bytes=workbook(headers,rows), started=performance.now(), p=parseTallyXlsx(bytes), parsed=performance.now();
  assert.equal(blocking(p).length,0,JSON.stringify(blocking(p).slice(0,3)));assert.equal(p.workbook.voucherCount,1000);
  assert.equal(p.workbook.sheets[0].columns,headers.length);
  if (process.env.FINANCER_XLSX_BENCHMARK_OUTPUT) writeFileSync(process.env.FINANCER_XLSX_BENCHMARK_OUTPUT,bytes);
  if (process.env.FINANCER_XLSX_PARSE_ONLY==='1') {
    t.diagnostic(JSON.stringify({vouchers:1000,itemRows:2000,worksheetRows:5001,cells:p.workbook.cellCount,xlsxBytes:bytes.length,parseMs:Math.round(parsed-started),heapUsedMiB:Math.round(process.memoryUsage().heapUsed/1048576)}));return;
  }
  const preview=previewTally([{name:'Public-1000.xlsx',base64:bytes.toString('base64')}],options), finished=performance.now();
  assert.equal(preview.canCommit,true,JSON.stringify(preview.issues.filter(issue=>issue.severity==='blocking').slice(0,3)));
  assert.equal(preview.vouchers.length,1000);assert.equal(preview.summary.reconciliation.postedDebitPaise,35400000);assert.equal(preview.summary.reconciliation.postedCreditPaise,35400000);
  assert.equal(preview.summary.reconciliation.failedVouchers,0);
  t.diagnostic(JSON.stringify({vouchers:1000,itemRows:2000,worksheetRows:5001,cells:p.workbook.cellCount,xlsxBytes:bytes.length,worksheetXmlBytes:readTallyZip(bytes).get('xl/worksheets/sheet1.xml').length,parseMs:Math.round(parsed-started),previewIncludingParseMs:Math.round(finished-parsed),heapUsedMiB:Math.round(process.memoryUsage().heapUsed/1048576)}));
});
