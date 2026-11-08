import { applyCreditReview } from '../lib/gst-credit-review.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gstinCheckDigit } from '../lib/gst.js';
import { buildOutwardAmendment, buildAmendmentEvent, outwardDocumentSnapshot } from '../lib/gst-outward-amendments.js';
import { returnWorkbook, worksheetCsv, columns } from '../lib/gst-returns.js';
import { gstrWorkbook } from '../lib/gst-workbook.js';
import { createStore } from '../lib/store.js';
import { companyBackup, validateTransfer } from '../lib/transfer.js';

const execute = promisify(execFile);
const gstin = prefix => prefix + gstinCheckDigit(prefix);
const registration = { id: 'reg', name: 'Synthetic registration', gstin: gstin('23ABCDE1234F1Z'), stateCode: '23' };
const heads = ['taxablePaise','igstPaise','cgstPaise','sgstPaise','utgstPaise','cessPaise','totalPaise'];
let sequence = 0;
function fixture() { return { company: { id: 'synthetic-returns', booksFrom: '2026-04-01', ledgers: [], gst: { registrations: [registration] } }, vouchers: [] }; }
function document(f, number, changes = {}, taxable = 20000) {
  const id=number.toLowerCase().replaceAll("/","-");
  const inter = changes.placeOfSupply !== '23';
  const withoutTax = changes.exportMode === 'lut';
  const items = [500,1800].map((rate,index) => {
    const amount = taxable / 2, tax = withoutTax ? 0 : amount * rate / 10000;
    return { itemId: 'item-' + index, kind: 'goods', name: 'Synthetic goods', hsnSac: index ? '85414090' : '010121', unit: 'NOS', quantity: '1', gstRateBps: rate,
      supplyStatus: changes.supplyCategory && changes.supplyCategory !== 'domestic' ? 'zero-rated' : 'taxable', taxablePaise: amount,
      igstPaise: inter ? tax : 0, cgstPaise: inter ? 0 : tax / 2, sgstPaise: inter ? 0 : tax / 2, utgstPaise: 0, cessPaise: 0, taxPaise: tax, totalPaise: amount + tax };
  });
  const totals = Object.fromEntries([...heads,'taxPaise'].map(key => [key,items.reduce((sum,row) => sum + row[key],0)]));
  const invoice = { id, voucherId: id, number, date: '2026-04-10', type: 'Sales', direction: 'sales', registrationId: registration.id, registration,
    party: { name: 'Synthetic customer', gstin: gstin('27LMNOP1234Q1Z') }, placeOfSupply: '27', supplyCategory: 'domestic', reverseCharge: false,
    stockEffect: 'quantity', items, totals, ...changes };
  f.vouchers.push({ id, date: invoice.date, type: invoice.type, number: invoice.number, gst: invoice, lines: [] });
  return invoice;
}
function priorFor(f, invoice, factor = .5) {
  const prior = structuredClone(outwardDocumentSnapshot(invoice,f.vouchers));
  prior.number = '0001'; prior.date = '2026-04-09'; prior.invoiceValuePaise *= factor;
  for (const row of prior.rates) for (const key of heads.filter(key => key !== 'totalPaise')) row[key] *= factor;
  for (const row of prior.hsnRows) { for (const key of heads) row[key] *= factor; row.quantity = String(Number(row.quantity) * factor); }
  return prior;
}
function creditEvidence(id) {
  return { invoiceId:id,revision:0,requestId:"synthetic-credit-review-"+id.replace(/[^a-z0-9-]/gi,"-"),declarationDate:"2026-06-11",annualReturnStatus:"not-filed",
    recipientBasis:"not-availed",adjustmentGround:"excess-value-or-tax",groundConfirmed:true,reference:"Synthetic recipient and credit calculation"};
}
function save(f, invoice, options = {}) {
  if (invoice.type === "Credit Note" && !invoice.originalInvoiceId) {
    const original = document(f,"ORIGINAL/1",{date:invoice.originalDate});
    invoice.originalInvoiceId = original.id;
    invoice.originalNumber = original.number;
    f.company = applyCreditReview(f.company,f.vouchers,creditEvidence(invoice.id)).company;
  }
  const input = { invoiceId: invoice.id, date: '2026-06-01', filingDate: '2026-06-11', amendmentPeriod: '2026-05', originalPeriod: '2026-04',
    revision: f.company.gst.outwardAmendments?.revision || 0, requestId: 'synthetic-return-' + String(++sequence).padStart(8,'0'),
    originalReported: priorFor(f,invoice), originalFiling: { form: 'GSTR-1', reference: 'SYNTHETIC-APRIL', filedDate: '2026-05-11', confirmedFiled: true },
    annualReturnStatus: 'not-filed', evidence: { basis: 'Synthetic reporting discrepancy', documentReference: 'SYNTHETIC-RECON', accurateBooksConfirmed: true, reportedSnapshotConfirmed: true }, ...options };
  input.previewHash = buildOutwardAmendment(f.company,f.vouchers,input,{ preview: true }).previewHash;
  const result = buildOutwardAmendment(f.company,f.vouchers,input);
  f.company.gst.outwardAmendments ||= { version: 1, revision: 0, records: [], events: [] };
  f.company.gst.outwardAmendments.records.push(result.record); f.company.gst.outwardAmendments.revision = result.revision;
  return result.record;
}
const report = (f,month) => returnWorkbook(f.company,f.vouchers,registration.id,month);

test('return working rows use the independent prior report while accurate books and issued counts stay unchanged', () => {
  const f=fixture(), invoice=document(f,'ACTUAL/1'), before=JSON.stringify(f.vouchers);
  const record=save(f,invoice), april=report(f,'2026-04'), may=report(f,'2026-05');
  assert.equal(april.bookSummary.outwardTaxable.taxablePaise,20000);
  assert.equal(april.summary.outwardTaxable.taxablePaise,10000);
  assert.equal(april.sheets['b2b,sez,de'][0][2],'0001');
  assert.equal(april.amendments.comparators[0].revised.totals.taxablePaise,20000);
  assert.equal(april.amendments.comparators[0].originalReported.totals.taxablePaise,10000);
  assert.equal(april.sheets.docs[0][1],'ACTUAL/1'); assert.equal(april.sheets.docs[0][3],1);
  assert.equal(april.hsnCheck.reconciliation[0].hsnPaise,10000);
  assert.equal(may.sheets.b2ba.length,2); assert.equal(may.sheets['b2b,sez,de'].length,0);
  assert.equal(may.sheets.b2ba[0][6],'223.00');
  assert.equal(may.summary.outwardTaxable.taxablePaise,record.delta.taxablePaise);
  assert.equal(may.summary.outwardTaxable.igstPaise,1150);
  assert.equal(may.hsnCheck.reconciliation[0].differencePaise,0);
  assert.equal(may.bookSummary.outwardTaxable.taxablePaise,0); assert.equal(may.sheets.docs.length,0);
  assert.equal(JSON.stringify(f.vouchers),before);
});

for (const reverseCharge of [false,true]) for (const correctionMonth of ['2026-05','2026-06']) test(`cross-month document date contributes no full return amount in its actual month (${correctionMonth} correction, RCM ${reverseCharge})`, () => {
  const f=fixture(), invoice=document(f,'MOVED/1',{ date:'2026-05-02',reverseCharge }), bucket=reverseCharge?'outwardRcm':'outwardTaxable';
  save(f,invoice,correctionMonth === '2026-06' ? { amendmentPeriod:correctionMonth,date:'2026-07-01',filingDate:'2026-07-11' } : {});
  const april=report(f,'2026-04'), may=report(f,'2026-05'), june=report(f,'2026-06');
  assert.equal(april.summary[bucket].taxablePaise,10000); assert.equal(april.bookSummary[bucket].taxablePaise,0);
  assert.equal(april.sheets.docs.length,0); assert.equal(april.sheets['b2b,sez,de'].length,2);
  assert.equal(may.bookSummary[bucket].taxablePaise,20000); assert.equal(may.sheets.docs[0][3],1);
  assert.equal(may.sheets['b2b,sez,de'].length,0);
  assert.equal(may.summary[bucket].taxablePaise,correctionMonth === '2026-05' ? 10000 : 0);
  assert.equal(june.summary[bucket].taxablePaise,correctionMonth === '2026-06' ? 10000 : 0);
  for (const current of [april,may,june]) assert.equal(current.hsnCheck.reconciliation[0].differencePaise,0);
  assert.equal([april,may,june].reduce((sum,r)=>sum+r.summary[bucket].taxablePaise,0),20000);
});

test('RCM, SEZ, export and credit/debit note amendments use the correct signed liability bucket and HSN delta', () => {
  for (const [changes,bucket,sign] of [
    [{reverseCharge:true},'outwardRcm',1], [{supplyCategory:'sez',exportMode:'igst'},'zeroRated',1], [{supplyCategory:'sez',exportMode:'lut'},'zeroRated',1],
    [{party:{name:'Foreign buyer',gstin:''},supplyCategory:'export',exportMode:'lut',placeOfSupply:'96'},'zeroRated',1],
    [{party:{name:'Foreign buyer',gstin:''},supplyCategory:'export',exportMode:'igst',placeOfSupply:'96'},'zeroRated',1],
    [{type:'Credit Note',stockEffect:'none',originalDate:'2026-04-01'},'outwardTaxable',-1], [{type:'Debit Note',stockEffect:'none'},'outwardTaxable',1],
  ]) {
    const f=fixture(), invoice=document(f,'ACTUAL/1',changes); save(f,invoice);
    const r=report(f,'2026-05'); assert.equal(r.summary[bucket].taxablePaise,sign*10000);
    assert.equal(r.amendments.difference.taxablePaise,sign*10000);
    assert.equal(r.amendments.liabilityDifference.taxablePaise,bucket === 'outwardRcm' ? 0 : sign*10000);
    assert.ok(r.hsnCheck.reconciliation.every(row=>row.differencePaise===0));
    if (changes.type === 'Credit Note') assert.ok(r.sheets['hsn(b2b)'].every(row=>row[3]==='0' && Number(row[5])<0));
  }
});

test('a withdrawn recipient confirmation holds the proposed extra credit without erasing the prior filed comparator', () => {
  const f = fixture(), note = document(f, 'CREDIT/2', {type:'Credit Note',stockEffect:'none',originalDate:'2026-04-01'});
  save(f,note);
  const prior = f.company.gst.creditReviews.records[0];
  const filed = report(f,'2026-04').sheets.cdnr;
  assert.equal(filed.length,2);
  assert.equal(report(f,'2026-05').sheets.cdnra.length,2);
  f.company = applyCreditReview(f.company,f.vouchers,{...creditEvidence(note.id),revision:1,requestId:'synthetic-review-withdrawal',supersedes:prior.id,
    recipientBasis:'unconfirmed',correctionReason:'Recipient withdrew the confirmation'}).company;
  const held = report(f,'2026-05');
  assert.equal(held.sheets.cdnra.length,0);
  assert.equal(held.amendments.liabilityDifference.igstPaise,0);
  assert.ok(held.amendments.rows[0].heldReason);
  assert.deepEqual(report(f,'2026-04').sheets.cdnr,filed);
});

test('lower revised invoice values reduce liability while lower revised credit values increase it', () => {
  for (const type of ['Sales','Credit Note']) {
    const f=fixture(), invoice=document(f,'ACTUAL/1',{type,stockEffect:'none',originalDate:'2026-04-01'});
    save(f,invoice,{originalReported:priorFor(f,invoice,2)});
    const r=report(f,'2026-05'), sign=type==='Sales'?-1:1;
    assert.equal(r.summary.outwardTaxable.taxablePaise,sign*20000);
    assert.equal(r.summary.outwardTaxable.igstPaise,sign*2300);
    assert.equal(r.amendments.liabilityDifference.taxablePaise,sign*20000);
    assert.ok(r.hsnCheck.reconciliation.every(row=>row.differencePaise===0));
  }
});

test('unknown prior HSN is flagged even for a zero-value correction and never inferred from books', () => {
  const f=fixture(), invoice=document(f,'ACTUAL/1'), original=priorFor(f,invoice,1); delete original.hsnRows;
  save(f,invoice,{originalReported:original});
  for (const month of ['2026-04','2026-05']) {
    const r=report(f,month); assert.equal(r.hsnCheck.complete,false); assert.equal(r.sheets['hsn(b2b)'].length,0);
    assert.equal(r.amendments.hsnIssues.length,1);
  }
  assert.equal(report(f,'2026-05').amendments.difference.taxablePaise,0);
});

test('withdrawal removes all return effects and a replacement contributes exactly once', () => {
  const f=fixture(), invoice=document(f,'ACTUAL/1'), record=save(f,invoice);
  const result=buildAmendmentEvent(f.company,f.vouchers,'withdraw',{amendmentId:record.id,revision:1,requestId:'synthetic-withdraw-00000001',date:'2026-06-02',reference:'UNFILED',basis:'Replace preparation',confirmedUnfiled:true});
  f.company.gst.outwardAmendments.events.push(result.event); f.company.gst.outwardAmendments.revision=result.revision;
  assert.equal(report(f,'2026-04').summary.outwardTaxable.taxablePaise,20000);
  assert.equal(report(f,'2026-04').sheets['b2b,sez,de'][0][2],'ACTUAL/1');
  assert.equal(report(f,'2026-05').sheets.b2ba.length,0); assert.equal(report(f,'2026-05').amendments.difference.taxablePaise,0);
  save(f,invoice); assert.equal(report(f,'2026-05').sheets.b2ba.length,2);
  assert.equal(report(f,'2026-05').amendments.difference.taxablePaise,10000);
});

test('all five official amendment worksheets preserve full multi-rate values, original identities, dates and cell types', async () => {
  const f=fixture();
  const consumer={name:'Synthetic consumer',gstin:''};
  const large=document(f,'LARGE/1',{party:consumer},20000000);
  const documents=[document(f,'B2B/1'),large,document(f,'EXPORT/1',{party:consumer,supplyCategory:'export',exportMode:'igst',placeOfSupply:'96',portCode:'INBOM1',shippingBillNumber:'0000123',shippingBillDate:'2026-04-10'}),
    document(f,'CREDIT/1',{type:'Credit Note',stockEffect:'none',originalDate:'2026-04-01'}),document(f,'UNREG/1',{party:consumer,type:'Debit Note',stockEffect:'none',originalInvoiceId:large.id})];
  for (const invoice of documents) save(f,invoice);
  const r=report(f,'2026-05');
  for (const section of ['b2ba','b2cla','expa','cdnra','cdnura']) {
    assert.equal(r.sheets[section].length,2); assert.equal(r.sheets[section][0].length,columns[section].length);
    assert.equal(worksheetCsv(section,r.sheets[section]).split('\r\n')[0],columns[section].join(','));
    // Reused original numbers in different years are different identities,
    // even when their revised numbers and full values happen to match.
    const dateColumn=columns[section].findIndex(header=>/^Original .*date$/i.test(header));
    assert.ok(dateColumn>=0);
    r.sheets[section].push(...r.sheets[section].map(row=>row.map((value,index)=>index===dateColumn?'09-Apr-2025':value)));
  }
  const scratch=await mkdtemp(path.join(tmpdir(),'financer-amended-xlsx-'));
  try {
    const file=path.join(scratch,'return.xlsx'), expected=path.join(scratch,'expected.json');
    await writeFile(file,await gstrWorkbook(r));
    await writeFile(expected,JSON.stringify({report:r,recalculate:true,cached:[
      {sheet:'b2ba',cell:'C3',value:2},{sheet:'b2ba',cell:'G3',value:'446.00'},{sheet:'b2ba',cell:'N3',value:'400.00'},
      {sheet:'b2cla',cell:'A3',value:2},{sheet:'b2cla',cell:'F3',value:'446000.00'},
      {sheet:'expa',cell:'B3',value:2},{sheet:'expa',cell:'F3',value:'446.00'},
      {sheet:'cdnra',cell:'C3',value:2},{sheet:'cdnra',cell:'K3',value:'446.00'},
      {sheet:'cdnura',cell:'B3',value:2},{sheet:'cdnura',cell:'H3',value:'446.00'},
    ]}));
    const base=fileURLToPath(new URL('../lib/resources/',import.meta.url));
    const {stdout}=await execute(process.env.LEDGERCRAFT_PYTHON || 'python3',[fileURLToPath(new URL('./gst-workbook-check.py',import.meta.url)),file,path.join(base,'GSTR1_Excel_Workbook_Template_V2.2.xlsx'),path.join(base,'gstr1-template.json'),expected],{timeout:120000});
    const checked=JSON.parse(stdout); assert.equal(checked.passed,true);
    if (process.env.FINANCER_TEST_RECALCULATE==='1') assert.equal(checked.recalculated,true);
  } finally { await rm(scratch,{recursive:true,force:true}); }
});

test('mixed-rate invoice and credit corrections produce identical worksheets and signed deltas after normal backup restore', async () => {
  const scratch=await mkdtemp(path.join(tmpdir(),'financer-amended-restore-'));
  try {
    const store=createStore(scratch), {company}=await store.create({name:'Synthetic amendment returns',booksFrom:'2026-04-01'});
    const {registration:reg}=await store.saveGstMaster(company.id,'registration',{...registration,id:undefined,address:'Synthetic address'});
    const {party}=await store.saveGstMaster(company.id,'party',{name:'Synthetic customer',kind:'customer',gstin:gstin('27LMNOP1234Q1Z'),stateCode:'27',address:'Synthetic buyer address'});
    const items=[];
    for (const [rate,hsnSac] of [[500,'010121'],[1800,'85414090']]) items.push((await store.saveGstMaster(company.id,'item',{name:'Synthetic goods '+rate,kind:'goods',hsnSac,unit:'NOS',gstRateBps:rate,pricePaise:10000})).item);
    const payload={type:'Sales',date:'2026-04-10',registrationId:reg.id,partyId:party.id,placeOfSupply:'27',items:items.map(item=>({itemId:item.id,quantity:'1'}))};
    const {invoice}=await store.passGstInvoice(company.id,payload);
    const {invoice:credit}=await store.passGstInvoice(company.id,{...payload,type:'Credit Note',direction:'sales',date:'2026-04-11',originalInvoiceId:invoice.id,stockEffect:'none'});
    await store.saveCreditReview(company.id,creditEvidence(credit.id));
    const f=await store.get(company.id);
    for (const doc of [invoice,credit]) {
      const prior=priorFor(f,doc); prior.number=doc.type==='Sales'?'FILED/1':'FILED/C1';
      const record=save(f,doc,{originalReported:prior});
      await store.saveGstAmendment(company.id,record.request);
    }
    const book=await store.get(company.id), restored=validateTransfer(companyBackup(book.company,book.vouchers));
    for (const month of ['2026-04','2026-05']) assert.deepEqual(returnWorkbook(restored.company,restored.vouchers,reg.id,month),returnWorkbook(book.company,book.vouchers,reg.id,month));
    const may=returnWorkbook(restored.company,restored.vouchers,reg.id,'2026-05');
    assert.equal(may.sheets.b2ba.length,2); assert.equal(may.sheets.cdnra.length,2);
    assert.equal(may.amendments.difference.taxablePaise,0); assert.equal(may.summary.outwardTaxable.igstPaise,0);
    assert.equal(restored.vouchers.length,2);
  } finally { await rm(scratch,{recursive:true,force:true}); }
});
