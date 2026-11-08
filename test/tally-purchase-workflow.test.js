import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { start } from "../server.js";

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

test("official general Tally workbook posts its actual purchase without manufacturing stock or input tax", async () => {
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
