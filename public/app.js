import { nextLineAction } from "/voucher-entry.js";
import { viewBookTool } from "/book-tools.js";
import { installFinder } from "/finder.js";
import { balancesFromTrial, createLedgerDirectory, installLedgerPicker, ledgerControl, notifyDirectory } from "/ledger-picker.js";
import { csvFileName, downloadCsv, dueSentence, gstCalendar, monthName, pagingNote, setExportRows, sheetModel, toCsv } from "/table-export.js";
import { installShortcuts, voucherKeyLabel, voucherKeyShortcut } from "/shortcuts.js";
import { formatINR, fyLabel, parseRupees, todayISO } from "/money.js";

const root = document.querySelector("#root");
const TYPES = ["Payment", "Receipt", "Contra", "Journal", "Sales", "Purchase", "Debit Note", "Credit Note"];
const MARK = {
  Payment: "Pm",
  Receipt: "Rc",
  Contra: "Ct",
  Journal: "Jr",
  Sales: "Sa",
  Purchase: "Pu",
  "Debit Note": "Dn",
  "Credit Note": "Cn",
};
const HINT = {
  Payment: "Credit cash or bank. Debit the party or the expense.",
  Receipt: "Debit cash or bank. Credit the income or the party.",
  Contra: "Both sides stay in cash and bank.",
  Journal: "Any ledgers, as long as the two sides match.",
  Sales: "Credit an income ledger. Debit cash or the customer.",
  Purchase: "Debit an expense ledger. Credit cash or the supplier.",
  "Debit Note": "Usually a debit to a supplier.",
  "Credit Note": "Usually a credit to a customer.",
};

let renderToken = 0;
const PAGE_ROWS = 200;
/* A paged table registers how to show every row, so that printing never stops at the first page. */
let expandForPrint = null;
let shortcuts = { mac: true, open() {} };

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function still(token) {
  return token === renderToken;
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      method: options.method || "GET",
      headers: options.body ? { "content-type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new Error("Ledgercraft could not reach its local server. Check that it is still running, then try again.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || (options.method && options.method !== "GET" ? "The book could not be updated" : "That page could not be loaded"));
  if (/^\/api\/companies\/[^/]+\/meta(\?|$)/.test(path)) bookWarning = typeof data.warning === "string" ? data.warning : "";
  return data;
}

/* Set when the server opened a book from its .bak copy; shown on every page of that company until a clean save. */
let bookWarning = "";

function focusNext(form, from) {
  const controls = [...form.querySelectorAll("input, select, textarea, button")].filter(el => !el.disabled && el.offsetParent !== null && el.getAttribute("aria-hidden") !== "true");
  const next = controls[controls.indexOf(from) + 1];
  if (next) next.focus();
  if (next && typeof next.select === "function" && next.tagName === "INPUT") next.select();
  return Boolean(next);
}

function parseRoute() {
  const parts = (location.hash.split("?")[0].replace(/^#/, "") || "/").split("/").filter(Boolean);
  if (parts[0] === "tally-import") return { name: "tally-import" };
  if (parts[0] === "transfer") return { name: "transfer" };
  if (parts[0] !== "c" || !parts[1]) return { name: "index" };
  const id = decodeURIComponent(parts[1]);
  const section = parts[2] || "home";
  if (section === "v") {
    return {
      name: "voucher",
      id,
      type: decodeURIComponent(parts[3] || "Receipt"),
      voucherId: parts[4] ? decodeURIComponent(parts[4]) : "",
    };
  }
  if (section === "ledger") return { name: "ledger", id, ledgerId: decodeURIComponent(parts[3] || "") };
  return { name: section, id, detail: decodeURIComponent(parts[3] || "") };
}

function fyStart(iso) {
  const [year, month] = iso.split("-").map(Number);
  return `${month >= 4 ? year : year - 1}-04-01`;
}

function readPeriod(company) {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(`financer-period:${company.id}`) || "null");
  } catch {
    saved = null;
  }
  let from = saved?.from || company.booksFrom;
  let to = saved?.to || todayISO();
  if (from < company.booksFrom) from = company.booksFrom;
  if (to < from) to = from;
  return { from, to };
}

function savePeriod(id, from, to) {
  sessionStorage.setItem(`financer-period:${id}`, JSON.stringify({ from, to }));
}

function takeFlash() {
  const message = sessionStorage.getItem("financer-flash") || "";
  sessionStorage.removeItem("financer-flash");
  return message;
}

const destinations = [
  ["Workspace", [["", "Owner review"], ["daybook", "Day book"], ["v/Receipt", "Pass a voucher"]]],
  ["GST", [["gst-invoice", "New invoice"], ["gst-register", "Invoice register"], ["gst-returns", "GST returns"], ["gst-rcm", "Reverse charge"], ["gst-itc", "Purchase ITC review"], ["gst", "GST setup"]]],
  ["Inventory", [["stock", "Stock summary"]]],
  ["Statements", [["cash-bank", "Cash & bank"], ["bank-reconciliation", "Bank reconciliation"], ["outstanding", "Outstanding"], ["bill-outstanding", "Bill-wise ageing"], ["tb", "Trial balance"], ["pl", "Profit & loss"], ["bs", "Balance sheet"], ["group-summary", "Group summary"]]],
  ["Books", [["ledgers", "Ledgers"], ["groups", "Groups"], ["parties", "Party statements"], ["audit", "Edit log"], ["settings", "Settings"], ["transfer", "Import & export"], ["tally-import", "Tally migration"]]],
];

function dateLabel(iso) { return iso.split("-").reverse().join("-"); }
function finderRoutes(id) {
  const book = id ? "#/c/" + encodeURIComponent(id) : "";
  const items = [{ title: "Switch company", detail: "Books on this Mac", href: "#/" }];
  if (!id) return items.concat([{ title: "Import a company", href: "#/transfer" }]);
  for (const [detail, links] of destinations) {
    for (const [route, title] of links) items.push({ title, detail, href: book + (route ? "/" + route : "") });
  }
  for (const type of TYPES) items.push({ title: "New " + type, detail: "Voucher", href: book + "/v/" + encodeURIComponent(type) });
  return items;
}

function themeLabel() {
  return document.documentElement.dataset.theme === "dark" ? "Light pages" : "Dark pages";
}

function page({ company, title, lede, error, status, body }) {
  const book = company ? "#/c/" + encodeURIComponent(company.id) : "#/";
  const current = parseRoute().name;
  const link = (href, label, selected) => `<a href="${href}"${selected ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
  const nav = company ? destinations.map(([group, links]) => `<section class="nav-group"><h2>${esc(group)}</h2>${links.map(([path, label]) => {
    if (path === "v/Receipt" && current === "home") return "";
    const selected = (path || "home") === current || (path.startsWith("v/") && current === "voucher");
    return link(`${book}${path ? "/" + path : ""}`, label, selected);
  }).join("")}</section>`).join("") : `<section class="nav-group"><h2>Workspace</h2>${link("#/", "Companies", current === "index")}${link("#/transfer", "Import a company", current === "transfer")}${link("#/tally-import", "Import Tally data", current === "tally-import")}</section>`;
  const range = company ? readPeriod(company) : null;
  const specimen = company && /^specimen-[0-9a-f]{6}$/.test(company.id) && company.name === "North Mill Traders";
  const period = company ? `<span class="fy">FY ${esc(fyLabel(range.to))}</span>
      <form class="period-control" id="period-control" data-company="${esc(company.id)}" data-books-from="${esc(company.booksFrom)}" aria-label="Reporting period">
        <label>From <input type="date" name="from" required min="${esc(company.booksFrom)}" value="${esc(range.from)}" /></label>
        <label>to <input type="date" name="to" required min="${esc(company.booksFrom)}" value="${esc(range.to)}" /></label>
      </form>` : "";
  return `<div class="app">
    <aside class="cover"><a class="brand" href="${book}"><span class="brand-mark" aria-hidden="true"></span>Ledgercraft</a>
      <nav aria-label="Book navigation">${nav}</nav>
      <div class="cover-foot"><div class="cover-buttons"><button type="button" class="theme-toggle" data-theme-toggle>${themeLabel()}</button><button type="button" class="theme-toggle" data-shortcuts aria-keyshortcuts="?">Keyboard shortcuts</button></div><p><span class="local-dot" aria-hidden="true"></span>Books stay on this Mac</p></div>
    </aside>
    <div class="pages"><header class="topbar">
      <a class="company-switch" href="#/"><strong>${esc(company?.name || "Companies")}</strong><span>${company ? (specimen ? "Specimen company" : "Switch company") : "Choose a company to open its books"}</span></a>
      ${period}
      <button type="button" class="find-button" data-find>Find <kbd>⌘K</kbd></button></header>
    <main class="sheet" id="sheet" tabindex="-1">
      <header class="sheet-head"><h1 tabindex="-1">${esc(title)}</h1>${lede ? `<p class="lede">${esc(lede)}</p>` : ""}</header>
      <div class="print-company">${esc(company?.name || "")}</div>
      ${company && bookWarning ? `<p class="alert" role="alert">${esc(bookWarning)}</p>` : ""}
      ${error ? `<p class="alert" role="alert">${esc(error)}</p>` : ""}
      ${status ? `<p class="status" role="status">${esc(status)}</p>` : ""}
      ${body}
    </main></div></div>`;
}

function parentName(company, group) {
  if (!group.parentId) return "Primary";
  return company.groups.find((item) => item.id === group.parentId)?.name || "Primary";
}

function ledgerOptions(company, selected) {
  return company.groups
    .map((group) => {
      const ledgers = company.ledgers.filter((ledger) => ledger.groupId === group.id);
      if (!ledgers.length) return "";
      const options = ledgers
        .map((ledger) => `<option value="${esc(ledger.id)}"${ledger.id === selected ? " selected" : ""}>${esc(ledger.name)}</option>`)
        .join("");
      return `<optgroup label="${esc(group.name)}">${options}</optgroup>`;
    })
    .join("");
}

function lineRow(company, line, index) {
  const debit = line.dc === "Dr" && line.paise ? formatINR(line.paise) : "";
  const credit = line.dc === "Cr" && line.paise ? formatINR(line.paise) : "";
  return `<tr>
    <td>
      <label class="sr" for="ledger-${index}">Ledger</label>
      <select id="ledger-${index}" name="ledger">
        <option value="">Choose a ledger</option>
        ${ledgerOptions(company, line.ledgerId)}
      </select>
    </td>
    <td>
      <label class="sr" for="dr-${index}">Debit</label>
      <input id="dr-${index}" name="debit" inputmode="decimal" autocomplete="off" value="${esc(debit)}" />
    </td>
    <td>
      <label class="sr" for="cr-${index}">Credit</label>
      <input id="cr-${index}" name="credit" inputmode="decimal" autocomplete="off" value="${esc(credit)}" />
    </td>
  </tr>`;
}

function collectLines(form) {
  const ledgers = [...form.querySelectorAll("[name=ledger]")];
  const debits = [...form.querySelectorAll("[name=debit]")];
  const credits = [...form.querySelectorAll("[name=credit]")];
  const lines = [];
  for (let i = 0; i < ledgers.length; i += 1) {
    const ledgerId = ledgers[i].value;
    const debit = debits[i].value.trim();
    const credit = credits[i].value.trim();
    if (!ledgerId && !debit && !credit) continue;
    if (debit && credit) throw new Error("A line is either debit or credit");
    const raw = debit || credit;
    if (!ledgerId || !raw) throw new Error("Each used line needs a ledger and one amount");
    const paise = parseRupees(raw);
    if (!paise) throw new Error("Enter an amount greater than zero");
    lines.push({ ledgerId, dc: debit ? "Dr" : "Cr", paise });
  }
  return lines;
}

function voucherLineAction(form) {
  const amounts = [...form.querySelectorAll("#lines tr")].map(tr => ({
    debit: tr.querySelector("[name=debit]").value, credit: tr.querySelector("[name=credit]").value
  }));
  return nextLineAction(amounts);
}

function bindDifference(form) {
  const note = form.querySelector(".difference");
  const button = form.querySelector("[data-pass]");
  const paint = () => {
    for (const row of form.querySelectorAll("#lines tr")) {
      const debit = row.querySelector("[name=debit]");
      const credit = row.querySelector("[name=credit]");
      const hasDebit = debit.value.trim() !== "";
      const hasCredit = credit.value.trim() !== "";
      debit.disabled = hasCredit && !hasDebit;
      credit.disabled = hasDebit && !hasCredit;
      debit.title = debit.disabled ? "Clear the credit amount to enter a debit" : "";
      credit.title = credit.disabled ? "Clear the debit amount to enter a credit" : "";
    }
    const action = form.querySelector("#line-action");
    try {
      action.querySelector("span").textContent = voucherLineAction(form).label;
      action.disabled = false;
    } catch {
      action.querySelector("span").textContent = "Add line";
      action.disabled = true;
    }
    try {
      const lines = collectLines(form);
      let debit = 0;
      let credit = 0;
      for (const line of lines) {
        if (line.dc === "Dr") debit += line.paise;
        else credit += line.paise;
      }
      const gap = debit - credit;
      note.classList.toggle("met", lines.length >= 2 && gap === 0);
      if (lines.length < 2) note.textContent = "Add both sides of the entry.";
      else if (gap === 0) note.textContent = `Both sides ${formatINR(debit)}.`;
      else if (gap > 0) note.textContent = `Debit is over by ${formatINR(gap)}.`;
      else note.textContent = `Credit is over by ${formatINR(-gap)}.`;
      button.disabled = !(lines.length >= 2 && gap === 0);
    } catch (error) {
      note.classList.remove("met");
      note.textContent = error.message;
      button.disabled = true;
    }
  };
  if (!form.dataset.bound) {
    form.dataset.bound = "1";
    form.addEventListener("input", paint);
  }
  paint();
}

function periodBar(range) {
  return `<div class="sheet-tools"><span class="period-echo">${esc(dateLabel(range.from))} to ${esc(dateLabel(range.to))} <button type="button" class="link" data-focus-period>Change period</button></span><span class="sheet-actions"><button type="button" class="ghost" data-export-csv>Download CSV</button><button type="button" class="ghost" data-print-sheet>Print</button></span></div><p class="only-print">${esc(dateLabel(range.from))} to ${esc(dateLabel(range.to))}</p>`;
}
function bindPeriod() {
  /* The reporting period is set once in the top bar; see the delegated change handler below. */
}

function figure(paise, dc = "") {
  if (!paise) return `<td class="figure quiet">\u2014</td>`;
  return `<td class="figure">${esc(formatINR(paise))}${dc ? `<span class="dc">${esc(dc)}</span>` : ""}</td>`;
}

function moreRows() {
  return `<div class="table-more" data-table-more hidden><p class="quiet" data-more-note></p><button type="button" class="ghost" data-more-rows>Show ${PAGE_ROWS} more rows</button></div>`;
}

/* Renders the first `limit` rows of a list into a tbody and keeps the "Show more" control honest. */
function pagedTable({ table, rows, rowHtml, prefix = () => "", suffix = "", onPage = () => {} }) {
  let limit = PAGE_ROWS;
  let current = rows;
  const more = table.closest("#sheet").querySelector("[data-table-more]");
  const body = table.tBodies[0];
  const paint = () => {
    const shown = current.slice(0, limit);
    body.innerHTML = prefix(shown) + shown.map(rowHtml).join("") + suffix;
    more.hidden = current.length <= limit;
    more.querySelector("[data-more-note]").textContent = pagingNote(Math.min(limit, current.length), current.length);
    onPage(shown);
  };
  more.querySelector("[data-more-rows]").addEventListener("click", () => { limit += PAGE_ROWS; paint(); });
  setExportRows(table, () => prefix(current) + current.map(rowHtml).join("") + suffix);
  expandForPrint = () => { if (current.length > limit) { limit = current.length; paint(); } };
  paint();
  return { update(next) { current = next; limit = PAGE_ROWS; paint(); } };
}

async function viewIndex(token, error = "") {
  const [{ companies }, settings] = await Promise.all([api("/api/companies"), api("/api/workstation")]);
  if (!still(token)) return;
  document.title = "Ledgercraft";
  const nameCounts = new Map();
  for (const c of companies) nameCounts.set(c.name, (nameCounts.get(c.name) || 0) + 1);
  const bookDetail = c => {
    if (/^specimen-[0-9a-f]{6}$/.test(c.id) && c.name === "North Mill Traders") return "Specimen book";
    return nameCounts.get(c.name) > 1 ? "Book " + c.id.slice(-6).toUpperCase() : "";
  };
  const list = companies.length
    ? `<ol class="index">${companies
        .map(
          (company) => `<li><a href="#/c/${esc(company.id)}">
            <span><strong>${esc(company.name)}</strong><em>Books from ${esc(dateLabel(company.booksFrom))}</em>${bookDetail(company) ? `<em>${esc(bookDetail(company))}</em>` : ""}</span>
            <span class="open">Open</span>
          </a></li>`,
        )
        .join("")}</ol>`
    : `<p class="empty">No company is on this desk yet.</p>`;
  root.innerHTML = page({
    folio: "Bk",
    kicker: "Index",
    title: "Companies",
    lede: "Open a book or start a new company.",
    error,
    body: `${list}
      <form class="launch-pref" id="launch-pref"><label>On launch
        <select name="launch"><option value="last"${settings.loadLastCompany ? " selected" : ""}>Reopen the last company</option><option value=""${!settings.loadLastCompany && !settings.defaultCompany ? " selected" : ""}>Choose a company</option>
        ${companies.map(c => `<option value="${esc(c.id)}"${!settings.loadLastCompany && settings.defaultCompany === c.id ? " selected" : ""}>Open ${esc(c.name)}${bookDetail(c) ? " (" + esc(bookDetail(c)) + ")" : ""}</option>`).join("")}</select></label><button type="submit" class="ghost">Save preference</button><span role="status"></span></form>
      <form class="foot-form" id="new-company">
        <h2>Open a new book</h2>
        <label>Company name <input name="name" required minlength="2" maxlength="80" autocomplete="organization" /></label>
        <label>Books begin <input name="booksFrom" type="date" required value="${esc(fyStart(todayISO()))}" /></label>
        <div class="actions">
          <button type="submit">Create the company</button>
          <button type="button" class="ghost" id="specimen">Add specimen company</button>
        </div>
      </form>`,
  });
  document.querySelector("#launch-pref").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const choice = form.elements.launch.value;
    try {
      await api("/api/workstation", { method: "PUT", body: { loadLastCompany: choice === "last", defaultCompany: choice === "last" ? settings.defaultCompany : choice || null } });
      form.querySelector("[role=status]").textContent = "Preference saved.";
    } catch (err) { showAlert(err.message, form); }
  });
  document.querySelector("#new-company").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const button = form.querySelector("[type=submit]");
    button.disabled = true;
    try {
      const created = await api("/api/companies", {
        method: "POST",
        body: { name: data.get("name"), booksFrom: data.get("booksFrom") },
      });
      location.hash = `#/c/${created.company.id}`;
    } catch (err) {
      button.disabled = false;
      showAlert(err.message, form);
    }
  });
  document.querySelector("#specimen").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const created = await api("/api/specimen", { method: "POST", body: {} });
      location.hash = `#/c/${created.company.id}`;
    } catch (err) {
      button.disabled = false;
      showAlert(err.message, document.querySelector("#new-company"));
    }
  });
}

function showAlert(message, form) {
  let alert;
  if (form instanceof Element) {
    alert = form.querySelector("[data-form-error]");
    if (!alert) {
      alert = document.createElement("p");
      alert.className = "form-message alert";
      alert.setAttribute("role", "alert");
      alert.setAttribute("tabindex", "-1");
      alert.dataset.formError = "1";
      const heading = form.querySelector(":scope > h2");
      if (heading) heading.after(alert); else form.prepend(alert);
    }
  } else {
    alert = document.querySelector("[data-page-error]");
    if (!alert) {
      alert = document.createElement("p");
      alert.className = "alert";
      alert.setAttribute("role", "alert");
      alert.setAttribute("tabindex", "-1");
      alert.dataset.pageError = "1";
      document.querySelector(".sheet-head").after(alert);
    }
  }
  alert.textContent = message;
  alert.scrollIntoView({ block: "nearest" });
  alert.focus({ preventScroll: true });
}

async function viewHome(token, id) {
  const base = "/api/companies/" + encodeURIComponent(id);
  const { company } = await api(base + "/meta");
  const range = readPeriod(company);
  const review = await api(base + "/owner-review?" + new URLSearchParams(range));
  if (!still(token)) return;
  const book = "#/c/" + encodeURIComponent(id);
  const money = value => "₹" + formatINR(Math.abs(value));
  const balance = (label, amount, route, suffix = "") => `<a class="review-balance" href="${book}/${route}"><span>${esc(label)}</span><strong>${esc(money(amount))}${suffix ? ` <small>${esc(suffix)}</small>` : ""}</strong></a>`;
  document.title = company.name + " · Ledgercraft";
  root.innerHTML = page({ company, folio: "Or", kicker: "Owner review", title: "Owner review", status: takeFlash(),
    body: `<div class="review-intro"><p>Balances as of <strong>${esc(dateLabel(range.to))}</strong></p><details class="new-voucher-menu"><summary class="ink-link">New voucher</summary><div>${TYPES.map(type=>`<a href="${book}/v/${encodeURIComponent(type)}" aria-keyshortcuts="${esc(voucherKeyShortcut(type))}">${esc(type)} <kbd aria-hidden="true">${esc(voucherKeyLabel(type, shortcuts.mac))}</kbd></a>`).join("")}</div></details></div>
      <div class="balance-strip">${balance("Cash & bank", review.cashBank, "cash-bank", review.cashBank < 0 ? "Cr" : "")}
      ${balance(review.receivable < 0 ? "Customer advances" : "Net receivables", review.receivable, "outstanding/debtors")}
      ${balance(review.payable < 0 ? "Supplier advances" : "Net payables", review.payable, "outstanding/creditors")}</div>
      <div class="profit-rule"><span>${review.netProfit < 0 ? "Net loss" : "Net profit"} <small>${esc(dateLabel(range.from))} – ${esc(dateLabel(range.to))}</small></span><a href="${book}/pl">${review.netProfit === null ? "Stock valuation pending" : esc(money(review.netProfit))}</a></div>
      ${review.workbookOpeningScope ? `<p class="quiet"><a href="${book}/tally-source">Tally workbook basis</a> · ${esc(review.workbookOpeningScope.message)}</p>` : ""}
      ${review.difference ? `<p class="alert"><a href="${book}/tb">Opening balances differ by ${esc(money(review.difference))}. Review trial balance</a></p>` : ""}
      <section class="review-attention" aria-labelledby="attention-title"><div class="section-title"><h2 id="attention-title">Needs attention</h2></div><div data-attention aria-live="polite" aria-busy="true"><p class="quiet">Checking GST returns, receivables, bank statements, purchase credit and stock.</p></div></section>
      <section class="latest"><div class="section-title"><h2>Recent vouchers</h2></div>
      ${review.latest.length ? `<table><thead><tr><th>Date</th><th>Voucher</th><th>Particulars</th><th class="figure">Amount (₹)</th></tr></thead><tbody>${review.latest.map(v => `<tr><td class="date-cell">${esc(dateLabel(v.date))}</td><td><a class="voucher-ref" href="${book}/v/${encodeURIComponent(v.type)}/${encodeURIComponent(v.id)}">${esc(v.number)}</a></td><td>${esc(v.narration || v.particulars)}</td><td class="figure">${esc(formatINR(v.paise))}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">No vouchers in this period.</p>'}</section>` });
  fillAttention(token, id, range);
}

const countLabel = (count, one, many = one + "s") => `${count.toLocaleString("en-IN")} ${count === 1 ? one : many}`;
const TAX_HEADS = ["cgst", "sgst", "utgst", "igst", "cess"];

/* Each check fails soft: a failed request leaves its line out and is named once at the end. */
async function fillAttention(token, id, range) {
  const base = "/api/companies/" + encodeURIComponent(id);
  const book = "#/c/" + encodeURIComponent(id);
  const money = paise => "₹" + formatINR(paise);
  const today = todayISO();
  const checks = [
    ["GST returns", async () => {
      const { registrations = [] } = await api(base + "/gst/registrations");
      if (!registrations.length) return [];
      const { invoices = [] } = await api(base + "/gst");
      return registrations.flatMap(registration => {
        const calendar = gstCalendar(invoices.filter(invoice => invoice.registrationId === registration.id).map(invoice => invoice.date), today);
        if (!calendar) return [];
        const href = `${book}/gst-returns?${new URLSearchParams({ registration: registration.id, month: calendar.month })}`;
        const which = registrations.length > 1 ? ` for ${registration.gstin}` : "";
        return calendar.returns.map(item => `<a href="${esc(href)}">${esc(item.form)} for ${esc(monthName(calendar.month))}</a>${esc(which)} ${esc(dueSentence(item.days, item.due))}.`);
      });
    }],
    ["receivables", async () => {
      const report = await api(`${base}/reconciliation/bills?asOf=${encodeURIComponent(range.to)}`);
      const overdue = (report.rows || []).filter(row => row.side === "receivable" && row.openPaise > 0 && row.daysOverdue > 30);
      if (!overdue.length) return [];
      const amount = overdue.reduce((sum, row) => sum + row.openPaise, 0);
      const parties = new Set(overdue.map(row => row.ledgerId)).size;
      return [`<a href="${book}/bill-outstanding">${esc(money(amount))} receivable from ${esc(countLabel(parties, "party", "parties"))}</a> is more than 30 days overdue.`];
    }],
    ["bank statements", async () => {
      const { statements = [] } = await api(`${base}/reconciliation/bank`);
      if (!statements.length) return [];
      const reports = await Promise.all(statements.map(statement => api(`${base}/reconciliation/bank?statementId=${encodeURIComponent(statement.id)}`)));
      const open = reports.reduce((sum, report) => sum + (report.rows || []).filter(row => !row.matched).length, 0);
      if (!open) return [];
      return [`<a href="${book}/bank-reconciliation">${esc(countLabel(open, "bank statement row"))}</a> ${open === 1 ? "has" : "have"} no match in the books yet.`];
    }],
    ["purchase credit", async () => {
      const report = await api(`${base}/gst/itc?to=${encodeURIComponent(range.to)}`);
      const total = row => TAX_HEADS.reduce((sum, head) => sum + (row?.[head + "Paise"] || 0), 0);
      const awaiting = (report.documents || []).reduce((sum, document) => sum + total(document.balances?.unreviewed) + total(document.balances?.unclaimed), 0);
      if (!awaiting) return [];
      return [`<a href="${book}/gst-itc">${esc(money(awaiting))} of purchase credit</a> is awaiting claim or review.`];
    }],
    ["stock", async () => {
      const report = await api(`${base}/stock?${new URLSearchParams({ from: range.from, to: range.to })}`);
      const flagged = (report.items || []).filter(row => row.complete === false || row.valuePaise == null).length;
      const issues = new Set((report.issues || []).map(issue => issue.itemId || issue.sourceId || issue.code || issue.message)).size;
      const count = Math.max(flagged, issues);
      if (!count) return [];
      return [`<a href="${book}/stock">${esc(countLabel(count, "stock item"))}</a> ${count === 1 ? "needs" : "need"} review.`];
    }],
  ];
  const results = await Promise.allSettled(checks.map(([, run]) => run()));
  if (!still(token)) return;
  const target = root.querySelector("[data-attention]");
  if (!target) return;
  const items = results.flatMap(result => result.status === "fulfilled" ? result.value : []);
  const failed = checks.filter((_, index) => results[index].status === "rejected").map(([name]) => name);
  const unchecked = failed.length ? `Ledgercraft could not check ${failed.length > 1 ? failed.slice(0, -1).join(", ") + " and " + failed.at(-1) : failed[0]} just now.` : "";
  target.removeAttribute("aria-busy");
  target.innerHTML = items.length
    ? `<ul class="attention-rule">${items.map(item => `<li>${item}</li>`).join("")}</ul>${unchecked ? `<p class="quiet">${esc(unchecked)}</p>` : ""}`
    : `<p class="quiet">${failed.length ? `Nothing needs attention in the checks that ran. ${esc(unchecked)}` : "Nothing needs attention right now."}</p>`;
}

function groupPath(company, groupId) {
  const names = [];
  const seen = new Set();
  let group = company.groups.find((item) => item.id === groupId);
  while (group && !seen.has(group.id)) {
    names.unshift(group.name);
    seen.add(group.id);
    group = company.groups.find((item) => item.id === group.parentId);
  }
  return names.join(" › ");
}

/* True when the group, or any group above it, is the target group. */
function underGroup(company, groupId, targetId) {
  const seen = new Set();
  let group = company.groups.find((item) => item.id === groupId);
  while (group && !seen.has(group.id)) {
    if (group.id === targetId) return true;
    seen.add(group.id);
    group = company.groups.find((item) => item.id === group.parentId);
  }
  return false;
}
const PARTY_GROUPS = ["g-debtors", "g-creditors"];
/* Reserved groups that can never sit under Sundry Debtors or Sundry Creditors, so the ledger report skips the masters lookup for them. */
const NON_PARTY_GROUPS = new Set(["g-capital", "g-reserves", "g-current-assets", "g-bank", "g-cash", "g-deposits", "g-advances", "g-stock", "g-current-liab", "g-duties", "g-provisions", "g-fixed", "g-invest", "g-loans", "g-od", "g-secured", "g-unsecured", "g-branch", "g-suspense", "g-misc", "g-sales", "g-purchase", "g-direct-exp", "g-direct-inc", "g-indirect-exp", "g-indirect-inc"]);

function lockEntryForm(form) {
  const enabled = [...form.elements].filter((control) => !control.disabled);
  for (const control of enabled) control.disabled = true;
  return () => {
    for (const control of enabled) control.disabled = false;
  };
}

async function viewGroups(token, id) {
  const { company } = await api(`/api/companies/${encodeURIComponent(id)}/masters`);
  if (!still(token)) return;
  document.title = `Groups · ${company.name}`;
  const options = company.groups.map((group) => `<option value="${esc(group.id)}">${esc(groupPath(company, group.id))}</option>`).join("");
  const rows = company.groups.map((group) => `<tr><th scope="row">${esc(group.name)}</th><td>${esc(group.parentId ? groupPath(company, group.parentId) : "Primary")}</td><td>${esc(group.nature || "As parent")}</td><td>${group.reserved ? "" : `<button class="ghost" data-edit-group="${esc(group.id)}">Edit</button>`}</td></tr>`).join("");
  root.innerHTML = page({ company, folio: "Gp", kicker: "Masters", title: "Groups",
    lede: "A new group inherits its parent’s accounting treatment.",
    body: `<table><thead><tr><th>Group</th><th>Under</th><th>Nature</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <form class="foot-form" id="group-form"><h2 id="group-heading">Add a group</h2>
        <label>Name <input name="name" required minlength="2" maxlength="80" /></label>
        <label>Under <select name="parentId">${options}</select></label>
        <div class="actions"><button type="submit">Add the group</button><button type="button" class="ghost" id="group-cancel" hidden>Cancel edit</button><button type="button" class="danger" id="group-remove" hidden>Remove group</button></div>
      </form>` });
  const form = document.querySelector("#group-form");
  let editing = null;
  let saving = false;
  form.addEventListener("input", () => { form.dataset.dirty = "1"; });
  form.addEventListener("change", () => { form.dataset.dirty = "1"; });
  const discardChanges = () => form.dataset.dirty !== "1" || confirm("Discard the changes in this form?");
  for (const button of document.querySelectorAll("[data-edit-group]")) button.addEventListener("click", () => {
    if (saving || !discardChanges()) return;
    form.dataset.dirty = "";
    editing = company.groups.find((group) => group.id === button.dataset.editGroup);
    form.elements.name.value = editing.name;
    form.elements.parentId.value = editing.parentId;
    form.elements.parentId.disabled = true;
    form.querySelector("h2").textContent = "Edit group";
    form.querySelector("[type=submit]").textContent = "Save group";
    document.querySelector("#group-cancel").hidden = false;
    document.querySelector("#group-remove").hidden = false;
    form.elements.name.focus();
  });
  document.querySelector("#group-cancel").addEventListener("click", () => { if (!saving && discardChanges()) render(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    const button = form.querySelector("[type=submit]");
    button.disabled = true;
    const unlock = lockEntryForm(form);
    try {
      await api(`/api/companies/${encodeURIComponent(id)}/groups${editing ? `/${encodeURIComponent(editing.id)}` : ""}`, {
        method: editing ? "PUT" : "POST", body: { name: form.elements.name.value, parentId: form.elements.parentId.value, expected: editing ? { name: editing.name } : undefined },
      });
      render();
    } catch (error) { unlock(); saving = false; button.disabled = false; showAlert(error.message, form); }
  });
  document.querySelector("#group-remove").addEventListener("click", async (event) => {
    if (saving || !editing || !confirm(`Remove group “${editing.name}”?`)) return;
    saving = true;
    const button = event.currentTarget;
    button.disabled = true;
    const unlock = lockEntryForm(form);
    try { await api(`/api/companies/${encodeURIComponent(id)}/groups/${encodeURIComponent(editing.id)}`, { method: "DELETE", body: { expected: { name: editing.name } } }); render(); }
    catch (error) { unlock(); saving = false; button.disabled = false; showAlert(error.message, form); }
  });
}

async function viewLedgers(token, id) {
  const { company, usedLedgerIds } = await api(`/api/companies/${encodeURIComponent(id)}/masters`);
  const usedLedgers = new Set(usedLedgerIds);
  if (!still(token)) return;
  document.title = `Ledgers · ${company.name}`;
  const groups = company.groups.map((group) => `<option value="${esc(group.id)}">${esc(groupPath(company, group.id))}</option>`).join("");
  /* Credit terms belong to sundry debtors and creditors; MSME status only to creditors. */
  const partyKind = (groupId) => ({ creditor: underGroup(company, groupId, "g-creditors"), debtor: underGroup(company, groupId, "g-debtors") });
  const termsText = (ledger) => {
    const kind = partyKind(ledger.groupId);
    if (!kind.creditor && !kind.debtor) return "";
    const parts = [];
    if (Number.isInteger(ledger.creditDays)) parts.push(`${ledger.creditDays} credit ${ledger.creditDays === 1 ? "day" : "days"}`);
    if (kind.creditor && ledger.msme === true) parts.push("MSME");
    return parts.join(", ");
  };
  const rows = company.ledgers.slice().sort((a, b) => a.name.localeCompare(b.name)).map((ledger) => `<tr data-ledger-row data-search="${esc(`${ledger.name} ${groupPath(company, ledger.groupId)} ${termsText(ledger)}`.toLowerCase())}">
    <th scope="row"><a href="#/c/${esc(id)}/ledger/${esc(ledger.id)}">${esc(ledger.name)}</a>${termsText(ledger) ? `<div class="quiet">${esc(termsText(ledger))}</div>` : ""}</th><td>${esc(groupPath(company, ledger.groupId))}</td>
    <td class="figure">${ledger.opening.paise ? `${esc(formatINR(ledger.opening.paise))}<span class="dc">${esc(ledger.opening.dc)}</span>` : "—"}</td>
    <td><button class="ghost" data-edit-ledger="${esc(ledger.id)}">Edit</button></td></tr>`).join("");
  root.innerHTML = page({ company, folio: "Ld", kicker: "Masters", title: "Ledgers",
    lede: "Open a ledger to review its entries, or edit its name, group and opening.",
    body: `<div class="period ledger-tools"><label>Find a ledger <input type="search" id="ledger-search" placeholder="Name or group" /></label><button type="button" class="ghost" data-export-csv>Download CSV</button></div>
      <table><thead><tr><th>Ledger</th><th>Group path</th><th class="figure">Opening</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <form class="foot-form" id="ledger-form"><h2>Add a ledger</h2>
        <label>Name <input name="name" required minlength="2" maxlength="80" /></label>
        <label>Group <select name="groupId">${groups}</select></label>
        <label>Opening balance <input name="opening" inputmode="decimal" value="0.00" /></label>
        <label>Side <select name="openingDc"><option value="Dr">Debit</option><option value="Cr">Credit</option></select></label>
        <label data-credit-days hidden>Credit days <input name="creditDays" type="number" min="0" max="3650" step="1" inputmode="numeric" placeholder="0" aria-describedby="credit-days-note" /></label>
        <p class="field-note" id="credit-days-note" data-credit-days hidden>Statements and ageing add these days to each bill date to find when it falls due. Leave blank for payment on the bill date.</p>
        <label class="check" data-msme-field hidden><input type="checkbox" name="msme" /><span>Registered MSME supplier (45-day payment rule)<small>Bills unpaid more than 45 days after their date are flagged, because Section 43B(h) of the Income-tax Act allows them as an expense only in the year they are paid.</small></span></label>
        <label data-opening-reason hidden>Reason for correcting the opening balance <textarea name="reason" maxlength="240" rows="2" placeholder="For example: audited opening balance for FY 2026-27 received from the CA"></textarea><small class="field-note" id="opening-note">Vouchers already use this ledger. A correction needs a reason of 10 to 240 characters and is written to the edit log.</small></label>
        <div class="actions"><button type="submit">Add the ledger</button><button type="button" class="ghost" id="ledger-cancel" hidden>Cancel edit</button><button type="button" class="danger" id="ledger-remove" hidden>Remove ledger</button></div>
      </form>` });
  const form = document.querySelector("#ledger-form");
  let editing = null;
  let saving = false;
  form.addEventListener("input", () => { form.dataset.dirty = "1"; });
  form.addEventListener("change", () => { form.dataset.dirty = "1"; });
  const discardChanges = () => form.dataset.dirty !== "1" || confirm("Discard the changes in this form?");
  const showTerms = () => {
    const kind = partyKind(form.elements.groupId.value);
    for (const field of form.querySelectorAll("[data-credit-days]")) field.hidden = !(kind.creditor || kind.debtor);
    form.querySelector("[data-msme-field]").hidden = !kind.creditor;
    return kind;
  };
  form.elements.groupId.addEventListener("change", showTerms);
  showTerms();
  document.querySelector("#ledger-search").addEventListener("input", (event) => {
    const query = event.target.value.toLowerCase().trim();
    for (const row of document.querySelectorAll("[data-ledger-row]")) row.hidden = !row.dataset.search.includes(query);
  });
  for (const button of document.querySelectorAll("[data-edit-ledger]")) button.addEventListener("click", () => {
    if (saving || !discardChanges()) return;
    form.dataset.dirty = "";
    editing = company.ledgers.find((ledger) => ledger.id === button.dataset.editLedger);
    const used = usedLedgers.has(editing.id);
    form.elements.name.value = editing.name;
    form.elements.groupId.value = editing.groupId;
    form.elements.opening.value = formatINR(editing.opening.paise);
    form.elements.openingDc.value = editing.opening.dc;
    form.elements.creditDays.value = Number.isInteger(editing.creditDays) ? String(editing.creditDays) : "";
    form.elements.msme.checked = editing.msme === true;
    showTerms();
    form.elements.reason.value = "";
    form.querySelector("[data-opening-reason]").hidden = !used;
    form.querySelector("h2").textContent = "Edit ledger";
    form.querySelector("[type=submit]").textContent = "Save ledger";
    document.querySelector("#ledger-cancel").hidden = false;
    document.querySelector("#ledger-remove").hidden = false;
    form.elements.name.focus();
  });
  document.querySelector("#ledger-cancel").addEventListener("click", () => { if (!saving && discardChanges()) render(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    const button = form.querySelector("[type=submit]");
    button.disabled = true;
    const kind = showTerms();
    const days = form.elements.creditDays.value.trim();
    const terms = { creditDays: (kind.creditor || kind.debtor) && days !== "" ? Number(days) : null, msme: kind.creditor ? form.elements.msme.checked : false };
    const unlock = lockEntryForm(form);
    try {
      await api(`/api/companies/${encodeURIComponent(id)}/ledgers${editing ? `/${encodeURIComponent(editing.id)}` : ""}`, {
        method: editing ? "PUT" : "POST", body: { name: form.elements.name.value, groupId: form.elements.groupId.value, openingPaise: parseRupees(form.elements.opening.value), openingDc: form.elements.openingDc.value, ...terms, ...(editing && form.elements.reason.value.trim() ? { reason: form.elements.reason.value.trim() } : {}), expected: editing ? { name: editing.name, groupId: editing.groupId, opening: editing.opening } : undefined },
      });
      render();
    } catch (error) { unlock(); saving = false; button.disabled = false; showAlert(error.message, form); }
  });
  document.querySelector("#ledger-remove").addEventListener("click", async (event) => {
    if (saving || !editing || !confirm(`Remove ledger “${editing.name}”?`)) return;
    saving = true;
    const button = event.currentTarget;
    button.disabled = true;
    const unlock = lockEntryForm(form);
    try { await api(`/api/companies/${encodeURIComponent(id)}/ledgers/${encodeURIComponent(editing.id)}`, { method: "DELETE", body: { expected: { name: editing.name, groupId: editing.groupId, opening: editing.opening } } }); render(); }
    catch (error) { unlock(); saving = false; button.disabled = false; showAlert(error.message, form); }
  });
}

async function viewVoucher(token, id, type, voucherId) {
  if (!TYPES.includes(type)) throw new Error("That voucher type is not in these books");
  const { company, voucher, nextNumbers } = await api(`/api/companies/${encodeURIComponent(id)}${voucherId ? `/vouchers/${encodeURIComponent(voucherId)}` : "/masters"}`);
  if (!still(token)) return;
  const existing = voucherId ? voucher : null;
  if (existing?.gst) {
    location.replace(`#/c/${encodeURIComponent(id)}/gst-document/${encodeURIComponent(existing.id)}`);
    return;
  }
  if (existing) type = existing.type;
  if (voucherId && !existing) throw new Error("That voucher is not in this company");
  document.title = `${type} · ${company.name}`;
  const dateKey = `financer-voucher-date-${id}-${type}`;
  const duplicateKey = `financer-duplicate-${id}-${type}`;
  let duplicate = null;
  if (!existing) {
    try { duplicate = JSON.parse(sessionStorage.getItem(duplicateKey) || "null"); } catch {}
    sessionStorage.removeItem(duplicateKey);
  }
  const draftKey = `financer-voucher-draft-${id}-${type}`;
  let draft = null;
  if (!existing && !duplicate) {
    try { draft = JSON.parse(sessionStorage.getItem(draftKey) || "null"); } catch { draft = null; }
    if (draft && !(draft.lines?.some(line => line.ledgerId || line.debit || line.credit) || draft.narration)) draft = null;
  }
  const draftSource = draft ? { date: draft.date, number: draft.number, narration: draft.narration, lines: draft.lines.map(line => {
    let paise = 0;
    try { paise = parseRupees(line.debit || line.credit || ""); } catch { paise = 0; }
    return { ledgerId: line.ledgerId, dc: line.debit ? "Dr" : "Cr", paise };
  }) } : null;
  const source = existing || duplicate || draftSource;
  const lines = source?.lines?.length ? source.lines : [{}, {}];
  const selectedDate = source?.date || sessionStorage.getItem(dateKey) || todayISO();
  root.innerHTML = page({ company, folio: MARK[type] || "Vc", kicker: type,
    title: existing ? `Alter ${existing.number}` : type, lede: HINT[type], status: takeFlash() || (draft ? `Your unsaved ${type.toLowerCase()} was restored.` : ""),
    body: `<div class="actions"><a href="#/c/${esc(id)}/daybook?type=${encodeURIComponent(type)}">${esc(type)} register</a>${existing ? `<a href="#/c/${esc(id)}/voucher-print/${esc(existing.id)}">Print voucher</a>` : ""}</div>
    <form id="voucher"><div class="period">
      <label>Date <input type="date" name="date" required min="${esc(company.booksFrom)}" value="${esc(selectedDate)}" /></label>
      <label>Number <input name="number" required maxlength="24" value="${esc(existing?.number || draft?.number || nextNumbers[type])}" /></label></div>
      <table class="voucher-table"><thead><tr><th>Particulars</th><th class="figure">Debit</th><th class="figure">Credit</th></tr></thead>
      <tbody id="lines">${lines.map((line, index) => lineRow(company, line, index)).join("")}</tbody></table>
      <div class="actions add-line"><button type="button" class="ghost" id="line-action"><span>Add line</span> <kbd aria-hidden="true">⌥↩</kbd></button></div>
      <label class="narration">Narration <textarea name="narration" maxlength="280">${esc(source?.narration || "")}</textarea></label>
      <p class="difference" aria-live="polite"></p><div class="actions"><button type="submit" data-pass>${existing ? "Save the voucher" : "Pass voucher"}</button>
      ${existing ? `<button type="button" class="ghost" id="duplicate">Duplicate as new</button><button type="button" class="danger" id="remove">Remove voucher</button>` : ""}</div>
      ${draft ? `<button type="button" class="ghost" id="discard-draft">Discard draft</button>` : ""}</div>
      <p class="quiet">Type a ledger name and press Return to choose it. Return moves to the next field. ⌘ Return passes the voucher. Press ? for every shortcut.</p></form>` });
  const form = document.querySelector("#voucher");
  let saving = false;
  const requestId = crypto.randomUUID();
  const directory = createLedgerDirectory({
    ledgers: company.ledgers.map(ledger => ({ id: ledger.id, name: ledger.name, groupId: ledger.groupId, path: groupPath(company, ledger.groupId) })),
    groups: company.groups.map(group => ({ id: group.id, path: groupPath(company, group.id) })).sort((a, b) => a.path.localeCompare(b.path)),
  });
  const focusAmount = select => {
    const row = select.closest("tr");
    const debit = row?.querySelector("[name=debit]");
    const target = debit && !debit.disabled ? debit : row?.querySelector("[name=credit]");
    target?.focus();
    target?.select();
  };
  const createLedger = async ({ name, groupId }) => {
    const saved = await api(`/api/companies/${encodeURIComponent(id)}/ledgers`, { method: "POST", body: { name, groupId, openingPaise: 0, openingDc: "Dr" } });
    const ledger = saved.company?.ledgers?.find(item => item.name.toLowerCase() === name.trim().toLowerCase());
    if (!ledger) throw new Error("The ledger was saved but could not be found. Reload the voucher to use it.");
    if (!company.ledgers.some(item => item.id === ledger.id)) company.ledgers.push(ledger);
    if (!directory.ledgers.some(item => item.id === ledger.id)) directory.ledgers.push({ id: ledger.id, name: ledger.name, groupId: ledger.groupId, path: groupPath(company, ledger.groupId) });
    for (const select of form.querySelectorAll("select[name=ledger]")) {
      if (![...select.options].some(option => option.value === ledger.id)) select.insertAdjacentHTML("beforeend", `<option value="${esc(ledger.id)}">${esc(ledger.name)}</option>`);
    }
    return ledger;
  };
  const mountPickers = () => {
    for (const select of form.querySelectorAll("select[name=ledger]")) installLedgerPicker(select, { directory, esc, formatINR, createLedger, afterChoose: focusAmount });
  };
  mountPickers();
  const balanceTo = todayISO() < company.booksFrom ? company.booksFrom : todayISO();
  api(`/api/companies/${encodeURIComponent(id)}/reports/trial-balance?from=${encodeURIComponent(company.booksFrom)}&to=${encodeURIComponent(balanceTo)}`)
    .then(report => { if (!still(token)) return; directory.balances = balancesFromTrial(report); notifyDirectory(directory); })
    .catch(() => { /* Balances are a convenience; the picker works without them. */ });
  bindDifference(form);
  const rememberDraft = () => {
    if (existing) return;
    const snapshot = { date: form.elements.date.value, number: form.elements.number.value, narration: form.elements.narration.value,
      lines: [...form.querySelectorAll("#lines tr")].map(tr => ({ ledgerId: tr.querySelector("[name=ledger]").value, debit: tr.querySelector("[name=debit]").value, credit: tr.querySelector("[name=credit]").value })) };
    try { sessionStorage.setItem(draftKey, JSON.stringify(snapshot)); } catch { /* storage full or unavailable */ }
  };
  form.addEventListener("input", rememberDraft);
  form.addEventListener("change", rememberDraft);
  /* The suggested number depends on the date when a series restarts each financial year. Follow the date while the number is still the suggestion. */
  let suggestedNumber = existing ? null : nextNumbers[type];
  let numberTicket = 0;
  const followDate = async () => {
    const date = form.elements.date.value;
    if (suggestedNumber === null || form.elements.number.value !== suggestedNumber || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const ticket = ++numberTicket;
    try {
      const { preview } = await api(`/api/companies/${encodeURIComponent(id)}/numbering?date=${encodeURIComponent(date)}`);
      if (!still(token) || ticket !== numberTicket || form.elements.number.value !== suggestedNumber || !preview?.[type]) return;
      form.elements.number.value = preview[type];
      suggestedNumber = preview[type];
      rememberDraft();
    } catch { /* Keep the current suggestion; the server still checks the number when the voucher is passed. */ }
  };
  form.elements.date.addEventListener("change", followDate);
  if (!existing && selectedDate !== todayISO()) followDate();
  document.querySelector("#discard-draft")?.addEventListener("click", () => { sessionStorage.removeItem(draftKey); render(); });
  const lineAction = () => {
    if (saving || form.querySelector("#line-action").disabled) return;
    const body = form.querySelector("#lines");
    const { index, side, paise } = voucherLineAction(form);
    if (index === body.rows.length) { body.insertAdjacentHTML("beforeend", lineRow(company, {}, index)); mountPickers(); }
    const row = body.rows[index];
    if (side) row.querySelector(`[name=${side}]`).value = formatINR(paise);
    bindDifference(form);
    const ledger = row.querySelector("select[name=ledger]");
    if (side && ledger.value) row.querySelector(`[name=${side}]`).select();
    else ledgerControl(row).focus();
  };
  form.querySelector("#line-action").addEventListener("click", lineAction);
  form.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      if (!saving && !form.querySelector("[data-pass]").disabled) form.requestSubmit();
    } else if (event.altKey) { event.preventDefault(); lineAction(); }
    else if (event.target.matches("input, select")) {
      event.preventDefault();
      const row = event.target.closest("#lines tr");
      const lastRow = row && row === form.querySelector("#lines tr:last-child");
      const lastField = lastRow && event.target.name === "credit";
      if (lastField && !form.querySelector("#line-action").disabled) lineAction();
      else if (!focusNext(form, event.target)) form.elements.narration.focus();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    form.querySelector("[data-pass]").disabled = true;
    let unlock = () => {};
    try {
      const data = new FormData(form);
      const payload = { type, date: data.get("date"), number: data.get("number"), narration: data.get("narration"), lines: collectLines(form), requestId: existing ? undefined : requestId, expected: existing ? { type: existing.type, date: existing.date, number: existing.number, narration: existing.narration, lines: existing.lines } : undefined };
      const path = `/api/companies/${encodeURIComponent(id)}/vouchers${existing ? `/${encodeURIComponent(existing.id)}` : ""}`;
      unlock = lockEntryForm(form);
      const saved = await api(path, { method: existing ? "PUT" : "POST", body: payload });
      sessionStorage.removeItem(draftKey);
      sessionStorage.setItem(dateKey, saved.voucher.date);
      sessionStorage.setItem("financer-flash", `${saved.voucher.number} ${existing ? "saved" : "passed"}.`);
      const next = `#/c/${id}/v/${encodeURIComponent(type)}`;
      if (location.hash === next) render(); else location.hash = next;
    } catch (error) { unlock(); saving = false; showAlert(error.message, form); bindDifference(form); }
  });
  document.querySelector("#duplicate")?.addEventListener("click", () => {
    sessionStorage.setItem(duplicateKey, JSON.stringify(existing));
    location.hash = `#/c/${id}/v/${encodeURIComponent(type)}`;
  });
  document.querySelector("#remove")?.addEventListener("click", async (event) => {
    if (!confirm(`Remove voucher ${existing.number}?`)) return;
    const button = event.currentTarget;
    button.disabled = true;
    try { await api(`/api/companies/${encodeURIComponent(id)}/vouchers/${encodeURIComponent(existing.id)}`, { method: "DELETE", body: { expected: { type: existing.type, date: existing.date, number: existing.number, narration: existing.narration, lines: existing.lines } } }); location.hash = `#/c/${id}/daybook`; }
    catch (error) { button.disabled = false; showAlert(error.message, form); }
  });
  if (!existing) { const first = form.querySelector("#lines tr"); if (first) ledgerControl(first).focus(); }
}

async function viewDaybook(token, id) {
  const bundle = await api(`/api/companies/${encodeURIComponent(id)}/meta`);
  if (!still(token)) return;
  const range = readPeriod(bundle.company);
  const report = await api(`/api/companies/${encodeURIComponent(id)}/reports/daybook?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`);
  if (!still(token)) return;
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const selectedType = TYPES.includes(params.get("type")) ? params.get("type") : "";
  const entries = report.rows.map(row => ({ row, search: `${row.number} ${row.particulars} ${row.narration || ""}`.toLowerCase() }));
  const rowHtml = ({ row }) => {
    const narration = row.narration || "";
    return `<tr data-book-row data-type="${esc(row.type)}">
      <td class="date-cell">${esc(dateLabel(row.date))}</td><td><a class="voucher-ref" href="#/c/${esc(id)}/v/${encodeURIComponent(row.type)}/${encodeURIComponent(row.id)}">${esc(row.number)}</a></td><td>${esc(row.type)}</td>
      <td>${esc(row.particulars)}${narration ? `<div class="quiet">${esc(narration)}</div>` : ""}</td><td class="figure">${esc(formatINR(row.paise))}</td></tr>`;
  };
  document.title = `Day book · ${bundle.company.name}`;
  root.innerHTML = page({ company: bundle.company, folio: "Db", kicker: "Day book", title: "Day book",
    body: `${periodBar(range)}<div class="period"><label>Voucher type <select id="daybook-type"><option value="">All types</option>${TYPES.map((type) => `<option${type === selectedType ? " selected" : ""}>${esc(type)}</option>`).join("")}</select></label>
      <label>Search <input type="search" id="daybook-search" placeholder="Narration, ledger or voucher number" /></label></div>
      <table><thead><tr><th>Date</th><th>No.</th><th>Type</th><th>Particulars</th><th class="figure">Amount</th></tr></thead><tbody></tbody><tfoot><tr class="total"><th colspan="4" id="daybook-count"></th><td class="figure" id="daybook-total"></td></tr></tfoot></table>${moreRows()}` });
  bindPeriod(bundle.company);
  const empty = `<tr id="daybook-empty" data-export-skip><td colspan="5" class="quiet">No vouchers match this period and search.</td></tr>`;
  const table = root.querySelector("#sheet table");
  const pager = pagedTable({ table, rows: entries, rowHtml, prefix: shown => shown.length ? "" : empty });
  /* Count and total cover every matching voucher, not only the rows on screen. */
  const filter = () => {
    const type = document.querySelector("#daybook-type").value;
    const query = document.querySelector("#daybook-search").value.toLowerCase().trim();
    const matching = entries.filter(entry => (!type || entry.row.type === type) && entry.search.includes(query));
    const total = matching.reduce((sum, entry) => sum + entry.row.paise, 0);
    document.querySelector("#daybook-count").textContent = `${matching.length.toLocaleString("en-IN")} voucher${matching.length === 1 ? "" : "s"}`;
    document.querySelector("#daybook-total").textContent = formatINR(total);
    pager.update(matching);
  };
  document.querySelector("#daybook-type").addEventListener("change", filter);
  document.querySelector("#daybook-search").addEventListener("input", filter);
  filter();
}

async function viewLedger(token, id, ledgerId) {
  const bundle = await api(`/api/companies/${encodeURIComponent(id)}/meta`);
  if (!still(token)) return;
  const range = readPeriod(bundle.company);
  const report = await api(
    `/api/companies/${encodeURIComponent(id)}/reports/ledger/${encodeURIComponent(ledgerId)}?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
  );
  if (!still(token)) return;
  /* Sundry debtors and creditors, including ledgers in groups beneath them, also have a statement of account. */
  let partyLedger = PARTY_GROUPS.includes(report.ledger.groupId);
  if (!partyLedger && report.ledger.groupId && !NON_PARTY_GROUPS.has(report.ledger.groupId)) {
    try {
      const { company } = await api(`/api/companies/${encodeURIComponent(id)}/masters`);
      partyLedger = PARTY_GROUPS.some((groupId) => underGroup(company, report.ledger.groupId, groupId));
    } catch { /* The statement link is a convenience; the ledger report stands without it. */ }
    if (!still(token)) return;
  }
  document.title = `${report.ledger.name} · ${bundle.company.name}`;
  const opening = `<tr><th scope="row">Opening</th><td></td><td></td>${figure(report.opening.dc === "Dr" ? report.opening.paise : 0)}${figure(report.opening.dc === "Cr" ? report.opening.paise : 0)}<td class="figure">${esc(formatINR(report.opening.paise))}<span class="dc">${esc(report.opening.dc)}</span></td></tr>`;
  const lineHtml = (line) => `<tr>
        <td class="date-cell">${esc(dateLabel(line.date))}</td>
        <td><a href="#/c/${esc(id)}/v/${encodeURIComponent(line.type)}/${encodeURIComponent(line.voucherId)}">${esc(line.number)}</a></td>
        <td>${esc(line.contra)}${line.narration ? `<div class="quiet">${esc(line.narration)}</div>` : ""}</td>
        ${figure(line.dc === "Dr" ? line.paise : 0)}
        ${figure(line.dc === "Cr" ? line.paise : 0)}
        <td class="figure">${esc(formatINR(line.balance.paise))}<span class="dc">${esc(line.balance.dc)}</span></td>
      </tr>`;
  root.innerHTML = page({
    company: bundle.company,
    folio: "Ac",
    kicker: "Ledger",
    title: report.ledger.name,
    body: `${partyLedger ? `<div class="actions"><a href="#/c/${esc(id)}/parties/${esc(encodeURIComponent(ledgerId))}">Party statement</a></div>` : ""}${periodBar(range)}
      <table>
        <thead><tr><th>Date</th><th>No.</th><th>Particulars</th><th class="figure">Debit</th><th class="figure">Credit</th><th class="figure">Balance</th></tr></thead>
        <tbody></tbody>
        <tfoot><tr class="total"><th colspan="3">Closing</th><td></td><td></td><td class="figure">${esc(formatINR(report.closing.paise))}<span class="dc">${esc(report.closing.dc)}</span></td></tr></tfoot>
      </table>${moreRows()}`,
  });
  bindPeriod(bundle.company);
  pagedTable({ table: root.querySelector("#sheet table"), rows: report.lines, rowHtml: lineHtml, prefix: () => opening });
}

async function viewTrial(token, id) {
  const bundle = await api(`/api/companies/${encodeURIComponent(id)}/meta`);
  if (!still(token)) return;
  const range = readPeriod(bundle.company);
  const report = await api(
    `/api/companies/${encodeURIComponent(id)}/reports/trial-balance?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
  );
  if (!still(token)) return;
  document.title = `Trial balance · ${bundle.company.name}`;
  const rowHtml = (row, index, rows) => {
    const header = index > 0 && rows[index - 1].groupName === row.groupName ? "" : `<tr class="group"><th colspan="5">${esc(row.groupName)}</th></tr>`;
      return `${header}<tr>
        <th scope="row"><a href="#/c/${esc(id)}/ledger/${esc(row.ledgerId)}">${esc(row.name)}</a></th>
        <td class="figure">${row.opening.paise ? `${esc(formatINR(row.opening.paise))}<span class="dc">${esc(row.opening.dc)}</span>` : "\u2014"}</td>
        <td class="figure">${row.periodDr ? esc(formatINR(row.periodDr)) : "\u2014"}</td>
        <td class="figure">${row.periodCr ? esc(formatINR(row.periodCr)) : "\u2014"}</td>
        <td class="figure">${esc(formatINR(row.closing.paise))}<span class="dc">${esc(row.closing.dc)}</span></td>
      </tr>`;
  };
  const periodDebit = report.rows.reduce((sum, row) => sum + row.periodDr, 0);
  const periodCredit = report.rows.reduce((sum, row) => sum + row.periodCr, 0);
  const difference =
    report.difference === 0 || report.difference === null
      ? ""
      : `<tr><th colspan="4">Difference in books</th><td class="figure">${esc(formatINR(Math.abs(report.difference)))}<span class="dc">${report.difference > 0 ? "Dr" : "Cr"}</span></td></tr>`;
  root.innerHTML = page({
    company: bundle.company,
    folio: "Tb",
    kicker: "Trial",
    title: "Trial balance",
    lede: "Opening is everything before the period. The last column is the position at the end of it.",
    body: `${periodBar(range)}
      <table>
        <thead><tr><th>Ledger</th><th class="figure">Opening</th><th class="figure">Debit</th><th class="figure">Credit</th><th class="figure">Closing</th></tr></thead>
        <tbody></tbody>
        <tfoot><tr class="total"><th colspan="2">Totals</th><td class="figure">${esc(formatINR(periodDebit))}</td><td class="figure">${esc(formatINR(periodCredit))}</td><td class="figure">${esc(formatINR(report.debit))}<span class="dc">Dr</span> = ${esc(formatINR(report.credit))}<span class="dc">Cr</span></td></tr></tfoot>
      </table>${moreRows()}`,
  });
  bindPeriod(bundle.company);
  /* Totals in the footer stay totals of every ledger; only the rows on screen are paged. */
  pagedTable({ table: root.querySelector("#sheet table"), rows: report.rows, rowHtml, suffix: difference,
    prefix: shown => shown.length ? "" : `<tr><td colspan="5" class="quiet">No balances in this period.</td></tr>` });
}

function labeledLines(label, lines, id) {
  if (!lines.length) return "";
  return `<h3>${esc(label)}</h3>${statementLines(lines, id)}`;
}

function statementLines(lines, id) {
  if (!lines.length) return "";
  return lines
    .map((line) => {
      const amount = line.nature === "Income" ? line.signed : -line.signed;
      const odd = amount < 0;
      return `<div class="stmt-line"><a href="#/c/${esc(id)}/ledger/${esc(line.ledgerId)}">${esc(line.name)}</a><span class="figure">${esc(formatINR(Math.abs(amount)))}${odd ? `<span class="dc">${line.nature === "Income" ? "Dr" : "Cr"}</span>` : ""}</span></div>`;
    })
    .join("");
}

function inventoryStatement(report,id) {
  const stock = report.inventory;
  if (!stock) return "";
  const link = `#/c/${encodeURIComponent(id)}/stock?from=${encodeURIComponent(report.from || "")}&to=${encodeURIComponent(report.to)}`;
  if (!stock.complete) return `<p class="alert">${esc(stock.reason)} <a href="${link}">Review stock register</a></p>`;
  const entries = [["Opening stock",stock.openingValuePaise],["Closing stock",stock.closingValuePaise]];
  if (stock.ledgerChangePaise) entries.push(["Movement already in Stock-in-Hand ledgers",stock.ledgerChangePaise]);
  return `<h3><a href="${link}">Stock register</a></h3>${entries.map(([name,value])=>`<div class="stmt-line"><span>${name}</span><span class="figure">${esc(formatINR(value))}</span></div>`).join("")}`;
}
const statementTotal = value => value === null ? "Valuation pending" : esc(formatINR(value));
async function viewProfit(token, id) {
  const bundle = await api(`/api/companies/${encodeURIComponent(id)}/meta`);
  if (!still(token)) return;
  const range = readPeriod(bundle.company);
  const report = await api(
    `/api/companies/${encodeURIComponent(id)}/reports/profit-loss?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
  );
  if (!still(token)) return;
  document.title = `Profit & loss · ${bundle.company.name}`;
  const grossIncome = report.lines.filter((line) => line.gross && line.nature === "Income");
  const grossExpense = report.lines.filter((line) => line.gross && line.nature === "Expense");
  const otherIncome = report.lines.filter((line) => !line.gross && line.nature === "Income");
  const otherExpense = report.lines.filter((line) => !line.gross && line.nature === "Expense");
  const grossLabel = report.grossProfit >= 0 ? "Gross profit" : "Gross loss";
  const netLabel = report.netProfit >= 0 ? "Net profit" : "Net loss";
  root.innerHTML = page({
    company: bundle.company,
    folio: "Pl",
    kicker: "Account",
    title: "Profit & loss",
    lede: "Movement for the period. Opening balances of income and expense ledgers count only when the period starts at the books beginning, so the statement agrees with the balance sheet.",
    body: `${periodBar(range)}
      <section class="stmt"><h2>Trading account</h2>${labeledLines("Income", grossIncome, id)}${labeledLines("Expenses", grossExpense, id)}${inventoryStatement(report,id)}
        <div class="stmt-total"><span>${grossLabel}</span><span class="figure">${statementTotal(report.grossProfit === null ? null : Math.abs(report.grossProfit))}</span></div>
      </section>
      <section class="stmt"><h2>Profit & loss account</h2>${labeledLines("Income", otherIncome, id)}${labeledLines("Expenses", otherExpense, id)}
        <div class="stmt-total"><span>${netLabel}</span><span class="figure">${statementTotal(report.netProfit === null ? null : Math.abs(report.netProfit))}</span></div>
      </section>`,
  });
  bindPeriod(bundle.company);
}

function sideGroups(groups, id, to) {
  if (!groups.length) return `<p class="quiet">None.</p>`;
  return groups
    .map(
      (group) => `<h2>${esc(group.groupName)}</h2>${group.ledgers
        .map(
          (ledger) => `<div class="stmt-line"><a href="#/c/${esc(id)}/${ledger.stockRegister ? "stock?to="+esc(to) : "ledger/"+esc(ledger.ledgerId)}">${esc(ledger.name)}</a><span class="figure">${esc(formatINR(ledger.paise))}</span></div>`,
        )
        .join("")}`,
    )
    .join("");
}

async function viewBalance(token, id) {
  const bundle = await api(`/api/companies/${encodeURIComponent(id)}/meta`);
  if (!still(token)) return;
  const range = readPeriod(bundle.company);
  const report = await api(
    `/api/companies/${encodeURIComponent(id)}/reports/balance-sheet?to=${encodeURIComponent(range.to)}`,
  );
  if (!still(token)) return;
  document.title = `Balance sheet · ${bundle.company.name}`;
  const profit =
    report.profit === 0 || report.profit === null
      ? ""
      : `<div class="stmt-line"><span>${report.profit > 0 ? "Profit & loss A/c" : ""}</span><span class="figure">${report.profit > 0 ? esc(formatINR(report.profit)) : ""}</span></div>`;
  const loss =
    report.profit < 0
      ? `<div class="stmt-line"><span>Profit & loss A/c</span><span class="figure">${esc(formatINR(-report.profit))}</span></div>`
      : "";
  const gap =
    report.difference === 0 || report.difference === null
      ? ""
      : `<p class="alert" role="alert">The two sides differ by ${esc(formatINR(Math.abs(report.difference)))}. Check opening balances.</p>`;
  root.innerHTML = page({
    company: bundle.company,
    folio: "Bs",
    kicker: "Sheet",
    title: "Balance sheet",
    lede: `Position as on ${dateLabel(range.to)}. Profit here is this financial year's; earlier years sit in the brought-forward row under Capital.`,
    body: `${periodBar(range)}${gap}${report.inventory && !report.inventory.complete ? inventoryStatement(report,id) : ""}
      <div class="two">
        <section class="stmt"><h2>Liabilities</h2>${sideGroups(report.liabilityGroups,id,range.to)}${profit}
          <div class="stmt-total"><span>Total</span><span class="figure">${statementTotal(report.liabilityTotal)}</span></div>
        </section>
        <section class="stmt"><h2>Assets</h2>${sideGroups(report.assetGroups,id,range.to)}${loss}
          <div class="stmt-total"><span>Total</span><span class="figure">${statementTotal(report.assetTotal)}</span></div>
        </section>
      </div>`,
  });
  bindPeriod(bundle.company);
}

let lastRenderedHash = null;
const live = document.createElement("div");
live.className = "sr";
live.setAttribute("aria-live", "polite");
document.body.append(live);

function afterRender(token) {
  if (!still(token)) return;
  const moved = location.hash !== lastRenderedHash;
  lastRenderedHash = location.hash;
  const active = document.activeElement;
  if (moved && (!active || active === document.body || !root.contains(active))) root.querySelector("h1")?.focus({ preventScroll: true });
  const status = root.querySelector(".status, [data-page-error]");
  live.textContent = status ? status.textContent : "";
}

async function render() {
  const token = ++renderToken;
  expandForPrint = null;
  try {
    await renderRoute(token);
  } finally {
    afterRender(token);
  }
}

async function renderRoute(token) {
  const route = parseRoute();
  try {
    if (route.id && route.id !== rememberedCompany) {
      rememberedCompany = route.id;
      api("/api/workstation", { method: "PUT", body: { lastCompany: route.id } }).catch(() => { rememberedCompany = null; });
    }
    const ui = { root, api, still, page, esc, readPeriod, periodBar, bindPeriod, formatINR, todayISO };
    if (route.name === "bank-reconciliation" || route.name === "bill-outstanding") {
      const { viewReconciliation } = await import("/reconciliation-ui.js");
      return await viewReconciliation(route, token, ui);
    }
    if (route.name === "gst-exchange") {
      const { viewGstExchange } = await import("/gst-exchange.js");
      return await viewGstExchange(route, token, ui);
    }
    if (route.name === "gst-amendments") {
      const { viewGstAmendments } = await import("/gst-amendment-ui.js");
      return await viewGstAmendments(route, token, ui);
    }
    if (route.name === "gst-itc") {
      const { viewPurchaseItc } = await import("/gst-itc-ui.js");
      return await viewPurchaseItc(route,token,ui);
    }
    if (route.name === "stock" || route.name === "stock-item") {
      const { viewStock } = await import("/stock-ui.js");
      return await viewStock(route,token,ui);
    }
    if (route.name === "gst-rcm" || route.name === "gst-rcm-document") {
      const { viewRcm } = await import("/gst-rcm-ui.js");
      return await viewRcm(route, token, ui);
    }
    if (route.name === "gst-returns") {
      const { viewReturns } = await import("/gst-returns-ui.js");
      return await viewReturns(route, token, ui);
    }
    if (route.name.startsWith("gst")) {
      const { viewGst } = await import("/gst-ui.js");
      if (await viewGst(route, token, ui)) return;
    }
    if (route.name === "settings") {
      const { viewSettings } = await import("/settings-ui.js");
      return await viewSettings(route, token, ui);
    }
    if (route.name === "audit") {
      const { viewAudit } = await import("/audit-ui.js");
      return await viewAudit(route, token, ui);
    }
    if (route.name === "parties") {
      const { viewParties } = await import("/party-ui.js");
      return await viewParties(route, token, ui);
    }
    if (route.name === "tally-import" || route.name === "tally-source") {
      const { viewTally } = await import("/tally-tools.js");
      return await viewTally(route, token, ui);
    }
    if (await viewBookTool(route, token, { root, api, still, page, esc, readPeriod, periodBar, bindPeriod, formatINR })) return;
    if (route.name === "index") return await viewIndex(token);
    if (route.name === "home") return await viewHome(token, route.id);
    if (route.name === "groups") return await viewGroups(token, route.id);
    if (route.name === "ledgers") return await viewLedgers(token, route.id);
    if (route.name === "voucher") return await viewVoucher(token, route.id, route.type, route.voucherId);
    if (route.name === "daybook") return await viewDaybook(token, route.id);
    if (route.name === "ledger") return await viewLedger(token, route.id, route.ledgerId);
    if (route.name === "tb") return await viewTrial(token, route.id);
    if (route.name === "pl") return await viewProfit(token, route.id);
    if (route.name === "bs") return await viewBalance(token, route.id);
    location.hash = `#/c/${route.id || ""}`;
  } catch (error) {
    if (!still(token)) return;
    document.title = "Ledgercraft";
    root.innerHTML = page({
      company: null,
      title: "The book did not open",
      error: error.message,
      body: `<div class="actions"><button type="button" data-retry>Try again</button><a href="#/">Back to the companies</a></div>`,
    });
  }
}

let rememberedCompany = null;
document.addEventListener("click", event => {
  if (event.target.closest("[data-print-sheet]")) window.print();
  if (event.target.closest("[data-export-csv]")) exportSheet();
  if (event.target.closest("[data-retry]")) render();
  if (event.target.closest(".skip")) { event.preventDefault(); document.querySelector("#sheet")?.focus(); }
  if (event.target.closest("[data-focus-period]")) { event.preventDefault(); document.querySelector("#period-control [name=from]")?.focus(); }
  const toggle = event.target.closest("[data-theme-toggle]");
  if (toggle) {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("ledgercraft-theme", next); } catch { /* private mode */ }
    document.documentElement.dataset.theme = next;
    toggle.textContent = themeLabel();
  }
});
document.addEventListener("change", event => {
  const form = event.target.closest("#period-control");
  if (!form) return;
  let from = form.elements.from.value;
  let to = form.elements.to.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return;
  if (from < form.dataset.booksFrom) from = form.dataset.booksFrom;
  if (to < from) [from, to] = [to, from];
  savePeriod(form.dataset.company, from, to);
  render();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", event => {
  let stored = null;
  try { stored = localStorage.getItem("ledgercraft-theme"); } catch { /* private mode */ }
  if (stored) return;
  document.documentElement.dataset.theme = event.matches ? "dark" : "light";
  document.querySelector("[data-theme-toggle]")?.replaceChildren(themeLabel());
});
window.addEventListener("financer-new-voucher", () => {
  const route = parseRoute(); if (route.id) location.hash = "#/c/" + encodeURIComponent(route.id) + "/v/Receipt";
});
installFinder({ api, esc, parseRoute, routes: finderRoutes });
shortcuts = installShortcuts({ esc, parseRoute });
window.addEventListener("beforeprint", () => expandForPrint?.());

function exportSheet() {
  const sheet = document.querySelector("#sheet");
  const model = sheetModel(sheet);
  if (!model || !model.rows.length) { showAlert("This page has no rows to download. Change the period or the search, then try again."); return; }
  const period = document.querySelector("#period-control");
  downloadCsv(csvFileName({
    company: document.querySelector(".company-switch strong")?.textContent || "ledgercraft",
    title: sheet.querySelector(".sheet-head h1")?.textContent || "",
    from: period?.elements.from.value || "",
    to: period?.elements.to.value || "",
  }), toCsv(model));
}
window.addEventListener("hashchange", render);
async function openDesk() {
  if (location.search.includes("token=")) history.replaceState(null, "", location.pathname + location.hash);
  if (!location.hash) {
    try {
      const [settings, { companies }] = await Promise.all([api("/api/workstation"), api("/api/companies")]);
      const id = settings.loadLastCompany ? settings.lastCompany || settings.defaultCompany : settings.defaultCompany;
      if (!location.hash && id && companies.some(c => c.id === id)) {
        rememberedCompany = settings.lastCompany;
        history.replaceState(null, "", "#/c/" + encodeURIComponent(id));
      }
    } catch { /* The normal render path displays any startup failure. */ }
  }
  render();
}
openDesk();
