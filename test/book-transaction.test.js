import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,readFile,readdir,writeFile,access,rm } from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createStore} from "../lib/store.js";
import {commitBook,keepBackup} from "../lib/book-transaction.js";

test("a new store and a cached reader finish a partially applied financial review before serving or mutating books",async()=>{
  const data=await mkdtemp(path.join(tmpdir(),"financer-transaction-"));
  try {
    const store=createStore(data);
    const {company,vouchers}=await store.specimen();
    const folder=path.join(data,"companies",company.id);
    let updated=structuredClone(company);
    updated.name="Recovered financial review";
    const changed=structuredClone(vouchers);
    changed[0].narration="Atomic decisions and accounting entries";
    await store.snapshot(company.id);
    await writeFile(path.join(folder,".financer-pending-book.json"),JSON.stringify({version:1,company:updated,vouchers:changed}));
    await writeFile(path.join(folder,"company.json"),JSON.stringify(updated)); // interruption between the replacements
    const observed=await store.snapshot(company.id);
    assert.equal(observed.company.name,updated.name);assert.equal(observed.vouchers[0].narration,changed[0].narration);
    await assert.rejects(access(path.join(folder,".financer-pending-book.json")),/ENOENT/);
    await commitBook(folder,company,vouchers);
    assert.deepEqual(JSON.parse(await readFile(path.join(folder,"company.json"),"utf8")),company);
    const fresh=await createStore(data).get(company.id);
    assert.deepEqual(fresh.vouchers,vouchers);
  } finally { await rm(data,{recursive:true,force:true}); }
});

test("a multi-file commit keeps the previous company and vouchers as rolling backups unless told to skip one",async()=>{
  const data=await mkdtemp(path.join(tmpdir(),"financer-transaction-bak-"));
  try {
    const store=createStore(data);
    const {company,vouchers}=await store.specimen();
    const folder=path.join(data,"companies",company.id);
    const read=async name=>JSON.parse(await readFile(path.join(folder,name),"utf8"));
    const second={...structuredClone(company),name:"Second version"};
    await commitBook(folder,second,vouchers.slice(1));
    assert.deepEqual(await read("company.json.bak"),company);
    assert.deepEqual(await read("vouchers.json.bak"),vouchers);
    await commitBook(folder,{...second,name:"Third version"},vouchers.slice(2),{backup:["vouchers.json"]});
    assert.equal((await read("company.json.bak")).name,company.name);
    assert.deepEqual(await read("vouchers.json.bak"),vouchers.slice(1));
    assert.equal((await read("company.json")).name,"Third version");
    assert.equal(await keepBackup(path.join(folder,"missing.json")),false);
    assert.deepEqual((await readdir(folder)).filter(name=>name.endsWith(".tmp")),[]);
  } finally { await rm(data,{recursive:true,force:true}); }
});

test("a store commit after opening a damaged primary leaves the good backup in place",async()=>{
  const data=await mkdtemp(path.join(tmpdir(),"financer-transaction-damaged-"));
  try {
    const store=createStore(data);
    const {company}=await store.specimen();
    const folder=path.join(data,"companies",company.id);
    await store.updateGroup(company.id,(await store.addGroup(company.id,{name:"Office Costs",parentId:"g-indirect-exp"})).company.groups.at(-1).id,{name:"Office Expenses"});
    const good=await readFile(path.join(folder,"company.json.bak"),"utf8");
    await writeFile(path.join(folder,"company.json"),"{");
    const opened=await store.get(company.id);
    assert.match(opened.warning,/company\.json/);
    await store.addLedger(company.id,{name:"Courier",groupId:"g-indirect-exp",openingPaise:0,openingDc:"Dr"});
    assert.equal(await readFile(path.join(folder,"company.json.bak"),"utf8"),good);
    const healed=await store.get(company.id);
    assert.equal(healed.warning,undefined);
    assert.ok(healed.company.ledgers.some(ledger=>ledger.name==="Courier"));
  } finally { await rm(data,{recursive:true,force:true}); }
});
