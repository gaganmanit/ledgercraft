// Measure a complete HTTP stock summary using a disposable company, including JSON decoding.
import assert from "node:assert/strict";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { start } from "../server.js";
import { createStore } from "../lib/store.js";
const dataDir=await mkdtemp(path.join(tmpdir(),"financer-stock-benchmark-"));
let server;
try {
  const store=createStore(dataDir);
  const {company}=await store.create({name:"Synthetic inventory benchmark",booksFrom:"2026-04-01"});
  const count=100, pairs=50;
  company.stock={version:1,masters:[],items:{},journals:[]};
  for (let i=0;i<count;i++) {
    const id="bench-"+i;
    company.stock.masters.push({id,name:"Stock "+i,unit:"NOS",openingQuantity:"10"});
    company.stock.items[id]={openingValuePaise:10000,costingMethod:i%2?"moving-average":"fifo"};
  }
  for(let pair=0;pair<pairs;pair++) for(const item of company.stock.masters) for(const inward of [true,false]) {
    const id="MOV-"+company.stock.journals.length;
    company.stock.journals.push({id,number:id,date:"2026-04-02",type:inward?"receipt":"issue",financialKind:inward?"purchase":"sale",
      lines:[{itemId:item.id,godownId:"main",quantity:"1",...(inward?{valuePaise:1000}:{})}]});
  }
  await writeFile(path.join(dataDir,"companies",company.id,"company.json"),JSON.stringify(company));
  server=await start({port:0,dataDir});
  const url=`http://127.0.0.1:${server.address().port}/api/companies/${company.id}/stock?from=2026-04-01&to=2026-04-30`;
  const timings=[];let bytes;
  for(let i=0;i<4;i++){
    const begin=performance.now();
    const response=await fetch(url);const json=await response.text(), result=JSON.parse(json);
    timings.push(Math.round((performance.now()-begin)*10)/10);bytes=Buffer.byteLength(json);
    assert.equal(response.status,200,JSON.stringify(result.error));
    assert.equal(result.items.length,count);assert.equal(result.totals.valuePaise,1000000);assert.equal(result.totals.complete,true);
    assert.ok(result.items.every(i=>i.quantity==="10" && i.valuePaise===10000));
  }
  const warm=timings.slice(1).sort((a,b)=>a-b);
  console.log(JSON.stringify({stockItems:count,stockJournals:count*pairs*2,costMethods:["fifo","moving-average"],closingQuantityPerItem:"10",closingValuePaise:1000000,responseBytes:bytes,coldMs:timings[0],warmMedianMs:warm[1],samplesMs:timings},null,2));
} finally { if(server) await new Promise(done=>server.close(done));await rm(dataDir,{recursive:true,force:true}); }
