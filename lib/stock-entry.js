import { createHash, randomUUID } from "node:crypto";
import { isIsoDate } from "./money.js";
import { openingStockControl } from "./stock-accounts.js";

export const stockLocations = company => {
  const list = company.stock?.godowns || [];
  return list.some(g=>g.id === "main") ? list : [{id:"main",name:"Main Location"},...list];
};
function nextSequence(company,vouchers) {
  let last = 0;
  for (const voucher of vouchers) last = Math.max(last,voucher.stock?.sequence || 0);
  for (const journal of company.stock?.journals || []) last = Math.max(last,journal.sequence || 0);
  for (const record of company.gst?.itc?.records || []) last = Math.max(last,record.stockSequence || 0);
  if (!Number.isSafeInteger(last + 1)) throw new Error("This stock sequence is full");
  return last + 1;
}
export function invoiceStockMetadata(company,invoice,input,vouchers) {
  const ids = new Set(stockLocations(company).map(g=>g.id)), lines = [];
  input.items.forEach((item,lineIndex)=>{
    const id = item.godownId;
    if (id == null || id === "main") return;
    if (!ids.has(id)) throw new Error("Choose a saved godown for each inventory line");
    const row = invoice.items[lineIndex];
    if (row.kind !== "goods" || invoice.stockEffect !== "quantity") throw new Error("Only a goods movement can have a godown");
    lines.push({lineIndex,allocations:[{godownId:id,quantity:row.quantity}]});
  });
  return invoice.stockEffect === "quantity" && invoice.items.some(i=>i.kind==="goods") ? {version:1,lines,sequence:nextSequence(company,vouchers)} : null;
}
function title(value, label, limit = 80) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > limit || /[\x00-\x1f]/.test(value)) throw new Error("Enter a valid " + label);
  return value.trim();
}
function hash(object) { return createHash("sha256").update(JSON.stringify(object)).digest("hex"); }
function journal(input) {
  if (!["physical","adjustment","transfer"].includes(input.type)) throw new Error("Choose a physical count, adjustment or transfer");
  if (!isIsoDate(input.date) || !Array.isArray(input.lines) || !input.lines.length || input.lines.length>500) throw new Error("Enter a valid journal date and its stock lines");
  const lines = input.lines.map(source=>{
    const line = {};
    // Batch, its dates and an alternate unit are optional; the stock engine validates them.
    for (const field of ["itemId","godownId","fromGodownId","toGodownId","direction","quantity","unit","batch","expiryDate","manufacturedDate","reason","valuePaise"]) if (Object.hasOwn(source,field)) line[field]=source[field];
    return line;
  });
  return { id:"sj-"+randomUUID(), date:input.date, number:title(input.number,"journal number",24), type:input.type, lines };
}
function itemSetting(company,section,id,input) {
  if (![...(company.gst?.items || []).filter(i=>i.kind === "goods"), ...(section.masters || [])].some(i=>i.id===id)) throw new Error("Choose a goods master in this company");
  if (!["fifo","moving-average"].includes(input.costingMethod)) throw new Error("Choose a supported stock costing method");
  if (input.openingValuePaise !== null && (!Number.isSafeInteger(input.openingValuePaise) || input.openingValuePaise < 0)) throw new Error("Enter the opening value in exact paise");
  if (!Array.isArray(input.openingAllocations) || input.openingAllocations.length>500) throw new Error("Choose the opening stock locations");
  // Named batches keep their identity and dates when the opening is saved again.
  const allocations = input.openingAllocations.map(({godownId,quantity,valuePaise,batch,expiryDate,manufacturedDate})=>({godownId,quantity,valuePaise,
    ...(batch != null ? {batch} : {}),...(expiryDate != null ? {expiryDate} : {}),...(manufacturedDate != null ? {manufacturedDate} : {})}));
  section.items ||= {};
  section.items[id] = { ...section.items[id], costingMethod:input.costingMethod, openingValuePaise:input.openingValuePaise };
  if (allocations.length) section.items[id].openingAllocations=allocations;
  else delete section.items[id].openingAllocations;
}
export function changeStock(current,book,action,id,input) {
  const section = current || {version:1,godowns:stockLocations(book.company),items:{},journals:[]};
  section.revision ??= 0;
  section.operationReceipts ||= [];
  if (!input || typeof input !== "object" || !/^[A-Za-z0-9-]{16,80}$/.test(input.requestId || "")) throw new Error("This stock change needs a request identifier");
  const { revision,requestId,...fields } = input;
  const requestHash=hash([action,id,fields]);
  const previous=section.operationReceipts.find(r=>r.requestId === requestId);
  if (previous) {
    if (previous.requestHash !== requestHash) throw new Error("That stock request identifier already belongs to a different change");
    return { section, result:previous.result, replayed:true };
  }
  if (revision !== section.revision) throw new Error("Stock settings changed. Reopen the page to review the latest revision");
  let result = {};
  if (action === "godowns") {
    const name = title(input.name,"godown name");
    if (stockLocations(book.company).some(g=>g.name.toLowerCase() === name.toLowerCase())) throw new Error("That godown name is already in use");
    result = { id:"godown-"+randomUUID(), name };
    section.godowns ||= []; section.godowns.push(result);
  } else if (action === "items") {
    itemSetting(book.company,section,id,input);
    result = {itemId:id};
  } else if (action === "journals") {
    const entry=journal(input);
    entry.sequence=nextSequence(book.company,book.vouchers);
    if (entry.date < book.company.booksFrom) throw new Error("A stock journal cannot precede the opening of the books");
    section.journals ||= [];
    if (section.journals.some(j=>j.number.toLowerCase() === entry.number.toLowerCase())) throw new Error("That stock journal number is already in use");
    section.journals.push(entry);
    result = {id:entry.id, number:entry.number};
  } else if (action === "settings") {
    if (typeof input.integrateAccounts !== "boolean") throw new Error("Choose whether to integrate inventory with the accounts");
    if (input.integrateAccounts) {
      const control=openingStockControl({...book.company,stock:section},book.vouchers);
      if (control.reason) throw new Error(control.reason);
    }
    section.integrateAccounts = input.integrateAccounts;
  } else throw new Error("Unknown stock change");
  section.revision++;
  section.operationReceipts.push({requestId,requestHash,result});
  return {section,result,replayed:false};
}
