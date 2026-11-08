import { Worker } from "node:worker_threads";
import { promisify } from "node:util";
import { planTallyGstPromotion } from "./tally-gst.js";
import { attachStatementFiles, restoreStatementFiles } from "./gst-statement-library.js";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { gzip, gunzip, gzipSync } from "node:zlib";
import path from "node:path";
import { companyBackup, validateTransfer } from "./transfer.js";
import { assertTallySourceRecords, hash, previewTally, restoreTallyArchive, replayTallySource } from "./tally-import.js";
import { tallyRecordSummary, tallyRecordView } from "./tally-read.js";
import { activateTallyBillReferences, planTallyBillReferences, TALLY_BILL_SOURCES } from "./tally-bills.js";
import { activateTallyStockProjection, planTallyStockProjection, TALLY_STOCK_SOURCES } from "./tally-stock.js";
import { accountingBookHash, exportTallyDayBook, exportTallyMasters } from "./tally-export.js";

const TOKEN = /^[a-f0-9]{24}$/;
const COMPANY = /^[a-z0-9-]{1,48}$/;
const pending = new Map();
const previewQueue = new Map();
const compress=promisify(gzip), decompress=promisify(gunzip);

function responsePreview(token, preview) {
  return {
    token, canCommit: preview.canCommit, summary: preview.summary,
    issues: preview.issues, mapping: preview.mapping,
    ...(preview.accountGroupMappings ? {overlaps:preview.overlaps,accountGroupMappings:preview.accountGroupMappings,accountGroups:preview.accountGroups} : {}),
    files: preview.sources.map(({ name, bytes, sha256, encoding }) => ({ name, bytes, sha256, encoding })),
  };
}

async function writeJson(file, input, spaces=2) {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(input, null, spaces), { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

async function readPreview(dataDir, token) {
  if (!TOKEN.test(token)) throw new Error("Preview this Tally import before confirming it");
  const folder = path.join(dataDir, "tally-previews", token);
  try {
    const compressed=await readFile(path.join(folder,"preview.json.gz"));
    const bytes=await decompress(compressed,{maxOutputLength:512*1024*1024});
    return {folder,preview:JSON.parse(bytes.toString("utf8"))};
  } catch (error) {
    if (error.code!=="ENOENT") throw error;
    // Uncommitted previews from earlier Financer releases use plain JSON.
    return {folder,preview:JSON.parse(await readFile(path.join(folder,"preview.json"),"utf8"))};
  }
}

export async function writeSourcePreview(dataDir, input) {
  let preview;
  if (input.archive) preview = restoreTallyArchive(input.archive);
  else if (Array.isArray(input.files) && input.files.length === 1 && /\.json$/i.test(input.files[0].name)) {
    const bytes = Buffer.from(input.files[0].base64 || "", "base64");
    let archive;
    try { archive = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { /* Normal exchange parsing below reports encoding and JSON errors. */ }
    preview = archive?.format === "financer-tally-archive" ? restoreTallyArchive(archive) : previewTally(input.files, input);
  } else preview = previewTally(input.files, input);
  const token = randomBytes(12).toString("hex");
  const folder = path.join(dataDir, "tally-previews", token);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const stored = { overlaps:preview.overlaps, accountGroups:preview.accountGroups, accountGroupMappings:preview.accountGroupMappings, gstStatementFiles:preview.gstStatementFiles, company: preview.company, vouchers: preview.vouchers, sources: preview.sources, records: preview.records, issues: preview.issues, mapping: preview.mapping, summary: preview.summary, canCommit: preview.canCommit, sourceBookHash: preview.sourceBookHash };
  const report=responsePreview(token,stored);
  try {
    const bytes=await compress(JSON.stringify(stored),{level:1});
    await writeFile(path.join(folder,"preview.json.gz"),bytes,{mode:0o600,flag:"wx"});
    await writeJson(path.join(folder,"report.json"),report);
  } catch (error) {
    await rm(folder,{recursive:true,force:true});
    throw error;
  }
  return report;
}

// A workbook may take seconds to expand and reconcile. Keep it off the local
// accounting server's event loop, and process one large preview per workstation.
async function previewSource(dataDir,input) {
  const large=input.archive || input.files?.some(file=>/\.(zip|xlsx)$/i.test(file.name) || file.base64?.length>500000);
  if (!large) return writeSourcePreview(dataDir,input);
  return runImportWorker(dataDir,{job:"preview",input});
}
async function runImportWorker(dataDir,task) {
  const key=path.resolve(dataDir);
  const prior=previewQueue.get(key) || Promise.resolve();
  const result=prior.catch(()=>{}).then(()=>new Promise((resolve,reject)=>{
    const worker=new Worker(new URL("./tally-preview-thread.js",import.meta.url),{workerData:{dataDir,...task},execArgv:[]});
    worker.once("message",message=>message.error ? reject(new Error(message.error)) : resolve(message.result));
    worker.once("error",reject);
    worker.once("exit",code=>reject(new Error(`The local Tally import stopped (exit ${code})`)));
  }));
  previewQueue.set(key,result);
  try {return await result;}
  finally {if(previewQueue.get(key)===result) previewQueue.delete(key);}
}

async function savedPreviewReport(dataDir,token) {
  if (!TOKEN.test(token)) throw new Error("Choose a valid Tally preview");
  try {return JSON.parse(await readFile(path.join(dataDir,"tally-previews",token,"report.json"),"utf8"));}
  catch (error) {if (error.code!=="ENOENT") throw error;}
  const {preview}=await readPreview(dataDir,token);
  return responsePreview(token,preview);
}

export async function publishSourceCompany(dataDir,token) {
  if (!TOKEN.test(token)) throw new Error("Choose a valid Tally preview");
  const id = `tally-${token}`;
  const companies = path.join(dataDir, "companies");
  const target = path.join(companies, id);
  try {
    const manifest = JSON.parse(await readFile(path.join(target, "tally-source", "manifest.json"), "utf8"));
    if (manifest.token === token) return {id, alreadyImported:true, summary:manifest.summary};
    throw new Error("The target company already exists");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const { folder, preview } = await readPreview(dataDir, token);
  if (!preview.canCommit || preview.issues.some(issue=>issue.severity==="blocking")) throw new Error("Resolve the import exceptions and create a new preview");
  const { company, vouchers } = validateTransfer({ company: preview.company, vouchers: preview.vouchers });
  // Source metadata is immutable provenance. validateTransfer validates its bounded shape.
  company.id = id;
  const stage = path.join(companies, `.tally-${token}-${randomBytes(6).toString("hex")}`);
  await mkdir(path.join(stage, "tally-source", "files"), { recursive: true, mode: 0o700 });
  try {
    const files = [];
    for (let index = 0; index < preview.sources.length; index++) {
      const source = preview.sources[index];
      const bytes = Buffer.from(source.base64, "base64");
      if (hash(bytes) !== source.sha256) throw new Error("The source bytes changed after preview");
      const storedName = `${String(index + 1).padStart(2, "0")}-${source.sha256.slice(0, 12)}.source`;
      await writeFile(path.join(stage, "tally-source", "files", storedName), bytes, { mode: 0o600 });
      files.push({ name: source.name, storedName, sha256: source.sha256, bytes: bytes.length, encoding: source.encoding });
    }
    await writeJson(path.join(stage, "tally-source", "manifest.json"), { format: "financer-tally-source", version: 1, token, importedAt: new Date().toISOString(), files, summary: preview.summary, issues: preview.issues, sourceBookHash: preview.sourceBookHash === null ? null : preview.sourceBookHash || accountingBookHash(company, vouchers) });
    await writeJson(path.join(stage, "tally-source", "records.json"), preview.records,0);
    await writeJson(path.join(stage, "tally-source", "mapping.json"), preview.mapping);
    await writeJson(path.join(stage, "company.json"), company);
    await writeJson(path.join(stage, "vouchers.json"), vouchers);
    await restoreStatementFiles(stage,company,vouchers,preview.gstStatementFiles);
    await rename(stage, target);
    await writeJson(path.join(folder, "result.json"), { companyId: id, completedAt: new Date().toISOString() });
    // The company archive now contains all original bytes, records and the mapping.
    // Keep the compact preview report and receipt. Idempotent commit reads the manifest.
    await rm(path.join(folder,"preview.json.gz"),{force:true}).catch(()=>{});
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  return {id,alreadyImported:false,summary:preview.summary};
}
async function commitSource(dataDir,store,token,compact=false) {
  if (!TOKEN.test(token)) throw new Error("Choose a valid Tally preview");
  const key=path.resolve(dataDir)+":"+token;
  let work=pending.get(key);
  if (!work) {
    work=(async()=>{
      const previewFile=path.join(dataDir,"tally-previews",token,"preview.json.gz");
      let large=false;
      try {large=(await stat(previewFile)).size>131072;} catch (error) {if (error.code!=="ENOENT") throw error;}
      return large ? runImportWorker(dataDir,{job:"commit",token}) : publishSourceCompany(dataDir,token);
    })();
    pending.set(key,work);
  }
  try {
    const receipt=await work;
    const result=compact ? {company:{id:receipt.id}} : await store.get(receipt.id);
    return {...result,tallyImport:receipt};
  } finally {if(pending.get(key)===work) pending.delete(key);}
}

export async function tallyArchive(dataDir, store, id, bundle) {
  if (!COMPANY.test(id)) throw new Error("Unknown company");
  const { company, vouchers } = bundle || await store.get(id);
  const folder = path.join(dataDir, "companies", id, "tally-source");
  const manifest = JSON.parse(await readFile(path.join(folder, "manifest.json"), "utf8"));
  const records = JSON.parse(await readFile(path.join(folder, "records.json"), "utf8"));
  const sources = [];
  for (const file of manifest.files) {
    if (!/^\d{2}-[a-f0-9]{12}\.source$/.test(file.storedName)) throw new Error("Invalid archived source path");
    const bytes = await readFile(path.join(folder, "files", file.storedName));
    if (hash(bytes) !== file.sha256) throw new Error("An archived source file hash does not match");
    sources.push({ name: file.name, sha256: file.sha256, bytes: bytes.length, encoding: file.encoding, base64: bytes.toString("base64") });
  }
  const compressed = gzipSync(Buffer.from(JSON.stringify({ sources, records, sourceBookHash: manifest.sourceBookHash || null })), { level: 1 });
  return attachStatementFiles(path.join(dataDir,"companies",id),{ ...companyBackup(company, vouchers), format: "financer-tally-archive", sourcePayload: { encoding: "gzip+base64", sha256: hash(compressed), data: compressed.toString("base64") }, sourceSummary: manifest.summary, sourceIssues: manifest.issues });
}

export async function importTallyArchive(dataDir, store, input) {
  const prepared = await previewSource(dataDir, { archive: input });
  return commitSource(dataDir, store, prepared.token);
}

async function billSourceRecords(dataDir, id, verify = false, replayCompany) {
  if (!COMPANY.test(id)) throw new Error("Choose an imported Tally company");
  const folder = path.join(dataDir, "companies", id, "tally-source");
  let records, manifest;
  try {
    records = JSON.parse(await readFile(path.join(folder, "records.json"), "utf8"));
    if (verify) manifest = JSON.parse(await readFile(path.join(folder, "manifest.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Restore this company's full Tally source archive before activating its source details");
    throw error;
  }
  if (!Array.isArray(records)) throw new Error("Invalid Tally source records");
  if (verify) {
    if (!Array.isArray(manifest.files) || manifest.files.length > 24) throw new Error("Invalid Tally source file inventory");
    const sources = [];
    let total = 0;
    for (const file of manifest.files) {
      if (!/^\d{2}-[a-f0-9]{12}\.source$/.test(file.storedName)) throw new Error("Invalid Tally source filename");
      const bytes = await readFile(path.join(folder, "files", file.storedName));
      total += bytes.length;
      if (total > 40 * 1024 * 1024 || hash(bytes) !== file.sha256) throw new Error("The preserved Tally source file hash does not match");
      sources.push({ name: file.name, sha256: file.sha256, base64: bytes.toString("base64") });
    }
    if (replayCompany) return replayTallySource(replayCompany,sources,records).records;
    assertTallySourceRecords(sources, records);
  }
  return records;
}
function billResponse(plan, url) {
  const query = (url.searchParams.get("q") || "").trim().toLowerCase();
  const status = url.searchParams.get("status") || "";
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset"), 10) || 0);
  const rows = plan.rows.filter(row => (!status || row.status === status) && (!query || [row.partyName, row.reference, row.method, row.date, row.message].join(" ").toLowerCase().includes(query)));
  return { summary: plan.summary, sourceHash: plan.sourceHash, reviewHash: plan.reviewHash, revision: plan.revision, canActivate: plan.canActivate, offset, total: rows.length, rows: rows.slice(offset, offset + 100), sources: TALLY_BILL_SOURCES };
}

const gstReviewCache=new WeakMap();
async function sourceGstReport(dataDir,id,book) {
  const file=path.join(dataDir,"companies",id,"tally-source","records.json");
  let stamp;
  try {stamp=await stat(file,{bigint:true});}
  catch(error) {if(error.code==="ENOENT") throw new Error("Restore this company's full Tally archive to review its source GST records"); throw error;}
  const key=[stamp.dev,stamp.ino,stamp.size,stamp.mtimeNs,stamp.ctimeNs].join(":");
  const cached=gstReviewCache.get(book);
  if (cached?.key===key) return cached.report;
  const records=await billSourceRecords(dataDir,id);
  const report=planTallyGstPromotion(book.company,book.vouchers,records);
  if (stamp.size<=32n*1024n*1024n) gstReviewCache.set(book,{key,report});
  return report;
}
function gstReviewPage(report,params) {
  const q=(params.get("q")||"").trim().toLowerCase(), requested=params.get("offset") || "0";
  if (q.length>200 || !/^\d{1,12}$/.test(requested)) throw new Error("Choose a valid source GST search and page");
  const words=q.split(/\s+/).filter(Boolean),limit=20;
  const rows=words.length ? report.rows.filter(row=>{
    const text=[row.recordId,row.number,row.sourceNumber,row.date,row.status,row.source?.partyName,row.source?.gstin].filter(Boolean).join(" ").toLowerCase();
    return words.every(word=>text.includes(word));
  }) : report.rows;
  const offset=Math.min(Number(requested),Math.max(0,Math.floor((rows.length-1)/limit)*limit));
  return {...report,rows:rows.slice(offset,offset+limit),page:{offset,limit,total:rows.length}};
}

export async function handleTallyRoute({ req, res, url, parts, dataDir, store, readBody, send }) {
  if (parts[0]==="api" && parts[1]==="tally" && parts[2]==="companies" && parts[3] && parts[4]==="gst") {
    const id=parts[3];
    if (!COMPANY.test(id)) throw new Error("Choose an imported Tally company");
    if (req.method==="GET" && (parts.length===5 || parts.length===6 && parts[5]==="report")) {
      const book=await store.snapshot(id);
      const report=await sourceGstReport(dataDir,id,book);
      if (parts[5]==="report") {
        res.writeHead(200,{"content-type":"application/json; charset=utf-8","content-disposition":`attachment; filename="${id}-gst-source-review.json"`,"cache-control":"no-store"});
        res.end(JSON.stringify(report));
      } else send(res,200,url.searchParams.get("view")==="desk" ? gstReviewPage(report,url.searchParams) : report);
      return true;
    }
    if (req.method==="POST" && parts.length===6 && ["mapping","activate"].includes(parts[5])) {
      const input=await readBody(req);
      const {company}=await store.snapshot(id);
      const records=await billSourceRecords(dataDir,id,true,company);
      const changed=await store.reviewTallyGst(id,parts[5],records,input);
      send(res,200,input.compact===true ? {result:changed.result,revision:changed.revision,replayed:changed.replayed} : changed);
      return true;
    }
    throw new Error("Unknown Tally GST source review action");
  }
  if (parts[0] === "api" && parts[1] === "tally" && parts[2] === "companies" && parts[3] && parts[4] === "stock") {
    const id = decodeURIComponent(parts[3]);
    if (!COMPANY.test(id)) throw new Error("Choose an imported Tally company");
    if (req.method === "GET" && (parts.length === 5 || (parts.length === 6 && parts[5] === "report"))) {
      const [{ company, vouchers }, records] = await Promise.all([store.snapshot(id), billSourceRecords(dataDir, id)]);
      const { stock, ...plan } = planTallyStockProjection(company, vouchers, records);
      if (parts[5] === "report") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${id}-stock-source-review.json"`, "cache-control": "no-store" });
        res.end(JSON.stringify({ ...plan, sources: TALLY_STOCK_SOURCES }));
      } else {
        const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset"), 10) || 0);
        send(res, 200, { ...plan, rows: plan.rows.slice(offset, offset + 100), offset, total: plan.rows.length, sources: TALLY_STOCK_SOURCES });
      }
      return true;
    }
    if (req.method === "POST" && parts.length === 6 && parts[5] === "activate") {
      const input = await readBody(req);
      if (!/^[a-f0-9]{64}$/.test(input.reviewHash || "")) throw new Error("Review this Tally stock before activating it");
      const records = await billSourceRecords(dataDir, id, true);
      let activated;
      await store.mutateCompanySection(id, "stock", (current, book) => {
        activated = activateTallyStockProjection(current, book, records, input);
        return activated.section;
      });
      send(res, 200, { result: activated.result, revision: activated.section?.revision || 0, replayed: activated.replayed });
      return true;
    }
    send(res, 404, { error: "Unknown Tally stock action" });
    return true;
  }
  if (parts[0] === "api" && parts[1] === "tally" && parts[2] === "companies" && parts[3] && parts[4] === "bills") {
    const id = decodeURIComponent(parts[3]);
    if (!COMPANY.test(id)) throw new Error("Choose an imported Tally company");
    if (req.method === "GET" && (parts.length === 5 || (parts.length === 6 && parts[5] === "report"))) {
      const [{ company, vouchers }, records] = await Promise.all([store.snapshot(id), billSourceRecords(dataDir, id)]);
      const plan = planTallyBillReferences(company, vouchers, records);
      if (parts[5] === "report") {
        const { meta, ...report } = plan;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${id}-bill-reference-review.json"`, "cache-control": "no-store" });
        res.end(JSON.stringify({ ...report, sources: TALLY_BILL_SOURCES }));
      } else send(res, 200, billResponse(plan, url));
      return true;
    }
    if (req.method === "POST" && parts.length === 6 && parts[5] === "activate") {
      const input = await readBody(req);
      if (typeof input.reviewHash !== "string" || !/^[a-f0-9]{64}$/.test(input.reviewHash)) throw new Error("Review these Tally bill references before activating them");
      const records = await billSourceRecords(dataDir, id, true);
      let activated;
      await store.mutateCompanySection(id, "reconciliation", (current, book) => {
        activated = activateTallyBillReferences(current, book, records, input);
        return activated.section;
      });
      send(res, 200, { revision: activated.section.revision, result: activated.result, replayed: activated.replayed });
      return true;
    }
    send(res, 404, { error: "Unknown Tally bill reference action" });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/tally/preview") {
    send(res, 200, await previewSource(dataDir, await readBody(req)));
    return true;
  }
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "tally" && parts[2] === "preview" && parts[3] && parts[4] === "report" && parts.length === 5) {
    const report=await savedPreviewReport(dataDir,parts[3]);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="tally-import-${parts[3]}.json"`, "cache-control": "no-store" });
    res.end(JSON.stringify(report, null, 2));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/tally/commit") {
    const input = await readBody(req);
    if (input.acknowledge !== true || !TOKEN.test(input.token)) throw new Error("Review and confirm this import before creating the company");
    send(res,201,await commitSource(dataDir,store,input.token,input.compact===true));
    return true;
  }
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "tally" && parts[2] === "companies" && COMPANY.test(parts[3] || "") && parts[4] === "export" && ["masters", "daybook"].includes(parts[5]) && parts.length === 6) {
    const { company, vouchers } = await store.snapshot(parts[3]);
    const type = parts[5];
    const from = url.searchParams.get("from") || company.booksFrom;
    const to = url.searchParams.get("to") || [...vouchers, ...(company.stock?.journals || [])].reduce((latest, entry) => entry.date > latest ? entry.date : latest, company.booksFrom);
    const xml = type === "masters" ? exportTallyMasters(company,vouchers) : exportTallyDayBook(company, vouchers, from, to);
    res.writeHead(200, { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="${type === "masters" ? "Masters" : "DayBook"}-accounting.xml"`, "cache-control": "no-store" });
    res.end(xml);
    return true;
  }
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "tally" && parts[2] === "companies" && COMPANY.test(parts[3] || "") && ["files", "file"].includes(parts[4])) {
    const bundle = await store.snapshot(parts[3]);
    const folder = path.join(dataDir, "companies", parts[3], "tally-source");
    const manifest = JSON.parse(await readFile(path.join(folder, "manifest.json"), "utf8"));
    if (parts[4] === "files") {
      send(res, 200, { files: manifest.files.map((file, index) => ({ index, name: file.name, bytes: file.bytes, sha256: file.sha256 })), unchangedSinceImport: manifest.sourceBookHash ? accountingBookHash(bundle.company, bundle.vouchers) === manifest.sourceBookHash : null });
    } else {
      if (!/^\d{1,2}$/.test(parts[5] || "")) throw new Error("Choose an original source file");
      const file = manifest.files[Number(parts[5])];
      if (!file || !/^\d{2}-[a-f0-9]{12}\.source$/.test(file.storedName)) throw new Error("Choose an original source file");
      const bytes = await readFile(path.join(folder, "files", file.storedName));
      if (hash(bytes) !== file.sha256) throw new Error("The original source file hash does not match");
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.name)}`, "cache-control": "no-store" });
      res.end(bytes);
    }
    return true;
  }
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "tally" && parts[2] === "companies" && COMPANY.test(parts[3] || "") && ["records", "record"].includes(parts[4])) {
    const id = parts[3];
    const folder = path.join(dataDir, "companies", id);
    const company = JSON.parse(await readFile(path.join(folder, "company.json"), "utf8"));
    let records;
    try { records = JSON.parse(await readFile(path.join(folder, "tally-source", "records.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") throw new Error("This company has no Tally source archive"); throw error; }
    const identity = { id: company.id, name: company.name, booksFrom: company.booksFrom };
    if (parts[4] === "record") {
      const record = records.find((entry) => entry.recordId === parts[5]);
      if (!record) throw new Error("That source record is not in this company");
      const detail = tallyRecordView(record);
      if (record.voucherId) {
        const current = (await store.get(id)).vouchers.find((voucher) => voucher.id === record.voucherId);
        detail.deletedAfterImport = !current;
        if (current && record.originalPosting) {
          const posting = { type: current.type, number: current.number, date: current.date, narration: current.narration, lines: current.lines };
          detail.editedAfterImport = JSON.stringify(posting) !== JSON.stringify(record.originalPosting);
        }
      }
      send(res, 200, { company: identity, record: detail });
    } else {
      const type = url.searchParams.get("type") || "";
      const query = (url.searchParams.get("q") || "").toLowerCase().trim();
      const offset = Math.max(0, Math.min(100_000, Number.parseInt(url.searchParams.get("offset"), 10) || 0));
      const counts = {};
      const selected = [];
      for (const record of records) {
        counts[record.type] = (counts[record.type] || 0) + 1;
        if (type && record.type !== type) continue;
        const summary = tallyRecordSummary(record);
        if (!query || [summary.name, summary.hsn, summary.gstin, summary.sourceType, summary.date].some((text) => text.toLowerCase().includes(query))) selected.push(summary);
      }
      send(res, 200, { company: identity, counts, total: selected.length, offset, records: selected.slice(offset, offset + 100) });
    }
    return true;
  }
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "tally" && parts[2] === "companies" && parts[3] && parts[4] === "archive" && parts.length === 5) {
    const id = decodeURIComponent(parts[3]);
    const archive = await tallyArchive(dataDir, store, id);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${id}-full-tally-archive.json"`, "cache-control": "no-store" });
    res.end(JSON.stringify(archive));
    return true;
  }
  return false;
}
