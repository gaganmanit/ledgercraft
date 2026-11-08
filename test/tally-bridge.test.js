import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const run=promisify(execFile);

const script=new URL("../public/tally-bridge.ps1",import.meta.url);
const companyXml='<ENVELOPE><BODY><DATA><COLLECTION><COMPANY NAME="Books &amp; Co"><NAME>Books &amp; Co</NAME><BOOKSFROM TYPE="Date">20250401</BOOKSFROM></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>';

async function bridge(from, responses) {
  const home=await mkdtemp(path.join(os.tmpdir(),"tally-bridge-test-"));
  const requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    requests.push(Buffer.concat(chunks).toString());
    res.writeHead(200,{"Content-Type":"text/xml; charset=utf-16"});
    res.end(Buffer.from(responses[requests.length-1],"utf16le"));
  });
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  let failure=null;
  try {
    await run(process.env.FINANCER_TEST_PWSH,["-NoLogo","-NoProfile","-File",script.pathname,"-Company","Books & Co","-From",from,"-To","2026-03-31","-Port",String(server.address().port),"-OutputDirectory",home],{env:{...process.env,POWERSHELL_TELEMETRY_OPTOUT:"1",DOTNET_CLI_TELEMETRY_OPTOUT:"1"}});
  } catch (error) { failure=error; }
  finally { await new Promise(r=>server.close(r)); }
  return { home, requests, failure, cleanup:()=>rm(home,{recursive:true,force:true}) };
}

test("Windows companion reads the books beginning date, then makes three read-only exports and preserves the exchange bytes", {skip:!process.env.FINANCER_TEST_PWSH}, async()=>{
  const xml=[companyXml,"<ENVELOPE><TALLYMESSAGE><LEDGER NAME=\"Cash\"/></TALLYMESSAGE></ENVELOPE>","<ENVELOPE><TALLYMESSAGE><VOUCHER/></TALLYMESSAGE></ENVELOPE>","<ENVELOPE><DSPACCNAME/></ENVELOPE>"];
  const result=await bridge("2025-04-01",xml);
  try {
    assert.equal(result.failure,null,String(result.failure?.stderr || result.failure));
    assert.equal(result.requests.length,4);
    assert.match(result.requests[0],/<TYPE>Collection<\/TYPE>/);assert.match(result.requests[0],/BOOKSFROM/);assert.match(result.requests[0],/Books &amp; Co/);
    for(const [i,id] of ["List of Accounts","Day Book","Trial Balance"].entries()) {
      const request=result.requests[i+1];
      assert.ok(request.includes("<TALLYREQUEST>Export</TALLYREQUEST>"));assert.ok(request.includes("<ID>"+id+"</ID>"));assert.match(request,/Books &amp; Co/);assert.match(request,/20260331/);
    }
    const folders=await readdir(result.home);assert.equal(folders.length,1);
    const dir=path.join(result.home,folders[0]);
    const receipt=JSON.parse(await readFile(path.join(dir,"Export-receipt.json")));
    assert.equal(receipt.booksFrom,"2025-04-01");
    assert.deepEqual(receipt.files.map(f=>f.file),["Company.xml","Masters.xml","DayBook.xml","TrialBalance.xml"]);
    for(const [i,f] of receipt.files.entries()){
      const bytes=await readFile(path.join(dir,f.file));assert.equal(bytes.toString("utf16le"),xml[i]);assert.equal(f.sha256,createHash("sha256").update(bytes).digest("hex"));
    }
  } finally { await result.cleanup(); }
});

test("Windows companion refuses a -From later than the books beginning date before exporting anything", {skip:!process.env.FINANCER_TEST_PWSH}, async()=>{
  const result=await bridge("2025-10-01",[companyXml]);
  try {
    assert.ok(result.failure,"the export must fail");
    assert.match(String(result.failure.stderr || result.failure.message),/begin on 2025-04-01[\s\S]*-From 2025-04-01/);
    assert.equal(result.requests.length,1,"no masters, day book or trial balance request is sent");
    assert.deepEqual(await readdir(result.home),[],"no partial export folder is left behind");
  } finally { await result.cleanup(); }
});

test("the companion script checks the books beginning date before any data export and hands the trial balance to the importer", async()=>{
  const text=await readFile(script,"utf8");
  const guard=text.indexOf("$startDate -gt $booksFrom"), firstExport=text.indexOf("Export-TallyFile 'List of Accounts'");
  assert.ok(text.includes("<FETCH>NAME, BOOKSFROM, STARTINGFROM</FETCH>"));
  assert.ok(guard>0 && firstExport>guard,"the -From guard runs before the first data export");
  assert.match(text,/Select Company\.xml, Masters\.xml, DayBook\.xml and TrialBalance\.xml/);
  assert.doesNotMatch(text,/Invoke-Expression|Set-ItemProperty|ACTION="(Create|Alter|Delete)"|Import Data/i,"the companion only reads from Tally");
});

test("the importer accepts the companion's Company.xml and TrialBalance.xml alongside masters and vouchers", async()=>{
  const { previewTally } = await import("../lib/tally-import.js");
  const file=(name,text)=>({name,base64:Buffer.from(text).toString("base64")});
  const masters='<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE><LEDGER NAME="Cash"><PARENT>Cash-in-Hand</PARENT><OPENINGBALANCE>-100.00</OPENINGBALANCE></LEDGER><LEDGER NAME="Capital"><PARENT>Capital Account</PARENT><OPENINGBALANCE>100.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
  const tb='<ENVELOPE><DSPACCNAME><DSPDISPNAME>Cash</DSPDISPNAME></DSPACCNAME><DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>-100.00</DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA></DSPCLCRAMTA></DSPCLCRAMT></DSPACCINFO><DSPACCNAME><DSPDISPNAME>Capital</DSPDISPNAME></DSPACCNAME><DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA></DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA>100.00</DSPCLCRAMTA></DSPCLCRAMT></DSPACCINFO></ENVELOPE>';
  const preview=previewTally([file("Company.xml",companyXml),file("Masters.xml",masters),file("TrialBalance.xml",tb)],{});
  assert.equal(preview.canCommit,true,JSON.stringify(preview.issues));
  assert.equal(preview.company.name,"Books & Co");
  assert.equal(preview.company.booksFrom,"2025-04-01");
  assert.equal(preview.summary.trialBalanceCheck.differences,0);
});
