import { createHash, randomBytes } from "node:crypto";
import { isIsoDate, parseRupees } from "./money.js";
import { openingSigned, walkGroups } from "./engine.js";

export const SOURCE_REFERENCES = [
  "https://help.tallysolutions.com/tally-prime/banking-utilities/bank-reconciliation-tally/",
  "https://help.tallysolutions.com/allocate-bills-for-payments-or-receipts/",
  "https://help.tallysolutions.com/receivables-payables-tracking-methods/",
];
export const newId = prefix => `${prefix}-${randomBytes(10).toString("hex")}`;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const digest = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(canonical(value))).digest("hex");
export const normalReference = value => String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

export function amount(value, label = "amount", signed = false) {
  if (!Number.isSafeInteger(value) || (!signed && value < 0)) throw new Error(`Enter a valid ${label} in paise`);
  return value;
}
export function sum(values) {
  let value = 0;
  for (const item of values) { value += amount(item, "amount", true); amount(value, "total", true); }
  return value;
}
export function text(value, label, maximum = 160, required = true) {
  if (typeof value !== "string" || value.trim().length > maximum || (required && !value.trim())) throw new Error(`Enter ${label} within ${maximum} characters`);
  return value.trim();
}
export function date(value, label = "date") {
  if (!isIsoDate(value)) throw new Error(`Enter a valid ${label}`);
  return value;
}
export function ledger(company, id) {
  const found = company.ledgers.find(row => row.id === id);
  if (!found) throw new Error("Choose a ledger in this company");
  return found;
}
export function isBank(company, account) {
  return walkGroups(company.groups, account.groupId).some(group => ["g-bank", "g-od"].includes(group.id));
}
export function partySide(company, account) {
  const groups = walkGroups(company.groups, account.groupId);
  if (groups.some(group => group.id === "g-debtors")) return "receivable";
  if (groups.some(group => group.id === "g-creditors")) return "payable";
  throw new Error("Choose a sundry debtor or sundry creditor ledger");
}
export function bookEntries(company, vouchers, ledgerId) {
  ledger(company, ledgerId);
  const entries = [];
  for (const voucher of vouchers) {
    const net = sum(voucher.lines.filter(line => line.ledgerId === ledgerId).map(line => line.dc === "Dr" ? line.paise : -line.paise));
    if (!net) continue;
    entries.push({
      key: `${voucher.id}:${ledgerId}`, voucherId: voucher.id, ledgerId, date: voucher.date,
      type: voucher.type, number: voucher.number, narration: voucher.narration,
      reference: voucher.gst?.supplierInvoiceNumber || voucher.gst?.number || voucher.number,
      amountPaise: net, gstId: voucher.gst?.id || null,
      fingerprint: digest([voucher.id, ledgerId, voucher.type, voucher.number, voucher.date, net]),
    });
  }
  return entries;
}

export function balanceAt(company, vouchers, ledgerId, to, before = false) {
  const account = ledger(company, ledgerId);
  return sum([openingSigned(account), ...bookEntries(company, vouchers, ledgerId)
    .filter(entry => before ? entry.date < to : entry.date <= to).map(entry => entry.amountPaise)]);
}
export function section(current) {
  if (!current) return { version: 1, revision: 0, statements: [], matches: [], bills: [], allocations: [], audit: [] };
  return structuredClone(current);
}
export function uniqueIds(rows, label) {
  if (!Array.isArray(rows)) throw new Error(`Invalid ${label} records`);
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !/^[a-z0-9-]{1,80}$/.test(row.id) || ids.has(row.id)) throw new Error(`Invalid or duplicate ${label} identity`);
    ids.add(row.id);
  }
}
// Bank exports prefix amounts with INR, Rs. or ₹ (before or after a sign or opening
// bracket) or suffix INR; Indian or western thousands separators are both accepted.
const CURRENCY = /(?:INR|Rs\.?|₹)/i;
export function signedMoney(value) {
  let input = String(value ?? "").trim()
    .replace(new RegExp(`^([(+-]?)\\s*${CURRENCY.source}\\s*`, "i"), "$1")
    .replace(new RegExp(`\\s*${CURRENCY.source}(\\)?)$`, "i"), "$1").trim();
  if (!input || input === "-") return 0;
  let sign = 1;
  const encodings = Number(/^\(.*\)$/.test(input)) + Number(/^[+-]/.test(input.replace(/^\(/, ""))) + Number(/\s*(DR|CR)$/i.test(input.replace(/\)$/, "")));
  if (encodings > 1) throw new Error("Use one sign format for each statement amount");
  if (/^\(.*\)$/.test(input)) { sign = -1; input = input.slice(1, -1).trim(); }
  const suffix = /\s*(DR|CR)$/i.exec(input);
  if (suffix) { sign = suffix[1].toUpperCase() === "DR" ? -1 : 1; input = input.slice(0, suffix.index).trim(); }
  if (/^[+-]/.test(input)) { sign *= input[0] === "-" ? -1 : 1; input = input.slice(1); }
  return amount(sign * parseRupees(input), "statement amount", true);
}
