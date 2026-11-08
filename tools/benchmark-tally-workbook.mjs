// Exercise the normal HTTP import while another request reads the same local desk.
// Pass a generated or public default sales workbook. Reads only the supplied file.
import { mkdtemp,readFile,readdir,rm,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { start } from "../server.js";
const file=process.argv[2];
if (!file) throw new Error("Pass a path to a public or generated Tally sales workbook");
const raw=await readFile(file), dataDir=await mkdtemp(path.join(tmpdir(),"financer-tally-preview-benchmark-"));
let server;
try {
  server=await start({port:0,dataDir});
  const base="http://127.0.0.1:"+server.address().port;
  const post=async(route,body)=>{
    const r=await fetch(base+route,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const v=await r.json();assert.ok(r.ok,v.error);return v;
  };
  await fetch(base+"/api/health");
  async function measure(request) {
    let running=true;
    const health=[];
    const began=performance.now(), response=request().finally(()=>{running=false;});
    const monitor=(async()=>{
      while (running) {
        await new Promise(done=>setTimeout(done,60));
        if (!running) break;
        const before=performance.now(),answer=await fetch(base+"/api/health");
        assert.equal((await answer.json()).app,"financer");
        if (running) health.push(performance.now()-before);
      }
    })();
    const result=await response, ms=Math.round(performance.now()-began);
    await monitor;
    health.sort((a,b)=>a-b);
    return {result,measurements:{ms,healthReads:health.length,healthMedianMs:health.length?+health[Math.floor(health.length/2)].toFixed(1):null,
      healthMaxMs:health.length?+health.at(-1).toFixed(1):null}};
  }
  const {result:preview,measurements:previewTime}=await measure(()=>post("/api/tally/preview",{companyName:"Synthetic large workbook",booksFrom:"2020-04-01",files:[{name:path.basename(file),base64:raw.toString("base64")}],useBilledAsActual:true}));
  assert.equal(preview.canCommit,true,JSON.stringify(preview.issues.filter(i=>i.severity==="blocking").slice(0,1)));
  const dir=path.join(dataDir,"tally-previews",preview.token);
  const stagedBytes=(await stat(path.join(dir,"preview.json.gz"))).size;
  const {result:saved,measurements:commitTime}=await measure(()=>post("/api/tally/commit",{token:preview.token,acknowledge:true,compact:true}));
  const vouchers=JSON.parse(await readFile(path.join(dataDir,"companies",saved.company.id,"vouchers.json"),"utf8"));
  assert.equal(vouchers.length,preview.summary.vouchers);
  const reviewBegin=performance.now();
  const review=await (await fetch(base+"/api/tally/companies/"+saved.company.id+"/gst")).text();
  const sourceReview={recordsFileBytes:(await stat(path.join(dataDir,"companies",saved.company.id,"tally-source","records.json"))).size,ms:Math.round(performance.now()-reviewBegin),responseBytes:Buffer.byteLength(review),rows:JSON.parse(review).rows.length};
  const deskBegin=performance.now();
  const page=await (await fetch(base+"/api/tally/companies/"+saved.company.id+"/gst?view=desk")).text();
  const desk=JSON.parse(page);
  assert.equal(desk.rows.length,Math.min(20,sourceReview.rows));assert.equal(desk.page.total,sourceReview.rows);
  const firstPage={ms:Math.round(performance.now()-deskBegin),responseBytes:Buffer.byteLength(page),rows:desk.rows.length};
  const last=await (await fetch(base+"/api/tally/companies/"+saved.company.id+"/gst?view=desk&offset="+(desk.page.total-1))).json();
  assert.ok(last.rows.length>0);assert.equal(last.rows.at(-1).recordId,JSON.parse(review).rows.at(-1).recordId);
  const found=await (await fetch(base+"/api/tally/companies/"+saved.company.id+"/gst?view=desk&q="+encodeURIComponent(last.rows.at(-1).recordId))).json();
  assert.equal(found.page.total,1);
  const reconciliation=preview.summary.reconciliation;
  assert.equal(reconciliation.postedDebitPaise,reconciliation.postedCreditPaise);
  assert.deepEqual((await readdir(dir)).sort(),["report.json","result.json"]);
  console.log(JSON.stringify({sourceSHA256:createHash("sha256").update(raw).digest("hex"),sourceBytes:raw.length,
    vouchers:vouchers.length,itemLines:preview.summary.stockProjection.issueLines,postedDebitPaise:reconciliation.postedDebitPaise,
    preview:previewTime,commit:commitTime,sourceReview,firstPage,
    compressedStagingBytes:stagedBytes,stagingCopyRetired:true},null,2));
} finally {if (server) await new Promise(done=>server.close(done)); await rm(dataDir,{recursive:true,force:true});}
