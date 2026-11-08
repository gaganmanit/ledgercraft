import { applyCreditReview } from "../lib/gst-credit-review.js";
import test from "node:test";
import assert from "node:assert/strict";
import { returnWorkbook, columns, worksheetCsv } from "../lib/gst-returns.js";
import { reconcile2B } from "../lib/gst-reconcile.js";
import { searchHSN } from "../lib/hsn-directory.js";
import { needsResources, HSN_DIRECTORY } from "./helpers/resources.mjs";

const registration={id:"reg",name:"Synthetic company",gstin:"23ABCDE1234F1Z8",stateCode:"23"};
const company={gst:{registrations:[registration]}};
const party={name:"Synthetic party",gstin:"27ABCDE1234F1Z0"};
function review(book, vouchers, doc, declarationDate) {
  return applyCreditReview(book,vouchers,{invoiceId:doc.id,revision:0,requestId:"synthetic-credit-review-001",declarationDate,
    annualReturnStatus:"not-filed",recipientBasis:"incidence-not-passed",adjustmentGround:"excess-value-or-tax",groundConfirmed:true,
    reference:"Synthetic consumer credit and price evidence"}).company;
}
function voucher(number,date,changes={},amount=10000) {
  const id=number.toLowerCase();
  const line={itemId:"item",kind:"goods",name:"Sample, part",hsnSac:"8541",unit:"NOS",gstRateBps:1800,supplyStatus:"taxable",quantity:"1",taxablePaise:amount,igstPaise:Math.round(amount*.18),cgstPaise:0,sgstPaise:0,utgstPaise:0,cessPaise:0,totalPaise:amount+Math.round(amount*.18),taxPaise:Math.round(amount*.18)};
  return {id,date,gst:{id,date,number,type:"Sales",direction:"sales",registration,registrationId:"reg",partyId:"buyer",party,placeOfSupply:"27",supplyCategory:"domestic",items:[line],totals:line,...changes}};
}
test("official HSN lookup includes leading zero, spaced source codes and service codes",async (t) =>{
  if (!needsResources(t, HSN_DIRECTORY)) return;
  assert.equal((await searchHSN("0101")).items[0].code,"0101");
  assert.equal((await searchHSN("230700")).items[0].code,"230700");
  assert.ok((await searchHSN("9983")).items.some(i=>i.kind==="service"));
});
test("GSTR-1 groups B2B, net B2CS, B2CL by historical threshold and preserves source amounts",()=>{
  const unregistered={gstin:"",name:"Consumer"};
  const source=[voucher("SI-1","2026-06-01"),voucher("SI-2","2026-06-02",{party:unregistered},10000001),
    voucher("SI-3","2026-06-02",{party:unregistered}),voucher("CN-1","2026-06-03",{party:unregistered,type:"Credit Note",originalInvoiceId:"si-3",originalNumber:"SI-3",originalDate:"2026-06-02",stockEffect:"none"},5000)];
  const reviewed=review(company,source,source.at(-1).gst,"2026-07-10");
  const report=returnWorkbook(reviewed,source,"reg","2026-06");
  assert.equal(report.sheets["b2b,sez,de"].length,1); assert.equal(report.sheets.b2cl.length,1);
  assert.equal(report.sheets.b2cs[0][4],"50.00"); assert.equal(report.sheets["hsn(b2c)"][0][3],"2");
  assert.deepEqual(report.sheets.docs.map(r=>r[3]).sort(),[1,3]); assert.equal(report.issues.length,0);
  assert.deepEqual(report.sheets["b2b,sez,de"][0].slice(0,5),[party.gstin,party.name,"SI-1","01-Jun-2026","118.00"]);
  assert.equal(worksheetCsv("b2cs",report.sheets.b2cs).split("\r\n")[0],columns.b2cs.join(","));
  const historic = returnWorkbook(company,[voucher("SI-1","2024-06-01",{party:unregistered},10000001)],"reg","2024-06");
  assert.equal(historic.sheets.b2cl.length,0);
  assert.equal(historic.sheets.b2cs.length,1);
});
test("GSTR-2B compares supplier invoices, tax heads, missing entries and explicit exceptions",()=>{
  const v=voucher("PI-1","2026-05-31",{direction:"purchase",type:"Purchase",supplierInvoiceNumber:"ABC/1"});
  const invoice={inum:"ABC/1",dt:"31-05-2026",val:118,itcavl:"N",rsn:"P",items:[{txval:100,igst:18}]};
  const statement={data:{gstin:registration.gstin,rtnprd:"062026",docdata:{b2b:[{ctin:party.gstin,inv:[invoice]}],isd:[{id:"1"}]}}};
  const run=()=>reconcile2B(company,[v],"reg","2026-06",statement);
  assert.equal(run().results[0].status,"Matched");assert.equal(run().results[0].statementITC,"N");assert.equal(run().exceptions.length,1);
  invoice.items[0].igst=17.99;assert.deepEqual(run().results[0].differences,["igst"]);
  statement.data.docdata.b2b[0].inv.push(invoice);assert.equal(run().results[0].status,"Duplicate");
  statement.data.gstin="wrong";assert.throws(run,/GSTIN/);
});

test("HSN reconciliation recomputes B2B and B2C taxable values from the exported worksheets and exposes unclassified credits",()=>{
  const consumer={name:"Consumer",gstin:""};
  const supplies=[voucher("R1","2026-05-01"),voucher("U1","2026-05-02",{party:consumer}),
    voucher("U-CREDIT","2026-05-03",{party:consumer,type:"Credit Note",originalInvoiceId:"u1",originalNumber:"U1",originalDate:"2026-05-02",stockEffect:"none"},1200),
    voucher("R-DEBIT","2026-05-04",{type:"Debit Note",originalInvoiceId:"r1",stockEffect:"none"},550)];
  const reviewed=review(company,supplies,supplies[2].gst,"2026-06-11");
  const normal=returnWorkbook(reviewed,supplies,"reg","2026-05");
  assert.deepEqual(normal.hsnCheck.reconciliation,[{type:"b2b",supplyPaise:10550,hsnPaise:10550,differencePaise:0},{type:"b2c",supplyPaise:8800,hsnPaise:8800,differencePaise:0}]);
  supplies[2].gst.originalInvoiceId="unresolved";
  const gap=returnWorkbook(company,supplies,"reg","2026-05");
  assert.equal(gap.hsnCheck.reconciliation[1].differencePaise,0);
  assert.equal(gap.creditReviews[0].eligible,false);
  assert.equal(gap.issues[0].id,"u-credit");
});

test("a late credit leaves the issued note and books intact and reduces no working return values",()=>{
  const consumer={name:"Consumer",gstin:""};
  const original=voucher("S1","2026-04-02",{party:consumer});
  const note=voucher("C1","2027-12-01",{party:consumer,type:"Credit Note",originalInvoiceId:original.id,originalNumber:"S1",originalDate:original.date,stockEffect:"quantity"},1000);
  const vouchers=[original,note],reviewed=review(company,vouchers,note.gst,"2028-01-11");
  const report=returnWorkbook(reviewed,vouchers,"reg","2027-12");
  assert.equal(report.creditReviews[0].eligible,false);
  assert.equal(report.creditReviews[0].deadline,"2027-11-30");
  assert.equal(report.sheets.docs.length,1);
  assert.equal(report.evidence[0].totalPaise,-1180);
  assert.equal(report.bookSummary.outwardTaxable.igstPaise,-180);
  assert.equal(report.summary.outwardTaxable.igstPaise,0);
  for (const sheet of ["b2cs","cdnur","exemp","hsn(b2c)"]) assert.deepEqual(report.sheets[sheet],[]);
});

test("goods and service code search pages the entire selectable catalogue and keeps exact leading-zero codes first",async (t) =>{
  if (!needsResources(t, HSN_DIRECTORY)) return;
  const first=await searchHSN("01",{kind:"goods",selectable:true,limit:10,offset:0});
  const next=await searchHSN("01",{kind:"goods",selectable:true,limit:10,offset:10});
  assert.ok(first.total>20);assert.equal(next.total,first.total);
  assert.equal(first.items[0].code,"0101");assert.equal(next.items.length,10);
  assert.ok(next.items.every(i=>!first.items.some(f=>f.code===i.code)));
  const services=await searchHSN("9983",{kind:"service",selectable:true});
  assert.equal(services.items[0].code,"9983");
  assert.ok(services.items.every(x=>x.kind==="service"));
  await assert.rejects(searchHSN("01",{offset:-1}),/valid directory page/);
});

// ---------------------------------------------------------------- GSTR-1 upload JSON
import { gstr1Json, gstr1JsonSummary, gstr1Export } from "../lib/gst-json.js";
import { handleReturnRoute } from "../lib/gst-return-routes.js";

const jsonParty=(name,gstin)=>({name,gstin});
function jsonLine(gstRateBps,taxablePaise,{inter=false,zeroTax=false,supplyStatus="taxable",hsnSac="8541",name="Solar cell",unit="NOS",quantity="1",kind="goods"}={}) {
  const tax=zeroTax||supplyStatus!=="taxable"&&supplyStatus!=="zero-rated" ? 0 : taxablePaise*gstRateBps/10000;
  const igstPaise=inter?tax:0, cgstPaise=inter?0:tax/2, sgstPaise=inter?0:tax/2;
  return {itemId:"item-"+hsnSac,kind,name,hsnSac,unit,gstRateBps,supplyStatus,quantity,taxablePaise,igstPaise,cgstPaise,sgstPaise,utgstPaise:0,cessPaise:0,taxPaise:tax,totalPaise:taxablePaise+tax};
}
function jsonDoc(number,date,party,placeOfSupply,items,changes={}) {
  const id=number.toLowerCase();
  const totals=Object.fromEntries(["taxablePaise","igstPaise","cgstPaise","sgstPaise","utgstPaise","cessPaise","taxPaise","totalPaise"].map(k=>[k,items.reduce((s,l)=>s+l[k],0)]));
  return {id,date,type:changes.type||"Sales",number,gst:{id,date,number,type:"Sales",direction:"sales",registration,registrationId:"reg",partyId:"p-"+(party.gstin||party.name),party,placeOfSupply,supplyCategory:"domestic",stockEffect:"quantity",items,totals,...changes}};
}
function jsonBook() {
  const local=jsonParty("Local dealer","23AAACL1234C1Z5"), outer=jsonParty("Mumbai dealer",party.gstin), consumer=jsonParty("Consumer",""), overseas=jsonParty("Overseas buyer","");
  const vouchers=[
    jsonDoc("SI-1","2026-06-01",local,"23",[jsonLine(1800,10000),jsonLine(500,2000,{hsnSac:"8501",name:"Motor"})]),
    jsonDoc("SI-2","2026-06-02",outer,"27",[jsonLine(1800,50000,{inter:true})]),
    jsonDoc("SI-3","2026-06-03",consumer,"27",[jsonLine(1800,10000000,{inter:true})]),
    jsonDoc("SI-4","2026-06-04",consumer,"23",[jsonLine(1200,3000,{hsnSac:"8504",name:"Inverter"}),jsonLine(0,1000,{supplyStatus:"nil-rated",hsnSac:"0401",name:"Milk",unit:"LTR"})]),
    jsonDoc("SI-5","2026-06-05",consumer,"27",[jsonLine(1800,4000,{inter:true})]),
    jsonDoc("SI-6","2026-06-06",consumer,"23",[jsonLine(1200,2000,{hsnSac:"8504",name:"Inverter"})]),
    jsonDoc("SI-9","2026-06-09",local,"23",[jsonLine(0,1500,{supplyStatus:"exempt",hsnSac:"9983",kind:"service",name:"Consulting"})]),
    jsonDoc("CN-1","2026-06-20",outer,"27",[jsonLine(1800,5000,{inter:true})],{type:"Credit Note",originalInvoiceId:"si-2",originalNumber:"SI-2",originalDate:"2026-06-02",stockEffect:"none"}),
    jsonDoc("EX-1","2026-06-10",overseas,"96",[jsonLine(1800,20000,{inter:true,supplyStatus:"zero-rated"})],{supplyCategory:"export",exportMode:"payment",portCode:"INNSA1",shippingBillNumber:"1234567",shippingBillDate:"2026-06-12"}),
    jsonDoc("EX-2","2026-06-11",overseas,"96",[jsonLine(1800,30000,{inter:true,zeroTax:true,supplyStatus:"zero-rated"})],{supplyCategory:"export",exportMode:"lut"}),
    jsonDoc("SZ-1","2026-06-12",jsonParty("SEZ unit","23AAACS1234C1Z9"),"23",[jsonLine(1800,7000,{inter:true,zeroTax:true,supplyStatus:"zero-rated"})],{supplyCategory:"sez",exportMode:"lut"}),
    jsonDoc("SZ-2","2026-06-13",jsonParty("SEZ developer","27AAACS1234C1Z2"),"27",[jsonLine(1800,8000,{inter:true,supplyStatus:"zero-rated"})],{supplyCategory:"sez",exportMode:"payment"}),
  ];
  const note=vouchers.find(v=>v.number==="CN-1").gst;
  const books={gst:{registrations:[registration],turnoverByYear:[{pan:"ABCDE1234F",year:"2026",band:"up-to-5cr"}]}};
  const reviewed=applyCreditReview(books,vouchers,{invoiceId:note.id,revision:0,requestId:"synthetic-json-credit-001",declarationDate:"2026-07-10",
    annualReturnStatus:"not-filed",recipientBasis:"reversed",adjustmentGround:"excess-value-or-tax",groundConfirmed:true,reference:"Synthetic recipient reversal evidence"}).company;
  return {company:reviewed,vouchers};
}
const toPaise=n=>Math.round(n*100);
const sheetSum=(book,sheet,header)=>book.sheets[sheet].reduce((s,row)=>s+toPaise(Number(row[columns[sheet].indexOf(header)])),0);
const items=(section,json)=>(json[section]||[]).flatMap(entry=>entry.inv||entry.nt||[entry]).flatMap(doc=>doc.itms?doc.itms.map(i=>i.itm_det||i):[doc]);
const headSum=(list,field)=>list.reduce((s,i)=>s+toPaise(i[field]||0),0);

test("GSTR-1 JSON carries every workbook section with equal totals, GSTN dates, rates and tax heads",()=>{
  const {company:c,vouchers}=jsonBook();
  const book=returnWorkbook(c,vouchers,"reg","2026-06");
  assert.deepEqual(book.issues,[]);
  const json=gstr1Json(c,vouchers,"reg","2026-06");
  assert.deepEqual(Object.keys(json).slice(0,6),["gstin","fp","version","hash","gt","cur_gt"]);
  assert.equal(json.gstin,registration.gstin); assert.equal(json.fp,"062026"); assert.equal(json.hash,"hash");
  for (const [section,sheet] of [["b2b","b2b,sez,de"],["b2cl","b2cl"],["b2cs","b2cs"],["cdnr","cdnr"],["exp","exp"]]) {
    assert.ok(book.sheets[sheet].length>0,section);
    assert.equal(headSum(items(section,json),"txval"),sheetSum(book,sheet,"Taxable Value"),section+" taxable");
    assert.equal(headSum(items(section,json),"csamt"),sheetSum(book,sheet,"Cess Amount"),section+" cess");
  }
  // Tax heads across the outward sections net to the workbook's liability summary.
  const sections=["b2b","b2cl","b2cs","exp"], net=field=>sections.reduce((s,n)=>s+headSum(items(n,json),field),0)-headSum(items("cdnr",json),field);
  const s=book.summary;
  assert.equal(net("iamt"),s.outwardTaxable.igstPaise+s.zeroRated.igstPaise);
  assert.equal(net("camt"),s.outwardTaxable.cgstPaise+s.zeroRated.cgstPaise);
  assert.equal(net("samt"),s.outwardTaxable.sgstPaise+s.outwardTaxable.utgstPaise);
  // Invoice values match the worksheet per document.
  const b2b=Object.fromEntries(json.b2b.flatMap(p=>p.inv.map(i=>[i.inum,{...i,ctin:p.ctin}])));
  assert.deepEqual(b2b["SI-1"],{inum:"SI-1",idt:"01-06-2026",val:139,pos:"23",rchrg:"N",inv_typ:"R",ctin:"23AAACL1234C1Z5",
    itms:[{num:1,itm_det:{rt:18,txval:100,camt:9,samt:9,csamt:0}},{num:2,itm_det:{rt:5,txval:20,camt:0.5,samt:0.5,csamt:0}}]});
  assert.deepEqual(b2b["SI-2"].itms,[{num:1,itm_det:{rt:18,txval:500,iamt:90,csamt:0}}]);
  assert.equal(b2b["SZ-1"].inv_typ,"SEWOP"); assert.deepEqual(b2b["SZ-1"].itms[0].itm_det,{rt:18,txval:70,iamt:0,csamt:0});
  assert.equal(b2b["SZ-2"].inv_typ,"SEWP"); assert.equal(b2b["SZ-2"].itms[0].itm_det.iamt,14.4);
  assert.equal(b2b["SI-9"],undefined);
  assert.deepEqual(json.b2cl,[{pos:"27",inv:[{inum:"SI-3",idt:"03-06-2026",val:118000,itms:[{num:1,itm_det:{rt:18,txval:100000,iamt:18000,csamt:0}}]}]}]);
  assert.deepEqual(json.b2cs.toSorted((a,b)=>a.pos.localeCompare(b.pos)),[
    {sply_ty:"INTRA",pos:"23",typ:"OE",rt:12,txval:50,camt:3,samt:3,csamt:0},
    {sply_ty:"INTER",pos:"27",typ:"OE",rt:18,txval:40,iamt:7.2,csamt:0}]);
  assert.deepEqual(json.cdnr,[{ctin:party.gstin,nt:[{ntty:"C",nt_num:"CN-1",nt_dt:"20-06-2026",val:59,pos:"27",rchrg:"N",inv_typ:"R",itms:[{num:1,itm_det:{rt:18,txval:50,iamt:9,csamt:0}}]}]}]);
  assert.equal(json.cdnur,undefined);
  const exp=Object.fromEntries(json.exp.map(e=>[e.exp_typ,e.inv]));
  assert.deepEqual(exp.WPAY,[{inum:"EX-1",idt:"10-06-2026",val:236,sbpcode:"INNSA1",sbnum:"1234567",sbdt:"12-06-2026",itms:[{txval:200,rt:18,iamt:36,csamt:0}]}]);
  assert.deepEqual(exp.WOPAY,[{inum:"EX-2",idt:"11-06-2026",val:300,itms:[{txval:300,rt:18,iamt:0,csamt:0}]}]);
  const dates=JSON.stringify(json).match(/"(idt|nt_dt|sbdt)":"[^"]*"/g);
  assert.ok(dates.length===9 && dates.every(d=>/"\d{2}-\d{2}-\d{4}"$/.test(d)));
  for (const item of sections.flatMap(n=>items(n,json))) assert.equal(typeof item.rt,"number");
  // Table 8, Table 12 split and Table 13 ranges.
  assert.deepEqual(json.nil,{inv:[{sply_ty:"INTRAB2B",expt_amt:15,nil_amt:0,ngsup_amt:0},{sply_ty:"INTRAB2C",expt_amt:0,nil_amt:10,ngsup_amt:0}]});
  assert.equal(json.hsn.data,undefined);
  for (const side of ["b2b","b2c"]) {
    const rows=json.hsn["hsn_"+side], sheet="hsn("+side+")";
    assert.equal(rows.length,book.sheets[sheet].length);
    assert.deepEqual(rows.map(r=>r.num),rows.map((_,i)=>i+1));
    for (const [field,header] of [["txval","Taxable Value"],["iamt","Integrated Tax Amount"],["camt","Central Tax Amount"],["samt","State/UT Tax Amount"],["csamt","Cess Amount"]]) assert.equal(headSum(rows,field),sheetSum(book,sheet,header),sheet+" "+field);
  }
  assert.deepEqual(json.hsn.hsn_b2c.find(r=>r.hsn_sc==="0401"),{num:json.hsn.hsn_b2c.find(r=>r.hsn_sc==="0401").num,hsn_sc:"0401",desc:"Milk",uqc:"LTR",qty:1,rt:0,txval:10,iamt:0,camt:0,samt:0,csamt:0});
  assert.equal(json.hsn.hsn_b2b.find(r=>r.hsn_sc==="9983").uqc,"NA"); assert.equal(json.hsn.hsn_b2b.find(r=>r.hsn_sc==="9983").qty,0);
  const ranges=json.doc_issue.doc_det.flatMap(d=>d.docs.map(r=>[d.doc_num,r.from,r.to,r.totnum,r.cancel,r.net_issue]));
  assert.deepEqual(ranges.toSorted(),[[1,"EX-1","EX-2",2,0,2],[1,"SI-1","SI-6",6,0,6],[1,"SI-9","SI-9",1,0,1],[1,"SZ-1","SZ-2",2,0,2],[5,"CN-1","CN-1",1,0,1]]);
  assert.deepEqual(json.doc_issue.doc_det.map(d=>d.doc_num),[1,5]);
  assert.deepEqual(json.doc_issue.doc_det[0].docs.map(r=>r.num),[1,2,3,4]);
  assert.equal(ranges.reduce((s,r)=>s+r[3],0),book.sheets.docs.reduce((s,r)=>s+r[3],0));
});

test("GSTR-1 JSON summary reports section counts and paise totals, and a workbook alone derives the same tax heads",()=>{
  const {company:c,vouchers}=jsonBook();
  const book=returnWorkbook(c,vouchers,"reg","2026-06");
  const {json,summary,fileName}=gstr1Export(c,vouchers,"reg","2026-06");
  assert.equal(fileName,"GSTR1_23ABCDE1234F1Z8_062026.json");
  assert.deepEqual(summary.issues,[]); assert.deepEqual(summary.warnings,[]); assert.equal(summary.hsnComplete,true);
  assert.equal(summary.ready,true); assert.equal(summary.taxHeads,"booked");
  assert.deepEqual(summary.sections.b2b,{documents:4,items:5,invoiceValuePaise:13900+59000+7000+9440,taxablePaise:77000,igstPaise:10440,cgstPaise:950,sgstPaise:950,cessPaise:0,taxPaise:12340});
  assert.equal(summary.sections.b2cs.documents,2); assert.equal(summary.sections.exp.documents,2); assert.equal(summary.sections.cdnr.taxablePaise,5000);
  assert.equal(summary.sections.b2ba.documents,0);
  assert.equal(summary.hsn.layout,"split"); assert.equal(summary.hsn.b2c.taxablePaise,sheetSum(book,"hsn(b2c)","Taxable Value"));
  assert.deepEqual(summary.docIssue,{categories:2,ranges:5,documents:12,cancelled:0,netIssued:12});
  assert.deepEqual(summary.nil,{rows:2,nilPaise:1000,exemptPaise:1500,nonGstPaise:0});
  assert.deepEqual(gstr1JsonSummary(book,{company:c,vouchers}).sections,summary.sections);
  const derived=gstr1Export(book);
  assert.equal(derived.summary.taxHeads,"derived");
  assert.deepEqual(derived.json,json);
});

test("GSTR-1 JSON refuses tax heads that contradict the place of supply and uses one HSN list before May 2025",()=>{
  const {company:c,vouchers}=jsonBook();
  const wrong=structuredClone(vouchers), line=wrong[0].gst.items[0];
  Object.assign(line,{igstPaise:1800,cgstPaise:0,sgstPaise:0});
  assert.throws(()=>gstr1Json(c,wrong,"reg","2026-06"),/SI-1: the booked tax heads do not match an intra-State supply/);
  const april=[jsonDoc("A-1","2025-04-02",jsonParty("Local dealer","23AAACL1234C1Z5"),"23",[jsonLine(1800,10000)]),jsonDoc("A-2","2025-04-03",jsonParty("Consumer",""),"23",[jsonLine(1800,2000)])];
  const json=gstr1Json(company,april,"reg","2025-04");
  assert.equal(json.fp,"042025");
  assert.deepEqual(json.hsn,{data:[{num:1,hsn_sc:"8541",desc:"Solar cell",uqc:"NOS",qty:2,rt:18,txval:120,iamt:0,camt:10.8,samt:10.8,csamt:0}]});
  assert.throws(()=>gstr1Json(company,april,"reg","2025-13"),/valid return month/);
});

test("the return route downloads the GSTR-1 JSON as an attachment and serves its summary",async (t)=>{
  if (!needsResources(t, HSN_DIRECTORY)) return;
  const {company:c,vouchers}=jsonBook(), books={company:{...c,id:"synthetic-json"},vouchers};
  async function get(path) {
    const response={};
    const res={writeHead:(code,headers)=>Object.assign(response,{code,headers}),end:body=>{response.body=String(body);}};
    const url=new URL("http://localhost/api/companies/synthetic-json/gst-returns/"+path+"?registration=reg&month=2026-06");
    const handled=await handleReturnRoute({req:{method:"GET"},res,parts:url.pathname.split("/").filter(Boolean),url,dataDir:"/synthetic",store:{snapshot:async()=>books},
      readBody:async()=>({}),send:(_res,code,body)=>Object.assign(response,{code,body:JSON.stringify(body),headers:{"content-type":"application/json"}})});
    assert.equal(handled,true);
    return response;
  }
  const file=await get("json");
  assert.equal(file.code,200); assert.match(file.headers["content-type"],/^application\/json/);
  assert.equal(file.headers["content-disposition"],'attachment; filename="GSTR1_23ABCDE1234F1Z8_062026.json"');
  const json=JSON.parse(file.body);
  assert.equal(json.fp,"062026"); assert.equal(json.b2b.length,4);
  const summary=await get("json/summary");
  assert.equal(summary.code,200);
  const body=JSON.parse(summary.body);
  assert.equal(body.fileName,"GSTR1_23ABCDE1234F1Z8_062026.json"); assert.equal(body.sections.b2cl.documents,1);
});

test("GSTR-1 JSON nets a small B2C credit into B2CS with booked heads and flags the negative rows before download",()=>{
  const consumer=jsonParty("Consumer","");
  const vouchers=[jsonDoc("SI-1","2026-05-20",consumer,"23",[jsonLine(1800,10000)]),
    jsonDoc("CN-1","2026-06-05",consumer,"23",[jsonLine(1800,3000)],{type:"Credit Note",originalInvoiceId:"si-1",originalNumber:"SI-1",originalDate:"2026-05-20",stockEffect:"none"})];
  const reviewed=review(company,vouchers,vouchers[1].gst,"2026-07-10");
  const {json,summary}=gstr1Export(reviewed,vouchers,"reg","2026-06");
  assert.deepEqual(json.b2cs,[{sply_ty:"INTRA",pos:"23",typ:"OE",rt:18,txval:-30,camt:-2.7,samt:-2.7,csamt:0}]);
  assert.equal(summary.sections.b2cs.taxablePaise,-3000);
  assert.ok(summary.warnings.some(w=>w.path==="b2cs[0].txval"));
  assert.ok(summary.warnings.some(w=>w.path.startsWith("hsn.hsn_b2c[0]")));
  assert.equal(summary.ready,false);
  assert.deepEqual(json.doc_issue.doc_det,[{doc_num:5,docs:[{num:1,from:"CN-1",to:"CN-1",totnum:1,cancel:0,net_issue:1}]}]);
});
