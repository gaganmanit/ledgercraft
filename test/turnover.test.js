import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../lib/store.js";
import { validateTransfer, companyBackup } from "../lib/transfer.js";
import { gstinCheckDigit } from "../lib/gst.js";
import { returnWorkbook } from "../lib/gst-returns.js";
import { directoryEntries } from "../lib/hsn-directory.js";
const gstin = (prefix) => prefix + gstinCheckDigit(prefix);

test("preceding-year aggregate turnover applies PAN-wide in the correct April financial year", async()=>{
  const dir = await mkdtemp(path.join(os.tmpdir(),"financer-turnover-"));
  try {
    const store = createStore(dir);
    const { company:{id} } = await store.create({name:"Turnover Test", booksFrom:"2025-04-01"});
    const register = async code => (await store.saveGstMaster(id,"registration",{gstin:gstin(code+"ABCDE1234F1Z"),name:"Test registration "+code,address:"Synthetic address",stateCode:code})).registration;
    const first = await register("23"), second = await register("27");
    const { party } = await store.saveGstMaster(id,"party",{name:"Customer",address:"Sample address",stateCode:"27",kind:"customer"});
    const { item } = await store.saveGstMaster(id,"item",{name:"Goods",kind:"goods",hsnSac:"8541",unit:"NOS",pricePaise:11000,gstRateBps:1800});
    await store.saveGstMaster(id,"turnover",{registrationId:first.id,year:"2026",band:"above-5cr"});
    const invoice={date:"2026-03-31",registrationId:second.id,partyId:party.id,placeOfSupply:"27",type:"Sales",items:[{itemId:item.id,quantity:"1"}]};
    await store.passGstInvoice(id,invoice);
    await assert.rejects(store.previewGstInvoice(id,{...invoice,date:"2026-04-01"}),/at least 6/);
    await store.saveGstMaster(id,"turnover",{registrationId:first.id,year:"2026",band:"up-to-5cr"});
    await store.passGstInvoice(id,{...invoice,date:"2026-04-01"});
    await store.saveGstMaster(id,"turnover",{registrationId:first.id,year:"2026",band:"above-5cr"});
    const { company,vouchers }=await store.get(id);
    assert.equal(vouchers.at(-1).gst.hsnProfile.band,"up-to-5cr");
    const report=returnWorkbook(company,vouchers,second.id,"2026-04",await directoryEntries());
    assert.equal(report.hsnCheck.minimumDigits,6);assert.equal(report.hsnCheck.checks[0].code,"8541");
    assert.notEqual(report.sheets["hsn(b2c)"][0][1],"Goods");
    assert.deepEqual(validateTransfer(companyBackup(company,vouchers)).company.gst.turnoverByYear,company.gst.turnoverByYear);
  } finally {await rm(dir,{recursive:true,force:true});}
});
