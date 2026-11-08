import { open, rename, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// The manifest becomes visible before either primary file is replaced. Its contents
// can be replayed until both replacements are durable on the local filesystem.
const pending = ".financer-pending-book.json";
async function syncDirectory(folder) {
  const handle=await open(folder,"r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function replaceJson(file,value) {
  const temp=file+"."+randomUUID()+".tmp";
  const handle=await open(temp,"wx",0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value,null,2)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp,file);
  } finally { await unlink(temp).catch(e=>{if(e.code!=="ENOENT")throw e;}); }
}
async function apply(folder,book) {
  if (book.version!==1 || book.company?.id!==path.basename(folder) || !Array.isArray(book.vouchers)) throw new Error("The pending book transaction is invalid");
  await replaceJson(path.join(folder,"company.json"),book.company);
  await replaceJson(path.join(folder,"vouchers.json"),book.vouchers);
  await syncDirectory(folder);
  await unlink(path.join(folder,pending));
  await syncDirectory(folder);
}
export async function recoverBook(folder) {
  let data;
  try { data=await readFile(path.join(folder,pending),"utf8"); }
  catch(error){ if(error.code==="ENOENT")return; throw error; }
  await apply(folder,JSON.parse(data));
}
export async function commitBook(folder,company,vouchers) {
  const book={version:1,company,vouchers};
  await replaceJson(path.join(folder,pending),book);
  await syncDirectory(folder);
  await apply(folder,book);
}
