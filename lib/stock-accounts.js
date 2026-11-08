import { stockOpening, stockPeriod, unresolvedTallyStockGaps } from "./stock-engine.js";

export function stockLedgerIds(company) {
  const parents = new Map(company.groups.map(g => [g.id,g.parentId]));
  const stock = new Set(["g-stock"]);
  function isStock(id) {
    const seen = new Set();
    while (id && !seen.has(id)) {
      if (stock.has(id)) { for (const child of seen) stock.add(child); return true; }
      seen.add(id); id = parents.get(id);
    }
    return false;
  }
  return new Set(company.ledgers.filter(l=>isStock(l.groupId)).map(l=>l.id));
}
function paise(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("Stock statement exceeds the supported paise limit");
  return n;
}
function postedStock(company, vouchers, from, to) {
  const ids = stockLedgerIds(company);
  let atStart = 0n, change = 0n;
  for (const l of company.ledgers) if (ids.has(l.id)) atStart += (l.opening.dc === "Dr" ? 1n : -1n) * BigInt(l.opening.paise);
  const initial = atStart;
  for (const v of vouchers) {
    if (v.date > to) continue;
    for (const line of v.lines) {
      if (!ids.has(line.ledgerId)) continue;
      const delta = (line.dc === "Dr" ? 1n : -1n) * BigInt(line.paise);
      if (v.date < from) atStart += delta;
      else change += delta;
    }
  }
  return { initial:paise(initial), opening:paise(atStart), closing:paise(atStart+change), change:paise(change) };
}
export function openingStockControl(company,vouchers) {
  const opening = stockOpening(company,vouchers);
  const sourceGaps = unresolvedTallyStockGaps(company,vouchers);
  const ledger = postedStock(company,[],company.booksFrom,company.booksFrom).initial;
  const inventory = opening.totals.valuePaise;
  let reason = "";
  if (sourceGaps.length) reason = "Review incomplete Tally stock data: " + sourceGaps[0].message;
  else if (company.source?.system === "tally" && !company.stock?.tally) reason = "Review the original Tally stock data before integrating it with the accounts.";
  else if (inventory === null) reason = "Enter the missing opening quantities and costs in the stock register.";
  else if (inventory !== ledger) reason = "The item opening value and the opening Stock-in-Hand ledger balance differ.";
  return {openingLedgerPaise:ledger, openingInventoryPaise:inventory, reason};
}
export function stockForStatements(company,vouchers,from,to) {
  if (!company.stock?.integrateAccounts) return null;
  if (to < company.booksFrom) return { complete:false,reason:"This date precedes the opening of the inventory books." };
  from = !from || from < company.booksFrom ? company.booksFrom : from;
  const control = openingStockControl(company,vouchers);
  const { financial } = stockPeriod(company,vouchers,{from,to});
  const ledger = postedStock(company,vouchers,from,to);
  const reason = control.reason || (!financial.complete || financial.openingValuePaise == null || financial.closingValuePaise == null
    ? "Resolve stock valuation exceptions for this period." : "");
  const result = { ...control, openingValuePaise:financial.openingValuePaise, closingValuePaise:financial.closingValuePaise,
    ledgerChangePaise:ledger.change, complete:!reason, reason, periodAdjustmentPaise:null, closingAdjustmentPaise:null };
  if (reason) return result;
  result.closingAdjustmentPaise = paise(BigInt(result.closingValuePaise) - BigInt(ledger.closing));
  result.periodAdjustmentPaise = paise(BigInt(result.closingValuePaise) - BigInt(result.openingValuePaise) - BigInt(ledger.change));
  return result;
}
