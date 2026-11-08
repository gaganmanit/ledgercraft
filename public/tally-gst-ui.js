import { formatINR, parseRupees } from "/money.js";

const components = ["cgst", "sgst", "utgst", "igst", "cess"];
const isPurchase = row => row?.source?.direction === "purchase" || row?.source?.type === "Purchase" || row?.type === "Purchase";
const isNote = row => row?.source?.note === true || ["Credit Note", "Debit Note"].includes(row?.type);
const goodsRows = source => (source?.items || []).filter(item => item.kind !== "service");
const serviceRows = source => [...new Map([...(source?.items || []).filter(item => item.kind === "service"), ...(source?.serviceCandidates || [])].map(item => [item.sourceLineId, item])).values()].sort((a, b) => a.sourceLineId.localeCompare(b.sourceLineId, undefined, { numeric: true }));
/* Dates shown to people are dd-mm-yyyy, whether the source wrote yyyy-mm-dd or Tally's yyyymmdd. */
const dateLabel = date => {
  const text = String(date ?? "");
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) || /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  return iso ? `${iso[3]}-${iso[2]}-${iso[1]}` : text || "—";
};

export async function installTallyGstReview({ root, api, esc, base, book, still, token, focus }) {
  const section = document.createElement("section");
  section.className = "subsection tally-gst-review";
  section.innerHTML = '<h2>GST from Tally</h2><p data-tally-gst-summary role="status">Checking source invoices…</p><div class="details-list"><details data-tally-gst-details><summary>Review GST mappings and activation</summary><p>Map each source invoice to dated business, customer or supplier, and item masters. The supporting evidence names the source of missing or corrected GST particulars.</p><p class="tally-gst-links"><a data-tally-gst-masters>Open GST registrations, parties and HSN masters</a><a data-tally-gst-report download>Download complete GST source review</a></p><div data-tally-gst-enrichment></div><form data-tally-gst-filter class="toolbar"><label class="grow">Invoice number, customer or supplier<input name="q" type="search" maxlength="160"></label><button type="submit" class="ghost">Search source invoices</button></form><p data-tally-gst-page class="quiet" role="status"></p><div data-tally-gst-rows aria-busy="false"></div><div class="actions"><button type="button" class="ghost" data-tally-gst-previous disabled>Previous source invoices</button><button type="button" class="ghost" data-tally-gst-next disabled>Next source invoices</button></div><p class="form-note">Activation applies to invoices selected on this page only. Changing pages clears the selection; unsaved mapping drafts are kept.</p><div class="actions"><button type="button" data-tally-gst-activate disabled>Activate selected GST invoices on this page</button><button type="button" class="ghost" data-tally-gst-refresh>Refresh review</button></div><p data-tally-gst-message class="form-message" role="status" aria-live="polite"></p></details></div>';
  root.querySelector(".tally-workspace").append(section);
  section.querySelector("[data-tally-gst-masters]").href = `${book}/gst`;
  section.querySelector("[data-tally-gst-report]").href = `${base}/gst/report`;
  let state, busy = false, loading = false, generation = 0, offset = 0, search = "";
  const drafts = new Map();
  const noteOriginals = new Map(), noteLookups = new Map();
  const mastersBase = base.replace("/api/tally/companies/", "/api/companies/") + "/gst";
  const money = value => esc(formatINR(value || 0));
  const current = () => still(token) && section.isConnected;
  const message = (text, error = false, reveal = true) => {
    const node = section.querySelector("[data-tally-gst-message]");
    node.className = `form-message ${error ? "alert" : "status"}`;
    node.setAttribute("role", error ? "alert" : "status");
    node.textContent = text;
    if (error && reveal) node.scrollIntoView({ block: "nearest" });
  };
  const rowMessage = (form, text, tone) => {
    const node = form.querySelector("[data-tally-gst-row-message]");
    node.className = `form-message ${tone}`;
    node.setAttribute("role", tone === "alert" ? "alert" : "status");
    node.textContent = text;
    if (tone === "alert") node.scrollIntoView({ block: "nearest" });
  };
  /* A master form's own message sits directly below that form, inside the nested disclosure. */
  const masterMessage = (form, text, tone = "quiet") => {
    const node = form.querySelector("[data-tally-gst-master-message]");
    node.className = `wide form-message ${tone}`;
    node.setAttribute("role", tone === "alert" ? "alert" : "status");
    node.textContent = text;
    if (tone === "alert" && text) node.scrollIntoView({ block: "nearest" });
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
    updateNoteButtons();
  };
  const originalPurchaseValue = (source, key) => {
    if (key === "supplierInvoiceNumber") return source.supplierDocument?.sourceNumber ?? source.sourceInvoiceNumber ?? "";
    if (key === "supplierInvoiceDate") return source.supplierDocument?.sourceDate ?? source.sourceInvoiceDate ?? "";
    const supplied = source.placeOfSupplyEvidence?.sourceValue ?? source.placeOfSupply ?? "";
    return state.states?.find(entry => entry.code === supplied || entry.name.toLowerCase() === String(supplied).toLowerCase())?.code || supplied;
  };
  const noteOriginal = id => noteOriginals.get(id);
  const originalNumber = invoice => invoice?.direction === "purchase" ? invoice.supplierInvoiceNumber : invoice?.number;
  const originalDate = invoice => invoice?.direction === "purchase" ? invoice.supplierInvoiceDate || invoice.date : invoice?.date;
  const originalNoteValue = (source, key) => key === "originalNumber" ? source.originalDocument?.sourceNumber || "" : key === "originalDate" ? source.originalDocument?.sourceDate || "" : key === "supplierNoteNumber" ? source.supplierDocument?.sourceNumber || "" : source.supplierDocument?.sourceDate || "";
  const noteCandidates = (row, registrationId, partyId) => {
    const lookup = noteLookups.get(row.recordId);
    return [...new Map([...(lookup?.rows || []), ...(lookup?.selectedInvoice ? [lookup.selectedInvoice] : [])].map(invoice => [invoice.id, invoice])).values()].filter(invoice => invoice.direction === row.source.direction && (!registrationId || invoice.registrationId === registrationId) && (!partyId || invoice.partyId === partyId));
  };
  const originalLabel = invoice => `${originalNumber(invoice)} dated ${dateLabel(originalDate(invoice))}, ${invoice.party?.name || ""}, ₹${formatINR(invoice.totals.totalPaise)}`;
  const noteEffect = row => {
    const credit = row.source.type === "Credit Note";
    return isPurchase(row)
      ? `${credit ? "Reduces" : "Increases"} the supplier balance and purchase taxable value/tax. ${credit ? "Purchase input-tax reduction follows the linked original credit review." : "Additional input credit stays pending review."}`
      : `${credit ? "Reduces" : "Increases"} the customer balance and outward taxable value/tax.`;
  };
  const noteHtml = (row, active = false) => {
    const source = row.source, review = row.mapping?.noteReview || {}, purchase = isPurchase(row), original = noteOriginal(review.originalInvoiceId);
    const physical = source.noteInventory && source.items.some(item => Number(item.actualQuantity) > 0);
    const identity = `<section data-tally-note-identity><h3>${esc(purchase ? "Supplier GST " : "Outward GST ")}${esc(source.type)}</h3><p>${purchase ? `Your Tally ${esc(source.sourceVoucherType || row.type)} records this supplier-issued GST ${esc(source.type)}.` : `The original Tally ${esc(source.sourceVoucherType || row.type)} remains the accounting entry.`}</p><dl class="tally-fields"><dt>Internal accounting voucher</dt><dd><span class="code">${esc(row.number)}</span> dated ${esc(dateLabel(row.date))}</dd><dt>Source original invoice reference</dt><dd><span class="code">${esc(source.originalDocument?.sourceNumber || "Not supplied")}</span> dated ${esc(dateLabel(source.originalDocument?.sourceDate))}</dd>${purchase ? `<dt>Source supplier ${esc(source.type.toLowerCase())}</dt><dd><span class="code">${esc(originalNoteValue(source, "supplierNoteNumber") || "Not supplied")}</span> dated ${esc(dateLabel(originalNoteValue(source, "supplierNoteDate")))}</dd>` : ""}</dl><p data-tally-note-effect>${esc(noteEffect(row))}</p><p data-tally-note-impact>${source.type === "Credit Note" ? "Decrease" : "Increase"}: ${!source.noteInventory && (source.taxablePaise === null || source.taxablePaise === undefined) ? `source accounting total ₹${money(source.totalPaise)}` : `${source.taxablePaise === null || source.taxablePaise === undefined ? "source item value" : "taxable value"} ₹${money(source.taxablePaise ?? source.itemValuePaise)}`}, tax ₹${money(source.taxPaise)}.</p></section>`;
    if (active) return identity + `<p data-tally-note-linked>Linked original invoice: <a href="${book}/gst-document/${encodeURIComponent(review.originalInvoiceId)}">${esc(original ? originalLabel(original) : `${review.originalNumber} dated ${dateLabel(review.originalDate)}`)}</a>. Stock: ${review.stockEffect === "quantity" ? "reviewed physical movement" : "financial adjustment only"}.</p>`;
    return `${identity}<h3>Original invoice and note review</h3><div class="tally-gst-search"><label>Find original invoice<input name="noteOriginalSearch" type="search" maxlength="160" value="${esc(noteLookups.get(row.recordId)?.q ?? [source.originalDocument?.sourceNumber, source.originalDocument?.sourceDate].filter(Boolean).join(" "))}"></label><button type="button" class="ghost" data-search-note-originals>Search original invoices</button></div><p data-note-original-status role="status">Open this note to load matching original invoices.</p><div class="actions"><button type="button" class="ghost" data-previous-note-originals disabled>Previous original invoices</button><button type="button" class="ghost" data-next-note-originals disabled>Next original invoices</button></div><div class="tally-gst-grid">${select("noteOriginalInvoiceId", "Verified original invoice", noteCandidates(row, row.mapping?.registrationId, row.mapping?.partyId), review.originalInvoiceId, originalLabel)}<label>Original invoice number<input name="noteOriginalNumber" required maxlength="16" value="${esc(review.originalNumber || source.originalDocument?.sourceNumber || "")}"></label><label>Original invoice date<input name="noteOriginalDate" type="date" required max="${esc(row.date)}" value="${esc(review.originalDate || source.originalDocument?.sourceDate || "")}"></label>${purchase ? `<label>Supplier ${esc(source.type.toLowerCase())} number<input name="supplierNoteNumber" required maxlength="16" value="${esc(review.supplierNoteNumber || source.sourceInvoiceNumber || "")}"></label><label>Supplier ${esc(source.type.toLowerCase())} date<input name="supplierNoteDate" type="date" required max="${esc(row.date)}" value="${esc(review.supplierNoteDate || source.sourceInvoiceDate || "")}"></label>` : ""}<label>Physical stock effect<select name="noteStockEffect" required><option value="">Choose explicitly</option><option value="none"${physical ? " disabled" : ""}${review.stockEffect === "none" ? " selected" : ""}>Financial adjustment only, no stock movement</option>${source.noteInventory ? `<option value="quantity"${review.stockEffect === "quantity" ? " selected" : ""}>Use reviewed source actual physical quantity</option>` : ""}</select></label></div><p>${physical ? "The source actual quantity requires a physical stock movement." : !source.noteInventory ? "This source has no physical item rows. Allocate its financial value to the original invoice." : "Review the source actual quantity before choosing the physical effect."}</p><p data-tally-note-original-context></p><div data-tally-note-allocations></div>${source.noteInventory ? "" : '<p><button type="button" class="ghost" data-add-note-allocation>Add financial allocation</button></p>'}${purchase ? `<label class="tally-gst-selection"><input type="checkbox" name="supplierDocumentConfirmed" value="confirmed" required${review.supplierDocumentConfirmed ? " checked" : ""}>I reviewed the supplier-issued GST ${esc(source.type.toLowerCase())} and its document number/date.</label>` : ""}<label class="tally-gst-selection"><input type="checkbox" name="noteReviewed" value="reviewed" required${row.mapping?.noteReview ? " checked" : ""}>I reviewed the linked original invoice, note amounts, relief direction and physical stock effect against the supporting evidence.</label>`;
  };
  const renderNoteAllocations = (form, row, saved) => {
    if (!isNote(row)) return;
    const original = noteOriginal(form.elements.noteOriginalInvoiceId.value), source = row.source;
    const prior = saved || [...form.querySelectorAll("[data-note-allocation]")].map(node => Object.fromEntries([...node.querySelectorAll("input,select")].map(input => [input.dataset.noteField, input.value])));
    const lines = prior.length ? prior : source.noteInventory ? source.items.map(() => ({})) : [{}];
    form.querySelector("[data-tally-note-allocations]").innerHTML = `<h3>${source.noteInventory ? "Source lines linked to original invoice lines" : "Financial allocation at original invoice HSN and rate"}</h3>` + lines.map((line, index) => `<div class="tally-gst-item" data-note-allocation="${index}">${source.noteInventory ? `<p><strong>${esc(source.items[index].sourceName)}</strong>: actual ${esc(source.items[index].actualQuantity ?? "unresolved")} ${esc(source.items[index].unit)}, billed ${esc(source.items[index].quantity)}, ₹${money(source.items[index].valuePaise)}</p>` : ""}<div class="tally-gst-grid"><label>Original invoice line<select name="noteLine-${index}" data-note-field="originalLineIndex" required>${!original?.items && line.originalLineIndex !== undefined && line.originalLineIndex !== "" ? `<option value="${esc(line.originalLineIndex)}" selected>Original line ${Number(line.originalLineIndex) + 1} (loading saved details)</option>` : ""}${options((original?.items || []).map((item, itemIndex) => ({ ...item, id: String(itemIndex) })), String(line.originalLineIndex ?? ""), item => `${Number(item.id) + 1}. ${item.name}, HSN ${item.hsnSac}, ${item.gstRateBps / 100}%, original ${item.quantity} ${item.unit}`)}</select></label>${source.noteInventory ? "" : `<label>Allocation quantity<input name="noteQuantity-${index}" data-note-field="quantity" required inputmode="decimal" value="${esc(line.quantity || "")}"></label><label>Allocation unit value ₹<input name="notePrice-${index}" data-note-field="unitPrice" required inputmode="decimal" value="${esc(line.unitPrice ?? (line.unitPricePaise === undefined ? "" : formatINR(line.unitPricePaise)))}"></label><label>Allocation discount %<input name="noteDiscount-${index}" data-note-field="discount" type="number" min="0" max="100" step="0.01" required value="${esc(line.discount ?? (line.discountBps || 0) / 100)}"></label>`}</div>${!source.noteInventory && lines.length > 1 ? '<button type="button" class="ghost" data-remove-note-allocation>Remove allocation</button>' : ""}</div>`).join("");
    form.querySelector("[data-tally-note-original-context]").textContent = original ? `Selected original: ${originalLabel(original)}. Note amounts use its saved HSN, tax rate and place of supply.` : "Choose the verified original invoice before allocating the note.";
    for (const button of form.querySelectorAll("[data-remove-note-allocation]")) button.addEventListener("click", () => {
      button.closest("[data-note-allocation]").remove();
      renderNoteAllocations(form, row);
      form.elements.noteStockEffect.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const updateNoteButtons = () => {
    for (const form of section.querySelectorAll("[data-tally-gst-mapping]")) {
      if (!form.elements.noteOriginalInvoiceId) continue;
      const lookup = noteLookups.get(form.closest("[data-tally-gst-record]").dataset.tallyGstRecord);
      const pending = form.dataset.originalLoading === "true", page = lookup?.page;
      form.querySelector("[data-search-note-originals]").disabled = busy || pending;
      form.querySelector("[data-previous-note-originals]").disabled = busy || pending || !page || page.offset === 0;
      form.querySelector("[data-next-note-originals]").disabled = busy || pending || !page || page.offset + page.limit >= page.total;
      form.querySelector('button[type="submit"]').disabled = busy || pending;
    }
  };
  const preserveNoteChoice = (form, id, label) => {
    const input = form.elements.noteOriginalInvoiceId;
    if (id && ![...input.options].some(option => option.value === id)) input.insertAdjacentHTML("beforeend", `<option value="${esc(id)}">${esc(label || "Selected original invoice")}</option>`);
    input.value = id || "";
  };
  const loadNoteOriginals = async (form, row, requestedOffset = 0) => {
    const selected = form.elements.noteOriginalInvoiceId.value;
    const request = Number(form.dataset.originalRequest || 0) + 1;
    form.dataset.originalRequest = String(request);
    form.dataset.originalLoading = "true";
    const status = form.querySelector("[data-note-original-status]");
    status.textContent = "Loading matching original invoices…";
    updateNoteButtons();
    const q = form.elements.noteOriginalSearch.value.trim();
    const query = new URLSearchParams({ direction: row.source.direction, partyLedgerId: row.source.partyLedgerId, q, offset: String(requestedOffset) });
    for (const name of ["registrationId", "partyId"]) if (form.elements[name].value) query.set(name, form.elements[name].value);
    if (selected) query.set("selected", selected);
    try {
      const result = await api(`${base}/gst/originals?${query}`);
      if (!current() || !form.isConnected || Number(form.dataset.originalRequest) !== request) return false;
      noteLookups.set(row.recordId, { ...result, q });
      if (result.selectedInvoice) noteOriginals.set(result.selectedInvoice.id, result.selectedInvoice);
      const inUse = new Set([...section.querySelectorAll('[name="noteOriginalInvoiceId"]')].map(input => input.value));
      for (const id of noteOriginals.keys()) if (noteOriginals.size > 40 && !inUse.has(id)) noteOriginals.delete(id);
      form.elements.noteOriginalInvoiceId.innerHTML = options(noteCandidates(row, form.elements.registrationId.value, form.elements.partyId.value), result.selectedInvoice?.id || "", originalLabel);
      const page = result.page;
      status.textContent = page.total ? `${page.offset + 1}–${Math.min(page.offset + page.limit, page.total)} of ${page.total} matching original invoices` : "No matching original invoices. Clear the search to browse this party's invoices.";
      if (result.selectedInvoice && !result.rows.some(invoice => invoice.id === result.selectedInvoice.id)) status.textContent += " Selected original retained.";
      renderNoteAllocations(form, row);
      renderCorrections(form, row);
      return true;
    } catch (error) {
      if (current() && form.isConnected && Number(form.dataset.originalRequest) === request) status.textContent = error.message;
      return false;
    } finally {
      if (current() && form.isConnected && Number(form.dataset.originalRequest) === request) { form.dataset.originalLoading = "false"; updateNoteButtons(); }
    }
  };
  const updateNoteContext = async (form, row, event) => {
    if (!isNote(row)) return;
    const input = form.elements.noteOriginalInvoiceId;
    if (["registrationId", "partyId"].includes(event?.target.name)) {
      if (!await loadNoteOriginals(form, row)) return;
      if (!input.value) renderNoteAllocations(form, row, []);
    }
    if (event?.target.name === "noteOriginalInvoiceId") {
      renderNoteAllocations(form, row, []);
      for (const input of form.querySelectorAll('[name^="item-"]')) input.value = "";
      if (!await loadNoteOriginals(form, row, noteLookups.get(row.recordId)?.page.offset || 0)) return;
      const original = noteOriginal(input.value);
      if (original) {
        form.elements.registrationId.value = original.registrationId;
        form.elements.partyId.value = original.partyId;
        form.elements.noteOriginalNumber.value = originalNumber(original);
        form.elements.noteOriginalDate.value = originalDate(original);
      }
      renderNoteAllocations(form, row, []);
    }
    const original = noteOriginal(input.value);
    if (event?.target.name.startsWith("noteLine-") && row.source.noteInventory) {
      const index = Number(event.target.closest("[data-note-allocation]").dataset.noteAllocation);
      const sourceNames = [...new Set((isNote(row) && !row.source.noteInventory ? [] : goodsRows(row.source)).map(item => item.sourceName))];
      const mapping = form.elements[`item-${sourceNames.indexOf(row.source.items[index].sourceName)}`];
      if (mapping) mapping.value = original?.items[Number(event.target.value)]?.itemId || "";
    }
  };
  const notePayload = (form, row, data) => ({
    direction: row.source.direction,
    originalInvoiceId: data.get("noteOriginalInvoiceId"),
    originalNumber: data.get("noteOriginalNumber"),
    originalDate: data.get("noteOriginalDate"),
    stockEffect: data.get("noteStockEffect"),
    ...(isPurchase(row) ? { supplierDocumentConfirmed: form.elements.supplierDocumentConfirmed.checked, supplierNoteNumber: data.get("supplierNoteNumber"), supplierNoteDate: data.get("supplierNoteDate") } : {}),
    lines: [...form.querySelectorAll("[data-note-allocation]")].map((node, index) => ({
      ...(row.source.noteInventory ? { sourceLineIndex: index } : {}),
      originalLineIndex: Number(node.querySelector('[data-note-field="originalLineIndex"]').value),
      ...(!row.source.noteInventory ? { quantity: node.querySelector('[data-note-field="quantity"]').value, unitPricePaise: parseRupees(node.querySelector('[data-note-field="unitPrice"]').value), discountBps: parseRupees(node.querySelector('[data-note-field="discount"]').value) } : {})
    }))
  });
  const field = (name, title, attributes = "") => `<label>${esc(title)}<input name="${esc(name)}" ${attributes}></label>`;
  const serviceFact = (source, service) => {
    const index = (source.items || []).findIndex(item => item.kind === "service" && item.sourceLineId === service.sourceLineId);
    return index >= 0 ? source.taxFacts?.items?.[index] : source.taxFacts?.items?.find(item => item.sourceLineId === service.sourceLineId);
  };
  const serviceHtml = (row, active = false) => {
    const services = serviceRows(row.source);
    if (!services.length || isNote(row)) return "";
    return `<section class="subsection" data-tally-service-mappings><h3>Services from the original ledgers</h3><p>Link each service amount to its GST service master. Services use SAC and have no physical stock movement.</p>${services.map(service => {
      const mapping = row.mapping?.serviceItems?.find(item => item.sourceLineId === service.sourceLineId) || {};
      const item = state.items.find(item => item.id === mapping.itemId), facts = serviceFact(row.source, service);
      const classification = service.classificationRequired || service.serviceClassification === "reviewed" || mapping.classificationConfirmed;
      const completion = mapping.completionReview || {}, confirmed = completion.status === "confirmed", id = esc(service.sourceLineId);
      const ledger = service.sourceLedgerName || service.sourceName;
      const identity = `<h4>${esc(ledger)}</h4><dl class="kv"><dt>Original ledger</dt><dd>${esc(ledger)}</dd><dt>Source amount</dt><dd>₹${money(service.valuePaise)}</dd><dt>Stock</dt><dd>No physical stock movement</dd></dl>`;
      const sourceFacts = `<details class="tally-service-facts"><summary>Dated SAC and rate evidence</summary>${factHtml("SAC", facts?.hsnSac, { code: true })}${factHtml("GST rate", facts?.gstRateBps, { rate: true })}</details>`;
      if (active) return `<div class="tally-gst-service" data-service-line="${id}">${identity}<dl class="kv"><dt>GST service master</dt><dd>${esc(item?.name || "Saved service")}${item?.hsnSac ? `, SAC <span class="code">${esc(item.hsnSac)}</span>` : ""}</dd>${isPurchase(row) ? `<dt>Completion at source review</dt><dd>${confirmed ? `<span class="pill ok">Confirmed</span> Completed ${esc(dateLabel(completion.date))}. Reference <span class="code">${esc(completion.reference)}</span>.` : '<span class="pill warn">Pending</span> Completion is pending confirmation. Later receipt evidence is kept in Purchase ITC review.'}</dd>` : ""}</dl>${sourceFacts}</div>`;
      return `<div class="tally-gst-service" data-service-line="${id}">${identity}${classification ? `<label class="check"><input type="checkbox" name="serviceConfirmed:${id}" value="confirmed" required${mapping.classificationConfirmed ? " checked" : ""}><span>The supporting evidence identifies this ledger amount as a service.</span></label>` : ""}<div class="form-grid">${select(`serviceItem:${service.sourceLineId}`, "GST service master (SAC)", state.items.filter(item => item.kind === "service"), mapping.itemId, item => `${item.name}, SAC ${item.hsnSac}, current rate ${item.gstRateBps / 100}%`)}</div><p><button type="button" class="ghost" data-tally-gst-prepare="service" data-source-line-id="${id}">Prepare service master from source facts</button></p>${sourceFacts}${isPurchase(row) ? `<div class="tally-service-completion"><h4>Was this service completed?</h4><div class="form-grid"><label>Service completion review<select name="serviceStatus:${id}" required><option value="">Choose explicitly</option><option value="confirmed"${confirmed ? " selected" : ""}>Completed, supporting evidence reviewed</option><option value="pending"${completion.status === "pending" ? " selected" : ""}>Pending, completion not confirmed</option></select></label><label data-service-completion-date${confirmed ? "" : " hidden"}>Service completion date<input type="date" name="serviceDate:${id}" value="${esc(completion.date || "")}"${confirmed ? " required" : " disabled"}></label><label class="wide">Completion evidence reference<input name="serviceReference:${id}" maxlength="500" value="${esc(completion.reference || "")}"${confirmed ? " required" : ""}></label></div><p class="form-note" data-service-completion-context>${confirmed ? "The completion date comes from the reviewed evidence." : "A pending service has no assumed completion date. Input credit remains subject to its later review."}</p></div>` : ""}</div>`;
    }).join("")}</section>`;
  };
  const updateServiceCompletion = form => {
    for (const node of form.querySelectorAll("[data-service-line]")) {
      const status = form.elements[`serviceStatus:${node.dataset.serviceLine}`];
      if (!status) continue;
      const confirmed = status.value === "confirmed", date = form.elements[`serviceDate:${node.dataset.serviceLine}`];
      date.disabled = !confirmed; date.required = confirmed;
      date.closest("[data-service-completion-date]").hidden = !confirmed;
      if (!confirmed) date.value = "";
      form.elements[`serviceReference:${node.dataset.serviceLine}`].required = confirmed;
      node.querySelector("[data-service-completion-context]").textContent = confirmed ? "The completion date comes from the reviewed evidence." : "A pending service has no assumed completion date. Input credit remains subject to its later review.";
    }
  };
  const servicePayload = (form, row, data) => serviceRows(row.source).map(service => {
    const id = service.sourceLineId, status = data.get(`serviceStatus:${id}`);
    return { sourceLineId: id, itemId: data.get(`serviceItem:${id}`),
      ...(form.elements[`serviceConfirmed:${id}`] ? { classificationConfirmed: form.elements[`serviceConfirmed:${id}`].checked } : {}),
      ...(isPurchase(row) ? { completionReview: { status, ...(status === "confirmed" ? { date: data.get(`serviceDate:${id}`) } : {}), ...(data.get(`serviceReference:${id}`) ? { reference: data.get(`serviceReference:${id}`) } : {}) } } : {}) };
  });
  const enrich = () => {
    const target = section.querySelector("[data-tally-gst-enrichment]");
    const existing = [...target.querySelectorAll("form")].map(form => ({ kind: form.dataset.tallyGstMaster, values: Object.fromEntries(new FormData(form)) }));
    const stateSelect = state.states?.length ? select("stateCode", "State or territory", state.states.map(row => ({ ...row, id: row.code })), "", row => `${row.code} ${row.name}`) : `<label>State code<input name="stateCode" required inputmode="numeric" pattern="[0-9]{2}" maxlength="2" placeholder="For example, 27"></label>`;
    target.innerHTML = `<details class="tally-gst-enrichment"><summary>Add GST masters for source records</summary><p>Use the source ledger and stock item below to keep the imported links. Review the GST facts supplied with each invoice. Use matching source values deliberately, and supply missing details or corrections from supporting evidence.</p><details><summary>Add business registration</summary><form data-tally-gst-master="settings" class="form-grid">${field("name", "Registration name", 'required maxlength="80"')}${field("legalName", "Legal business name", 'required maxlength="120"')}${field("gstin", "Business GSTIN", 'required minlength="15" maxlength="15" class="code" autocapitalize="characters" spellcheck="false"')}${stateSelect}<label class="wide">Business address<textarea name="address" required maxlength="600"></textarea></label>${field("pincode", "PIN code", 'pattern="[0-9]{6}" maxlength="6" inputmode="numeric"')}<div class="wide actions"><button type="submit">Save business registration</button></div><p data-tally-gst-master-message class="wide form-message" role="status"></p></form></details><details><summary>Add customer linked to source ledger</summary><form data-tally-gst-master="parties" class="form-grid">${select("customerLedgerId", "Original customer ledger", state.ledgers || [], "")}${field("name", "Customer name", 'required maxlength="120"')}${field("gstin", "Customer GSTIN (leave empty if unregistered)", 'maxlength="15" class="code" autocapitalize="characters" spellcheck="false"')}${stateSelect}<label class="wide">Customer address<textarea name="address" required maxlength="600"></textarea></label>${field("pincode", "PIN code", 'pattern="[0-9]{6}" maxlength="6" inputmode="numeric"')}<div class="wide actions"><button type="submit">Save source customer</button></div><p data-tally-gst-master-message class="wide form-message" role="status"></p></form></details><details><summary>Add supplier linked to source ledger</summary><form data-tally-gst-master="suppliers" class="form-grid">${select("supplierLedgerId", "Original supplier ledger", state.ledgers || [], "")}${field("name", "Supplier name", 'required maxlength="120"')}${field("gstin", "Supplier GSTIN (leave empty if unregistered)", 'maxlength="15" class="code" autocapitalize="characters" spellcheck="false"')}${stateSelect}<label class="wide">Supplier address<textarea name="address" required maxlength="600"></textarea></label>${field("pincode", "PIN code", 'pattern="[0-9]{6}" maxlength="6" inputmode="numeric"')}<div class="wide actions"><button type="submit">Save source supplier</button></div><p data-tally-gst-master-message class="wide form-message" role="status"></p></form></details><details><summary>Add HSN to source stock item</summary><form data-tally-gst-master="items" class="form-grid">${select("stockItemId", "Original stock item", state.sourceStockItems || [], "", item => `${item.name} (${item.unit})`)}${field("hsnSac", "HSN code", 'required inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" class="code"')}${field("unit", "Unit or UQC", 'required maxlength="12"')}${field("gstRate", "GST rate (%)", 'required type="number" min="0" max="100" step="0.01"')}${field("cessRate", "Cess rate (%)", 'required type="number" min="0" max="1000" step="0.01" value="0"')}<div class="wide actions"><button type="submit">Save source item HSN</button></div><p data-tally-gst-master-message class="wide form-message" role="status"></p></form></details><details><summary>Add a GST service master</summary><p>Prepare this from a service ledger below, then select the saved master on that invoice.</p><p class="form-note" data-tally-service-ledger></p><form data-tally-gst-master="services" class="form-grid">${field("name", "Service name", 'required maxlength="120"')}${field("hsnSac", "SAC (six digits beginning with 99)", 'required inputmode="numeric" pattern="99[0-9]{4}" minlength="6" maxlength="6" class="code"')}${field("unit", "Service unit", 'readonly value="OTH"')}${field("gstRate", "Current master GST rate (%)", 'required type="number" min="0" max="100" step="0.01"')}${field("cessRate", "Cess rate (%)", 'required type="number" min="0" max="1000" step="0.01" value="0"')}<div class="wide actions"><button type="submit">Save service master</button></div><p data-tally-gst-master-message class="wide form-message" role="status"></p></form></details></details>`;
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
        if (kind === "items" || kind === "services") {
          const item = state.sourceStockItems.find(entry => entry.id === body.stockItemId);
          Object.assign(body, kind === "services" ? { kind: "service", unit: "OTH", openingQuantity: "0" } : { name: item.name, kind: "goods", openingQuantity: item.openingQuantity });
          Object.assign(body, { pricePaise: 0, purchasePricePaise: 0, supplyStatus: "taxable", gstRateBps: Math.round(Number(body.gstRate) * 100), cessRateBps: Math.round(Number(body.cessRate) * 100) });
          delete body.gstRate; delete body.cessRate;
        }
        busy = true;
        for (const button of section.querySelectorAll("button")) button.disabled = true;
        masterMessage(form, "");
        try {
          await api(`${mastersBase}/${kind === "suppliers" ? "parties" : kind === "services" ? "items" : kind}`, { method: kind === "settings" ? "PUT" : "POST", body });
          if (!current()) return;
          form.reset();
          await show();
          /* show() rebuilt the master forms; reopen the one just saved and confirm it there. */
          const saved = section.querySelector(`[data-tally-gst-master="${kind}"]`);
          for (let detail = saved?.closest("details"); detail && section.contains(detail); detail = detail.parentElement.closest("details")) detail.open = true;
          if (saved) masterMessage(saved, "Source master saved. Select it explicitly on each invoice mapping.", "status");
        } catch (error) { if (current()) masterMessage(form, error.message, "alert"); }
        finally { busy = false; if (current()) { for (const button of section.querySelectorAll("button")) button.disabled = false; updateActivation(); updatePage(); } }
      });
    }
  };
  const factValue = value => value === null || value === undefined ? "Not supplied" : typeof value === "object" ? JSON.stringify(value) : String(value);
  const reasonText = { "future-effective": "Not effective on invoice date", "earlier-effective": "Earlier effective value", "invoice-override": "Replaced by invoice override" };
  const evidenceHtml = evidence => (evidence || []).map(entry => `<li>${entry.recordId ? `<a href="${book}/tally-source/${encodeURIComponent(entry.recordId)}">${esc(entry.file || "Source record")}</a>` : esc(entry.file || "Source")}${entry.fieldPath ? `, field <span class="code">${esc(entry.fieldPath)}</span>` : ""}. ${entry.effectiveFrom ? `Effective ${esc(dateLabel(entry.effectiveFrom))}. ` : ""}Value ${esc(factValue(entry.sourceValue))}.${entry.reason ? ` ${esc(reasonText[entry.reason] || entry.reason)}.` : ""}</li>`).join("");
  const factHtml = (label, fact, { rate = false, code = false } = {}) => {
    if (!fact) return "";
    const status = { absent: "Not supplied for this date", supplied: "Supplied", conflict: "Needs source review" }[fact.status] || fact.status;
    const tone = { absent: "warn", supplied: "ok", conflict: "bad" }[fact.status] || "";
    const value = fact.value === null || fact.value === undefined ? "" : rate && typeof fact.value === "number" ? `${fact.value / 100}%` : factValue(fact.value);
    return `<div class="tally-gst-fact" data-fact-status="${esc(fact.status)}"><p><strong>${esc(label)}</strong> <span class="pill ${tone}">${esc(status)}</span>${value ? ` <span${code ? ' class="code"' : ""}>${esc(value)}</span>` : ""}</p>${fact.evidence?.length ? `<ul>${evidenceHtml(fact.evidence)}</ul>` : ""}${fact.issues?.length ? `<ul class="attention-rule">${fact.issues.map(issue => `<li>${esc(issue.message || issue)}</li>`).join("")}</ul>` : ""}${fact.superseded?.length ? `<details><summary>Other dated source facts (${fact.superseded.length})</summary><ul>${evidenceHtml(fact.superseded)}</ul></details>` : ""}</div>`;
  };
  const factsHtml = row => {
    const facts = row.source?.taxFacts;
    if (!facts) return "";
    const suggestions = row.suggestions || {};
    const prepare = (kind, label, sourceName = "") => row.status === "active" ? "" : `<button type="button" class="ghost" data-tally-gst-prepare="${kind}" data-source-name="${esc(sourceName)}">${esc(label)}</button>`;
    const purchase = isPurchase(row);
    const identities = purchase
      ? `${factHtml("Supplier GSTIN (seller)", facts.sellerGstin, { code: true })}${suggestions.party ? prepare("party", "Prepare supplier master from supplied GSTIN") : ""}${factHtml("Your business GSTIN (buyer)", facts.buyerGstin, { code: true })}${suggestions.registration ? prepare("seller", "Prepare buyer business registration from supplied GSTIN") : ""}`
      : `${factHtml("Seller GSTIN", facts.sellerGstin, { code: true })}${suggestions.registration ? prepare("seller", "Prepare seller master from supplied GSTIN") : ""}${factHtml("Customer GSTIN", facts.buyerGstin, { code: true })}${suggestions.party ? prepare("party", "Prepare customer master from supplied GSTIN") : ""}`;
    return `<details class="tally-gst-facts"><summary>GST facts supplied with the source</summary>${identities}${(facts.items || []).map(item => {
      const suggestion = suggestions.items?.find(entry => entry.sourceName === item.sourceName);
      return `<h4>${esc(item.sourceName)}</h4>${factHtml("HSN or SAC", item.hsnSac, { code: true })}${factHtml("GST rate", item.gstRateBps, { rate: true })}${factHtml("Supply type", item.supplyType)}${factHtml("Taxability", item.taxability)}${suggestion?.stockItemId && suggestion.kind !== "service" && (!suggestion.supplyStatus || suggestion.supplyStatus === "taxable") ? prepare("item", "Prepare item master from supplied facts", item.sourceName) : ""}`;
    }).join("")}${row.status === "active" ? "" : '<p><button type="button" class="ghost" data-tally-gst-match-source>Select saved masters that match the source</button></p>'}</details>`;
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
    if (isPurchase(row) && !isNote(row)) {
      const source = row.source;
      for (const [key, label, sourceKey] of [["supplierInvoiceNumber", "Supplier invoice number", "sourceInvoiceNumber"], ["supplierInvoiceDate", "Supplier invoice date", "sourceInvoiceDate"], ["placeOfSupply", "Place of supply", "placeOfSupply"]]) {
        const value = originalPurchaseValue(source, key);
        checks.push([key, label, { status: value ? "supplied" : "absent", value }, form.elements[key]?.value || undefined]);
      }
    }
    if (isNote(row)) {
      for (const [key, label, input] of [["originalNumber", "Original invoice number", "noteOriginalNumber"], ["originalDate", "Original invoice date", "noteOriginalDate"], ...(isPurchase(row) ? [["supplierNoteNumber", "Supplier note number", "supplierNoteNumber"], ["supplierNoteDate", "Supplier note date", "supplierNoteDate"]] : [])]) {
        const value = originalNoteValue(row.source, key);
        checks.push([key, label, { status: value ? "supplied" : "absent", value }, form.elements[input]?.value || undefined]);
      }
    }
    [...new Set((isNote(row) && !row.source.noteInventory ? [] : goodsRows(row.source)).map(item => item.sourceName))].forEach((sourceName, index) => {
      const original = isNote(row) ? noteOriginal(form.elements.noteOriginalInvoiceId?.value) : null;
      const sourceIndex = row.source.items.findIndex(item => item.sourceName === sourceName);
      const originalIndex = form.elements[`noteLine-${sourceIndex}`]?.value;
      const item = isNote(row) ? original?.items[originalIndex] : state.items.find(entry => entry.id === form.elements[`item-${index}`].value);
      const source = facts.items?.find(entry => entry.sourceName === sourceName);
      if (source) checks.push([`item:${sourceName}:hsnSac`, `${sourceName} HSN or SAC`, source.hsnSac, item?.hsnSac], [`item:${sourceName}:gstRateBps`, `${sourceName} GST rate`, source.gstRateBps, item?.gstRateBps], [`item:${sourceName}:supplyType`, `${sourceName} supply type`, source.supplyType, item?.kind], [`item:${sourceName}:taxability`, `${sourceName} taxability`, source.taxability, item?.supplyStatus]);
    });
    if (!isNote(row)) for (const service of serviceRows(row.source)) {
      const item = state.items.find(item => item.id === form.elements[`serviceItem:${service.sourceLineId}`]?.value);
      const facts = serviceFact(row.source, service), prefix = `service:${service.sourceLineId}:`;
      if (facts) checks.push([prefix + "hsnSac", `${service.sourceName} SAC`, facts.hsnSac, item?.hsnSac], [prefix + "gstRateBps", `${service.sourceName} GST rate`, facts.gstRateBps, item?.gstRateBps], [prefix + "supplyType", `${service.sourceName} supply type`, facts.supplyType, item?.kind], [prefix + "taxability", `${service.sourceName} taxability`, facts.taxability, item?.supplyStatus]);
    }
    const differs = (fact, selected) => String(fact.value).trim().toUpperCase() !== String(selected).trim().toUpperCase();
    const datedItem = key => (key.startsWith("item:") || key.startsWith("service:")) && (key.endsWith(":hsnSac") || key.endsWith(":gstRateBps"));
    const historical = checks.filter(([key, , fact, selected]) => datedItem(key) && fact?.status === "supplied" && selected !== undefined && differs(fact, selected));
    for (const [key] of historical) form.sourceChoices[key] ||= row.mapping?.sourceCorrections?.[key] ? "master" : "source";
    const different = checks.filter(([key, , fact, selected]) => fact && selected !== undefined && (fact.status === "conflict" || fact.status === "supplied" && differs(fact, selected) && (!datedItem(key) || form.sourceChoices[key] === "master")));
    const display = (key, value) => key.endsWith(":gstRateBps") ? esc(`${Number(value) / 100}%`) : /Gstin$|:hsnSac$/.test(key) ? `<span class="code">${esc(value)}</span>` : esc(value);
    target.innerHTML = (historical.length ? `<h3>Dated source or current master</h3><p>The supplied source value applies to this invoice date. The current master stays unchanged.</p>${historical.map(([key, label, fact, selected]) => `<label><span>${esc(label)}: source ${display(key, fact.value)}, current master ${display(key, selected)}</span><select name="${esc("sourceChoice:" + key)}"><option value="source"${form.sourceChoices[key] === "source" ? " selected" : ""}>Use supplied source for this document</option><option value="master"${form.sourceChoices[key] === "master" ? " selected" : ""}>Use current master as an evidenced correction</option></select></label>`).join("")}` : "") + (different.length ? `<h3>Reasons for source corrections</h3><p>Record the reason and supporting evidence for each selected correction or unresolved source fact.</p>${different.map(([key, label]) => `<label>${esc(label)}: reason for the correction<input name="${esc("sourceCorrection:" + key)}" value="${esc(form.sourceReasons[key] || "")}" required maxlength="500"></label>`).join("")}` : "");
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
      } else if (button.dataset.tallyGstPrepare === "service") {
        const service = serviceRows(row.source).find(item => item.sourceLineId === button.dataset.sourceLineId);
        const facts = serviceFact(row.source, service);
        kind = "services"; values = { name: service.sourceLedgerName || service.sourceName, unit: "OTH", hsnSac: facts?.hsnSac?.status === "supplied" ? facts.hsnSac.value : "", gstRate: facts?.gstRateBps?.status === "supplied" ? String(facts.gstRateBps.value / 100) : "" };
        section.querySelector("[data-tally-service-ledger]").textContent = `Original ledger: ${service.sourceLedgerName || service.sourceName}`;
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
      masterMessage(form, "Supplied source values copied into this form. Review them, complete the remaining details and save explicitly.", "notice");
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
      [...new Set((isNote(row) && !row.source.noteInventory ? [] : goodsRows(row.source)).map(item => item.sourceName))].forEach((sourceName, index) => {
        const suggestion = suggestions.items?.find(entry => entry.sourceName === sourceName);
        if (!suggestion) return;
        const item = state.items.find(entry => (entry.stockItemId || entry.id) === suggestion.stockItemId);
        if (item) { form.elements[`item-${index}`].value = item.id; matched++; }
      });
      form.elements.registrationId.dispatchEvent(new Event("input", { bubbles: true }));
      rowMessage(form, matched ? `${matched} saved master${matched === 1 ? "" : "s"} matching source identities selected. Review dated source facts and every choice and save the invoice mapping.` : "No saved GST masters match the supplied facts. Prepare a master from the source facts or enter an evidenced correction.", "notice");
    });
  };
  const rowHtml = row => {
    const source = row.source || {}, mapping = row.mapping || {}, evidence = mapping.evidence || {};
    const purchase = isPurchase(row), note = isNote(row), type = row.type || source.type || (purchase ? "Purchase" : "Sales");
    const partyName = purchase ? "Supplier" : "Customer", tradeRole = purchase ? "purchase" : "sales";
    const items = note && !source.noteInventory ? [] : [...new Map(goodsRows(source).map(item => [item.sourceName, item])).values()];
    const services = serviceRows(source), serviceOnly = !note && !items.length && services.length > 0;
    const taxes = source.taxes || {};
    const roles = ["party", ...(serviceOnly ? [] : [tradeRole]), ...components.filter(key => taxes[`${key}Paise`] || taxes[key] || mapping.accounts?.[key])];
    const problems = [...(row.blockers || []), ...(row.discrepancies || [])];
    const active = row.status === "active";
    const statusLabel = { blocked: "Needs mapping", ready: "Ready", active: "Active" }[row.status] || row.status;
    const statusTone = { blocked: "warn", ready: "info", active: "ok" }[row.status] || "";
    const postingRows = (source.postings || []).map(line => `<tr><th scope="row">${esc(line.name)}</th>${line.dc === "Dr" ? `<td class="figure">${money(line.paise)}</td><td class="figure quiet">—</td>` : `<td class="figure quiet">—</td><td class="figure">${money(line.paise)}</td>`}</tr>`).join("") || '<tr><td colspan="3" class="quiet">The source voucher carries no accounting postings.</td></tr>';
    const reusable = state.rows.filter(entry => entry.recordId !== row.recordId && entry.mapping?.registrationId && isPurchase(entry) === purchase && isNote(entry) === note);
    const review = mapping.purchaseReview || {};
    const supplierNumber = review.supplierInvoiceNumber || source.sourceInvoiceNumber || "";
    const supplierDate = review.supplierInvoiceDate || source.sourceInvoiceDate || "";
    const receivedDate = review.receivedDate || "";
    const placeOfSupply = review.placeOfSupply || source.placeOfSupply || "";
    const partyWord = purchase ? "supplier" : "customer";
    const purchaseIdentity = purchase && !note ? `<dl class="kv" data-tally-purchase-identities><dt>Internal accounting voucher</dt><dd><span class="code">${esc(row.number || "Not supplied")}</span> dated ${esc(dateLabel(row.date))}</dd><dt>Original voucher</dt><dd><span class="code">${esc(source.sourceVoucherNumber || row.sourceNumber || "Not supplied")}</span> dated ${esc(dateLabel(source.sourceVoucherDate || row.date))}</dd><dt>Source supplier invoice</dt><dd><span class="code">${esc(originalPurchaseValue(source, "supplierInvoiceNumber") || "Not supplied")}</span> dated ${esc(dateLabel(originalPurchaseValue(source, "supplierInvoiceDate")))}</dd>${active ? `<dt>Reviewed supplier invoice</dt><dd><span class="code">${esc(supplierNumber || "Not supplied")}</span> dated ${esc(dateLabel(supplierDate))}</dd>${items.length ? `<dt>Goods received</dt><dd>${esc(dateLabel(receivedDate))}</dd>` : ""}` : ""}</dl>` : "";
    const purchaseReview = purchase && !note ? `<h3>Supplier document${serviceOnly ? "" : " and receipt"} review</h3><div class="form-grid"><label>Supplier invoice number<input name="supplierInvoiceNumber" required maxlength="16" class="code" value="${esc(supplierNumber)}"></label><label>Supplier invoice date<input name="supplierInvoiceDate" type="date" required value="${esc(supplierDate)}"></label>${serviceOnly ? "" : `<label>Goods received date<input name="receivedDate" type="date" required value="${esc(receivedDate)}"></label>`}${select("placeOfSupply", "Reviewed place of supply", (state.states || []).map(entry => ({ ...entry, id: entry.code })), placeOfSupply, entry => `${entry.code} ${entry.name}`)}</div><p class="form-note" data-tally-purchase-pos>Source place of supply: ${esc(source.placeOfSupply || "Not supplied")}. Review it against the selected business and supplier states.</p><p class="notice" data-tally-purchase-itc>ITC on activation starts as pending review. Use Purchase ITC review for a later credit decision.</p><label class="check"><input name="purchaseReviewed" type="checkbox" value="reviewed" required${mapping.purchaseReview ? " checked" : ""}><span>I reviewed the supplier document, ${serviceOnly ? "service completion choices" : "receipt date"}, place of supply and original postings. Credit starts pending review.</span></label>` : "";
    const itemMappings = note
      ? items.map((item, index) => `<input type="hidden" name="item-${index}" value="${esc((mapping.items || []).find(entry => entry.sourceName === item.sourceName)?.itemId || "")}">`).join("")
      : (items.length ? "<h3>Goods and HSN mappings</h3>" : "") + items.map((item, index) => `<div class="form-grid tally-gst-item"><p class="wide"><strong>${esc(item.sourceName)}</strong>: ${esc(item.quantity)} ${esc(item.unit)} billed${item.actualQuantity === null || item.actualQuantity === undefined ? ", actual quantity unresolved" : `, actual ${esc(item.actualQuantity)} ${esc(item.unit)}`}. Source item value ₹${money(item.valuePaise ?? item.taxablePaise)}.</p>${select(`item-${index}`, "GST goods item (current master HSN)", (state.items || []).filter(entry => entry.kind !== "service"), (mapping.items || []).find(entry => entry.sourceName === item.sourceName)?.itemId, entry => `${entry.name}, HSN ${entry.hsnSac}, ${entry.unit || "service"}`)}</div>`).join("");
    const form = `<form data-tally-gst-mapping>${reusable.length ? `<div class="toolbar tally-gst-copy"><label class="grow">Reuse business registration, evidence and matching item mappings<select data-copy-source><option value="">Choose a saved ${purchase ? "purchase" : "sales"} mapping</option>${reusable.map(entry => `<option value="${esc(entry.recordId)}">${esc(entry.number)}</option>`).join("")}</select></label><button type="button" class="ghost" data-copy-mapping>Copy into this draft</button></div>` : ""}<div class="form-grid">${select("registrationId", purchase ? "Your business registration (buyer)" : "Seller registration", state.registrations || [], mapping.registrationId, item => `${item.name || item.legalName} (${item.gstin})`)}${select("partyId", partyName, (state.parties || []).filter(item => !item.kind || item.kind === "both" || item.kind === (purchase ? "supplier" : "customer")), mapping.partyId, item => `${item.name} (${item.gstin || "unregistered"})`)}${serviceOnly ? '<input type="hidden" name="stockMode" value="financial-only"><p class="wide form-note">No goods lines. Services do not move physical stock.</p>' : `<label${note ? " hidden" : ""}>Stock treatment<select name="stockMode" required><option value="source"${mapping.stockMode !== "report-only" ? " selected" : ""}>Use reviewed original stock movement</option><option value="report-only"${mapping.stockMode === "report-only" ? " selected" : ""}>GST reporting only, actual quantity unresolved</option></select></label>`}</div>${note && row.source ? noteHtml(row) : purchaseReview}${itemMappings}${serviceHtml(row)}<h3>Original posting accounts</h3><p class="quiet">Choose the ledgers used by the imported accounting voucher.</p><div class="table-scroll"><table class="tally-gst-postings"><thead><tr><th>Source ledger</th><th class="figure">Debit (₹)</th><th class="figure">Credit (₹)</th></tr></thead><tbody>${postingRows}</tbody></table></div><div class="form-grid">${roles.map(role => select(`account-${role}`, role === "party" ? `${partyName} ledger` : role === tradeRole ? `${purchase ? "Purchase" : "Sales"} ledger` : `${role.toUpperCase()} ${purchase ? "input tax " : ""}ledger`, state.ledgers || [], mapping.accounts?.[role])).join("")}</div><div data-tally-gst-corrections></div><div class="form-grid"><label>Supporting evidence name<input name="evidenceName" required maxlength="120" value="${esc(evidence.name || "")}"></label><label>Supporting evidence reference<input name="evidenceReference" required maxlength="500" value="${esc(evidence.reference || "")}"></label></div><p class="actions"><button type="submit">Save ${note ? "note" : "invoice"} mapping</button>${row.status === "ready" ? `<label class="check"><input type="checkbox" data-tally-gst-select="${esc(row.recordId)}"><span>Select for GST activation</span></label>` : ""}</p><p data-tally-gst-row-message class="form-message" role="status"></p></form>`;
    const links = [`<a href="${book}/tally-source/${encodeURIComponent(row.recordId)}">Open original source record</a>`];
    if (row.voucherId) links.push(`<a href="${book}/v/${encodeURIComponent(type)}/${encodeURIComponent(row.voucherId)}">Open accounting voucher</a>`);
    if ((purchase || note || services.length) && active && row.voucherId) {
      links.push(`<a href="${book}/gst-document/${encodeURIComponent(row.voucherId)}">Open GST ${note ? "note" : purchase ? "purchase" : "invoice"}</a>`);
      if (purchase) links.push(`<a href="${book}/gst-itc/${encodeURIComponent(row.voucherId)}">Open purchase ITC review</a>`);
    }
    const activeText = active ? `<p class="status">GST ${note ? "note" : purchase ? "purchase" : "invoice"} activated from the retained source.</p>${purchase ? `<p class="form-note" data-tally-purchase-itc>${note ? "Use Purchase ITC review for the linked note adjustment. Activation does not claim new input credit." : "Imported with ITC pending review. Use Purchase ITC review for dated credit decisions."}</p>` : ""}` : "";
    return `<details class="tally-gst-invoice" data-tally-gst-record="${esc(row.recordId)}" data-tally-gst-type="${esc(type)}"><summary><span class="pill">${esc(type)}</span><strong class="code">${esc(row.number || "Unnumbered invoice")}</strong>${row.sourceNumber && row.sourceNumber !== row.number ? `<small>Source <span class="code">${esc(row.sourceNumber)}</span></small>` : ""}<span>${esc(dateLabel(row.date))}</span><span>${esc(source.partyName || `Source ${partyWord}`)}</span><span class="tally-gst-amount">₹${money(source.totalPaise)}</span><span class="pill ${statusTone}">${esc(statusLabel)}</span></summary>`
      + `<p class="tally-gst-links">${links.join("")}</p>`
      + purchaseIdentity
      + (note && active && row.source ? noteHtml(row, true) : "")
      + (active && row.source ? serviceHtml(row, true) : "")
      + `<dl class="kv"><dt>${purchase ? "Source supplier GSTIN" : "Source customer GSTIN"}</dt><dd>${source.gstin ? `<span class="code">${esc(source.gstin)}</span>` : "Not supplied"}</dd><dt>Place of supply</dt><dd>${esc(source.placeOfSupply || "Not supplied")}</dd></dl>`
      + factsHtml(row)
      + (problems.length ? `<ul class="attention-rule tally-gst-problems">${problems.map(problem => `<li>${esc(problem.message || problem)}</li>`).join("")}</ul>` : "")
      + (!row.source ? '<p>Resolve the source exception before mapping this invoice. Open the original source record to see what is missing.</p>' : active ? activeText : form)
      + `<details class="tally-gst-original"><summary>Source items, tax, transport and references</summary><pre>${esc(JSON.stringify(source, null, 2))}</pre></details></details>`;
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
      const visibleRecords = new Set((state.rows || []).map(row => row.recordId));
      for (const id of noteLookups.keys()) if (!visibleRecords.has(id)) noteLookups.delete(id);
      const summary = state.summary;
      enrich();
      section.querySelector("[data-tally-gst-summary]").textContent = `${summary.sourceInvoices} source invoices: ${summary.active} active, ${summary.ready} ready and ${summary.blocked} needing review. Source item value ₹${formatINR(summary.sourceItemValuePaise ?? summary.taxablePaise ?? 0)}, classified taxable value ₹${formatINR(summary.taxablePaise || 0)} and tax ₹${formatINR(summary.taxPaise || 0)}.`;
      section.querySelector("[data-tally-gst-rows]").innerHTML = (state.rows || []).map(rowHtml).join("") || `<p class="empty">${search ? "No source invoices match this search. Clear the search box and select Search source invoices to see every invoice." : "This Tally import carries no source sales invoices to review."}</p>`;
      for (const form of section.querySelectorAll("[data-tally-gst-mapping]")) {
        const formRow = state.rows.find(row => row.recordId === form.closest("[data-tally-gst-record]").dataset.tallyGstRecord);
        if (isNote(formRow)) {
          const review = formRow.mapping?.noteReview;
          preserveNoteChoice(form, review?.originalInvoiceId, review ? `${review.originalNumber} dated ${dateLabel(review.originalDate)}` : "");
          renderNoteAllocations(form, formRow, formRow.mapping?.noteReview?.lines || []);
          const note = form.closest("[data-tally-gst-record]");
          note.addEventListener("toggle", event => { if (event.target === note && note.open) loadNoteOriginals(form, formRow, noteLookups.get(formRow.recordId)?.page.offset || 0); });
          form.querySelector("[data-search-note-originals]").addEventListener("click", () => loadNoteOriginals(form, formRow));
          form.elements.noteOriginalSearch.addEventListener("keydown", event => {
            if (event.key === "Enter") { event.preventDefault(); if (!busy && form.dataset.originalLoading !== "true") loadNoteOriginals(form, formRow); }
          });
          form.querySelector("[data-previous-note-originals]").addEventListener("click", () => {
            const page = noteLookups.get(formRow.recordId)?.page;
            if (page) loadNoteOriginals(form, formRow, Math.max(0, page.offset - page.limit));
          });
          form.querySelector("[data-next-note-originals]").addEventListener("click", () => {
            const page = noteLookups.get(formRow.recordId)?.page;
            if (page) loadNoteOriginals(form, formRow, page.offset + page.limit);
          });
          form.querySelector("[data-add-note-allocation]")?.addEventListener("click", () => {
            const lines = [...form.querySelectorAll("[data-note-allocation]")].map(node => Object.fromEntries([...node.querySelectorAll("input,select")].map(input => [input.dataset.noteField, input.value])));
            lines.push({}); renderNoteAllocations(form, formRow, lines);
            form.elements.noteStockEffect.dispatchEvent(new Event("input", { bubbles: true }));
          });
        }
        form.addEventListener("input", async event => {
          if (event.target.matches("[data-tally-gst-select]")) return;
          await updateNoteContext(form, formRow, event);
          if (!current() || !form.isConnected) return;
          updateServiceCompletion(form);
          if (["registrationId", "partyId"].includes(event.target.name) || event.target.name.startsWith("item-") || event.target.name.startsWith("serviceItem:") || event.target.name.startsWith("sourceChoice:") || event.target.name.startsWith("supplierInvoice") || event.target.name === "placeOfSupply" || event.target.name.startsWith("note") || event.target.name.startsWith("supplierNote")) renderCorrections(form, state.rows.find(row => row.recordId === form.closest("[data-tally-gst-record]").dataset.tallyGstRecord));
          if (event.target.name.startsWith("sourceChoice:")) form.elements[event.target.name]?.focus();
          if (form.elements.purchaseReviewed && event.target.name !== "purchaseReviewed") form.elements.purchaseReviewed.checked = false;
          if (form.elements.noteReviewed && event.target.name !== "noteReviewed") form.elements.noteReviewed.checked = false;
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
          if (isNote(formRow)) {
            preserveNoteChoice(form, draft.noteOriginalInvoiceId, `${draft.noteOriginalNumber || "Selected original"} dated ${dateLabel(draft.noteOriginalDate)}`);
            const lines = Object.keys(draft).filter(key => /^noteLine-\d+$/.test(key)).sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1])).map(key => {
              const index = key.split("-")[1];
              return { originalLineIndex: draft[key], quantity: draft[`noteQuantity-${index}`], unitPrice: draft[`notePrice-${index}`], discount: draft[`noteDiscount-${index}`] };
            });
            renderNoteAllocations(form, formRow, lines);
          }
          for (const [name, value] of Object.entries(draft)) if (form.elements[name]) form.elements[name].value = value;
          for (const [name, value] of Object.entries(draft)) if (name.startsWith("sourceChoice:")) form.sourceChoices[name.slice("sourceChoice:".length)] = value;
          renderCorrections(form, state.rows.find(row => row.recordId === form.closest("[data-tally-gst-record]").dataset.tallyGstRecord));
          for (const [name, value] of Object.entries(draft)) if (form.elements[name]) form.elements[name].value = value;
          if (form.elements.purchaseReviewed) form.elements.purchaseReviewed.checked = draft.purchaseReviewed === "reviewed";
          if (form.elements.noteReviewed) form.elements.noteReviewed.checked = draft.noteReviewed === "reviewed";
          if (form.elements.supplierDocumentConfirmed) form.elements.supplierDocumentConfirmed.checked = draft.supplierDocumentConfirmed === "confirmed";
          const checkbox = form.querySelector("[data-tally-gst-select]");
          if (checkbox) checkbox.disabled = true;
        }
        updateServiceCompletion(form);
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
          [...new Set((isNote(row) && !row.source.noteInventory ? [] : goodsRows(row.source)).map(item => item.sourceName))].forEach((sourceName, index) => { form.elements[`item-${index}`].value = mapping.items?.find(item => item.sourceName === sourceName)?.itemId || ""; });
          form.elements.registrationId.dispatchEvent(new Event("input", { bubbles: true }));
          rowMessage(form, "Copied the business registration, evidence, shared posting accounts and matching items. Review the party and every copied choice, then save.", "notice");
        });
        form.addEventListener("submit", async event => {
          event.preventDefault();
          if (busy || form.dataset.originalLoading === "true" || !form.reportValidity()) return;
          const row = state.rows.find(entry => entry.recordId === form.closest("[data-tally-gst-record]").dataset.tallyGstRecord);
          const sourceItems = [...new Set((isNote(row) && !row.source.noteInventory ? [] : goodsRows(row.source)).map(item => item.sourceName))];
          const data = new FormData(form);
          form.dataset.requestId ||= crypto.randomUUID();
          busy = true;
          for (const control of section.querySelectorAll("button")) control.disabled = true;
          try {
            await api(`${base}/gst/mapping`, { method: "POST", body: { requestId: form.dataset.requestId, compact: true, revision: state.revision, recordId: row.recordId, stockMode: data.get("stockMode"), ...(isNote(row) ? { noteReview: notePayload(form, row, data) } : isPurchase(row) ? { purchaseReview: { supplierInvoiceNumber: data.get("supplierInvoiceNumber"), supplierInvoiceDate: data.get("supplierInvoiceDate"), ...(data.has("receivedDate") ? { receivedDate: data.get("receivedDate") } : {}), placeOfSupply: data.get("placeOfSupply"), itcEligibility: "pending" } } : {}), sourceCorrections: Object.fromEntries([...data.entries()].filter(([key]) => key.startsWith("sourceCorrection:")).map(([key, value]) => [key.slice("sourceCorrection:".length), value])), registrationId: data.get("registrationId"), partyId: data.get("partyId"), items: sourceItems.map((sourceName, index) => ({ sourceName, itemId: data.get(`item-${index}`) })), ...(serviceRows(row.source).length ? { serviceItems: servicePayload(form, row, data) } : {}), accounts: Object.fromEntries(["party", isPurchase(row) ? "purchase" : "sales", ...components].filter(role => data.has(`account-${role}`)).map(role => [role, data.get(`account-${role}`)])), evidence: { name: data.get("evidenceName"), reference: data.get("evidenceReference") } } });
            if (!current()) return;
            drafts.delete(row.recordId);
            await show();
            const saved = [...section.querySelectorAll("[data-tally-gst-record]")].find(node => node.dataset.tallyGstRecord === row.recordId);
            if (saved) { saved.open = true; saved.querySelector("[data-tally-gst-select]")?.focus(); }
            message("Invoice mapping saved. Review its status before selecting it for activation.");
          } catch (error) { if (current()) { rowMessage(form, error.message, "alert"); message(error.message, true, false); } }
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
