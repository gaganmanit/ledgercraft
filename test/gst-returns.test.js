import test from "node:test";
import assert from "node:assert/strict";
import { returnWorkbook, columns, worksheetCsv } from "../lib/gst-returns.js";
import { reconcile2B } from "../lib/gst-reconcile.js";
import { searchHSN } from "../lib/hsn-directory.js";

const registration={id:"reg",name:"Synthetic company",gstin:"23ABCDE1234F1Z8",stateCode:"23"};
const company={gst:{registrations:[registration]}};
const party={name:"Synthetic party",gstin:"27ABCDE1234F1Z0"};
function voucher(id,date,changes={},amount=10000) {
  const line={itemId:"item",kind:"goods",name:"Sample, part",hsnSac:"8541",unit:"NOS",gstRateBps:1800,supplyStatus:"taxable",quantity:"1",taxablePaise:amount,igstPaise:Math.round(amount*.18),cgstPaise:0,sgstPaise:0,utgstPaise:0,cessPaise:0,totalPaise:amount+Math.round(amount*.18),taxPaise:Math.round(amount*.18)};
  return {id,date,gst:{id,date,number:id,type:"Sales",direction:"sales",registration,registrationId:"reg",party,placeOfSupply:"27",supplyCategory:"domestic",items:[line],totals:line,...changes}};
}
test("official HSN lookup includes leading zero, spaced source codes and service codes",async()=>{
  assert.equal((await searchHSN("0101")).items[0].code,"0101");
  assert.equal((await searchHSN("230700")).items[0].code,"230700");
  assert.ok((await searchHSN("9983")).items.some(i=>i.kind==="service"));
});
test("GSTR-1 groups B2B, net B2CS, B2CL by historical threshold and preserves source amounts",()=>{
  const unregistered={gstin:"",name:"Consumer"};
  const source=[voucher("SI-1","2026-06-01"),voucher("SI-2","2026-06-02",{party:unregistered},10000001),
    voucher("SI-3","2026-06-02",{party:unregistered}),voucher("CN-1","2026-06-03",{party:unregistered,type:"Credit Note",originalInvoiceId:"SI-3",stockEffect:"none"},5000)];
  const report=returnWorkbook(company,source,"reg","2026-06");
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
    voucher("U-CREDIT","2026-05-03",{party:consumer,type:"Credit Note",originalInvoiceId:"U1",stockEffect:"none"},1200),
    voucher("R-DEBIT","2026-05-04",{type:"Debit Note",originalInvoiceId:"R1",stockEffect:"none"},550)];
  const normal=returnWorkbook(company,supplies,"reg","2026-05");
  assert.deepEqual(normal.hsnCheck.reconciliation,[{type:"b2b",supplyPaise:10550,hsnPaise:10550,differencePaise:0},{type:"b2c",supplyPaise:8800,hsnPaise:8800,differencePaise:0}]);
  supplies[2].gst.originalInvoiceId="unresolved";
  const gap=returnWorkbook(company,supplies,"reg","2026-05");
  assert.equal(gap.hsnCheck.reconciliation[1].differencePaise,-1200);
  assert.equal(gap.issues[0].id,"U-CREDIT");
});

test("goods and service code search pages the entire selectable catalogue and keeps exact leading-zero codes first",async()=>{
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
