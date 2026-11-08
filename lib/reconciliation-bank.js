import { amount, balanceAt, bookEntries, date, digest, isBank, ledger, newId, normalReference, signedMoney, sum, text, uniqueIds } from "./reconciliation-common.js";

const DELIMITERS = [",", ";", "\t"];
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const FULL_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function csvRows(source, delimiter) {
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
    if (char === delimiter || char === "\n" || char === "\r") {
      row.push(value.trim()); value = ""; closedQuote = false;
      if (char !== delimiter) {
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
  return rows;
}
const dateHeader = cell => cell.length <= 40 && /\b(date|dt)\b/i.test(cell);
const moneyHeader = cell => cell.length <= 40 && (/debit|credit|withdrawal|deposit|amount|paid (in|out)/i.test(cell) || /^(dr|cr)\.?$/i.test(cell));
const looksLikeValue = cell => /\d/.test(cell) && (/^[(+-]?\s*(?:INR|Rs\.?|₹)?\s*[\d,]+(\.\d+)?\)?(\s*(dr|cr))?$/i.test(cell) || /^\d{1,4}[/.\- ]\w{1,9}[/.\- ]\d{2,4}/.test(cell));
// The header is the first row naming every mapped column, or else the first row that
// names a date and an amount column without holding any data value itself.
function headerIndex(rows, mapping) {
  const names = Object.values(mapping || {}).filter(name => typeof name === "string" && name.trim() && !/^-?\d+$/.test(name));
  if (names.length) {
    const found = rows.findIndex(cells => names.every(name => cells.includes(name)));
    if (found >= 0) return found;
  }
  const guessed = rows.findIndex(cells => cells.filter(Boolean).length >= 2 && cells.some(dateHeader) && cells.some(moneyHeader) && !cells.some(looksLikeValue));
  return guessed >= 0 ? guessed : 0;
}
function tableOf(rows, headerRow, legacy) {
  if (rows.length < 2 || rows.length > 10_001 + (legacy ? 0 : 200) || rows[headerRow].length > 100) throw new Error("Use a header row and up to 10,000 statement rows");
  const headers = rows[headerRow], skipped = [];
  for (let index = 0; index < headerRow; index++) skipped.push({ sourceRow: index + 1, reason: "Before the statement header" });
  const after = rows.slice(headerRow + 1);
  const conforming = after.map(cells => cells.length === headers.length);
  if (legacy) {
    if (conforming.some(ok => !ok)) throw new Error("Every CSV row must have the same number of columns as its header");
    return { headers, records: after, recordRows: after.map((_, index) => headerRow + index + 2), skipped };
  }
  const first = conforming.indexOf(true), last = conforming.lastIndexOf(true);
  if (first < 0) throw new Error("Use a header row and up to 10,000 statement rows");
  const records = [], recordRows = [];
  after.forEach((cells, index) => {
    const sourceRow = headerRow + index + 2;
    if (index < first || index > last) { skipped.push({ sourceRow, reason: index < first ? "Before the statement table" : "After the statement table" }); return; }
    if (!conforming[index]) throw new Error(`CSV row ${sourceRow} has ${cells.length} columns; the header has ${headers.length}`);
    records.push(cells); recordRows.push(sourceRow);
  });
  if (records.length > 10_000) throw new Error("Use a header row and up to 10,000 statement rows");
  return { headers, records, recordRows, skipped };
}
// Statements saved before header detection keep the original single-table reading so
// their stored rows still validate exactly.
export function parseBankCsv(csv, options = {}) {
  if (typeof csv !== "string" || csv.length > 2_000_000 || !csv.trim()) throw new Error("Choose a CSV statement up to 2 MB");
  const source = csv.replace(/^\uFEFF/, "");
  const layout = options.layout;
  if (layout === undefined || layout === null) {
    if (options.legacy) {
      const rows = csvRows(source, ",");
      return { ...tableOf(rows, 0, true), layout: null };
    }
    // Comma, semicolon or tab: the delimiter giving the largest table of at least two
    // columns wins, comma first on a tie; otherwise the comma reading (or its error) stands.
    let best = null, comma = null, firstError = null;
    for (const delimiter of DELIMITERS) {
      try {
        const rows = csvRows(source, delimiter);
        if (!rows.length) continue;
        const headerRow = headerIndex(rows, options.mapping);
        const table = { ...tableOf(rows, headerRow, false), layout: { delimiter, headerRow } };
        if (delimiter === ",") comma = table;
        if (table.headers.length >= 2 && (!best || table.records.length > best.records.length)) best = table;
      } catch (error) { firstError ||= error; }
    }
    if (best) return best;
    if (firstError) throw firstError;
    if (comma) return comma;
    throw new Error("Use a header row and up to 10,000 statement rows");
  }
  if (!layout || typeof layout !== "object" || !DELIMITERS.includes(layout.delimiter) || !Number.isSafeInteger(layout.headerRow) || layout.headerRow < 0) throw new Error("Invalid bank statement layout");
  const rows = csvRows(source, layout.delimiter);
  if (layout.headerRow >= rows.length) throw new Error("Invalid bank statement layout");
  return { ...tableOf(rows, layout.headerRow, false), layout: { delimiter: layout.delimiter, headerRow: layout.headerRow } };
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
function fullYear(text) {
  if (text.length === 4) return text;
  const year = Number(text);
  return String(year <= 69 ? 2000 + year : 1900 + year);
}
function monthNumber(text) {
  const name = text.toLowerCase().replace(/\.$/, "");
  const month = MONTHS[name] || FULL_MONTHS.indexOf(name) + 1;
  if (!month) throw new Error("The date does not match the selected CSV date format");
  return String(month).padStart(2, "0");
}
// Day-first and month-first formats accept the layouts Indian banks export: dd/mm/yy
// (00-69 means 20xx), dd-MMM-yyyy, dd MMM yyyy and a trailing time of day.
export function statementDate(raw, format) {
  const value = String(raw ?? "").trim().replace(/(?:[T ]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[AP]\.?M\.?)?\s*(?:Z|[+-]\d{2}:?\d{2})?)$/i, "").trim();
  let output;
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value);
  const named = /^(\d{1,2})[-/ .]*([A-Za-z]{3,9}\.?)[-/ .,]*(\d{4}|\d{2})$/.exec(value);
  const monthFirstNamed = /^([A-Za-z]{3,9}\.?)[-/ .]*(\d{1,2})(?:st|nd|rd|th)?[-/ .,]+(\d{4}|\d{2})$/.exec(value);
  if (format === "yyyy-mm-dd" && !iso) output = value;
  else if (iso) output = `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  else if (named) output = `${fullYear(named[3])}-${monthNumber(named[2])}-${named[1].padStart(2, "0")}`;
  else if (monthFirstNamed) output = `${fullYear(monthFirstNamed[3])}-${monthNumber(monthFirstNamed[1])}-${monthFirstNamed[2].padStart(2, "0")}`;
  else {
    const parts = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{4}|\d{2})$/.exec(value);
    if (!parts) throw new Error("The date does not match the selected CSV date format");
    const first = parts[1].padStart(2, "0"), second = parts[2].padStart(2, "0"), year = fullYear(parts[3]);
    output = format === "mm/dd/yyyy" ? `${year}-${first}-${second}` : `${year}-${second}-${first}`;
  }
  return date(output, "statement date");
}
const dateLike = cell => /^\d{1,4}\s*[/.\- ]\s*(\d{1,2}|[A-Za-z]{3,9}\.?)\s*[/.\- ,]\s*\d{2,4}\b/.test(String(cell ?? "").trim());
const DATE_FORMATS = ["yyyy-mm-dd", "dd/mm/yyyy", "mm/dd/yyyy", "dd-mm-yyyy"];
const parsedStatements = new Map();
// Rows depend only on the CSV and its reading options, never on the books, so a
// validation pass (or the next one) reuses them instead of re-parsing every statement.
function statementRows(input) {
  const from = date(input.from, "statement beginning date"), to = date(input.to, "statement ending date");
  if (!DATE_FORMATS.includes(input.dateFormat)) throw new Error("Choose the CSV date format");
  const legacy = input.csvLayout === undefined && input.legacyLayout === true;
  const key = digest([digest(String(input.csv)), input.mapping ?? null, input.dateFormat, input.signedConvention ?? null, from, to, input.csvLayout ?? null, legacy]);
  const cached = parsedStatements.get(key);
  if (cached) { parsedStatements.delete(key); parsedStatements.set(key, cached); return cached; }
  const parsed = parseBankCsv(input.csv, { legacy, layout: input.csvLayout, mapping: input.mapping });
  const mapping = Object.fromEntries(["date", "debit", "credit", "amount", "reference", "narration"].map(name => [name, column(parsed.headers, input.mapping, name, name === "date")]));
  if (mapping.amount < 0 && (mapping.debit < 0 || mapping.credit < 0)) throw new Error("Map either a signed amount column, or both debit and credit columns");
  if (mapping.amount >= 0 && (mapping.debit >= 0 || mapping.credit >= 0)) throw new Error("Use one amount mapping style at a time");
  const used = Object.values(mapping).filter(index => index >= 0);
  if (new Set(used).size !== used.length) throw new Error("Map each CSV column to only one field");
  if (mapping.amount >= 0 && !["credit-positive", "debit-positive"].includes(input.signedConvention)) throw new Error("Choose what a positive signed amount means");
  const ignoredRows = [...parsed.skipped];
  const rows = [];
  // Summary or legend lines inside the table width but outside its dated rows are not transactions.
  const dated = parsed.records.map(cells => { try { statementDate(cells[mapping.date], input.dateFormat); return true; } catch { return false; } });
  const firstDated = parsed.layout ? dated.indexOf(true) : -1, lastDated = parsed.layout ? dated.lastIndexOf(true) : -1;
  for (let index = 0; index < parsed.records.length; index++) {
    const sourceRow = parsed.recordRows[index], cells = parsed.records[index];
    if (firstDated >= 0 && !dated[index] && !dateLike(cells[mapping.date]) && (index < firstDated || index > lastDated)) { ignoredRows.push({ sourceRow, reason: "Outside the dated statement rows" }); continue; }
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
      rows.push({ sourceRow, date: when, amountPaise: movement, reference, narration,
        fingerprint: digest([when, movement, normalReference(reference), narration.trim()]) });
    } catch (error) { throw new Error(`CSV row ${sourceRow}. ${error.message}`); }
  }
  if (!rows.length) throw new Error("The statement has no transaction rows");
  ignoredRows.sort((a, b) => a.sourceRow - b.sourceRow);
  const result = Object.freeze({ from, to, mapping, rows, ignoredRows, layout: parsed.layout, sourceHash: digest(input.csv) });
  parsedStatements.set(key, result);
  if (parsedStatements.size > 8) parsedStatements.delete(parsedStatements.keys().next().value);
  return result;
}
export function previewBankStatement(company, vouchers, input, context = {}) {
  const account = ledger(company, input.ledgerId);
  if (!isBank(company, account)) throw new Error("Choose a bank or bank overdraft ledger");
  const from = date(input.from, "statement beginning date"), to = date(input.to, "statement ending date");
  if (from > to || from < company.booksFrom) throw new Error("Choose a statement period within these company books");
  const openingPaise = amount(input.openingPaise, "statement opening", true), closingPaise = amount(input.closingPaise, "statement closing", true);
  const parsed = statementRows(input);
  const entries = context.entries || bookEntries(company, vouchers, account.id);
  const prior = new Set(entries.filter(entry => entry.date < from).map(entry => entry.voucherId));
  const openingPendingVoucherIds = input.openingPendingVoucherIds || [];
  if (!Array.isArray(openingPendingVoucherIds) || new Set(openingPendingVoucherIds).size !== openingPendingVoucherIds.length || openingPendingVoucherIds.some(id => !prior.has(id))) throw new Error("Choose valid book transactions pending at the statement beginning date");
  return {
    id: newId("st"), ledgerId: account.id, name: text(input.name || "Bank statement", "statement name", 100),
    from, to, openingPaise, closingPaise, openingPendingVoucherIds,
    rows: parsed.rows.map(row => ({ id: newId("sr"), ...row })), ignoredRows: parsed.ignoredRows.map(row => ({ ...row })),
    sourceCsv: input.csv, sourceHash: parsed.sourceHash, mapping: { ...parsed.mapping }, dateFormat: input.dateFormat,
    signedConvention: input.signedConvention || "credit-positive", importedAt: new Date().toISOString(),
    computedClosingPaise: sum([openingPaise, ...parsed.rows.map(row => row.amountPaise)]),
    ...(parsed.layout ? { csvLayout: { ...parsed.layout } } : {}),
  };
}
export function importBankStatement(meta, company, vouchers, input) {
  const statement = previewBankStatement(company, vouchers, input);
  if (meta.statements.some(row => row.ledgerId === statement.ledgerId && row.sourceHash === statement.sourceHash)) throw new Error("This CSV has already been imported for this bank ledger");
  meta.statements.push(statement);
  return { id: statement.id };
}
function bankRecords(meta, company, vouchers, statement, entries = bookEntries(company, vouchers, statement.ledgerId)) {
  const entryMap = new Map(entries.map(entry => [entry.voucherId, entry]));
  const rowMap = new Map(meta.statements.filter(row => row.ledgerId === statement.ledgerId).flatMap(item => item.rows.map(row => [row.id, { ...row, statementId: item.id }])));
  const matches = meta.matches.filter(match => match.ledgerId === statement.ledgerId);
  return { entries, entryMap, rowMap, matches };
}
// Pure check of one proposed match against prepared ledger maps; shared by a new match
// and by validation of every saved match, so the rules cannot drift apart.
function checkBankMatch(statement, records, input) {
  const { entryMap, rowMap, matches } = records;
  const rowIds = input.rowIds, voucherIds = input.voucherIds;
  if (!Array.isArray(rowIds) || !rowIds.length || rowIds.length > 100 || new Set(rowIds).size !== rowIds.length || !Array.isArray(voucherIds) || !voucherIds.length || voucherIds.length > 100 || new Set(voucherIds).size !== voucherIds.length) throw new Error("Select statement rows and book transactions once each");
  const rows = rowIds.map(id => rowMap.get(id));
  const entries = voucherIds.map(id => entryMap.get(id));
  if (rows.some(row => !row || row.statementId !== statement.id) || entries.some(entry => !entry || entry.date > statement.to || (entry.date < statement.from && !statement.openingPendingVoucherIds.includes(entry.voucherId)))) throw new Error("Choose statement rows and eligible book transactions for this statement");
  if (matches.some(match => match.rowIds.some(id => rowIds.includes(id)) || match.voucherIds.some(id => voucherIds.includes(id)))) throw new Error("One of these transactions is already matched. Unmatch it first");
  const sign = Math.sign(rows[0].amountPaise);
  if (rows.some(row => Math.sign(row.amountPaise) !== sign) || entries.some(entry => Math.sign(entry.amountPaise) !== sign) || sum(rows.map(row => row.amountPaise)) !== sum(entries.map(entry => entry.amountPaise))) throw new Error("Match equal totals moving in the same direction");
  return entries;
}
export function matchBank(meta, company, vouchers, input) {
  const statement = meta.statements.find(row => row.id === input.statementId);
  if (!statement) throw new Error("Choose an imported statement");
  const entries = checkBankMatch(statement, bankRecords(meta, company, vouchers, statement), input);
  const match = { id: newId("bm"), ledgerId: statement.ledgerId, statementId: statement.id, rowIds: input.rowIds, voucherIds: input.voucherIds,
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
// Book entries are computed once per bank ledger and each statement's rows once per
// source, so validation is linear in vouchers plus matches rather than their product.
export function assertBankMetadata(meta, company, vouchers) {
  uniqueIds(meta.statements, "statement"); uniqueIds(meta.matches, "bank match");
  const ledgerEntries = new Map();
  const entriesFor = ledgerId => {
    if (!ledgerEntries.has(ledgerId)) ledgerEntries.set(ledgerId, bookEntries(company, vouchers, ledgerId));
    return ledgerEntries.get(ledgerId);
  };
  const rowIds = new Set(), usedRows = new Set(), usedEntries = new Set();
  for (const statement of meta.statements) {
    if (!statement || typeof statement.ledgerId !== "string") throw new Error("Invalid bank statement source");
    ledger(company, statement.ledgerId);
    const preview = previewBankStatement(company, vouchers, { ...statement, csv: statement.sourceCsv, legacyLayout: statement.csvLayout === undefined }, { entries: entriesFor(statement.ledgerId) });
    if (statement.sourceHash !== preview.sourceHash || !Array.isArray(statement.rows) || statement.rows.length !== preview.rows.length || JSON.stringify(statement.ignoredRows) !== JSON.stringify(preview.ignoredRows) || statement.computedClosingPaise !== preview.computedClosingPaise) throw new Error("Invalid bank statement source");
    for (let index = 0; index < statement.rows.length; index++) {
      const row = statement.rows[index], expected = preview.rows[index];
      if (typeof row.id !== "string" || !/^sr-[a-f0-9]{20}$/.test(row.id) || rowIds.has(row.id) || ["sourceRow", "date", "amountPaise", "reference", "narration", "fingerprint"].some(key => row[key] !== expected[key])) throw new Error("Invalid bank statement row");
      rowIds.add(row.id);
    }
  }
  const ledgerRecords = new Map();
  const recordsFor = statement => {
    if (!ledgerRecords.has(statement.ledgerId)) ledgerRecords.set(statement.ledgerId, { ...bankRecords(meta, company, vouchers, statement, entriesFor(statement.ledgerId)) });
    return ledgerRecords.get(statement.ledgerId);
  };
  const statements = new Map(meta.statements.map(statement => [statement.id, statement]));
  for (const statement of meta.statements) {
    const { rowMap, matches } = recordsFor(statement);
    const opening = new Set(statement.openingPendingVoucherIds);
    if (matches.some(match => match.rowIds.every(id => rowMap.get(id)?.date < statement.from) && match.voucherIds.some(id => opening.has(id)))) throw new Error("An opening pending transaction was already cleared before this statement began");
  }
  for (const match of meta.matches) {
    const statement = statements.get(match.statementId);
    if (!statement) throw new Error("Choose an imported statement");
    const records = recordsFor(statement);
    const entries = checkBankMatch(statement, { ...records, matches: [] }, match);
    if (match.ledgerId !== statement.ledgerId || !match.fingerprints || entries.some(entry => match.fingerprints[entry.voucherId] !== entry.fingerprint)) throw new Error("A bank match no longer agrees with its book transaction");
    for (const id of match.rowIds) { if (usedRows.has(id)) throw new Error("A bank row is matched twice"); usedRows.add(id); }
    for (const id of match.voucherIds) { const key = `${match.ledgerId}:${id}`; if (usedEntries.has(key)) throw new Error("A bank transaction is matched twice"); usedEntries.add(key); }
  }
}
