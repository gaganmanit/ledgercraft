import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp,rm,readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { start } from "../server.js";
import { createStore } from "../lib/store.js";
import { gstinCheckDigit } from "../lib/gst.js";
import { verifyItcStatement } from "../lib/gst-statement-library.js";
import { needsResources, GSTR1_TEMPLATE } from "./helpers/resources.mjs";

test("2B workpapers retain original bytes, revised versions and evidence links through native and full-source Tally restore", async (t) =>{
  if (!needsResources(t, GSTR1_TEMPLATE)) return;
  const dataDir=await mkdtemp(path.join(tmpdir(),"financer-statement-library-"));
  const server=await start({port:0,dataDir}), origin="http://127.0.0.1:"+server.address().port;
  const store=createStore(dataDir);
  const encode=s=>Buffer.from(s).toString("base64");
  const post=async(route,body,status=200)=>{
    const res=await fetch(origin+route,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const result=await res.json();assert.equal(res.status,status,JSON.stringify(result));return result;
  };
  const get=async route=>await (await fetch(origin+route)).json();
  try {
    const original=await store.create({name:"Public statement library",booksFrom:"2026-04-01"});
    const samples=new URL("./fixtures/tally/",import.meta.url);
    const files=await Promise.all(["Masters.xml","DayBook.xml"].map(async name=>({name,base64:(await readFile(new URL(name,samples))).toString("base64")})));
    const preview=await post("/api/tally/preview",{files,companyName:"Public Tally GST library",booksFrom:"2026-04-01"});
    const migrated=await post("/api/tally/commit",{token:preview.token,acknowledge:true},201);
    for (const source of [original,migrated]) {
      const c=source.company,base="/api/companies/"+c.id;
      const gstin=stem=>stem+gstinCheckDigit(stem);
      const {registration}=await store.saveGstMaster(c.id,"registration",{name:"Synthetic buyer",gstin:gstin("23ABCDE1234F1Z"),stateCode:"23",address:"Public test address"});
      const {party}=await store.saveGstMaster(c.id,"party",{name:"Synthetic supplier",kind:"supplier",gstin:gstin("27PQRST5678L1Z"),stateCode:"27",address:"Public test address"});
      const {item}=await store.saveGstMaster(c.id,"item",{name:"Sample service",kind:"service",hsnSac:"998599",unit:"OTH",gstRateBps:1800});
      const {invoice}=await store.passGstInvoice(c.id,{registrationId:registration.id,partyId:party.id,type:"Purchase",date:"2026-04-08",placeOfSupply:"23",itcEligibility:"pending",supplierInvoiceNumber:"S/1",items:[{itemId:item.id,quantity:"1",unitPricePaise:10000}]});
      const doc={inum:"S/1",dt:"08-04-2026",val:118,txval:100,igst:18,pos:"23",rev:"N",itcavl:"Y"};
      const statement={data:{gstin:registration.gstin,rtnprd:"042026",itcsumm:{},docdata:{b2b:[{ctin:party.gstin,inv:[doc]}]}}};
      const bytes="\uFEFF"+JSON.stringify(statement,null,2)+"\r\n";
      const sha=createHash("sha256").update(bytes).digest("hex");
      const route=base+"/gst-returns/statements?registration="+registration.id+"&month=2026-04";
      const payload={files:[{name:"April source ₹.json",base64:encode(bytes)}]};
      const [a,b]=await Promise.all([post(route,payload),post(route,payload)]);
      assert.equal(a.statement.id,sha);
      assert.equal(Number(a.replayed)+Number(b.replayed),1);
      assert.equal(a.results[0].status,"Matched");
      const evidence=(await get(base+"/gst-returns/statement-evidence?invoice="+invoice.id)).matches[0];
      assert.equal(evidence.id,sha);assert.equal(evidence.availability,"Y");
      const book=await store.get(c.id);
      await verifyItcStatement(path.join(dataDir,"companies",c.id),book.company,book.vouchers,invoice.id,evidence);
      await assert.rejects(verifyItcStatement(path.join(dataDir,"companies",c.id),book.company,book.vouchers,invoice.id,{...evidence,availability:"N"}),/does not match/);
      const confirmations=Object.fromEntries(["invoiceHeld","received","businessUse","notBlocked","supplierReported","supplierTaxPaid","returnFurnished","paymentReview","noTaxDepreciation"].map(n=>[n,true]));
      const claim={invoiceId:invoice.id,date:"2026-05-02",reference:"Reviewed purchase S1",requestId:"purchase-evidence-claim-001",
        evidence:{...confirmations,annualReturnStatus:"not-filed",basis:"Synthetic evidence confirming forward credit",documentReference:"PUBLIC-1",statement:evidence}};
      await post(base+"/gst/itc/claim",{...claim,evidence:{...claim.evidence,statement:{...evidence,rowKey:"a".repeat(64)}}},400);
      const saved=await post(base+"/gst/itc/claim",claim,201);
      assert.equal(saved.record.components.igstPaise,1800);
      assert.equal((await post(base+"/gst/itc/claim",claim,201)).replayed,true);
      assert.equal((await get(base+"/gst-returns?registration="+registration.id+"&month=2026-04")).itc.table4["4A(5)"].igstPaise,0);
      const filed=await get(base+"/gst-returns?registration="+registration.id+"&month=2026-05");
      assert.equal(filed.itc.table4["4A(5)"].igstPaise,1800);
      assert.equal(filed.itc.reviewedNet.igstPaise,1800);
      doc.itcavl="N";
      await post(route,{files:[{name:"April recomputed.json",base64:encode(JSON.stringify(statement))}]});
      assert.equal((await get(base+"/gst-returns?registration="+registration.id+"&month=2026-04")).statements.length,2);
      const backup=await get(base+"/backup");
      assert.equal(Object.keys(backup.gstStatementFiles).length,2);
      const restored=await post("/api/import",backup,201);
      assert.deepEqual(restored.company.gst.itc.records,backup.company.gst.itc.records);
      const file=await fetch(origin+"/api/companies/"+restored.company.id+"/gst-returns/statements/"+sha+"/files/0");
      assert.equal(file.status,200);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()),Buffer.from(bytes));
      const invalid=structuredClone(backup);delete invalid.gstStatementFiles[sha];
      const before=(await store.list()).length;
      await post("/api/import",invalid,400);
      assert.equal((await store.list()).length,before);
    }
  } finally { await new Promise(done=>server.close(done));await rm(dataDir,{recursive:true,force:true}); }
});
