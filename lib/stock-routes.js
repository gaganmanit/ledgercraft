import { changeStock, stockLocations } from "./stock-entry.js";
import { isIsoDate, todayISO } from "./money.js";
import { stockState } from "./stock-engine.js";
import { openingStockControl } from "./stock-accounts.js";

function range(company,url) {
  const from = url.searchParams.get("from") || company.booksFrom, to = url.searchParams.get("to") || todayISO();
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) throw new Error("Enter a valid stock report period");
  return {from,to};
}
let recent = null;
function calculatedStock(book,to) {
  if (recent?.book === book && recent.to === to) return recent;
  const {company,vouchers} = book;
  const state = stockState(company,vouchers,{to});
  const financialCheck = openingStockControl(company,vouchers);
  const entry = {book,to,state,financialCheck};
  // The store replaces its read-only snapshot when either on-disk book file changes.
  if (vouchers.length+(company.stock?.journals?.length || 0) <= 50000) recent = entry;
  else recent=null;
  return entry;
}
function journalPage(company,period,itemId,location,offset=0,limit=50) {
  if (!Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(limit) || limit<1 || limit>100) throw new Error("Choose a valid stock journal page");
  if (location && !stockLocations(company).some(g=>g.id===location)) throw new Error("Choose a saved stock location");
  const matches = (company.stock?.journals || []).map((j,index)=>({j,index})).filter(({j})=>
    j.date >= period.from && j.date <= period.to && j.lines.some(l=> {
      if (itemId && l.itemId!==itemId) return false;
      if (!location) return true;
      if (l.fromGodownId || l.toGodownId) return l.fromGodownId===location || l.toGodownId===location;
      return (l.godownId || "main")===location;
    }));
  matches.sort((a,b)=>b.j.date.localeCompare(a.j.date) || (b.j.sequence||0)-(a.j.sequence||0) || b.index-a.index);
  return {rows:matches.slice(offset,offset+limit).map(m=>m.j),offset,limit,total:matches.length};
}
function report(book,period,itemId,location) {
  const {company}=book;
  const {state:value,financialCheck} = calculatedStock(book,period.to);
  const native = new Set((company.gst?.items || []).map(i=>i.id));
  const items = value.items.filter(i=>!itemId || i.itemId === itemId).map(({movements,lots,...i})=>({...i,masterKind:native.has(i.itemId)?"gst":"tally",...(itemId ? {movements,lots} : {})}));
  if (itemId && !items.length) throw new Error("That stock item is not in this company");
  const {rows,...cursor}=journalPage(company,period,itemId,location);
  return { ...value,items,...period,company:{id:company.id,name:company.name,booksFrom:company.booksFrom,...(company.source ? {source:company.source} : {})}, godowns:stockLocations(company),
    settings:{integrateAccounts:company.stock?.integrateAccounts || false},itemSettings:itemId ? {[itemId]:company.stock?.items?.[itemId] || {}} : {},
    journals:rows,journalPage:cursor,revision:company.stock?.revision || 0,financialCheck };
}
export async function handleStockRoute({req,res,parts,url,store,readBody,send}) {
  if (parts[0]!=="api" || parts[1]!=="companies" || !parts[2] || parts[3]!=="stock") return false;
  const id=decodeURIComponent(parts[2]), action=parts[4], itemId=parts[5] ? decodeURIComponent(parts[5]) : "";
  const location=url.searchParams.get("godownId") || "";
  if (req.method === "GET" && parts.length===5 && action==="journals") {
    const {company}=await store.snapshot(id);
    send(res,200,journalPage(company,range(company,url),url.searchParams.get("itemId"),location,
      Number(url.searchParams.get("offset") || 0),Number(url.searchParams.get("limit") || 50))); return true;
  }
  if (req.method === "GET" && (parts.length === 4 || (action === "items" && parts.length === 6))) {
    const book=await store.snapshot(id);
    send(res,200,report(book,range(book.company,url),itemId,location));
    return true;
  }
  if ((req.method==="POST" && ["godowns","journals"].includes(action) && parts.length===5) ||
      (req.method==="PUT" && ((action==="settings" && parts.length===5) || (action==="items" && parts.length===6)))) {
    const input = await readBody(req);
    let saved;
    await store.mutateCompanySection(id,"stock",(current,book)=>{saved=changeStock(current,book,action,itemId,input);return saved.section;});
    send(res,200,{result:saved.result,revision:saved.section.revision,replayed:saved.replayed});
    return true;
  }
  send(res,404,{error:"Unknown stock action"}); return true;
}
