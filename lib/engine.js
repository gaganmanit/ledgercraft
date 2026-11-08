import { stockForStatements, stockLedgerIds } from "./stock-accounts.js";
import { isIsoDate } from "./money.js";
import { VOUCHER_TYPES } from "./groups.js";

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
  const clash = vouchers.some(
    (voucher) => voucher.type === type && voucher.number === number && voucher.id !== keepId,
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
function periodMovements(vouchers, from, to) {
  const byLedger = new Map();
  for (const voucher of vouchers) {
    if (to && voucher.date > to) continue;
    const prior = from && voucher.date < from;
    for (const { ledgerId, dc, paise } of voucher.lines) {
      let totals = byLedger.get(ledgerId);
      if (!totals) {
        totals = { prior: 0, dr: 0, cr: 0 };
        byLedger.set(ledgerId, totals);
      }
      if (prior) totals.prior += dc === "Dr" ? paise : -paise;
      else if (dc === "Dr") totals.dr += paise;
      else totals.cr += paise;
    }
  }
  return byLedger;
}
const noMovement = { prior: 0, dr: 0, cr: 0 };

export function trialBalance(company, vouchers, from, to) {
  const rows = [];
  const byLedger = periodMovements(vouchers, from, to);
  for (const ledger of company.ledgers) {
    const period = byLedger.get(ledger.id) || noMovement;
    const brought = asBalance(openingSigned(ledger) + period.prior);
    const broughtNet = brought.dc === "Dr" ? brought.paise : -brought.paise;
    const closing = asBalance(broughtNet + period.dr - period.cr);
    const used = (ledger.opening?.paise ?? 0) > 0 || period.dr > 0 || period.cr > 0 || brought.paise > 0;
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
  rows.sort((a, b) => a.groupName.localeCompare(b.groupName) || a.name.localeCompare(b.name));
  const debit = rows.reduce((sum, row) => sum + (row.closing.dc === "Dr" ? row.closing.paise : 0), 0);
  const credit = rows.reduce((sum, row) => sum + (row.closing.dc === "Cr" ? row.closing.paise : 0), 0);
  return { from, to, rows, debit, credit, difference: debit - credit };
}

function plLines(company, vouchers, from, to) {
  const lines = [];
  const byLedger = periodMovements(vouchers, from, to);
  for (const ledger of company.ledgers) {
    const nature = natureOf(company.groups, ledger.groupId);
    if (nature !== "Income" && nature !== "Expense") continue;
    const move = byLedger.get(ledger.id) || noMovement;
    if (move.dr === 0 && move.cr === 0) continue;
    lines.push({
      ledgerId: ledger.id,
      name: ledger.name,
      nature,
      gross: isGross(company.groups, ledger.groupId),
      dr: move.dr,
      cr: move.cr,
      signed: move.cr - move.dr,
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
    if (nature === "Income" || nature === "Expense") {
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
  const assetGroups = byGroup(assets);
  const liabilityGroups = byGroup(liabilities);
  const assetLedgerTotal = assets.reduce((sum, row) => sum + row.paise, 0);
  const liabilityLedgerTotal = liabilities.reduce((sum, row) => sum + row.paise, 0);
  const assetTotal = assetLedgerTotal + (profit < 0 ? -profit : 0);
  const liabilityTotal = liabilityLedgerTotal + (profit > 0 ? profit : 0);
  if (!Number.isSafeInteger(assetTotal) || !Number.isSafeInteger(liabilityTotal)) throw new Error("Balance sheet exceeds the supported paise limit");
  return {
    to,
    assetGroups,
    liabilityGroups,
    ...(inventory ? { inventory } : {}),
    profit: inventory && !inventory.complete ? null : profit,
    assetTotal: inventory && !inventory.complete ? null : assetTotal,
    liabilityTotal: inventory && !inventory.complete ? null : liabilityTotal,
    difference: inventory && !inventory.complete ? null : assetTotal - liabilityTotal,
  };
}

export function dayBook(company, vouchers, from, to) {
  const namesById = new Map(company.ledgers.map((ledger) => [ledger.id, ledger.name]));
  return vouchers
    .filter((voucher) => (!from || voucher.date >= from) && (!to || voucher.date <= to))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
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
  const ledger = ledgerOrThrow(company, ledgerId);
  const prior = from ? movements(vouchers, ledgerId, null, priorTo(from)) : noMovement;
  const broughtNet = openingSigned(ledger) + prior.dr - prior.cr;
  const namesById = new Map(company.ledgers.map((item) => [item.id, item.name]));
  const lines = [];
  let running = broughtNet;
  const selected = vouchers
    .filter((voucher) => (!from || voucher.date >= from) && (!to || voucher.date <= to))
    .filter((voucher) => voucher.lines.some((line) => line.ledgerId === ledgerId))
    .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
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
