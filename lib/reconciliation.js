import { isDeepStrictEqual } from "node:util";
import { amount, digest, newId, section, SOURCE_REFERENCES, uniqueIds } from "./reconciliation-common.js";
import { assertBankMetadata, importBankStatement, matchBank, updateBankOpening } from "./reconciliation-bank.js";
import { allocateBill, assertBillMetadata, removeBill, saveBill } from "./reconciliation-bills.js";

export { SOURCE_REFERENCES };
export { bankReport, parseBankCsv, previewBankStatement } from "./reconciliation-bank.js";
export { billReport } from "./reconciliation-bills.js";
export { section as reconciliationSection } from "./reconciliation-common.js";

// Statement rows are cached by source and book entries are built once per ledger, so the
// store's re-check of a freshly mutated section costs milliseconds, not a second pass
// over every voucher per match.
export function assertReconciliation(company, vouchers) {
  if (company.reconciliation === undefined) return;
  validateReconciliation(company, vouchers);
}
function validateReconciliation(company, vouchers) {
  const meta = company.reconciliation;
  if (!meta || meta.version !== 1 || !Number.isSafeInteger(meta.revision) || meta.revision < 0 ||
      Object.keys(meta).some(key => !["version", "revision", "statements", "matches", "bills", "allocations", "audit", "sourceActivations"].includes(key))) throw new Error("Invalid reconciliation metadata version");
  for (const key of ["statements", "matches", "bills", "allocations", "audit"]) if (!Array.isArray(meta[key])) throw new Error("Invalid reconciliation metadata records");
  if (meta.revision !== meta.audit.length) throw new Error("Reconciliation revision does not agree with its change history");
  uniqueIds(meta.audit, "reconciliation audit");
  const requestIds = new Set();
  for (const entry of meta.audit) {
    if (typeof entry.action !== "string" || !/^[a-z-]{1,40}$/.test(entry.action) || !/^[a-zA-Z0-9-]{16,80}$/.test(entry.requestId) || requestIds.has(entry.requestId) || !/^[a-f0-9]{64}$/.test(entry.requestHash) || !Number.isFinite(Date.parse(entry.at))) throw new Error("Invalid reconciliation audit entry");
    requestIds.add(entry.requestId);
  }
  if (meta.sourceActivations !== undefined) {
    uniqueIds(meta.sourceActivations, "source activation");
    const sourceKeys = new Set();
    for (const activation of meta.sourceActivations) {
      if (activation.system !== "tally-bills" || activation.version !== 1 || !/^[a-f0-9]{64}$/.test(activation.sourceHash) || !Number.isFinite(Date.parse(activation.at)) || !Array.isArray(activation.targets)) throw new Error("Invalid source bill activation record");
      const keys = new Set();
      for (const target of activation.targets) {
        if (typeof target.sourceKey !== "string" || target.sourceKey.length > 240 || !target.sourceKey.startsWith("r-") || keys.has(target.sourceKey) || !["bill", "allocation"].includes(target.kind) || !/^[a-z0-9-]{1,80}$/.test(target.targetId)) throw new Error("Invalid source bill activation target");
        if (sourceKeys.has(target.sourceKey)) throw new Error("A source bill reference was activated more than once");
        keys.add(target.sourceKey);
        sourceKeys.add(target.sourceKey);
      }
    }
  }
  const originKeys = new Set();
  for (const row of [...meta.bills, ...meta.allocations]) if (row.origin !== undefined) {
    const origin = row.origin;
    if (!origin || origin.system !== "tally-bills" || !/^r-[a-f0-9]{24}$/.test(origin.recordId) || typeof origin.nodePath !== "string" || origin.nodePath.length > 180 || origin.sourceKey !== `${origin.recordId}:${origin.nodePath}` || !/^[a-f0-9]{64}$/.test(origin.sourceHash) || typeof origin.reference !== "string" || !origin.reference.trim() || origin.reference.length > 80 || !Number.isSafeInteger(origin.paise) || origin.paise <= 0 || !Number.isFinite(Date.parse(origin.date))) throw new Error("Invalid bill source linkage");
    if (originKeys.has(origin.sourceKey)) throw new Error("A source bill allocation is linked twice");
    originKeys.add(origin.sourceKey);
  }
  assertBankMetadata(meta, company, vouchers);
  assertBillMetadata(meta, company, vouchers);
}

export function mutateReconciliation(current, book, action, input) {
  const meta = section(current);
  if (!input || typeof input !== "object" || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId || "")) throw new Error("This change needs a valid save identifier");
  const requestHash = digest({ action, ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== "revision")) });
  const previous = meta.audit.find(row => row.requestId === input.requestId);
  if (previous) {
    if (previous.action !== action || previous.requestHash !== requestHash) throw new Error("This save identifier already belongs to a different reconciliation change");
    return { section: meta, result: previous.result, replayed: true };
  }
  if (input.revision !== meta.revision) throw new Error("Reconciliation changed while you were reviewing. Reload the page before saving");
  const { company, vouchers } = book;
  let result;
  if (action === "import-statement") result = importBankStatement(meta, company, vouchers, input);
  else if (action === "match-bank") result = matchBank(meta, company, vouchers, input);
  else if (action === "bank-opening") result = updateBankOpening(meta, company, vouchers, input);
  else if (action === "save-bill") result = saveBill(meta, company, vouchers, input);
  else if (action === "remove-bill") result = removeBill(meta, input);
  else if (action === "allocate-bill") result = allocateBill(meta, company, vouchers, input);
  else if (action === "unmatch-bank" || action === "unallocate-bill") {
    const list = action === "unmatch-bank" ? meta.matches : meta.allocations;
    const id = action === "unmatch-bank" ? input.matchId : input.allocationId;
    const index = list.findIndex(row => row.id === id);
    if (index < 0) throw new Error("That saved reconciliation link is not available");
    result = { id, removed: structuredClone(list[index]) };
    list.splice(index, 1);
  } else throw new Error("Unknown reconciliation action");
  meta.revision = amount(meta.revision + 1, "reconciliation revision");
  meta.audit.push({ id: newId("ra"), requestId: input.requestId, requestHash, action, at: new Date().toISOString(), result });
  assertReconciliation({ ...company, reconciliation: meta }, vouchers);
  return { section: meta, result, replayed: false };
}

function financialVoucher(voucher) {
  if (!voucher) return null;
  return { id: voucher.id, type: voucher.type, number: voucher.number, date: voucher.date, lines: voucher.lines };
}
export function guardReconciledVoucher(company, original, next) {
  if (!original || isDeepStrictEqual(financialVoucher(original), financialVoucher(next))) return;
  const meta = section(company.reconciliation);
  const id = original.id;
  const linked = meta.matches.some(match => match.voucherIds.includes(id)) ||
    meta.statements.some(statement => statement.openingPendingVoucherIds.includes(id)) ||
    meta.bills.some(bill => bill.voucherId === id) ||
    meta.allocations.some(row => row.billVoucherId === id || row.creditVoucherId === id);
  if (linked) throw new Error("This voucher has bank matches, opening pending items or bill references. Remove its matches, opening selections and bill allocations/references before changing its postings, number or date");
}
export function guardReconciledLedger(company, original, next) {
  if (!original || (next && original.groupId === next.groupId && isDeepStrictEqual(original.opening, next.opening))) return;
  const meta = section(company.reconciliation);
  const referenced = meta.statements.some(row => row.ledgerId === original.id) || meta.bills.some(row => row.ledgerId === original.id) || meta.allocations.some(row => row.ledgerId === original.id);
  const openingReferenced = meta.bills.some(row => row.sourceKey === `opening:${original.id}`) || meta.allocations.some(row => row.creditKey === `opening:${original.id}`);
  if (referenced && (!next || original.groupId !== next.groupId)) throw new Error("This ledger has reconciliation records. Keep its account group while those records are linked");
  if (openingReferenced && !isDeepStrictEqual(original.opening, next.opening)) throw new Error("Remove opening-balance bill references and allocations before changing this opening balance");
}
