import { tallyInvoiceReferences } from "/tally-invoice-references.js";
import { formatINR, parseRupees, todayISO } from "/money.js";

const GST_ROUTES = new Set(["gst", "gst-invoice", "gst-register", "gst-document"]);
const TYPES = ["Sales", "Purchase", "Credit Note", "Debit Note"];
const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.split("-").reverse().join("-") : value || "—";
const decimal = (value = 0) => String(value / 100);
const rupees = (value = 0) => (value / 100).toFixed(2);

function rateBps(value) {
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(String(value))) throw new Error("Enter a percentage with up to two decimal places");
  const [whole, fraction = ""] = String(value).split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export async function viewGst(route, token, ui) {
  if (!GST_ROUTES.has(route.name)) return false;
  const { root, api, still, page, esc, readPeriod, periodBar, bindPeriod } = ui;
  if (!route.id) throw new Error("Open a company to use billing");
  const base = `/api/companies/${encodeURIComponent(route.id)}/gst`;
  const state = await api(base);
  if (!still(token)) return true;
  const { company, registrations = [], parties = [], items = [], invoices = [], states = [] } = state;
  const book = `#/c/${encodeURIComponent(company.id)}`;
  const money = value => esc(formatINR(value || 0));
  const flashKey = `financer-gst-flash:${company.id}`;
  const stateName = code => {
    const found = states.find(row => row.code === code);
    return found ? `${found.code} · ${found.name}` : code || "—";
  };
  const stateOptions = selected => '<option value="">Choose state / territory</option>' + states.map(row => `<option value="${esc(row.code)}"${row.code === selected ? " selected" : ""}>${esc(row.code)} · ${esc(row.name)}</option>`).join("");
  const render = (title, body, folio = "Gs") => {
    const flash = sessionStorage.getItem(flashKey) || "";
    sessionStorage.removeItem(flashKey);
    document.title = `${title} · ${company.name}`;
    root.innerHTML = page({ company, kicker: "Billing", title, folio, status: flash, body: `<div class="gst-workspace">${body}</div>` });
  };
  const field = (name, label, value = "", options = "") => `<label>${label}<input name="${name}" value="${esc(value)}" ${options}></label>`;
  const addressField = (name = "address", label = "Address", value = "") => `<label class="gst-wide">${label}<textarea name="${name}" rows="2">${esc(value)}</textarea></label>`;
  const formMessage = form => form.querySelector("[data-form-message]");
  const showError = (form, error) => {
    const target = formMessage(form);
    target.className = "alert";
    target.textContent = error.message;
    target.scrollIntoView({ block: "nearest" });
  };
  const bindMaster = (selector, endpoint, collect, message) => {
    const form = root.querySelector(selector);
    form?.addEventListener("submit", async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const buttons = [...root.querySelectorAll('form button[type="submit"]')];
      for (const button of buttons) button.disabled = true;
      try {
        await api(`${base}/${endpoint}`, { method: ["settings","turnover","irp-policy"].includes(endpoint) ? "PUT" : "POST", body: collect(new FormData(form)) });
        if (!still(token)) return;
        const drafts = [...root.querySelectorAll("form")].filter(other => other !== form).map(other => ({ id: other.getAttribute("id"), values: Object.fromEntries(new FormData(other)) }));
        sessionStorage.setItem(flashKey, message);
        await viewGst(route, token, ui);
        if (!still(token)) return;
        for (const draft of drafts) {
          const restored = root.querySelector(`#${draft.id}`);
          if (!restored) continue;
          for (const [name, value] of Object.entries(draft.values)) if (restored.elements[name]) restored.elements[name].value = value;
          restored.elements.kind?.dispatchEvent(new Event("change", { bubbles: true }));
          restored.elements.stateCode?.dispatchEvent(new Event("change"));
        }
        const chooser = root.querySelector("[data-registration-choice]");
        if (chooser) chooser.value = root.querySelector("#gst-registration").elements.id.value;
      } catch (error) {
        if (still(token)) showError(form, error);
      } finally { for (const button of buttons) button.disabled = false; }
    });
  };

  if (route.name === "gst") {
    const registration = registrations[0] || {};
    const date = todayISO();
    const currentFY = Number(date.slice(0,4)) - (Number(date.slice(5,7)) < 4 ? 1 : 0);
    const turnoverSection = registrations.length ? `<details class="gst-add"><summary>HSN reporting by financial year</summary>
        <form id="gst-turnover" class="gst-form">
        <label>Registration<select name="registrationId">${registrations.map(r => `<option value="${esc(r.id)}">${esc(r.gstin)} · ${esc(r.name)}</option>`).join("")}</select></label>
        ${field("year","Invoice financial year starts in",currentFY,'type="number" min="2017" max="2099" required')}
        <label>Preceding financial year’s aggregate turnover across this PAN<select name="band"><option value="unspecified">Not recorded</option><option value="up-to-5cr">Up to ₹5 crore</option><option value="above-5cr">Above ₹5 crore</option></select></label>
        <p data-form-message class="gst-wide" role="status"></p><div class="gst-wide actions"><button type="submit">Save turnover band</button></div></form></details>` : "";
    const irpSection = registrations.length ? `<details class="gst-add"><summary>E-invoicing applicability</summary>
      ${state.irpPolicies?.length ? `<table><thead><tr><th>Registration</th><th>Effective from</th><th>Applicability</th></tr></thead><tbody>${state.irpPolicies.map(p => `<tr><td>${esc(registrations.find(r=>r.id===p.registrationId)?.gstin)}</td><td>${dateLabel(p.effectiveFrom)}</td><td>${esc(({required:"Required",exempt:"Exempt","below-threshold":"Below threshold"})[p.status])}</td></tr>`).join("")}</tbody></table>` : ""}
      <form id="gst-irp-policy" class="gst-form"><label>Registration<select name="registrationId">${registrations.map(r=>`<option value="${esc(r.id)}">${esc(r.gstin)} · ${esc(r.name)}</option>`).join("")}</select></label>
      ${field("effectiveFrom","Effective from",todayISO(),'type="date" required')}
      <label>Applicability<select name="status" required><option value="">Choose status</option><option value="required">E-invoicing required</option><option value="exempt">Exempt above threshold</option><option value="below-threshold">Below the applicable threshold</option></select></label>
      <label data-window hidden>IRP reporting window<select name="window"><option value="">Standard</option><option value="30">30 days</option></select></label>
      <label class="gst-wide" data-declaration hidden>Rule 46(s) declaration for this registration<textarea name="declaration" maxlength="1200" rows="3"></textarea></label>
      <p data-form-message class="gst-wide" role="status"></p><div class="gst-wide actions"><button type="submit">Save applicability</button></div></form></details>` : "";
    render("GST setup & catalog", `<section class="gst-section"><h2>Business registration</h2>${registrations.length ? `<label class="gst-registration-choice">Registration<select data-registration-choice>${registrations.map(row => `<option value="${esc(row.id)}">${esc(row.name || row.legalName)} · ${esc(row.gstin)}</option>`).join("")}<option value="">Add another registration</option></select></label>` : ""}<form id="gst-registration" class="gst-form">
      <input type="hidden" name="id" value="${esc(registration.id || "")}">
      ${field("name", "Registration name", registration.name || company.name, 'required maxlength="80"')}
      ${field("legalName", "Legal business name", registration.legalName || company.name, 'required maxlength="120"')}
      ${field("gstin", "GSTIN", registration.gstin, 'required minlength="15" maxlength="15" autocapitalize="characters" spellcheck="false"')}
      <label>State / territory<select name="stateCode" required>${stateOptions(registration.stateCode)}</select></label>
      ${addressField("address", "Business address", registration.address)}
      ${field("pincode", "PIN code", registration.pincode, 'inputmode="numeric" pattern="[0-9]{6}" maxlength="6"')}
      ${field("phone", "Phone", registration.phone, 'type="tel" maxlength="30"')}
      ${field("email", "Email", registration.email, 'type="email" maxlength="120"')}
      ${field("invoicePrefix", "Invoice series prefix", registration.invoicePrefix || "", 'maxlength="4" pattern="[A-Za-z0-9]{1,4}"')}
      <p data-form-message class="gst-wide" role="status" aria-live="polite"></p><div class="gst-wide actions"><button type="submit">Save registration</button></div>
    </form>${turnoverSection}${irpSection}</section>
    <section class="gst-section"><div class="gst-section-heading"><h2>Products & services</h2><span>${items.length} saved</span></div>
      <table><thead><tr><th>Name</th><th>HSN / SAC</th><th>Unit</th><th class="figure">Stock</th><th class="figure">Rate</th><th class="figure">Price ₹</th></tr></thead><tbody>${items.map(item => `<tr><th scope="row"><button class="gst-edit-master" type="button" data-edit-item="${esc(item.id)}">${esc(item.name)}</button><small class="gst-detail">${esc(item.kind === "service" ? "Service" : "Goods")}</small>${item.kind === "goods" ? `<small><a href="${book}/stock-item/${encodeURIComponent(item.id)}">Stock ledger & costing</a></small>` : ""}</th><td class="gst-code">${esc(item.hsnSac)}</td><td>${esc(item.unit)}</td><td class="figure">${item.kind === "goods" ? esc(state.inventory?.find(row => row.itemId === item.id)?.quantity || item.openingQuantity) : "—"}</td><td class="figure">${decimal(item.gstRateBps)}%</td><td class="figure">${money(item.pricePaise)}</td></tr>`).join("") || '<tr><td colspan="6" class="quiet">Save an item to reuse its HSN / SAC, unit and tax rate on invoices.</td></tr>'}</tbody></table>
      <details class="gst-add"${items.length ? "" : " open"}><summary>Add a product or service</summary><form id="gst-item" class="gst-form"><input type="hidden" name="id" value="">
        ${field("name", "Item name", "", 'required maxlength="120"')}
        <label>Kind<select name="kind"><option value="goods">Goods</option><option value="service">Service</option></select></label>
        <div class="gst-wide gst-hsn-search"><label>Search HSN / SAC directory<input type="search" name="hsnSearch" placeholder="Code or description" autocomplete="off"></label><div data-hsn-results class="gst-hsn-results" aria-label="HSN / SAC results"></div><p data-hsn-message class="quiet" role="status"></p><div data-hsn-pages class="book-toolbar"></div></div>
        ${field("hsnSac", "HSN / SAC code", "", 'required inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8"')}
        ${field("unit", "Unit / UQC", "NOS", 'required maxlength="12"')}
        ${field("price", "Selling price ₹", "0.00", 'required inputmode="decimal"')}
        ${field("purchasePrice", "Purchase price ₹", "0.00", 'required inputmode="decimal"')}
        ${field("gstRate", "GST rate %", "0", 'required type="number" min="0" max="100" step="0.01"')}
        ${field("cessRate", "Cess rate %", "0", 'required type="number" min="0" max="1000" step="0.01"')}
        <label>Supply status<select name="supplyStatus">${statusOptions(state, esc, "taxable")}</select></label>
        ${field("openingQuantity", "Opening stock quantity", "0", 'required inputmode="decimal"')}
        <p data-form-message class="gst-wide" role="status" aria-live="polite"></p><div class="gst-wide actions"><button type="submit">Save item</button><button type="button" class="ghost" data-new-item>New item</button></div>
      </form></details>
    </section>
    <section class="gst-section"><div class="gst-section-heading"><h2>Customers & suppliers</h2><span>${parties.length} saved</span></div>
      <table><thead><tr><th>Name</th><th>GSTIN</th><th>State / territory</th><th>Role</th></tr></thead><tbody>${parties.map(party => `<tr><th scope="row"><button class="gst-edit-master" type="button" data-edit-party="${esc(party.id)}">${esc(party.name)}</button></th><td class="gst-code">${esc(party.gstin || "Unregistered")}</td><td>${esc(stateName(party.stateCode))}</td><td>${esc(party.kind)}</td></tr>`).join("") || '<tr><td colspan="4" class="quiet">Add a customer or supplier before creating an invoice.</td></tr>'}</tbody></table>
      <details class="gst-add"${parties.length ? "" : " open"}><summary>Add a customer or supplier</summary><form id="gst-party" class="gst-form"><input type="hidden" name="id" value="">
        ${field("name", "Party name", "", 'required maxlength="120"')}
        <label>Role<select name="kind"><option value="customer">Customer</option><option value="supplier">Supplier</option><option value="both">Customer & supplier</option></select></label>
        ${field("gstin", "GSTIN · leave empty for unregistered", "", 'maxlength="15" autocapitalize="characters" spellcheck="false"')}
        <label>State / territory<select name="stateCode" required>${stateOptions("")}</select></label>
        ${addressField()}
        ${field("pincode", "PIN code", "", 'inputmode="numeric" pattern="[0-9]{6}" maxlength="6"')}
        ${field("phone", "Phone", "", 'type="tel" maxlength="30"')}
        ${field("email", "Email", "", 'type="email" maxlength="120"')}
        <p data-form-message class="gst-wide" role="status" aria-live="polite"></p><div class="gst-wide actions"><button type="submit">Save party</button><button type="button" class="ghost" data-new-party>New party</button></div>
      </form></details>
    </section>`);
    const registrationForm = root.querySelector("#gst-registration");
    root.querySelector("[data-registration-choice]")?.addEventListener("change", event => {
      const selected = registrations.find(row => row.id === event.target.value) || { name: company.name, legalName: company.name };
      for (const name of ["id", "name", "legalName", "gstin", "stateCode", "address", "pincode", "phone", "email", "invoicePrefix"]) registrationForm.elements[name].value = selected[name] || "";
    });
    root.querySelector('#gst-registration [name="address"]').required = true;
    root.querySelector('#gst-party [name="address"]').required = true;
    const object = form => Object.fromEntries(form);
    const irpForm = root.querySelector("#gst-irp-policy");
    if (irpForm) {
      const update = () => {
        irpForm.querySelector("[data-window]").hidden = irpForm.elements.status.value !== "required";
        irpForm.querySelector("[data-declaration]").hidden = irpForm.elements.status.value !== "exempt";
        irpForm.elements.declaration.required = irpForm.elements.status.value === "exempt";
      };
      irpForm.elements.status.addEventListener("change", update); update();
      bindMaster("#gst-irp-policy","irp-policy", form => ({ ...object(form), thirtyDayWindow: form.get("status") === "required" && form.get("window") === "30" }), "E-invoice applicability saved.");
    }
    const turnoverForm = root.querySelector("#gst-turnover");
    if (turnoverForm) {
      const refreshBand = () => {
        const r = registrations.find(item => item.id === turnoverForm.elements.registrationId.value);
        turnoverForm.elements.band.value = state.turnoverByYear?.find(t => t.pan === r.gstin.slice(2,12) && t.year === turnoverForm.elements.year.value)?.band || "unspecified";
      };
      turnoverForm.elements.registrationId.addEventListener("change", refreshBand);
      turnoverForm.elements.year.addEventListener("input", refreshBand);
      refreshBand();
      bindMaster("#gst-turnover", "turnover", form => object(form), "Turnover band saved for this PAN and financial year.");
    }
    bindMaster("#gst-registration", "settings", form => object(form), "Business registration saved.");
    bindMaster("#gst-party", "parties", form => object(form), "Party saved.");
    bindMaster("#gst-item", "items", form => ({ id: form.get("id") || undefined, name: form.get("name"), kind: form.get("kind"), hsnSac: form.get("hsnSac"), unit: form.get("unit"), pricePaise: parseRupees(form.get("price")), purchasePricePaise: parseRupees(form.get("purchasePrice")), gstRateBps: rateBps(form.get("gstRate")), cessRateBps: rateBps(form.get("cessRate")), supplyStatus: form.get("supplyStatus"), openingQuantity: form.get("kind") === "goods" ? form.get("openingQuantity") : "0" }), "Item saved.");
    for (const button of root.querySelectorAll("[data-edit-item]")) button.addEventListener("click", () => {
      const item = items.find(row => row.id === button.dataset.editItem);
      const form = root.querySelector("#gst-item");
      form.closest("details").open = true;
      for (const name of ["id", "name", "kind", "hsnSac", "unit", "supplyStatus", "openingQuantity"]) form.elements[name].value = item[name] ?? "";
      for (const [name, key] of [["price", "pricePaise"], ["purchasePrice", "purchasePricePaise"]]) form.elements[name].value = rupees(item[key]);
      form.elements.gstRate.value = decimal(item.gstRateBps);
      form.elements.cessRate.value = decimal(item.cessRateBps);
      form.elements.openingQuantity.disabled = item.kind === "service";
      form.elements.name.focus();
      form.scrollIntoView({ block: "center" });
    });
    for (const button of root.querySelectorAll("[data-edit-party]")) button.addEventListener("click", () => {
      const party = parties.find(row => row.id === button.dataset.editParty);
      const form = root.querySelector("#gst-party");
      form.closest("details").open = true;
      for (const name of ["id", "name", "kind", "gstin", "stateCode", "address", "pincode", "phone", "email"]) form.elements[name].value = party[name] ?? "";
      form.elements.name.focus();
      form.scrollIntoView({ block: "center" });
    });
    root.querySelector("[data-new-item]").addEventListener("click", () => {
      const form = root.querySelector("#gst-item"); form.reset(); form.elements.openingQuantity.disabled = false; form.elements.name.focus();
    });
    root.querySelector("[data-new-party]").addEventListener("click", () => { const form = root.querySelector("#gst-party"); form.reset(); form.elements.name.focus(); });
    root.querySelector('#gst-item [name="kind"]').addEventListener("change", event => {
      const opening = root.querySelector('#gst-item [name="openingQuantity"]');
      opening.disabled = event.target.value === "service";
      if (opening.disabled) opening.value = "0";
    });
    bindHsnLookup(root.querySelector("#gst-item"), api, esc, still, token);
    for (const form of root.querySelectorAll("form")) bindGstinState(form);
    return true;
  }

  if (route.name === "gst-register") {
    const range = readPeriod(company);
    render("Invoice register", `${periodBar(range)}<div class="gst-register-filters"><label>Search invoices<input name="invoiceSearch" type="search" placeholder="Number, party, GSTIN or narration"></label><label>Document type<select name="invoiceType"><option value="">All documents</option>${TYPES.map(type => `<option>${type}</option>`).join("")}</select></label></div><p class="quiet">Documents saved in these books</p><div data-invoice-list></div>`, "Ir");
    const draw = () => {
      const needle = root.querySelector('[name="invoiceSearch"]').value.trim().toLowerCase();
      const type = root.querySelector('[name="invoiceType"]').value;
      const rows = invoices.filter(invoice => invoice.date >= range.from && invoice.date <= range.to && (!type || invoice.type === type) && (!needle || [invoice.number, invoice.party?.name, invoice.party?.gstin, invoice.narration].join(" ").toLowerCase().includes(needle))).sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
      root.querySelector("[data-invoice-list]").innerHTML = `<table><thead><tr><th>Date</th><th>Document</th><th>Party</th><th class="figure">Taxable ₹</th><th class="figure">Tax ₹</th><th class="figure">Amount due ₹</th></tr></thead><tbody>${rows.map(invoice => `<tr><td>${dateLabel(invoice.date)}</td><th scope="row"><a href="${book}/gst-document/${esc(invoice.id)}">${esc(invoice.number)}</a><small class="gst-detail">${esc(invoice.type)}</small></th><td>${esc(invoice.party?.name)}<small class="gst-detail">${esc(invoice.party?.gstin || "Unregistered")}</small></td><td class="figure">${money(invoice.totals.taxablePaise)}</td><td class="figure">${money(invoice.totals.taxPaise)}</td><td class="figure">${money(invoice.partyDuePaise ?? invoice.totals.totalPaise)}</td></tr>`).join("") || '<tr><td colspan="6" class="quiet">No documents match this period and search.</td></tr>'}</tbody></table><p class="quiet">${rows.length} document${rows.length === 1 ? "" : "s"}</p>`;
    };
    root.querySelector('[name="invoiceSearch"]').addEventListener("input", draw);
    root.querySelector('[name="invoiceType"]').addEventListener("change", draw);
    bindPeriod(company);
    draw();
    return true;
  }

  if (route.name === "gst-document") {
    const { invoice, acknowledgement, irpStatus } = await api(`${base}/invoices/${encodeURIComponent(route.detail || "")}`);
    if (!still(token)) return true;
    const irpPrint = acknowledgement ? `<section class="gst-irp-print" aria-label="IRP acknowledgement">
      <img src="/api/companies/${encodeURIComponent(company.id)}/gst-exchange/${encodeURIComponent(invoice.id)}/qr.svg" alt="Signed QR code from the imported IRP acknowledgement">
      <div><h2>Imported IRP acknowledgement</h2><p><strong>Invoice reference number</strong><br><span class="gst-code">${esc(acknowledgement.irn)}</span></p>
      <p><strong>Acknowledgement number</strong> ${esc(acknowledgement.acknowledgementNumber)}<br><strong>Date</strong> ${esc(acknowledgement.acknowledgementDate)}</p></div></section>` : "";
    const pending = irpStatus?.pending;
    const title = pending ? documentTitle(invoice) + " draft" : documentTitle(invoice);
    const docStatus = pending ? "Awaiting IRN" + (irpStatus.reportBy ? " · Report by " + dateLabel(irpStatus.reportBy) : "") : acknowledgement ? "IRP acknowledgement imported" : "Posted in books";
    const declaration = irpStatus?.declaration ? `<p class="gst-declaration">${esc(irpStatus.declaration)}</p>` : "";
    render(title, `<div class="gst-toolbar actions"><button type="button" data-gst-print>Print document</button>${invoice.reverseCharge ? `<a href="${book}/gst-rcm">RCM payments & credit review</a>` : ""}${invoice.direction === "sales" ? `<a href="${book}/gst-exchange/${esc(invoice.id)}">E-invoice & e-way bill</a>` : ""}</div>${tallyInvoiceReferences(invoice,company.id,esc)}<p class="gst-filing-status">${esc(docStatus)}</p>${documentMarkup(invoice, { esc, money, stateName, irpPrint })}${declaration}`, "In");
    root.querySelector("[data-gst-print]").addEventListener("click", () => window.print());
    return true;
  }

  await composeInvoice({ route, token, ui, state, base, book, render, field, addressField, stateOptions, money, showError });
  return true;
}

function statusOptions(state, esc, selected) {
  const names = { taxable: "Taxable", exempt: "Exempt", "nil-rated": "Nil rated", "non-gst": "Non-GST", "zero-rated": "Zero rated export" };
  const statuses = state.supportedStatuses || ["taxable", "exempt", "nil-rated", "non-gst", "zero-rated"];
  return statuses.map(status => {
    const value = typeof status === "string" ? status : status.id || status.value;
    const label = typeof status === "string" ? names[status] || status : status.name || status.label;
    return `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`;
  }).join("");
}

function bindGstinState(form) {
  const gstin = form.querySelector('[name="gstin"]');
  const state = form.querySelector('[name="stateCode"]');
  gstin?.addEventListener("change", () => {
    gstin.value = gstin.value.trim().toUpperCase();
    if (/^\d{2}/.test(gstin.value)) state.value = gstin.value.slice(0, 2);
    state?.dispatchEvent(new Event("change"));
  });
  state?.addEventListener("change", () => {
    const pincode = form.querySelector('[name="pincode"]');
    if (!pincode) return;
    pincode.pattern = state.value === "96" ? ".*" : "[0-9]{6}";
    pincode.maxLength = state.value === "96" ? 12 : 6;
  });
}

function bindHsnLookup(form, api, esc, still, token) {
  const input = form.elements.hsnSearch, results = form.querySelector("[data-hsn-results]");
  const message = form.querySelector("[data-hsn-message]"), pages = form.querySelector("[data-hsn-pages]");
  const size = 20;
  let timer, sequence = 0;
  async function load(offset, current) {
    const params = new URLSearchParams({q:input.value.trim(),kind:form.elements.kind.value,selectable:"1",offset,limit:size});
    try {
      const value = await api("/api/hsn?"+params);
      if (!still(token) || current!==sequence) return;
      results.innerHTML = value.items.map((row,index)=>`<button type="button" class="ghost" data-hsn-index="${index}"><span class="gst-code">${esc(row.code)}</span> ${esc(row.description)}</button>`).join("");
      results.scrollTop=0;
      message.textContent=value.total ? `${offset+1}–${offset+value.items.length} of ${value.total} matching codes` : "No matching codes in this category.";
      pages.innerHTML=[...(offset ? [[offset-size,"Previous codes"]] : []),...(offset+size<value.total ? [[offset+size,"Next codes"]] : [])].map(([next,label])=>`<button type="button" class="secondary" data-offset="${next}">${label}</button>`).join("");
      pages.onclick=e=>{
        const button=e.target.closest("[data-offset]");
        if (button) load(Number(button.dataset.offset),++sequence);
      };
      results.onclick=e=>{
        const button=e.target.closest("[data-hsn-index]");
        if (!button) return;
        const item=value.items[Number(button.dataset.hsnIndex)];
        form.elements.hsnSac.value=item.code; input.value=item.description;
        results.replaceChildren(); pages.replaceChildren();
        message.textContent=item.code+" · "+item.description;
      };
    } catch(error){if(still(token)&&current===sequence)message.textContent=error.message;}
  }
  function search() {
    clearTimeout(timer);
    const current=++sequence;
    results.replaceChildren();pages.replaceChildren();message.textContent="";
    if (input.value.trim().length>=2) timer=setTimeout(()=>load(0,current),150);
  }
  input.addEventListener("input",search);
  form.elements.kind.addEventListener("change",search);
  form.addEventListener("reset",()=>{clearTimeout(timer);sequence++;results.replaceChildren();pages.replaceChildren();message.textContent="";});
}

async function composeInvoice(context) {
  const { route, token, ui, state, base, book, render, field, addressField, stateOptions, money, showError } = context;
  const { root, api, still, esc } = ui;
  const { company, registrations, parties, items, invoices } = state;
  const godowns = state.godowns?.length ? state.godowns : [{ id: "main", name: "Main Location" }];
  if (!registrations.length || !parties.length || !items.length) {
    const missing = [[registrations.length, "business registration"], [parties.length, "customer or supplier"], [items.length, "product or service"]].filter(([count]) => !count).map(([, label]) => label);
    render("New invoice", `<section class="gst-section"><h2>Set up these books for billing</h2><p>Add ${missing.map(esc).join(", ")} to create your first invoice.</p><p><a class="button" href="${book}/gst">Open GST setup & catalog</a></p></section>`, "In");
    return;
  }
  const key = `financer-gst-draft:${company.id}`;
  let draft;
  try { draft = JSON.parse(localStorage.getItem(key) || "null"); } catch { draft = null; }
  const freshLine = () => ({ itemId: "", godownId: godowns[0].id, quantity: "1", unitPrice: "0.00", discount: "0", gstRate: "0", cessRate: "0", supplyStatus: "taxable" });
  const initial = { type: "Sales", direction: "sales", registrationId: registrations[0].id, partyId: "", date: todayISO(), placeOfSupply: registrations[0].stateCode, pricing: "exclusive", supplyCategory: "domestic", exportMode: "lut", number: "", supplierInvoiceNumber: "", originalInvoiceId: "", originalNumber: "", originalDate: "", shippingAddress: "", portCode: "", shippingBillNumber: "", shippingBillDate: "", destinationCountry: "", narration: "", itcEligibility: "pending", stockEffect: "none", reverseCharge: new URLSearchParams(location.hash.split("?")[1] || "").get("rcm") === "true" ? "true" : "false", rcmBasis: "", rcmReceiptDate: "", rcmSupplierDate: "", rcmSelfDate: "", rcmAssociated: "false", rcmConfirmed: "" };
  const fields = { ...initial, ...(draft?.fields || {}) };
  let lines = Array.isArray(draft?.lines) && draft.lines.length ? draft.lines : [freshLine()];
  const requestId = draft?.requestId || crypto.randomUUID();
  const select = (name, label, options) => `<label>${label}<select name="${name}">${options}</select></label>`;
  render("New invoice", `<form id="gst-compose" class="gst-compose">
    <div class="gst-draft-status"><span data-draft-status role="status">${draft ? "Saved draft restored" : "Draft saves on this Mac"}</span><button type="button" class="ghost" data-discard-draft>Clear draft</button></div>
    <div class="gst-form">
      ${select("type", "Document type", TYPES.map(type => `<option>${type}</option>`).join(""))}
      ${select("registrationId", "Business registration", registrations.map(row => `<option value="${esc(row.id)}">${esc(row.name || row.legalName)} · ${esc(row.gstin)}</option>`).join(""))}
      ${select("partyId", "Customer / supplier", '<option value="">Choose party</option>' + parties.map(row => `<option value="${esc(row.id)}">${esc(row.name)}${row.gstin ? " · " + esc(row.gstin) : " · Unregistered"}</option>`).join(""))}
      ${field("date", "Document date", fields.date, `type="date" required min="${esc(company.booksFrom)}"`)}
      <label>Place of supply<select name="placeOfSupply" required>${stateOptions(fields.placeOfSupply)}</select></label>
      ${select("pricing", "Item prices", '<option value="exclusive">Tax exclusive</option><option value="inclusive">Tax inclusive</option>')}
      ${select("reverseCharge", "Tax responsibility", '<option value="false">Forward charge</option><option value="true">Reverse charge</option>')}
      ${field("number", "Document number · automatic when empty", fields.number, 'maxlength="16" pattern="[A-Za-z0-9/\\-]+"')}
      <label data-purchase-field hidden>Supplier invoice number<input name="supplierInvoiceNumber" maxlength="16" value="${esc(fields.supplierInvoiceNumber)}"></label>
      <label data-purchase-field hidden>Input tax credit review<select name="itcEligibility"><option value="pending">Pending review</option><option value="eligible">Eligible</option><option value="ineligible">Ineligible</option></select></label>
      <label data-note-field hidden>Stock treatment<select name="stockEffect"><option value="none">Financial adjustment only</option><option value="quantity">Goods return / quantity adjustment</option></select></label>
      <label data-note-field hidden>Note applies to<select name="direction"><option value="sales">Sales</option><option value="purchase">Purchases</option></select></label>
      <label data-note-field hidden>Original invoice<select name="originalInvoiceId"><option value="">Enter external invoice details below</option>${invoices.filter(row => row.type === "Sales" || row.type === "Purchase").map(row => `<option value="${esc(row.id)}">${esc(row.number)} · ${esc(row.party?.name)} · ${dateLabel(row.date)}</option>`).join("")}</select></label>
      <label data-note-field hidden>Original invoice number<input name="originalNumber" maxlength="16" value="${esc(fields.originalNumber)}"></label>
      <label data-note-field hidden>Original invoice date<input name="originalDate" type="date" value="${esc(fields.originalDate)}"></label>
    </div>
    <fieldset data-rcm-fields hidden class="gst-form gst-rcm-facts"><legend>Reverse-charge facts</legend>
      ${field("rcmBasis", "Applicable section and notification reference", fields.rcmBasis, 'maxlength="240"')}
      <label class="gst-wide gst-rcm-check"><input type="checkbox" name="rcmConfirmed">RCM applicability and the notification conditions have been reviewed for this supply.</label>
      <label data-rcm-inward>Supply received on<input type="date" name="rcmReceiptDate" value="${esc(fields.rcmReceiptDate)}"></label>
      <label data-rcm-inward>Supplier document date<input type="date" name="rcmSupplierDate" value="${esc(fields.rcmSupplierDate)}"></label>
      <label data-rcm-self>Recipient self-invoice date<input type="date" name="rcmSelfDate" value="${esc(fields.rcmSelfDate)}"></label>
      <label data-rcm-inward>Imported services from an associated enterprise<select name="rcmAssociated"><option value="false">No</option><option value="true">Yes</option></select></label>
      <p class="gst-wide quiet">RCM supplier consideration excludes the recipient's tax. Liability, cash discharge and input-credit review are linked in the RCM workspace.</p>
    </fieldset>
    <div class="gst-section-heading gst-items-heading"><h2>Invoice items</h2></div>
    <div class="gst-line-scroll"><table class="gst-entry-table"><thead><tr><th>Item / HSN / unit</th><th class="figure">Quantity</th><th class="figure">Unit price ₹</th><th class="figure">Discount %</th><th class="figure">GST %</th><th class="figure">Cess %</th><th>Supply status</th><th></th></tr></thead><tbody data-invoice-lines></tbody></table></div>
    <div class="actions"><button type="button" class="ghost" data-add-item>Add item</button></div>
    <details class="gst-add"><summary>Delivery & supply details</summary><div class="gst-form">
      ${select("supplyCategory", "Supply category", '<option value="domestic">Domestic</option><option value="export">Export</option><option value="sez">SEZ</option>')}
      <label data-export-field hidden>Export / SEZ tax treatment<select name="exportMode"><option value="lut">Under LUT / bond without payment of tax</option><option value="with-payment">With payment of integrated tax</option></select></label>
      <label data-customs-field hidden>Destination country code<input name="destinationCountry" maxlength="2" placeholder="US" value="${esc(fields.destinationCountry || "")}"></label>
      <label data-customs-field hidden>Customs port code<input name="portCode" maxlength="6" value="${esc(fields.portCode || "")}"></label>
      <label data-customs-field hidden>Shipping bill number<input name="shippingBillNumber" maxlength="20" value="${esc(fields.shippingBillNumber || "")}"></label>
      <label data-customs-field hidden>Shipping bill date<input type="date" name="shippingBillDate" value="${esc(fields.shippingBillDate || "")}"></label>
      ${addressField("shippingAddress", "Delivery address · if different", fields.shippingAddress)}
      ${addressField("narration", "Narration / terms", fields.narration)}
    </div></details>
    <div class="gst-preview" data-invoice-preview aria-live="polite"><p class="quiet">Complete the invoice details to review the amounts.</p></div>
    <p data-form-message role="alert"></p>
    <div class="gst-post actions"><button type="submit" data-post-invoice disabled>Post invoice</button><span class="quiet">⌘ Enter to post</span></div>
  </form>`, "In");
  const form = root.querySelector("#gst-compose");
  for (const [name, value] of Object.entries(fields)) if (form.elements[name]) form.elements[name].value = value;
  form.elements.rcmConfirmed.checked = fields.rcmConfirmed === "on" || fields.rcmConfirmed === true;
  const preparedRcm = new Map();
  const prepareRcm = async () => {
    if (form.elements.reverseCharge.value !== "true") return;
    const registrationId = form.elements.registrationId.value;
    if (!preparedRcm.has(registrationId)) preparedRcm.set(registrationId, api(`${base}/rcm/setup`, { method: "POST", body: { registrationId } }).catch(error => { preparedRcm.delete(registrationId); throw error; }));
    await preparedRcm.get(registrationId);
  };
  const rows = form.querySelector("[data-invoice-lines]");
  const postButton = form.querySelector("[data-post-invoice]");
  let previewTimer;
  let sequence = 0;
  let posting = false;
  let placeWasEdited = Boolean(draft?.placeWasEdited);
  const captureLines = () => [...rows.querySelectorAll("tr")].map(row => Object.fromEntries([...row.querySelectorAll("input,select")].map(input => [input.dataset.field, input.value])));
  const remember = () => {
    lines = captureLines();
    const values = Object.fromEntries(new FormData(form));
    values.rcmConfirmed = form.elements.rcmConfirmed.checked;
    try {
      localStorage.setItem(key, JSON.stringify({ fields: values, lines, requestId, placeWasEdited }));
      form.querySelector("[data-draft-status]").textContent = "Draft saved on this Mac";
    } catch {
      form.querySelector("[data-draft-status]").textContent = "Draft storage is full. Keep this page open until posting.";
    }
  };
  const drawLines = () => {
    rows.innerHTML = lines.map((line, index) => {
      const item = items.find(row => row.id === line.itemId);
      return `<tr data-line="${index}"><td><select data-field="itemId" aria-label="Item ${index + 1}" required><option value="">Choose item</option>${items.map(row => `<option value="${esc(row.id)}"${line.itemId === row.id ? " selected" : ""}>${esc(row.name)}</option>`).join("")}</select><small class="gst-item-code">${item ? `${esc(item.hsnSac)} · ${esc(item.unit || "Service")}` : "HSN / SAC · Unit"}</small><label class="gst-line-godown"${item?.kind === "service" ? " hidden" : ""}>Godown<select data-field="godownId" aria-label="Godown ${index + 1}"${item?.kind === "service" ? " disabled" : " required"}><option value="">Choose godown</option>${godowns.map(location => `<option value="${esc(location.id)}"${(line.godownId ?? godowns[0].id) === location.id ? " selected" : ""}>${esc(location.name)}</option>`).join("")}</select></label></td>
        <td><input data-field="quantity" aria-label="Quantity ${index + 1}" value="${esc(line.quantity)}" inputmode="decimal" required></td>
        <td><input data-field="unitPrice" aria-label="Unit price ${index + 1}" value="${esc(line.unitPrice)}" inputmode="decimal" required></td>
        <td><input data-field="discount" aria-label="Discount percent ${index + 1}" value="${esc(line.discount)}" type="number" min="0" max="100" step="0.01" required></td>
        <td><input data-field="gstRate" aria-label="GST rate percent ${index + 1}" value="${esc(line.gstRate)}" type="number" min="0" max="100" step="0.01" required></td>
        <td><input data-field="cessRate" aria-label="Cess rate percent ${index + 1}" value="${esc(line.cessRate)}" type="number" min="0" max="1000" step="0.01" required></td>
        <td><select data-field="supplyStatus" aria-label="Supply status ${index + 1}">${statusOptions(state, esc, line.supplyStatus)}</select></td>
        <td><button type="button" class="ghost gst-remove" data-remove-item="${index}" aria-label="Remove item ${index + 1}"${lines.length === 1 ? " disabled" : ""}>×</button></td></tr>`;
    }).join("");
  };
  const conditionalFields = () => {
    const note = form.elements.type.value.includes("Note");
    const purchase = form.elements.type.value === "Purchase" || (note && form.elements.direction.value === "purchase");
    for (const element of form.querySelectorAll("[data-note-field]")) element.hidden = !note;
    for (const element of form.querySelectorAll("[data-purchase-field]")) element.hidden = !purchase;
    for (const element of form.querySelectorAll("[data-export-field]")) element.hidden = form.elements.supplyCategory.value === "domestic";
    for (const element of form.querySelectorAll("[data-customs-field]")) element.hidden = form.elements.supplyCategory.value !== "export";
    const reverseCharge = form.elements.reverseCharge.value === "true";
    const party = parties.find(row => row.id === form.elements.partyId.value);
    const selfInvoice = reverseCharge && purchase && !party?.gstin && !note;
    form.querySelector("[data-rcm-fields]").hidden = !reverseCharge;
    for (const element of form.querySelectorAll("[data-rcm-inward]")) element.hidden = !purchase;
    form.querySelector("[data-rcm-self]").hidden = !selfInvoice;
    form.elements.rcmBasis.required = reverseCharge;
    form.elements.rcmConfirmed.required = reverseCharge;
    form.elements.rcmReceiptDate.required = reverseCharge && purchase;
    form.elements.rcmSupplierDate.required = reverseCharge && purchase && Boolean(party?.gstin);
    form.elements.rcmSelfDate.required = selfInvoice;
    form.elements.itcEligibility.disabled = reverseCharge;
    if (reverseCharge) { form.elements.pricing.value = "exclusive"; form.elements.supplyCategory.value = "domestic"; }
    form.elements.pricing.querySelector('[value="inclusive"]').disabled = reverseCharge;
    form.elements.supplierInvoiceNumber.required = purchase && !(reverseCharge && !party?.gstin);
    form.elements.originalNumber.required = note && !form.elements.originalInvoiceId.value;
    form.elements.originalDate.required = note && !form.elements.originalInvoiceId.value;
    form.elements.originalNumber.disabled = !note || Boolean(form.elements.originalInvoiceId.value);
    form.elements.originalDate.disabled = !note || Boolean(form.elements.originalInvoiceId.value);
    for (const row of rows.children) {
      const item = items.find(item => item.id === row.querySelector('[data-field="itemId"]').value);
      const movement = item?.kind === "goods" && (!note || form.elements.stockEffect.value === "quantity");
      row.querySelector(".gst-line-godown").hidden = !movement;
      row.querySelector('[data-field="godownId"]').disabled = !movement;
      row.querySelector('[data-field="godownId"]').required = movement;
    }
    postButton.textContent = note ? "Post note" : "Post invoice";
  };
  const payload = () => {
    const data = new FormData(form);
    const type = data.get("type");
    const quantityMovement = !type.includes("Note") || data.get("stockEffect") === "quantity";
    return {
      type, direction: type.includes("Note") ? data.get("direction") : type === "Purchase" ? "purchase" : "sales",
      registrationId: data.get("registrationId"), partyId: data.get("partyId"), date: data.get("date"), placeOfSupply: data.get("placeOfSupply"), pricing: data.get("pricing"),
      number: data.get("number") || undefined, supplierInvoiceNumber: data.get("supplierInvoiceNumber") || undefined,
      originalInvoiceId: type.includes("Note") ? data.get("originalInvoiceId") || undefined : undefined,
      originalNumber: type.includes("Note") ? data.get("originalNumber") || undefined : undefined,
      originalDate: type.includes("Note") ? data.get("originalDate") || undefined : undefined,
      supplyCategory: data.get("supplyCategory"), exportMode: data.get("supplyCategory") === "domestic" ? undefined : data.get("exportMode"),
      ...(data.get("supplyCategory") === "export" ? {destinationCountry:data.get("destinationCountry"),portCode:data.get("portCode"),shippingBillNumber:data.get("shippingBillNumber"),shippingBillDate:data.get("shippingBillDate")} : {}),
      shippingAddress: data.get("shippingAddress"), narration: data.get("narration"), reverseCharge: data.get("reverseCharge") === "true", requestId,
      rcm: data.get("reverseCharge") === "true" ? { applicabilityConfirmed: form.elements.rcmConfirmed.checked, basisReference: data.get("rcmBasis"), receiptDate: data.get("rcmReceiptDate") || data.get("date"), supplierInvoiceDate: data.get("rcmSupplierDate") || data.get("date"), selfInvoiceDate: data.get("rcmSelfDate") || data.get("date"), associatedEnterprise: data.get("rcmAssociated") === "true" } : undefined,
      itcEligibility: data.get("itcEligibility"), stockEffect: type.includes("Note") ? data.get("stockEffect") : "quantity",
      items: captureLines().map(line => ({ itemId: line.itemId, ...(quantityMovement && items.find(item => item.id === line.itemId)?.kind === "goods" ? { godownId: line.godownId } : {}), quantity: line.quantity, unitPricePaise: parseRupees(line.unitPrice), discountBps: rateBps(line.discount), gstRateBps: rateBps(line.gstRate), cessRateBps: rateBps(line.cessRate), supplyStatus: line.supplyStatus })),
    };
  };
  const preview = async () => {
    clearTimeout(previewTimer);
    const current = ++sequence;
    postButton.disabled = true;
    const target = form.querySelector("[data-invoice-preview]");
    if (!form.checkValidity()) {
      target.innerHTML = '<p class="quiet">Complete the invoice details to review the amounts.</p>';
      return;
    }
    try {
      await prepareRcm();
      const { invoice } = await api(`${base}/preview`, { method: "POST", body: payload() });
      if (!still(token) || current !== sequence || posting) return;
      const tax = invoice.totals;
      const componentLabels = [["CGST", "cgstPaise"], ["SGST", "sgstPaise"], ["UTGST", "utgstPaise"], ["IGST", "igstPaise"], ["Cess", "cessPaise"]];
      target.innerHTML = `<div class="gst-preview-number"><span>Document</span><strong>${esc(invoice.number)}</strong></div><div class="gst-preview-breakdown"><div><span>Taxable value</span><strong>₹ ${money(tax.taxablePaise)}</strong></div>${componentLabels.filter(([, key]) => tax[key]).map(([name, key]) => `<div><span>${name}</span><strong>₹ ${money(tax[key])}</strong></div>`).join("")}<div class="gst-preview-total"><span>${invoice.reverseCharge ? "Party amount due" : "Document total"}</span><strong>₹ ${money(invoice.partyDuePaise ?? tax.totalPaise)}</strong></div></div>`;
      postButton.disabled = false;
    } catch (error) {
      if (still(token) && current === sequence) target.innerHTML = `<p class="alert">${esc(error.message)}</p>`;
    }
  };
  const schedulePreview = () => {
    ++sequence;
    postButton.disabled = true;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, 240);
  };
  drawLines();
  conditionalFields();
  form.addEventListener("input", event => {
    if (event.target.name === "placeOfSupply") placeWasEdited = true;
    remember(); schedulePreview();
  });
  form.addEventListener("change", event => {
    const input = event.target;
    if (input.dataset.field === "itemId") {
      const item = items.find(row => row.id === input.value);
      if (item) {
        const row = input.closest("tr");
        const purchase = form.elements.type.value === "Purchase" || (form.elements.type.value.includes("Note") && form.elements.direction.value === "purchase");
        row.querySelector('[data-field="unitPrice"]').value = rupees(purchase ? item.purchasePricePaise ?? item.pricePaise : item.pricePaise);
        row.querySelector('[data-field="gstRate"]').value = decimal(item.gstRateBps);
        row.querySelector('[data-field="cessRate"]').value = decimal(item.cessRateBps);
        row.querySelector('[data-field="supplyStatus"]').value = item.supplyStatus;
        row.querySelector(".gst-item-code").textContent = `${item.hsnSac} · ${item.unit || "Service"}`;
        row.querySelector(".gst-line-godown").hidden = item.kind === "service";
        const godown = row.querySelector('[data-field="godownId"]');
        godown.disabled = item.kind === "service";
        godown.required = item.kind !== "service";
        row.querySelector('[data-field="quantity"]').focus();
        row.querySelector('[data-field="quantity"]').select();
      }
    }
    if (input.name === "supplyCategory") {
      const special = input.value !== "domestic";
      if (input.value === "export") form.elements.placeOfSupply.value = "96";
      for (const status of rows.querySelectorAll('[data-field="supplyStatus"]')) {
        if (special) status.value = "zero-rated";
        else if (status.value === "zero-rated") status.value = "taxable";
      }
    }
    if (["partyId", "registrationId", "type", "direction"].includes(input.name) && !placeWasEdited) {
      const purchase = form.elements.type.value === "Purchase" || (form.elements.type.value.includes("Note") && form.elements.direction.value === "purchase");
      const entity = purchase ? registrations.find(row => row.id === form.elements.registrationId.value) : parties.find(row => row.id === form.elements.partyId.value);
      if (entity) form.elements.placeOfSupply.value = entity.stateCode;
    }
    if (input.name === "originalInvoiceId" && input.value) {
      const original = invoices.find(row => row.id === input.value);
      if (original) {
        form.elements.direction.value = original.type === "Purchase" ? "purchase" : "sales";
        form.elements.partyId.value = original.partyId;
        form.elements.registrationId.value = original.registrationId;
        form.elements.placeOfSupply.value = original.placeOfSupply;
        form.elements.originalNumber.value = original.number;
        form.elements.originalDate.value = original.date;
        form.elements.reverseCharge.value = String(Boolean(original.reverseCharge));
        if (original.rcm) {
          form.elements.rcmBasis.value = original.rcm.basisReference;
          form.elements.rcmReceiptDate.value = original.rcm.receiptDate || form.elements.date.value;
          form.elements.rcmSupplierDate.value = form.elements.date.value;
          form.elements.rcmSelfDate.value = form.elements.date.value;
          form.elements.rcmAssociated.value = String(original.rcm.associatedEnterprise);
          form.elements.rcmConfirmed.checked = false;
        }
      }
    }
    conditionalFields();
    remember();
    schedulePreview();
  });
  form.querySelector("[data-add-item]").addEventListener("click", () => {
    lines = captureLines(); lines.push(freshLine()); drawLines(); remember(); schedulePreview();
    rows.lastElementChild.querySelector("select").focus();
  });
  rows.addEventListener("click", event => {
    const button = event.target.closest("[data-remove-item]");
    if (!button || lines.length === 1) return;
    lines = captureLines(); lines.splice(Number(button.dataset.removeItem), 1); drawLines(); remember(); schedulePreview();
  });
  form.querySelector("[data-discard-draft]").addEventListener("click", async () => {
    if (!window.confirm("Clear this invoice draft?")) return;
    clearTimeout(previewTimer); ++sequence;
    localStorage.removeItem(key);
    await viewGst(route, token, ui);
  });
  form.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (!postButton.disabled && !posting) form.requestSubmit();
    }
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (posting || !form.reportValidity()) return;
    posting = true; ++sequence; clearTimeout(previewTimer); postButton.disabled = true;
    try {
      await prepareRcm();
      const { invoice } = await api(`${base}/invoices`, { method: "POST", body: payload() });
      localStorage.removeItem(key);
      if (!still(token)) return;
      sessionStorage.setItem(`financer-gst-flash:${company.id}`, `${invoice.type} ${invoice.number} posted to the books.`);
      location.hash = `${book}/gst-document/${encodeURIComponent(invoice.id)}`;
    } catch (error) {
      posting = false;
      if (still(token)) { showError(form, error); await preview(); }
    }
  });
  await preview();
}

function documentTitle(invoice) {
  if (invoice.rcm?.selfInvoiceRequired) return "Self-invoice";
  if (invoice.type === "Purchase") return "Purchase invoice record";
  if (invoice.documentLabel) return invoice.documentLabel.charAt(0).toUpperCase() + invoice.documentLabel.slice(1).toLowerCase();
  if (invoice.type === "Credit Note" || invoice.type === "Debit Note") return invoice.type;
  return invoice.items.every(row => row.supplyStatus === "exempt" || row.supplyStatus === "nil-rated" || row.supplyStatus === "non-gst") ? "Bill of supply" : "Tax invoice";
}

function documentMarkup(invoice, helpers) {
  const { esc, money, stateName } = helpers;
  const registration = invoice.registration;
  const party = invoice.party;
  const purchase = invoice.direction === "purchase" || invoice.type === "Purchase";
  const supplier = purchase ? party : registration;
  const recipient = purchase ? registration : party;
  const totals = invoice.totals;
  const issuer = invoice.rcm?.selfInvoiceRequired ? recipient : supplier;
  const components = [["CGST", "cgstPaise"], ["SGST", "sgstPaise"], ["UTGST", "utgstPaise"], ["IGST", "igstPaise"], ["Cess", "cessPaise"]].filter(([, key]) => totals[key]);
  const address = entity => `<strong>${esc(entity.legalName || entity.name)}</strong><p>${esc(entity.address || "").replace(/\n/g, "<br>")}${entity.pincode ? " · " + esc(entity.pincode) : ""}</p><p>GSTIN ${esc(entity.gstin || "Unregistered")}</p><p>${esc(stateName(entity.stateCode))}</p>${entity.phone || entity.email ? `<p>${esc([entity.phone, entity.email].filter(Boolean).join(" · "))}</p>` : ""}`;
  const rowTax = row => components.map(([label, key]) => {
    const rate = key === "cessPaise" ? decimal(row.cessRateBps) : key === "igstPaise" ? decimal(row.gstRateBps) : String(row.gstRateBps / 200);
    return `<span>${label} ${esc(rate)}% · ${money(row[key])}</span>`;
  }).join("");
  let exportText = "";
  if (["export", "sez"].includes(invoice.supplyCategory)) {
    exportText = invoice.exportMode === "with-payment" ? "Supply meant for export / supply to SEZ unit or SEZ developer for authorised operations on payment of integrated tax" : "Supply meant for export / supply to SEZ unit or SEZ developer for authorised operations under bond or letter of undertaking without payment of integrated tax";
  }
  return `<article class="gst-document">
    ${exportText ? `<p class="gst-export-endorsement">${esc(exportText)}</p>` : ""}
    <div class="gst-document-identity"><div><span>Document number</span><strong>${esc(invoice.number)}</strong></div><div><span>Date</span><strong>${dateLabel(invoice.date)}</strong></div></div>
    ${purchase && !invoice.rcm?.selfInvoiceRequired ? `<p class="gst-reference">Supplier invoice ${esc(invoice.supplierInvoiceNumber || invoice.number)}</p>` : ""}
    ${invoice.originalNumber || invoice.originalInvoiceId ? `<p class="gst-reference">Against invoice ${esc(invoice.originalNumber || invoice.originalInvoiceId)}${invoice.originalDate ? " dated " + dateLabel(invoice.originalDate) : ""}</p>` : ""}
    <div class="gst-addresses"><section><h2>Supplier</h2>${address(supplier)}</section><section><h2>Recipient</h2>${address(recipient)}</section></div>
    ${invoice.reverseCharge ? `<p class="gst-export-endorsement">Tax is payable by the recipient under reverse charge.</p><p class="gst-reference">${esc(invoice.rcm.basisReference)}</p>` : ""}
    <div class="gst-document-context"><p><strong>Place of supply</strong> ${esc(stateName(invoice.placeOfSupply))}</p><p><strong>Reverse charge</strong> ${invoice.reverseCharge ? "Yes" : "No"}</p><p><strong>Prices</strong> ${invoice.pricing === "inclusive" ? "Tax inclusive" : "Tax exclusive"}</p></div>
    ${invoice.destinationCountry || invoice.portCode || invoice.shippingBillNumber || invoice.shippingBillDate ? `<p class="gst-delivery">${[invoice.destinationCountry && "Destination " + invoice.destinationCountry, invoice.portCode && "Port " + invoice.portCode, invoice.shippingBillNumber && "Shipping bill " + invoice.shippingBillNumber, invoice.shippingBillDate && "Shipping bill date " + dateLabel(invoice.shippingBillDate)].filter(Boolean).map(esc).join(" · ")}</p>` : ""}
    ${invoice.shippingAddress ? `<p class="gst-delivery"><strong>Delivery address</strong><br>${esc(invoice.shippingAddress).replace(/\n/g, "<br>")}</p>` : ""}
    <table class="gst-document-table"><thead><tr><th>Description</th><th>HSN / SAC</th><th class="figure">Quantity / unit</th><th class="figure">Rate ₹</th><th class="figure">Discount ₹</th><th class="figure">Taxable ₹</th><th class="figure">${invoice.reverseCharge ? "Assessed tax" : "Tax"}</th><th class="figure">${invoice.reverseCharge ? "Assessed value ₹" : "Amount ₹"}</th></tr></thead><tbody>${invoice.items.map(row => `<tr><th scope="row">${esc(row.name)}<small class="gst-detail">${esc(row.supplyStatus)}</small></th><td class="gst-code">${esc(row.hsnSac)}</td><td class="figure">${esc(row.quantity)} ${esc(row.unit || "")}</td><td class="figure">${money(row.unitPricePaise)}</td><td class="figure">${money(row.discountPaise)}</td><td class="figure">${money(row.taxablePaise)}</td><td class="figure gst-tax-cell">${components.length ? rowTax(row) : `<span>GST ${esc(decimal(row.gstRateBps))}% · ${money(row.taxPaise)}</span>`}</td><td class="figure">${money(row.totalPaise)}</td></tr>`).join("")}</tbody></table>
    <div class="gst-document-bottom"><div>${helpers.irpPrint || ""}${invoice.narration ? `<p class="gst-terms">${esc(invoice.narration).replace(/\n/g, "<br>")}</p>` : ""}</div><dl class="gst-document-totals"><div><dt>Taxable value</dt><dd>₹ ${money(totals.taxablePaise)}</dd></div>${components.map(([label, key]) => `<div><dt>${label}</dt><dd>₹ ${money(totals[key])}</dd></div>`).join("")}<div class="${invoice.reverseCharge ? "" : "gst-total"}"><dt>${invoice.reverseCharge ? "Assessed value including RCM tax" : "Total"}</dt><dd>₹ ${money(totals.totalPaise)}</dd></div>${invoice.reverseCharge ? `<div class="gst-total"><dt>${purchase ? "Amount payable to supplier" : "Amount due from recipient"}</dt><dd>₹ ${money(invoice.partyDuePaise)}</dd></div>` : ""}</dl></div>
    <div class="gst-signature"><p>For ${esc(issuer.legalName || issuer.name)}</p><span>Authorised signatory</span></div>
  </article>`;
}
