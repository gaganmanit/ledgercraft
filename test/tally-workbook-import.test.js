import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { start } from "../server.js";
import { needsResources, TALLY_SALES_GST_ZIP } from "./helpers/resources.mjs";

const directory=new URL("./fixtures/tally-xlsx/",import.meta.url);
const namedFile=async name=>({name,base64:(await readFile(new URL(name,directory))).toString("base64")});
const options={companyName:"Public Tally migration",booksFrom:"2023-04-01"};
const overlapXml={name:"Separate export.xml",base64:Buffer.from(`<ENVELOPE><TALLYMESSAGE><VOUCHER VCHTYPE="Sales"><GUID>separate-public-fixture</GUID><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><DATE>20230401</DATE><VOUCHERNUMBER>101</VOUCHERNUMBER><PARTYLEDGERNAME>National Traders</PARTYLEDGERNAME>
 <ALLLEDGERENTRIES.LIST><LEDGERNAME>National Traders</LEDGERNAME><AMOUNT>-200</AMOUNT></ALLLEDGERENTRIES.LIST>
 <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>200</AMOUNT></ALLLEDGERENTRIES.LIST>
 </VOUCHER></TALLYMESSAGE></ENVELOPE>`).toString("base64")};

async function withDesk(work) {
  const dataDir=await mkdtemp(path.join(tmpdir(),"financer-workbook-integrity-"));
  const server=await start({port:0,dataDir}),url="http://127.0.0.1:"+server.address().port;
  const post=async(route,input,status=200)=>{
    const response=await fetch(url+route,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
    const result=await response.json(); assert.equal(response.status,status,result.error);return result;
  };
  const get=async route=>{const response=await fetch(url+route);assert.equal(response.status,200);return response.json();};
  try {await work({dataDir,url,post,get});}
  finally {await new Promise(done=>server.close(done)); await rm(dataDir,{recursive:true,force:true});}
}

test("HTTP workbook review retains group and quantity choices, restores exact sources, and retires the committed preview copy",(t)=>needsResources(t, TALLY_SALES_GST_ZIP) && withDesk(async({post,get,dataDir})=>{
  const file=await namedFile("Tally-Sales-GST-Template.zip"), files=[file];
  const first=await post("/api/tally/preview",{...options,files});
  assert.equal(first.canCommit,true);assert.equal(first.summary.openingScope.billedOnlyLines,10);
  assert.equal(first.summary.stockProjection.journals,0);assert.equal(first.summary.gstReadiness.taxablePaise,null);
  assert.equal(first.summary.gstReadiness.sourceItemValuePaise,2720000);assert.equal(first.summary.gstReadiness.taxPaise,489600);
  assert.ok(first.accountGroupMappings.some(row=>row.sourceName==="Sales"&&row.groupId==="g-sales"));
  assert.ok(first.accountGroups.some(row=>row.id==="g-duties"));
  const reviewed=await post("/api/tally/preview",{...options,files,useBilledAsActual:true,accountGroupMappings:{Sales:"g-sales"}});
  assert.equal(reviewed.summary.stockProjection.issueLines,10);assert.equal(reviewed.summary.stockProjection.journals,4);
  assert.equal(reviewed.accountGroupMappings.find(row=>row.sourceName==="Sales").chosen,true);
  assert.deepEqual(await get("/api/tally/preview/"+reviewed.token+"/report"),reviewed);
  const [left,right]=await Promise.all([1,2].map(()=>post("/api/tally/commit",{token:reviewed.token,acknowledge:true},201)));
  assert.equal(left.company.id,right.company.id);assert.equal(left.vouchers.length,4);
  const restored=await post("/api/import",await get("/api/companies/"+left.company.id+"/backup"),201);
  assert.deepEqual(restored.vouchers,left.vouchers);
  assert.deepEqual(restored.company.tallyWorkbook,left.company.tallyWorkbook);
  assert.deepEqual(restored.company.stock,left.company.stock);
  assert.deepEqual(await get("/api/tally/preview/"+reviewed.token+"/report"),reviewed);
  assert.equal((await post("/api/tally/commit",{token:reviewed.token,acknowledge:true},201)).tallyImport.alreadyImported,true);
  assert.deepEqual((await readdir(path.join(dataDir,"tally-previews",reviewed.token))).sort(),["report.json","result.json"]);
}));

test("overlapping workbook and XML exports require a source choice and restore checks the chosen posting",(t)=>needsResources(t, TALLY_SALES_GST_ZIP) && withDesk(async({post,get})=>{
  const excel=await namedFile("Tally-Sales-GST-Template.zip"), files=[excel,overlapXml];
  const blocked=await post("/api/tally/preview",{...options,files});
  assert.equal(blocked.canCommit,false);assert.equal(blocked.overlaps.length,1);
  const group=blocked.overlaps[0], xml=group.records.find(row=>row.file===overlapXml.name);
  assert.equal(group.number,"101");assert.equal(group.date,"2023-04-01");assert.equal(group.records.length,2);
  assert.equal(xml.amountPaise,20000);
  await post("/api/tally/commit",{token:blocked.token,acknowledge:true},400);
  await post("/api/tally/preview",{...options,files,overlapChoices:{[group.key]:"wrong-source-record"}},400);
  const separate=await post("/api/tally/preview",{...options,files,overlapChoices:{[group.key]:"distinct"}});
  assert.equal(separate.canCommit,true); assert.equal(separate.summary.vouchers,5);
  const picked=await post("/api/tally/preview",{...options,files,useBilledAsActual:true,overlapChoices:{[group.key]:xml.recordId}});
  assert.equal(picked.canCommit,true);assert.equal(picked.summary.vouchers,4);
  assert.equal(picked.summary.reconciliation.postedDebitPaise,3209600-354000+20000);
  const {company,vouchers}=await post("/api/tally/commit",{token:picked.token,acknowledge:true},201);
  const backup=await get("/api/companies/"+company.id+"/backup");
  const restored=await post("/api/import",backup,201);
  assert.deepEqual(restored.vouchers,vouchers);
  const forged=structuredClone(backup), data=JSON.parse(gunzipSync(Buffer.from(forged.sourcePayload.data,"base64")));
  data.records.find(r=>r.disposition==="voucher").originalPosting.lines[0].paise+=1;
  const zipped=gzipSync(JSON.stringify(data));forged.sourcePayload.data=zipped.toString("base64");
  forged.sourcePayload.sha256=createHash("sha256").update(zipped).digest("hex");
  assert.match((await post("/api/import",forged,400)).error,/projection differs/);
  const duplicate=structuredClone(backup), copied=JSON.parse(gunzipSync(Buffer.from(duplicate.sourcePayload.data,"base64")));
  copied.records[1]=copied.records[0];
  const dupBytes=gzipSync(JSON.stringify(copied));
  duplicate.sourcePayload={encoding:"gzip+base64",sha256:createHash("sha256").update(dupBytes).digest("hex"),data:dupBytes.toString("base64")};
  assert.match((await post("/api/import",duplicate,400)).error,/inventory/);
  const wrongBasis=structuredClone(backup);
  wrongBasis.company.tallyWorkbook.overlapChoices[group.key]="distinct";
  assert.match((await post("/api/import",wrongBasis,400)).error,/basis differs|projection differs/);
}));
