import { formatINR, parseRupees } from "/money.js";

const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.split("-").reverse().join("-") : value || "—";
const costingLabel = value => value === "moving-average" ? "Moving average" : "FIFO";
const rupees = value => value === null || value === undefined ? "" : (value / 100).toFixed(2);
const journalLabels = { transfer: "Godown transfer", adjustment: "Stock adjustment", physical: "Physical count", receipt: "Imported receipt", issue: "Imported issue" };
const withQuery = (path, values) => { const query = new URLSearchParams(values).toString(); return query ? `${path}?${query}` : path; };

/* One beforeprint listener for the whole session. Each render points it at its own view. */
let preparePrint = null;
let printListenerAdded = false;

function quantityUnits(value) {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(String(value));
  if (!match) throw new Error("Enter a quantity with up to six decimal places");
  return (match[1] ? -1n : 1n) * (BigInt(match[2]) * 1000000n + BigInt((match[3] || "").padEnd(6, "0")));
}
function quantityText(value) {
  const sign = value < 0n ? "−" : "";
  const absolute = value < 0n ? -value : value;
  const fraction = String(absolute % 1000000n).padStart(6, "0").replace(/0+$/, "");
  return sign + absolute / 1000000n + (fraction ? "." + fraction : "");
}

export async function viewStock(route, token, ui) {
  if (!["stock", "stock-item"].includes(route.name)) return false;
  if (!route.id) throw new Error("Open a company to review stock");
  const { root, api, still, page, esc, readPeriod } = ui;
  const base = `/api/companies/${encodeURIComponent(route.id)}/stock`;
  const book = `#/c/${encodeURIComponent(route.id)}`;
  const routePath = `${book}/${route.name}${route.detail ? "/" + encodeURIComponent(route.detail) : ""}`;
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const meta = await api(`/api/companies/${encodeURIComponent(route.id)}/meta`);
  if (!still(token)) return true;
  /* The books period comes from the top bar. Links from statements may still pin a range with ?from and ?to. */
  const period = readPeriod(meta.company);
  const from = params.get("from") || period.from;
  const to = params.get("to") || period.to;
  const pinned = (params.has("from") || params.has("to")) && (from !== period.from || to !== period.to);
  const pinnedRange = pinned ? { from, to } : {};
  const query = new URLSearchParams({ from, to });
  const reportQuery = new URLSearchParams(query);
  if (params.get("godown")) reportQuery.set("godownId", params.get("godown"));
  const report = await api(`${base}${route.name === "stock-item" ? "/items/" + encodeURIComponent(route.detail) : ""}?${reportQuery}`);
  if (!still(token)) return true;
  const godowns = report.godowns?.length ? report.godowns : [{ id: "main", name: "Main Location" }];
  let godownId = godowns.some(row => row.id === params.get("godown")) ? params.get("godown") : "";
  const item = route.name === "stock-item" ? report.items.find(row => row.itemId === route.detail) : null;
  if (route.name === "stock-item" && !item) throw new Error("This stock item is not in the current company");
  let journalSequence = 0;
  let journalHistory = { rows: (report.journals || []).slice(0, 50), total: report.journalPage?.total ?? report.journals?.length ?? 0,
    offset: report.journalPage?.offset || 0, limit: 50, loading: false, error: "", requestedOffset: 0 };
  const draftKey = `financer-stock-draft:${route.id}:${route.name}:${route.detail || ""}`;
  const flashKey = `financer-stock-flash:${route.id}`;
  let draft;
  try { draft = JSON.parse(localStorage.getItem(draftKey) || "null") || {}; } catch { draft = {}; }
  const dirtyForms = new Set(Object.keys(draft.forms || {}));
  const incomplete = '<span class="pill warn">Incomplete</span>';
  const money = value => value === null || value === undefined ? incomplete : `₹ ${esc(formatINR(value))}`;
  const amount = value => value === null || value === undefined ? incomplete : esc(formatINR(value));
  const locationName = id => godowns.find(row => row.id === id)?.name || id || "Main Location";
  const godownQuery = () => godownId ? { godown: godownId } : {};
  const itemLink = id => withQuery(`${book}/stock-item/${encodeURIComponent(id)}`, { ...pinnedRange, ...godownQuery() });
  const godownOptions = (selected, all = false) => (all ? '<option value="">All godowns</option>' : "") + godowns.map(row => `<option value="${esc(row.id)}"${row.id === selected ? " selected" : ""}>${esc(row.name)}</option>`).join("");
  const selectedStock = row => !godownId ? row : row.godowns?.find(location => location.godownId === godownId) || (row.godowns ? { quantity: "0", valuePaise: 0, knownValuePaise: 0, complete: true } : { quantity: "—", valuePaise: null, knownValuePaise: 0, complete: false });
  const issueRows = (issues = []) => issues.map(issue => {
    const other = issue.itemId && issue.itemId !== item?.itemId ? `<a href="${itemLink(issue.itemId)}">${esc(report.items.find(row => row.itemId === issue.itemId)?.name || "Item")}</a>: ` : "";
    const source = issue.sourceId && (item?.movements || []).some(movement => movement.sourceId === issue.sourceId && movement.sourceType === "gst") ? ` <a href="${book}/gst-document/${encodeURIComponent(issue.sourceId)}">Review source invoice</a>` : "";
    return `<li>${other}${esc(issue.message || issue.reason || issue.code || String(issue))}${source}</li>`;
  }).join("");
  const status = sessionStorage.getItem(flashKey) || "";
  sessionStorage.removeItem(flashKey);
  document.title = `${item ? item.name + " · Item ledger" : "Stock summary"} · ${report.company.name}`;
  const tallySource = report.company.source?.system === "tally" || report.items.some(row => row.masterKind === "tally") || (report.issues || []).some(issue => /^tally-|^source-stock-gaps$/.test(issue.code || ""));
  const tallyLink = `${book}/tally-source?review=stock`;
  const settings = item ? report.itemSettings?.[item.itemId] || {} : null;
  let allocations = item ? draft.openingAllocations || structuredClone(settings.openingAllocations?.length ? settings.openingAllocations : quantityUnits(item.openingQuantity || "0") === 0n ? [] : [{ godownId: godowns[0].id, quantity: String(item.openingQuantity), valuePaise: settings.openingValuePaise ?? null }]).map(row => ({ godownId: row.godownId, quantity: row.quantity, value: rupees(row.valuePaise) })) : [];
  const freshJournalLine = () => ({ itemId: report.items[0]?.itemId || "", godownId: godowns[0].id, fromGodownId: godowns[0].id, toGodownId: godowns[1]?.id || godowns[0].id, quantity: "1", direction: "in", value: "", reason: "" });
  let journalLines = draft.journalLines?.length ? draft.journalLines : [freshJournalLine()];
  const rangeEcho = pinned
    ? `<span class="period-echo">${esc(dateLabel(from))} to ${esc(dateLabel(to))}, as linked from the statement. <a href="${withQuery(routePath, godownQuery())}">Use the books period</a></span>`
    : `<span class="period-echo">${esc(dateLabel(from))} to ${esc(dateLabel(to))} <button type="button" class="link" data-focus-period>Change period</button></span>`;
  const sheetTools = `<div class="sheet-tools">${rangeEcho}<button type="button" class="ghost" data-stock-print>Print ${item ? "item ledger" : "stock summary"}</button></div>`;
  const reportControls = `<form id="stock-period" class="toolbar stock-filter" aria-label="Stock filter"><label>Godown<select name="godown">${godownOptions(godownId, true)}</select></label></form><p class="only-print" data-stock-context></p>`;
  const check = report.financialCheck;
  const financial = !check ? "" : `<div class="stock-financial-check"><h3>Opening stock in the accounts</h3><dl class="kv"><dt>Stock-in-Hand ledgers</dt><dd>${money(check.openingLedgerPaise)}</dd><dt>Item register</dt><dd>${money(check.openingInventoryPaise)}</dd></dl>${check.reason ? `<p class="attention-rule">${esc(check.reason)}</p>` : '<p><span class="pill ok">Agrees</span> Opening item values agree with the opening stock ledgers.</p>'}<p><a href="${book}/ledgers">Review stock ledgers</a></p>${item ? "" : '<p class="quiet">To review an item’s opening cost, open the item from the table above.</p>'}</div>`;
  const integration = `<details data-stock-section="accounts"><summary>Inventory in financial statements</summary>${financial}<form id="stock-integration" class="form-grid" data-stock-draft><label class="check wide"><input type="checkbox" name="integrateAccounts"${report.settings?.integrateAccounts ? " checked" : ""}><span>Use this stock register’s valuation in financial statements<small>Save this setting after you review the opening stock and any valuation gaps.</small></span></label><div class="actions wide"><button>Save inventory setting</button></div><p data-stock-error class="form-message wide" role="alert"></p></form></details>`;
  const costing = settings?.costingMethod || item?.costingMethod;
  const itemSettings = !item ? "" : `<details data-stock-section="cost"><summary>Costing and opening stock</summary><form id="stock-item-settings" class="form-grid" data-stock-draft><label>Costing method<select name="costingMethod"><option value="fifo"${costing === "fifo" ? " selected" : ""}>FIFO, perpetual</option><option value="moving-average"${costing === "moving-average" ? " selected" : ""}>Moving average, perpetual</option></select></label><label>Total opening value ₹<input name="openingValue" inputmode="decimal" value="${esc(rupees(settings.openingValuePaise))}" placeholder="Not valued"></label><p class="form-note wide">The opening quantity of ${esc(item.openingQuantity || "0")} ${esc(item.unit)} comes from the item master.${item.masterKind === "tally" ? ` <a href="${tallyLink}">Review Tally stock</a> to change its source quantity.` : ` <a href="${book}/gst">Edit the quantity in GST setup</a>.`} A blank cost stays unvalued. Enter a value for every allocation, or leave every allocation blank and enter the total.</p><div class="wide table-scroll"><table class="stock-entry-table"><thead><tr><th>Opening godown</th><th class="figure">Quantity</th><th class="figure">Opening value ₹</th><th><span class="sr">Remove</span></th></tr></thead><tbody data-opening-allocations></tbody></table></div><div class="wide actions"><button type="button" class="ghost" data-add-allocation>Add opening allocation</button><span class="quiet" data-allocation-total></span></div><div class="actions wide"><button>Save item costing</button></div><p data-stock-error class="form-message wide" role="alert"></p></form></details>`;
  const godownEditor = `<details data-stock-section="godowns"><summary>Godowns <small>${godowns.length === 1 ? "1 godown" : godowns.length + " godowns"}</small></summary><div class="table-scroll"><table class="stock-godown-list"><thead><tr><th>Godown</th><th>Code</th></tr></thead><tbody>${godowns.map(row => `<tr><th scope="row">${esc(row.name)}</th><td class="code">${esc(row.id)}</td></tr>`).join("")}</tbody></table></div><form id="stock-godown" class="form-grid" data-stock-draft><label>New godown name<input name="name" maxlength="80" required autocomplete="off"></label><div class="actions wide"><button>Add godown</button></div><p data-stock-error class="form-message wide" role="alert"></p></form></details>`;
  const journalEditor = `<details data-stock-section="journal"><summary>Record a stock movement</summary>${report.items.length ? `<form id="stock-journal" class="form-grid" data-stock-draft><label>Movement<select name="type"><option value="transfer">Transfer between godowns</option><option value="adjustment">Stock adjustment</option><option value="physical">Physical count</option></select></label><label>Date<input name="date" type="date" min="${esc(report.company.booksFrom)}" value="${esc(to)}" required></label><label>Journal number<input name="number" maxlength="24" required autocomplete="off"></label><p class="form-note wide" data-journal-help></p><div class="wide" data-journal-lines></div><div class="actions wide"><button type="button" class="ghost" data-add-stock-line>Add line</button></div><div class="actions wide"><button>Post stock journal <kbd aria-hidden="true">⌘↩</kbd></button></div><p data-stock-error class="form-message wide" role="alert"></p></form>` : `<p class="empty">Add a goods item in <a href="${book}/gst">GST setup</a> before you record a stock movement.</p>`}</details>`;
  const issues = item?.issues || report.issues || [];
  const gaps = issues.length ? `<section class="subsection stock-gaps"><h2>Valuation needs attention</h2><ul class="attention-rule">${issueRows(issues)}</ul><p>${item ? "Review this item’s opening costs below, or open the source document for its purchase cost." : "Open the affected item to review its cost sources and opening allocations."}</p></section>` : "";
  const itemHead = item ? `<p class="stock-back"><a href="${withQuery(`${book}/stock`, pinnedRange)}">All stock items</a></p><p class="stock-facts">Counted in ${esc(item.unit)}. Valued by ${esc(costingLabel(item.costingMethod))}.</p>` : "";
  const tallyNote = tallySource ? `<p class="notice stock-source-action">Check the source allocations and any unsupported stock before you activate it. <a href="${tallyLink}">Review Tally stock</a></p>` : "";
  root.innerHTML = page({ company: report.company, title: item ? item.name : "Stock summary", kicker: item ? "Item ledger" : "Inventory", folio: item ? "Il" : "St", status, body: `<div class="stock-workspace">${itemHead}${sheetTools}${reportControls}${tallyNote}<div data-stock-summary></div>${item ? '<section class="subsection stock-history"><h2>Item movements</h2><div data-stock-movements></div></section>' : ""}${gaps}<div class="details-list stock-editors">${itemSettings}${!item ? integration + godownEditor + journalEditor : ""}</div><section class="subsection stock-history"><h2>Stock journal history</h2><div class="details-list" data-stock-journals></div></section></div>` });

  for (const form of root.querySelectorAll("[data-stock-draft]")) {
    const values = draft.forms?.[form.id];
    if (!values) continue;
    for (const [name, value] of Object.entries(values)) if (form.elements[name]) {
      if (form.elements[name].type === "checkbox") form.elements[name].checked = value === true;
      else form.elements[name].value = value;
    }
    form.closest("details").open = true;
  }
  const allocationRows = root.querySelector("[data-opening-allocations]");
  const journalRows = root.querySelector("[data-journal-lines]");
  const historyRoot = root.querySelector("[data-stock-journals]");
  const collectRows = target => target ? [...target.children].map(row => Object.fromEntries([...row.querySelectorAll("[data-field]")].map(input => [input.dataset.field, input.value]))) : [];
  const remember = () => {
    const forms = Object.fromEntries([...root.querySelectorAll("[data-stock-draft]")].filter(form => dirtyForms.has(form.id)).map(form => [form.id, Object.fromEntries([...form.querySelectorAll("[name]")].map(input => [input.name, input.type === "checkbox" ? input.checked : input.value]))]));
    draft = { forms, ...(dirtyForms.has("stock-item-settings") ? { openingAllocations: collectRows(allocationRows) } : {}), ...(dirtyForms.has("stock-journal") ? { journalLines: collectRows(journalRows) } : {}) };
    try { localStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* Current forms remain usable if local storage is full. */ }
  };
  const showError = (form, error) => { const target = form.querySelector("[data-stock-error]"); target.className = "form-message alert wide"; target.textContent = error.message; target.scrollIntoView({ block: "nearest" }); };
  let saving = false;
  const bindSave = (selector, endpoint, method, collect, message) => {
    const form = root.querySelector(selector);
    if (!form) return;
    form.addEventListener("input", () => { delete form.dataset.requestId; });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (saving || form.dataset.busy === "true" || !form.reportValidity()) return;
      const controls = [...form.elements].filter(control => !control.disabled);
      const saveButtons = [...root.querySelectorAll('[data-stock-draft] button:not([type="button"])')].filter(button => !button.disabled);
      try {
        const payload = collect(form);
        form.dataset.requestId ||= crypto.randomUUID();
        form.dataset.busy = "true";
        saving = true;
        for (const button of saveButtons) button.disabled = true;
        for (const control of controls) control.disabled = true;
        await api(base + endpoint, { method, body: { ...payload, revision: report.revision, requestId: form.dataset.requestId } });
        if (!still(token)) return;
        remember();
        delete draft.forms[form.id];
        dirtyForms.delete(form.id);
        if (form.id === "stock-item-settings") delete draft.openingAllocations;
        if (form.id === "stock-journal") delete draft.journalLines;
        try { localStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* A confirmed save does not depend on draft storage. */ }
        sessionStorage.setItem(flashKey, message);
        await viewStock(route, token, ui);
      } catch (error) { if (still(token)) showError(form, error); }
      finally { saving = false; form.dataset.busy = "false"; for (const control of controls) control.disabled = false; for (const button of saveButtons) button.disabled = false; }
    });
  };
  const drawSummary = () => {
    const displayed = report.items.map(row => ({ item: row, stock: selectedStock(row) }));
    const issues = item ? item.issues || [] : report.issues || [];
    const complete = displayed.every(({ stock }) => stock.complete !== false && Number.isSafeInteger(stock.valuePaise))
      && (item ? item.complete !== false : report.totals?.complete === true && Number.isSafeInteger(report.totals.valuePaise) && !issues.length);
    const displayedKnown = displayed.reduce((sum, { stock }) => sum + (stock.knownValuePaise ?? stock.valuePaise ?? 0), 0);
    const known = !item && !godownId ? report.totals?.knownValuePaise ?? displayedKnown : displayedKnown;
    const total = complete ? !item && !godownId ? report.totals.valuePaise : displayed.reduce((sum, { stock }) => sum + stock.valuePaise, 0) : null;
    const needsReview = Math.max(displayed.filter(({ stock }) => stock.complete === false || stock.valuePaise == null).length,
      new Set(issues.map(issue => issue.itemId || issue.sourceId || issue.code || issue.message)).size);
    root.querySelector("[data-stock-context]").textContent = `${dateLabel(from)} to ${dateLabel(to)}. ${godownId ? locationName(godownId) : "All godowns"}.`;
    const empty = tallySource ? `No stock items are active yet. <a href="${tallyLink}">Review Tally stock</a> to activate them.` : `No goods items in this company yet. <a href="${book}/gst">Add a goods item in GST setup</a> to start the stock register.`;
    root.querySelector("[data-stock-summary]").innerHTML = `<div class="summary-strip"><div><span>${item ? "Quantity on hand" : "Stock items"}</span><strong>${item ? esc(selectedStock(item).quantity) + " " + esc(item.unit) : displayed.length}</strong></div><div><span>Closing stock value</span><strong>${money(total)}</strong>${complete ? "" : `<small>Known cost ${money(known)}</small>`}</div><div><span>Needs review</span><strong>${needsReview}</strong>${needsReview ? `<small>${item ? "Add the missing cost below." : "Open each flagged item to add its cost."}</small>` : ""}</div></div>${item ? "" : `<div class="table-scroll"><table class="stock-summary-table"><thead><tr><th>Item</th><th>Costing</th><th class="figure">Quantity</th><th class="figure">Closing value ₹</th><th>Review</th></tr></thead><tbody>${displayed.map(({ item: row, stock }) => `<tr><th scope="row"><a href="${itemLink(row.itemId)}">${esc(row.name)}</a><small>${esc(row.unit)}</small></th><td>${esc(costingLabel(row.costingMethod))}</td><td class="figure">${esc(stock.quantity)}</td><td class="figure">${amount(stock.valuePaise)}</td><td>${stock.complete === false || stock.valuePaise == null ? `<span class="pill warn">Cost missing</span> <a href="${itemLink(row.itemId)}">Review cost</a>` : '<span class="pill ok">Valued</span>'}</td></tr>`).join("") || `<tr><td colspan="5" class="quiet">${empty}</td></tr>`}</tbody></table></div>`}`;
  };
  const sourceLink = movement => movement.sourceType === "gst" ? `<a class="code" href="${book}/gst-document/${encodeURIComponent(movement.sourceId)}">${esc(movement.number || movement.sourceId)}</a>` : movement.sourceType === "opening" ? "Opening stock" : !journalHistory.rows.some(journal => journal.id === movement.sourceId) ? `<span class="code">${esc(movement.number || movement.sourceRef?.name || journalLabels[movement.sourceType] || movement.sourceId)}</span>` : `<a class="code" href="#stock-journal-${encodeURIComponent(movement.sourceId)}" data-stock-journal-link="${esc(movement.sourceId)}">${esc(movement.number || journalLabels[movement.sourceType] || movement.sourceId)}</a>`;
  /* Cost lineage names its source the way people know it: opening stock, or the voucher or journal number. */
  const lineageSource = id => {
    if (/^opening:/.test(id || "")) return "Opening stock";
    const number = (item?.movements || []).find(movement => movement.sourceId === id)?.number || journalHistory.rows.find(journal => journal.id === id)?.number;
    return `<span class="code">${esc(number || id)}</span>`;
  };
  const drawMovements = () => {
    if (!item) return;
    const rows = (item.movements || []).filter(row => (!godownId || row.godownId === godownId) && (!row.date || (row.date >= from && row.date <= to)));
    root.querySelector("[data-stock-movements]").innerHTML = `<div class="table-scroll"><table class="stock-movements-table"><thead><tr><th>Date</th><th>Source</th><th>Godown</th><th class="figure">Quantity</th><th class="figure">Balance quantity</th><th class="figure">Cost ₹</th><th class="figure">Balance cost ₹</th><th>Cost sources</th></tr></thead><tbody>${rows.map(row => `<tr><td class="date-cell">${esc(dateLabel(row.date))}</td><td>${sourceLink(row)}</td><td>${esc(row.godownName || locationName(row.godownId))}</td><td class="figure">${esc(row.quantity)}</td><td class="figure">${esc(row.runningQuantity ?? "—")}</td><td class="figure">${amount(row.valuePaise)}</td><td class="figure">${amount(row.runningValuePaise)}</td><td>${row.lineage?.length ? `<details class="stock-lineage"><summary>${row.lineage.length} source(s)</summary><ul>${row.lineage.map(source => `<li><span>${lineageSource(source.sourceId)}</span><span>${esc(source.quantity)} ${esc(item.unit)}</span><span>${money(source.valuePaise)}</span></li>`).join("")}</ul></details>` : esc(row.costBasisReason || (row.valuePaise === null ? "Review valuation gaps" : "Recorded cost"))}</td></tr>`).join("") || '<tr><td colspan="8" class="quiet">No stock movements for this period and godown. Choose another godown or change the period.</td></tr>'}</tbody></table></div>`;
  };
  const drawJournalHistory = () => {
    const { rows, total, offset, limit, loading, error } = journalHistory;
    const range = loading ? "Loading journal history…" : rows.length ? `Showing ${offset + 1}–${Math.min(offset + rows.length, total)} of ${total} journals, newest first.` : error ? "Journal history is unavailable." : `No stock journals for this period and godown.${item ? "" : " Record a stock movement above to add one."}`;
    historyRoot.setAttribute("aria-busy", String(loading));
    historyRoot.innerHTML = `<p class="quiet" data-stock-history-page role="status">${esc(range)}</p>
      ${journalHistory.rows.map(journal => `<details id="stock-journal-${esc(journal.id)}" data-stock-journal="${esc(journal.id)}"><summary><span class="date-cell">${esc(dateLabel(journal.date))}</span><span class="code">${esc(journal.number)}</span><small>${esc(journalLabels[journal.type] || journal.type)}</small></summary><div class="table-scroll"><table><thead><tr><th>Item</th><th>Godown</th><th class="figure">${journal.type === "physical" ? "Counted quantity" : "Quantity"}</th><th class="figure">Recorded value ₹</th><th>Reason</th></tr></thead><tbody>${journal.lines.map(line => `<tr><td>${esc(report.items.find(row => row.itemId === line.itemId)?.name || line.itemId)}</td><td>${esc(journal.type === "transfer" ? locationName(line.fromGodownId) + " to " + locationName(line.toGodownId) : locationName(line.godownId || line.toGodownId || line.fromGodownId))}${line.direction ? `<small>${line.direction === "in" ? "Stock in" : "Stock out"}</small>` : ""}</td><td class="figure">${esc(line.quantity)}</td>${line.valuePaise === undefined || line.valuePaise === null ? '<td class="figure quiet">At carried cost</td>' : `<td class="figure">${amount(line.valuePaise)}</td>`}<td>${esc(line.reason || journal.sourceRef?.name || "—")}</td></tr>`).join("")}</tbody></table></div></details>`).join("")}
      ${error ? `<p class="form-message alert" role="alert">${esc(error)}</p>` : ""}
      ${total > limit || error ? `<div class="book-toolbar"><button type="button" class="ghost" data-stock-history-direction="later" data-stock-history-offset="${Math.max(0, offset - limit)}"${loading || !offset ? " disabled" : ""}>Later journals</button><button type="button" class="ghost" data-stock-history-direction="earlier" data-stock-history-offset="${offset + limit}"${loading || offset + rows.length >= total ? " disabled" : ""}>Earlier journals</button>${error ? `<button type="button" class="ghost" data-stock-history-direction="retry" data-stock-history-offset="${journalHistory.requestedOffset}">Retry history</button>` : ""}</div>` : ""}`;
    root.querySelector("[data-stock-print]").disabled = loading;
  };
  const loadJournalPage = async (offset, reset = false, focusDirection = "") => {
    const current = ++journalSequence;
    journalHistory = { ...journalHistory, ...(reset ? { rows: [], total: 0, offset: 0 } : {}), loading: true, error: "", requestedOffset: offset };
    drawJournalHistory();
    if (reset) drawMovements();
    const filter = new URLSearchParams({ from, to, offset: String(offset), limit: "50" });
    if (godownId) filter.set("godownId", godownId);
    if (item) filter.set("itemId", item.itemId);
    try {
      const result = await api(`${base}/journals?${filter}`);
      if (!still(token) || current !== journalSequence || !historyRoot.isConnected) return;
      journalHistory = { rows: result.rows.slice(0, 50), total: result.total, offset: result.offset, limit: 50, loading: false, error: "", requestedOffset: result.offset };
    } catch (error) {
      if (!still(token) || current !== journalSequence || !historyRoot.isConnected) return;
      journalHistory = { ...journalHistory, loading: false, error: error.message || "Journal history could not be loaded. Retry history to try again." };
    }
    drawJournalHistory();
    drawMovements();
    if (focusDirection && document.activeElement === document.body) {
      const target = historyRoot.querySelector(`[data-stock-history-direction="${focusDirection}"]:not(:disabled)`) || historyRoot.querySelector("[data-stock-history-offset]:not(:disabled)");
      target?.focus();
    }
  };
  historyRoot.addEventListener("click", event => {
    const button = event.target.closest("[data-stock-history-offset]");
    if (button && !button.disabled) loadJournalPage(Number(button.dataset.stockHistoryOffset), false, document.activeElement === button ? button.dataset.stockHistoryDirection : "");
  });
  root.querySelector(".stock-workspace").addEventListener("click", event => {
    const link = event.target.closest("[data-stock-journal-link]");
    if (!link) return;
    event.preventDefault();
    const journal = [...root.querySelectorAll("[data-stock-journal]")].find(node => node.dataset.stockJournal === link.dataset.stockJournalLink);
    if (journal) { journal.open = true; journal.scrollIntoView({ block: "center" }); }
  });
  const drawAllocations = () => {
    if (!allocationRows) return;
    allocationRows.innerHTML = allocations.map((row, index) => `<tr><td><select data-field="godownId" aria-label="Opening godown ${index + 1}">${godownOptions(row.godownId)}</select></td><td class="figure"><input data-field="quantity" inputmode="decimal" aria-label="Opening quantity ${index + 1}" value="${esc(row.quantity)}" required></td><td class="figure"><input data-field="value" inputmode="decimal" aria-label="Opening value ${index + 1}" value="${esc(row.value)}" placeholder="Not valued"></td><td><button type="button" class="ghost" data-remove-allocation="${index}" aria-label="Remove opening allocation ${index + 1}"${allocations.length === 1 && quantityUnits(item.openingQuantity || "0") > 0n ? " disabled" : ""}>Remove</button></td></tr>`).join("");
    allocationTotal();
  };
  function allocationTotal() {
    try {
      const total = collectRows(allocationRows).reduce((sum, row) => sum + quantityUnits(row.quantity), 0n);
      root.querySelector("[data-allocation-total]").textContent = `Allocated ${quantityText(total)} of ${item.openingQuantity || "0"} ${item.unit}`;
    } catch { root.querySelector("[data-allocation-total]").textContent = "Enter exact opening quantities"; }
  }
  const drawJournal = () => {
    if (!journalRows) return;
    const type = root.querySelector("#stock-journal").elements.type.value;
    const physical = type === "physical", transfer = type === "transfer";
    root.querySelector("[data-journal-help]").textContent = transfer ? "Transfers move quantity and its existing cost together. Choose different source and destination godowns." : physical ? "Enter the quantity actually counted at each godown. Value any stock gain explicitly; stock losses carry their existing cost." : "Record a dated stock gain or loss with its reason. Value additions explicitly; reductions carry their existing cost.";
    journalRows.innerHTML = journalLines.map((line, index) => `<fieldset class="stock-journal-line"><legend>Line ${index + 1}</legend><label>Item<select data-field="itemId" required>${report.items.map(row => `<option value="${esc(row.itemId)}"${row.itemId === line.itemId ? " selected" : ""}>${esc(row.name)} (${esc(row.unit)})</option>`).join("")}</select></label>${transfer ? `<label>From godown<select data-field="fromGodownId">${godownOptions(line.fromGodownId)}</select></label><label>To godown<select data-field="toGodownId">${godownOptions(line.toGodownId)}</select></label>` : `<label>Godown<select data-field="godownId">${godownOptions(line.godownId)}</select></label>${physical ? "" : `<label>Direction<select data-field="direction"><option value="in"${line.direction === "in" ? " selected" : ""}>Stock in</option><option value="out"${line.direction === "out" ? " selected" : ""}>Stock out</option></select></label>`}`}<label>${physical ? "Counted quantity" : "Quantity"}<input data-field="quantity" inputmode="decimal" value="${esc(line.quantity)}" required></label>${!transfer ? `<label data-gain-value${!physical && line.direction === "out" ? " hidden" : ""}>${physical ? "Value of any gain ₹" : "Value of added stock ₹"}<input data-field="value" inputmode="decimal" value="${esc(line.value)}"${!physical && line.direction !== "out" ? " required" : ""} placeholder="${physical ? "Required for a gain" : "0.00"}"></label>` : ""}<label class="stock-journal-reason">Reason<input data-field="reason" maxlength="240" value="${esc(line.reason)}"${transfer ? "" : " required"}></label><button type="button" class="ghost stock-remove-line" data-remove-stock-line="${index}"${journalLines.length === 1 ? " disabled" : ""}>Remove line ${index + 1}</button></fieldset>`).join("");
  };
  drawSummary(); drawMovements(); drawJournalHistory(); drawAllocations(); drawJournal();
  let printState = null;
  const openForPrint = () => {
    if (printState || !still(token) || !historyRoot.isConnected) return;
    const details = [...root.querySelectorAll(".stock-history details")];
    const states = details.map(node => node.open);
    printState = states;
    for (const node of details) node.open = true;
    window.addEventListener("afterprint", () => { details.forEach((node, index) => { node.open = states[index]; }); printState = null; }, { once: true });
  };
  preparePrint = openForPrint;
  if (!printListenerAdded) {
    printListenerAdded = true;
    window.addEventListener("beforeprint", () => preparePrint?.());
  }
  root.querySelector("[data-stock-print]").addEventListener("click", () => { openForPrint(); window.print(); });
  root.querySelector("#stock-period").addEventListener("submit", event => event.preventDefault());
  root.querySelector('#stock-period [name="godown"]').addEventListener("change", event => { godownId = event.target.value; drawSummary(); loadJournalPage(0, true); history.replaceState(null, "", withQuery(routePath, { ...pinnedRange, ...godownQuery() })); });
  allocationRows?.addEventListener("input", allocationTotal);
  root.querySelector("[data-add-allocation]")?.addEventListener("click", () => { allocations = collectRows(allocationRows); dirtyForms.add("stock-item-settings"); allocations.push({ godownId: godowns.find(row => !allocations.some(allocation => allocation.godownId === row.id))?.id || godowns[0].id, quantity: "0", value: "" }); drawAllocations(); remember(); allocationRows.lastElementChild.querySelector("select").focus(); });
  allocationRows?.addEventListener("click", event => { const button = event.target.closest("[data-remove-allocation]"); if (!button || (allocations.length < 2 && quantityUnits(item.openingQuantity || "0") > 0n)) return; allocations = collectRows(allocationRows); dirtyForms.add("stock-item-settings"); allocations.splice(Number(button.dataset.removeAllocation), 1); drawAllocations(); remember(); });
  root.querySelector("[data-add-stock-line]")?.addEventListener("click", () => { journalLines = collectRows(journalRows); dirtyForms.add("stock-journal"); journalLines.push(freshJournalLine()); drawJournal(); remember(); journalRows.lastElementChild.querySelector("select").focus(); });
  journalRows?.addEventListener("click", event => { const button = event.target.closest("[data-remove-stock-line]"); if (!button || journalLines.length < 2) return; journalLines = collectRows(journalRows); dirtyForms.add("stock-journal"); journalLines.splice(Number(button.dataset.removeStockLine), 1); drawJournal(); remember(); });
  root.querySelector('#stock-journal [name="type"]')?.addEventListener("change", () => { journalLines = collectRows(journalRows).map(line => ({ ...freshJournalLine(), ...line })); drawJournal(); remember(); });
  journalRows?.addEventListener("change", event => { if (event.target.dataset.field === "direction") { const line = event.target.closest("fieldset"); const gain = line.querySelector("[data-gain-value]"); gain.hidden = event.target.value === "out"; gain.querySelector("input").required = event.target.value !== "out"; } });
  for (const form of root.querySelectorAll("[data-stock-draft]")) { const changed = () => { dirtyForms.add(form.id); remember(); }; form.addEventListener("input", changed); form.addEventListener("change", changed); }
  bindSave("#stock-godown", "/godowns", "POST", form => ({ name: form.elements.name.value }), "Godown added.");
  bindSave("#stock-integration", "/settings", "PUT", form => ({ integrateAccounts: form.elements.integrateAccounts.checked }), "Inventory accounting setting saved.");
  bindSave("#stock-item-settings", "/items/" + encodeURIComponent(item?.itemId || ""), "PUT", form => ({ costingMethod: form.elements.costingMethod.value, openingValuePaise: form.elements.openingValue.value.trim() === "" ? null : parseRupees(form.elements.openingValue.value), openingAllocations: collectRows(allocationRows).map(row => ({ godownId: row.godownId, quantity: row.quantity, valuePaise: row.value.trim() === "" ? null : parseRupees(row.value) })) }), "Item costing saved.");
  bindSave("#stock-journal", "/journals", "POST", form => ({ date: form.elements.date.value, number: form.elements.number.value, type: form.elements.type.value, lines: collectRows(journalRows).map(line => ({ itemId: line.itemId, quantity: line.quantity, ...(form.elements.type.value === "transfer" ? { fromGodownId: line.fromGodownId, toGodownId: line.toGodownId } : form.elements.type.value === "physical" ? { godownId: line.godownId } : { direction: line.direction, ...(line.direction === "out" ? { fromGodownId: line.godownId } : { toGodownId: line.godownId }) }), ...(!["transfer"].includes(form.elements.type.value) && line.value?.trim() && (form.elements.type.value === "physical" || line.direction !== "out") ? { valuePaise: parseRupees(line.value) } : {}), reason: line.reason })) }), "Stock journal posted.");
  root.querySelector("#stock-journal")?.addEventListener("keydown", event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.requestSubmit(); } });
  return true;
}
