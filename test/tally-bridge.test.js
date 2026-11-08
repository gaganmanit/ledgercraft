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

test("Windows companion uses three read-only loopback requests and preserves the exchange bytes", {skip:!process.env.FINANCER_TEST_PWSH}, async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),"tally-bridge-test-"));
  const requests=[];
  const xml=["<ENVELOPE><TALLYMESSAGE><LEDGER NAME=\"Cash\"/></TALLYMESSAGE></ENVELOPE>","<ENVELOPE><TALLYMESSAGE><VOUCHER/></TALLYMESSAGE></ENVELOPE>","<ENVELOPE><DSPACCNAME/></ENVELOPE>"];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    requests.push(Buffer.concat(chunks).toString());
    res.writeHead(200,{"Content-Type":"text/xml; charset=utf-16"});
    res.end(Buffer.from(xml[requests.length-1],"utf16le"));
  });
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  try {
    await run(process.env.FINANCER_TEST_PWSH,["-NoLogo","-NoProfile","-File",new URL("../public/tally-bridge.ps1",import.meta.url).pathname,"-Company","Books & Co","-From","2025-04-01","-To","2026-03-31","-Port",String(server.address().port),"-OutputDirectory",home],{env:{...process.env,POWERSHELL_TELEMETRY_OPTOUT:"1",DOTNET_CLI_TELEMETRY_OPTOUT:"1"}});
    assert.equal(requests.length,3);
    for(const [i,id] of ["List of Accounts","Day Book","Trial Balance"].entries()) {
      assert.ok(requests[i].includes("<TALLYREQUEST>Export</TALLYREQUEST>"));assert.ok(requests[i].includes("<ID>"+id+"</ID>"));assert.match(requests[i],/Books &amp; Co/);assert.match(requests[i],/20260331/);
    }
    const folders=await readdir(home);assert.equal(folders.length,1);
    const dir=path.join(home,folders[0]);
    const receipt=JSON.parse(await readFile(path.join(dir,"Export-receipt.json")));
    for(const [i,f] of receipt.files.entries()){
      const bytes=await readFile(path.join(dir,f.file));assert.equal(bytes.toString("utf16le"),xml[i]);assert.equal(f.sha256,createHash("sha256").update(bytes).digest("hex"));
    }
  } finally {await new Promise(r=>server.close(r));await rm(home,{recursive:true,force:true});}
});
