import { formatINR, parseRupees, todayISO } from "/money.js";

const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.split("-").reverse().join("-") : value || "—";
const rupees = value => (value / 100).toFixed(2);
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
  const postingLink = row => !row?.voucherId ? "Opening balance" : `<a href="${book}/${row.gstId ? `gst-document/${esc(row.gstId)}` : `v/${encodeURIComponent(row.type)}/${esc(row.voucherId)}`}">${esc(row.number)}</a>`;
  const render = (company, title, body, folio) => {
    const status = sessionStorage.getItem(flashKey) || "";
    sessionStorage.removeItem(flashKey);
    document.title = `${title} · ${company.name}`;
    root.innerHTML = page({ company, title, kicker: "Reconciliation", folio, status, body: `<div class="reconciliation-workspace">${body}</div>` });
  };
  const errorAt = (target, error) => { target.className = "alert"; target.textContent = error.message; target.scrollIntoView({ block: "nearest" }); };
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
  const { root, api, still, token, route, base, book, esc, money, postingLink, render, errorAt, save, refresh } = ctx;
  const report = await api(`${base}/bank${route.detail ? `?statementId=${encodeURIComponent(route.detail)}` : ""}`);
  if (!still(token)) return;
  if (!report.banks.length) {
    render(report.company, "Bank reconciliation", `<p>Create a bank or bank overdraft ledger to reconcile its statements.</p><p><a href="${book}/ledgers">Open ledgers</a></p>`, "Br");
    return;
  }
  const preferredBank = report.statement?.ledgerId || sessionStorage.getItem(`financer-bank-ledger:${route.id}`);
  const selectedBank = report.banks.some(bank => bank.id === preferredBank) ? preferredBank : report.banks[0].id;
  const statements = report.statements.filter(row => row.ledgerId === selectedBank);
  render(report.company, "Bank reconciliation", `<div class="reconciliation-controls"><label>Bank ledger<select data-bank-ledger>${report.banks.map(bank => `<option value="${esc(bank.id)}"${bank.id === selectedBank ? " selected" : ""}>${esc(bank.name)}</option>`).join("")}</select></label>${report.statement ? '<button type="button" class="ghost" data-reconciliation-print>Print reconciliation</button>' : ""}</div>
    <div class="reconciliation-statements">${statements.length ? `<label>Statement<select data-bank-statement><option value="">Choose an imported statement</option>${statements.map(statement => `<option value="${esc(statement.id)}"${statement.id === report.statement?.id ? " selected" : ""}>${esc(statement.name)} · ${dateLabel(statement.from)} to ${dateLabel(statement.to)} · ${statement.rowCount} rows</option>`).join("")}</select></label>` : '<p class="quiet">Import the statement for the period you want to review.</p>'}</div>
    <details class="reconciliation-import"${statements.length ? "" : " open"}><summary>Import bank statement CSV</summary><form id="bank-statement-import" class="reconciliation-form">
      <label class="reconciliation-wide">CSV file<input type="file" name="file" accept=".csv,text/csv" required></label>
      <label>Statement name<input name="name" maxlength="100" required></label>
      <label>Date format<select name="dateFormat"><option value="dd/mm/yyyy">Day / month / year</option><option value="yyyy-mm-dd">Year-month-day</option><option value="mm/dd/yyyy">Month / day / year</option></select></label>
      <label>From<input name="from" type="date" value="${esc(report.company.booksFrom)}" min="${esc(report.company.booksFrom)}" required></label>
      <label>To<input name="to" type="date" value="${todayISO()}" required></label>
      <label>Statement opening ₹<input name="opening" inputmode="decimal" placeholder="0.00" required></label>
      <label>Statement closing ₹<input name="closing" inputmode="decimal" placeholder="0.00" required></label>
      <p class="quiet reconciliation-wide">Use a minus sign for an overdraft balance.</p>
      <div data-csv-mapping class="reconciliation-wide"></div>
      <p data-import-error class="reconciliation-wide" role="alert"></p><div class="actions reconciliation-wide"><button type="submit" disabled>Preview statement</button></div>
      <div data-statement-preview class="reconciliation-wide"></div>
    </form></details>
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
      mapping.innerHTML = `<div class="reconciliation-form"><label>Amount columns<select name="amountMode"><option value="split"${debit >= 0 && credit >= 0 ? " selected" : ""}>Separate debit / credit</option><option value="signed"${debit < 0 || credit < 0 ? " selected" : ""}>One signed amount</option></select></label>
        <label data-signed-mapping>Positive signed amount means<select name="signedConvention"><option value="credit-positive">Money in</option><option value="debit-positive">Money out</option></select></label>
        ${select("mapDate", "Date column", dateColumn)}${select("mapReference", "Reference column", guess(/ref|utr|cheque|chq|transaction id/i))}
        ${select("mapNarration", "Description column", guess(/description|narration|particulars|details/i))}
        <div data-signed-mapping>${select("mapAmount", "Signed amount column", signed)}</div><div data-split-mapping>${select("mapDebit", "Debit / money out column", debit)}</div><div data-split-mapping>${select("mapCredit", "Credit / money in column", credit)}</div></div>`;
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
      preview.innerHTML = `<h3>Statement preview</h3><p>${statement.rows.length} transaction rows${statement.ignoredRows.length ? ` · ${statement.ignoredRows.length} zero-movement rows excluded` : ""}</p><table><tbody><tr><th>Opening ₹</th><td class="figure">${money(statement.openingPaise)}</td></tr><tr><th>Closing from CSV movements ₹</th><td class="figure">${money(statement.computedClosingPaise)}</td></tr><tr><th>Reported closing ₹</th><td class="figure">${money(statement.closingPaise)}</td></tr><tr class="total"><th>Difference ₹</th><td class="figure">${money(difference)}</td></tr></tbody></table><table><thead><tr><th>Date</th><th>Reference / description</th><th class="figure">Money in ₹</th><th class="figure">Money out ₹</th></tr></thead><tbody>${statement.rows.slice(0, 10).map(row => `<tr><td>${dateLabel(row.date)}</td><td>${esc(row.reference)}<small>${esc(row.narration)}</small></td><td class="figure">${row.amountPaise > 0 ? money(row.amountPaise) : "—"}</td><td class="figure">${row.amountPaise < 0 ? money(-row.amountPaise) : "—"}</td></tr>`).join("")}</tbody></table><p class="quiet">First ${Math.min(10, statement.rows.length)} rows shown.</p><button type="button" data-import-reviewed>Import for review</button>`;
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
  area.innerHTML = `<section class="reconciliation-section"><h2>${esc(report.statement.name)}</h2><p>${dateLabel(report.statement.from)} to ${dateLabel(report.statement.to)} · ${report.matches.length} confirmed match${report.matches.length === 1 ? "" : "es"} · ${report.rows.filter(row => !row.matched).length} statement rows open · ${report.bookEntries.filter(row => !row.matched).length} book transactions uncleared</p>
    <div class="reconciliation-balance-grid"><section><h3>Opening comparison</h3><table><tbody><tr><th>Book opening ₹</th><td class="figure">${money(totals.openingBookPaise)}</td></tr><tr><th>Expected bank opening after pending items ₹</th><td class="figure">${money(totals.expectedOpeningBankPaise)}</td></tr><tr><th>Statement opening ₹</th><td class="figure">${money(totals.statementOpeningPaise)}</td></tr><tr class="total"><th>Opening difference ₹</th><td class="figure">${money(totals.openingDifferencePaise)}</td></tr></tbody></table></section>
    <section><h3>Closing comparison</h3><table><tbody><tr><th>Book closing ₹</th><td class="figure">${money(totals.closingBookPaise)}</td></tr><tr><th>Less uncleared book movements ₹</th><td class="figure">${money(totals.unmatchedBookPaise)}</td></tr><tr><th>Add bank movements awaiting books ₹</th><td class="figure">${money(totals.unmatchedStatementPaise)}</td></tr><tr><th>Expected bank closing ₹</th><td class="figure">${money(totals.expectedBankPaise)}</td></tr><tr><th>Statement closing ₹</th><td class="figure">${money(totals.statementClosingPaise)}</td></tr><tr class="total"><th>Unexplained difference ₹</th><td class="figure">${money(totals.differencePaise)}</td></tr><tr><th>CSV arithmetic difference ₹</th><td class="figure">${money(totals.statementArithmeticDifferencePaise)}</td></tr></tbody></table></section></div>
    <details class="reconciliation-opening"><summary>Transactions pending at the beginning of this statement</summary><form id="bank-opening-pending"><div data-opening-choices></div><p data-opening-error role="alert"></p><button type="submit">Save opening pending items</button></form></details>
    <label class="reconciliation-search">Find a date, reference or description<input type="search" data-bank-search placeholder="Search both sides and confirmed matches"></label>
    <div class="reconciliation-match-bar"><span data-selected-totals>No transactions selected.</span><button type="button" data-confirm-bank-match disabled>Confirm selected match</button></div><p data-match-error role="alert"></p>
    <div class="reconciliation-match-grid"><section><h3>Statement rows awaiting match</h3><div data-statement-rows></div></section><section><h3>Book transactions awaiting clearance</h3><div data-book-rows></div></section></div>
    <section class="reconciliation-section"><h3>Confirmed matches</h3><div data-confirmed-matches></div></section><button type="button" class="ghost" data-more-bank>Show 200 more rows</button>
    <details class="reconciliation-audit"><summary>Change history</summary><div data-audit-rows></div></details></section>`;
  const selectedRows = new Set(), selectedBooks = new Set(), openingIds = new Set(report.statement.openingPendingVoucherIds);
  let limit = 200;
  const query = () => area.querySelector("[data-bank-search]").value.trim().toLowerCase();
  const includes = row => !query() || [row.date, dateLabel(row.date), row.reference, row.number, row.narration].join(" ").toLowerCase().includes(query());
  const selectedTotals = () => {
    const rows = report.rows.filter(row => selectedRows.has(row.id)), entries = report.bookEntries.filter(row => selectedBooks.has(row.voucherId));
    const rowTotal = rows.reduce((total, row) => total + row.amountPaise, 0), bookTotal = entries.reduce((total, row) => total + row.amountPaise, 0);
    area.querySelector("[data-selected-totals]").textContent = `${rows.length} bank rows · ₹ ${formatINR(rowTotal)} / ${entries.length} book transactions · ₹ ${formatINR(bookTotal)}`;
    const sameDirection = new Set([...rows, ...entries].map(row => Math.sign(row.amountPaise))).size === 1;
    if (rows.length && entries.length && !sameDirection) area.querySelector("[data-selected-totals]").textContent += " · Choose one money direction";
    area.querySelector("[data-confirm-bank-match]").disabled = !rows.length || !entries.length || rowTotal !== bookTotal || !sameDirection || rows.length > 100 || entries.length > 100;
  };
  const draw = () => {
    const rows = report.rows.filter(row => !row.matched && includes(row));
    const entries = report.bookEntries.filter(row => !row.matched && includes(row));
    const matches = report.matches.filter(match => match.rows.some(includes) || match.entries.some(includes));
    const old = report.openingChoices.filter(includes);
    area.querySelector("[data-statement-rows]").innerHTML = `<table><thead><tr><th></th><th>Date / reference</th><th class="figure">Amount ₹</th></tr></thead><tbody>${rows.slice(0, limit).map(row => `<tr><td><input type="checkbox" data-row-id="${esc(row.id)}" aria-label="Select bank row ${row.sourceRow}"${selectedRows.has(row.id) ? " checked" : ""}></td><td>${dateLabel(row.date)}<strong class="reconciliation-detail">${esc(row.reference || "No reference")}</strong><small>${esc(row.narration)}</small>${row.possibleDuplicate ? '<small class="reconciliation-attention">Also present in another imported statement</small>' : ""}${row.candidateKind === "ambiguous" ? '<small class="reconciliation-attention">Multiple possible matches</small>' : ""}${row.candidates.map(candidate => `<button type="button" class="reconciliation-candidate" data-candidate-row="${esc(row.id)}" data-candidate-voucher="${esc(candidate.voucherId)}">Select ${esc(candidate.number)}${row.candidateKind === "amount-date-reference" ? " · same amount, date & reference" : " · same amount & date"}</button>`).join("")}</td><td class="figure">${money(row.amountPaise)}</td></tr>`).join("") || '<tr><td colspan="3" class="quiet">No matching open bank rows.</td></tr>'}</tbody></table>`;
    area.querySelector("[data-book-rows]").innerHTML = `<table><thead><tr><th></th><th>Date / voucher</th><th class="figure">Amount ₹</th></tr></thead><tbody>${entries.slice(0, limit).map(entry => `<tr><td><input type="checkbox" data-voucher-id="${esc(entry.voucherId)}" aria-label="Select book voucher ${esc(entry.number)}"${selectedBooks.has(entry.voucherId) ? " checked" : ""}></td><td>${dateLabel(entry.date)}<strong class="reconciliation-detail">${postingLink(entry)}</strong><small>${esc(entry.narration)}</small></td><td class="figure">${money(entry.amountPaise)}</td></tr>`).join("") || '<tr><td colspan="3" class="quiet">No matching uncleared book transactions.</td></tr>'}</tbody></table>`;
    area.querySelector("[data-confirmed-matches]").innerHTML = `<table><thead><tr><th>Bank rows</th><th>Book vouchers</th><th></th></tr></thead><tbody>${matches.slice(0, limit).map(match => `<tr><td>${match.rows.map(row => `${dateLabel(row.date)} · ${esc(row.reference)} · ₹ ${money(row.amountPaise)}`).join("<br>")}</td><td>${match.entries.map(postingLink).join("<br>")}</td><td><button type="button" class="ghost" data-unmatch="${esc(match.id)}">Unmatch</button></td></tr>`).join("") || '<tr><td colspan="3" class="quiet">No confirmed matches for this search.</td></tr>'}</tbody></table>`;
    area.querySelector("[data-opening-choices]").innerHTML = old.slice(0, limit).map(entry => `<label class="reconciliation-check"><input type="checkbox" data-opening-voucher="${esc(entry.voucherId)}"${openingIds.has(entry.voucherId) ? " checked" : ""}><span>${dateLabel(entry.date)} · ${esc(entry.number)} · ₹ ${money(entry.amountPaise)}</span></label>`).join("") || '<p class="quiet">No older bank postings match this search.</p>';
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
      try {
        if (await save("unmatch-bank", { matchId: unmatch.dataset.unmatch }, unmatch, "Bank match removed.", report.revision)) await refresh();
      } catch (failure) { errorAt(area.querySelector("[data-match-error]"), failure); }
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
  const { root, api, still, token, route, base, esc, money, postingLink, render, errorAt, save, refresh } = ctx;
  const storageKey = `financer-bills-filter:${route.id}`;
  let filter;
  try { filter = JSON.parse(sessionStorage.getItem(storageKey) || "null"); } catch { filter = null; }
  const asOf = filter?.asOf || todayISO(), ledgerId = filter?.ledgerId || "";
  const report = await api(`${base}/bills?asOf=${encodeURIComponent(asOf)}&ledgerId=${encodeURIComponent(ledgerId)}`);
  if (!still(token)) return;
  const partyLabel = id => report.parties.find(party => party.id === id)?.name || "";
  const sideLabel = side => side === "receivable" ? "Receivable" : "Payable";
  render(report.company, "Bill-wise outstanding", `<form id="bill-report-filter" class="reconciliation-controls"><label>As on<input type="date" name="asOf" value="${esc(report.asOf)}" min="${esc(report.company.booksFrom)}" required></label><label>Party ledger<select name="ledgerId"><option value="">All debtors & creditors</option>${report.parties.map(party => `<option value="${esc(party.id)}"${party.id === ledgerId ? " selected" : ""}>${esc(party.name)} · ${sideLabel(party.side)}</option>`).join("")}</select></label><button type="submit">View</button><button type="button" class="ghost" data-reconciliation-print>Print outstanding</button></form>
    <p class="reconciliation-print-context">As on ${dateLabel(report.asOf)} · ${esc(ledgerId ? partyLabel(ledgerId) : "All debtors & creditors")}</p>
    <table class="reconciliation-ageing"><thead><tr><th>Due-date ageing ₹</th><th class="figure">Current</th><th class="figure">1–30 days</th><th class="figure">31–60</th><th class="figure">61–90</th><th class="figure">90+</th></tr></thead><tbody>${report.ageing.map(row => `<tr><th scope="row">${sideLabel(row.side)}</th>${["current", "1–30", "31–60", "61–90", "90+"].map(bucket => `<td class="figure">${money(row.buckets[bucket])}</td>`).join("")}</tr>`).join("")}</tbody></table>
    <label class="reconciliation-search">Find party, bill or voucher<input type="search" data-bill-search></label><label class="reconciliation-check reconciliation-show-settled"><input type="checkbox" data-show-settled><span>Include settled bills</span></label>
    <section class="reconciliation-section"><h2>Bill references</h2><div data-bill-rows></div></section>
    <details class="reconciliation-reference"${report.rows.length ? "" : " open"}><summary data-reference-summary>Create bill reference</summary><form id="bill-reference-form" class="reconciliation-form"><input type="hidden" name="billId"><label class="reconciliation-wide">Source posting<select name="sourceKey" required><option value="">Choose an unreferenced posting</option></select></label><label>Reference<input name="reference" maxlength="80" required></label><label>Due date<input name="dueDate" type="date" required></label><label>Reference amount ₹<input name="amount" inputmode="decimal" required></label><p data-reference-error class="reconciliation-wide" role="alert"></p><div class="actions reconciliation-wide"><button type="submit">Save reference</button><button type="button" class="ghost" data-clear-reference>New reference</button></div></form></details>
    <section class="reconciliation-section"><h2>Receipts, payments & advances</h2><div data-settlement-rows></div></section>
    <details class="reconciliation-allocation"><summary>Allocate a settlement against a bill</summary><form id="bill-allocation-form" class="reconciliation-form"><label class="reconciliation-wide">Open bill<select name="billId" required><option value="">Choose a bill</option>${report.rows.filter(row => row.openPaise > 0).map(row => `<option value="${esc(row.id)}">${esc(row.partyName)} · ${esc(row.reference)} · ₹ ${money(row.openPaise)} open</option>`).join("")}</select></label><label class="reconciliation-wide">Receipt / payment / credit / advance<select name="creditKey" required><option value="">Choose the bill first</option></select></label><label>Allocation date<input name="date" type="date" value="${esc(report.asOf)}" required></label><label>Amount to allocate ₹<input name="amount" inputmode="decimal" required></label><p data-allocation-error class="reconciliation-wide" role="alert"></p><button type="submit">Save allocation</button></form></details>
    <section class="reconciliation-section"><h2>Allocation trail</h2><div data-allocation-rows></div><p data-allocation-action-error role="alert"></p></section>
    <section class="reconciliation-section"><h2>On-account postings awaiting a reference</h2><div data-unreferenced-rows></div></section>
    <section class="reconciliation-section"><h2>Agreement with party ledgers</h2><div data-party-totals></div></section>
    <button type="button" class="ghost" data-more-bills>Show 200 more rows</button><p data-print-search class="reconciliation-print-context"></p>
    <details class="reconciliation-audit"><summary>Change history</summary><div data-audit-rows></div></details>`, "Bo");
  root.querySelector("#bill-report-filter").addEventListener("submit", async event => {
    event.preventDefault();
    if (!event.target.reportValidity()) return;
    sessionStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(new FormData(event.target))));
    await refresh();
  });
  let limit = 200;
  const query = () => root.querySelector("[data-bill-search]").value.trim().toLowerCase();
  const includes = row => !query() || [row.partyName, row.reference, row.number, row.narration, row.bill?.reference, row.settlement?.number].join(" ").toLowerCase().includes(query());
  const draw = () => {
    const rows = report.rows.filter(row => (row.openPaise > 0 || root.querySelector("[data-show-settled]").checked) && includes(row));
    const settlements = report.settlements.filter(includes), allocations = report.allocations.filter(includes), unreferenced = report.unreferenced.filter(includes);
    root.querySelector("[data-bill-rows]").innerHTML = `<table><thead><tr><th>Party / bill</th><th>Due / overdue</th><th class="figure">Bill ₹</th><th class="figure">Allocated ₹</th><th class="figure">Open ₹</th><th></th></tr></thead><tbody>${rows.slice(0, limit).map(row => `<tr><th scope="row">${esc(row.partyName)}<button type="button" class="reconciliation-reference-link" data-edit-bill="${esc(row.id)}">${esc(row.reference)}</button><small>${postingLink(row.source)}</small></th><td>${dateLabel(row.dueDate)}<small>${row.openPaise ? row.daysOverdue ? `${row.daysOverdue} days overdue` : "Current" : "Settled"}</small></td><td class="figure">${money(row.amountPaise)}</td><td class="figure">${money(row.paidPaise)}</td><td class="figure">${money(row.openPaise)}</td><td>${!row.derived ? `<button type="button" class="ghost" data-remove-bill="${esc(row.id)}">Remove reference</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="6" class="quiet">No open bills match this report.</td></tr>'}</tbody></table>`;
    root.querySelector("[data-settlement-rows]").innerHTML = `<table><thead><tr><th>Party / voucher</th><th>Date</th><th class="figure">Settlement ₹</th><th class="figure">Allocated ₹</th><th class="figure">Unallocated / advance ₹</th></tr></thead><tbody>${settlements.slice(0, limit).map(row => `<tr><th scope="row">${esc(row.partyName)}<span class="reconciliation-detail">${postingLink(row)}</span><small>${esc(row.type)}</small></th><td>${dateLabel(row.date)}</td><td class="figure">${money(-row.amountPaise)}</td><td class="figure">${money(row.allocatedPaise)}</td><td class="figure">${money(row.remainingPaise)}</td></tr>`).join("") || '<tr><td colspan="5" class="quiet">No settlements match this report.</td></tr>'}</tbody></table>`;
    root.querySelector("[data-allocation-rows]").innerHTML = `<table><thead><tr><th>Party / bill</th><th>Settlement source</th><th>Date</th><th class="figure">Allocated ₹</th><th></th></tr></thead><tbody>${allocations.slice(0, limit).map(row => `<tr><th scope="row">${esc(row.partyName)}<span class="reconciliation-detail">${esc(row.bill?.reference || row.billId)}</span><small>${postingLink(row.bill?.source || report.rows.find(bill => bill.id === row.billId)?.source)}</small></th><td>${postingLink(row.settlement)}</td><td>${dateLabel(row.date)}</td><td class="figure">${money(row.paise)}</td><td><button type="button" class="ghost" data-unallocate="${esc(row.id)}">Remove allocation</button></td></tr>`).join("") || '<tr><td colspan="5" class="quiet">No bill allocations for this report.</td></tr>'}</tbody></table>`;
    root.querySelector("[data-unreferenced-rows]").innerHTML = `<table><thead><tr><th>Party / source</th><th>Date</th><th class="figure">Awaiting reference ₹</th></tr></thead><tbody>${unreferenced.slice(0, limit).map(row => `<tr><th scope="row">${esc(row.partyName)}<span class="reconciliation-detail">${postingLink(row)}</span></th><td>${dateLabel(row.date)}</td><td class="figure">${money(row.remainingPaise)}</td></tr>`).join("") || '<tr><td colspan="3" class="quiet">No unreferenced postings match this report.</td></tr>'}</tbody></table>`;
    root.querySelector("[data-party-totals]").innerHTML = `<table><thead><tr><th>Party</th><th class="figure">Open bills ₹</th><th class="figure">On account ₹</th><th class="figure">Less advances ₹</th><th class="figure">Ledger ₹</th><th class="figure">Difference ₹</th></tr></thead><tbody>${report.totals.filter(row => !query() || row.name.toLowerCase().includes(query())).slice(0, limit).map(row => `<tr><th scope="row">${esc(row.name)}<small>${sideLabel(row.side)}</small></th><td class="figure">${money(row.outstandingPaise)}</td><td class="figure">${money(row.onAccountPaise)}</td><td class="figure">${money(row.advancePaise)}</td><td class="figure">${money(row.ledgerPaise)}</td><td class="figure">${money(row.differencePaise)}</td></tr>`).join("")}</tbody></table>`;
    root.querySelector("[data-more-bills]").hidden = ![rows, settlements, allocations, unreferenced, report.totals].some(list => list.length > limit);
    root.querySelector("[data-print-search]").textContent = query() ? `Filtered by ${root.querySelector("[data-bill-search]").value}` : "";
  };
  const sourceChoices = new Map([...report.rows.map(row => ({ ...row.source, partyName: row.partyName, remainingPaise: row.amountPaise })), ...report.unreferenced].map(source => [source.key, source]));
  const referenceForm = root.querySelector("#bill-reference-form");
  const sourceOption = source => `<option value="${esc(source.key)}">${esc(source.partyName)} · ${esc(source.number)} · ${dateLabel(source.date)}</option>`;
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
    allocationForm.elements.creditKey.innerHTML = '<option value="">Choose a settlement</option>' + report.settlements.filter(row => row.remainingPaise > 0 && row.ledgerId === bill?.ledgerId).map(row => `<option value="${esc(row.key)}">${esc(row.number)} · ${dateLabel(row.date)} · ₹ ${money(row.remainingPaise)} available</option>`).join("");
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
    try {
      const action = remove ? "remove-bill" : "unallocate-bill";
      const input = remove ? { billId: remove.dataset.removeBill } : { allocationId: unallocate.dataset.unallocate };
      if (await save(action, input, button, remove ? "Bill reference removed." : "Allocation removed.", report.revision)) await refresh();
    } catch (failure) { errorAt(root.querySelector("[data-allocation-action-error]"), failure); }
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
      area.innerHTML = `<table><thead><tr><th>Saved</th><th>Change</th><th>Reference</th></tr></thead><tbody>${rows.slice().reverse().map(row => `<tr><td>${esc(new Date(row.at).toLocaleString("en-GB"))}</td><td>${esc(row.action.replace(/-/g, " "))}</td><td class="reconciliation-code">${esc(row.result?.id || "")}</td></tr>`).join("") || '<tr><td colspan="3" class="quiet">No reconciliation changes yet.</td></tr>'}</tbody></table>`;
    } catch (failure) { area.textContent = failure.message; }
  });
}
