import { irpBulk, ewaybillDocument, exchangeDefaults } from "../lib/gst-exchange.js";
import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {start} from "../server.js";
import {needsResources, HSN_DIRECTORY, GSTR1_TEMPLATE} from "./helpers/resources.mjs";

const source = {name:"tally-service-cycle.xml",base64:(await readFile(new URL("./fixtures/tally-service-cycle.xml",import.meta.url))).toString("base64")};
const serviceNames = ["Consulting Income","Support Income","Professional Fees","Maintenance Expense"];
const amountProfile = invoice => invoice.items.map(line=>[line.kind,line.hsnSac,line.gstRateBps,line.taxablePaise,line.taxPaise]);

test("four Tally service workflows reconcile original accounts, goods-only stock, returns, XML and dated input credit",async(t)=>{
  if (!needsResources(t, HSN_DIRECTORY, GSTR1_TEMPLATE)) return;
  const dataDir=await mkdtemp(path.join(tmpdir(),"ledgercraft-service-e2e-"));
  const server=await start({port:0,dataDir}), base="http://127.0.0.1:"+server.address().port;
  async function api(route,body,method=body===undefined?"GET":"POST"){
    const r=await fetch(base+route,{method,headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const response=await r.json();
    if (!r.ok) throw new Error(method+" "+route+" "+response.error);
    return response;
  }
  async function activateFiles(files,name){
    const preview=await api("/api/tally/preview",{files,companyName:name,booksFrom:"2026-04-01"});
    assert.equal(preview.canCommit,true,JSON.stringify(preview.issues));
    const imported=await api("/api/tally/commit",{token:preview.token,acknowledge:true});
    const id=imported.company.id, book="/api/companies/"+id, migration="/api/tally/companies/"+id;
    assert.equal(imported.company.stock.journals.length,2,"Both goods movements are operational before GST activation");
    assert.deepEqual((await api(book+"/stock?to=2026-04-30")).items.map(row=>row.quantity),["11"]);
    const ledger=n=>imported.company.ledgers.find(row=>row.name===n).id;
    const {registration}=await api(book+"/gst/settings",{name,gstin:"23ABCDE1234F1Z8",stateCode:"23",address:"Synthetic registered office",pincode:"462001"},"PUT");
    const parties={};
    for(const [kind,label,gstin] of [["customer","Service Buyer","23PQRST5678L1Z8"],["supplier","Service Supplier","23LMNOP4321A1Z9"]]){
      parties[kind]=(await api(book+"/gst/parties",{name:label,kind,gstin,stateCode:"23",address:"Synthetic counterparty",pincode:"452001",[kind+"LedgerId"]:ledger(label)})).party;
    }
    const master=imported.company.stock.masters[0], catalog={};
    const goods=(await api(book+"/gst/items",{name:master.name,kind:"goods",stockItemId:master.id,unit:master.unit,openingQuantity:master.openingQuantity,hsnSac:"854140",gstRateBps:1800})).item;
    for(const label of serviceNames) catalog[label]=(await api(book+"/gst/items",{name:label,kind:"service",unit:"OTH",hsnSac:"998311",gstRateBps:500})).item;
    for (const number of ["SV-101","PV-201","MS-102","MP-202"]){
      const plan=await api(migration+"/gst"),row=plan.rows.find(r=>r.number===number);
      assert.ok(row.source?.items,`${number} ${JSON.stringify(row.blockers)}`);
      const inward=row.type==="Purchase"||row.source.direction==="purchase", mixed=number[0]==="M";
      const party=inward?parties.supplier:parties.customer;
      const serviceItems=row.source.items.filter(s=>s.kind==="service").map(s=>({sourceLineId:s.sourceLineId,itemId:catalog[s.sourceName].id,
        ...(inward?{completionReview:number==="MP-202"?{status:"pending"}:{status:"confirmed",date:"2026-04-15",reference:"Synthetic service acceptance"}}:{})}));
      await api(migration+"/gst/mapping",{recordId:row.recordId,revision:plan.revision,requestId:randomUUID(),registrationId:registration.id,partyId:party.id,
        stockMode:mixed?"source":"financial-only",items:mixed?[{sourceName:master.name,itemId:goods.id}]:[],serviceItems,
        accounts:{party:ledger(party.name),cgst:ledger("CGST"),sgst:ledger("SGST"),...(mixed?{[inward?"purchase":"sales"]:ledger(inward?"Goods Purchases":"Goods Sales")}:{})},
        ...(inward && mixed?{purchaseReview:{receivedDate:"2026-04-12"}}:{}),evidence:{name:"Synthetic supplier or customer document",reference:"Ledger row and dated SAC review "+number}});
    }
    const plan=await api(migration+"/gst"),targets=plan.rows.filter(row=>["SV-101","PV-201","MS-102","MP-202"].includes(row.number));
    assert.deepEqual(targets.filter(row=>row.status!=="ready").map(row=>[row.number,row.blockers]),[]);
    const request={recordIds:targets.map(row=>row.recordId),reviewHash:plan.reviewHash,revision:plan.revision,requestId:randomUUID()};
    await api(migration+"/gst/activate",request);
    assert.equal((await api(migration+"/gst/activate",request)).replayed,true);
    const active=await api(book), invoices=new Map(active.vouchers.map(v=>[v.number,v.gst]));
    for (const before of imported.vouchers) {
      const after=active.vouchers.find(v=>v.id===before.id);
      assert.deepEqual(after.lines,before.lines); assert.equal(after.gst.tallyOrigin.version,4);
    }
    assert.equal(active.vouchers.length,4);assert.equal(active.company.stock.journals.length,2);
    const stock=await api(book+"/stock?to=2026-04-30");
    assert.deepEqual(stock.items.map(i=>i.quantity),["11"]);
    const period="?registration="+registration.id+"&month=2026-04";
    const report=await api(book+"/gst-returns"+period);
    assert.equal(report.summary.outwardTaxable.taxablePaise,300000);
    assert.equal(report.summary.purchases.taxablePaise,240000);
    assert.equal(report.sheets["b2b,sez,de"].length,2);
    const services=report.sheets["hsn(b2b)"].filter(r=>r[0].startsWith("99"));
    assert.deepEqual(services.map(r=>[r[0],r[2],r[3],r[5]]).sort(),[["998313","NA","0","1300.00"],["998713","NA","0","700.00"]]);
    assert.equal(report.hsnCheck.reconciliation[0].differencePaise,0);
    return {book,migration,registration,invoices,period,active};
  }
  try {
    const first=await activateFiles([source],"Service Original"),{book,migration,invoices,period,registration}=first;
    const mixedSale=invoices.get("MS-102");
    const prep=exchangeDefaults(mixedSale);
    Object.assign(prep.seller,{location:"Synthetic seller"});
    Object.assign(prep.buyer,{location:"Synthetic buyer"});
    Object.assign(prep.transport,{mode:"1",vehicleNo:"MP04AB1234",distanceKm:200});
    const [irp]=irpBulk(mixedSale,prep);
    assert.deepEqual(irp.ItemList.map(row=>[row.IsServc,Object.hasOwn(row,"Qty"),Object.hasOwn(row,"Unit")]),[["N",true,true],["Y",false,false],["Y",false,false]]);
    assert.equal(irp.ValDtls.TotInvVal,1770);
    const consignment=ewaybillDocument(mixedSale,prep,"2026-04-10");
    assert.deepEqual([consignment.itemList.length,consignment.totalValue,consignment.cgstValue,consignment.sgstValue,consignment.totInvValue],[1,1000,90,90,1180]);
    assert.throws(()=>ewaybillDocument(invoices.get("SV-101"),prep,"2026-04-10"),/physical goods/);
    const files=[];
    for(const type of ["masters","daybook"]){
      const response=await fetch(base+migration+"/export/"+type+"?from=2026-04-01&to=2026-04-30");
      const xml=await response.text();assert.ok(response.ok,xml);
      if(type==="daybook"){assert.equal((xml.match(/<ALLINVENTORYENTRIES\.LIST>/g)||[]).length,2);assert.equal((xml.match(/<GSTOVRDNTYPEOFSUPPLY>Services</g)||[]).length,7);}
      files.push({name:type+".xml",base64:Buffer.from(xml).toString("base64")});
    }
    const roundtrip=await activateFiles(files,"Service Reimport");
    assert.equal(first.registration.invoicePrefix,"R1");
    assert.equal(roundtrip.registration.invoicePrefix,"R2");
    for(const [number,invoice] of invoices){
      const restored=roundtrip.invoices.get(number);
      assert.deepEqual(amountProfile(restored),amountProfile(invoice));
      assert.equal(restored.supplierInvoiceNumber,invoice.supplierInvoiceNumber);
      const legs=(company,voucher)=>voucher.lines.map(line=>[company.ledgers.find(l=>l.id===line.ledgerId).name,line.dc,line.paise]).sort();
      const firstLegs=legs(first.active.company,first.active.vouchers.find(v=>v.number===number));
      assert.deepEqual(legs(roundtrip.active.company,roundtrip.active.vouchers.find(v=>v.number===number)),firstLegs);
    }
    // Tally may put one goods ledger posting under each physical line of a mixed invoice.
    const originalXml=Buffer.from(source.base64,"base64").toString();
    const splitXml=originalXml.replace(/<ALLLEDGERENTRIES[.]LIST><LEDGERNAME>Goods Purchases<[/]LEDGERNAME>[^]*?<[/]ALLLEDGERENTRIES[.]LIST>/,
      row=>row.replace("-1200.00","-400.00")+row.replace("-1200.00","-800.00"))
      .replace(/<ALLINVENTORYENTRIES[.]LIST><STOCKITEMNAME>Widget<[/]STOCKITEMNAME><ISDEEMEDPOSITIVE>Yes<[/]ISDEEMEDPOSITIVE>[^]*?<[/]ALLINVENTORYENTRIES[.]LIST>/,
        row=>row.replaceAll("-1200.00","-400.00").replaceAll("3 NOS","1 NOS")+row.replaceAll("-1200.00","-800.00").replaceAll("3 NOS","2 NOS"));
    const split=await activateFiles([{name:"split.xml",base64:Buffer.from(splitXml).toString("base64")}],"Split ledger");
    const parts=split.active.vouchers.find(v=>v.number==="MP-202");
    const goodsLedger=split.active.company.ledgers.find(l=>l.name==="Goods Purchases");
    assert.deepEqual(parts.lines.filter(row=>row.ledgerId===goodsLedger.id).map(row=>row.paise),[40000,80000]);
    const splitExport=await fetch(base+split.migration+"/export/daybook?from=2026-04-01&to=2026-04-30");
    const splitDay=await splitExport.text(); assert.ok(splitExport.ok,splitDay);
    const splitMasters=await fetch(base+split.migration+"/export/masters");
    assert.ok(splitMasters.ok);
    const importedSplit=await activateFiles([{name:"split-masters.xml",base64:Buffer.from(await splitMasters.text()).toString("base64")},{name:"split-daybook.xml",base64:Buffer.from(splitDay).toString("base64")}],"Split reimport");
    assert.deepEqual(amountProfile(importedSplit.invoices.get("MP-202")),amountProfile(split.invoices.get("MP-202")));
    const purchase=invoices.get("MP-202");
    const supplier={inum:purchase.supplierInvoiceNumber,dt:"09-04-2026",pos:"23",rev:"N",val:1652,itcavl:"Y",items:[{txval:1400,cgst:126,sgst:126}]};
    const statement={data:{gstin:registration.gstin,rtnprd:"042026",docdata:{b2b:[{ctin:purchase.party.gstin,inv:[supplier]}]}}};
    await api(book+"/gst-returns/statements"+period,{files:[{name:"Synthetic service 2B.json",base64:Buffer.from(JSON.stringify(statement)).toString("base64")}]});
    const savedMatch=(await api(book+"/gst-returns/statement-evidence?invoice="+purchase.id)).matches[0];
    assert.equal(savedMatch.matchStatus,"Matched");
    const evidence={basis:"Synthetic section 16 review",documentReference:"Fixture purchase and 2B",statement:savedMatch,invoiceHeld:true,received:true,businessUse:true,notBlocked:true,supplierReported:true,supplierTaxPaid:true,returnFurnished:true,paymentReview:true,noTaxDepreciation:true,annualReturnStatus:"not-filed"};
    const claim=(index,tax,date,extra={})=>api(book+"/gst/itc/claim",{invoiceId:purchase.id,date,reference:"Synthetic line-specific receipt",requestId:randomUUID(),
      evidence:{...evidence,...extra},lineAllocations:[{lineIndex:index,fromBucket:"unreviewed",cgstPaise:tax,sgstPaise:tax}]});
    await claim(0,10800,"2026-04-20");
    await assert.rejects(claim(1,1800,"2026-04-20"),/service|receipt/i);
    const service=purchase.tallyOrigin.serviceItems[0];
    const serviceReceipts=[{lineIndex:1,sourceLineId:service.sourceLineId,sourceLedgerId:service.sourceLedgerId,received:true,date:"2026-05-01",reference:"Signed synthetic service completion"}];
    await assert.rejects(claim(1,1800,"2026-04-20",{serviceReceipts}),/date|before|receipt/i);
    await claim(1,1800,"2026-05-02",{serviceReceipts});
    assert.equal((await api(book+"/gst-returns"+period)).itc.table4["4A(5)"].cgstPaise,10800);
    assert.equal((await api(book+"/gst-returns"+period.replace("2026-04","2026-05"))).itc.table4["4A(5)"].cgstPaise,1800);
    const final=await api(book);
    for(const route of [book+"/backup",migration+"/archive"]){
      const restored=await api("/api/import",await api(route));
      assert.deepEqual(restored.vouchers,final.vouchers); assert.deepEqual(restored.company.stock,final.company.stock); assert.deepEqual(restored.company.gst.itc,final.company.gst.itc);
      const original=await fetch(base+"/api/tally/companies/"+restored.company.id+"/file/0");
      assert.equal(Buffer.from(await original.arrayBuffer()).toString("base64"),source.base64);
    }
  } finally {server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));await rm(dataDir,{recursive:true,force:true});}
});
