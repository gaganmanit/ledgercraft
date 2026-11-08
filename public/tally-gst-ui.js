import { formatINR } from "/money.js";

const components = ["cgst", "sgst", "utgst", "igst", "cess"];
const isPurchase = row => row?.source?.direction === "purchase" || row?.source?.type === "Purchase" || row?.type === "Purchase";
const dateLabel = date => /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date.split("-").reverse().join("-") : date || "—";

export async function installTallyGstReview({ root, api, esc, base, book, still, token, focus }) {
  const section = document.createElement("section");
  section.className = "tally-gst-review";
  section.innerHTML = '<h2>GST from Tally</h2><p data-tally-gst-summary role="status">Checking source invoices…</p><details data-tally-gst-details><summary>Review GST mappings and activation</summary><p>Map the source invoice to dated business, customer or supplier, and item masters. The supporting evidence names the source of missing or corrected GST particulars.</p><p><a data-tally-gst-masters>Open GST registrations, parties and HSN masters</a> · <a data-tally-gst-report download>Download complete GST source review</a></p><div data-tally-gst-enrichment></div><form data-tally-gst-filter class="tally-gst-search"><label>Invoice number, customer or supplier<input name="q" type="search" maxlength="160"></label><button type="submit" class="ghost">Search source invoices</button></form><p data-tally-gst-page role="status"></p><div data-tally-gst-rows aria-busy="false"></div><div class="actions"><button type="button" class="ghost" data-tally-gst-previous disabled>Previous source invoices</button><button type="button" class="ghost" data-tally-gst-next disabled>Next source invoices</button></div><p class="quiet">Activation selects displayed invoices only. Changing pages clears the selection; unsaved mapping drafts are retained.</p><div class="actions"><button type="button" data-tally-gst-activate disabled>Activate selected GST invoices on this page</button><button type="button" class="ghost" data-tally-gst-refresh>Refresh review</button></div><p data-tally-gst-message role="status" aria-live="polite"></p></details>';
  root.querySelector(".tally-workspace").append(section);
  section.querySelector("[data-tally-gst-masters]").href = `${book}/gst`;
  section.querySelector("[data-tally-gst-report]").href = `${base}/gst/report`;
  let state, busy = false, loading = false, generation = 0, offset = 0, search = "";
  const drafts = new Map();
  const mastersBase = base.replace("/api/tally/companies/", "/api/companies/") + "/gst";
  const money = value => esc(formatINR(value || 0));
  const current = () => still(token) && section.isConnected;
  const message = (text, error = false) => {
    const node = section.querySelector("[data-tally-gst-message]");
    node.className = error ? "alert" : "status";
    node.textContent = text;
  };
  const options = (rows, selected, label) => '<option value="">Choose explicitly</option>' + rows.map(row => `<option value="${esc(row.id)}"${row.id === selected ? " selected" : ""}>${esc(label(row))}</option>`).join("");
  const select = (name, title, rows, selected, label = row => row.name) => `<label>${esc(title)}<select name="${esc(name)}" required>${options(rows, selected, label)}</select></label>`;
  const selectedIds = () => [...section.querySelectorAll("[data-tally-gst-select]:checked")].map(node => node.dataset.tallyGstSelect);
  const updateActivation = () => {
    const button = section.querySelector("[data-tally-gst-activate]"), count = selectedIds().length;
    button.disabled = busy || loading || !count;
    button.textContent = count ? `Activate ${count} selected GST invoice${count === 1 ? "" : "s"} on this page` : "Activate selected GST invoices on this page";
  };
  const updatePage = () => {
    const page = state?.page || { offset: 0, limit: 20, total: state?.rows?.length || 0 };
    section.querySelector("[data-tally-gst-page]").textContent = page.total ? `${page.offset + 1}–${Math.min(page.offset + page.limit, page.total)} of ${page.total} matching source invoices` : "No matching source invoices";
    section.querySelector("[data-tally-gst-previous]").disabled = busy || loading || page.offset === 0;
    section.querySelector("[data-tally-gst-next]").disabled = busy || loading || page.offset + page.limit >= page.total;
  };
  const originalPurchaseValue = (source, key) => {
    if (key === "supplierInvoiceNumber") return source.supplierDocument?.sourceNumber ?? source.sourceInvoiceNumber ?? "";
    if (key === "supplierInvoiceDate") return source.supplierDocument?.sourceDate ?? source.sourceInvoiceDate ?? "";
    const supplied = source.placeOfSupplyEvidence?.sourceValue ?? source.placeOfSupply ?? "";
    return state.states?.find(entry => entry.code === supplied || entry.name.toLowerCase() === String(supplied).toLowerCase())?.code || supplied;
  };
  const field = (name, title, attributes = "") => `<label>${esc(title)}<input name="${esc(name)}" ${attributes}></label>`;
  const enrich = () => {
    const target = section.querySelector("[data-tally-gst-enrichment]");
    const existing = [...target.querySelectorAll("form")].map(form => ({ kind: form.dataset.tallyGstMaster, values: Object.fromEntries(new FormData(form)) }));
    const stateSelect = state.states?.length ? select("stateCode", "State / territory", state.states.map(row => ({ ...row, id: row.code })), "", row => `${row.code} · ${row.name}`) : `<label>State code<input name="stateCode" required inputmode="numeric" pattern="[0-9]{2}" maxlength="2" placeholder="For example, 27"></label>`;
    target.innerHTML = `<details class="tally-gst-enrichment"><summary>Add GST masters for source records</summary><p>Use the source ledger and stock item below to retain the imported links. Review the GST facts supplied with each invoice. Use matching source values deliberately, and supply missing details or corrections from supporting evidence.</p><details><summary>Add business registration</summary><form data-tally-gst-master="settings" class="tally-gst-grid">${field("name", "Registration name", 'required maxlength="80"')}${field("legalName", "Legal business name", 'required maxlength="120"')}${field("gstin", "Business GSTIN", 'required minlength="15" maxlength="15"')}${stateSelect}<label>Business address<textarea name="address" required maxlength="600"></textarea></label>${field("pincode", "PIN code", 'pattern="[0-9]{6}" maxlength="6"')}<button type="submit">Save business registration</button></form></details><details><summary>Add customer linked to source ledger</summary><form data-tally-gst-master="parties" class="tally-gst-grid">${select("customerLedgerId", "Original customer ledger", state.ledgers || [], "")}${field("name", "Customer name", 'required maxlength="120"')}${field("gstin", "GSTIN · leave empty for unregistered", 'maxlength="15"')}${stateSelect}<label>Customer address<textarea name="address" required maxlength="600"></textarea></label>${field("pincode", "PIN code", 'pattern="[0-9]{6}" maxlength="6"')}<button type="submit">Save source customer</button></form></details><details><summary>Add HSN to source stock item</summary><form data-tally-gst-master="items" class="tally-gst-grid">${select("stockItemId", "Original stock item", state.sourceStockItems || [], "", item => `${item.name} · ${item.unit}`)}${field("hsnSac", "HSN code", 'required inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8"')}${field("unit", "Unit / UQC", 'required maxlength="12"')}${field("gstRate", "GST rate %", 'required type="number" min="0" max="100" step="0.01"')}${field("cessRate", "Cess rate %", 'required type="number" min="0" max="1000" step="0.01" value="0"')}<button type="submit">Save source item HSN</button></form></details></details>`;
    target.querySelector('[data-tally-gst-master="items"]').closest("details").insertAdjacentHTML("beforebegin", `<details><summary>Add supplier linked to source ledger</summary><form data-tally-gst-master="suppliers" class="tally-gst-grid">${select("supplierLedgerId", "Original supplier ledger", state.ledgers || [], "")}${field("name", "Supplier name", 'required maxlength="120"')}${field("gstin", "Supplier GSTIN · leave empty for unregistered", 'maxlength="15"')}${stateSelect}<label>Supplier address<textarea name="address" required maxlength="600"></textarea></label>${field("pincode", "PIN code", 'pattern="[0-9]{6}" maxlength="6"')}<button type="submit">Save source supplier</button></form></details>`);
    for (const form of target.querySelectorAll("form")) {
      const draft = existing.find(entry => entry.kind === form.dataset.tallyGstMaster);
      if (draft) for (const [name, value] of Object.entries(draft.values)) if (form.elements[name]) form.elements[name].value = value;
      form.elements.stockItemId?.addEventListener("change", () => { form.elements.unit.value = state.sourceStockItems.find(item => item.id === form.elements.stockItemId.value)?.unit?.toUpperCase() || ""; });
      form.addEventListener("submit", async event => {
        event.preventDefault();
        if (busy || !form.reportValidity()) return;
        const body = Object.fromEntries(new FormData(form));
        const kind = form.dataset.tallyGstMaster;
        if (kind === "parties") body.kind = "customer";
        if (kind === "suppliers") body.kind = "supplier";
        if (kind === "items") {
          const item = state.sourceStockItems.find(entry => entry.id === body.stockItemId);
          Object.assign(body, { name: item.name, kind: "goods", openingQuantity: item.openingQuantity, pricePaise: 0, purchasePricePaise: 0, supplyStatus: "taxable", gstRateBps: Math.round(Number(body.gstRate) * 100), cessRateBps: Math.round(Number(body.cessRate) * 100) });
          delete body.gstRate; delete body.cessRate;
        }
        busy = true;
        for (const button of section.querySelectorAll("button")) button.disabled = true;
        try {
          await api(`${mastersBase}/${kind === "suppliers" ? "parties" : kind}`, { method: kind === "settings" ? "PUT" : "POST", body });
          if (!current()) return;
          form.reset();
          await show();
          section.querySelector("[data-tally-gst-enrichment] > details").open = true;
          message("Source master saved. Select it explicitly on each invoice mapping.");
        } catch (error) { if (current()) message(error.message, true); }
        finally { busy = false; if (current()) { for (const button of section.querySelectorAll("button")) button.disabled = false; updateActivation(); updatePage(); } }
      });
    }
  };
  const factValue = value => value === null || value === undefined ? "Not supplied" : typeof value === "object" ? JSON.stringify(value) : String(value);
  const evidenceHtml = evidence => (evidence || []).map(entry => `<li>${entry.recordId ? `<a href="${book}/tally-source/${encodeURIComponent(entry.recordId)}">${esc(entry.file || "Source record")}</a>` : esc(entry.file || "Source")}: ${esc(entry.fieldPath || "")}${entry.effectiveFrom ? ` · effective ${esc(dateLabel(entry.effectiveFrom))}` : ""} · ${esc(factValue(entry.sourceValue))}${entry.reason ? ` · ${esc(({ "future-effective": "Not effective on invoice date", "earlier-effective": "Earlier effective value", "invoice-override": "Replaced by invoice override" })[entry.reason] || entry.reason)}` : ""}</li>`).join("");
  const factHtml = (label, fact, rate = false) => {
    if (!fact) return "";
    const status = { absent: "Not supplied for this date", supplied: "Supplied", conflict: "Needs source review" }[fact.status] || fact.status;
    const value = fact.value === null || fact.value === undefined ? "" : rate && typeof fact.value === "number" ? `${fact.value / 100}%` : factValue(fact.value);
    return `<div class="tally-gst-fact" data-fact-status="${esc(fact.status)}"><strong>${esc(label)}</strong><span>${esc(status)}${value ? ` · ${esc(value)}` : ""}</span>${fact.evidence?.length ? `<ul>${evidenceHtml(fact.evidence)}</ul>` : ""}${fact.issues?.length ? `<ul>${fact.issues.map(issue => `<li>${esc(issue.message || issue)}</li>`).join("")}</ul>` : ""}${fact.superseded?.length ? `<details><summary>Other dated source facts (${fact.superseded.length})</summary><ul>${evidenceHtml(fact.superseded)}</ul></details>` : ""}</div>`;
  };
  const factsHtml = row => {
    const facts = row.source?.taxFacts;
    if (!facts) return "";
    const suggestions = row.suggestions || {};
    const prepare = (kind, label, sourceName = "") => row.status === "active" ? "" : `<button type="button" class="ghost" data-tally-gst-prepare="${kind}" data-source-name="${esc(sourceName)}">${esc(label)}</button>`;
    const purchase = isPurchase(row);
    const identities = purchase
      ? `${factHtml("Supplier GSTIN (seller)", facts.sellerGstin)}${suggestions.party ? prepare("party", "Prepare supplier master from supplied GSTIN") : ""}${factHtml("Your business GSTIN (buyer)", facts.buyerGstin)}${suggestions.registration ? prepare("seller", "Prepare buyer business registration from supplied GSTIN") : ""}`
      : `${factHtml("Seller GSTIN", facts.sellerGstin)}${suggestions.registration ? prepare("seller", "Prepare seller master from supplied GSTIN") : ""}${factHtml("Customer GSTIN", facts.buyerGstin)}${suggestions.party ? prepare("party", "Prepare customer master from supplied GSTIN") : ""}`;
    return `<details class="tally-gst-facts"><summary>GST facts supplied with the source</summary>${identities}${(facts.items || []).map(item => {
      const suggestion = suggestions.items?.find(entry => entry.sourceName === item.sourceName);
      return `<h4>${esc(item.sourceName)}</h4>${factHtml("HSN / SAC", item.hsnSac)}${factHtml("GST rate", item.gstRateBps, true)}${factHtml("Supply type", item.supplyType)}${factHtml("Taxability", item.taxability)}${suggestion?.stockItemId && suggestion.kind !== "service" && (!suggestion.supplyStatus || suggestion.supplyStatus === "taxable") ? prepare("item", "Prepare item master from supplied facts", item.sourceName) : ""}`;
    }).join("")}${row.status === "active" ? "" : '<p><button type="button" class="ghost" data-tally-gst-match-source>Use saved masters matching source identities</button></p>'}</details>`;
  };
  const renderCorrections = (form, row) => {
    const target = form.querySelector("[data-tally-gst-corrections]");
    if (!target) return;
    form.sourceReasons ||= { ...(row.mapping?.sourceCorrections || {}) };
    form.sourceChoices ||= {};
    for (const input of target.querySelectorAll("input")) form.sourceReasons[input.name.slice("sourceCorrection:".length)] = input.value;
    for (const select of target.querySelectorAll("select")) form.sourceChoices[select.name.slice("sourceChoice:".length)] = select.value;
    const facts = row.source?.taxFacts || {};
    const registration = state.registrations.find(entry => entry.id === form.elements.registrationId.value);
    const party = state.parties.find(entry => entry.id === form.elements.partyId.value);
    const checks = isPurchase(row)
      ? [["sellerGstin", "Supplier GSTIN", facts.sellerGstin, party?.gstin], ["buyerGstin", "Your business GSTIN", facts.buyerGstin, registration?.gstin]]
      : [["sellerGstin", "Seller GSTIN", facts.sellerGstin, registration?.gstin], ["buyerGstin", "Customer GSTIN", facts.buyerGstin, party?.gstin]];
    if (isPurchase(row)) {
      const source = row.source;
      for (const [key, label, sourceKey] of [["supplierInvoiceNumber", "Supplier invoice number", "sourceInvoiceNumber"], ["supplierInvoiceDate", "Supplier invoice date", "sourceInvoiceDate"], ["placeOfSupply", "Place of supply", "placeOfSupply"]]) {
        const value = originalPurchaseValue(source, key);
        checks.push([key, label, { status: value ? "supplied" : "absent", value }, form.elements[key]?.value || undefined]);
      }
    }
    [...new Set(row.source.items.map(item => item.sourceName))].forEach((sourceName, index) => {
      const item = state.items.find(entry => entry.id === form.elements[`item-${index}`].value);
      const source = facts.items?.find(entry => entry.sourceName === sourceName);
      if (source) checks.push([`item:${sourceName}:hsnSac`, `${sourceName} HSN / SAC`, source.hsnSac, item?.hsnSac], [`item:${sourceName}:gstRateBps`, `${sourceName} GST rate`, source.gstRateBps, item?.gstRateBps], [`item:${sourceName}:supplyType`, `${sourceName} supply type`, source.supplyType, item?.kind], [`item:${sourceName}:taxability`, `${sourceName} taxability`, source.taxability, item?.supplyStatus]);
    });
    const differs = (fact, selected) => String(fact.value).trim().toUpperCase() !== String(selected).trim().toUpperCase();
    const datedItem = key => key.startsWith("item:") && (key.endsWith(":hsnSac") || key.endsWith(":gstRateBps"));
    const historical = checks.filter(([key, , fact, selected]) => datedItem(key) && fact?.status === "supplied" && selected !== undefined && differs(fact, selected));
    for (const [key] of historical) form.sourceChoices[key] ||= row.mapping?.sourceCorrections?.[key] ? "master" : "source";
    const different = checks.filter(([key, , fact, selected]) => fact && selected !== undefined && (fact.status === "conflict" || fact.status === "supplied" && differs(fact, selected) && (!datedItem(key) || form.sourceChoices[key] === "master")));
    const display = (key, value) => key.endsWith(":gstRateBps") ? `${Number(value) / 100}%` : String(value);
    target.innerHTML = (historical.length ? `<h3>Dated source or current master</h3><p>The supplied source value applies to this invoice date. The current master stays unchanged.</p>${historical.map(([key, label, fact, selected]) => `<label>${esc(label)} · source ${esc(display(key, fact.value))} · current master ${esc(display(key, selected))}<select name="${esc("sourceChoice:" + key)}"><option value="source"${form.sourceChoices[key] === "source" ? " selected" : ""}>Use supplied source for this document</option><option value="master"${form.sourceChoices[key] === "master" ? " selected" : ""}>Use current master as an evidenced correction</option></select></label>`).join("")}` : "") + (different.length ? `<h3>Reasons for source corrections</h3><p>Record the reason and supporting evidence for each selected correction or unresolved source fact.</p>${different.map(([key, label]) => `<label>${esc(label)} · correction reason<input name="${esc("sourceCorrection:" + key)}" value="${esc(form.sourceReasons[key] || "")}" required maxlength="500"></label>`).join("")}` : "");
  };
  const bindSourceFacts = () => {
    for (const button of section.querySelectorAll("[data-tally-gst-prepare]")) button.addEventListener("click", () => {
      if (busy) return;
      const row = state.rows.find(entry => entry.recordId === button.closest("[data-tally-gst-record]").dataset.tallyGstRecord);
      let kind, values;
      if (button.dataset.tallyGstPrepare === "seller") {
        kind = "settings"; values = { gstin: row.suggestions.registration.gstin, stateCode: row.suggestions.registration.stateCode };
      } else if (button.dataset.tallyGstPrepare === "party") {
        kind = isPurchase(row) ? "suppliers" : "parties"; values = { [isPurchase(row) ? "supplierLedgerId" : "customerLedgerId"]: row.source.partyLedgerId, name: row.source.partyName, gstin: row.suggestions.party.gstin, stateCode: row.suggestions.party.stateCode };
      } else {
        kind = "items";
        const suggestion = row.suggestions.items.find(entry => entry.sourceName === button.dataset.sourceName);
        const item = state.sourceStockItems.find(entry => entry.id === suggestion.stockItemId);
        values = { stockItemId: suggestion.stockItemId, hsnSac: suggestion.hsnSac || "", gstRate: suggestion.gstRateBps === undefined ? "" : String(suggestion.gstRateBps / 100), unit: item?.unit?.toUpperCase() || "" };
      }
      const form = section.querySelector(`[data-tally-gst-master="${kind}"]`);
      for (const [name, value] of Object.entries(values)) if (form.elements[name]) form.elements[name].value = value;
      for (let detail = form.closest("details"); detail && section.contains(detail); detail = detail.parentElement.closest("details")) detail.open = true;
      form.scrollIntoView({ block: "start" });
      message("Supplied source values copied into the master form. Review them, complete the remaining details and save explicitly.");
    });
    for (const button of section.querySelectorAll("[data-tally-gst-match-source]")) button.addEventListener("click", () => {
      if (busy) return;
      const row = state.rows.find(entry => entry.recordId === button.closest("[data-tally-gst-record]").dataset.tallyGstRecord);
      const form = button.closest("[data-tally-gst-record]").querySelector("[data-tally-gst-mapping]");
      const suggestions = row.suggestions || {};
      let matched = 0;
      const registration = suggestions.registration && state.registrations.find(entry => entry.gstin === suggestions.registration.gstin);
      const party = suggestions.party && state.parties.find(entry => entry.gstin === suggestions.party.gstin && entry[isPurchase(row) ? "supplierLedgerId" : "customerLedgerId"] === row.source.partyLedgerId);
      if (registration) { form.elements.registrationId.value = registration.id; matched++; }
      if (party) { form.elements.partyId.value = party.id; matched++; }
      [...new Set(row.source.items.map(item => item.sourceName))].forEach((sourceName, index) => {
        const suggestion = suggestions.items?.find(entry => entry.sourceName === sourceName);
        if (!suggestion) return;
        const item = state.items.find(entry => (entry.stockItemId || entry.id) === suggestion.stockItemId);
        if (item) { form.elements[`item-${index}`].value = item.id; matched++; }
      });
      form.elements.registrationId.dispatchEvent(new Event("input", { bubbles: true }));
      message(matched ? `${matched} saved master${matched === 1 ? "" : "s"} matching source identities selected. Review dated source facts and every choice and save the invoice mapping.` : "No saved GST masters match the supplied facts. Prepare a master from the source facts or enter an evidenced correction.");
    });
  };
  const rowHtml = row => {
    const source = row.source || {}, mapping = row.mapping || {}, evidence = mapping.evidence || {};
    const purchase = isPurchase(row), type = row.type || source.type || (purchase ? "Purchase" : "Sales");
    const partyName = purchase ? "Supplier" : "Customer", tradeRole = purchase ? "purchase" : "sales";
    const items = [...new Map((source.items || []).map(item => [item.sourceName, item])).values()];
    const taxes = source.taxes || {};
    const roles = ["party", tradeRole, ...components.filter(key => taxes[`${key}Paise`] || taxes[key] || mapping.accounts?.[key])];
    const problems = [...(row.blockers || []), ...(row.discrepancies || [])];
    const active = row.status === "active";
    const reusable = state.rows.filter(entry => entry.recordId !== row.recordId && entry.mapping?.registrationId && isPurchase(entry) === purchase);
    const review = mapping.purchaseReview || {};
    const supplierNumber = review.supplierInvoiceNumber || source.sourceInvoiceNumber || "";
    const supplierDate = review.supplierInvoiceDate || source.sourceInvoiceDate || "";
    const receivedDate = review.receivedDate || "";
    const placeOfSupply = review.placeOfSupply || source.placeOfSupply || "";
    const purchaseIdentity = purchase ? `<dl class="tally-fields" data-tally-purchase-identities><dt>Internal accounting voucher</dt><dd>${esc(row.number || "Not supplied")} · ${esc(dateLabel(row.date))}</dd><dt>Original voucher</dt><dd>${esc(source.sourceVoucherNumber || row.sourceNumber || "Not supplied")} · ${esc(dateLabel(source.sourceVoucherDate || row.date))}</dd><dt>Source supplier invoice</dt><dd>${esc(originalPurchaseValue(source, "supplierInvoiceNumber") || "Not supplied")} · ${esc(dateLabel(originalPurchaseValue(source, "supplierInvoiceDate")))}</dd>${active ? `<dt>Reviewed supplier invoice</dt><dd>${esc(supplierNumber || "Not supplied")} · ${esc(dateLabel(supplierDate))}</dd><dt>Goods received</dt><dd>${esc(dateLabel(receivedDate))}</dd>` : ""}</dl>` : "";
    const purchaseReview = purchase ? `<h3>Supplier document and receipt review</h3><div class="tally-gst-grid"><label>Supplier invoice number<input name="supplierInvoiceNumber" required maxlength="16" value="${esc(supplierNumber)}"></label><label>Supplier invoice date<input name="supplierInvoiceDate" type="date" required value="${esc(supplierDate)}"></label><label>Goods received date<input name="receivedDate" type="date" required value="${esc(receivedDate)}"></label>${select("placeOfSupply", "Reviewed place of supply", (state.states || []).map(entry => ({ ...entry, id: entry.code })), placeOfSupply, entry => `${entry.code} · ${entry.name}`)}</div><p data-tally-purchase-pos>Source place of supply: ${esc(source.placeOfSupply || "Not supplied")}. Review it against the selected business and supplier states.</p><p class="status" data-tally-purchase-itc>ITC on activation: Pending review. Use Purchase ITC review for a later credit decision.</p><label class="tally-gst-selection"><input name="purchaseReviewed" type="checkbox" value="reviewed" required${mapping.purchaseReview ? " checked" : ""}>I reviewed the supplier document, receipt date, place of supply and original postings. Credit starts pending review.</label>` : "";
    const form = `<form data-tally-gst-mapping>${reusable.length ? `<div class="tally-gst-copy"><label>Reuse business registration, evidence and matching item mappings<select data-copy-source><option value="">Choose a saved ${purchase ? "purchase" : "sales"} mapping</option>${reusable.map(entry => `<option value="${esc(entry.recordId)}">${esc(entry.number)}</option>`).join("")}</select></label><button type="button" class="ghost" data-copy-mapping>Copy into this draft</button></div>` : ""}<div class="tally-gst-grid">${select("registrationId", purchase ? "Your business registration (buyer)" : "Seller registration", state.registrations || [], mapping.registrationId, item => `${item.gstin} · ${item.name || item.legalName}`)}${select("partyId", partyName, (state.parties || []).filter(item => !item.kind || item.kind === "both" || item.kind === (purchase ? "supplier" : "customer")), mapping.partyId, item => `${item.name} · ${item.gstin || "Unregistered"}`)}<label>Stock treatment<select name="stockMode" required><option value="source"${mapping.stockMode !== "report-only" ? " selected" : ""}>Use reviewed original stock movement</option><option value="report-only"${mapping.stockMode === "report-only" ? " selected" : ""}>GST reporting only · actual quantity unresolved</option></select></label></div>${purchaseReview}<h3>Item and HSN mappings</h3>${items.map((item, index) => `<div class="tally-gst-item"><p>${esc(item.sourceName)} · actual ${item.actualQuantity === null || item.actualQuantity === undefined ? "unresolved" : esc(item.actualQuantity + " " + item.unit)} · billed ${esc(item.quantity)} ${esc(item.unit)} · source item value ₹${money(item.valuePaise ?? item.taxablePaise)}</p>${select(`item-${index}`, "GST item · current master HSN", state.items || [], (mapping.items || []).find(entry => entry.sourceName === item.sourceName)?.itemId, entry => `${entry.name} · ${entry.hsnSac} · ${entry.unit || "Service"}`)}</div>`).join("")}<h3>Original posting accounts</h3><p class="quiet">Choose the ledgers used by the imported accounting voucher.</p><ul class="tally-gst-postings">${(source.postings || []).map(line => `<li>${esc(line.name)} · ${esc(line.dc)} ₹${money(line.paise)}</li>`).join("")}</ul><div class="tally-gst-grid">${roles.map(role => select(`account-${role}`, role === "party" ? `${partyName} ledger` : role === tradeRole ? `${purchase ? "Purchase" : "Sales"} ledger` : `${role.toUpperCase()} ${purchase ? "input tax " : ""}ledger`, state.ledgers || [], mapping.accounts?.[role])).join("")}</div><div data-tally-gst-corrections></div><div class="tally-gst-grid"><label>Supporting evidence name<input name="evidenceName" required maxlength="120" value="${esc(evidence.name || "")}"></label><label>Supporting evidence reference<input name="evidenceReference" required maxlength="500" value="${esc(evidence.reference || "")}"></label></div><p class="actions"><button type="submit">Save invoice mapping</button>${row.status === "ready" ? `<label class="tally-gst-selection"><input type="checkbox" data-tally-gst-select="${esc(row.recordId)}">Select for GST activation</label>` : ""}</p><p data-tally-gst-row-message role="status"></p></form>`;
    return `<details class="tally-gst-invoice" data-tally-gst-record="${esc(row.recordId)}" data-tally-gst-type="${esc(type)}"><summary><span>${esc(type)} · <strong>${esc(row.number || "Unnumbered invoice")}</strong>${row.sourceNumber && row.sourceNumber !== row.number ? ` · source ${esc(row.sourceNumber)}` : ""} · ${esc(dateLabel(row.date))} · ${esc(source.partyName || `Source ${partyName.toLowerCase()}`)}</span><span>${money(source.totalPaise)} · ${esc({ blocked: "Needs mapping", ready: "Ready", active: "Active" }[row.status] || row.status)}</span></summary><p><a href="${book}/tally-source/${encodeURIComponent(row.recordId)}">Open original source record</a>${row.voucherId ? ` · <a href="${book}/v/${encodeURIComponent(type)}/${encodeURIComponent(row.voucherId)}">Open accounting voucher</a>` : ""}${purchase && active && row.voucherId ? ` · <a href="${book}/gst-document/${encodeURIComponent(row.voucherId)}">Open GST purchase</a> · <a href="${book}/gst-itc/${encodeURIComponent(row.voucherId)}">Open purchase ITC review</a>` : ""}</p>${purchaseIdentity}<p>${purchase ? "Source supplier GSTIN" : "Source customer GSTIN"}: ${esc(source.gstin || "Not supplied")} · place of supply: ${esc(source.placeOfSupply || "Not supplied")}</p>${factsHtml(row)}${problems.length ? `<ul class="tally-gst-problems">${problems.map(problem => `<li>${esc(problem.message || problem)}</li>`).join("")}</ul>` : ""}${!row.source ? '<p>Resolve the source exception before mapping this invoice.</p>' : active ? `<p class="status">GST ${purchase ? "purchase" : "invoice"} activated from the retained source.</p>${purchase ? '<p data-tally-purchase-itc>Imported with ITC pending review. Use Purchase ITC review for dated credit decisions.</p>' : ""}` : form}<details class="tally-gst-original"><summary>Source items, tax, transport and references</summary><pre>${esc(JSON.stringify(source, null, 2))}</pre></details></details>`;
  };
  const updatePurchaseContext = (form, row) => {
    const target = form.querySelector("[data-tally-purchase-pos]");
    if (!target) return;
    const registration = state.registrations.find(entry => entry.id === form.elements.registrationId.value);
    const party = state.parties.find(entry => entry.id === form.elements.partyId.value);
    const stateName = code => state.states?.find(entry => entry.code === code)?.name || code || "Not selected";
    target.textContent = `Source place of supply: ${stateName(originalPurchaseValue(row.source, "placeOfSupply"))}. Reviewed place of supply: ${stateName(form.elements.placeOfSupply.value)}. Buyer state: ${stateName(registration?.stateCode)}. Supplier state: ${stateName(party?.stateCode)}.`;
  };
  const show = async () => {
    const request = ++generation;
    loading = true;
    section.querySelector("[data-tally-gst-rows]").setAttribute("aria-busy", "true");
    updateActivation(); updatePage();
    try {
      const query = new URLSearchParams({ view: "desk", q: search, offset: String(offset) });
      const result = await api(`${base}/gst?${query}`);
      if (!current() || request !== generation) return;
      state = result;
      const summary = state.summary;
      enrich();
      section.querySelector("[data-tally-gst-summary]").textContent = `${summary.sourceInvoices} source invoices · ${summary.active} active · ${summary.ready} ready · ${summary.blocked} need review · source item value ₹${formatINR(summary.sourceItemValuePaise ?? summary.taxablePaise ?? 0)} · classified taxable ₹${formatINR(summary.taxablePaise || 0)} · tax ₹${formatINR(summary.taxPaise || 0)}`;
      section.querySelector("[data-tally-gst-rows]").innerHTML = (state.rows || []).map(rowHtml).join("") || '<p>No source invoices match this search.</p>';
      for (const form of section.querySelectorAll("[data-tally-gst-mapping]")) {
        form.addEventListener("input", event => {
          if (event.target.matches("[data-tally-gst-select]")) return;
          if (["registrationId", "partyId"].includes(event.target.name) || event.target.name.startsWith("item-") || event.target.name.startsWith("sourceChoice:") || event.target.name.startsWith("supplierInvoice") || event.target.name === "placeOfSupply") renderCorrections(form, state.rows.find(row => row.recordId === form.closest("[data-tally-gst-record]").dataset.tallyGstRecord));
          if (event.target.name.startsWith("sourceChoice:")) form.elements[event.target.name]?.focus();
          if (form.elements.purchaseReviewed && event.target.name !== "purchaseReviewed") form.elements.purchaseReviewed.checked = false;
          updatePurchaseContext(form, state.rows.find(row => row.recordId === form.closest("[data-tally-gst-record]").dataset.tallyGstRecord));
          drafts.set(form.closest("[data-tally-gst-record]").dataset.tallyGstRecord, Object.fromEntries(new FormData(form)));
          delete form.dataset.requestId;
          const checkbox = form.querySelector("[data-tally-gst-select]");
          if (checkbox) { checkbox.checked = false; checkbox.disabled = true; }
          updateActivation();
        });
        renderCorrections(form, state.rows.find(row => row.recordId === form.closest("[data-tally-gst-record]").dataset.tallyGstRecord));
        const draft = drafts.get(form.closest("[data-tally-gst-record]").dataset.tallyGstRecord);
        if (draft) {
          for (const [name, value] of Object.entries(draft)) if (form.elements[name]) form.elements[name].value = value;
          for (const [name, value] of Object.entries(draft)) if (name.startsWith("sourceChoice:")) form.sourceChoices[name.slice("sourceChoice:".length)] = value;
          renderCorrections(form, state.rows.find(row => row.recordId === form.closest("[data-tally-gst-record]").dataset.tallyGstRecord));
          for (const [name, value] of Object.entries(draft)) if (form.elements[name]) form.elements[name].value = value;
          if (form.elements.purchaseReviewed) form.elements.purchaseReviewed.checked = draft.purchaseReviewed === "reviewed";
          const checkbox = form.querySelector("[data-tally-gst-select]");
          if (checkbox) checkbox.disabled = true;
        }
        updatePurchaseContext(form, state.rows.find(row => row.recordId === form.closest("[data-tally-gst-record]").dataset.tallyGstRecord));
        form.querySelector("[data-copy-mapping]")?.addEventListener("click", () => {
          const source = state.rows.find(row => row.recordId === form.querySelector("[data-copy-source]").value);
          if (!source?.mapping) return;
          const mapping = source.mapping;
          form.elements.registrationId.value = mapping.registrationId || "";
          form.elements.evidenceName.value = mapping.evidence?.name || "";
          form.elements.evidenceReference.value = mapping.evidence?.reference || "";
          for (const role of [isPurchase(source) ? "purchase" : "sales", ...components]) if (form.elements[`account-${role}`]) form.elements[`account-${role}`].value = mapping.accounts?.[role] || "";
          const row = state.rows.find(entry => entry.recordId === form.closest("[data-tally-gst-record]").dataset.tallyGstRecord);
          [...new Set(row.source.items.map(item => item.sourceName))].forEach((sourceName, index) => { form.elements[`item-${index}`].value = mapping.items?.find(item => item.sourceName === sourceName)?.itemId || ""; });
          form.elements.registrationId.dispatchEvent(new Event("input", { bubbles: true }));
          form.querySelector("[data-tally-gst-row-message]").textContent = "Copied the business registration, evidence, shared posting accounts and matching items. Review the party and every copied choice, then save.";
        });
        form.addEventListener("submit", async event => {
          event.preventDefault();
          if (busy || !form.reportValidity()) return;
          const row = state.rows.find(entry => entry.recordId === form.closest("[data-tally-gst-record]").dataset.tallyGstRecord);
          const sourceItems = [...new Set(row.source.items.map(item => item.sourceName))];
          const data = new FormData(form);
          form.dataset.requestId ||= crypto.randomUUID();
          busy = true;
          for (const control of section.querySelectorAll("button")) control.disabled = true;
          try {
            await api(`${base}/gst/mapping`, { method: "POST", body: { requestId: form.dataset.requestId, compact: true, revision: state.revision, recordId: row.recordId, stockMode: data.get("stockMode"), ...(isPurchase(row) ? { purchaseReview: { supplierInvoiceNumber: data.get("supplierInvoiceNumber"), supplierInvoiceDate: data.get("supplierInvoiceDate"), receivedDate: data.get("receivedDate"), placeOfSupply: data.get("placeOfSupply"), itcEligibility: "pending" } } : {}), sourceCorrections: Object.fromEntries([...data.entries()].filter(([key]) => key.startsWith("sourceCorrection:")).map(([key, value]) => [key.slice("sourceCorrection:".length), value])), registrationId: data.get("registrationId"), partyId: data.get("partyId"), items: sourceItems.map((sourceName, index) => ({ sourceName, itemId: data.get(`item-${index}`) })), accounts: Object.fromEntries(["party", isPurchase(row) ? "purchase" : "sales", ...components].filter(role => data.has(`account-${role}`)).map(role => [role, data.get(`account-${role}`)])), evidence: { name: data.get("evidenceName"), reference: data.get("evidenceReference") } } });
            if (!current()) return;
            drafts.delete(row.recordId);
            await show();
            const saved = [...section.querySelectorAll("[data-tally-gst-record]")].find(node => node.dataset.tallyGstRecord === row.recordId);
            if (saved) { saved.open = true; saved.querySelector("[data-tally-gst-select]")?.focus(); }
            message("Invoice mapping saved. Review its status before selecting it for activation.");
          } catch (error) { if (current()) { form.querySelector("[data-tally-gst-row-message]").textContent = error.message; message(error.message, true); } }
          finally { busy = false; if (current()) { for (const control of section.querySelectorAll("button")) control.disabled = false; updateActivation(); updatePage(); } }
        });
      }
      bindSourceFacts();
      for (const checkbox of section.querySelectorAll("[data-tally-gst-select]")) checkbox.addEventListener("change", () => { delete section.querySelector("[data-tally-gst-activate]").dataset.requestId; updateActivation(); });
      updateActivation();
    } catch (error) { if (current() && request === generation) message(error.message, true); }
    finally { if (current() && request === generation) { loading = false; section.querySelector("[data-tally-gst-rows]").setAttribute("aria-busy", "false"); updateActivation(); updatePage(); } }
  };
  section.querySelector("[data-tally-gst-filter]").addEventListener("submit", event => {
    event.preventDefault(); if (busy) return;
    search = event.currentTarget.elements.q.value.trim(); offset = 0; show();
  });
  section.querySelector("[data-tally-gst-previous]").addEventListener("click", () => {
    if (busy || loading) return; const page = state.page || { offset, limit: 20 }; offset = Math.max(0, page.offset - page.limit); show();
  });
  section.querySelector("[data-tally-gst-next]").addEventListener("click", () => {
    if (busy || loading) return; const page = state.page || { offset, limit: 20 }; offset = page.offset + page.limit; show();
  });
  section.querySelector("[data-tally-gst-refresh]").addEventListener("click", async () => {
    if (busy) return;
    await show();
    message("Source review refreshed.");
  });
  section.querySelector("[data-tally-gst-activate]").addEventListener("click", async event => {
    const recordIds = selectedIds();
    if (busy || loading || !recordIds.length) return;
    const button = event.currentTarget;
    button.dataset.requestId ||= crypto.randomUUID();
    busy = true;
    for (const control of section.querySelectorAll("button")) control.disabled = true;
    try {
      await api(`${base}/gst/activate`, { method: "POST", body: { requestId: button.dataset.requestId, compact: true, revision: state.revision, reviewHash: state.reviewHash, recordIds } });
      if (!current()) return;
      delete button.dataset.requestId;
      await show();
      message(`${recordIds.length} GST invoice${recordIds.length === 1 ? "" : "s"} activated.`);
    } catch (error) { if (current()) message(error.message, true); }
    finally { busy = false; if (current()) { for (const control of section.querySelectorAll("button")) control.disabled = false; updateActivation(); updatePage(); } }
  });
  await show();
  if (focus && current()) { section.querySelector("[data-tally-gst-details]").open = true; section.scrollIntoView({ block: "start" }); }
}
