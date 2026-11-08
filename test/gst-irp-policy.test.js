import assert from "node:assert/strict";
import test from "node:test";
import { invoiceIrpStatus, saveIrpPolicy, validateIrpPolicies } from "../lib/gst-irp-policy.js";
import { signedQrSvg } from "../lib/signed-qr.js";

test("dated applicability distinguishes exports, ordinary B2C, exemption and imported IRN",()=>{
  const company = {gst:{registrations:[{id:"r"}]}};
  const doc={registrationId:"r",direction:"sales",party:{gstin:"synthetic"},date:"2025-04-01",documentLabel:"Tax Invoice",supplyCategory:"domestic"};
  saveIrpPolicy(company,{registrationId:"r",effectiveFrom:"2025-04-01",status:"required",thirtyDayWindow:true});
  assert.equal(invoiceIrpStatus(company,doc,null,"2025-04-30").overdue,false);
  assert.equal(invoiceIrpStatus(company,doc,null,"2025-05-01").overdue,true);
  assert.equal(invoiceIrpStatus(company,doc,null,"2025-05-01").reportBy,"2025-04-30");
  assert.equal(invoiceIrpStatus(company,doc,{irn:"fixture"}).pending,false);
  assert.equal(invoiceIrpStatus(company,{...doc,date:"2025-03-31"},null).required,false);
  assert.equal(invoiceIrpStatus(company,{...doc,party:{gstin:""}},null).required,false);
  assert.equal(invoiceIrpStatus(company,{...doc,party:{gstin:""},supplyCategory:"export"},null).required,true);
  assert.throws(()=>saveIrpPolicy(company,{registrationId:"r",effectiveFrom:"2026-04-01",status:"exempt"}),/declaration/);
  saveIrpPolicy(company,{registrationId:"r",effectiveFrom:"2026-04-01",status:"exempt",declaration:"Example declaration entered by the registration holder."});
  assert.match(invoiceIrpStatus(company,{...doc,date:"2026-04-01"},null).declaration,/registration holder/);
  assert.doesNotThrow(()=>validateIrpPolicies(company.gst));
});
test("signed QR rendering requires a compact token and emits only encoded square modules",()=>{
  assert.throws(()=>signedQrSvg(""),/bound/);
  assert.throws(()=>signedQrSvg("<svg/>"),/bound/);
  const result=signedQrSvg("eyJhbGciOiJSUzI1NiJ9.ZGF0YQ.c2lnbmF0dXJl");
  assert.match(result,/viewBox="0 0 \d+ \d+"/);assert.match(result,/crispEdges/);
  assert.equal(result.includes("eyJhb"),false);
});
