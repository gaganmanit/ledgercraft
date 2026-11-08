import { assertCreditReviews } from "./gst-credit-review.js";
import { assertUniqueGstDocuments } from "./gst-document-identity.js";
import { assertTallyGstBook } from "./tally-gst.js";
import { assertOutwardAmendments } from "./gst-outward-amendments.js";
import { assertItcBook } from "./gst-itc.js";
import { assertStatementLibrary, restoreStatementFiles } from "./gst-statement-library.js";
import { assertStockBook } from "./stock-engine.js";
import { mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { assertVoucher } from "./engine.js";
import { nextNumbers, reservedGroups } from "./groups.js";
import { isIsoDate } from "./money.js";
import { assertRcmBook } from "./gst-rcm.js";
import { assertReconciliation } from "./reconciliation.js";
import { assertGstMasters, assertGstBookReferences } from "./gst.js";
import { checkedSource, copyVoucherMetadata } from "./voucher-metadata.js";
import { syncDirectory } from "./book-transaction.js";

const ID = /^[a-z0-9-]{1,48}$/;

function name(value, label) {
  if (typeof value !== "string" || value.trim().length < 2 || value.length > 80) throw new Error(`Invalid ${label} name`);
}

function unique(items, field, label) {
  const found = new Set();
  for (const item of items) {
    const value = item?.[field];
    if (typeof value !== "string" || (field === "id" && !ID.test(value)) || found.has(value.toLowerCase())) throw new Error(`Invalid or duplicate ${label} ${field}`);
    found.add(value.toLowerCase());
  }
}

export function assertBookAmounts(company, vouchers) {
  const totals = { Dr: 0, Cr: 0 };
  const add = (dc, amount, opening) => {
    if (!["Dr", "Cr"].includes(dc) || !Number.isSafeInteger(amount) || amount < (opening ? 0 : 1)) {
      throw new Error("The book contains an invalid amount");
    }
    totals[dc] += amount;
    if (!Number.isSafeInteger(totals[dc])) throw new Error("The book totals exceed the supported amount");
  };
  for (const ledger of company.ledgers) add(ledger.opening.dc, ledger.opening.paise, true);
  for (const voucher of vouchers) {
    for (const line of voucher.lines) add(line.dc, line.paise, false);
  }
  return totals;
}

export function validateTransfer(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Choose a Ledgercraft company backup or a company.json with vouchers.json");
  if (input.format !== undefined && input.format !== "financer-company") throw new Error("This source is not a Ledgercraft company backup");
  if (input.version !== undefined && input.version !== 1) throw new Error("This Ledgercraft backup version cannot be imported by this app");
  if (input.format === "financer-company" && input.version !== 1) throw new Error("The backup needs its Ledgercraft format version");
  const company = structuredClone(input.company);
  const source = input.vouchers;
  if (!company || typeof company !== "object" || !Array.isArray(company.groups) || !Array.isArray(company.ledgers) || !Array.isArray(source)) throw new Error("The source needs a company, account groups, ledgers, and a flat voucher list");
  name(company.name, "company");
  if (typeof company.id !== "string" || !ID.test(company.id) || !isIsoDate(company.booksFrom)) throw new Error("Invalid company identity or books begin date");
  if (company.groups.length > 10_000 || company.ledgers.length > 100_000 || source.length > 100_000) throw new Error("This backup exceeds the supported book size");
  unique(company.groups, "id", "group");
  unique(company.groups, "name", "group");
  unique(company.ledgers, "id", "ledger");
  unique(company.ledgers, "name", "ledger");
  unique(source, "id", "voucher");
  const groups = new Map(company.groups.map((group) => [group.id, group]));
  const reserved = new Map(reservedGroups().map((group) => [group.id, group]));
  for (const expected of reserved.values()) {
    const group = groups.get(expected.id);
    if (!group || Object.keys(expected).some((key) => group[key] !== expected[key])) throw new Error("A reserved account group was changed or removed");
  }
  for (const group of company.groups) {
    name(group.name, "group");
    if (reserved.has(group.id)) continue;
    if (group.reserved !== false || group.nature !== null || group.gross !== false || group.cashBank !== false || !groups.has(group.parentId)) throw new Error("Custom account groups must inherit a valid parent group");
    const seen = new Set([group.id]);
    let parent = groups.get(group.parentId);
    while (parent) {
      if (seen.has(parent.id)) throw new Error("The group tree contains a cycle");
      seen.add(parent.id);
      parent = groups.get(parent.parentId);
    }
  }
  for (const ledger of company.ledgers) {
    name(ledger.name, "ledger");
    if (!groups.has(ledger.groupId) || !ledger.opening || !["Dr", "Cr"].includes(ledger.opening.dc) || !Number.isSafeInteger(ledger.opening.paise) || ledger.opening.paise < 0) throw new Error("A ledger has an invalid group or opening balance");
  }
  assertGstMasters(company);
  assertStatementLibrary(company);
  if (company.source !== undefined) company.source = checkedSource(company.source);
  const vouchers = [];
  const numbers = new Set();
  for (const voucher of source) {
    if (typeof voucher.number !== "string" || voucher.number !== voucher.number.trim() || typeof voucher.narration !== "string" || voucher.narration.length > 280 || !Array.isArray(voucher.lines) || voucher.lines.some((line) => !Number.isSafeInteger(line.paise))) throw new Error("A voucher contains an invalid number, narration, or amount");
    const numberKey = `${voucher.type}\u0000${voucher.number}`;
    if (numbers.has(numberKey)) throw new Error("That voucher number is already used for this type");
    numbers.add(numberKey);
    const checked = assertVoucher(company, voucher, [], voucher.id);
    if (checked.lines.length !== voucher.lines.length) throw new Error("A voucher contains an empty posting line");
    vouchers.push(copyVoucherMetadata(company, voucher, checked));
  }
  assertUniqueGstDocuments(vouchers);
  assertGstBookReferences(vouchers);
  assertBookAmounts(company, vouchers);
  assertReconciliation(company, vouchers);
  assertRcmBook(company, vouchers);
  assertItcBook(company,vouchers);
  assertOutwardAmendments(company,vouchers);
  assertCreditReviews(company,vouchers);
  assertTallyGstBook(company,vouchers);
  assertStockBook(company, vouchers);
  return { company, vouchers };
}

export function companyBackup(company, vouchers) {
  return { format: "financer-company", version: 1, exportedAt: new Date().toISOString(), company, vouchers };
}

async function writeDurable(file, text) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(text); await handle.sync(); }
  finally { await handle.close(); }
}

// Flush every file and folder under the import stage before it is published.
async function syncTree(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) await syncTree(target);
    else if (entry.isFile()) {
      const handle = await open(target, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    }
  }
  await syncDirectory(folder);
}

export async function importCompany(dataDir, input) {
  if (input?.company?.source?.system === "tally" && input.company.source.archive !== "accounting-only") throw new Error("Restore the full Tally source archive to retain its source files, or choose the explicit accounting-only import");
  const { company, vouchers } = validateTransfer(input);
  const root = path.join(dataDir, "companies");
  await mkdir(root, { recursive: true });
  const stage = await mkdtemp(path.join(root, ".financer-import-"));
  company.id = `import-${randomBytes(12).toString("hex")}`;
  try {
    await writeDurable(path.join(stage, "company.json"), JSON.stringify(company, null, 2));
    await writeDurable(path.join(stage, "vouchers.json"), JSON.stringify(vouchers, null, 2));
    await restoreStatementFiles(stage,company,vouchers,input.gstStatementFiles);
    await syncTree(stage);
    await rename(stage, path.join(root, company.id));
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  // The company is already published here; this only makes the rename durable.
  await syncDirectory(root);
  return { company, vouchers, nextNumbers: nextNumbers(vouchers) };
}
