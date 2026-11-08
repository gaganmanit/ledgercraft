import { bookBalances } from "./report-tools.js";
import { dayBook, profitAndLoss, trialBalance } from "./engine.js";
import { companyAgeing } from "./ageing.js";
import { sum } from "./reconciliation-common.js";

export function ownerReview(company, vouchers, from, to) {
  const trial = trialBalance(company, vouchers, from, to);
  const { cashBank, receivable, payable, debtors, creditors } = bookBalances(company, trial.rows);
  // Overdue amounts are as on the last day of the period: past due by more than 30 days,
  // and MSME supplier bills unpaid beyond 45 days of the bill date (Section 43B(h)).
  const ageing = [...companyAgeing(company, vouchers, to, [...debtors, ...creditors].map((row) => row.ledgerId)).values()];
  const overdue = (side) => sum(ageing.filter((row) => row.side === side).map((row) => row.overduePaise));
  const entries = dayBook(company, vouchers, from, to);
  const { netProfit } = profitAndLoss(company, vouchers, from, to);
  return { ...(company.tallyWorkbook?.openingScope?.transactionOnly ? {workbookOpeningScope:company.tallyWorkbook.openingScope} : {}), from, to, cashBank, receivable, payable, netProfit, difference: trial.difference,
    receivableOverduePaise: overdue("receivable"), payableOverduePaise: overdue("payable"), msmeOverduePaise: sum(ageing.map((row) => row.msmeOverduePaise)),
    count: entries.length, latest: entries.slice(-5).reverse() };
}

export function findEntries(company, vouchers, query) {
  const matches = [];
  const needle = query.toLocaleLowerCase().trim();
  if (!needle) return matches;
  const ledgers = new Map(company.ledgers.map(l => [l.id, l.name]));
  for (const ledger of company.ledgers) {
    if (ledger.name.toLocaleLowerCase().includes(needle)) {
      matches.push({ kind: "Ledger", title: ledger.name, detail: company.groups.find(g => g.id === ledger.groupId)?.name,
        route: "ledger/" + encodeURIComponent(ledger.id) });
      if (matches.length >= 10) break;
    }
  }
  for (let i = vouchers.length - 1; i >= 0 && matches.length < 25; i--) {
    const v = vouchers[i];
    if ([v.number, v.type, v.narration, v.date].some(value => value?.toLowerCase().includes(needle)) ||
        v.lines.some(line => ledgers.get(line.ledgerId)?.toLowerCase().includes(needle))) {
      matches.push({ kind: v.type, title: v.number, detail: v.narration || v.date,
        route: "v/" + encodeURIComponent(v.type) + "/" + encodeURIComponent(v.id) });
    }
  }
  return matches;
}
