import { createHash } from "node:crypto";
import { attribute, children, value } from "./tally-format.js";
import { tallyAmount, tallyDate } from "./tally-values.js";

const key = text => String(text || "").trim().toLocaleLowerCase("en-IN");
const node = (tag,text="",items=[]) => ({tag,attrs:{},text,children:items});
const masterName = record => attribute(record.node,"NAME") || value(record.node,"NAME");
const dutyName = name => /\b(?:[CSI]GST|UTGST|CESS)\b/i.test(name);

function unitOf(entry) {
  const units = new Set();
  for (const field of ["ACTUALQTY","BILLEDQTY"]) {
    const match = /^[+-]?[\d,.]+\s+(.+)$/.exec(value(entry,field).trim());
    if (match) units.add(match[1].trim());
  }
  const rate = value(entry,"RATE");
  if (rate.includes("/")) units.add(rate.slice(rate.lastIndexOf("/")+1).trim());
  return units;
}

// Workbook references describe what is named in the transactions. Explicit masters always take
// precedence. These extra records remain identifiable when the original bytes are replayed.
export function workbookReferences(records) {
  const supplied = new Set(records.map(record => record.type + ":" + key(masterName(record))));
  const candidates = new Map();
  const add = (type,name,record,role) => {
    if (!name || supplied.has(type+":"+key(name))) return null;
    const id = type+":"+key(name);
    if (!candidates.has(id)) candidates.set(id,{id,type,name,files:new Set(),roles:new Set(),units:new Set()});
    const candidate=candidates.get(id);
    candidate.files.add(record.file);
    if (role) candidate.roles.add(role);
    return candidate;
  };
  for (const record of records.filter(record => record.sourceFormat === "xlsx")) {
    const n=record.node;
    if (record.type === "STOCKITEM") add("UNIT",value(n,"BASEUNITS"),record);
    if (record.type !== "VOUCHER") continue;
    const type=key(value(n,"VOUCHERTYPENAME") || attribute(n,"VCHTYPE"));
    const sale=["sales","credit note"].includes(type), purchase=["purchase","debit note"].includes(type);
    const party=key(value(n,"PARTYLEDGERNAME"));
    const allocs=new Set();
    for (const item of [...children(n,"ALLINVENTORYENTRIES"),...children(n,"INVENTORYENTRIES")]) {
      const name=value(item,"STOCKITEMNAME"), candidate=add("STOCKITEM",name,record);
      for (const unit of unitOf(item)) {
        add("UNIT",unit,record);
        if (candidate) candidate.units.add(unit);
      }
      for (const allocation of children(item,"ACCOUNTINGALLOCATIONS")) {
        const ledger=value(allocation,"LEDGERNAME"); allocs.add(key(ledger));
        add("LEDGER",ledger,record,sale ? "sales" : purchase ? "purchase" : null);
      }
      const loc=value(item,"GODOWNNAME");
      if (loc && key(loc)!=="main location") add("GODOWN",loc,record);
    }
    for (const entry of [...children(n,"ALLLEDGERENTRIES"),...children(n,"LEDGERENTRIES")]) {
      const name=value(entry,"LEDGERNAME"), ledger=key(name);
      let role;
      if (ledger===party) role=sale ? "debtors" : purchase ? "creditors" : undefined;
      else if (dutyName(name)) role="duties";
      else if (sale && (allocs.has(ledger) || ledger==="sales")) role="sales";
      else if (purchase && (allocs.has(ledger) || ledger==="purchase" || ledger==="purchases")) role="purchase";
      if (ledger==="cash") role="cash";
      add("LEDGER",name,record,role);
    }
  }
  return [...candidates.values()].sort((a,b)=>a.id.localeCompare(b.id,"en")).map(c=>{
    const facts=[node("NAME",c.name),node("WORKBOOKREFERENCE","Yes")];
    if (c.type==="LEDGER" && c.roles.size===1) facts.push(node("SUGGESTEDGROUP","g-"+[...c.roles][0]));
    if (c.type==="UNIT") facts.push(node("ISSIMPLEUNIT","Yes"),node("DECIMALPLACES","6"));
    if (c.type==="STOCKITEM") {
      if (c.units.size===1) facts.push(node("BASEUNITS",[...c.units][0]));
      if (c.units.size>1) facts.push(node("ADDITIONALUNITS",[...c.units].sort().join(" / ")));
    }
    return {type:c.type,file:[...c.files].sort()[0],sourceFormat:"xlsx-reference",
      recordId:"r-"+createHash("sha256").update("excel-reference:"+c.id).digest("hex").slice(0,24), node:node(c.type,"",facts)};
  });
}

export function workbookBasis(records, references, groups, options) {
  const supplied=options.accountGroupMappings || {};
  if (typeof supplied!=="object" || Array.isArray(supplied)) throw new Error("Choose account groups for the referenced workbook ledgers");
  if (options.useBilledAsActual!==undefined && typeof options.useBilledAsActual!=="boolean") throw new Error("Choose whether billed quantities match actual stock");
  const choices=new Map(), groupIds=new Set(groups.map(g=>g.id));
  const rows=references.filter(r=>r.type==="LEDGER").map(record=>{
    const sourceName=masterName(record);
    const chosen=Object.hasOwn(supplied,sourceName) && Boolean(supplied[sourceName]);
    const proposed=value(record.node,"SUGGESTEDGROUP"), groupId=chosen ? supplied[sourceName] : proposed;
    if (groupId && !groupIds.has(groupId)) throw new Error("Choose a valid ledger group for "+sourceName);
    if (chosen) choices.set(sourceName,groupId);
    return {sourceName,groupId,required:!proposed,chosen,reason:chosen?"Reviewed account group":proposed?"Suggested from the transaction role":"Account group is absent from the source"};
  });
  const relevant=new Set(rows.map(row=>row.sourceName));
  if (Object.keys(supplied).some(name=>!relevant.has(name))) throw new Error("A saved ledger group choice is missing from this workbook. Review the current references");
  let billedOnlyLines=0, sourceSales=0, taxable=0n, tax=0n;
  for (const r of records.filter(r=>r.type==="VOUCHER" && r.sourceFormat==="xlsx")) {
    const n=r.node, entries=[...children(n,"ALLINVENTORYENTRIES"),...children(n,"INVENTORYENTRIES")];
    billedOnlyLines+=entries.filter(e=>value(e,"BILLEDQTY")&&!value(e,"ACTUALQTY")).length;
    if (key(value(n,"VOUCHERTYPENAME") || attribute(n,"VCHTYPE"))!=="sales" || ["ISCANCELLED","ISDELETED","ISOPTIONAL","ISPOSTDATED"].some(f=>/^(yes|true|1)$/i.test(value(n,f)))) continue;
    sourceSales++;
    for (const e of entries) taxable+=BigInt(Math.abs(tallyAmount(value(e,"AMOUNT"),true)));
    for (const e of [...children(n,"ALLLEDGERENTRIES"),...children(n,"LEDGERENTRIES")]) {
      if (dutyName(value(e,"LEDGERNAME"))) tax+=BigInt(tallyAmount(value(e,"AMOUNT"),true));
    }
  }
  const referencedStockItems=references.filter(r=>r.type==="STOCKITEM").length;
  const uncertain=records.filter(record=>record.sourceFormat==="xlsx" && value(record.node,"XLSXOPENINGUNKNOWN")==="Yes");
  const unknownLedgerOpenings=rows.length+uncertain.filter(r=>r.type==="LEDGER").length;
  const unknownStockOpenings=referencedStockItems+uncertain.filter(r=>r.type==="STOCKITEM").length;
  const missing=unknownLedgerOpenings>0 || unknownStockOpenings>0;
  return {rows, stored:{version:1,accountGroupMappings:Object.fromEntries(choices),useBilledAsActual:options.useBilledAsActual===true},
    openingScope:{transactionOnly:missing,referencedLedgers:rows.length,referencedStockItems,billedOnlyLines,unknownLedgerOpenings,unknownStockOpenings,
      message:missing?"Opening balances were not supplied for all referenced masters. The imported movements start at the selected books-begin date.":""},
    gstReadiness:{sourceSales,sourceItemValuePaise:Number.isSafeInteger(Number(taxable))?Number(taxable):null,taxablePaise:null,
      taxPaise:Number.isSafeInteger(Number(tax))?Number(tax):null}};
}

// Tally workbooks often omit voucher GUIDs. Overlapping date ranges from two files
// cannot be merged on the displayed voucher number alone.
export function workbookOverlaps(records, choices = {}) {
  if (!choices || typeof choices!=="object" || Array.isArray(choices)) throw new Error("Review the overlapping voucher choices");
  const groups = new Map(), overlaps = [], omitted = new Map();
  for (const record of records) {
    if (record.type !== "VOUCHER") continue;
    const n=record.node,number=value(n,"VOUCHERNUMBER").trim();
    if (!number) continue;
    const type=value(n,"VOUCHERTYPENAME") || attribute(n,"VCHTYPE");
    let date;
    try { date=tallyDate(value(n,"DATE")); }
    catch { continue; } // The voucher validator reports invalid or missing dates.
    const identity=JSON.stringify([key(type),date,key(number)]);
    if (!groups.has(identity)) groups.set(identity,{number,type,date,records:[]});
    groups.get(identity).records.push(record);
  }
  for (const [identity,group] of groups) {
    if (new Set(group.records.map(record=>record.file)).size < 2 || !group.records.some(record=>record.sourceFormat==="xlsx")) continue;
    const id=createHash("sha256").update(identity).digest("hex").slice(0,24);
    const choice=Object.hasOwn(choices,id) ? choices[id] : "";
    if (choice && choice!=="distinct" && !group.records.some(record=>record.recordId===choice)) throw new Error("Selected overlapping source is missing. Review the files again");
    const members=group.records.map(record=>{
      const n=record.node;
      const lines=[...children(n,"ALLLEDGERENTRIES"),...children(n,"LEDGERENTRIES")];
      let amount=0n;
      for (const line of lines) {
        const paise=tallyAmount(value(line,"AMOUNT"),true);
        if (paise<0) amount+=BigInt(-paise);
      }
      if (choice!=="distinct" && choice!==record.recordId) omitted.set(record.recordId,choice || null);
      return {recordId:record.recordId,file:record.file,party:value(n,"PARTYLEDGERNAME"),amountPaise:Number.isSafeInteger(Number(amount))?Number(amount):null};
    });
    overlaps.push({key:id,number:group.number,type:group.type,date:group.date,records:members,choice});
  }
  const keys=new Set(overlaps.map(group=>group.key));
  if (Object.keys(choices).some(id=>!keys.has(id))) throw new Error("The overlap choices refer to different source files");
  return {overlaps,omitted};
}

// Source records are reconstructed and compared with the exact submitted bytes before
// activation and restore. Hash the deterministic workbook nodes one record at a time
// so the fingerprint does not require a second in-memory copy of an entire worksheet.
export function workbookSourceFingerprint(records) {
  if (!records.some(record=>record.sourceFormat==="xlsx")) return null;
  const hash=createHash("sha256").update("financer-tally-workbook-source:1\n");
  for (const record of [...records].sort((a,b)=>a.recordId.localeCompare(b.recordId))) {
    hash.update(JSON.stringify([record.recordId,record.type,record.node])).update("\n");
  }
  return hash.digest("hex");
}
