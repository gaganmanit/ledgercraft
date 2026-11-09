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
/* The engine stores quantities as text with a hyphen for a shortfall; people read a true minus sign. */
const shownQuantity = value => /^-?\d+(\.\d+)?$/.test(String(value ?? "")) ? quantityText(quantityUnits(value)) : String(value ?? "—");

/* Alternate units: factorNumerator base units = factorDenominator alternate units, kept exact. */
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
function unitRatio(unit) {
  const n = BigInt(unit.factorNumerator), d = BigInt(unit.factorDenominator), common = gcd(n, d);
  return { n: n / common, d: d / common };
}
function unitLine(unit, base) {
  const { n, d } = unitRatio(unit);
  /* Show "1 bag = 37.5 kg" when one alternate unit is an exact decimal of the base unit, otherwise "3 box = 10 kg". */
  for (let places = 0, scale = 1n; places <= 6; places++, scale *= 10n) {
    if ((n * scale) % d) continue;
    const scaled = n * scale / d, text = String(scaled).padStart(places + 1, "0");
    const factor = places ? `${text.slice(0, -places)}.${text.slice(-places)}`.replace(/\.?0+$/, "") : text;
    return `1 ${unit.name} = ${factor} ${base}`;
  }
  return `${d} ${unit.name} = ${n} ${base}`;
}
/* Converts a typed quantity in an alternate unit to the base unit; null when it is not an exact base quantity. */
function baseQuantity(value, unit) {
  const { n, d } = unitRatio(unit);
  const typed = quantityUnits(value);
  return (typed * n) % d ? null : typed * n / d;
}
/* Return moves to the next field, as it does on vouchers. Buttons and text areas keep their own Return. */
function focusNext(form, from) {
  const controls = [...form.querySelectorAll("input, select, textarea, button")].filter(el => !el.disabled && el.offsetParent !== null && el.getAttribute("aria-hidden") !== "true");
  const next = controls[controls.indexOf(from) + 1];
  if (next) next.focus();
  if (next && typeof next.select === "function" && next.tagName === "INPUT" && !["checkbox", "date"].includes(next.type)) next.select();
  return Boolean(next);
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
  const itemById = id => report.items.find(row => row.itemId === id);
  /* An item is batch-tracked when it holds a named batch now, or its saved opening or movements name one. */
  const batchTracked = id => {
    const row = itemById(id);
    return Boolean(row?.batches?.length || row?.lots?.some(lot => lot.batch) || row?.movements?.some(movement => movement.batch)
      || report.itemSettings?.[id]?.openingAllocations?.some(allocation => allocation.batch));
  };
  const expired = batch => Boolean(batch.expiry && batch.expiry < to);
  /* A journal line keyed in an alternate unit shows that unit, with its base quantity beneath. */
  const journalQuantity = line => {
    const master = itemById(line.itemId);
    const alternate = line.unit && master?.alternateUnits?.find(unit => unit.name.toLowerCase() === String(line.unit).toLowerCase());
    if (alternate) {
      let base = null;
      try { base = baseQuantity(line.quantity, alternate); } catch { base = null; }
      return `${esc(shownQuantity(line.quantity))} ${esc(alternate.name)}${base === null ? "" : `<small>${esc(quantityText(base))} ${esc(master.unit)}</small>`}`;
    }
    if (line.unit && !master) return `${esc(shownQuantity(line.quantity))} ${esc(line.unit)}`;
    return esc(shownQuantity(line.quantity)) + (line.sourceQuantity && line.sourceQuantity !== line.quantity ? `<small>Tally quantity ${esc(line.sourceQuantity)}</small>` : "");
  };
  let allocations = item ? draft.openingAllocations || structuredClone(settings.openingAllocations?.length ? settings.openingAllocations : quantityUnits(item.openingQuantity || "0") === 0n ? [] : [{ godownId: godowns[0].id, quantity: String(item.openingQuantity), valuePaise: settings.openingValuePaise ?? null }]).map(row => ({ godownId: row.godownId, quantity: row.quantity, value: rupees(row.valuePaise), batch: row.batch || "", manufacturedDate: row.manufacturedDate || "", expiryDate: row.expiryDate || "" })) : [];
  const freshJournalLine = () => ({ itemId: report.items[0]?.itemId || "", godownId: godowns[0].id, fromGodownId: godowns[0].id, toGodownId: godowns[1]?.id || godowns[0].id, quantity: "1", unit: "", direction: "in", value: "", reason: "", batch: "", manufacturedDate: "", expiryDate: "", trackBatch: "" });
  /* Tally Avg. Cost items carry an informational disclosure from the Tally stock review, keyed by item. */
  const disclosures = new Map();
  const wantsDisclosure = tallySource && (item ? [item] : report.items).some(row => row.masterKind === "tally" && row.costingMethod === "moving-average");
  let disclosureError = "";
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
  const itemSettings = !item ? "" : `<details data-stock-section="cost"><summary>Costing and opening stock</summary><form id="stock-item-settings" class="form-grid" data-stock-draft><label>Costing method<select name="costingMethod"><option value="fifo"${costing === "fifo" ? " selected" : ""}>FIFO, perpetual</option><option value="moving-average"${costing === "moving-average" ? " selected" : ""}>Moving average, perpetual</option></select></label><label>Total opening value ₹<input name="openingValue" inputmode="decimal" value="${esc(rupees(settings.openingValuePaise))}" placeholder="Not valued"></label><p class="form-note wide">The opening quantity of ${esc(item.openingQuantity || "0")} ${esc(item.unit)} comes from the item master.${item.masterKind === "tally" ? ` <a href="${tallyLink}">Review Tally stock</a> to change its source quantity.` : ` <a href="${book}/gst">Edit the quantity in GST setup</a>.`} A blank cost stays unvalued. Enter a value for every allocation, or leave every allocation blank and enter the total.</p>${batchTracked(item.itemId) ? "" : `<label class="check wide"><input type="checkbox" name="openingInBatches"${allocations.some(row => row.batch) ? " checked" : ""}><span>Opening stock is held in named batches<small>Adds batch name, manufacturing date and expiry date to each opening allocation.</small></span></label>`}<div class="wide table-scroll"><table class="stock-entry-table"><thead data-opening-head></thead><tbody data-opening-allocations></tbody></table></div><div class="wide actions"><button type="button" class="ghost" data-add-allocation>Add opening allocation</button><span class="quiet" data-allocation-total></span></div><div class="actions wide"><button>Save item costing</button></div><p data-stock-error class="form-message wide" role="alert"></p></form></details>`;
  const godownEditor = `<details data-stock-section="godowns"><summary>Godowns <small>${godowns.length === 1 ? "1 godown" : godowns.length + " godowns"}</small></summary><div class="table-scroll"><table class="stock-godown-list"><thead><tr><th>Godown</th><th>Code</th></tr></thead><tbody>${godowns.map(row => `<tr><th scope="row">${esc(row.name)}</th><td class="code">${esc(row.id)}</td></tr>`).join("")}</tbody></table></div><form id="stock-godown" class="form-grid" data-stock-draft><label>New godown name<input name="name" maxlength="80" required autocomplete="off"></label><div class="actions wide"><button>Add godown</button></div><p data-stock-error class="form-message wide" role="alert"></p></form></details>`;
  const journalEditor = `<details data-stock-section="journal"><summary>Record a stock movement</summary>${report.items.length ? `<form id="stock-journal" class="form-grid" data-stock-draft><label>Movement<select name="type"><option value="transfer">Transfer between godowns</option><option value="adjustment">Stock adjustment</option><option value="physical">Physical count</option></select></label><label>Date<input name="date" type="date" min="${esc(report.company.booksFrom)}" value="${esc(to)}" required></label><label>Journal number<input name="number" maxlength="24" required autocomplete="off"></label><p class="form-note wide" data-journal-help></p><div class="wide" data-journal-lines></div><div class="actions wide"><button type="button" class="ghost" data-add-stock-line>Add line</button></div><div class="actions wide"><button>Post stock journal <kbd aria-hidden="true">⌘↩</kbd></button></div><p data-stock-error class="form-message wide" role="alert"></p></form>` : `<p class="empty">Add a goods item in <a href="${book}/gst">GST setup</a> before you record a stock movement.</p>`}</details>`;
  const issues = item?.issues || report.issues || [];
  const gaps = issues.length ? `<section class="subsection stock-gaps"><h2>Valuation needs attention</h2><ul class="attention-rule">${issueRows(issues)}</ul><p>${item ? "Review this item’s opening costs below, or open the source document for its purchase cost." : "Open the affected item to review its cost sources and opening allocations."}</p></section>` : "";
  const alternates = item?.alternateUnits || [];
  const itemHead = item ? `<p class="stock-back"><a href="${withQuery(`${book}/stock`, pinnedRange)}">All stock items</a></p><p class="stock-facts">Counted in ${esc(item.unit)}. Valued by ${item.costingMethod === "moving-average" ? "moving average" : "FIFO"}.</p>${alternates.length ? `<ul class="stock-units" aria-label="Alternate units">${alternates.map(unit => `<li>${esc(unitLine(unit, item.unit))}</li>`).join("")}</ul>` : ""}` : "";
  const tallyNote = tallySource ? `<p class="notice stock-source-action">Check the source allocations and any unsupported stock before you activate it. <a href="${tallyLink}">Review Tally stock</a></p>` : "";
  root.innerHTML = page({ company: report.company, title: item ? item.name : "Stock summary", kicker: item ? "Item ledger" : "Inventory", folio: item ? "Il" : "St", status, body: `<div class="stock-workspace">${itemHead}${sheetTools}${reportControls}${tallyNote}${item && wantsDisclosure ? '<div data-stock-costing role="status"></div>' : ""}<div data-stock-summary></div>${item ? '<div data-stock-batches></div><section class="subsection stock-lots"><h2>Stock on hand by receipt</h2><p>Each row is the unsold part of one receipt and the cost it carries.</p><div data-stock-lots></div></section><section class="subsection stock-history"><h2>Item movements</h2><div data-stock-movements></div></section>' : ""}${gaps}<div class="details-list stock-editors">${itemSettings}${!item ? integration + godownEditor + journalEditor : ""}</div><section class="subsection stock-history"><h2>Stock journal history</h2><div class="details-list" data-stock-journals></div></section></div>` });

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
  const collectRows = target => target ? [...target.children].map(row => Object.fromEntries([...row.querySelectorAll("[data-field]")].map(input => [input.dataset.field, input.type === "checkbox" ? (input.checked ? "1" : "") : input.value]))) : [];
  const remember = () => {
    const forms = Object.fromEntries([...root.querySelectorAll("[data-stock-draft]")].filter(form => dirtyForms.has(form.id)).map(form => [form.id, Object.fromEntries([...form.querySelectorAll("[name]")].map(input => [input.name, input.type === "checkbox" ? input.checked : input.value]))]));
    draft = { forms, ...(dirtyForms.has("stock-item-settings") ? { openingAllocations: collectRows(allocationRows) } : {}), ...(dirtyForms.has("stock-journal") ? { journalLines: collectRows(journalRows) } : {}) };
    try { localStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* Current forms remain usable if local storage is full. */ }
  };
  const showError = (form, error) => { const target = form.querySelector("[data-stock-error]"); target.className = "form-message alert wide"; target.textContent = error.message; target.scrollIntoView({ block: "nearest" }); };
  /* Batch name and dates for a journal line or opening allocation. Only the fields on screen are sent. */
  const batchFields = (row, label) => {
    const batch = (row.batch || "").trim();
    const manufacturedDate = row.manufacturedDate || "", expiryDate = row.expiryDate || "";
    if (!batch && (manufacturedDate || expiryDate)) throw new Error(`${label}: enter the batch name for its manufacturing or expiry date.`);
    if (manufacturedDate && expiryDate && expiryDate < manufacturedDate) throw new Error(`${label}: the expiry date ${dateLabel(expiryDate)} is before the manufacturing date ${dateLabel(manufacturedDate)}.`);
    return batch ? { batch, ...(manufacturedDate ? { manufacturedDate } : {}), ...(expiryDate ? { expiryDate } : {}) } : {};
  };
  /* An alternate unit is sent as unit; the base unit is the default and is not sent. */
  const unitField = (line, index) => {
    const master = itemById(line.itemId);
    const alternate = line.unit && master?.alternateUnits?.find(unit => unit.name === line.unit);
    if (!alternate) return {};
    if (baseQuantity(line.quantity, alternate) === null) throw new Error(`Line ${index + 1}: ${line.quantity} ${alternate.name} does not convert exactly into ${master.unit}. Enter the quantity in ${master.unit}.`);
    return { unit: alternate.name };
  };
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
    const itemNotes = row => {
      const batches = row.batches || [];
      const lapsed = batches.filter(expired).length;
      const disclosure = disclosures.get(row.itemId);
      const costing = !disclosure ? "" : Number.isSafeInteger(disclosure.differencePaise)
        ? (disclosure.differencePaise ? `Tally average cost differs by ₹${formatINR(Math.abs(disclosure.differencePaise))}` : "Tally average cost agrees")
        : "Tally average cost mapped to moving average";
      return (batches.length ? `<small>${batches.length === 1 ? "1 batch" : batches.length + " batches"}${lapsed ? `, ${lapsed} expired` : ""}</small>` : "")
        + (costing ? `<small>${esc(costing)}</small>` : "");
    };
    root.querySelector("[data-stock-summary]").innerHTML = `<div class="summary-strip"><div><span>${item ? "Quantity on hand" : "Stock items"}</span><strong>${item ? esc(shownQuantity(selectedStock(item).quantity)) + " " + esc(item.unit) : displayed.length}</strong></div><div><span>Closing stock value</span><strong>${money(total)}</strong>${complete ? "" : `<small>Known cost ${money(known)}</small>`}</div><div><span>Needs review</span><strong>${needsReview}</strong>${needsReview ? `<small>${item ? "Add the missing cost below." : "Open each flagged item to add its cost."}</small>` : ""}</div></div>${item ? "" : `<div class="table-scroll"><table class="stock-summary-table"><thead><tr><th>Item</th><th>Costing</th><th class="figure">Quantity</th><th class="figure">Closing value ₹</th><th>Review</th></tr></thead><tbody>${displayed.map(({ item: row, stock }) => `<tr><th scope="row"><a href="${itemLink(row.itemId)}">${esc(row.name)}</a><small>${esc(row.unit)}</small>${itemNotes(row)}</th><td>${esc(costingLabel(row.costingMethod))}</td><td class="figure">${esc(shownQuantity(stock.quantity))}</td><td class="figure">${amount(stock.valuePaise)}</td><td>${stock.complete === false || stock.valuePaise == null ? `<span class="pill warn">Cost missing</span> <a href="${itemLink(row.itemId)}">Review cost</a>` : '<span class="pill ok">Valued</span>'}</td></tr>`).join("") || `<tr><td colspan="5" class="quiet">${empty}</td></tr>`}</tbody></table></div>`}`;
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
    const withBatch = rows.some(row => row.batch);
    root.querySelector("[data-stock-movements]").innerHTML = `<div class="table-scroll"><table class="stock-movements-table"><thead><tr><th>Date</th><th>Source</th><th>Godown</th>${withBatch ? "<th>Batch</th>" : ""}<th class="figure">Quantity</th><th class="figure">Balance quantity</th><th class="figure">Cost ₹</th><th class="figure">Balance cost ₹</th><th>Cost sources</th></tr></thead><tbody>${rows.map(row => `<tr><td class="date-cell">${esc(dateLabel(row.date))}</td><td>${sourceLink(row)}</td><td>${esc(row.godownName || locationName(row.godownId))}</td>${withBatch ? `<td>${row.batch ? esc(row.batch) : '<span class="quiet">No batch</span>'}</td>` : ""}<td class="figure">${esc(shownQuantity(row.quantity))}</td><td class="figure">${esc(shownQuantity(row.runningQuantity ?? "—"))}</td><td class="figure">${amount(row.valuePaise)}</td><td class="figure">${amount(row.runningValuePaise)}</td><td>${row.lineage?.length ? `<details class="stock-lineage"><summary>${row.lineage.length} source(s)</summary><ul>${row.lineage.map(source => `<li><span>${lineageSource(source.sourceId)}</span><span>${esc(source.quantity)} ${esc(item.unit)}</span><span>${money(source.valuePaise)}</span></li>`).join("")}</ul></details>` : esc(row.costBasisReason || (row.valuePaise === null ? "Review valuation gaps" : "Recorded cost"))}</td></tr>`).join("") || `<tr><td colspan="${withBatch ? 9 : 8}" class="quiet">No stock movements for this period and godown. Choose another godown or change the period.</td></tr>`}</tbody></table></div>`;
  };
  /* Named batches. With a godown chosen, the batch rows are rebuilt from that godown's lots; values follow the item's completeness. */
  const drawBatches = () => {
    const target = root.querySelector("[data-stock-batches]");
    if (!target) return;
    const known = new Map((item.batches || []).map(row => [row.name, row]));
    let rows = item.batches || [];
    if (godownId) {
      const groups = new Map();
      for (const lot of (item.lots || []).filter(lot => lot.batch && lot.godownId === godownId)) {
        const group = groups.get(lot.batch) || { name: lot.batch, units: 0n, value: 0, valued: true };
        group.units += quantityUnits(lot.quantity);
        if (lot.valuePaise === null || lot.valuePaise === undefined) group.valued = false; else group.value += lot.valuePaise;
        groups.set(lot.batch, group);
      }
      rows = [...groups.values()].filter(group => group.units !== 0n).sort((a, b) => a.name.localeCompare(b.name, "en-IN")).map(group => ({ name: group.name, quantity: quantityText(group.units).replace("−", "-"),
        valuePaise: group.valued && item.complete !== false && selectedStock(item).complete !== false ? group.value : null,
        ...(known.get(group.name)?.expiry ? { expiry: known.get(group.name).expiry } : {}), ...(known.get(group.name)?.manufactured ? { manufactured: known.get(group.name).manufactured } : {}) }));
    }
    if (!rows.length && !batchTracked(item.itemId)) { target.innerHTML = ""; return; }
    /* Expired batches first, oldest expiry first; the rest keep their name order. */
    const ordered = [...rows.filter(expired).sort((a, b) => a.expiry.localeCompare(b.expiry)), ...rows.filter(row => !expired(row))];
    const valued = rows.every(row => Number.isSafeInteger(row.valuePaise));
    const units = rows.reduce((sum, row) => sum + quantityUnits(row.quantity), 0n);
    const lapsed = rows.filter(expired).length;
    const valueCell = paise => Number.isSafeInteger(paise) ? `<td class="figure">${esc(formatINR(paise))}</td>` : '<td class="figure quiet">Valuation incomplete</td>';
    target.innerHTML = `<section class="subsection stock-batches"><h2>Batches</h2><p>${godownId ? `Batches held at ${esc(locationName(godownId))} on ${esc(dateLabel(to))}.` : `Batches held across all godowns on ${esc(dateLabel(to))}.`}${lapsed ? ` ${lapsed === 1 ? "One batch has" : lapsed + " batches have"} passed expiry and ${lapsed === 1 ? "is" : "are"} listed first.` : ""}</p>
      <div class="table-scroll"><table class="stock-batch-table"><thead><tr><th>Batch</th><th>Manufactured</th><th>Expiry</th><th class="figure">Quantity</th><th class="figure">Value ₹</th></tr></thead>
      <tbody>${ordered.map(row => `<tr${expired(row) ? ' class="stock-batch-expired"' : ""}><th scope="row">${esc(row.name)}${expired(row) ? ' <span class="pill warn">Expired</span>' : ""}${quantityUnits(String(row.quantity)) < 0n ? ' <span class="pill warn">Short</span>' : ""}</th><td class="date-cell">${row.manufactured ? esc(dateLabel(row.manufactured)) : '<span class="quiet">Not recorded</span>'}</td><td class="date-cell">${row.expiry ? esc(dateLabel(row.expiry)) : '<span class="quiet">Not recorded</span>'}</td><td class="figure">${esc(shownQuantity(row.quantity))}</td>${valueCell(row.valuePaise)}</tr>`).join("")
        || `<tr><td colspan="5" class="quiet">No named batch is on hand${godownId ? " at this godown" : ""}. Record a stock movement with a batch to add one.</td></tr>`}</tbody>
      ${rows.length ? `<tfoot><tr class="total"><th scope="row" colspan="3">Total in batches</th><td class="figure">${esc(quantityText(units))}</td>${valueCell(valued ? rows.reduce((sum, row) => sum + row.valuePaise, 0) : null)}</tr></tfoot>` : ""}</table></div></section>`;
  };
  /* Stock on hand by receipt: the open cost lots, with a batch column only when a lot names one. */
  const drawLots = () => {
    const target = root.querySelector("[data-stock-lots]");
    if (!target) return;
    const rows = (item.lots || []).filter(lot => !godownId || lot.godownId === godownId);
    const withBatch = rows.some(lot => lot.batch);
    const valued = rows.every(lot => Number.isSafeInteger(lot.valuePaise));
    const units = rows.reduce((sum, lot) => sum + quantityUnits(lot.quantity), 0n);
    const columns = withBatch ? 6 : 5;
    target.innerHTML = `<div class="table-scroll"><table class="stock-lot-table"><thead><tr><th>Received</th><th>Source</th><th>Godown</th>${withBatch ? "<th>Batch</th>" : ""}<th class="figure">Quantity</th><th class="figure">Cost ₹</th></tr></thead>
      <tbody>${rows.map(lot => `<tr><td class="date-cell">${esc(dateLabel(lot.date))}</td><td>${lineageSource(lot.sourceId)}</td><td>${esc(locationName(lot.godownId))}</td>${withBatch ? `<td>${lot.batch ? esc(lot.batch) : '<span class="quiet">No batch</span>'}</td>` : ""}<td class="figure">${esc(shownQuantity(lot.quantity))}</td>${Number.isSafeInteger(lot.valuePaise) ? `<td class="figure">${esc(formatINR(lot.valuePaise))}</td>` : '<td class="figure quiet">Valuation incomplete</td>'}</tr>`).join("")
        || `<tr><td colspan="${columns}" class="quiet">No stock on hand${godownId ? " at this godown" : ""} on ${esc(dateLabel(to))}.</td></tr>`}</tbody>
      ${rows.length ? `<tfoot><tr class="total"><th scope="row" colspan="${columns - 2}">Total on hand</th><td class="figure">${esc(quantityText(units))}</td>${valued ? `<td class="figure">${esc(formatINR(rows.reduce((sum, lot) => sum + lot.valuePaise, 0)))}</td>` : '<td class="figure quiet">Valuation incomplete</td>'}</tr></tfoot>` : ""}</table></div>`;
  };
  /* The Tally costing disclosure is information, not a fault: Tally's periodic average against the moving average. */
  const drawCosting = () => {
    const target = root.querySelector("[data-stock-costing]");
    if (!target) return;
    const issue = disclosures.get(item.itemId);
    if (!issue) { target.innerHTML = disclosureError ? `<p class="quiet">${esc(disclosureError)}</p>` : ""; return; }
    if (!Number.isSafeInteger(issue.differencePaise) || !Number.isSafeInteger(issue.sourceClosingValuePaise) || !Number.isSafeInteger(issue.ledgercraftClosingValuePaise)) {
      target.innerHTML = `<div class="notice stock-costing-note"><p><strong>Tally costing.</strong> ${esc(issue.message || "Tally Avg. Cost is imported as a moving average.")}</p></div>`;
      return;
    }
    const difference = issue.differencePaise;
    target.innerHTML = `<div class="notice stock-costing-note"><p><strong>Tally costing.</strong> Tally values this item at its periodic average cost for the period. Ledgercraft uses a moving average, recalculated at every receipt, so the closing values differ.</p>
      <dl class="kv"><dt>Tally periodic average</dt><dd>₹ ${esc(formatINR(issue.sourceClosingValuePaise))}</dd><dt>Ledgercraft moving average</dt><dd>₹ ${esc(formatINR(issue.ledgercraftClosingValuePaise))}</dd><dt>Disclosed difference</dt><dd>${difference ? `₹ ${esc(formatINR(Math.abs(difference)))}, Tally ${difference > 0 ? "higher" : "lower"}` : "None"}</dd></dl>
      <p class="quiet">Closing stock of ${esc(issue.sourceClosingQuantity || item.quantity)} ${esc(item.unit)} on ${esc(dateLabel(issue.asOf))}, the last imported movement date.</p></div>`;
  };
  const drawJournalHistory = () => {
    const { rows, total, offset, limit, loading, error } = journalHistory;
    const range = loading ? "Loading journal history…" : rows.length ? `Showing ${offset + 1}–${Math.min(offset + rows.length, total)} of ${total} journals, newest first.` : error ? "Journal history is unavailable." : `No stock journals for this period and godown.${item ? "" : " Record a stock movement above to add one."}`;
    historyRoot.setAttribute("aria-busy", String(loading));
    historyRoot.innerHTML = `<p class="quiet" data-stock-history-page role="status">${esc(range)}</p>
      ${journalHistory.rows.map(journal => `<details id="stock-journal-${esc(journal.id)}" data-stock-journal="${esc(journal.id)}"><summary><span class="date-cell">${esc(dateLabel(journal.date))}</span><span class="code">${esc(journal.number)}</span><small>${esc(journalLabels[journal.type] || journal.type)}</small></summary><div class="table-scroll"><table><thead><tr><th>Item</th><th>Godown</th>${journal.lines.some(line => line.batch) ? "<th>Batch</th>" : ""}<th class="figure">${journal.type === "physical" ? "Counted quantity" : "Quantity"}</th><th class="figure">Recorded value ₹</th><th>Reason</th></tr></thead><tbody>${journal.lines.map(line => `<tr><td>${esc(itemById(line.itemId)?.name || line.itemId)}</td><td>${esc(journal.type === "transfer" ? locationName(line.fromGodownId) + " to " + locationName(line.toGodownId) : locationName(line.godownId || line.toGodownId || line.fromGodownId))}${line.direction ? `<small>${line.direction === "in" ? "Stock in" : "Stock out"}</small>` : ""}</td>${journal.lines.some(row => row.batch) ? `<td>${line.batch ? esc(line.batch) : '<span class="quiet">No batch</span>'}${line.expiryDate ? `<small>Expires ${esc(dateLabel(line.expiryDate))}</small>` : ""}</td>` : ""}<td class="figure">${journalQuantity(line)}</td>${line.valuePaise === undefined || line.valuePaise === null ? '<td class="figure quiet">At carried cost</td>' : `<td class="figure">${amount(line.valuePaise)}</td>`}<td>${esc(line.reason || journal.sourceRef?.name || "—")}</td></tr>`).join("")}</tbody></table></div></details>`).join("")}
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
  const openingInBatches = () => Boolean(item) && (batchTracked(item.itemId) || root.querySelector('#stock-item-settings [name="openingInBatches"]')?.checked === true);
  const drawAllocations = () => {
    if (!allocationRows) return;
    const batched = openingInBatches();
    root.querySelector("[data-opening-head]").innerHTML = `<tr><th>Opening godown</th>${batched ? "<th>Batch</th><th>Manufactured</th><th>Expiry</th>" : ""}<th class="figure">Quantity</th><th class="figure">Opening value ₹</th><th><span class="sr">Remove</span></th></tr>`;
    const batchCells = (row, index) => batched ? `<td><input data-field="batch" maxlength="120" autocomplete="off" aria-label="Opening batch ${index + 1}" value="${esc(row.batch || "")}" placeholder="No batch"></td><td><input data-field="manufacturedDate" type="date" aria-label="Opening batch ${index + 1} manufacturing date" value="${esc(row.manufacturedDate || "")}"></td><td><input data-field="expiryDate" type="date" aria-label="Opening batch ${index + 1} expiry date" value="${esc(row.expiryDate || "")}"></td>` : "";
    allocationRows.innerHTML = allocations.map((row, index) => `<tr><td><select data-field="godownId" aria-label="Opening godown ${index + 1}">${godownOptions(row.godownId)}</select></td>${batchCells(row, index)}<td class="figure"><input data-field="quantity" inputmode="decimal" aria-label="Opening quantity ${index + 1}" value="${esc(row.quantity)}" required></td><td class="figure"><input data-field="value" inputmode="decimal" aria-label="Opening value ${index + 1}" value="${esc(row.value)}" placeholder="Not valued"></td><td><button type="button" class="ghost" data-remove-allocation="${index}" aria-label="Remove opening allocation ${index + 1}"${allocations.length === 1 && quantityUnits(item.openingQuantity || "0") > 0n ? " disabled" : ""}>Remove</button></td></tr>`).join("");
    allocationTotal();
  };
  function allocationTotal() {
    try {
      const total = collectRows(allocationRows).reduce((sum, row) => sum + quantityUnits(row.quantity), 0n);
      root.querySelector("[data-allocation-total]").textContent = `Allocated ${quantityText(total)} of ${item.openingQuantity || "0"} ${item.unit}`;
    } catch { root.querySelector("[data-allocation-total]").textContent = "Enter exact opening quantities"; }
  }
  /* Shows the base quantity for a line keyed in an alternate unit, as the person types. */
  const updateBaseHint = line => {
    const hint = line?.querySelector("[data-base-quantity]");
    if (!hint) return;
    const master = itemById(line.querySelector('[data-field="itemId"]').value);
    const alternate = master?.alternateUnits?.find(unit => unit.name === line.querySelector('[data-field="unit"]')?.value);
    const typed = line.querySelector('[data-field="quantity"]').value.trim();
    if (!alternate || !master) { hint.textContent = ""; return; }
    if (!typed) { hint.textContent = unitLine(alternate, master.unit) + "."; return; }
    try {
      const base = baseQuantity(typed, alternate);
      hint.textContent = base === null ? `${typed} ${alternate.name} does not convert exactly into ${master.unit}. Enter the quantity in ${master.unit}.` : `Equals ${quantityText(base)} ${master.unit}.`;
    } catch { hint.textContent = "Enter a quantity with up to six decimal places."; }
  };
  const drawJournal = () => {
    if (!journalRows) return;
    const type = root.querySelector("#stock-journal").elements.type.value;
    const physical = type === "physical", transfer = type === "transfer";
    root.querySelector("[data-journal-help]").textContent = transfer ? "Transfers move quantity and its existing cost together. Choose different source and destination godowns." : physical ? "Enter the quantity actually counted at each godown. Value any stock gain explicitly; stock losses carry their existing cost." : "Record a dated stock gain or loss with its reason. Value additions explicitly; reductions carry their existing cost.";
    journalRows.innerHTML = journalLines.map((line, index) => {
      const master = itemById(line.itemId) || report.items[0];
      const units = master?.alternateUnits || [];
      const unit = units.some(row => row.name === line.unit) ? line.unit : "";
      const tracked = batchTracked(master?.itemId);
      const showBatch = tracked || line.trackBatch === "1";
      /* Batch dates belong to stock coming in: a gain, an inward adjustment or a count. */
      const receiving = !transfer && (physical || line.direction !== "out");
      const hintId = `stock-line-${index + 1}-base`;
      const batches = master?.batches || [];
      return `<fieldset class="stock-journal-line"><legend>Line ${index + 1}</legend><label>Item<select data-field="itemId" required>${report.items.map(row => `<option value="${esc(row.itemId)}"${row.itemId === master?.itemId ? " selected" : ""}>${esc(row.name)} (${esc(row.unit)})</option>`).join("")}</select></label>${transfer ? `<label>From godown<select data-field="fromGodownId">${godownOptions(line.fromGodownId)}</select></label><label>To godown<select data-field="toGodownId">${godownOptions(line.toGodownId)}</select></label>` : `<label>Godown<select data-field="godownId">${godownOptions(line.godownId)}</select></label>${physical ? "" : `<label>Direction<select data-field="direction"><option value="in"${line.direction === "in" ? " selected" : ""}>Stock in</option><option value="out"${line.direction === "out" ? " selected" : ""}>Stock out</option></select></label>`}`}<label>${physical ? "Counted quantity" : "Quantity"}<input data-field="quantity" inputmode="decimal" value="${esc(line.quantity)}" required${units.length ? ` aria-describedby="${hintId}"` : ""}>${units.length ? `<small class="stock-base-hint" id="${hintId}" data-base-quantity></small>` : ""}</label>${units.length ? `<label>Unit<select data-field="unit"><option value="">${esc(master.unit)}</option>${units.map(row => `<option value="${esc(row.name)}"${row.name === unit ? " selected" : ""}>${esc(row.name)}</option>`).join("")}</select></label>` : ""}${!transfer ? `<label data-gain-value${!physical && line.direction === "out" ? " hidden" : ""}>${physical ? "Value of any gain ₹" : "Value of added stock ₹"}<input data-field="value" inputmode="decimal" value="${esc(line.value)}"${!physical && line.direction !== "out" ? " required" : ""} placeholder="${physical ? "Required for a gain" : "0.00"}"></label>` : ""}<label class="stock-journal-reason">Reason<input data-field="reason" maxlength="240" value="${esc(line.reason)}"${transfer ? "" : " required"}></label>${tracked ? "" : `<label class="check stock-track-batch"><input type="checkbox" data-field="trackBatch"${showBatch ? " checked" : ""}><span>Track a batch</span></label>`}${showBatch ? `<label>Batch<input data-field="batch" maxlength="120" autocomplete="off" value="${esc(line.batch || "")}"${batches.length ? ` list="stock-line-${index + 1}-batches"` : ""} placeholder="${transfer || !receiving ? "Any batch" : "Batch name"}">${batches.length ? `<datalist id="stock-line-${index + 1}-batches">${batches.map(row => `<option value="${esc(row.name)}"></option>`).join("")}</datalist>` : ""}</label>${receiving ? `<label>Manufacturing date<input data-field="manufacturedDate" type="date" value="${esc(line.manufacturedDate || "")}"></label><label>Expiry date<input data-field="expiryDate" type="date" value="${esc(line.expiryDate || "")}"></label>` : ""}` : ""}<button type="button" class="ghost stock-remove-line" data-remove-stock-line="${index}"${journalLines.length === 1 ? " disabled" : ""}>Remove line ${index + 1}</button></fieldset>`;
    }).join("");
    for (const line of journalRows.children) updateBaseHint(line);
  };
  /* Redraws the journal lines after a choice that changes which fields a line needs, keeping focus on that choice. */
  const redrawJournal = (index, field) => {
    journalLines = collectRows(journalRows).map(line => ({ ...freshJournalLine(), ...line }));
    drawJournal();
    remember();
    journalRows.children[index]?.querySelector(`[data-field="${field}"]`)?.focus();
  };
  drawSummary(); drawMovements(); drawJournalHistory(); drawAllocations(); drawJournal();
  if (item) { drawBatches(); drawLots(); drawCosting(); }
  if (wantsDisclosure) {
    api(`/api/tally/companies/${encodeURIComponent(route.id)}/stock`).then(review => {
      if (!still(token) || !historyRoot.isConnected) return;
      for (const issue of review.issues || []) if (issue.code === "tally-costing-mapped" && issue.itemId) disclosures.set(issue.itemId, issue);
      drawSummary();
      if (item) drawCosting();
    }).catch(() => {
      if (!still(token) || !historyRoot.isConnected || !item) return;
      disclosureError = "The Tally costing note could not be loaded. Open Review Tally stock to read it.";
      drawCosting();
    });
  }
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
  root.querySelector('#stock-period [name="godown"]').addEventListener("change", event => { godownId = event.target.value; drawSummary(); if (item) { drawBatches(); drawLots(); } loadJournalPage(0, true); history.replaceState(null, "", withQuery(routePath, { ...pinnedRange, ...godownQuery() })); });
  allocationRows?.addEventListener("input", allocationTotal);
  root.querySelector("[data-add-allocation]")?.addEventListener("click", () => { allocations = collectRows(allocationRows); dirtyForms.add("stock-item-settings"); allocations.push({ godownId: godowns.find(row => !allocations.some(allocation => allocation.godownId === row.id))?.id || godowns[0].id, quantity: "0", value: "", batch: "", manufacturedDate: "", expiryDate: "" }); drawAllocations(); remember(); allocationRows.lastElementChild.querySelector("select").focus(); });
  allocationRows?.addEventListener("click", event => { const button = event.target.closest("[data-remove-allocation]"); if (!button || (allocations.length < 2 && quantityUnits(item.openingQuantity || "0") > 0n)) return; allocations = collectRows(allocationRows); dirtyForms.add("stock-item-settings"); allocations.splice(Number(button.dataset.removeAllocation), 1); drawAllocations(); remember(); });
  root.querySelector("[data-add-stock-line]")?.addEventListener("click", () => { journalLines = collectRows(journalRows); dirtyForms.add("stock-journal"); journalLines.push(freshJournalLine()); drawJournal(); remember(); journalRows.lastElementChild.querySelector("select").focus(); });
  journalRows?.addEventListener("click", event => { const button = event.target.closest("[data-remove-stock-line]"); if (!button || journalLines.length < 2) return; journalLines = collectRows(journalRows); dirtyForms.add("stock-journal"); journalLines.splice(Number(button.dataset.removeStockLine), 1); drawJournal(); remember(); });
  root.querySelector('#stock-journal [name="type"]')?.addEventListener("change", () => { journalLines = collectRows(journalRows).map(line => ({ ...freshJournalLine(), ...line })); drawJournal(); remember(); });
  journalRows?.addEventListener("change", event => {
    const field = event.target.dataset.field;
    const index = [...journalRows.children].indexOf(event.target.closest("fieldset"));
    /* The item, direction and batch choice decide which fields the line shows; the unit only changes the hint. */
    if (["itemId", "direction", "trackBatch"].includes(field)) redrawJournal(index, field);
    else if (field === "unit") updateBaseHint(event.target.closest("fieldset"));
  });
  journalRows?.addEventListener("input", event => { if (event.target.dataset.field === "quantity") updateBaseHint(event.target.closest("fieldset")); });
  root.querySelector('#stock-item-settings [name="openingInBatches"]')?.addEventListener("change", () => { allocations = collectRows(allocationRows).map(row => ({ batch: "", manufacturedDate: "", expiryDate: "", ...row })); drawAllocations(); });
  for (const form of root.querySelectorAll("[data-stock-draft]")) { const changed = () => { dirtyForms.add(form.id); remember(); }; form.addEventListener("input", changed); form.addEventListener("change", changed); }
  bindSave("#stock-godown", "/godowns", "POST", form => ({ name: form.elements.name.value }), "Godown added.");
  bindSave("#stock-integration", "/settings", "PUT", form => ({ integrateAccounts: form.elements.integrateAccounts.checked }), "Inventory accounting setting saved.");
  bindSave("#stock-item-settings", "/items/" + encodeURIComponent(item?.itemId || ""), "PUT", form => ({ costingMethod: form.elements.costingMethod.value, openingValuePaise: form.elements.openingValue.value.trim() === "" ? null : parseRupees(form.elements.openingValue.value), openingAllocations: collectRows(allocationRows).map((row, index) => ({ godownId: row.godownId, quantity: row.quantity, valuePaise: row.value.trim() === "" ? null : parseRupees(row.value), ...batchFields(row, `Opening allocation ${index + 1}`) })) }), "Item costing saved.");
  bindSave("#stock-journal", "/journals", "POST", form => ({ date: form.elements.date.value, number: form.elements.number.value, type: form.elements.type.value, lines: collectRows(journalRows).map((line, index) => ({ itemId: line.itemId, quantity: line.quantity, ...unitField(line, index), ...batchFields(line, `Line ${index + 1}`), ...(form.elements.type.value === "transfer" ? { fromGodownId: line.fromGodownId, toGodownId: line.toGodownId } : form.elements.type.value === "physical" ? { godownId: line.godownId } : { direction: line.direction, ...(line.direction === "out" ? { fromGodownId: line.godownId } : { toGodownId: line.godownId }) }), ...(!["transfer"].includes(form.elements.type.value) && line.value?.trim() && (form.elements.type.value === "physical" || line.direction !== "out") ? { valuePaise: parseRupees(line.value) } : {}), reason: line.reason })) }), "Stock journal posted.");
  root.querySelector("#stock-journal")?.addEventListener("keydown", event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.requestSubmit(); } });
  /* Return moves to the next field in the journal and costing forms; ⌘↩ posts the journal. */
  for (const form of [root.querySelector("#stock-journal"), root.querySelector("#stock-item-settings")].filter(Boolean)) {
    form.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing) return;
      if (!["INPUT", "SELECT"].includes(event.target.tagName) || ["submit", "button"].includes(event.target.type)) return;
      event.preventDefault();
      focusNext(form, event.target);
    });
  }
  return true;
}
