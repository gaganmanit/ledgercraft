import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { readOriginalSection } from "../public/gst-filed-source.js";
import { start } from "../server.js";
import { createStore } from "../lib/store.js";
import { gstinCheckDigit } from "../lib/gst.js";
import { exchangeDefaults } from "../lib/gst-exchange.js";

const gstin = first14 => first14 + gstinCheckDigit(first14);
const seller = gstin("23ABCDE1234F1Z"), buyer = gstin("27PQRST5678L1Z");
function fileFixture() {
  const inv = {inum:"FILE-04",idt:"20-04-2026",val:118,pos:"27",rchrg:"N",inv_typ:"R",
    itms:[{num:1,itm_det:{rt:18,txval:90.25,iamt:16.25}},{num:2,itm_det:{rt:18,txval:9.75,iamt:1.75}}]};
  return {gstin:seller,fp:"042026",b2b:[{ctin:buyer,inv:[inv]}]};
}

test("selects literal prior GSTR-1 rate amounts and filters other sections, invalid and unsupported documents",()=>{
  const doc=fileFixture(); const input=doc.b2b[0].inv[0];
  doc.b2b[0].inv.push({...input,inum:"ECO",etin:buyer},{...input,inum:"BAD",idt:"31-04-2026"},{...input,inum:"CUT",flag:"D"});
  doc.b2ba=[{ctin:buyer,inv:[{...input,oinum:"ANOTHER"}]}];
  const {records,period}=readOriginalSection(doc,seller,"b2b");
  assert.equal(period,"2026-04"); assert.equal(records.length,4);
  assert.deepEqual(records[0].original.rates,[{gstRateBps:1800,taxablePaise:10000,igstPaise:1800,cgstPaise:0,sgstPaise:0,utgstPaise:0,cessPaise:0}]);
  assert.equal(records[0].original.recipientName,""); assert.equal(records[0].original.invoiceValuePaise,11800);
  assert.ok(records.slice(1).every(row=>row.problem && !row.original));
  const sez=fileFixture();
  sez.b2b[0].inv[0].inv_typ="SEWOP";
  assert.equal(readOriginalSection(sez,seller,"b2b").records[0].original.invoiceType,"SEZ supplies without payment");
  assert.throws(()=>readOriginalSection(doc,buyer,"b2b"),/supplier GSTIN/);
  assert.throws(()=>readOriginalSection({...doc,fp:"132026"},seller,"b2b"),/period/);
  assert.throws(()=>readOriginalSection({...doc,docdata:{}},seller,"b2b"),/GSTR-1/);
});

// This record uses the provider's published GET/SAVE GSTR-1 export example, including
// its stated value, rate breakup and bill. It is an interchange example, not a real filing.
// https://sandbox-docs.readme.io/reference/save-gstr-1-api
test("preserves a published export record's original amounts, bill and calendar date",()=>{
  const sample={gstin:"27AHQPA7588L1ZJ", fp:"122016", exp:[{exp_typ:"WPAY",inv:[{inum:"81542",idt:"12-02-2016",val:995048.36,
    sbpcode:"ASB991",sbnum:"7896542",sbdt:"04-10-2016",itms:[{txval:10000,rt:5,iamt:833.33,csamt:100}]}]}]};
  const report=readOriginalSection({data:sample},sample.gstin,"exp"), original=report.records[0].original;
  assert.equal(report.period,"2016-12"); assert.equal(original.invoiceValuePaise,99504836);
  assert.equal(original.shippingBillNumber,"7896542"); assert.equal(original.shippingBillDate,"2016-10-04");
  assert.equal(original.portCode,"ASB991");assert.equal(original.rates[0].igstPaise,83333);assert.equal(original.rates[0].cessPaise,10000);
});

test("reads unregistered notes, credit flags and separately identifies UTGST on registered supplies",()=>{
  const doc=fileFixture(), ut=gstin("04ABCDE1234F1Z");
  doc.gstin=ut;
  doc.b2b[0].inv[0].itms=[{itm_det:{rt:18,txval:100,camt:9,samt:9}}];
  const rates=readOriginalSection(doc,ut,"b2b").records[0].original.rates[0];
  assert.equal(rates.utgstPaise,900); assert.equal(rates.sgstPaise,0);
  doc.cdnur=[{ntty:"C",nt_num:"C/01",nt_dt:"05-04-2026",typ:"EXPWOP",val:100,itms:[{itm_det:{rt:5,txval:100}}]}];
  const note=readOriginalSection(doc,ut,"cdnur").records[0].original;
  assert.equal(note.noteType,"C"); assert.equal(note.exportType,"WOPAY"); assert.equal(note.placeOfSupply,"96");
});

test("binds the prior filing to exact bytes and a source row through concurrent save, native and full-source Tally backups",async()=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),"financer-outward-sources-"));
  const server=await start({port:0,dataDir}), origin="http://127.0.0.1:"+server.address().port, store=createStore(dataDir);
  const post=async(route,body,status)=>{
    const response=await fetch(origin+route,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const value=await response.json(); assert.equal(response.status,status,JSON.stringify(value.error)); return value;
  };
  const get=async(route)=>(await fetch(origin+route)).json();
  try {
    const native=await store.create({name:"Filed return source",booksFrom:"2026-04-01"});
    const files=await Promise.all(["Masters.xml","DayBook.xml"].map(async name=>({name,base64:(await readFile(new URL("./fixtures/tally/"+name,import.meta.url))).toString("base64")})));
    const preview=await post("/api/tally/preview",{files,companyName:"Public migration with outward source",booksFrom:"2026-04-01"},200);
    const migrated=await post("/api/tally/commit",{token:preview.token,acknowledge:true},201);
    for (const {company} of [native,migrated]) {
      const cid=company.id,base="/api/companies/"+cid, endpoint=base+"/gst/amendments";
      const {registration}=await store.saveGstMaster(cid,"registration",{gstin:seller,stateCode:"23",name:"Exporter",address:"Local test address"});
      const {party}=await store.saveGstMaster(cid,"party",{gstin:buyer,stateCode:"27",name:"Public sample buyer",kind:"customer",address:"Local buyer"});
      const {item}=await store.saveGstMaster(cid,"item",{name:"Fastener",kind:"goods",hsnSac:"731815",unit:"NOS",gstRateBps:1800});
      const {invoice}=await store.passGstInvoice(cid,{type:"Sales",date:"2026-04-20",number:"BOOK-04",registrationId:registration.id,partyId:party.id,placeOfSupply:"27",items:[{itemId:item.id,quantity:"1",unitPricePaise:20000}]});
      const before=(await store.snapshot(cid)).vouchers;
      const raw=Buffer.from("\ufeff"+JSON.stringify(fileFixture(),null,2)+"\r\n");
      const hash=createHash("sha256").update(raw).digest("hex");
      const {original,key}=readOriginalSection(fileFixture(),seller,"b2b").records[0];
      const src={fileName:"Prior filed April.json",sha256:hash,bytes:raw.length,sourcePeriod:"2026-04",section:"b2b",documentKey:key};
      const input={requestId:"file-correction-"+cid,revision:0,invoiceId:invoice.id,originalPeriod:"2026-04",amendmentPeriod:"2026-05",date:"2026-06-02",filingDate:"2026-06-08",annualReturnStatus:"not-filed",originalReported:original,
        originalFiling:{form:"GSTR-1",reference:"Public April example",filedDate:"2026-05-08",confirmedFiled:true,source:src},evidence:{accurateBooksConfirmed:true,reportedSnapshotConfirmed:true,basis:"April return understated one posted sale",documentReference:"April filing and posted invoice"}};
      const expected=await post(endpoint+"/preview",input,200);
      assert.equal(expected.record.delta.taxablePaise,10000);assert.equal(expected.record.delta.igstPaise,1800);
      const altered={...input,originalReported:{...original,invoiceValuePaise:12000}};
      const invalid=await post(endpoint+"/preview",altered,200);
      await post(endpoint+"/save",{...altered,previewHash:invalid.previewHash,sourceFileBase64:raw.toString("base64")},400);
      await post(endpoint+"/save",{...input,previewHash:expected.previewHash,sourceFileBase64:Buffer.from("{}").toString("base64")},400);
      assert.equal((await store.snapshot(cid)).company.gst.outwardAmendments,undefined);
      const save={...input,previewHash:expected.previewHash,sourceFileBase64:raw.toString("base64")};
      const both=await Promise.all([post(endpoint+"/save",save,201),post(endpoint+"/save",save,201)]);
      assert.equal(both[0].record.id,both[1].record.id);
      assert.equal((await store.snapshot(cid)).company.gst.outwardAmendments.records.length,1);
      assert.deepEqual((await store.snapshot(cid)).vouchers,before);
      const download=async id=>{
        const res=await fetch(origin+"/api/companies/"+id+"/gst-filed-source/"+hash);
        assert.equal(res.status,200);assert.deepEqual(Buffer.from(await res.arrayBuffer()),raw);
      };
      await download(cid);
      const returnsUrl=base+"/gst-returns?registration="+registration.id+"&month=2026-05";
      const firstReport=await get(returnsUrl);
      assert.equal(firstReport.sheets.b2ba.length,1);
      const disposition={amendmentId:both[0].record.id,revision:1,requestId:"withdraw-"+cid,
        date:"2026-06-05",reference:"Test review",basis:"Replace an unfiled entry with its reviewed version",confirmedUnfiled:true};
      await post(endpoint+"/events/withdraw",disposition,201);
      const removed=await get(returnsUrl);
      assert.deepEqual(removed.sheets.b2ba,[]); assert.equal(removed.amendments.liabilityDifference.igstPaise,0);
      const replacement={...input,requestId:"replacement-"+cid,revision:2,date:"2026-06-06"};
      const next=await post(endpoint+"/preview",replacement,200);
      const active=await post(endpoint+"/save",{...replacement,previewHash:next.previewHash,sourceFileBase64:raw.toString("base64")},201);
      await post(endpoint+"/events/record-filing",{amendmentId:active.record.id,revision:3,requestId:"filed-example-"+cid,
        date:"2026-06-09",reference:"Example acknowledgement",basis:"Reviewed included record",
        filing:{confirmedFiled:true,form:"GSTR-1",period:"2026-05",filedDate:"2026-06-08",reference:"Example acknowledgement"}},201);
      await post(endpoint+"/events/withdraw",{...disposition,revision:4,requestId:"withdraw-again-"+cid,amendmentId:active.record.id,date:"2026-06-10"},400);
      const finalReport=await get(returnsUrl);
      assert.equal(finalReport.sheets.b2ba.length,1); assert.equal(finalReport.amendments.liabilityDifference.igstPaise,1800);
      const backup=await get(base+"/backup"); assert.ok(backup.gstStatementFiles[hash]);
      await post("/api/import",{...backup,gstStatementFiles:{}},400);
      await post("/api/import",{...backup,gstStatementFiles:{[hash]:"AAAA"}},400);
      const restored=await post("/api/import",backup,201);await download(restored.company.id);
      assert.deepEqual(restored.company.gst.outwardAmendments,backup.company.gst.outwardAmendments);
      assert.deepEqual(restored.vouchers,before);
    }
  } finally {await new Promise(done=>server.close(done));await rm(dataDir,{recursive:true,force:true});}
});

test("export shipping details carry through the original voucher, return worksheet, IRP defaults and restore",async()=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),"financer-export-record-"));
  try {
    const store=createStore(dataDir), {company}=await store.create({name:"Shipping test",booksFrom:"2026-04-01"}), cid=company.id;
    const {registration}=await store.saveGstMaster(cid,"registration",{name:"Export sample",address:"Local address",stateCode:"23",gstin:seller});
    const {party}=await store.saveGstMaster(cid,"party",{name:"Overseas sample",address:"Sample destination",stateCode:"96",kind:"customer"});
    const {item}=await store.saveGstMaster(cid,"item",{name:"Export fastener",kind:"goods",hsnSac:"731815",unit:"NOS",gstRateBps:1800});
    const input={type:"Sales",date:"2026-05-26",supplyCategory:"export",exportMode:"with-payment",registrationId:registration.id,partyId:party.id,placeOfSupply:"96",
      portCode:"inbom4",shippingBillNumber:"0012345",shippingBillDate:"2026-05-27",destinationCountry:"gb",items:[{itemId:item.id,quantity:"1",unitPricePaise:20000,supplyStatus:"zero-rated"}]};
    await assert.rejects(store.previewGstInvoice(cid,{...input,shippingBillDate:"2026-02-30"}),/shipping bill date/);
    const {invoice}=await store.passGstInvoice(cid,input);
    assert.equal(invoice.destinationCountry,"GB"); assert.equal(invoice.portCode,"INBOM4");
    assert.deepEqual(exchangeDefaults(invoice).export,{countryCode:"GB",portCode:"INBOM4",shippingBillDate:"2026-05-27",shippingBillNumber:"0012345"});
    const snapshot=await store.snapshot(cid);
    const {returnWorkbook}=await import("../lib/gst-returns.js");
    const {companyBackup,importCompany}=await import("../lib/transfer.js");
    const row=returnWorkbook(snapshot.company,snapshot.vouchers,registration.id,"2026-05").sheets.exp[0];
    assert.equal(row[4],"INBOM4");assert.equal(row[5],"0012345");assert.match(row[6],/^27-May-2026$/);
    assert.deepEqual((await importCompany(dataDir,companyBackup(snapshot.company,snapshot.vouchers))).vouchers[0].gst,invoice);
  } finally {await rm(dataDir,{recursive:true,force:true});}
});
