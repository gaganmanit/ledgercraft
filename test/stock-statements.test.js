import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../lib/store.js";
import { start } from "../server.js";
import { gstinCheckDigit } from "../lib/gst.js";
import { companyBackup,validateTransfer } from "../lib/transfer.js";

async function fixture(run) {
  const dataDir=await mkdtemp(path.join(tmpdir(),"financer-stock-statements-"));
  let server;
  try {
    const store=createStore(dataDir), {company}=await store.create({name:"Public stock verification",booksFrom:"2026-04-01"});
    const regGstin="23ABCDE1234F1Z",partyGstin="23PQRST5678L1Z";
    const {registration}=await store.saveGstMaster(company.id,"registration",{name:"Stock test seller",legalName:"Stock test seller",address:"Test registered address",stateCode:"23",gstin:regGstin+gstinCheckDigit(regGstin)});
    const {party}=await store.saveGstMaster(company.id,"party",{name:"Stock test counterparty",kind:"both",stateCode:"23",address:"Test party address",gstin:partyGstin+gstinCheckDigit(partyGstin)});
    const {item}=await store.saveGstMaster(company.id,"item",{name:"Goods A",kind:"goods",hsnSac:"854140",unit:"NOS",pricePaise:20000,purchasePricePaise:12000,gstRateBps:1800,openingQuantity:"4"});
    server=await start({port:0,dataDir});
    const origin="http://127.0.0.1:"+server.address().port,base=origin+"/api/companies/"+company.id;
    const req=async (route, method="GET",body,status=200) => {
      const res=await fetch(route.startsWith("/api/")?origin+route:base+route,{method,headers:{"content-type":"application/json"},body:body?JSON.stringify(body):undefined});
      const data=await res.json();assert.equal(res.status,status,JSON.stringify(data));return data;
    };
    await run({req,store,company,item,registration,party,base,origin});
  } finally { if (server) await new Promise(done=>server.close(done)); await rm(dataDir,{recursive:true,force:true}); }
}

test("native purchase, transfer and sale reconcile the stock register with P&L and balance sheet and survive normal HTTP restore",async()=>{
  await fixture(async({req,store,company,item,registration,party})=>{
    const itemPath="/stock/items/"+item.id;
    const edit = await req(itemPath,"PUT",{revision:0,requestId:"public-stock-opening-001",costingMethod:"fifo",openingValuePaise:40000,openingAllocations:[]});
    assert.equal(edit.revision,1);
    const integrate={revision:1,requestId:"public-stock-integrate-001",integrateAccounts:true};
    await req("/stock/settings","PUT",integrate,400);
    await store.addLedger(company.id,{name:"Opening merchandise",groupId:"g-stock",openingDc:"Dr",openingPaise:40000});
    await store.addLedger(company.id,{name:"Owner contribution",groupId:"g-capital",openingDc:"Cr",openingPaise:40000});
    await req("/stock/settings","PUT",integrate);
    const godown=await req("/stock/godowns","POST",{name:"East depot",revision:2,requestId:"public-stock-godown-001"});
    const line={itemId:item.id,quantity:"6",unitPricePaise:12000};
    const fields={registrationId:registration.id,partyId:party.id,placeOfSupply:"23",itcEligibility:"eligible"};
    await req("/gst/invoices","POST",{...fields,type:"Purchase",date:"2026-04-02",supplierInvoiceNumber:"SUP-1",items:[line]},201);
    const transfer={number:"ST-1",date:"2026-04-03",type:"transfer",lines:[{itemId:item.id,quantity:"3",fromGodownId:"main",toGodownId:godown.result.id}],requestId:"public-stock-transfer-001",revision:3};
    const transferSave=await req("/stock/journals","POST",transfer);
    assert.equal((await req("/stock/journals","POST",transfer)).replayed,true);
    await req("/stock/journals","POST",{...transfer,number:"ST-2"},400);
    await req("/stock/journals","POST",{...transfer,requestId:"other-stock-transfer-001"},400);
    assert.equal(transferSave.revision,4);
    const sale={...fields,type:"Sales",date:"2026-04-04",items:[{...line,quantity:"3",unitPricePaise:20000,godownId:godown.result.id}]};
    const saved=await req("/gst/invoices","POST",sale,201);
    assert.equal(saved.voucher.stock.lines[0].allocations[0].godownId,godown.result.id);
    const range="?from=2026-04-01&to=2026-04-30";
    const stock=await req(itemPath+range);
    assert.equal(stock.items[0].quantity,"7");
    assert.equal(stock.items[0].valuePaise,82000);
    assert.equal(stock.items[0].godowns.find(d=>d.godownId===godown.result.id).quantity,"0");
    const pl=await req("/reports/profit-loss"+range),bs=await req("/reports/balance-sheet"+range),tb=await req("/reports/trial-balance"+range);
    assert.equal(pl.grossProfit,30000); assert.equal(pl.netProfit,30000);
    assert.equal(bs.profit,30000); assert.equal(bs.difference,0); assert.equal(tb.difference,0);
    assert.equal(bs.assetGroups.find(g=>g.groupName==="Stock-in-Hand").total,82000);
    assert.equal((await req("/reports/profit-loss?from=2026-04-04&to=2026-04-04")).netProfit,30000);
    assert.equal((await req("/reports/profit-loss?from=2026-04-02&to=2026-04-02")).netProfit,0);
    const backup=await req("/backup"),restored=await req("/api/import","POST",backup,201);
    const copy=await req("/api/companies/"+restored.company.id+"/reports/balance-sheet"+range);
    assert.deepEqual(copy,bs);
    const bad=structuredClone(backup);
    bad.vouchers.at(-1).stock.lines[0].allocations[0].quantity="9";
    assert.throws(()=>validateTransfer(bad),/allocat|quantity/i);
  });
});

test("unvalued inventory cannot masquerade as a final profit, disabling integration restores ledger-only reporting",async()=>{
  await fixture(async({req,store,company,item,registration,party})=>{
    await store.addLedger(company.id,{name:"Opening inventory",groupId:"g-stock",openingDc:"Dr",openingPaise:40000});
    await req("/stock/items/"+item.id,"PUT",{revision:0,requestId:"initial-cost-40000",costingMethod:"moving-average",openingValuePaise:40000,openingAllocations:[]});
    await req("/stock/settings","PUT",{revision:1,requestId:"integrate-stock-books",integrateAccounts:true});
    await req("/gst/invoices","POST",{registrationId:registration.id,partyId:party.id,type:"Purchase",date:"2026-04-04",placeOfSupply:"23",itcEligibility:"pending",supplierInvoiceNumber:"PENDING-TAX",items:[{itemId:item.id,quantity:"1",unitPricePaise:12000}]},201);
    const path="/reports/profit-loss?from=2026-04-01&to=2026-04-30";
    const pl=await req(path);
    assert.equal(pl.netProfit,null); assert.equal(pl.inventory.complete,false);
    assert.equal((await req("/reports/balance-sheet?to=2026-04-30")).assetTotal,null);
    await req("/stock/settings","PUT",{revision:2,requestId:"separate-stock-books",integrateAccounts:false});
    assert.equal((await req(path)).netProfit,-12000);
    const {company:owner,vouchers}=await store.get(company.id);
    const backup=companyBackup(owner,vouchers);
    delete backup.vouchers[0].gst;
    assert.throws(()=>validateTransfer(backup),/stock allocat/);
  });
});
