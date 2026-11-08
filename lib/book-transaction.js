import { copyFile, link, open, rename, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// The manifest becomes visible before either primary file is replaced. Its contents
// can be replayed until both replacements are durable on the local filesystem.
const pending = ".financer-pending-book.json";
export const BOOK_FILES = ["company.json", "vouchers.json"];

export async function syncDirectory(folder) {
  const handle=await open(folder,"r");
  try { await handle.sync(); } finally { await handle.close(); }
}

// Write to a fresh temporary file, fsync it, then rename it over the target.
// Callers sync the directory afterwards so the rename itself is durable.
export async function replaceJson(file,value) {
  const temp=file+"."+randomUUID()+".tmp";
  const handle=await open(temp,"wx",0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value,null,2)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp,file);
  } finally { await unlink(temp).catch(e=>{if(e.code!=="ENOENT")throw e;}); }
}

// Keep the current file as a single rolling `<file>.bak` before it is replaced.
// A hard link makes the backup without copying and without a moment in which the
// primary is missing; filesystems without hard links fall back to a copy.
export async function keepBackup(file) {
  const temp=file+".bak."+randomUUID()+".tmp";
  try {
    try { await link(file,temp); }
    catch (error) {
      if (error.code==="ENOENT") return false;
      if (!["EPERM","ENOTSUP","EXDEV","EOPNOTSUPP","EMLINK","ENOSYS"].includes(error.code)) throw error;
      await copyFile(file,temp);
    }
    await rename(temp,file+".bak");
    return true;
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
// `backup` names the primary files whose current version becomes the rolling `.bak`.
// The store leaves out a primary it could not parse, so a good backup is never replaced
// by a damaged file.
export async function commitBook(folder,company,vouchers,{backup=BOOK_FILES}={}) {
  const book={version:1,company,vouchers};
  for (const name of backup) await keepBackup(path.join(folder,name));
  await replaceJson(path.join(folder,pending),book);
  await syncDirectory(folder);
  await apply(folder,book);
}
