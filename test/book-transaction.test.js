import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,readFile,writeFile,access,rm } from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createStore} from "../lib/store.js";
import {commitBook} from "../lib/book-transaction.js";

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
