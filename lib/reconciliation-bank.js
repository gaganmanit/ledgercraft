import { amount, balanceAt, bookEntries, date, digest, isBank, ledger, newId, normalReference, signedMoney, sum, text, uniqueIds } from "./reconciliation-common.js";

export function parseBankCsv(csv) {
  if (typeof csv !== "string" || csv.length > 2_000_000 || !csv.trim()) throw new Error("Choose a CSV statement up to 2 MB");
  const source = csv.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], value = "", quoted = false, closedQuote = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { value += '"'; index++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else value += char;
      continue;
    }
    if (char === '"') {
      if (value.trim() || closedQuote) throw new Error("A CSV quote appears inside an unquoted field");
      quoted = true; value = ""; continue;
    }
    if (char === "," || char === "\n" || char === "\r") {
      row.push(value.trim()); value = ""; closedQuote = false;
      if (char !== ",") {
        if (row.some(cell => cell !== "")) rows.push(row);
        row = [];
        if (char === "\r" && source[index + 1] === "\n") index++;
      }
      continue;
    }
    if (closedQuote && char.trim()) throw new Error("Unexpected characters after a CSV quote");
    value += char;
  }
  if (quoted) throw new Error("The CSV contains an unfinished quoted field");
  row.push(value.trim());
  if (row.some(cell => cell !== "")) rows.push(row);
  if (rows.length < 2 || rows.length > 10_001 || rows[0].length > 100) throw new Error("Use a header row and up to 10,000 statement rows");
  const headers = rows.shift();
  if (rows.some(cells => cells.length !== headers.length)) throw new Error("Every CSV row must have the same number of columns as its header");
  return { headers, records: rows };
}
function column(headers, mapping, name, required = false) {
  const value = mapping?.[name];
  if (value === undefined || value === null || value === "" || value === -1) {
    if (required) throw new Error(`Map the ${name} column`);
    return -1;
  }
  const index = typeof value === "number" || /^\d+$/.test(String(value)) ? Number(value) : headers.indexOf(value);
  if (!Number.isInteger(index) || index < 0 || index >= headers.length || (typeof value === "string" && !/^\d+$/.test(value) && headers.lastIndexOf(value) !== index)) throw new Error(`Choose an unambiguous ${name} column`);
  return index;
}
function statementDate(value, format) {
  let output;
  if (format === "yyyy-mm-dd") output = value;
  else {
    const parts = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
    if (!parts) throw new Error("The date does not match the selected CSV date format");
    const first = parts[1].padStart(2, "0"), second = parts[2].padStart(2, "0");
    output = format === "mm/dd/yyyy" ? `${parts[3]}-${first}-${second}` : `${parts[3]}-${second}-${first}`;
  }
  return date(output, "statement date");
}
export function previewBankStatement(company, vouchers, input) {
  const account = ledger(company, input.ledgerId);
  if (!isBank(company, account)) throw new Error("Choose a bank or bank overdraft ledger");
  const from = date(input.from, "statement beginning date"), to = date(input.to, "statement ending date");
  if (from > to || from < company.booksFrom) throw new Error("Choose a statement period within these company books");
  const openingPaise = amount(input.openingPaise, "statement opening", true), closingPaise = amount(input.closingPaise, "statement closing", true);
  const parsed = parseBankCsv(input.csv);
  const mapping = Object.fromEntries(["date", "debit", "credit", "amount", "reference", "narration"].map(name => [name, column(parsed.headers, input.mapping, name, name === "date")]));
  if (mapping.amount < 0 && (mapping.debit < 0 || mapping.credit < 0)) throw new Error("Map either a signed amount column, or both debit and credit columns");
  if (mapping.amount >= 0 && (mapping.debit >= 0 || mapping.credit >= 0)) throw new Error("Use one amount mapping style at a time");
  const used = Object.values(mapping).filter(index => index >= 0);
  if (new Set(used).size !== used.length) throw new Error("Map each CSV column to only one field");
  if (!["yyyy-mm-dd", "dd/mm/yyyy", "mm/dd/yyyy", "dd-mm-yyyy"].includes(input.dateFormat)) throw new Error("Choose the CSV date format");
  if (mapping.amount >= 0 && !["credit-positive", "debit-positive"].includes(input.signedConvention)) throw new Error("Choose what a positive signed amount means");
  const ignoredRows = [];
  const rows = [];
  for (let index = 0; index < parsed.records.length; index++) {
    const sourceRow = index + 2, cells = parsed.records[index];
    try {
      let movement;
      if (mapping.amount >= 0) movement = signedMoney(cells[mapping.amount]) * (input.signedConvention === "debit-positive" ? -1 : 1);
      else {
        const debit = signedMoney(cells[mapping.debit]), credit = signedMoney(cells[mapping.credit]);
        if (debit < 0 || credit < 0 || (debit && credit)) throw new Error("Debit and credit columns need positive amounts on one side of each row");
        movement = credit - debit;
      }
      if (!movement) { ignoredRows.push({ sourceRow, reason: "No money movement" }); continue; }
      const when = statementDate(cells[mapping.date], input.dateFormat);
      if (when < from || when > to) throw new Error("The transaction is outside the stated period");
      const reference = mapping.reference >= 0 ? text(cells[mapping.reference], "bank reference", 240, false) : "";
      const narration = mapping.narration >= 0 ? text(cells[mapping.narration], "bank narration", 500, false) : "";
      rows.push({ id: newId("sr"), sourceRow, date: when, amountPaise: movement, reference, narration,
        fingerprint: digest([when, movement, normalReference(reference), narration.trim()]) });
    } catch (error) { throw new Error(`CSV row ${sourceRow}. ${error.message}`); }
  }
  if (!rows.length) throw new Error("The statement has no transaction rows");
  const priorEntries = bookEntries(company, vouchers, account.id).filter(entry => entry.date < from);
  const openingPendingVoucherIds = input.openingPendingVoucherIds || [];
  if (!Array.isArray(openingPendingVoucherIds) || new Set(openingPendingVoucherIds).size !== openingPendingVoucherIds.length || openingPendingVoucherIds.some(id => !priorEntries.some(entry => entry.voucherId === id))) throw new Error("Choose valid book transactions pending at the statement beginning date");
  return {
    id: newId("st"), ledgerId: account.id, name: text(input.name || "Bank statement", "statement name", 100),
    from, to, openingPaise, closingPaise, openingPendingVoucherIds,
    rows, ignoredRows, sourceCsv: input.csv, sourceHash: digest(input.csv), mapping, dateFormat: input.dateFormat,
    signedConvention: input.signedConvention || "credit-positive", importedAt: new Date().toISOString(),
    computedClosingPaise: sum([openingPaise, ...rows.map(row => row.amountPaise)]),
  };
}
export function importBankStatement(meta, company, vouchers, input) {
  const statement = previewBankStatement(company, vouchers, input);
  if (meta.statements.some(row => row.ledgerId === statement.ledgerId && row.sourceHash === statement.sourceHash)) throw new Error("This CSV has already been imported for this bank ledger");
  meta.statements.push(statement);
  return { id: statement.id };
}
function bankRecords(meta, company, vouchers, statement) {
  const entries = bookEntries(company, vouchers, statement.ledgerId);
  const entryMap = new Map(entries.map(entry => [entry.voucherId, entry]));
  const rowMap = new Map(meta.statements.filter(row => row.ledgerId === statement.ledgerId).flatMap(item => item.rows.map(row => [row.id, { ...row, statementId: item.id }])));
  const matches = meta.matches.filter(match => match.ledgerId === statement.ledgerId);
  return { entries, entryMap, rowMap, matches };
}
export function matchBank(meta, company, vouchers, input) {
  const statement = meta.statements.find(row => row.id === input.statementId);
  if (!statement) throw new Error("Choose an imported statement");
  const { entryMap, rowMap, matches } = bankRecords(meta, company, vouchers, statement);
  const rowIds = input.rowIds, voucherIds = input.voucherIds;
  if (!Array.isArray(rowIds) || !rowIds.length || rowIds.length > 100 || new Set(rowIds).size !== rowIds.length || !Array.isArray(voucherIds) || !voucherIds.length || voucherIds.length > 100 || new Set(voucherIds).size !== voucherIds.length) throw new Error("Select statement rows and book transactions once each");
  const rows = rowIds.map(id => rowMap.get(id));
  const entries = voucherIds.map(id => entryMap.get(id));
  if (rows.some(row => !row || row.statementId !== statement.id) || entries.some(entry => !entry || entry.date > statement.to || (entry.date < statement.from && !statement.openingPendingVoucherIds.includes(entry.voucherId)))) throw new Error("Choose statement rows and eligible book transactions for this statement");
  if (matches.some(match => match.rowIds.some(id => rowIds.includes(id)) || match.voucherIds.some(id => voucherIds.includes(id)))) throw new Error("One of these transactions is already matched. Unmatch it first");
  const sign = Math.sign(rows[0].amountPaise);
  if (rows.some(row => Math.sign(row.amountPaise) !== sign) || entries.some(entry => Math.sign(entry.amountPaise) !== sign) || sum(rows.map(row => row.amountPaise)) !== sum(entries.map(entry => entry.amountPaise))) throw new Error("Match equal totals moving in the same direction");
  const match = { id: newId("bm"), ledgerId: statement.ledgerId, statementId: statement.id, rowIds, voucherIds,
    fingerprints: Object.fromEntries(entries.map(entry => [entry.voucherId, entry.fingerprint])), matchedAt: new Date().toISOString() };
  meta.matches.push(match);
  return { id: match.id, matched: structuredClone(match) };
}
export function updateBankOpening(meta, company, vouchers, input) {
  const statement = meta.statements.find(row => row.id === input.statementId);
  if (!statement) throw new Error("Choose an imported statement");
  const old = new Set(statement.openingPendingVoucherIds);
  const next = input.openingPendingVoucherIds;
  const entries = bookEntries(company, vouchers, statement.ledgerId);
  if (!Array.isArray(next) || new Set(next).size !== next.length || next.some(id => !entries.some(entry => entry.voucherId === id && entry.date < statement.from))) throw new Error("Choose valid opening pending transactions");
  if (meta.matches.filter(match => match.statementId === statement.id).some(match => match.voucherIds.some(id => old.has(id) && !next.includes(id)))) throw new Error("Unmatch a cleared opening transaction before removing its opening reference");
  const previous = [...statement.openingPendingVoucherIds];
  statement.openingPendingVoucherIds = [...next];
  return { id: statement.id, previous, openingPendingVoucherIds: [...next] };
}
export function bankReport(meta, company, vouchers, statementId) {
  const banks = company.ledgers.filter(account => isBank(company, account)).map(account => ({ id: account.id, name: account.name }));
  const statements = meta.statements.map(({ rows, sourceCsv, ignoredRows, ...row }) => ({ ...row, rowCount: rows.length, ignoredCount: ignoredRows.length }));
  const statement = meta.statements.find(row => row.id === statementId);
  if (!statement) return { company: { id: company.id, name: company.name, booksFrom: company.booksFrom }, revision: meta.revision, banks, statements };
  const { entries, entryMap, rowMap, matches } = bankRecords(meta, company, vouchers, statement);
  const usedRows = new Set(matches.flatMap(match => match.rowIds));
  const usedEntries = new Set(matches.filter(match => match.rowIds.every(id => rowMap.get(id)?.date <= statement.to)).flatMap(match => match.voucherIds));
  const eligible = entries.filter(entry => (entry.date >= statement.from && entry.date <= statement.to) || statement.openingPendingVoucherIds.includes(entry.voucherId));
  const unmatchedBooks = eligible.filter(entry => !usedEntries.has(entry.voucherId));
  const currentRows = statement.rows.map(row => ({ ...row, matched: usedRows.has(row.id) }));
  const available = unmatchedBooks;
  const candidateMap = new Map(), referenceMap = new Map();
  for (const entry of available) {
    const key = `${entry.date}:${entry.amountPaise}`;
    if (!candidateMap.has(key)) candidateMap.set(key, []);
    candidateMap.get(key).push(entry);
    const refKey = `${key}:${normalReference(entry.reference)}`;
    if (!referenceMap.has(refKey)) referenceMap.set(refKey, []);
    referenceMap.get(refKey).push(entry);
  }
  const duplicateCounts = new Map(), duplicateReferences = new Map();
  for (const row of currentRows.filter(row => !row.matched)) {
    const key = `${row.date}:${row.amountPaise}`, refKey = `${key}:${normalReference(row.reference)}`;
    duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1);
    duplicateReferences.set(refKey, (duplicateReferences.get(refKey) || 0) + 1);
  }
  const priorRows = meta.statements.filter(other => other.ledgerId === statement.ledgerId && other.id !== statement.id).flatMap(other => other.rows);
  const priorFingerprints = new Set(priorRows.map(row => row.fingerprint));
  const rows = currentRows.map(row => {
    const candidates = row.matched ? [] : candidateMap.get(`${row.date}:${row.amountPaise}`) || [];
    const sameReference = normalReference(row.reference) ? referenceMap.get(`${row.date}:${row.amountPaise}:${normalReference(row.reference)}`) || [] : [];
    const selected = sameReference.length ? sameReference : candidates;
    const duplicateCount = sameReference.length ? duplicateReferences.get(`${row.date}:${row.amountPaise}:${normalReference(row.reference)}`) : duplicateCounts.get(`${row.date}:${row.amountPaise}`);
    return { ...row, candidates: selected.map(entry => ({ voucherId: entry.voucherId, number: entry.number, type: entry.type, date: entry.date, amountPaise: entry.amountPaise })),
      candidateKind: selected.length === 1 && duplicateCount === 1 ? sameReference.length ? "amount-date-reference" : "amount-date" : selected.length ? "ambiguous" : "none",
      possibleDuplicate: priorFingerprints.has(row.fingerprint) };
  });
  const clearedBeforeOpening = new Set(matches.filter(match => match.rowIds.every(id => rowMap.get(id)?.date < statement.from)).flatMap(match => match.voucherIds));
  const openingBookPaise = balanceAt(company, vouchers, statement.ledgerId, statement.from, true);
  const closingBookPaise = balanceAt(company, vouchers, statement.ledgerId, statement.to);
  const pendingOpening = entries.filter(entry => statement.openingPendingVoucherIds.includes(entry.voucherId));
  const unmatchedStatementPaise = sum(rows.filter(row => !row.matched).map(row => row.amountPaise));
  const unmatchedBookPaise = sum(unmatchedBooks.map(entry => entry.amountPaise));
  const expectedBankPaise = sum([closingBookPaise, -unmatchedBookPaise, unmatchedStatementPaise]);
  return {
    company: { id: company.id, name: company.name, booksFrom: company.booksFrom }, revision: meta.revision, banks, statements,
    statement: statements.find(row => row.id === statement.id), rows, bookEntries: eligible.map(entry => ({ ...entry, matched: usedEntries.has(entry.voucherId) })),
    openingChoices: entries.filter(entry => entry.date < statement.from && !clearedBeforeOpening.has(entry.voucherId)).map(entry => ({ ...entry, selected: statement.openingPendingVoucherIds.includes(entry.voucherId) })),
    matches: matches.filter(match => match.statementId === statement.id).map(match => ({ ...match, rows: match.rowIds.map(id => rowMap.get(id)), entries: match.voucherIds.map(id => entryMap.get(id)) })),
    totals: { openingBookPaise, closingBookPaise, expectedOpeningBankPaise: sum([openingBookPaise, -sum(pendingOpening.map(entry => entry.amountPaise))]),
      openingDifferencePaise: sum([statement.openingPaise, -openingBookPaise, sum(pendingOpening.map(entry => entry.amountPaise))]),
      statementOpeningPaise: statement.openingPaise, statementClosingPaise: statement.closingPaise,
      computedStatementClosingPaise: sum([statement.openingPaise, ...statement.rows.map(row => row.amountPaise)]),
      statementArithmeticDifferencePaise: sum([statement.closingPaise, -statement.openingPaise, -sum(statement.rows.map(row => row.amountPaise))]),
      unmatchedStatementPaise, unmatchedBookPaise, expectedBankPaise, differencePaise: sum([statement.closingPaise, -expectedBankPaise]) },
  };
}
export function assertBankMetadata(meta, company, vouchers) {
  uniqueIds(meta.statements, "statement"); uniqueIds(meta.matches, "bank match");
  const rowIds = new Set(), usedRows = new Set(), usedEntries = new Set();
  for (const statement of meta.statements) {
    const preview = previewBankStatement(company, vouchers, { ...statement, csv: statement.sourceCsv });
    if (statement.sourceHash !== preview.sourceHash || !Array.isArray(statement.rows) || statement.rows.length !== preview.rows.length || JSON.stringify(statement.ignoredRows) !== JSON.stringify(preview.ignoredRows) || statement.computedClosingPaise !== preview.computedClosingPaise) throw new Error("Invalid bank statement source");
    for (let index = 0; index < statement.rows.length; index++) {
      const row = statement.rows[index], expected = preview.rows[index];
      if (typeof row.id !== "string" || !/^sr-[a-f0-9]{20}$/.test(row.id) || rowIds.has(row.id) || ["sourceRow", "date", "amountPaise", "reference", "narration", "fingerprint"].some(key => row[key] !== expected[key])) throw new Error("Invalid bank statement row");
      rowIds.add(row.id);
    }
  }
  for (const statement of meta.statements) {
    const { rowMap, matches } = bankRecords(meta, company, vouchers, statement);
    if (matches.some(match => match.rowIds.every(id => rowMap.get(id)?.date < statement.from) && match.voucherIds.some(id => statement.openingPendingVoucherIds.includes(id)))) throw new Error("An opening pending transaction was already cleared before this statement began");
  }
  for (const match of meta.matches) {
    const scratch = { ...meta, matches: [] };
    const checked = matchBank(scratch, company, vouchers, match);
    void checked;
    const statement = meta.statements.find(row => row.id === match.statementId);
    if (match.ledgerId !== statement.ledgerId || !match.fingerprints || scratch.matches[0].voucherIds.some(id => scratch.matches[0].fingerprints[id] !== match.fingerprints[id])) throw new Error("A bank match no longer agrees with its book transaction");
    for (const id of match.rowIds) { if (usedRows.has(id)) throw new Error("A bank row is matched twice"); usedRows.add(id); }
    for (const id of match.voucherIds) { const key = `${match.ledgerId}:${id}`; if (usedEntries.has(key)) throw new Error("A bank transaction is matched twice"); usedEntries.add(key); }
  }
}
