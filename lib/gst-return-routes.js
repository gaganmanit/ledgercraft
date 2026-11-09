import { supplierDocumentDate } from "./gst-document-identity.js";
import path from "node:path";
import { matchSavedStatement, originalStatementFile } from "./gst-statement-library.js";
import { directoryEntries } from "./hsn-directory.js";
import { columns, returnWorkbook, worksheetCsv } from "./gst-returns.js";
import { gstrWorkbook } from "./gst-workbook.js";
import { gstr1Export } from "./gst-json.js";
import { reconcile2B } from "./gst-reconcile.js";
import { supplierDocDate } from "./gst.js";
import { itcImsState } from "./gst-itc.js";
import { applyGstr3bSettings, gstr3bExport, gstr3bOptionsFromQuery, gstr3bSettingsView, gstr3bWorking } from "./gst-3b.js";
import { parseRupees } from "./money.js";
export async function handleReturnRoute({ req, res, parts, url, store, dataDir, readBody, send }) {
  if (parts[0] !== "api" || parts[1] !== "companies" || !parts[2] || parts[3] !== "gst-returns") return false;
  const { company, vouchers } = await store.snapshot(decodeURIComponent(parts[2]));
  const reg = url.searchParams.get("registration");
  const month = url.searchParams.get("month");
  const companyDir=path.join(dataDir,"companies",company.id);
  if (req.method === "POST" && parts[4] === "credit-review" && parts.length === 5) {
    send(res, 201, await store.saveCreditReview(company.id, await readBody(req))); return true;
  }
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
    // GSTR-2B lists the document in the supplier's period, which can precede the book date.
    const supplierInvoiceDate=supplierDocDate(invoice);
    for (const entry of (company.gstStatements || []).filter(e=>e.registrationId===invoice.registrationId && e.month>=supplierInvoiceDate.slice(0,7))) {
      const {results}=await matchSavedStatement(companyDir,company,vouchers,entry.id,{rule37:false});
      for (const row of results.filter(r=>r.bookId===invoiceId && r.statementRowKey)) matches.push({id:entry.id,sha256:entry.id,rowKey:row.statementRowKey,period:entry.month,
        availability:row.statementITC,matchStatus:row.status,reason:row.reason,number:row.number,fileName:entry.files[0].name,ims:itcImsState(row)});
    }
    send(res,200,{matches:matches.reverse(),supplierInvoiceDate}); return true;
  }
  if (req.method === "POST" && parts[4] === "reconcile-2b") {
    send(res,200,reconcile2B(company,vouchers,reg,month,await readBody(req)));
    return true;
  }
  // Saved GSTR-3B settings per registration (frequency and preceding-year turnover).
  if (parts[4] === "3b" && parts[5] === "settings" && parts.length === 6) {
    if (req.method === "GET") { send(res, 200, gstr3bSettingsView(company, reg)); return true; }
    if (req.method === "POST") { send(res, 200, await store.saveGstr3bSettings(company.id, reg, await readBody(req))); return true; }
    return false;
  }
  if (req.method !== "GET") return false;
  // GSTR-3B working and GSTN upload JSON. Query: registration, month (YYYY-MM; the
  // quarter's last month when frequency=quarterly), frequency, dueDate, paymentDate,
  // filingDate, cashDate, turnover, credit*/cash*/reversal*/isd* (Igst, Cgst, Sgst,
  // Cess) and importGoodsIgst/importGoodsCess, all amounts in rupees.
  if (parts[4] === "3b" || parts[4] === "3b.json") {
    if (parts.length !== 5) return false;
    // Saved settings are the defaults; frequency and turnover in the query override them.
    const { options, settings } = applyGstr3bSettings(company, reg, gstr3bOptionsFromQuery(url.searchParams, parseRupees));
    const working = gstr3bWorking(company, vouchers, reg, month, options);
    if (parts[4] === "3b") { send(res, 200, { ...working, settings }); return true; }
    const { json, fileName } = gstr3bExport(working);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${fileName}"`, "cache-control": "no-store" });
    res.end(JSON.stringify(json));
    return true;
  }
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
  } else if (parts[4] === "json" && parts.length === 5) {
    const { json, fileName } = gstr1Export(book,{company,vouchers});
    res.writeHead(200,{"content-type":"application/json; charset=utf-8","content-disposition":`attachment; filename="${fileName}"`,"cache-control":"no-store"});
    res.end(JSON.stringify(json));
  } else if (parts[4] === "json" && parts[5] === "summary" && parts.length === 6) {
    send(res,200,gstr1Export(book,{company,vouchers}).summary);
  } else if (parts.length === 4) send(res,200,{...book,columns,statements:(company.gstStatements || []).filter(e=>e.registrationId===reg && e.month===month)});
  else return false;
  return true;
}
