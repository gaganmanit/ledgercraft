import path from "node:path";
import { matchSavedStatement, originalStatementFile } from "./gst-statement-library.js";
import { directoryEntries } from "./hsn-directory.js";
import { columns, returnWorkbook, worksheetCsv } from "./gst-returns.js";
import { gstrWorkbook } from "./gst-workbook.js";
import { reconcile2B } from "./gst-reconcile.js";
export async function handleReturnRoute({ req, res, parts, url, store, dataDir, readBody, send }) {
  if (parts[0] !== "api" || parts[1] !== "companies" || !parts[2] || parts[3] !== "gst-returns") return false;
  const { company, vouchers } = await store.snapshot(decodeURIComponent(parts[2]));
  const reg = url.searchParams.get("registration");
  const month = url.searchParams.get("month");
  const companyDir=path.join(dataDir,"companies",company.id);
  if (parts[4] === "statements") {
    if (req.method === "POST" && parts.length === 5) {
      send(res,200,await store.saveGstStatement(company.id,reg,month,await readBody(req))); return true;
    }
    if (req.method === "GET" && parts.length === 6) {
      send(res,200,await matchSavedStatement(companyDir,company,vouchers,parts[5])); return true;
    }
    if (req.method === "GET" && parts.length === 8 && parts[6] === "files" && /^\d{1,3}$/.test(parts[7])) {
      const {raw,name}=await originalStatementFile(companyDir,company,parts[5],Number(parts[7]));
      res.writeHead(200,{"content-type":"application/json","cache-control":"no-store","content-disposition":`attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g,"%27")}`});res.end(raw);return true;
    }
    send(res,404,{error:"Unknown statement action"});return true;
  }
  if (req.method === "GET" && parts[4]==="statement-evidence" && parts.length===5) {
    const invoiceId=url.searchParams.get("invoice");
    const invoice=vouchers.find(v=>v.id===invoiceId)?.gst;
    if (!invoice || invoice.direction!=="purchase") throw new Error("Choose a purchase to review statement evidence");
    const matches=[];
    for (const entry of (company.gstStatements || []).filter(e=>e.registrationId===invoice.registrationId && e.month>=invoice.date.slice(0,7))) {
      const {results}=await matchSavedStatement(companyDir,company,vouchers,entry.id);
      for (const row of results.filter(r=>r.bookId===invoiceId && r.statementRowKey)) matches.push({id:entry.id,sha256:entry.id,rowKey:row.statementRowKey,period:entry.month,
        availability:row.statementITC,matchStatus:row.status,reason:row.reason,number:row.number,fileName:entry.files[0].name});
    }
    send(res,200,{matches:matches.reverse()}); return true;
  }
  if (req.method === "POST" && parts[4] === "reconcile-2b") {
    send(res,200,reconcile2B(company,vouchers,reg,month,await readBody(req)));
    return true;
  }
  if (req.method !== "GET") return false;
  const book = returnWorkbook(company,vouchers,reg,month,await directoryEntries());
  if (parts[4] === "workbook" && parts.length === 5) {
    const file = await gstrWorkbook(book);
    res.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="GSTR1-${book.registration.gstin}-${month}.xlsx"`, "cache-control": "no-store" });
    res.end(file);
  } else if (parts[4] === "csv") {
    const sheet = decodeURIComponent(parts[5] || "");
    if (!Object.hasOwn(columns,sheet)) throw new Error("Select a return worksheet");
    res.writeHead(200,{"content-type":"text/csv; charset=utf-8","content-disposition":`attachment; filename="${sheet}.csv"`,"cache-control":"no-store"});
    res.end(worksheetCsv(sheet,book.sheets[sheet]));
  } else if (parts.length === 4) send(res,200,{...book,columns,statements:(company.gstStatements || []).filter(e=>e.registrationId===reg && e.month===month)});
  else return false;
  return true;
}
