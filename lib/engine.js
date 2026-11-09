import { stockForStatements, stockLedgerIds } from "./stock-accounts.js";
import { fyStart, isIsoDate } from "./money.js";
import { VOUCHER_TYPES } from "./groups.js";
import { numberScopeShared } from "./numbering.js";

export function walkGroups(groups, groupId) {
  const chain = [];
  const seen = new Set();
  let current = groups.find((group) => group.id === groupId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parentId ? groups.find((group) => group.id === current.parentId) : null;
  }
  return chain;
}

export function natureOf(groups, groupId) {
  const found = walkGroups(groups, groupId).find((group) => group.nature);
  return found ? found.nature : null;
}

export function isCashBank(groups, groupId) {
  return walkGroups(groups, groupId).some((group) => group.cashBank);
}

export function isGross(groups, groupId) {
  return walkGroups(groups, groupId).some((group) => group.gross);
}

function ledgerOrThrow(company, ledgerId) {
  const ledger = company.ledgers.find((item) => item.id === ledgerId);
  if (!ledger) throw new Error("That ledger is not in this company");
  return ledger;
}

export function assertVoucher(company, input, vouchers, keepId) {
  const type = input.type;
  if (!VOUCHER_TYPES.includes(type)) throw new Error("Unknown voucher type");
  if (!isIsoDate(input.date)) throw new Error("Enter the voucher date");
  if (input.date < company.booksFrom) throw new Error("That date is before these books begin");
  const number = String(input.number ?? "").trim();
  if (!number || number.length > 24) throw new Error("Enter a voucher number");
  // Numbers are unique per type, and per financial year when the series restarts yearly.
  const clash = vouchers.some(
    (voucher) => voucher.type === type && voucher.number === number && voucher.id !== keepId &&
      numberScopeShared(company, type, voucher.date, input.date),
  );
  if (clash) throw new Error("That voucher number is already used for this type");

  const source = Array.isArray(input.lines) ? input.lines : [];
  const lines = [];
  for (const line of source) {
    const paise = line.paise;
    const ledgerId = line.ledgerId || "";
    if (!ledgerId && (!paise || paise === 0)) continue;
    if (!ledgerId) throw new Error("Every amount needs a ledger");
    ledgerOrThrow(company, ledgerId);
    if (line.dc !== "Dr" && line.dc !== "Cr") throw new Error("Each line is debit or credit");
    if (!Number.isInteger(paise) || paise <= 0) throw new Error("Amounts are in rupees and paise, greater than zero");
    if (paise > 9_000_000_000_000_00) throw new Error("That amount is too large");
    lines.push({ ledgerId, dc: line.dc, paise });
  }
  if (lines.length < 2) throw new Error("A voucher needs two lines");

  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    if (line.dc === "Dr") debit += line.paise;
    else credit += line.paise;
  }
  if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) throw new Error("The voucher total is too large");
  if (debit !== credit) throw new Error("Debit and credit do not match");

  const cash = (ledgerId) => isCashBank(groupsOf(company), ledgerOrThrow(company, ledgerId).groupId);
  if (type === "Contra" && lines.some((line) => !cash(line.ledgerId))) {
    throw new Error("Contra only moves cash and bank");
  }
  if (type === "Payment" && !lines.some((line) => line.dc === "Cr" && cash(line.ledgerId))) {
    throw new Error("A payment credits cash or bank");
  }
  if (type === "Receipt" && !lines.some((line) => line.dc === "Dr" && cash(line.ledgerId))) {
    throw new Error("A receipt debits cash or bank");
  }
  const nature = (ledgerId) => natureOf(groupsOf(company), ledgerOrThrow(company, ledgerId).groupId);
  if (type === "Sales" && !lines.some((line) => line.dc === "Cr" && nature(line.ledgerId) === "Income")) {
    throw new Error("A sale credits an income ledger");
  }
  if (type === "Purchase" && !lines.some((line) => line.dc === "Dr" && nature(line.ledgerId) === "Expense")) {
    throw new Error("A purchase debits an expense ledger");
  }

  return {
    id: keepId,
    type,
    date: input.date,
    number,
    narration: String(input.narration ?? "").trim().slice(0, 280),
    lines,
  };
}

function groupsOf(company) {
  return company.groups;
}

export function movements(vouchers, ledgerId, from, to) {
  let dr = 0;
  let cr = 0;
  for (const voucher of vouchers) {
    if (from && voucher.date < from) continue;
    if (to && voucher.date > to) continue;
    for (const line of voucher.lines) {
      if (line.ledgerId !== ledgerId) continue;
      if (line.dc === "Dr") dr += line.paise;
      else cr += line.paise;
    }
  }
  return { dr, cr };
}

export function asBalance(net) {
  if (net >= 0) return { dc: "Dr", paise: net };
  return { dc: "Cr", paise: -net };
}

export function openingSigned(ledger) {
  const paise = ledger.opening?.paise ?? 0;
  if (!Number.isInteger(paise) || paise < 0) return 0;
  return ledger.opening.dc === "Cr" ? -paise : paise;
}

function priorTo(from) {
  if (!from) return null;
  const [y, m, d] = from.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

export function closeLedger(ledger, vouchers, to) {
  const move = movements(vouchers, ledger.id, null, to);
  return asBalance(openingSigned(ledger) + move.dr - move.cr);
}

// Split the journal once into brought-forward and in-period movements for every ledger.
// `prior` is everything before `from`; `earlier` is the part of it before `yearStart`
// (the start of the financial year that contains `from`).
function periodMovements(vouchers, from, to, yearStart = null) {
  const byLedger = new Map();
  for (const voucher of vouchers) {
    if (to && voucher.date > to) continue;
    const prior = from && voucher.date < from;
    const earlier = yearStart && voucher.date < yearStart;
    for (const { ledgerId, dc, paise } of voucher.lines) {
      let totals = byLedger.get(ledgerId);
      if (!totals) {
        totals = { prior: 0, earlier: 0, dr: 0, cr: 0 };
        byLedger.set(ledgerId, totals);
      }
      const signed = dc === "Dr" ? paise : -paise;
      if (earlier) totals.earlier += signed;
      if (prior) totals.prior += signed;
      else if (dc === "Dr") totals.dr += paise;
      else totals.cr += paise;
    }
  }
  return byLedger;
}
const noMovement = { prior: 0, earlier: 0, dr: 0, cr: 0 };

// Financial-year boundary (Indian FY, 1 April to 31 March).
// Income and expense ledgers start every financial year at nil. Their balance brought
// forward into a report period is only this year's movement before `from`, plus the
// ledger's opening balance when the books began inside this same financial year.
// Everything they earned or spent in earlier years is carried as one synthetic
// "Profit & loss account (brought forward)" row under Capital Account, so the trial
// balance still balances and the balance sheet shows retained profit separately.
export const PL_BROUGHT_FORWARD_ID = "pl:brought-forward";
export const PL_BROUGHT_FORWARD_NAME = "Profit & loss account (brought forward)";
const PL_BROUGHT_FORWARD_GROUP = "g-capital";

export function isRevenueNature(nature) {
  return nature === "Income" || nature === "Expense";
}

// One group walk per group instead of one per ledger.
function revenueGroups(groups) {
  return new Set(groups.filter((group) => isRevenueNature(natureOf(groups, group.id))).map((group) => group.id));
}

function checkedPaise(value, message = "The book totals exceed the supported amount") {
  if (!Number.isSafeInteger(value)) throw new Error(message);
  return value;
}

// Start of the financial year that `date` falls in, or null when the books begin inside it.
function earlierYearsEnd(company, date) {
  if (!date || !isIsoDate(date)) return null;
  const start = fyStart(date);
  return company.booksFrom < start ? start : null;
}

// The slice of a revenue ledger that belongs to earlier financial years (debit positive).
function revenueEarlier(ledger, move, yearStart) {
  return yearStart ? openingSigned(ledger) + move.earlier : 0;
}

function broughtForwardLedger(net) {
  return {
    id: PL_BROUGHT_FORWARD_ID,
    name: PL_BROUGHT_FORWARD_NAME,
    groupId: PL_BROUGHT_FORWARD_GROUP,
    opening: asBalance(net),
    synthetic: true,
  };
}

// Net earlier-years profit or loss (debit positive, so a profit is negative).
export function earlierYearsResult(company, vouchers, date) {
  const yearStart = earlierYearsEnd(company, date);
  if (!yearStart) return 0;
  const byLedger = periodMovements(vouchers, yearStart, null, yearStart);
  const revenueIds = revenueGroups(company.groups);
  let net = 0;
  for (const ledger of company.ledgers) {
    if (!revenueIds.has(ledger.groupId)) continue;
    net = checkedPaise(net + revenueEarlier(ledger, byLedger.get(ledger.id) || noMovement, yearStart));
  }
  return net;
}

export function trialBalance(company, vouchers, from, to) {
  const rows = [];
  const yearStart = earlierYearsEnd(company, from);
  const byLedger = periodMovements(vouchers, from, to, yearStart);
  const revenueIds = revenueGroups(company.groups);
  let carried = 0;
  for (const ledger of company.ledgers) {
    const period = byLedger.get(ledger.id) || noMovement;
    const revenue = revenueIds.has(ledger.groupId);
    const earlier = revenue ? revenueEarlier(ledger, period, yearStart) : 0;
    carried += earlier;
    const brought = asBalance(openingSigned(ledger) + period.prior - earlier);
    const broughtNet = brought.dc === "Dr" ? brought.paise : -brought.paise;
    const closing = asBalance(broughtNet + period.dr - period.cr);
    const openingShown = revenue && yearStart ? 0 : (ledger.opening?.paise ?? 0);
    const used = openingShown > 0 || period.dr > 0 || period.cr > 0 || brought.paise > 0;
    if (!used) continue;
    const group = company.groups.find((item) => item.id === ledger.groupId);
    rows.push({
      ledgerId: ledger.id,
      name: ledger.name,
      groupId: ledger.groupId,
      groupName: group ? group.name : "Ungrouped",
      opening: brought,
      periodDr: period.dr,
      periodCr: period.cr,
      closing,
    });
  }
  if (carried !== 0) {
    const group = company.groups.find((item) => item.id === PL_BROUGHT_FORWARD_GROUP);
    const balance = asBalance(carried);
    rows.push({
      ledgerId: PL_BROUGHT_FORWARD_ID,
      name: PL_BROUGHT_FORWARD_NAME,
      groupId: PL_BROUGHT_FORWARD_GROUP,
      groupName: group ? group.name : "Capital Account",
      opening: balance,
      periodDr: 0,
      periodCr: 0,
      closing: { ...balance },
      synthetic: true,
    });
  }
  rows.sort((a, b) => a.groupName.localeCompare(b.groupName) || a.name.localeCompare(b.name));
  const debit = rows.reduce((sum, row) => sum + (row.closing.dc === "Dr" ? row.closing.paise : 0), 0);
  const credit = rows.reduce((sum, row) => sum + (row.closing.dc === "Cr" ? row.closing.paise : 0), 0);
  return { from, to, rows, debit, credit, difference: debit - credit };
}

// Opening balances on income and expense ledgers belong to the profit and loss account
// of the financial year in which the books began (a mid-year migration brings in the
// year's income and expense to date as openings). The rule that keeps the P&L and the
// balance sheet reconciled is therefore: a P&L whose period starts on or before
// booksFrom includes those openings, shown as each ledger's `opening` and folded into
// `signed`; a P&L that starts later excludes them, because they precede its period.
// The balance sheet counts them in the current-year profit while that year lasts and
// in the brought-forward profit afterwards.
function plLines(company, vouchers, from, to) {
  const lines = [];
  const byLedger = periodMovements(vouchers, from, to);
  const withOpenings = !from || from <= company.booksFrom;
  for (const ledger of company.ledgers) {
    const nature = natureOf(company.groups, ledger.groupId);
    if (!isRevenueNature(nature)) continue;
    const move = byLedger.get(ledger.id) || noMovement;
    const opening = withOpenings ? openingSigned(ledger) : 0;
    if (move.dr === 0 && move.cr === 0 && opening === 0) continue;
    lines.push({
      ledgerId: ledger.id,
      name: ledger.name,
      nature,
      gross: isGross(company.groups, ledger.groupId),
      ...(opening !== 0 ? { opening: asBalance(opening) } : {}),
      dr: move.dr,
      cr: move.cr,
      signed: checkedPaise(move.cr - move.dr - opening, "Profit exceeds the exact paise limit"),
    });
  }
  return lines;
}

function sideTotal(lines, predicate) {
  return lines.filter(predicate).reduce((sum, line) => sum + line.signed, 0);
}

export function profitAndLoss(company, vouchers, from, to) {
  const lines = plLines(company, vouchers, from, to);
  const grossIncome = sideTotal(lines, (line) => line.gross && line.nature === "Income");
  const grossExpense = -sideTotal(lines, (line) => line.gross && line.nature === "Expense");
  const indirectIncome = sideTotal(lines, (line) => !line.gross && line.nature === "Income");
  const indirectExpense = -sideTotal(lines, (line) => !line.gross && line.nature === "Expense");
  const inventory = stockForStatements(company,vouchers,from,to);
  const grossProfit = inventory && !inventory.complete ? null : grossIncome - grossExpense + (inventory?.periodAdjustmentPaise || 0);
  const netProfit = grossProfit === null ? null : grossProfit + indirectIncome - indirectExpense;
  if (netProfit !== null && (!Number.isSafeInteger(netProfit) || !Number.isSafeInteger(grossProfit))) throw new Error("Profit exceeds the exact paise limit");
  return {
    from,
    to,
    lines,
    grossIncome,
    ...(inventory ? { inventory } : {}),
    grossExpense,
    grossProfit,
    indirectIncome,
    indirectExpense,
    netProfit,
  };
}

export function balanceSheet(company, vouchers, to) {
  const assets = [];
  const liabilities = [];
  const inventory = stockForStatements(company,vouchers,company.booksFrom,to);
  const stockIds = inventory ? stockLedgerIds(company) : new Set();
  let profit = 0;
  const byLedger = periodMovements(vouchers, null, to);
  for (const ledger of company.ledgers) {
    const nature = natureOf(company.groups, ledger.groupId);
    const move = byLedger.get(ledger.id) || noMovement;
    const closing = asBalance(openingSigned(ledger) + move.dr - move.cr);
    if (closing.paise === 0 || stockIds.has(ledger.id)) continue;
    if (isRevenueNature(nature)) {
      profit += closing.dc === "Cr" ? closing.paise : -closing.paise;
      continue;
    }
    const group = company.groups.find((item) => item.id === ledger.groupId);
    const row = {
      ledgerId: ledger.id,
      name: ledger.name,
      groupName: group ? group.name : "Ungrouped",
      paise: closing.paise,
    };
    if (closing.dc === "Dr") assets.push(row);
    else liabilities.push(row);
  }
  const byGroup = (rows) => {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.groupName)) map.set(row.groupName, []);
      map.get(row.groupName).push(row);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([groupName, ledgers]) => ({
        groupName,
        ledgers: ledgers.sort((a, b) => a.name.localeCompare(b.name)),
        total: ledgers.reduce((sum, ledger) => sum + ledger.paise, 0),
      }));
  };
  if (inventory?.complete) {
    profit += inventory.closingAdjustmentPaise;
    if (!Number.isSafeInteger(profit)) throw new Error("Profit exceeds the exact paise limit");
    if (inventory.closingValuePaise) assets.push({stockRegister:true, name:"Closing stock", groupName:"Stock-in-Hand", paise:inventory.closingValuePaise});
  }
  // Split cumulative profit into earlier financial years (retained, shown under Capital
  // Account as one brought-forward row) and the financial year that contains `to`.
  let retainedProfit = 0;
  const yearStart = earlierYearsEnd(company, to);
  if (yearStart && (!inventory || inventory.complete)) {
    retainedProfit = -earlierYearsResult(company, vouchers, to);
    if (inventory) {
      const earlierStock = stockForStatements(company, vouchers, company.booksFrom, priorTo(yearStart));
      retainedProfit = earlierStock.complete ? checkedPaise(retainedProfit + earlierStock.closingAdjustmentPaise, "Profit exceeds the exact paise limit") : null;
    }
  }
  if (retainedProfit) {
    const group = company.groups.find((item) => item.id === PL_BROUGHT_FORWARD_GROUP);
    const row = { ledgerId: PL_BROUGHT_FORWARD_ID, name: PL_BROUGHT_FORWARD_NAME, groupName: group ? group.name : "Capital Account", paise: Math.abs(retainedProfit), synthetic: true };
    if (retainedProfit > 0) liabilities.push(row);
    else assets.push(row);
  }
  const currentProfit = retainedProfit === null ? null : profit - retainedProfit;
  // Without an earlier-year stock valuation the split is unknown, so the sheet keeps the
  // cumulative figure on the profit line as before.
  const profitLine = currentProfit === null ? profit : currentProfit;
  const assetGroups = byGroup(assets);
  const liabilityGroups = byGroup(liabilities);
  const assetLedgerTotal = assets.reduce((sum, row) => sum + row.paise, 0);
  const liabilityLedgerTotal = liabilities.reduce((sum, row) => sum + row.paise, 0);
  const assetTotal = assetLedgerTotal + (profitLine < 0 ? -profitLine : 0);
  const liabilityTotal = liabilityLedgerTotal + (profitLine > 0 ? profitLine : 0);
  if (!Number.isSafeInteger(assetTotal) || !Number.isSafeInteger(liabilityTotal)) throw new Error("Balance sheet exceeds the supported paise limit");
  const pending = inventory && !inventory.complete;
  return {
    to,
    assetGroups,
    liabilityGroups,
    ...(inventory ? { inventory } : {}),
    profit: pending ? null : profitLine,
    retainedProfit: pending ? null : retainedProfit,
    currentProfit: pending ? null : currentProfit,
    assetTotal: pending ? null : assetTotal,
    liabilityTotal: pending ? null : liabilityTotal,
    difference: pending ? null : assetTotal - liabilityTotal,
  };
}

// Same-day vouchers sort by number with digits compared as numbers (RCT-9 before RCT-10).
const numberOrder = new Intl.Collator("en", { numeric: true });
function byDateAndNumber(a, b) {
  return a.date.localeCompare(b.date) || numberOrder.compare(String(a.number ?? ""), String(b.number ?? ""));
}

export function dayBook(company, vouchers, from, to) {
  const namesById = new Map(company.ledgers.map((ledger) => [ledger.id, ledger.name]));
  return vouchers
    .filter((voucher) => (!from || voucher.date >= from) && (!to || voucher.date <= to))
    .slice()
    .sort(byDateAndNumber)
    .map((voucher) => {
      const names = voucher.lines.map((line) => {
        return namesById.get(line.ledgerId) || "Missing ledger";
      });
      const paise = voucher.lines.reduce((sum, line) => sum + (line.dc === "Dr" ? line.paise : 0), 0);
      return {
        id: voucher.id,
        date: voucher.date,
        number: voucher.number,
        type: voucher.type,
        narration: voucher.narration,
        particulars: names.join(", "),
        paise,
      };
    });
}

export function ledgerReport(company, vouchers, ledgerId, from, to) {
  if (ledgerId === PL_BROUGHT_FORWARD_ID) {
    const net = earlierYearsResult(company, vouchers, from);
    const balance = asBalance(net);
    return { ledger: broughtForwardLedger(net), from, to, opening: balance, lines: [], closing: { ...balance } };
  }
  const ledger = ledgerOrThrow(company, ledgerId);
  const yearStart = isRevenueNature(natureOf(company.groups, ledger.groupId)) ? earlierYearsEnd(company, from) : null;
  // Revenue ledgers restart at the financial year that contains `from`.
  const prior = from ? movements(vouchers, ledgerId, yearStart, priorTo(from)) : noMovement;
  const broughtNet = (yearStart ? 0 : openingSigned(ledger)) + prior.dr - prior.cr;
  const namesById = new Map(company.ledgers.map((item) => [item.id, item.name]));
  const lines = [];
  let running = broughtNet;
  const selected = vouchers
    .filter((voucher) => (!from || voucher.date >= from) && (!to || voucher.date <= to))
    .filter((voucher) => voucher.lines.some((line) => line.ledgerId === ledgerId))
    .sort(byDateAndNumber);
  for (const voucher of selected) {
    for (const line of voucher.lines) {
      if (line.ledgerId !== ledgerId) continue;
      running += line.dc === "Dr" ? line.paise : -line.paise;
      const others = voucher.lines
        .filter((item) => item !== line)
        .map((item) => namesById.get(item.ledgerId) || "Ledger")
        .join(", ");
      lines.push({
        voucherId: voucher.id,
        date: voucher.date,
        number: voucher.number,
        type: voucher.type,
        narration: voucher.narration,
        contra: others,
        dc: line.dc,
        paise: line.paise,
        balance: asBalance(running),
      });
    }
  }
  return {
    ledger,
    from,
    to,
    opening: asBalance(broughtNet),
    lines,
    closing: asBalance(running),
  };
}

// Paging for long registers (day book, ledger, GST register). Without offset or limit
// the whole list comes back as before. A limit above PAGE_LIMIT_MAX is cut to it; an
// offset without a limit returns every row from that offset (limit null).
export const PAGE_LIMIT_MAX = 500;

/** Read offset/limit from URLSearchParams or a plain object. Returns null when neither is given. */
export function pageQuery(params) {
  const read = (key) => {
    const value = typeof params?.get === "function" ? params.get(key) : params?.[key];
    return value === undefined || value === null || value === "" ? null : value;
  };
  const rawOffset = read("offset");
  const rawLimit = read("limit");
  if (rawOffset === null && rawLimit === null) return null;
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Choose a valid page start (offset 0 or more)");
  if (rawLimit === null) return { offset, limit: null };
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Choose a page size from 1 to ${PAGE_LIMIT_MAX}`);
  return { offset, limit: Math.min(limit, PAGE_LIMIT_MAX) };
}

/** {rows, total, offset, limit} for a list; limit is null when every row from offset is returned. */
export function pageRows(rows, page) {
  if (!page) return { rows, total: rows.length, offset: 0, limit: null };
  const end = page.limit === null ? rows.length : page.offset + page.limit;
  return { rows: rows.slice(page.offset, end), total: rows.length, offset: page.offset, limit: page.limit };
}

/** Day book with paging. totalPaise covers every row in the period, not only the page. */
export function dayBookPage(company, vouchers, from, to, page = null) {
  const all = dayBook(company, vouchers, from, to);
  const totalPaise = all.reduce((sum, row) => sum + row.paise, 0);
  return { from, to, ...pageRows(all, page), totalPaise };
}

/**
 * Ledger report with paging. opening, closing and totals cover the whole period; when a
 * page is asked for, `lines` and `rows` hold that page and pageOpening is the running
 * balance brought forward to its first line.
 */
export function ledgerReportPage(company, vouchers, ledgerId, from, to, page = null) {
  const report = ledgerReport(company, vouchers, ledgerId, from, to);
  const totals = { debitPaise: 0, creditPaise: 0 };
  for (const line of report.lines) totals[line.dc === "Dr" ? "debitPaise" : "creditPaise"] += line.paise;
  const paged = pageRows(report.lines, page);
  if (!page) return { ...report, rows: report.lines, total: paged.total, offset: 0, limit: null, totals };
  const before = paged.offset > 0 ? report.lines[Math.min(paged.offset, report.lines.length) - 1]?.balance : null;
  return { ...report, lines: paged.rows, rows: paged.rows, total: paged.total, offset: paged.offset, limit: paged.limit, totals, pageOpening: before ? { ...before } : { ...report.opening } };
}
