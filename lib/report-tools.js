import { dayBook, isCashBank, trialBalance, walkGroups } from "./engine.js";
import { isIsoDate } from "./money.js";
import { companyAgeing, sumBuckets } from "./ageing.js";

export function reportPeriod(company, from = company.booksFrom, to = from) {
  if (!isIsoDate(from) || !isIsoDate(to) || from > to || from < company.booksFrom) {
    throw new Error("Choose a valid period on or after the books begin");
  }
  return { from, to };
}

function addPaise(sum, amount) {
  const total = sum + amount;
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(total)) throw new Error("The book totals exceed the supported amount");
  return total;
}

function checkedTrial(company, vouchers, from, to) {
  const trial = trialBalance(company, vouchers, from, to);
  const values = [trial.debit, trial.credit, trial.difference];
  for (const row of trial.rows) values.push(row.opening.paise, row.periodDr, row.periodCr, row.closing.paise);
  if (values.some((value) => !Number.isSafeInteger(value))) throw new Error("The book totals exceed the supported amount");
  return trial;
}

// Group summary aggregates bottom-up: every group's figures include all descendant
// ledgers. Selecting a group returns its direct ledgers plus one rolled-up row per child
// group that carries any balance or movement, as Tally's group drill-down does.
export function groupSummary(company, vouchers, from, to, groupId = "") {
  reportPeriod(company, from, to);
  const trial = checkedTrial(company, vouchers, from, to);
  const selected = groupId && company.groups.find((group) => group.id === groupId);
  if (groupId && !selected) throw new Error("That group is not in this company");
  const byGroup = new Map(company.groups.map((group) => {
    const chain = walkGroups(company.groups, group.id);
    return [group.id, {
      groupId: group.id, name: group.name,
      parentId: group.parentId ?? null,
      depth: chain.length - 1,
      path: chain.slice().reverse().map((part) => part.name).join(" / "),
      ledgers: [], ledgerCount: 0, debit: 0, credit: 0, periodDr: 0, periodCr: 0,
      chain: chain.map((part) => part.id),
    }];
  }));
  for (const row of trial.rows) {
    const own = byGroup.get(row.groupId);
    if (!own) throw new Error("A ledger has an unknown account group");
    own.ledgers.push(row);
    const side = row.closing.dc === "Dr" ? "debit" : "credit";
    // Each ledger counts once in its own group and once in every ancestor.
    for (const ancestorId of own.chain) {
      const group = byGroup.get(ancestorId);
      group.ledgerCount += 1;
      group[side] = addPaise(group[side], row.closing.paise);
      group.periodDr = addPaise(group.periodDr, row.periodDr);
      group.periodCr = addPaise(group.periodCr, row.periodCr);
    }
  }
  const rows = [...byGroup.values()].map(({ chain, ...row }) => row).sort((a, b) => a.path.localeCompare(b.path));
  const summary = (row) => {
    const { ledgers, ...rest } = row;
    return rest;
  };
  if (!selected) {
    return {
      from, to, group: null, ledgers: trial.rows, childGroups: [], rows,
      debit: trial.rows.reduce((sum, row) => addPaise(sum, row.closing.dc === "Dr" ? row.closing.paise : 0), 0),
      credit: trial.rows.reduce((sum, row) => addPaise(sum, row.closing.dc === "Cr" ? row.closing.paise : 0), 0),
    };
  }
  const total = rows.find((row) => row.groupId === selected.id);
  const childGroups = rows.filter((row) => row.parentId === selected.id && row.ledgerCount > 0).map(summary).sort((a, b) => a.name.localeCompare(b.name));
  return {
    from, to, group: selected, ledgers: total.ledgers, childGroups, rows,
    debit: total.debit,
    credit: total.credit,
  };
}

export function bookBalances(company, rows) {
  const classifications = new Map(company.groups.map((group) => {
    const chain = walkGroups(company.groups, group.id);
    return [group.id, {
      cashBank: chain.some((part) => part.cashBank),
      debtor: chain.some((part) => part.id === "g-debtors"),
      creditor: chain.some((part) => part.id === "g-creditors"),
    }];
  }));
  const result = {
    cashBank: 0, receivable: 0, payable: 0,
    debtorDebit: 0, debtorCredit: 0, creditorDebit: 0, creditorCredit: 0,
    cashBankRows: [], debtors: [], creditors: [],
  };
  for (const row of rows) {
    const classification = classifications.get(row.groupId);
    if (!classification) throw new Error("A ledger has an unknown account group");
    const amount = row.closing.paise;
    const signed = row.closing.dc === "Dr" ? amount : -amount;
    if (classification.cashBank) {
      result.cashBankRows.push(row);
      result.cashBank = addPaise(result.cashBank, signed);
    }
    if (!amount) continue;
    if (classification.debtor) {
      result.debtors.push(row);
      const field = row.closing.dc === "Dr" ? "debtorDebit" : "debtorCredit";
      result[field] = addPaise(result[field], amount);
    }
    if (classification.creditor) {
      result.creditors.push(row);
      const field = row.closing.dc === "Dr" ? "creditorDebit" : "creditorCredit";
      result[field] = addPaise(result[field], amount);
    }
  }
  result.receivable = addPaise(result.debtorDebit, -result.debtorCredit);
  result.payable = addPaise(result.creditorCredit, -result.creditorDebit);
  result.partyReceivable = addPaise(result.debtorDebit, result.creditorDebit);
  result.partyPayable = addPaise(result.creditorCredit, result.debtorCredit);
  return result;
}

export function cashBankBook(company, vouchers, from, to) {
  reportPeriod(company, from, to);
  const trial = checkedTrial(company, vouchers, from, to);
  const { cashBankRows, cashBank } = bookBalances(company, trial.rows);
  const cashIds = new Set(company.ledgers.filter((ledger) => isCashBank(company.groups, ledger.groupId)).map((ledger) => ledger.id));
  const selected = vouchers.filter((voucher) => voucher.lines.some((line) => cashIds.has(line.ledgerId)));
  return { from, to, cashBank, balances: cashBankRows, rows: dayBook(company, selected, from, to) };
}

export function outstanding(company, vouchers, from, to) {
  reportPeriod(company, from, to);
  const trial = checkedTrial(company, vouchers, from, to);
  const { debtors, creditors, receivable, payable } = bookBalances(company, trial.rows);
  // Each party row is aged as on the last day of the period (see lib/ageing.js).
  const ageing = companyAgeing(company, vouchers, to, [...debtors, ...creditors].map((row) => row.ledgerId));
  const aged = (row) => {
    const party = ageing.get(row.ledgerId);
    return { ...row, ageing: party.buckets, oldestDate: party.oldestDate, msme: party.msme, msmeOverduePaise: party.msmeOverduePaise,
      creditDays: party.creditDays, overduePaise: party.overduePaise, advancePaise: party.advancePaise };
  };
  const debtorRows = debtors.map(aged);
  const creditorRows = creditors.map(aged);
  const sideTotals = (rows) => ({
    buckets: sumBuckets(rows.map((row) => row.ageing)),
    overduePaise: rows.reduce((total, row) => addPaise(total, row.overduePaise), 0),
    advancePaise: rows.reduce((total, row) => addPaise(total, row.advancePaise), 0),
  });
  return {
    from, to, debtors: debtorRows, creditors: creditorRows, receivable, payable,
    asOf: to,
    ageing: { receivable: sideTotals(debtorRows), payable: sideTotals(creditorRows) },
    msmeOverduePaise: creditorRows.reduce((total, row) => addPaise(total, row.msmeOverduePaise), 0),
  };
}

function xml(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "�").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]));
}

function column(name, type, { precision = 0, scale = 0, nullable = false, length = 0 } = {}) {
  return `<FinancerColumn name="${name}" alias="${name}" type="${type}" length="${length}" precision="${precision}" scale="${scale}" nullable="${nullable}"/>`;
}

export function exportXml(company, vouchers, reportName, from, to) {
  reportPeriod(company, from, to);
  let columns;
  let records;
  let totals;
  if (reportName === "trial-balance") {
    const trial = checkedTrial(company, vouchers, from, to);
    columns = column("Ledger", "string", { length: 80 }) + column("Group", "string", { length: 80 }) + column("DebitPaise", "integer", { precision: 16 }) + column("CreditPaise", "integer", { precision: 16 });
    records = trial.rows.map((row) => `<FinancerRow><Ledger>${xml(row.name)}</Ledger><Group>${xml(row.groupName)}</Group><DebitPaise>${row.closing.dc === "Dr" ? row.closing.paise : 0}</DebitPaise><CreditPaise>${row.closing.dc === "Cr" ? row.closing.paise : 0}</CreditPaise></FinancerRow>`).join("");
    totals = `<FinancerTotals debitPaise="${trial.debit}" creditPaise="${trial.credit}" differencePaise="${trial.difference}"/>`;
  } else if (reportName === "daybook" || reportName === "vouchers") {
    const day = dayBook(company, vouchers, from, to);
    columns = column("Date", "date") + column("Number", "string", { length: 24 }) + column("Type", "string", { length: 24 }) + column("Narration", "string", { length: 280 }) + column("AmountPaise", "integer", { precision: 16 });
    const byId = new Map(vouchers.map((voucher) => [voucher.id, voucher]));
    const names = new Map(company.ledgers.map((ledger) => [ledger.id, ledger.name]));
    records = day.map((row) => {
      const lines = reportName === "vouchers" ? `<FinancerLines>${byId.get(row.id).lines.map((line) => `<FinancerLine ledgerId="${xml(line.ledgerId)}" ledger="${xml(names.get(line.ledgerId))}" dc="${line.dc}" paise="${line.paise}"/>`).join("")}</FinancerLines>` : "";
      return `<FinancerRow id="${xml(row.id)}"><Date>${row.date}</Date><Number>${xml(row.number)}</Number><Type>${xml(row.type)}</Type><Narration>${xml(row.narration)}</Narration><AmountPaise>${row.paise}</AmountPaise>${lines}</FinancerRow>`;
    }).join("");
    const total = day.reduce((sum, row) => addPaise(sum, row.paise), 0);
    totals = `<FinancerTotals debitPaise="${total}" creditPaise="${total}" voucherCount="${day.length}"/>`;
  } else {
    throw new Error("Choose daybook, trial-balance, or vouchers for XML export");
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<FinancerXmlTcpEnvelope version="1"><FinancerRequest>Export Data</FinancerRequest><FinancerExportData><FinancerReportName>${reportName}</FinancerReportName><FinancerExportFormat>XML</FinancerExportFormat><FinancerCompany id="${xml(company.id)}">${xml(company.name)}</FinancerCompany><FinancerPeriod from="${from}" to="${to}"/><FinancerColumns>${columns}</FinancerColumns><FinancerRows>${records}</FinancerRows>${totals}</FinancerExportData></FinancerXmlTcpEnvelope>\n`;
}
