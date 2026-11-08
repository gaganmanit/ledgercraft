import { createHash } from "node:crypto";
import { isIsoDate } from "./money.js";
import { validateTransfer } from "./transfer.js";
import { tallyStockMastersXml, tallyStockVoucherXml, tallyStockJournalsXml } from "./tally-stock.js";

function xml(input) {
  const text = String(input ?? "");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(text)) throw new Error("A name or narration contains a character that cannot be represented in accounting XML");
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]));
}

export function tallyRupees(paise, dc) {
  if (!Number.isSafeInteger(paise) || paise < 0 || !["Dr", "Cr"].includes(dc)) throw new Error("A posting contains an invalid paise amount");
  const amount = BigInt(paise);
  return `${dc === "Dr" && amount ? "-" : ""}${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`;
}

function envelope(company, reportName, content) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${reportName}</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xml(company.name)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${content}</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`;
}

export function exportTallyMasters(input,vouchers) {
  // A master-only caller has no voucher history against which to validate journal-linked reviews.
  const masterCopy = vouchers ? input : { ...input, reconciliation:undefined, gst:input.gst && {...input.gst,itc:undefined} };
  const { company } = validateTransfer({ company:masterCopy,vouchers:vouchers || [] });
  const names = new Map(company.groups.map((group) => [group.id, group.name]));
  const byId = new Map(company.groups.map((group) => [group.id, group]));
  const depths = new Map();
  const depth = (group) => {
    const chain = [];
    let current = group;
    while (current && !depths.has(current.id)) { chain.push(current); current = byId.get(current.parentId); }
    let level = current ? depths.get(current.id) : 0;
    for (const entry of chain.reverse()) depths.set(entry.id, ++level);
    return depths.get(group.id);
  };
  const customGroups = company.groups.filter((group) => !group.reserved).sort((a, b) => depth(a) - depth(b) || a.name.localeCompare(b.name));
  const groups = customGroups.map((group) => `<GROUP NAME="${xml(group.name)}" ACTION="Create"><NAME>${xml(group.name)}</NAME><PARENT>${xml(names.get(group.parentId))}</PARENT></GROUP>`).join("");
  const ledgers = company.ledgers.map((ledger) => `<LEDGER NAME="${xml(ledger.name)}" ACTION="Create"><NAME>${xml(ledger.name)}</NAME><PARENT>${xml(names.get(ledger.groupId))}</PARENT><OPENINGBALANCE>${tallyRupees(ledger.opening.paise, ledger.opening.dc)}</OPENINGBALANCE><CURRENCYNAME>₹</CURRENCYNAME></LEDGER>`).join("");
  return envelope(company, "All Masters", groups + ledgers + tallyStockMastersXml(company, xml));
}

function voucherGuid(companyId, voucher) {
  if (voucher.source?.system === "tally" && voucher.source.guid) return voucher.source.guid;
  const digest = createHash("sha256").update(`financer:${companyId}:${voucher.id}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function exportTallyDayBook(inputCompany, inputVouchers, from, to) {
  const { company, vouchers } = validateTransfer({ company: inputCompany, vouchers: inputVouchers });
  if (!isIsoDate(from) || !isIsoDate(to) || from > to || from < company.booksFrom) throw new Error("Choose a valid Tally export period");
  const ledgers = new Map(company.ledgers.map((ledger) => [ledger.id, ledger.name]));
  const selected = vouchers.filter((voucher) => voucher.date >= from && voucher.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
  const content = selected.map((voucher) => {
    const guid = voucherGuid(company.id, voucher);
    const lines = voucher.lines.map((line) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(ledgers.get(line.ledgerId))}</LEDGERNAME><ISDEEMEDPOSITIVE>${line.dc === "Dr" ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${tallyRupees(line.paise, line.dc)}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join("");
    return `<VOUCHER VCHTYPE="${xml(voucher.type)}" ACTION="Create" OBJVIEW="Accounting Voucher View" REMOTEID="${xml(guid)}"><GUID>${xml(guid)}</GUID><DATE>${voucher.date.replaceAll("-", "")}</DATE><VOUCHERTYPENAME>${xml(voucher.type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(voucher.number)}</VOUCHERNUMBER><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><NARRATION>${xml(voucher.narration)}</NARRATION>${lines}${tallyStockVoucherXml(company, voucher, xml)}</VOUCHER>`;
  }).join("");
  return envelope(company, "Vouchers", content + tallyStockJournalsXml(company, from, to, xml));
}

function ordered(value) {
  if (Array.isArray(value)) {
    const list = value.every((entry) => entry && typeof entry === "object" && typeof entry.id === "string") ? value.slice().sort((a, b) => a.id.localeCompare(b.id)) : value;
    return list.map(ordered);
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => !["source", "requestId"].includes(key)).map((key) => [key, ordered(value[key])]));
}

export function accountingBookHash(company, vouchers) {
  const { id, ...book } = company;
  return createHash("sha256").update(JSON.stringify(ordered({ company: book, vouchers }))).digest("hex");
}
