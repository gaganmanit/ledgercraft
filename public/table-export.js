// Table export and small pure helpers for the book screens. No imports, so node:test can load it.
// The pure functions (toCsv, csvFileName, pagingNote, gstCalendar, dueSentence) take plain data.
// The DOM functions (sheetModel, downloadCsv, setExportRows) read the rendered sheet.

const FORMULA_START = /^[=+@\t\r-]/;
const PLAIN_NUMBER = /^-?[\d,]+(?:\.\d+)?$/;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function csvField(value) {
  const text = String(value ?? "");
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A money cell's text as a plain number without thousands separators, or "" for a dash. */
export function plainAmount(text) {
  const value = String(text ?? "").replace(/₹/g, "").replace(/\s+/g, " ").trim();
  if (!value || /^[—–-]$/.test(value)) return "";
  if (PLAIN_NUMBER.test(value)) return value.replace(/,/g, "");
  return value;
}

/** Text cells that a spreadsheet would read as a formula get a leading apostrophe. Numbers stay numbers. */
function safeText(text) {
  const value = String(text ?? "");
  if (FORMULA_START.test(value) && !PLAIN_NUMBER.test(value.trim())) return "'" + value;
  return value;
}

/**
 * Serialise a table model to CSV with a byte-order mark so that Excel reads ₹ correctly.
 * Model: { columns: [{ label, figure }], rows: [[{ text, figure, dc }]] }, rows already expanded for colspan.
 * Each money column becomes an amount column (plain number) followed, when any of its cells carries
 * Dr or Cr, by a Dr/Cr column. Columns with no heading and no content (action buttons) are left out.
 */
export function toCsv(model) {
  const columns = model.columns || [];
  const rows = model.rows || [];
  const width = Math.max(columns.length, ...rows.map(row => row.length), 0);
  const plan = [];
  for (let index = 0; index < width; index += 1) {
    const column = columns[index] || { label: "" };
    const cells = rows.map(row => row[index]).filter(Boolean);
    const figure = Boolean(column.figure) || cells.some(cell => cell.figure && plainAmount(cell.text) !== "" && PLAIN_NUMBER.test(String(cell.text).trim()));
    const dc = figure && cells.some(cell => cell.dc);
    const label = String(column.label ?? "").trim();
    if (!label && cells.every(cell => !String(cell.text ?? "").trim() && !cell.dc)) continue;
    plan.push({ index, label, figure, dc });
  }
  const lines = [];
  lines.push(plan.flatMap(column => column.dc ? [column.label, column.label ? `${column.label} Dr/Cr` : "Dr/Cr"] : [column.label]));
  for (const row of rows) {
    lines.push(plan.flatMap(column => {
      const cell = row[column.index] || { text: "" };
      if (!column.figure) return [safeText(cell.text)];
      const amount = plainAmount(cell.text);
      return column.dc ? [amount, cell.dc || ""] : [amount];
    }));
  }
  return "\uFEFF" + lines.map(line => line.map(csvField).join(",")).join("\r\n") + "\r\n";
}

function slug(text) {
  return String(text ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

function dayFirst(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso || "") ? iso.split("-").reverse().join("-") : String(iso || "");
}

/** north-mill-traders-trial-balance-01-04-2026-09-11-2026.csv */
export function csvFileName({ company, title, from, to }) {
  const parts = [company, title, dayFirst(from), dayFirst(to)].map(slug).filter(Boolean);
  return (parts.join("-") || "ledgercraft") + ".csv";
}

const count = new Intl.NumberFormat("en-IN");

/** "Showing 200 of 1,240 rows", or "" when every row is shown. */
export function pagingNote(shown, total) {
  if (total <= shown) return "";
  return `Showing ${count.format(shown)} of ${count.format(total)} rows`;
}

function addMonth(month) {
  const [year, number] = month.split("-").map(Number);
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, "0")}`;
}

export function monthName(month) {
  return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / 86_400_000);
}

/**
 * Monthly GST filing dates for the latest completed month that has GST documents.
 * GSTR-1 is due on the 11th and GSTR-3B on the 20th of the following month.
 * @param {string[]} documentDates ISO dates of the registration's GST documents
 * @param {string} today ISO date
 */
export function gstCalendar(documentDates, today) {
  const thisMonth = today.slice(0, 7);
  let latest = "";
  for (const date of documentDates) {
    const month = String(date || "").slice(0, 7);
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month < thisMonth && month > latest) latest = month;
  }
  if (!latest) return null;
  const next = addMonth(latest);
  return {
    month: latest,
    returns: [
      { form: "GSTR-1", due: `${next}-11`, days: daysBetween(today, `${next}-11`) },
      { form: "GSTR-3B", due: `${next}-20`, days: daysBetween(today, `${next}-20`) },
    ],
  };
}

/** "is due in 2 days (11-11-2026)", "is due today (…)", "was due on 11-11-2026". */
export function dueSentence(days, due) {
  if (days > 1) return `is due in ${days} days (${dayFirst(due)})`;
  if (days === 1) return `is due tomorrow (${dayFirst(due)})`;
  if (days === 0) return `is due today (${dayFirst(due)})`;
  return `was due on ${dayFirst(due)}`;
}

/* ---------- DOM ---------- */

const exportRows = new WeakMap();

/** A paged table can supply the HTML of every matching body row so that the CSV is not cut at the page. */
export function setExportRows(table, provider) {
  exportRows.set(table, provider);
}

const BLOCK = new Set(["DIV", "P", "SMALL", "BR", "LI", "UL"]);

function cellParts(cell) {
  const pieces = [];
  let current = "";
  const walk = node => {
    if (node.nodeType === 3) { current += node.nodeValue; return; }
    if (node.nodeType !== 1) return;
    if (node.matches(".dc, .sr, button, input, select, textarea, kbd, [aria-hidden=true]")) return;
    const block = BLOCK.has(node.tagName) || node.classList.contains("reconciliation-detail");
    if (block && current.trim()) { pieces.push(current); current = ""; }
    for (const child of node.childNodes) walk(child);
    if (block && current.trim()) { pieces.push(current); current = ""; }
  };
  for (const child of cell.childNodes) walk(child);
  if (current.trim()) pieces.push(current);
  return pieces.map(piece => piece.replace(/\s+/g, " ").trim()).filter(Boolean).join("; ");
}

function cellModel(cell) {
  const figure = cell.classList.contains("figure");
  const dc = figure ? [...cell.querySelectorAll(".dc")].map(span => span.textContent.trim()).filter(Boolean) : [];
  return { text: cellParts(cell), figure, dc: dc.length === 1 ? dc[0] : "" };
}

/* Plain element queries rather than the table DOM (tHead, cells, colSpan) so that rows parsed from a template behave the same. */
const cellsOf = tr => [...tr.children].filter(cell => cell.tagName === "TD" || cell.tagName === "TH");
const spanOf = cell => Math.max(1, Number(cell.getAttribute("colspan")) || 1);
const rowsOf = (table, section) => [...table.querySelectorAll(`:scope > ${section} > tr`)];

function expand(tr) {
  const cells = [];
  for (const cell of cellsOf(tr)) {
    cells.push(cellModel(cell));
    for (let extra = 1; extra < spanOf(cell); extra += 1) cells.push({ text: "", figure: false, dc: "" });
  }
  return cells;
}

function isPlaceholder(tr, width) {
  if (tr.hidden || tr.hasAttribute("data-export-skip")) return true;
  const cells = cellsOf(tr);
  return cells.length === 1 && spanOf(cells[0]) >= width && cells[0].classList.contains("quiet");
}

function tableModel(table) {
  const headRow = rowsOf(table, "thead").at(-1);
  const columns = headRow ? cellsOf(headRow).flatMap(cell => {
    const entry = { label: cellParts(cell) || cell.textContent.replace(/\s+/g, " ").trim(), figure: cell.classList.contains("figure") };
    return [entry, ...Array.from({ length: spanOf(cell) - 1 }, () => ({ label: "", figure: false }))];
  }) : [];
  const width = columns.length || Math.max(0, ...rowsOf(table, "tbody").map(row => cellsOf(row).length));
  let bodyRows = rowsOf(table, "tbody");
  const provider = exportRows.get(table);
  if (provider) {
    const template = document.createElement("template");
    template.innerHTML = `<table><tbody>${provider()}</tbody></table>`;
    bodyRows = [...template.content.querySelectorAll("tbody > tr")];
  }
  const footRows = rowsOf(table, "tfoot");
  const rows = [...bodyRows, ...footRows].filter(tr => !isPlaceholder(tr, width)).map(expand);
  return { columns, rows };
}

function statementModel(sheet) {
  const rows = [];
  const nodes = [...sheet.querySelectorAll(".stmt h2, .stmt h3, .stmt-line, .stmt-total")]
    .sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  for (const node of nodes) {
    if (node.matches("h2, h3")) { rows.push([{ text: cellParts(node) }, { text: "", figure: true }]); continue; }
    const [label, amount] = node.children;
    rows.push([{ text: label ? cellParts(label) : "" }, amount ? cellModel(amount) : { text: "", figure: true }]);
  }
  return rows.length ? { columns: [{ label: "Particulars" }, { label: "Amount", figure: true }], rows } : null;
}

/** The model for the first table in the sheet, or the statement lines of P&L and balance sheet pages. */
export function sheetModel(sheet) {
  const table = sheet?.querySelector("table");
  if (table) return tableModel(table);
  return sheet ? statementModel(sheet) : null;
}

export function downloadCsv(filename, csv) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
