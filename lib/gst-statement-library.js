import { filedRecords, verifyFiledRecords } from "./gst-filed-source.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { buildToleranceChange, reconcile2B } from "./gst-reconcile.js";
import { assertItcImsClaim } from "./gst-itc.js";
import { assertImsBook, attachIms, buildImsAction, imsActions, imsHistory, IMS_ACTIONS, IMS_SOURCES, replayedImsAction } from "./gst-ims.js";

const pack = promisify(gzip), unpack = promisify(gunzip);
const MAX_BYTES = 32 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceId = hashes => hashes.length === 1 ? hashes[0] : digest(hashes.slice().sort().join("\n"));
function checkedFilename(value) {
  if (typeof value !== "string" || !value.trim() || /[\\/\x00-\x1f\x7f]/.test(value) || value.length > 220) throw new Error("Invalid statement filename");
  return value;
}
function parse(bytes) {
  try { return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)); }
  catch { throw new Error("Choose original UTF-8 GSTR-2B JSON files"); }
}
function unbase64(text,max) {
  if (typeof text !== "string" || text.length > 4*Math.ceil(max/3) || !text.length || text.length%4) throw new Error("Invalid or oversized encoded GST statement");
  const raw=Buffer.from(text,"base64");
  if (raw.length>max || raw.toString("base64")!==text) throw new Error("Invalid encoded GST statement");
  return raw;
}
function manifest(company) {
  const list=company.gstStatements ?? [];
  if (!Array.isArray(list)) throw new Error("Invalid GST statement library");
  return list;
}
export function assertStatementLibrary(company) {
  const ids=new Set(), seen=new Map();
  for (const row of manifest(company)) {
    if (!row || !SHA.test(row.id) || ids.has(row.id) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month) || !company.gst?.registrations?.some(r=>r.id===row.registrationId && r.gstin===row.gstin)) throw new Error("Invalid statement period, registration or identity");
    if (!Array.isArray(row.files) || !row.files.length || row.files.length>100 || typeof row.savedAt!=="string" || !Number.isFinite(Date.parse(row.savedAt))) throw new Error("Invalid saved statement metadata");
    let size=0;
    for (const f of row.files) {
      checkedFilename(f.name);
      if (!SHA.test(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes<=0 || (seen.has(f.sha256)&&seen.get(f.sha256)!==f.bytes)) throw new Error("Invalid saved statement file digest or size");
      size+=f.bytes; seen.set(f.sha256,f.bytes);
    }
    if (size>MAX_BYTES || new Set(row.files.map(f=>f.sha256)).size!==row.files.length || sourceId(row.files.map(f=>f.sha256))!==row.id) throw new Error("Saved statement files do not match their identity");
    ids.add(row.id);
  }
  for (const record of company.gst?.itc?.records || []) {
    const ref = record.evidence?.statement;
    if (!ref) continue;
    const source = manifest(company).find(s=>s.id===ref.id);
    if (!source || source.registrationId!==record.registrationId || source.month!==ref.period || ref.sha256!==source.id) throw new Error("The ITC review is missing its original statement evidence");
  }
  assertImsBook(company);
}
const folder = companyDir => path.join(companyDir,"gst-statement-files");
async function putBlob(companyDir,hash,bytes) {
  const parent=folder(companyDir),target=path.join(parent,hash+".gz");
  await mkdir(parent,{recursive:true,mode:0o700});
  const temp=target+"."+randomUUID()+".tmp";
  try {
    await writeFile(temp,bytes,{mode:0o600}); await rename(temp,target);
  } finally { await rm(temp,{force:true}); }
}
async function decodeBlob(compressed,meta) {
  const raw=await unpack(compressed,{maxOutputLength:meta.bytes});
  if (raw.length!==meta.bytes || digest(raw)!==meta.sha256) throw new Error("The saved GST statement file failed its content check");
  return raw;
}
function selected(company,id) {
  const entry = manifest(company).find(it=>it.id===id);
  if (!entry) throw new Error("The selected statement is not in this company");
  return entry;
}
function verifyRows(report, id, company, registrationId) {
  // Stable across split-file ordering and book changes. Identical duplicates keep separate ordinals.
  const seen = new Map();
  report.results.forEach(row=>{
    if (row.portalValue===undefined) return;
    const fields=Object.entries(row.values).map(([k,v])=>[k,v.portal]);
    const hash=digest(JSON.stringify([id,row.section,row.gstin,row.number,row.date,row.original || null,fields,row.statementITC,row.reason,row.imsStatus]));
    const occurrence=seen.get(hash)||0; seen.set(hash,occurrence+1);
    row.statementRowKey=digest(hash+"|"+occurrence);
  });
  // IMS actions are saved per statement row key, so attach them again once keys exist.
  return attachIms(report, company, registrationId);
}
export async function recordStatement(companyDir,company,vouchers,reg,month,input) {
  if (!Array.isArray(input.files) || !input.files.length || input.files.length>100) throw new Error("Choose the statement's JSON files");
  const raw=[], files=[];
  let remaining=MAX_BYTES;
  for (const f of input.files) {
    const name=checkedFilename(f.name);
    const bytes=unbase64(f.base64,remaining);
    remaining-=bytes.length;
    raw.push(bytes); files.push({name,bytes:bytes.length,sha256:digest(bytes)});
  }
  const id=sourceId(files.map(f=>f.sha256));
  const report=verifyRows(reconcile2B(company,vouchers,reg,month,raw.map(parse)),id,company,reg);
  const prior=manifest(company).find(it=>it.id===id);
  const statement=prior || {id,month,registrationId:reg,gstin:report.gstin,savedAt:new Date().toISOString(),files};
  if (prior && (prior.month!==month || prior.registrationId!==reg)) throw new Error("These bytes already belong to another statement registration or period");
  // Writing verified blobs before the manifest keeps every published reference readable after retry.
  for (let i=0;i<raw.length;i++) await putBlob(companyDir,files[i].sha256,await pack(raw[i],{level:3}));
  if (!prior) { company.gstStatements=[...manifest(company),statement]; assertStatementLibrary(company); }
  return { ...report,statement,replayed:Boolean(prior) };
}
export async function originalStatementFile(companyDir,company,id,index) {
  const entry=selected(company,id), file=entry.files[index];
  if (!file || !Number.isInteger(index)) throw new Error("Choose a statement source file");
  const raw=await decodeBlob(await readFile(path.join(folder(companyDir),file.sha256+".gz")),file);
  return {raw,name:file.name};
}
export async function matchSavedStatement(companyDir,company,vouchers,id,options={}) {
  const statement=selected(company,id),parts=[];
  for (let i=0;i<statement.files.length;i++) parts.push(parse((await originalStatementFile(companyDir,company,id,i)).raw));
  return {...verifyRows(reconcile2B(company,vouchers,statement.registrationId,statement.month,parts,options),id,company,statement.registrationId),statement};
}
export async function verifyItcStatement(companyDir,company,vouchers,invoiceId,reference,action) {
  if (!reference) return;
  const {statement,results}=await matchSavedStatement(companyDir,company,vouchers,reference.id,{rule37:false});
  const row=results.find(r=>r.statementRowKey===reference.rowKey && r.bookId===invoiceId);
  if (!row || reference.sha256!==statement.id || reference.period!==statement.month ||
      reference.availability!==row.statementITC || (reference.reason || "")!==(row.reason || "") || reference.matchStatus!==row.status) throw new Error("The GST statement evidence does not match this purchase and document row");
  assertItcImsClaim(action,row);
}
function sourceFiles(company) {
  const purchases = manifest(company).flatMap(row => row.files);
  const outward = filedRecords(company).map(row => row.originalFiling.source);
  const files = new Map();
  for (const f of [...purchases, ...outward]) {
    if (!SHA.test(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes <= 0 || f.bytes > MAX_BYTES ||
        (files.has(f.sha256) && files.get(f.sha256).bytes !== f.bytes)) throw new Error("Invalid GST source file identity or length");
    files.set(f.sha256,f);
  }
  return files;
}

export async function saveFiledSource(companyDir,company,record,base64) {
  const source = record.originalFiling.source;
  if (!source) {
    if (base64 !== undefined) throw new Error("Choose a reported document before saving a return file");
    return;
  }
  checkedFilename(source.fileName);
  const bytes = unbase64(base64,MAX_BYTES);
  if (bytes.length !== source.bytes || digest(bytes) !== source.sha256) throw new Error("The original GSTR-1 file differs from the selected file");
  verifyFiledRecords(bytes,company,[record]);
  await putBlob(companyDir,source.sha256,await pack(bytes,{level:3}));
}

export async function originalFiledSource(companyDir,company,hash) {
  const source = filedRecords(company).find(row => row.originalFiling.source.sha256 === hash)?.originalFiling.source;
  if (!source || !SHA.test(hash)) throw new Error("The original GSTR-1 file is not linked to this company");
  checkedFilename(source.fileName);
  const bytes = await readFile(path.join(folder(companyDir),hash+".gz"));
  return {name:source.fileName,raw:await decodeBlob(bytes,source)};
}
export async function attachStatementFiles(companyDir,backup) {
  const sources = sourceFiles(backup.company);
  if (!sources.size) return backup;
  assertStatementLibrary(backup.company);
  const files={};
  for (const f of sources.values()) {
    const bytes=await readFile(path.join(folder(companyDir),f.sha256+".gz"));
    await decodeBlob(bytes,f);
    files[f.sha256]=bytes.toString("base64");
  }
  return {...backup,gstStatementFiles:files};
}
export async function restoreStatementFiles(stage,company,vouchers,files) {
  assertStatementLibrary(company);
  const expected = sourceFiles(company);
  const outward = Map.groupBy(filedRecords(company), row => row.originalFiling.source.sha256);
  if (files===undefined && !expected.size) return;
  if (!files || Array.isArray(files) || typeof files!=="object" || Object.keys(files).length!==expected.size) throw new Error("Use the complete company backup with all original GSTR-2B statement files and linked GSTR-1 files");
  for (const [hash,f] of expected) {
    const bytes=unbase64(files[hash],MAX_BYTES+65536);
    const raw = await decodeBlob(bytes,f);
    if (outward.has(hash)) verifyFiledRecords(raw,company,outward.get(hash));
    await putBlob(stage,hash,bytes);
  }
  for (const statement of manifest(company)) {
    const result=await matchSavedStatement(stage,company,vouchers,statement.id,{rule37:false});
    for (const record of (company.gst?.itc?.records || []).filter(r=>r.evidence?.statement?.id===statement.id)) {
      const ref=record.evidence.statement;
      // Match status is a snapshot of the books at review time; later books can introduce candidates.
      const row=result.results.find(r=>r.statementRowKey===ref.rowKey && (r.bookId===record.invoiceId || r.candidates?.some(c=>c.id===record.invoiceId)));
      if (!row || row.statementITC!==ref.availability || (row.reason || "")!==(ref.reason || "")) throw new Error("The restored ITC review refers to a different statement row");
    }
    for (const action of imsActions(company).filter(a=>a.statementId===statement.id)) {
      if (!result.results.some(r=>r.statementRowKey===action.rowKey)) throw new Error("The restored IMS action refers to a different statement row");
    }
  }
}

/** Rows of one saved GSTR-2B (the latest for the registration when none is named) with their IMS actions and history. */
export async function imsStatementView(companyDir,company,vouchers,registrationId,statementId) {
  const reg=company.gst?.registrations?.find(r=>r.id===registrationId);
  if (!reg) throw new Error("Choose a saved GST registration");
  const saved=manifest(company).filter(s=>s.registrationId===registrationId);
  const statement=statementId ? saved.find(s=>s.id===statementId) : saved.toSorted((a,b)=>a.month.localeCompare(b.month) || a.savedAt.localeCompare(b.savedAt)).at(-1);
  if (!statement) throw new Error(statementId ? "The selected statement is not saved for this registration" : "Save a GSTR-2B statement for this registration first");
  const report=await matchSavedStatement(companyDir,company,vouchers,statement.id);
  const rows=report.results.filter(r=>r.statementRowKey).map(r=>({...r,rowKey:r.statementRowKey,history:imsHistory(company,r.statementRowKey)}));
  return { registrationId, gstin:reg.gstin, month:statement.month, statement:{id:statement.id,month:statement.month,savedAt:statement.savedAt,files:statement.files},
    rows, bookOnly:report.results.filter(r=>r.portalValue===undefined), imsCounts:report.imsCounts, itcAvailable:report.itcAvailable, itcExcludedByIms:report.itcExcludedByIms,
    matchCounts:report.matchCounts, tolerance:report.tolerance, rule37:report.rule37, exceptions:report.exceptions, partial:report.partial, actions:IMS_ACTIONS, sources:IMS_SOURCES };
}

/** Prepares a store change: an IMS action on a saved statement row ("action") or the 2B matching tolerance ("tolerance"). */
export async function prepareImsChange(companyDir,company,vouchers,kind,input) {
  if (kind==="tolerance") return buildToleranceChange(company,input);
  if (kind!=="action") throw new Error("Unknown IMS change");
  const replay=replayedImsAction(company,input);
  if (replay) return replay;
  if (typeof input.statementId!=="string" || !SHA.test(input.statementId)) throw new Error("Choose a saved GSTR-2B statement");
  const statement=selected(company,input.statementId);
  if (statement.registrationId!==input.registration) throw new Error("The statement belongs to a different GST registration");
  const report=await matchSavedStatement(companyDir,company,vouchers,statement.id,{rule37:false});
  const row=report.results.find(r=>r.statementRowKey && r.statementRowKey===input.rowKey);
  if (!row) throw new Error("Choose a document row from this statement");
  return buildImsAction(company,{statement,row},input);
}
