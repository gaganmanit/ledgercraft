import { ledgerReport } from "./engine.js";
import { fyStart, isIsoDate, todayISO } from "./money.js";
import { addDays, linkedGstParty, partyAgeing } from "./ageing.js";
import { partySide } from "./reconciliation-common.js";
import { reportPeriod } from "./report-tools.js";

// Party statement of account: the ledger of one sundry debtor or creditor for a period,
// with a running balance, due dates for the bills it raises and the closing balance aged
// as on the last day. GET .../parties/<ledgerId>/statement returns JSON and
// GET .../parties/<ledgerId>/statement.csv the same rows as a spreadsheet download.

function documentOf(voucher) {
  const gst = voucher?.gst;
  if (!gst) return null;
  const label = gst.documentLabel || (gst.type === "Credit Note" || gst.type === "Debit Note" ? gst.type : "GST invoice");
  const supplierNumber = gst.direction === "purchase" && gst.supplierInvoiceNumber ? gst.supplierInvoiceNumber : "";
  const number = supplierNumber || gst.number || voucher.number;
  return { label: supplierNumber ? `Supplier ${label.toLowerCase()}` : label, number };
}

const present = (value) => typeof value === "string" && value.trim() !== "";

export function partyStatement(company, vouchers, ledgerId, from, to) {
  reportPeriod(company, from, to);
  const account = company.ledgers.find((row) => row.id === ledgerId);
  if (!account) throw new Error("Choose a ledger in this company");
  const side = partySide(company, account);
  const gstParty = linkedGstParty(company, account, side);
  const registration = company.gst?.registrations?.find((row) => present(row.gstin));
  const gstin = [gstParty?.gstin, account.gstin].find(present);
  const address = [gstParty?.address, account.address].find(present);
  const report = ledgerReport(company, vouchers, ledgerId, from, to);
  const ageing = partyAgeing(company, vouchers, ledgerId, to);
  const byId = new Map(vouchers.map((voucher) => [voucher.id, voucher]));
  const names = new Map(company.ledgers.map((row) => [row.id, row.name]));
  // Lines that raise the party's balance (a debtor's debit, a creditor's credit) carry a due date.
  const raising = side === "receivable" ? "Dr" : "Cr";
  const itemsByVoucher = new Map();
  for (const item of ageing.items) {
    if (!item.voucherId) continue;
    if (!itemsByVoucher.has(item.voucherId)) itemsByVoucher.set(item.voucherId, []);
    itemsByVoucher.get(item.voucherId).push(item);
  }
  let debitPaise = 0;
  let creditPaise = 0;
  const lines = report.lines.map((line) => {
    const voucher = byId.get(line.voucherId);
    const contra = [...new Set((voucher?.lines || []).filter((row) => row.ledgerId !== ledgerId).map((row) => names.get(row.ledgerId) || "Ledger"))].join(", ");
    const document = documentOf(voucher);
    const particulars = document ? [contra, `${document.label} ${document.number}`].filter(Boolean).join(" — ") : contra;
    const debit = line.dc === "Dr" ? line.paise : 0;
    const credit = line.dc === "Cr" ? line.paise : 0;
    debitPaise += debit;
    creditPaise += credit;
    if (!Number.isSafeInteger(debitPaise) || !Number.isSafeInteger(creditPaise)) throw new Error("The book totals exceed the supported amount");
    const row = { date: line.date, number: line.number, type: line.type, voucherId: line.voucherId, particulars,
      ...(document ? { documentNumber: document.number } : {}), narration: line.narration || "", debitPaise: debit, creditPaise: credit, balance: line.balance };
    if (line.dc === raising) {
      const items = itemsByVoucher.get(line.voucherId) || [];
      row.dueDate = items.length ? items.map((item) => item.dueDate).sort()[0] : addDays(line.date, ageing.creditDays);
      const overdue = items.filter((item) => item.openPaise > 0 && item.days > 0).map((item) => item.days);
      if (overdue.length) row.overdueDays = Math.max(...overdue);
    }
    return row;
  });
  return {
    company: { name: company.name, ...(registration ? { gstin: registration.gstin } : {}) },
    party: { ledgerId, name: account.name, side, ...(gstin ? { gstin } : {}), ...(address ? { address } : {}), msme: account.msme === true, creditDays: ageing.creditDays },
    period: { from, to },
    opening: report.opening,
    lines,
    closing: report.closing,
    ageing: {
      asOf: to, buckets: ageing.buckets, total: ageing.total, advancePaise: ageing.advancePaise, netPaise: ageing.netPaise,
      oldestDate: ageing.oldestDate, overduePaise: ageing.overduePaise, msmeOverduePaise: ageing.msmeOverduePaise,
      openItems: ageing.items.filter((item) => item.openPaise > 0).map(({ kind, billWise, voucherId, reference, date, dueDate, openPaise, days }) => ({ kind, billWise, voucherId, reference, date, dueDate, openPaise, days })),
    },
    totals: { debitPaise, creditPaise, lineCount: lines.length },
  };
}

const indianDate = (iso) => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : "");
const plain = (paise) => (paise ? `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, "0")}` : "");
const balanceAmount = (paise) => `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;

function cell(value) {
  let text = String(value ?? "");
  // Spreadsheet programs run cells that begin with these characters as formulas.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

/** UTF-8 CSV (with byte order mark) of a party statement: dd-mm-yyyy dates, plain rupee amounts. */
export function statementCsv(statement) {
  const header = ["Date", "Voucher type", "Voucher number", "Particulars", "Narration", "Debit", "Credit", "Balance", "Dr/Cr", "Due date", "Overdue days"];
  const rows = [header];
  rows.push([indianDate(statement.period.from), "", "", "Opening balance", "", "", "", balanceAmount(statement.opening.paise), statement.opening.dc, "", ""]);
  for (const line of statement.lines) {
    rows.push([indianDate(line.date), line.type, line.number, line.particulars, line.narration, plain(line.debitPaise), plain(line.creditPaise),
      balanceAmount(line.balance.paise), line.balance.dc, indianDate(line.dueDate), line.overdueDays ?? ""]);
  }
  rows.push(["", "", "", "Total for the period", "", balanceAmount(statement.totals.debitPaise), balanceAmount(statement.totals.creditPaise), "", "", "", ""]);
  rows.push([indianDate(statement.period.to), "", "", "Closing balance", "", "", "", balanceAmount(statement.closing.paise), statement.closing.dc, "", ""]);
  return "\uFEFF" + rows.map((row) => row.map((value, index) => (index === 0 || index >= 5 ? String(value) : cell(value))).join(",")).join("\r\n") + "\r\n";
}

export function statementFilename(statement) {
  const slug = statement.party.name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "party";
  return `${slug}-statement-${statement.period.from}-${statement.period.to}.csv`;
}

function statementRange(company, url) {
  const to = url.searchParams.get("to") || todayISO();
  if (!isIsoDate(to)) throw new Error("Choose a valid period on or after the books begin");
  const yearStart = fyStart(to);
  const from = url.searchParams.get("from") || (yearStart > company.booksFrom ? yearStart : company.booksFrom);
  return { from, to };
}

export async function handleStatementRoute({ req, res, url, parts, store, send }) {
  if (req.method !== "GET" || parts.length !== 6 || parts[0] !== "api" || parts[1] !== "companies" || parts[3] !== "parties" || !["statement", "statement.csv"].includes(parts[5])) return false;
  const { company, vouchers } = await store.snapshot(decodeURIComponent(parts[2]));
  const { from, to } = statementRange(company, url);
  const statement = partyStatement(company, vouchers, decodeURIComponent(parts[4]), from, to);
  if (parts[5] === "statement") {
    send(res, 200, statement);
    return true;
  }
  res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${statementFilename(statement)}"`, "cache-control": "no-store" });
  res.end(statementCsv(statement));
  return true;
}
