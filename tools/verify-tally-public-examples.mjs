// Pass the official demo ZIP and the invoice-mode XML extracted from TallyHelp's Sample XML page.
// The supporting ledger masters supply the prerequisites TallyHelp lists for these two voucher requests.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { start } from "../server.js";
import { stockState, stockPeriod } from "../lib/stock-engine.js";
const samples = new URL("../test/fixtures/tally/official/", import.meta.url);
const [zipFile = fileURLToPath(new URL("Integration_Demo_Samples.zip",samples)), publishedInvoice = fileURLToPath(new URL("TallyHelp-invoice-mode.xml",samples))] = process.argv.slice(2);
const digest = buffer => createHash("sha256").update(buffer).digest("hex");
const dir = await mkdtemp(path.join(tmpdir(),"financer-official-tally-"));
const server = await start({port:0,dataDir:dir});
const base = "http://127.0.0.1:" + server.address().port;
async function post(api, body, status) {
  const response = await fetch(base+api,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const result = await response.json();
  assert.equal(response.status,status,JSON.stringify(result)); return result;
}
const file = (name,bytes) => ({name,base64:Buffer.from(bytes).toString("base64")});
try {
  const archive = await readFile(zipFile), invoice = await readFile(publishedInvoice);
  const member = "Integration_Demo_Samples/Demo Samples/8_Import Vouchers/Voucher creation.txt";
  const payments = execFileSync("/usr/bin/unzip",["-p",zipFile,member]);
  const response = execFileSync("/usr/bin/unzip",["-p",zipFile,member.replace("creation.txt","creation-Response.txt")],{encoding:"utf8"});
  assert.match(response.toString(),/<CREATED>2<\/CREATED>/);
  const ledgers = [["Conveyance","Indirect Expenses"],["Bank of India","Bank Accounts"],["ABC Company Limited","Sundry Debtors"],["Sales","Sales Accounts"],["Packing Charges","Direct Incomes"],["VAT","Duties &amp; Taxes"]];
  const stockMasters = '<UNIT NAME="nos"><NAME>nos</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>0</DECIMALPLACES></UNIT>'+
    [["Sony Television 14 inches", "20000.00"], ["Samsung DVD Player", "4000.00"]].map(([name, value])=>`<STOCKITEM NAME="${name}"><NAME>${name}</NAME><BASEUNITS>nos</BASEUNITS><COSTINGMETHOD>FIFO Perpetual</COSTINGMETHOD><OPENINGBALANCE>2 nos</OPENINGBALANCE><OPENINGVALUE>${value}</OPENINGVALUE></STOCKITEM>`).join("");
  const masters = "<ENVELOPE><BODY><DATA><TALLYMESSAGE>"+ledgers.map(([name,parent])=>`<LEDGER NAME="${name}"><PARENT>${parent}</PARENT></LEDGER>`).join("")+stockMasters+"</TALLYMESSAGE></DATA></BODY></ENVELOPE>";
  const input = {companyName:"TallyHelp public examples",booksFrom:"2009-04-01",files:[file("Prerequisite masters.xml",masters),file("Voucher creation.txt",payments),file("TallyHelp invoice.xml",invoice)]};
  const first = await post("/api/tally/preview",input,200);
  assert.equal(first.canCommit,false);
  const blocking=first.issues.filter(i=>i.severity==="blocking");
  assert.deepEqual(blocking.map(i=>i.code),["posting-sign-conflict"],JSON.stringify(blocking));
  const ref=blocking[0].reference;
  const wrong=await post("/api/tally/preview",{...input,signChoices:{[ref]:"signed-amounts"}},200);
  assert.equal(wrong.canCommit,false); assert.ok(wrong.issues.some(i=>i.message.includes("payment credits cash or bank")));
  const reviewed=await post("/api/tally/preview",{...input,signChoices:{[ref]:"debit-credit-flags"}},200);
  assert.equal(reviewed.canCommit,true,JSON.stringify(reviewed.issues));
  const created=await post("/api/tally/commit",{token:reviewed.token,acknowledge:true},201);
  const entries=created.vouchers.map(v=>({type:v.type,number:v.number,lines:v.lines.map(l=>({ledger:created.company.ledgers.find(a=>a.id===l.ledgerId).name,side:l.dc,paise:l.paise}))}));
  assert.equal(entries.length,3);
  const by=(type,number)=>entries.find(e=>e.type===type && e.number===number);
  for (const [number,paise] of [["1",1200000],["2",500000]]) {
    assert.deepEqual(by("Payment",number).lines,[{ledger:"Conveyance",side:"Dr",paise},{ledger:"Bank of India",side:"Cr",paise}]);
  }
  const sale=by("Sales","1");
  assert.equal(sale.lines.filter(l=>l.side==="Dr").reduce((sum,l)=>sum+l.paise,0),2154600);
  assert.equal(sale.lines.filter(l=>l.ledger==="Sales").reduce((sum,l)=>sum+l.paise,0),1800000);
  const bills = await (await fetch(base+"/api/companies/"+created.company.id+"/reconciliation/bills?asOf=2016-04-01")).json();
  assert.equal(bills.rows.length,1,JSON.stringify(bills));
  const bill = bills.rows[0];
  assert.equal(bill.partyName,"ABC Company Limited");
  assert.equal(bill.reference,"1");
  assert.equal(bill.date,"2016-04-01");
  assert.equal(bill.amountPaise,2154600);
  assert.equal(bill.openPaise,2154600);
  assert.equal(bill.origin.method,"New Ref");
  assert.ok(bills.totals.every(party=>party.differencePaise===0));
  const stock = stockState(created.company,created.vouchers,{to:"2016-04-01"});
  assert.equal(stock.items.length,2);
  assert.ok(stock.items.every(item=>item.quantity==="1" && item.complete));
  assert.equal(stock.totals.valuePaise,1200000);
  const cost = stockPeriod(created.company,created.vouchers,{from:"2009-04-01",to:"2016-04-01"});
  assert.equal(cost.financial.costOfGoodsSoldPaise,1200000);
  const backup = await (await fetch(base+"/api/companies/"+created.company.id+"/backup")).json();
  const restored = await post("/api/import",backup,201);
  assert.deepEqual(restored.vouchers,created.vouchers);
  assert.deepEqual(restored.company.reconciliation,created.company.reconciliation);
  assert.deepEqual(restored.company.stock,created.company.stock);
  const restoredBills = await (await fetch(base+"/api/companies/"+restored.company.id+"/reconciliation/bills?asOf=2016-04-01")).json();
  assert.deepEqual(restoredBills.rows,bills.rows);
  const restoredSource=await fetch(base+"/api/tally/companies/"+restored.company.id+"/file/1");
  assert.equal(digest(Buffer.from(await restoredSource.arrayBuffer())),digest(payments));
  console.log(JSON.stringify({sources:{archive:"https://help.tallysolutions.com/wp-content/uploads/2025/07/Integration_Demo_Samples.zip",sha256:digest(archive),member,memberSHA256:digest(payments),invoicePage:"https://help.tallysolutions.com/sample-xml/",invoiceSHA256:digest(invoice),invoiceExtraction:"Invoice-mode envelope extracted as text. Replaced typographic quotation marks and nonbreaking spaces from HTML. Kept voucher fields and values."},supportingMasters:"Six synthetic prerequisite ledger masters, one simple unit and two synthetic stock masters; opening quantity 2 each, combined opening value 2400000 paise",strictPreview:{blockedVouchers:1,postedCandidates:2},reviewChoice:{voucher:"Payment 1",selected:"debit-credit-flags",sourceCreditCashValidatedByVoucherType:true},posted:entries,billReference:{party:bill.partyName,reference:bill.reference,date:bill.date,method:bill.origin.method,amountPaise:bill.amountPaise,openPaise:bill.openPaise,ledgerDifferencePaise:0,restoredExactly:true},stock:{basis:"Exact published invoice inventory; synthetic prerequisite opening stocks and costs",items:stock.items.map(item=>({name:item.name,closingQuantity:item.quantity,closingValuePaise:item.valuePaise})),closingValuePaise:stock.totals.valuePaise,costOfGoodsSoldPaise:cost.financial.costOfGoodsSoldPaise,restoredExactly:true},restoredEntries:restored.vouchers.length,originalBytesMatchAfterRestore:true},null,2));
} finally {
  await new Promise(resolve=>server.close(resolve)); await rm(dir,{recursive:true,force:true});
}
