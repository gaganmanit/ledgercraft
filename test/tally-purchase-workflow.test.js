import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { start } from "../server.js";
import { needsResources, TALLY_VOUCHERS_DEFAULT_ZIP } from "./helpers/resources.mjs";

async function sourceFile(relative) {
  const bytes = await readFile(new URL("./fixtures/" + relative, import.meta.url));
  return { name: path.basename(relative), base64: bytes.toString("base64") };
}

async function withDesk(run) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ledgercraft-purchase-"));
  const server = await start({ port: 0, dataDir });
  const base = "http://127.0.0.1:" + server.address().port;
  async function api(route, input, method = input === undefined ? "GET" : "POST") {
    const response = await fetch(base + route, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const value = await response.json();
    assert.ok(response.ok, method + " " + route + " " + value.error);
    return value;
  }
  async function importFile(file, options) {
    const preview = await api("/api/tally/preview", { files: [file], ...options });
    assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
    return api("/api/tally/commit", { token: preview.token, acknowledge: true });
  }
  try { await run({ api, base, importFile }); }
  finally { server.closeIdleConnections(); await new Promise(done => server.close(done)); await rm(dataDir, {recursive:true,force:true}); }
}

test("official general Tally workbook posts its actual purchase without manufacturing stock or input tax", async (t) => {
  if (!needsResources(t, TALLY_VOUCHERS_DEFAULT_ZIP)) return;
  await withDesk(async ({ api, importFile }) => {
    const source = await sourceFile("tally-xlsx/Tally-Vouchers-Default-Template.zip");
    const result = await importFile(source, { companyName:"Tally public example", booksFrom:"2023-04-01", accountGroupMappings:{"HDFC Bank":"g-bank"} });
    assert.equal(result.vouchers.length, 5);
    const voucher = result.vouchers.find(row => row.type === "Purchase");
    assert.equal(voucher.number, "1520"); assert.equal(voucher.date,"2023-04-12");
    const names = new Map(result.company.ledgers.map(l => [l.id,l.name]));
    assert.deepEqual(voucher.lines.map(l => [names.get(l.ledgerId),l.dc,l.paise]), [["Titan Corporation","Cr",2200000],["Purchase","Dr",2200000]]);
    assert.equal(voucher.gst, undefined);
    const report = await api("/api/tally/companies/"+result.company.id+"/gst?view=desk");
    const purchase = report.rows.find(row=>row.voucherId===voucher.id);
    assert.equal(purchase.status,"blocked");
    assert.match(purchase.blockers[0].message,/item lines/i);
  });
});

test("Tally purchase through 2B, pending stock valuation, reviewed ITC, period returns and both backups", async () => {
  await withDesk(async ({ api, base, importFile }) => {
    const source = await sourceFile("tally-purchase-gst.xml");
    const imported = await importFile(source,{companyName:"Meridian Fixture Books",booksFrom:"2025-04-01"});
    const id = imported.company.id, book = "/api/companies/" + id, migration = "/api/tally/companies/" + id;
    const creditor = imported.company.ledgers.find(l=>l.name==="Deccan Fixture Vendor").id;
    const expense = imported.company.ledgers.find(l=>l.name==="Purchase").id;
    const inputTax = imported.company.ledgers.find(l=>l.name==="Input IGST").id;
    const {registration} = await api(book + "/gst/settings",{name:"Meridian Fixture Books",gstin:"23ABCDE1234F1Z8",stateCode:"23",address:"Synthetic buyer address"},"PUT");
    const {party} = await api(book+"/gst/parties",{name:"Deccan Fixture Vendor",kind:"supplier",supplierLedgerId:creditor,gstin:"27PQRST5678L1Z0",stateCode:"27",address:"Synthetic supplier address"});
    const master = imported.company.stock.masters[0];
    const {item} = await api(book+"/gst/items",{name:master.name,stockItemId:master.id,kind:"goods",hsnSac:"8541",unit:"NOS",gstRateBps:1800});
    const initial = await api(migration+"/gst?view=desk");
    const recordId=initial.rows[0].recordId;
    await api(migration+"/gst/mapping",{recordId,revision:initial.revision,requestId:"purchase-flow-map-0001",registrationId:registration.id,partyId:party.id,items:[{sourceName:master.name,itemId:item.id}],accounts:{party:creditor,purchase:expense,igst:inputTax},purchaseReview:{receivedDate:"2026-04-02"},evidence:{name:"Fixture invoice review",reference:"Synthetic invoice INV/3103 and goods receipt"}});
    const ready=await api(migration+"/gst?view=desk");
    assert.equal(ready.rows[0].status,"ready",JSON.stringify(ready.rows[0].blockers));
    const searched = await api(migration + "/gst?view=desk&q=" + encodeURIComponent("Purchase INV/3103"));
    assert.equal(searched.rows[0].recordId, recordId);
    await api(migration+"/gst/activate",{revision:ready.revision,reviewHash:ready.reviewHash,recordIds:[recordId],requestId:"purchase-flow-activate-01"});
    const active=await api(book);
    assert.equal(active.vouchers.length,1);
    const purchase=active.vouchers[0], doc=purchase.gst;
    assert.deepEqual(purchase.lines,imported.vouchers[0].lines);
    assert.deepEqual(active.company.stock.journals,imported.company.stock.journals);
    assert.equal(doc.number,"P-48");assert.equal(doc.supplierInvoiceNumber,"INV/3103");assert.equal(doc.supplierInvoiceDate,"2026-03-31");
    assert.equal(doc.date,"2026-04-02");assert.equal(doc.receivedDate,"2026-04-02");
    assert.equal(doc.itcEligibility,"pending");assert.equal(doc.totals.igstPaise,3600);assert.equal(doc.totals.totalPaise,23600);
    const filter=month=>"?registration="+registration.id+"&month="+month;
    const pendingStock=await api(book+"/stock?to=2026-04-10");
    assert.equal(pendingStock.items[0].quantity,"3");
    assert.equal(pendingStock.items[0].complete,false);
    assert.ok(pendingStock.issues.some(i=>i.code==="pending-tax-cost") || pendingStock.items[0].issues.some(i=>i.code==="pending-tax-cost"));
    const originalReturn=await api(book+"/gst-returns"+filter("2026-04"));
    assert.equal(originalReturn.itc.table4["4A(5)"].igstPaise,0);
    assert.equal(originalReturn.evidence[0].supplierInvoiceDate,"2026-03-31");
    const supplier={inum:"INV/3103",dt:"31-03-2026",pos:"23",rev:"N",val:236,txval:200,igst:36,itcavl:"Y"};
    const statement={gstin:registration.gstin,rtnprd:"032026",itcsumm:{},docdata:{b2b:[{ctin:party.gstin,inv:[supplier]}]}};
    const statementFile={name:"Synthetic March 2B.json",base64:Buffer.from(JSON.stringify(statement)).toString("base64")};
    const match=await api(book+"/gst-returns/statements"+filter("2026-03"),{files:[statementFile]});
    assert.equal(match.results[0].status,"Matched");assert.equal(match.results[0].bookDate,doc.date);
    const {matches}=await api(book+"/gst-returns/statement-evidence?invoice="+purchase.id);
    assert.equal(matches.length,1);assert.equal(matches[0].rowKey,match.results[0].statementRowKey);
    const claim={invoiceId:purchase.id,date:"2026-04-20",reference:"Synthetic April eligibility review",requestId:"purchase-flow-claim-0001",evidence:{basis:"Synthetic section 16 review",documentReference:"INV/3103",invoiceHeld:true,received:true,businessUse:true,notBlocked:true,supplierReported:true,supplierTaxPaid:true,returnFurnished:true,paymentReview:true,noTaxDepreciation:true,annualReturnStatus:"not-filed",statement:matches[0]}};
    const acted=await api(book+"/gst/itc/claim",claim);
    const claimedBook=await api(book);
    assert.equal(claimedBook.vouchers.length,2);
    const journal=claimedBook.vouchers.find(v=>v.gstItc);
    assert.ok(journal.lines.some(l=>l.ledgerId===inputTax && l.dc==="Cr" && l.paise===3600));
    assert.equal(acted.record.components.igstPaise,3600);
    const valued=await api(book+"/stock?to=2026-04-30");
    assert.equal(valued.items[0].quantity,"3");
    assert.equal(valued.items[0].valuePaise,20000);
    assert.equal(valued.items[0].complete,true);
    const april=await api(book+"/gst-returns"+filter("2026-04"));
    const march=await api(book+"/gst-returns"+filter("2026-03"));
    assert.equal(april.itc.table4["4A(5)"].igstPaise,3600);assert.equal(march.itc.table4["4A(5)"].igstPaise,0);
    for (const route of [book+"/backup",migration+"/archive"]) {
      const backup=await api(route);
      const restored=await api("/api/import",backup);
      assert.deepEqual(restored.vouchers,claimedBook.vouchers);
      assert.deepEqual(restored.company.stock,claimedBook.company.stock);
      assert.deepEqual(restored.company.gst.itc,claimedBook.company.gst.itc);
      const original=await fetch(base+"/api/tally/companies/"+restored.company.id+"/file/0");
      assert.equal(original.status,200);
      assert.equal(Buffer.from(await original.arrayBuffer()).toString("base64"),source.base64);
    }
  });
});

test("Tally note cycle joins outward returns, supplier 2B notes, ITC dispositions and restored stock", async () => {
  await withDesk(async ({api,importFile,base}) => {
    const source=await sourceFile("tally-note-cycle.xml");
    const imported=await importFile(source,{companyName:"Meridian Fixture Books",booksFrom:"2025-04-01"});
    const id=imported.company.id, book="/api/companies/"+id, migration="/api/tally/companies/"+id;
    assert.equal(imported.vouchers.length,6);
    const ledger=name=>imported.company.ledgers.find(row=>row.name===name).id;
    const {registration}=await api(book+"/gst/settings",{name:"Meridian Fixture Books",gstin:"23ABCDE1234F1Z8",stateCode:"23",address:"Synthetic MP registration"},"PUT");
    const {party:vendor}=await api(book+"/gst/parties",{name:"Deccan Fixture Vendor",kind:"supplier",supplierLedgerId:ledger("Deccan Fixture Vendor"),gstin:"27PQRST5678L1Z0",stateCode:"27",address:"Synthetic MH registration"});
    const {party:customer}=await api(book+"/gst/parties",{name:"Central Fixture Customer",kind:"customer",customerLedgerId:ledger("Central Fixture Customer"),gstin:"23LMNOP1234Q1ZE",stateCode:"23",address:"Synthetic MP customer"});
    const receiptItem=imported.company.stock.masters[0];
    const {item}=await api(book+"/gst/items",{name:receiptItem.name,stockItemId:receiptItem.id,kind:"goods",hsnSac:"8541",unit:"NOS",gstRateBps:1800});
    const purchaseAccounts={party:vendor.supplierLedgerId,purchase:ledger("Purchase"),igst:ledger("Input IGST")};
    const salesAccounts={party:customer.customerLedgerId,sales:ledger("Domestic Sales"),cgst:ledger("Output CGST"),sgst:ledger("Output SGST")};
    const plan=()=>api(migration+"/gst?view=desk");
    let sequence=0;
    const token=()=>`cycle-request-id-${String(++sequence).padStart(6,"0")}`;
    async function map(number,inward,extra={},financial=false) {
      const current=await plan(),row=current.rows.find(row=>row.number===number);
      await api(migration+"/gst/mapping",{recordId:row.recordId,revision:current.revision,requestId:token(),registrationId:registration.id,partyId:(inward?vendor:customer).id,
        items:financial?[]:[{sourceName:receiptItem.name,itemId:item.id}],accounts:inward?purchaseAccounts:salesAccounts,
        evidence:{name:"Synthetic note cycle documents",reference:"Source invoice or statutory note and receipt review "+number},...extra});
    }
    async function activate(numbers) {
      const current=await plan(),rows=numbers.map(n=>current.rows.find(row=>row.number===n));
      assert.ok(rows.every(row=>row.status==="ready"),JSON.stringify(rows.map(r=>[r.number,r.blockers])));
      const body={recordIds:rows.map(r=>r.recordId),reviewHash:current.reviewHash,revision:current.revision,requestId:token()};
      await api(migration+"/gst/activate",body);
      assert.equal((await api(migration+"/gst/activate",body)).replayed,true);
    }
    await map("P-48",true,{purchaseReview:{receivedDate:"2026-04-02"}});
    await map("S-10",false);
    await activate(["P-48","S-10"]);
    const ordinary=await api(book);
    const purchase=ordinary.vouchers.find(v=>v.number==="P-48").gst, sale=ordinary.vouchers.find(v=>v.number==="S-10").gst;
    const itcEvidence={basis:"Synthetic section 16 review",documentReference:"Supplier invoice and statement",invoiceHeld:true,received:true,businessUse:true,notBlocked:true,supplierReported:true,supplierTaxPaid:true,returnFurnished:true,paymentReview:true,noTaxDepreciation:true,annualReturnStatus:"not-filed"};
    await api(book+"/gst/itc/claim",{invoiceId:purchase.id,date:"2026-04-05",reference:"Synthetic claim before return",requestId:token(),evidence:itcEvidence});
    const noteSpecs=[["CN-2",false,true,0],["DN-7",false,false,1000],["PD-5",true,true,0],["PC-6",true,false,2000]];
    for(const [number,inward,physical,unitPricePaise] of noteSpecs){
      const original=inward?purchase:sale;
      await map(number,inward,{noteReview:{direction:inward?"purchase":"sales",originalInvoiceId:original.id,originalNumber:inward?purchase.supplierInvoiceNumber:sale.number,originalDate:inward?purchase.supplierInvoiceDate:sale.date,
        stockEffect:physical?"quantity":"none",...(inward?{supplierDocumentConfirmed:true}:{}),lines:[physical?{sourceLineIndex:0,originalLineIndex:0}:{originalLineIndex:0,quantity:"1",unitPricePaise,discountBps:0}]}},!physical);
    }
    await activate(noteSpecs.map(row=>row[0]));
    const active=await api(book),get=number=>active.vouchers.find(v=>v.number===number);
    for(const baseline of imported.vouchers){
      const v=get(baseline.number);
      assert.equal(v.id,baseline.id);assert.equal(v.type,baseline.type);assert.deepEqual(v.lines,baseline.lines);
    }
    assert.deepEqual(noteSpecs.map(([number])=>[get(number).type,get(number).gst.type,get(number).gst.direction]),[
      ["Credit Note","Credit Note","sales"],["Debit Note","Debit Note","sales"],["Debit Note","Credit Note","purchase"],["Credit Note","Debit Note","purchase"]
    ]);
    assert.equal(active.company.stock.journals.length,4);
    const stock=await api(book+"/stock?to=2026-04-30");
    assert.equal(stock.items[0].quantity,"1");
    const period="?registration="+registration.id+"&month=2026-04";
    const held=await api(book+"/gst-returns"+period);
    assert.deepEqual(held.sheets.cdnr.map(row=>row[2]),["DN-7"]);
    assert.equal(held.summary.outwardTaxable.taxablePaise-held.bookSummary.outwardTaxable.taxablePaise,15000);
    assert.equal(held.creditReviews.find(row=>row.id===get("CN-2").id).eligible,false);
    const review={invoiceId:get("CN-2").id,revision:held.creditReviewRevision,requestId:token(),declarationDate:"2026-05-11",
      annualReturnStatus:"not-filed",recipientBasis:"not-availed",adjustmentGround:"goods-returned",groundConfirmed:true,reference:"Synthetic recipient confirmation and return receipt"};
    await api(book+"/gst-returns/credit-review",review);
    assert.equal((await api(book+"/gst-returns/credit-review",review)).replayed,true);
    const working=await api(book+"/gst-returns"+period);
    assert.equal(working.creditReviews.find(row=>row.id===get("CN-2").id).eligible,true);
    assert.deepEqual(working.sheets.cdnr.map(r=>[r[2],r[4],r[8],r[11]]).sort(),[["CN-2","C","177.00","150.00"],["DN-7","D","11.80","10.00"]]);
    assert.equal(working.summary.purchases.taxablePaise,12000);assert.equal(working.summary.purchases.igstPaise,2160);
    assert.equal(working.itc.table4["4A(5)"].igstPaise,3600);
    const portalNote=(typ,num,dt,val,txval,igst)=>({typ,ntnum:num,dt,pos:"23",rev:"N",itcavl:"Y",val,txval,igst});
    const statement={gstin:registration.gstin,rtnprd:"042026",itcsumm:{},docdata:{cdnr:[{ctin:vendor.gstin,nt:[portalNote("C","SCN/9","09-04-2026",118,100,18),portalNote("D","SDN/1","11-04-2026",23.6,20,3.6)]}]}};
    const recorded=await api(book+"/gst-returns/statements"+period,{files:[{name:"Synthetic April CDN.json",base64:Buffer.from(JSON.stringify(statement)).toString("base64")}]});
    const notes=recorded.results.filter(r=>r.section==="cdnr");
    assert.deepEqual(notes.map(n=>[n.status,n.bookId]),[["Matched",get("PD-5").id],["Matched",get("PC-6").id]]);
    const evidence=async id=>(await api(book+"/gst-returns/statement-evidence?invoice="+id)).matches[0];
    const reduction=await api(book+"/gst/itc/credit-note",{invoiceId:get("PD-5").id,date:"2026-04-15",reference:"Supplier credit disposition",requestId:token(),
      evidence:{basis:"Review of credit previously claimed",documentReference:"SCN/9",statement:await evidence(get("PD-5").id)},
      creditSources:[{invoiceId:purchase.id,lineIndex:0,noteLineIndex:0,bucket:"claimable",igstPaise:1800}]});
    assert.deepEqual(reduction.record.returnRows.map(r=>[r.table,r.sign,r.igstPaise]),[["4A(5)",-1,1800]]);
    assert.ok(reduction.voucher.lines.some(l=>l.ledgerId===purchaseAccounts.igst && l.dc==="Dr" && l.paise===1800));
    await api(book+"/gst/itc/claim",{invoiceId:get("PC-6").id,date:"2026-04-16",reference:"Actual additional supplier tax",requestId:token(),evidence:{...itcEvidence,documentReference:"SDN/1",statement:await evidence(get("PC-6").id)}});
    assert.equal((await api(book+"/gst-returns"+period)).itc.table4["4A(5)"].igstPaise,2160);
    const final=await api(book);
    assert.equal(final.vouchers.filter(v=>v.gst?.tallyOrigin?.version===3).length,4);
    for(const url of [book+"/backup",migration+"/archive"]){
      const restored=await api("/api/import",await api(url));
      assert.deepEqual(restored.vouchers,final.vouchers);
      assert.deepEqual(restored.company.stock,final.company.stock);
      assert.deepEqual(restored.company.gst.itc,final.company.gst.itc);
      assert.deepEqual(restored.company.gst.creditReviews,final.company.gst.creditReviews);
      const r=await fetch(base+"/api/tally/companies/"+restored.company.id+"/file/0");
      assert.equal(Buffer.from(await r.arrayBuffer()).toString("base64"),source.base64);
    }
  });
});
