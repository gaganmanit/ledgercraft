import { formatINR, parseRupees } from "/money.js";

const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.split("-").reverse().join("-") : value || "—";
const rupees = value => (value / 100).toFixed(2);
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const pad = value => String(value).padStart(2, "0");
const stampLabel = at => { const when = new Date(at); return Number.isNaN(when.getTime()) ? String(at || "") : `${pad(when.getDate())}-${pad(when.getMonth() + 1)}-${when.getFullYear()} ${pad(when.getHours())}:${pad(when.getMinutes())}`; };
function signedRupees(value) {
  const input = String(value || "").trim();
  return (input.startsWith("-") ? -1 : 1) * parseRupees(input.replace(/^[+-]/, ""));
}

export async function viewReconciliation(route, token, ui) {
  if (!["bank-reconciliation", "bill-outstanding"].includes(route.name)) return false;
  if (!route.id) throw new Error("Open a company to reconcile its books");
  const base = `/api/companies/${encodeURIComponent(route.id)}/reconciliation`;
  const book = `#/c/${encodeURIComponent(route.id)}`;
  const { root, api, still, page, esc } = ui;
  const flashKey = `financer-reconciliation-flash:${route.id}`;
  const money = value => esc(formatINR(value));
  const postingLink = row => !row?.voucherId ? "Opening balance" : `<a class="code" href="${book}/${row.gstId ? `gst-document/${esc(row.gstId)}` : `v/${encodeURIComponent(row.type)}/${esc(row.voucherId)}`}">${esc(row.number)}</a>`;
  const render = (company, title, body, folio) => {
    const status = sessionStorage.getItem(flashKey) || "";
    sessionStorage.removeItem(flashKey);
    document.title = `${title} · ${company.name}`;
    root.innerHTML = page({ company, title, kicker: "Reconciliation", folio, status, body: `<div class="reconciliation-workspace">${body}</div>` });
  };
  const errorAt = (target, error) => { target.classList.add("form-message", "alert"); target.textContent = error.message; target.scrollIntoView({ block: "nearest" }); };
  const refresh = async () => { if (still(token)) await viewReconciliation(route, token, ui); };
  const save = async (action, input, target, status, revision) => {
    if (target.dataset.busy === "true") return null;
    target.dataset.busy = "true";
    target.dataset.requestId ||= crypto.randomUUID();
    const controls = target.matches("button") ? [target] : [...target.querySelectorAll("button")];
    for (const button of controls) button.disabled = true;
    try {
      const result = await api(`${base}/${action}`, { method: "POST", body: { ...input, revision, requestId: target.dataset.requestId } });
      if (!still(token)) return null;
      sessionStorage.setItem(flashKey, status);
      return result;
    } finally {
      target.dataset.busy = "false";
      for (const button of controls) button.disabled = false;
    }
  };
  const shared = { ...ui, base, book, token, route, money, postingLink, render, errorAt, refresh, save };
  if (route.name === "bank-reconciliation") await bankWorkspace(shared);
  else await billWorkspace(shared);
  return true;
}

async function bankWorkspace(ctx) {
  const { root, api, still, token, route, base, book, esc, render, readPeriod } = ctx;
  const report = await api(`${base}/bank${route.detail ? `?statementId=${encodeURIComponent(route.detail)}` : ""}`);
  if (!still(token)) return;
  if (!report.banks.length) {
    render(report.company, "Bank reconciliation", `<p class="empty">Create a bank or bank overdraft ledger first, then import its statement here. <a href="${book}/ledgers">Open ledgers</a></p>`, "Br");
    return;
  }
  const period = readPeriod(report.company);
  const preferredBank = report.statement?.ledgerId || sessionStorage.getItem(`financer-bank-ledger:${route.id}`);
  const selectedBank = report.banks.some(bank => bank.id === preferredBank) ? preferredBank : report.banks[0].id;
  const statements = report.statements.filter(row => row.ledgerId === selectedBank);
  render(report.company, "Bank reconciliation", `<div class="toolbar reconciliation-controls"><label>Bank ledger<select data-bank-ledger>${report.banks.map(bank => `<option value="${esc(bank.id)}"${bank.id === selectedBank ? " selected" : ""}>${esc(bank.name)}</option>`).join("")}</select></label>${statements.length ? `<label class="grow">Statement<select data-bank-statement><option value="">Choose an imported statement</option>${statements.map(statement => `<option value="${esc(statement.id)}"${statement.id === report.statement?.id ? " selected" : ""}>${esc(statement.name)}, ${dateLabel(statement.from)} to ${dateLabel(statement.to)}, ${plural(statement.rowCount, "row")}</option>`).join("")}</select></label>` : ""}${report.statement ? '<button type="button" class="ghost" data-reconciliation-print>Print reconciliation</button>' : ""}${statements.length ? "" : '<p class="quiet">No statement is imported for this bank yet. Import its CSV below to start reconciling.</p>'}</div>
    <div class="details-list"><details class="reconciliation-import"${statements.length ? "" : " open"}><summary>Import bank statement CSV</summary><form id="bank-statement-import" class="form-grid">
      <label class="wide">CSV file<input type="file" name="file" accept=".csv,text/csv" required></label>
      <label>Statement name<input name="name" maxlength="100" required></label>
      <label>Date format<select name="dateFormat"><option value="dd/mm/yyyy">Day/month/year, such as 31/03/2026</option><option value="yyyy-mm-dd">Year-month-day, such as 2026-03-31</option><option value="mm/dd/yyyy">Month/day/year, such as 03/31/2026</option></select></label>
      <label>Statement from<input name="from" type="date" value="${esc(period.from)}" min="${esc(report.company.booksFrom)}" required></label>
      <label>Statement to<input name="to" type="date" value="${esc(period.to)}" required></label>
      <label>Statement opening ₹<input name="opening" inputmode="decimal" placeholder="0.00" required></label>
      <label>Statement closing ₹<input name="closing" inputmode="decimal" placeholder="0.00" required></label>
      <p class="form-note wide">Use a minus sign for an overdraft balance.</p>
      <div data-csv-mapping class="wide"></div>
      <div class="actions wide"><button type="submit" disabled>Preview statement</button></div>
      <div data-statement-preview class="wide"></div>
      <p data-import-error class="form-message wide" role="alert"></p>
    </form></details></div>
    <div data-bank-report></div>`, "Br");
  root.querySelector("[data-bank-ledger]").addEventListener("change", async event => {
    sessionStorage.setItem(`financer-bank-ledger:${route.id}`, event.target.value);
    if (route.detail) location.hash = `${book}/bank-reconciliation`;
    else await viewReconciliation(route, token, ctx);
  });
  root.querySelector("[data-bank-statement]")?.addEventListener("change", event => {
    location.hash = `${book}/bank-reconciliation${event.target.value ? "/" + encodeURIComponent(event.target.value) : ""}`;
  });
  bindStatementImport(ctx, report, selectedBank);
  if (report.statement) bindBankReport(ctx, report);
}

function bindStatementImport(ctx, report, ledgerId) {
  const { root, api, still, token, base, book, esc, money, errorAt, save } = ctx;
  const form = root.querySelector("#bank-statement-import");
  const mapping = form.querySelector("[data-csv-mapping]");
  const preview = form.querySelector("[data-statement-preview]");
  const error = form.querySelector("[data-import-error]");
  let csv = "", reviewed = null, importSequence = 0;
  const input = () => {
    const data = new FormData(form);
    const mode = data.get("amountMode");
    return { ledgerId, name: data.get("name"), from: data.get("from"), to: data.get("to"), csv,
      openingPaise: signedRupees(data.get("opening")), closingPaise: signedRupees(data.get("closing")),
      dateFormat: data.get("dateFormat"), signedConvention: data.get("signedConvention"),
      mapping: { date: Number(data.get("mapDate")), narration: Number(data.get("mapNarration")), reference: Number(data.get("mapReference")),
        ...(mode === "signed" ? { amount: Number(data.get("mapAmount")) } : { debit: Number(data.get("mapDebit")), credit: Number(data.get("mapCredit")) }) } };
  };
  form.addEventListener("input", () => { ++importSequence; reviewed = null; preview.innerHTML = ""; error.textContent = ""; });
  form.elements.file.addEventListener("change", async () => {
    const current = ++importSequence;
    csv = ""; reviewed = null; mapping.innerHTML = ""; preview.innerHTML = "";
    form.querySelector('button[type="submit"]').disabled = true;
    try {
      const file = form.elements.file.files[0];
      if (!file || file.size > 2_000_000) throw new Error("Choose a CSV file up to 2 MB");
      const source = await file.text();
      if (!still(token) || current !== importSequence) return;
      csv = source;
      const { headers, sample } = await api(`${base}/csv-columns`, { method: "POST", body: { csv } });
      if (!still(token) || current !== importSequence) return;
      form.elements.name.value = file.name.replace(/\.csv$/i, "");
      const guess = pattern => headers.findIndex(name => pattern.test(name));
      const select = (name, label, chosen) => `<label>${label}<select name="${name}"><option value="-1">Not mapped</option>${headers.map((header, index) => `<option value="${index}"${index === chosen ? " selected" : ""}>${esc(header || "Column " + (index + 1))}</option>`).join("")}</select></label>`;
      const debit = guess(/debit|withdrawal|paid out/i), credit = guess(/credit|deposit|paid in/i), signed = guess(/^amount$|signed amount/i), dateColumn = guess(/date/i);
      mapping.innerHTML = `<fieldset><legend>Match the CSV columns</legend><div class="form-grid"><label>Amount columns<select name="amountMode"><option value="split"${debit >= 0 && credit >= 0 ? " selected" : ""}>Separate debit and credit columns</option><option value="signed"${debit < 0 || credit < 0 ? " selected" : ""}>One signed amount column</option></select></label>
        <label data-signed-mapping>A positive amount means<select name="signedConvention"><option value="credit-positive">Money in</option><option value="debit-positive">Money out</option></select></label>
        ${select("mapDate", "Date column", dateColumn)}${select("mapReference", "Reference column", guess(/ref|utr|cheque|chq|transaction id/i))}
        ${select("mapNarration", "Description column", guess(/description|narration|particulars|details/i))}
        <div data-signed-mapping>${select("mapAmount", "Signed amount column", signed)}</div><div data-split-mapping>${select("mapDebit", "Debit (money out) column", debit)}</div><div data-split-mapping>${select("mapCredit", "Credit (money in) column", credit)}</div></div></fieldset>`;
      const mode = () => {
        const signedMode = form.elements.amountMode.value === "signed";
        for (const node of mapping.querySelectorAll("[data-signed-mapping]")) node.hidden = !signedMode;
        for (const node of mapping.querySelectorAll("[data-split-mapping]")) node.hidden = signedMode;
      };
      form.elements.amountMode.addEventListener("change", mode); mode();
      const first = sample?.find(row => row[dateColumn])?.[dateColumn] || "";
      if (/^\d{4}-/.test(first)) form.elements.dateFormat.value = "yyyy-mm-dd";
      form.querySelector('button[type="submit"]').disabled = false;
    } catch (failure) { errorAt(error, failure); }
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    const current = ++importSequence;
    button.disabled = true;
    try {
      const payload = input();
      const result = await api(`${base}/bank-preview`, { method: "POST", body: payload });
      if (!still(token) || current !== importSequence) return;
      reviewed = payload;
      const statement = result.statement;
      const difference = statement.closingPaise - statement.computedClosingPaise;
      const shown = Math.min(10, statement.rows.length);
      preview.innerHTML = `<h3>Statement preview</h3><p>${plural(statement.rows.length, "transaction row")}.${statement.ignoredRows.length ? ` ${plural(statement.ignoredRows.length, "zero-movement row")} left out.` : ""}</p>
        <p>${difference === 0 ? '<span class="pill ok">Agrees</span> The CSV movements reach the reported closing balance.' : `<span class="pill warn">Off by ₹ ${money(Math.abs(difference))}</span> Check the opening, the closing and the column mapping before you import.`}</p>
        <table class="reconciliation-check-table"><tbody><tr><th scope="row">Opening ₹</th><td class="figure">${money(statement.openingPaise)}</td></tr><tr><th scope="row">Closing from CSV movements ₹</th><td class="figure">${money(statement.computedClosingPaise)}</td></tr><tr><th scope="row">Reported closing ₹</th><td class="figure">${money(statement.closingPaise)}</td></tr><tr class="total"><th scope="row">Difference ₹</th><td class="figure">${money(difference)}</td></tr></tbody></table>
        <div class="table-scroll"><table><thead><tr><th>Date</th><th>Reference and description</th><th class="figure">Money in ₹</th><th class="figure">Money out ₹</th></tr></thead><tbody>${statement.rows.slice(0, 10).map(row => `<tr><td class="date-cell">${dateLabel(row.date)}</td><td><span class="code">${esc(row.reference)}</span><small>${esc(row.narration)}</small></td><td class="figure">${row.amountPaise > 0 ? money(row.amountPaise) : "—"}</td><td class="figure">${row.amountPaise < 0 ? money(-row.amountPaise) : "—"}</td></tr>`).join("")}</tbody></table></div>
        <p class="quiet">Showing the first ${shown} of ${plural(statement.rows.length, "row")}.</p><div class="actions"><button type="button" data-import-reviewed>Import for review</button></div>`;
      preview.querySelector("[data-import-reviewed]").addEventListener("click", async () => {
        if (!reviewed) return;
        try {
          const saved = await save("import-statement", reviewed, form, "Statement imported for reconciliation.", report.revision);
          if (saved) location.hash = `${book}/bank-reconciliation/${encodeURIComponent(saved.result.id)}`;
        } catch (failure) { errorAt(error, failure); }
      });
    } catch (failure) { errorAt(error, failure); }
    finally { button.disabled = !csv || !form.querySelector('[name="amountMode"]'); }
  });
}

function bindBankReport(ctx, report) {
  const { root, esc, money, postingLink, errorAt, save, refresh } = ctx;
  const area = root.querySelector("[data-bank-report]");
  const totals = report.totals;
  const openRows = report.rows.filter(row => !row.matched).length;
  const openBooks = report.bookEntries.filter(row => !row.matched).length;
  const bankName = report.banks.find(bank => bank.id === report.statement.ledgerId)?.name || "";
  area.innerHTML = `<section class="reconciliation-section"><h2>${esc(report.statement.name)}</h2><p class="quiet">${bankName ? `Bank ledger ${esc(bankName)}. ` : ""}Statement period ${dateLabel(report.statement.from)} to ${dateLabel(report.statement.to)}.</p>
    <div class="summary-strip"><div><span>Confirmed matches</span><strong>${report.matches.length}</strong></div><div><span>Statement rows open</span><strong>${openRows}</strong></div><div><span>Book transactions uncleared</span><strong>${openBooks}</strong></div><div><span>Unexplained difference</span><strong>₹ ${money(totals.differencePaise)}</strong><small>${totals.differencePaise === 0 ? '<span class="pill ok">Reconciled</span>' : '<span class="pill warn">Not reconciled</span> Review the open items below.'}</small></div></div>
    <div class="two reconciliation-balance-grid"><section><h3>Opening comparison</h3><table><tbody><tr><th scope="row">Book opening ₹</th><td class="figure">${money(totals.openingBookPaise)}</td></tr><tr><th scope="row">Expected bank opening after pending items ₹</th><td class="figure">${money(totals.expectedOpeningBankPaise)}</td></tr><tr><th scope="row">Statement opening ₹</th><td class="figure">${money(totals.statementOpeningPaise)}</td></tr><tr class="total"><th scope="row">Opening difference ₹</th><td class="figure">${money(totals.openingDifferencePaise)}</td></tr></tbody></table></section>
    <section><h3>Closing comparison</h3><table><tbody><tr><th scope="row">Book closing ₹</th><td class="figure">${money(totals.closingBookPaise)}</td></tr><tr><th scope="row">Less uncleared book movements ₹</th><td class="figure">${money(totals.unmatchedBookPaise)}</td></tr><tr><th scope="row">Add bank movements awaiting books ₹</th><td class="figure">${money(totals.unmatchedStatementPaise)}</td></tr><tr><th scope="row">Expected bank closing ₹</th><td class="figure">${money(totals.expectedBankPaise)}</td></tr><tr><th scope="row">Statement closing ₹</th><td class="figure">${money(totals.statementClosingPaise)}</td></tr><tr class="total"><th scope="row">Unexplained difference ₹</th><td class="figure">${money(totals.differencePaise)}</td></tr><tr><th scope="row">CSV arithmetic difference ₹</th><td class="figure">${money(totals.statementArithmeticDifferencePaise)}</td></tr></tbody></table></section></div>
    <div class="details-list"><details class="reconciliation-opening"><summary>Transactions pending at the beginning of this statement</summary><form id="bank-opening-pending"><p class="form-note">Tick the older book postings that had not reached the bank by the statement’s opening date.</p><div class="check-group" data-opening-choices></div><div class="actions"><button type="submit">Save opening pending items</button></div><p data-opening-error class="form-message" role="alert"></p></form></details></div>
    <div class="toolbar reconciliation-find"><label class="grow">Find a date, reference or description<input type="search" data-bank-search placeholder="Searches both sides and confirmed matches"></label></div>
    <div class="reconciliation-match-bar"><div class="reconciliation-selected" data-selected-totals aria-live="polite"></div><button type="button" data-confirm-bank-match disabled>Confirm selected match</button></div><p data-match-error class="form-message" role="alert"></p>
    <div class="two reconciliation-match-grid"><section><h3>Statement rows awaiting match</h3><div data-statement-rows></div></section><section><h3>Book transactions awaiting clearance</h3><div data-book-rows></div></section></div>
    <section class="reconciliation-section"><h3>Confirmed matches</h3><div data-confirmed-matches></div><p data-unmatch-error class="form-message" role="alert"></p></section><button type="button" class="ghost" data-more-bank>Show 200 more rows</button>
    <div class="details-list"><details class="reconciliation-audit"><summary>Change history</summary><div data-audit-rows></div></details></div></section>`;
  const selectedRows = new Set(), selectedBooks = new Set(), openingIds = new Set(report.statement.openingPendingVoucherIds);
  let limit = 200;
  const query = () => area.querySelector("[data-bank-search]").value.trim().toLowerCase();
  const includes = row => !query() || [row.date, dateLabel(row.date), row.reference, row.number, row.narration].join(" ").toLowerCase().includes(query());
  const matchTotal = match => match.rows.reduce((total, row) => total + row.amountPaise, 0);
  const selectedTotals = () => {
    const rows = report.rows.filter(row => selectedRows.has(row.id)), entries = report.bookEntries.filter(row => selectedBooks.has(row.voucherId));
    const rowTotal = rows.reduce((total, row) => total + row.amountPaise, 0), bookTotal = entries.reduce((total, row) => total + row.amountPaise, 0);
    const sameDirection = new Set([...rows, ...entries].map(row => Math.sign(row.amountPaise))).size === 1;
    const target = area.querySelector("[data-selected-totals]");
    if (!rows.length && !entries.length) target.innerHTML = '<span class="quiet">Tick bank rows and book transactions with the same total, or pick a suggested voucher.</span>';
    else {
      const state = rows.length > 100 || entries.length > 100 ? '<span><span class="pill warn">Too many rows</span> Select up to 100 on each side.</span>'
        : rows.length && entries.length && !sameDirection ? '<span><span class="pill warn">Mixed directions</span> Choose money in on both sides, or money out on both sides.</span>'
          : rows.length && entries.length && rowTotal === bookTotal ? '<span class="pill ok">Totals agree</span>'
            : rows.length && entries.length ? `<span class="pill warn">Differ by ₹ ${money(Math.abs(rowTotal - bookTotal))}</span>`
              : `<span class="quiet">Now tick the matching ${rows.length ? "book transactions" : "bank rows"}.</span>`;
      target.innerHTML = `<span>${plural(rows.length, "bank row")} <strong class="figure">₹ ${money(rowTotal)}</strong></span><span>${plural(entries.length, "book transaction")} <strong class="figure">₹ ${money(bookTotal)}</strong></span>${state}`;
    }
    area.querySelector("[data-confirm-bank-match]").disabled = !rows.length || !entries.length || rowTotal !== bookTotal || !sameDirection || rows.length > 100 || entries.length > 100;
  };
  const draw = () => {
    const rows = report.rows.filter(row => !row.matched && includes(row));
    const entries = report.bookEntries.filter(row => !row.matched && includes(row));
    const matches = report.matches.filter(match => match.rows.some(includes) || match.entries.some(includes));
    const old = report.openingChoices.filter(includes);
    area.querySelector("[data-statement-rows]").innerHTML = `<div class="table-scroll"><table><thead><tr><th class="reconciliation-select"><span class="sr">Select</span></th><th>Date and reference</th><th class="figure">Amount ₹</th></tr></thead><tbody>${rows.slice(0, limit).map(row => `<tr><td class="reconciliation-select"><input type="checkbox" data-row-id="${esc(row.id)}" aria-label="Select bank row ${row.sourceRow}"${selectedRows.has(row.id) ? " checked" : ""}></td><td><span class="date-cell">${dateLabel(row.date)}</span>${row.reference ? `<strong class="reconciliation-detail code">${esc(row.reference)}</strong>` : '<span class="reconciliation-detail quiet">No reference</span>'}<small>${esc(row.narration)}</small>${row.possibleDuplicate ? '<small><span class="pill warn">Possible duplicate</span> This row is also in another imported statement.</small>' : ""}${row.candidateKind === "ambiguous" ? '<small><span class="pill warn">Several possible matches</span></small>' : ""}${row.candidates.length ? `<small>${row.candidateKind === "amount-date-reference" ? "Suggested by the same amount, date and reference." : "Suggested by the same amount and date."}</small>${row.candidates.map(candidate => `<button type="button" class="link reconciliation-candidate" data-candidate-row="${esc(row.id)}" data-candidate-voucher="${esc(candidate.voucherId)}">Select ${esc(candidate.number)}</button>`).join("")}` : ""}</td><td class="figure">${money(row.amountPaise)}</td></tr>`).join("") || '<tr><td colspan="3" class="quiet">No open bank rows match. Clear the search or import the next statement.</td></tr>'}</tbody></table></div>`;
    area.querySelector("[data-book-rows]").innerHTML = `<div class="table-scroll"><table><thead><tr><th class="reconciliation-select"><span class="sr">Select</span></th><th>Date and voucher</th><th class="figure">Amount ₹</th></tr></thead><tbody>${entries.slice(0, limit).map(entry => `<tr><td class="reconciliation-select"><input type="checkbox" data-voucher-id="${esc(entry.voucherId)}" aria-label="Select book voucher ${esc(entry.number)}"${selectedBooks.has(entry.voucherId) ? " checked" : ""}></td><td><span class="date-cell">${dateLabel(entry.date)}</span><strong class="reconciliation-detail">${postingLink(entry)}</strong><small>${esc(entry.narration)}</small></td><td class="figure">${money(entry.amountPaise)}</td></tr>`).join("") || '<tr><td colspan="3" class="quiet">No uncleared book transactions match. Clear the search or pass the missing voucher.</td></tr>'}</tbody></table></div>`;
    area.querySelector("[data-confirmed-matches]").innerHTML = `<div class="table-scroll"><table><thead><tr><th>Bank rows</th><th>Book vouchers</th><th class="figure">Amount ₹</th><th><span class="sr">Action</span></th></tr></thead><tbody>${matches.slice(0, limit).map(match => `<tr><td>${match.rows.map(row => `<span class="reconciliation-detail"><span class="date-cell">${dateLabel(row.date)}</span> <span class="code">${esc(row.reference)}</span>${match.rows.length > 1 ? ` <span class="quiet">₹ ${money(row.amountPaise)}</span>` : ""}</span>`).join("")}</td><td>${match.entries.map(entry => `<span class="reconciliation-detail">${postingLink(entry)}</span>`).join("")}</td><td class="figure">${money(matchTotal(match))}</td><td><button type="button" class="danger" data-unmatch="${esc(match.id)}">Unmatch</button></td></tr>`).join("") || '<tr><td colspan="4" class="quiet">No confirmed matches for this search. Select rows on both sides above and confirm the match.</td></tr>'}</tbody></table></div>`;
    area.querySelector("[data-opening-choices]").innerHTML = old.slice(0, limit).map(entry => `<label class="check"><input type="checkbox" data-opening-voucher="${esc(entry.voucherId)}"${openingIds.has(entry.voucherId) ? " checked" : ""}><span class="date-cell">${dateLabel(entry.date)}</span><span class="code">${esc(entry.number)}</span><span>₹ ${money(entry.amountPaise)}</span></label>`).join("") || '<p class="quiet">No older bank postings match this search.</p>';
    area.querySelector("[data-more-bank]").hidden = ![rows, entries, matches, old].some(list => list.length > limit);
    selectedTotals();
  };
  area.addEventListener("change", event => {
    const target = event.target;
    const set = target.dataset.rowId ? selectedRows : target.dataset.voucherId ? selectedBooks : target.dataset.openingVoucher ? openingIds : null;
    const id = target.dataset.rowId || target.dataset.voucherId || target.dataset.openingVoucher;
    if (set) { if (target.checked) set.add(id); else set.delete(id); selectedTotals(); }
  });
  area.addEventListener("click", async event => {
    const candidate = event.target.closest("[data-candidate-row]");
    if (candidate) { selectedRows.clear(); selectedBooks.clear(); selectedRows.add(candidate.dataset.candidateRow); selectedBooks.add(candidate.dataset.candidateVoucher); draw(); }
    const unmatch = event.target.closest("[data-unmatch]");
    if (unmatch) {
      const match = report.matches.find(row => row.id === unmatch.dataset.unmatch);
      const question = match
        ? `Unmatch bank ${plural(match.rows.length, "row")} ${match.rows.map(row => row.reference || dateLabel(row.date)).join(", ")} for ₹ ${formatINR(Math.abs(matchTotal(match)))} from ${match.entries.map(entry => entry.number || "the opening balance").join(", ")}?`
        : "Unmatch these bank rows from their book vouchers?";
      if (!confirm(`${question} Both sides go back to the open lists.`)) return;
      try {
        if (await save("unmatch-bank", { matchId: unmatch.dataset.unmatch }, unmatch, "Bank match removed.", report.revision)) await refresh();
      } catch (failure) { errorAt(area.querySelector("[data-unmatch-error]"), failure); }
    }
  });
  area.querySelector("[data-confirm-bank-match]").addEventListener("click", async event => {
    try {
      const result = await save("match-bank", { statementId: report.statement.id, rowIds: [...selectedRows], voucherIds: [...selectedBooks] }, event.target, "Selected transactions matched.", report.revision);
      if (result) await refresh();
    } catch (failure) { errorAt(area.querySelector("[data-match-error]"), failure); }
  });
  area.querySelector("#bank-opening-pending").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      if (await save("bank-opening", { statementId: report.statement.id, openingPendingVoucherIds: [...openingIds] }, event.target, "Opening pending transactions saved.", report.revision)) await refresh();
    } catch (failure) { errorAt(area.querySelector("[data-opening-error]"), failure); }
  });
  area.querySelector("[data-bank-search]").addEventListener("input", () => { limit = 200; draw(); });
  area.querySelector("[data-more-bank]").addEventListener("click", () => { limit += 200; draw(); });
  root.querySelector("[data-reconciliation-print]").addEventListener("click", () => { limit = Number.MAX_SAFE_INTEGER; draw(); window.print(); });
  bindAudit(ctx, area.querySelector(".reconciliation-audit"));
  draw();
}

async function billWorkspace(ctx) {
  const { root, api, still, token, route, esc, base, money, postingLink, render, errorAt, save, refresh, readPeriod } = ctx;
  const storageKey = `financer-bills-filter:${route.id}`;
  let filter;
  try { filter = JSON.parse(sessionStorage.getItem(storageKey) || "null"); } catch { filter = null; }
  const { company } = await api(`/api/companies/${encodeURIComponent(route.id)}/meta`);
  if (!still(token)) return;
  /* The as-on date is a review control of its own. It follows the books period unless chosen under the current period or passed as ?asOf. */
  const period = readPeriod(company);
  const queryAsOf = new URLSearchParams(location.hash.split("?")[1] || "").get("asOf") || "";
  const savedAsOf = filter?.periodTo === period.to ? filter.asOf : "";
  const asOf = (/^\d{4}-\d{2}-\d{2}$/.test(queryAsOf) ? queryAsOf : "") || savedAsOf || period.to;
  const ledgerId = filter?.ledgerId || "";
  const report = await api(`${base}/bills?asOf=${encodeURIComponent(asOf)}&ledgerId=${encodeURIComponent(ledgerId)}`);
  if (!still(token)) return;
  const partyLabel = id => report.parties.find(party => party.id === id)?.name || "";
  const sideLabel = side => side === "receivable" ? "Receivable" : "Payable";
  const buckets = [["current", "Current"], ["1–30", "1–30 days"], ["31–60", "31–60 days"], ["61–90", "61–90 days"], ["90+", "Over 90 days"]];
  render(report.company, "Bill-wise outstanding", `<form id="bill-report-filter" class="toolbar reconciliation-controls"><label>As on<input type="date" name="asOf" value="${esc(report.asOf)}" min="${esc(report.company.booksFrom)}" required></label><label class="grow">Party ledger<select name="ledgerId"><option value="">All debtors and creditors</option>${report.parties.map(party => `<option value="${esc(party.id)}"${party.id === ledgerId ? " selected" : ""}>${esc(party.name)} (${sideLabel(party.side).toLowerCase()})</option>`).join("")}</select></label><button type="submit">Show outstanding</button><button type="button" class="ghost" data-reconciliation-print>Print outstanding</button></form>
    <p class="only-print">As on ${dateLabel(report.asOf)}. ${esc(ledgerId ? partyLabel(ledgerId) : "All debtors and creditors")}.</p>
    <div class="table-scroll"><table class="reconciliation-ageing"><thead><tr><th>Ageing by due date</th>${buckets.map(([, label]) => `<th class="figure">${label}</th>`).join("")}</tr></thead><tbody>${report.ageing.map(row => `<tr><th scope="row">${sideLabel(row.side)}</th>${buckets.map(([bucket]) => `<td class="figure">${money(row.buckets[bucket])}</td>`).join("")}</tr>`).join("") || '<tr><td colspan="6" class="quiet">No open bills to age on this date.</td></tr>'}</tbody></table></div>
    <div class="toolbar reconciliation-find"><label class="grow">Find party, bill or voucher<input type="search" data-bill-search></label><label class="check reconciliation-show-settled"><input type="checkbox" data-show-settled><span>Include settled bills</span></label></div>
    <section class="subsection"><h2>Bill references</h2><div data-bill-rows></div><p data-bill-action-error class="form-message" role="alert"></p></section>
    <div class="details-list"><details class="reconciliation-reference"${report.rows.length ? "" : " open"}><summary data-reference-summary>Create bill reference</summary><form id="bill-reference-form" class="form-grid"><input type="hidden" name="billId"><label class="wide">Source posting<select name="sourceKey" required><option value="">Choose an unreferenced posting</option></select></label><label>Reference<input name="reference" maxlength="80" required></label><label>Due date<input name="dueDate" type="date" required></label><label>Reference amount ₹<input name="amount" inputmode="decimal" required></label><div class="actions wide"><button type="submit">Save reference</button><button type="button" class="ghost" data-clear-reference>Start a new reference</button></div><p data-reference-error class="form-message wide" role="alert"></p></form></details></div>
    <section class="subsection"><h2>Receipts, payments and advances</h2><div data-settlement-rows></div></section>
    <div class="details-list"><details class="reconciliation-allocation"><summary>Allocate a settlement against a bill</summary><form id="bill-allocation-form" class="form-grid"><label class="wide">Open bill<select name="billId" required><option value="">Choose a bill</option>${report.rows.filter(row => row.openPaise > 0).map(row => `<option value="${esc(row.id)}">${esc(row.partyName)}, ${esc(row.reference)}, ₹ ${money(row.openPaise)} open</option>`).join("")}</select></label><label class="wide">Receipt, payment, credit note or advance<select name="creditKey" required><option value="">Choose the bill first</option></select></label><label>Allocation date<input name="date" type="date" value="${esc(report.asOf)}" required></label><label>Amount to allocate ₹<input name="amount" inputmode="decimal" required></label><div class="actions wide"><button type="submit">Save allocation</button></div><p data-allocation-error class="form-message wide" role="alert"></p></form></details></div>
    <section class="subsection"><h2>Allocation trail</h2><div data-allocation-rows></div><p data-allocation-action-error class="form-message" role="alert"></p></section>
    <section class="subsection"><h2>On-account postings awaiting a reference</h2><div data-unreferenced-rows></div></section>
    <section class="subsection"><h2>Agreement with party ledgers</h2><div data-party-totals></div></section>
    <button type="button" class="ghost" data-more-bills>Show 200 more rows</button><p data-print-search class="only-print"></p>
    <div class="details-list"><details class="reconciliation-audit"><summary>Change history</summary><div data-audit-rows></div></details></div>`, "Bo");
  root.querySelector("#bill-report-filter").addEventListener("submit", async event => {
    event.preventDefault();
    if (!event.target.reportValidity()) return;
    sessionStorage.setItem(storageKey, JSON.stringify({ ...Object.fromEntries(new FormData(event.target)), periodTo: period.to }));
    await refresh();
  });
  let limit = 200;
  const query = () => root.querySelector("[data-bill-search]").value.trim().toLowerCase();
  const includes = row => !query() || [row.partyName, row.reference, row.number, row.narration, row.bill?.reference, row.settlement?.number].join(" ").toLowerCase().includes(query());
  const dueState = row => !row.openPaise ? '<span class="pill ok">Settled</span>' : row.daysOverdue ? `<span class="pill warn">${plural(row.daysOverdue, "day")} overdue</span>` : '<span class="pill">Current</span>';
  const draw = () => {
    const rows = report.rows.filter(row => (row.openPaise > 0 || root.querySelector("[data-show-settled]").checked) && includes(row));
    const settlements = report.settlements.filter(includes), allocations = report.allocations.filter(includes), unreferenced = report.unreferenced.filter(includes);
    const parties = report.totals.filter(row => !query() || row.name.toLowerCase().includes(query()));
    root.querySelector("[data-bill-rows]").innerHTML = `<div class="table-scroll"><table><thead><tr><th>Party and bill</th><th>Due date</th><th class="figure">Bill ₹</th><th class="figure">Allocated ₹</th><th class="figure">Open ₹</th><th><span class="sr">Action</span></th></tr></thead><tbody>${rows.slice(0, limit).map(row => `<tr><th scope="row">${esc(row.partyName)}<button type="button" class="link code reconciliation-reference-link" data-edit-bill="${esc(row.id)}" aria-label="Edit bill reference ${esc(row.reference)}">${esc(row.reference)}</button><small>${postingLink(row.source)}</small></th><td><span class="date-cell">${dateLabel(row.dueDate)}</span><small>${dueState(row)}</small></td><td class="figure">${money(row.amountPaise)}</td><td class="figure">${money(row.paidPaise)}</td><td class="figure">${money(row.openPaise)}</td><td>${!row.derived ? `<button type="button" class="danger" data-remove-bill="${esc(row.id)}">Remove reference</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="6" class="quiet">No open bills match this report. Create a bill reference below, or include settled bills.</td></tr>'}</tbody></table></div>`;
    root.querySelector("[data-settlement-rows]").innerHTML = `<div class="table-scroll"><table><thead><tr><th>Party and voucher</th><th>Date</th><th class="figure">Settlement ₹</th><th class="figure">Allocated ₹</th><th class="figure">Unallocated ₹</th></tr></thead><tbody>${settlements.slice(0, limit).map(row => `<tr><th scope="row">${esc(row.partyName)}<span class="reconciliation-detail">${postingLink(row)}</span><small>${esc(row.type)}</small></th><td class="date-cell">${dateLabel(row.date)}</td><td class="figure">${money(-row.amountPaise)}</td><td class="figure">${money(row.allocatedPaise)}</td><td class="figure">${money(row.remainingPaise)}</td></tr>`).join("") || '<tr><td colspan="5" class="quiet">No receipts, payments or advances match this report.</td></tr>'}</tbody></table></div>`;
    root.querySelector("[data-allocation-rows]").innerHTML = `<div class="table-scroll"><table><thead><tr><th>Party and bill</th><th>Settlement</th><th>Date</th><th class="figure">Allocated ₹</th><th><span class="sr">Action</span></th></tr></thead><tbody>${allocations.slice(0, limit).map(row => `<tr><th scope="row">${esc(row.partyName)}<span class="reconciliation-detail code">${esc(row.bill?.reference || row.billId)}</span><small>${postingLink(row.bill?.source || report.rows.find(bill => bill.id === row.billId)?.source)}</small></th><td>${postingLink(row.settlement)}</td><td class="date-cell">${dateLabel(row.date)}</td><td class="figure">${money(row.paise)}</td><td><button type="button" class="danger" data-unallocate="${esc(row.id)}">Remove allocation</button></td></tr>`).join("") || '<tr><td colspan="5" class="quiet">No bill allocations for this report. Allocate a settlement against a bill above.</td></tr>'}</tbody></table></div>`;
    root.querySelector("[data-unreferenced-rows]").innerHTML = `<div class="table-scroll"><table><thead><tr><th>Party and source</th><th>Date</th><th class="figure">Awaiting reference ₹</th></tr></thead><tbody>${unreferenced.slice(0, limit).map(row => `<tr><th scope="row">${esc(row.partyName)}<span class="reconciliation-detail">${postingLink(row)}</span></th><td class="date-cell">${dateLabel(row.date)}</td><td class="figure">${money(row.remainingPaise)}</td></tr>`).join("") || '<tr><td colspan="3" class="quiet">No unreferenced postings match this report.</td></tr>'}</tbody></table></div>`;
    root.querySelector("[data-party-totals]").innerHTML = `<div class="table-scroll"><table><thead><tr><th>Party</th><th class="figure">Open bills ₹</th><th class="figure">On account ₹</th><th class="figure">Less advances ₹</th><th class="figure">Ledger ₹</th><th class="figure">Difference ₹</th><th>Agreement</th></tr></thead><tbody>${parties.slice(0, limit).map(row => `<tr><th scope="row">${esc(row.name)}<small>${sideLabel(row.side)}</small></th><td class="figure">${money(row.outstandingPaise)}</td><td class="figure">${money(row.onAccountPaise)}</td><td class="figure">${money(row.advancePaise)}</td><td class="figure">${money(row.ledgerPaise)}</td><td class="figure">${money(row.differencePaise)}</td><td>${row.differencePaise === 0 ? '<span class="pill ok">Agrees</span>' : '<span class="pill warn">Differs</span>'}</td></tr>`).join("") || '<tr><td colspan="7" class="quiet">No debtor or creditor ledgers match this search.</td></tr>'}</tbody></table></div>`;
    root.querySelector("[data-more-bills]").hidden = ![rows, settlements, allocations, unreferenced, report.totals].some(list => list.length > limit);
    root.querySelector("[data-print-search]").textContent = query() ? `Filtered by “${root.querySelector("[data-bill-search]").value}”.` : "";
  };
  const sourceChoices = new Map([...report.rows.map(row => ({ ...row.source, partyName: row.partyName, remainingPaise: row.amountPaise })), ...report.unreferenced].map(source => [source.key, source]));
  const referenceForm = root.querySelector("#bill-reference-form");
  const sourceOption = source => `<option value="${esc(source.key)}">${esc(source.partyName)}, ${esc(source.number)}, ${dateLabel(source.date)}</option>`;
  const resetSources = () => { referenceForm.elements.sourceKey.innerHTML = '<option value="">Choose an unreferenced posting</option>' + report.unreferenced.map(sourceOption).join(""); };
  resetSources();
  referenceForm.elements.sourceKey.addEventListener("change", () => {
    const source = sourceChoices.get(referenceForm.elements.sourceKey.value);
    if (!source) return;
    referenceForm.elements.reference.value = source.reference || source.number;
    referenceForm.elements.dueDate.value = source.date;
    referenceForm.elements.dueDate.min = source.date;
    referenceForm.elements.amount.value = rupees(source.remainingPaise);
  });
  root.querySelector("[data-clear-reference]").addEventListener("click", () => {
    referenceForm.reset(); resetSources(); referenceForm.elements.sourceKey.disabled = false; referenceForm.elements.amount.readOnly = false;
    root.querySelector("[data-reference-summary]").textContent = "Create bill reference";
    delete referenceForm.dataset.requestId;
  });
  referenceForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!referenceForm.reportValidity()) return;
    try {
      const source = sourceChoices.get(referenceForm.elements.sourceKey.value);
      const input = { id: referenceForm.elements.billId.value || undefined, ledgerId: source.ledgerId, sourceKey: source.key,
        reference: referenceForm.elements.reference.value, dueDate: referenceForm.elements.dueDate.value, amountPaise: parseRupees(referenceForm.elements.amount.value) };
      if (await save("save-bill", input, referenceForm, "Bill reference saved.", report.revision)) await refresh();
    } catch (failure) { errorAt(referenceForm.querySelector("[data-reference-error]"), failure); }
  });
  const allocationForm = root.querySelector("#bill-allocation-form");
  const suggestAmount = () => {
    const bill = report.rows.find(row => row.id === allocationForm.elements.billId.value);
    const credit = report.settlements.find(row => row.key === allocationForm.elements.creditKey.value);
    if (!bill || !credit) return;
    allocationForm.elements.amount.value = rupees(Math.min(bill.openPaise, credit.remainingPaise));
    allocationForm.elements.date.min = bill.date > credit.date ? bill.date : credit.date;
  };
  allocationForm.elements.billId.addEventListener("change", () => {
    const bill = report.rows.find(row => row.id === allocationForm.elements.billId.value);
    allocationForm.elements.creditKey.innerHTML = '<option value="">Choose a settlement</option>' + report.settlements.filter(row => row.remainingPaise > 0 && row.ledgerId === bill?.ledgerId).map(row => `<option value="${esc(row.key)}">${esc(row.number)}, ${dateLabel(row.date)}, ₹ ${money(row.remainingPaise)} available</option>`).join("");
    allocationForm.elements.amount.value = "";
  });
  allocationForm.elements.creditKey.addEventListener("change", suggestAmount);
  allocationForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!allocationForm.reportValidity()) return;
    try {
      const bill = report.rows.find(row => row.id === allocationForm.elements.billId.value);
      if (await save("allocate-bill", { ledgerId: bill.ledgerId, billId: bill.id, creditKey: allocationForm.elements.creditKey.value, date: allocationForm.elements.date.value, paise: parseRupees(allocationForm.elements.amount.value) }, allocationForm, "Settlement allocated to bill.", report.revision)) await refresh();
    } catch (failure) { errorAt(allocationForm.querySelector("[data-allocation-error]"), failure); }
  });
  root.querySelector(".reconciliation-workspace").addEventListener("click", async event => {
    if (!still(token)) return;
    const edit = event.target.closest("[data-edit-bill]");
    if (edit) {
      const bill = report.rows.find(row => row.id === edit.dataset.editBill);
      referenceForm.elements.billId.value = bill.id;
      if (![...referenceForm.elements.sourceKey.options].some(option => option.value === bill.sourceKey)) referenceForm.elements.sourceKey.insertAdjacentHTML("beforeend", sourceOption(sourceChoices.get(bill.sourceKey)));
      referenceForm.elements.sourceKey.value = bill.sourceKey;
      referenceForm.elements.sourceKey.disabled = true;
      referenceForm.elements.reference.value = bill.reference;
      referenceForm.elements.dueDate.value = bill.dueDate;
      referenceForm.elements.dueDate.min = bill.date;
      referenceForm.elements.amount.value = rupees(bill.amountPaise);
      if (bill.derived || bill.source?.gstId) referenceForm.elements.amount.readOnly = true;
      else referenceForm.elements.amount.readOnly = false;
      delete referenceForm.dataset.requestId;
      root.querySelector(".reconciliation-reference").open = true;
      root.querySelector("[data-reference-summary]").textContent = "Edit bill reference";
      referenceForm.elements.reference.focus();
      referenceForm.scrollIntoView({ block: "center" });
    }
    const remove = event.target.closest("[data-remove-bill]");
    const unallocate = event.target.closest("[data-unallocate]");
    const button = remove || unallocate;
    if (!button) return;
    if (remove) {
      const bill = report.rows.find(row => row.id === remove.dataset.removeBill);
      const question = bill ? `Remove bill reference ${bill.reference} for ${bill.partyName}, ₹ ${formatINR(bill.amountPaise)}?` : "Remove this bill reference?";
      if (!confirm(`${question} The voucher stays in the books. Only the bill reference is removed.`)) return;
    } else {
      const allocation = report.allocations.find(row => row.id === unallocate.dataset.unallocate);
      const reference = allocation?.bill?.reference || report.rows.find(bill => bill.id === allocation?.billId)?.reference || "";
      const question = allocation
        ? `Remove the ₹ ${formatINR(allocation.paise)} allocation of ${allocation.settlement?.number || "this settlement"} against bill ${reference || "reference"} for ${allocation.partyName}?`
        : "Remove this allocation?";
      if (!confirm(`${question} The bill becomes open again by that amount.`)) return;
    }
    try {
      const action = remove ? "remove-bill" : "unallocate-bill";
      const input = remove ? { billId: remove.dataset.removeBill } : { allocationId: unallocate.dataset.unallocate };
      if (await save(action, input, button, remove ? "Bill reference removed." : "Allocation removed.", report.revision)) await refresh();
    } catch (failure) { errorAt(root.querySelector(remove ? "[data-bill-action-error]" : "[data-allocation-action-error]"), failure); }
  });
  root.querySelector("[data-bill-search]").addEventListener("input", () => { limit = 200; draw(); });
  root.querySelector("[data-show-settled]").addEventListener("change", draw);
  root.querySelector("[data-more-bills]").addEventListener("click", () => { limit += 200; draw(); });
  root.querySelector("[data-reconciliation-print]").addEventListener("click", () => { limit = Number.MAX_SAFE_INTEGER; draw(); window.print(); });
  bindAudit(ctx, root.querySelector(".reconciliation-audit"));
  draw();
}

function bindAudit(ctx, details) {
  const { api, base, esc, still, token } = ctx;
  let loaded = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || loaded) return;
    const area = details.querySelector("[data-audit-rows]");
    try {
      const { rows } = await api(`${base}/audit`);
      if (!still(token)) return;
      loaded = true;
      area.innerHTML = `<div class="table-scroll"><table><thead><tr><th>Saved</th><th>Change</th><th>Reference</th></tr></thead><tbody>${rows.slice().reverse().map(row => { const action = row.action.replace(/-/g, " "); return `<tr><td class="date-cell">${esc(stampLabel(row.at))}</td><td>${esc(action.charAt(0).toUpperCase() + action.slice(1))}</td><td class="code">${esc(row.result?.id || "")}</td></tr>`; }).join("") || '<tr><td colspan="3" class="quiet">No reconciliation changes yet.</td></tr>'}</tbody></table></div>`;
    } catch (failure) { area.innerHTML = `<p class="form-message alert" role="alert">${esc(failure.message)}</p>`; }
  });
}
