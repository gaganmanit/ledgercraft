import { amountOnlyService } from "/gst-line-basis.js";
import { tallyInvoiceReferences } from "/tally-invoice-references.js";
import { formatINR, parseRupees, todayISO } from "/money.js";
import { compositionDealerField, compositionDealerPill, compositionDealerValue, setCompositionDealer } from "/party-ui.js";

const GST_ROUTES = new Set(["gst", "gst-invoice", "gst-register", "gst-document"]);
const TYPES = ["Sales", "Purchase", "Credit Note", "Debit Note"];
const COMPONENTS = [["CGST", "cgstPaise"], ["SGST", "sgstPaise"], ["UTGST", "utgstPaise"], ["IGST", "igstPaise"], ["Cess", "cessPaise"]];
const ROLES = { customer: "Customer", supplier: "Supplier", both: "Customer and supplier" };
const STATUS_NAMES = { taxable: "Taxable", exempt: "Exempt", "nil-rated": "Nil rated", "non-gst": "Non-GST", "zero-rated": "Zero rated export" };
/* Invoice numbers under Rule 46(b): up to 16 characters, letters, digits, slash and hyphen, starting with a letter or digit. */
const INVOICE_NUMBER_PATTERN = "[A-Za-z0-9][A-Za-z0-9\\/\\-]{0,15}";
const INVOICE_NUMBER_HINT = "Up to 16 letters, digits, / or -, starting with a letter or digit";
const dateLabel = value => /^\d{4}-\d{2}-\d{2}/.test(value || "") ? value.slice(0, 10).split("-").reverse().join("-") + value.slice(10).replace("T", " ").replace(/\.\d+Z?$|Z$/, "") : value || "—";
const decimal = (value = 0) => String(value / 100);
const rupees = (value = 0) => (value / 100).toFixed(2);

function rateBps(value) {
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(String(value))) throw new Error("Enter a percentage with up to two decimal places");
  const [whole, fraction = ""] = String(value).split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const belowHundred = n => n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
const belowThousand = n => [Math.floor(n / 100) ? ONES[Math.floor(n / 100)] + " hundred" : "", n % 100 ? belowHundred(n % 100) : ""].filter(Boolean).join(" ");
function indianWords(n) {
  if (!n) return "zero";
  const crore = Math.floor(n / 1e7), lakh = Math.floor((n % 1e7) / 1e5), thousand = Math.floor((n % 1e5) / 1000), rest = n % 1000;
  return [crore ? indianWords(crore) + " crore" : "", lakh ? belowHundred(lakh) + " lakh" : "", thousand ? belowHundred(thousand) + " thousand" : "", rest ? belowThousand(rest) : ""].filter(Boolean).join(" ");
}
function amountInWords(paise) {
  const value = Math.abs(Number(paise) || 0);
  const whole = Math.floor(value / 100), fraction = value % 100;
  return `Indian rupees ${indianWords(whole)}${fraction ? ` and ${belowHundred(fraction)} paise` : ""} only`;
}

/*
 * Invoice register: GET /api/companies/<id>/gst-register filters by period, document type and words
 * on the server, newest first, 200 documents a page. The count and totals come from the server and
 * cover every matching document; Download CSV and Print fetch every matching document first.
 */
async function viewRegister(route, token, ui) {
  const { root, api, still, page, esc, readPeriod, periodBar, bindPeriod, moreRows, serverPagedTable, PAGE_ROWS, canWrite } = ui;
  const base = `/api/companies/${encodeURIComponent(route.id)}`;
  const meta = await api(`${base}/meta`);
  if (!still(token)) return true;
  const range = readPeriod(meta.company);
  const filters = { type: "", q: "" };
  const address = (page = null, values = filters) => `${base}/gst-register?${new URLSearchParams({ from: range.from, to: range.to, ...(values.type ? { type: values.type } : {}), ...(values.q ? { q: values.q } : {}), ...(page ? { offset: String(page.offset), limit: String(page.limit) } : {}) })}`;
  const first = await api(address({ offset: 0, limit: PAGE_ROWS }));
  if (!still(token)) return true;
  const company = { ...meta.company, ...first.company };
  const book = `#/c/${encodeURIComponent(company.id)}`;
  const money = value => esc(formatINR(value || 0));
  /* Whether these books hold any GST document at all decides what an empty register says. */
  let anyDocuments = first.total > 0;
  if (!anyDocuments) {
    try { anyDocuments = (await api(`${base}/gst-register?limit=1`)).total > 0; } catch (error) { if (error.signIn) return true; }
    if (!still(token)) return true;
  }
  const flashKey = `financer-gst-flash:${company.id}`;
  const flash = sessionStorage.getItem(flashKey) || "";
  sessionStorage.removeItem(flashKey);
  const typeOptions = TYPES.map(type => `<option>${type}</option>`).join("");
  document.title = `Invoice register · ${company.name}`;
  root.innerHTML = page({ company, kicker: "Billing", title: "Invoice register", folio: "Ir", status: flash, body: `<div class="gst-workspace">${periodBar(range)}<div class="toolbar gst-register-filters"><label class="grow">Search invoices<input name="invoiceSearch" type="search" placeholder="Number, party, GSTIN or narration" autocomplete="off"></label><label>Document type<select name="invoiceType"><option value="">All documents</option>${typeOptions}</select></label></div>
      <div class="table-scroll" data-invoice-list><table class="gst-register-table"><thead><tr><th>Date</th><th>Document</th><th>Party</th><th class="figure">Taxable (₹)</th><th class="figure">Tax (₹)</th><th class="figure">Amount due (₹)</th></tr></thead><tbody data-invoice-rows></tbody>
      <tfoot><tr class="total"><th scope="row" colspan="3" data-invoice-count></th><td class="figure" data-total-taxable></td><td class="figure" data-total-tax></td><td class="figure" data-total-due></td></tr></tfoot></table></div>
      ${moreRows()}<p class="sr" data-invoice-status role="status"></p></div>` });
  const search = root.querySelector('[name="invoiceSearch"]');
  const typeFilter = root.querySelector('[name="invoiceType"]');
  const count = root.querySelector("[data-invoice-count]");
  const announce = root.querySelector("[data-invoice-status]");
  const empty = () => anyDocuments
    ? '<tr><td colspan="6" class="quiet">No documents in this period match the search. Clear the search or change the period in the top bar.</td></tr>'
    : `<tr><td colspan="6" class="quiet">No invoices in these books yet.${canWrite() ? ` <a href="${book}/gst-invoice">Create the first invoice</a>.` : ""}</td></tr>`;
  const rowMarkup = invoice => `<tr><td class="date-cell">${dateLabel(invoice.date)}</td><th scope="row"><a class="code" href="${book}/gst-document/${esc(invoice.id)}">${esc(invoice.number)}</a><small class="gst-detail">${esc(invoice.type)}</small></th><td>${esc(invoice.party?.name)}<small class="gst-detail">${invoice.party?.gstin ? `<span class="code">${esc(invoice.party.gstin)}</span>` : "Unregistered"}</small></td><td class="figure">${money(invoice.taxablePaise)}</td><td class="figure">${money(invoice.taxPaise)}</td><td class="figure">${money(invoice.amountDuePaise)}</td></tr>`;
  const onPaint = state => {
    const totals = state.data?.totals || {};
    const label = `${state.total.toLocaleString("en-IN")} document${state.total === 1 ? "" : "s"}`;
    count.textContent = `Total of ${label}`;
    root.querySelector("[data-total-taxable]").textContent = formatINR(totals.taxablePaise || 0);
    root.querySelector("[data-total-tax]").textContent = formatINR(totals.taxPaise || 0);
    root.querySelector("[data-total-due]").textContent = formatINR(totals.amountDuePaise || 0);
    announce.textContent = label;
  };
  const pager = serverPagedTable({ table: root.querySelector(".gst-register-table"), first, rowHtml: rowMarkup, onPaint, noun: "documents",
    prefix: shown => shown.length ? "" : empty(),
    load: (offset, limit) => api(address({ offset, limit })),
    loadAll: () => api(address()) });
  /* A filter asks the server again from the first page; the latest request wins. */
  const apply = () => {
    filters.type = typeFilter.value;
    filters.q = search.value.trim();
    pager.reset();
  };
  let searchTimer;
  search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(apply, 250); });
  typeFilter.addEventListener("change", () => { clearTimeout(searchTimer); apply(); });
  bindPeriod(company);
  return true;
}

export async function viewGst(route, token, ui) {
  if (!GST_ROUTES.has(route.name)) return false;
  const { root, api, still, page, esc, readPeriod, periodBar, bindPeriod } = ui;
  if (!route.id) throw new Error("Open a company to use billing");
  if (route.name === "gst-register") return viewRegister(route, token, ui);
  const base = `/api/companies/${encodeURIComponent(route.id)}/gst`;
  const state = await api(base);
  if (!still(token)) return true;
  const { company, registrations = [], parties = [], items = [], invoices = [], states = [] } = state;
  const book = `#/c/${encodeURIComponent(company.id)}`;
  const money = value => esc(formatINR(value || 0));
  const flashKey = `financer-gst-flash:${company.id}`;
  const stateName = code => {
    const found = states.find(row => row.code === code);
    return found ? `${found.name} (${found.code})` : code || "—";
  };
  const stateOptions = selected => '<option value="">Choose a state or territory</option>' + states.map(row => `<option value="${esc(row.code)}"${row.code === selected ? " selected" : ""}>${esc(row.name)} (${esc(row.code)})</option>`).join("");
  const registrationOptions = () => registrations.map(row => `<option value="${esc(row.id)}">${esc(row.name || row.legalName)} (${esc(row.gstin)})</option>`).join("");
  const render = (title, body, folio = "Gs") => {
    const flash = sessionStorage.getItem(flashKey) || "";
    sessionStorage.removeItem(flashKey);
    document.title = `${title} · ${company.name}`;
    root.innerHTML = page({ company, kicker: "Billing", title, folio, status: flash, body: `<div class="gst-workspace">${body}</div>` });
  };
  const field = (name, label, value = "", options = "") => `<label>${label}<input name="${name}" value="${esc(value)}" ${options}></label>`;
  const addressField = (name = "address", label = "Address", value = "") => `<label class="wide">${label}<textarea name="${name}" rows="2">${esc(value)}</textarea></label>`;
  const formMessage = form => form.querySelector("[data-form-message]");
  const showError = (form, error) => {
    const target = formMessage(form);
    target.className = "form-message alert";
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
          for (const [name, value] of Object.entries(draft.values)) {
            const control = restored.elements[name];
            if (!control) continue;
            if (control.type === "checkbox") control.checked = true; else control.value = value;
          }
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
    const asOf = readPeriod(company).to || todayISO();
    const currentFY = Number(asOf.slice(0,4)) - (Number(asOf.slice(5,7)) < 4 ? 1 : 0);
    const message = '<p data-form-message class="form-message wide" role="alert"></p>';
    const turnoverSection = registrations.length ? `<details><summary>HSN reporting by financial year</summary>
        <form id="gst-turnover" class="form-grid">
        <label>Registration<select name="registrationId">${registrationOptions()}</select></label>
        ${field("year","Invoice financial year starts in",currentFY,'type="number" min="2017" max="2099" required')}
        <label class="wide">Preceding financial year’s aggregate turnover across this PAN<select name="band"><option value="unspecified">Not recorded</option><option value="up-to-5cr">Up to ₹5 crore</option><option value="above-5cr">Above ₹5 crore</option></select></label>
        <div class="wide actions"><button type="submit">Save turnover band</button></div>${message}</form></details>` : "";
    const irpSection = registrations.length ? `<details><summary>E-invoicing applicability</summary>
      ${state.irpPolicies?.length ? `<div class="table-scroll"><table><thead><tr><th>Registration</th><th>Effective from</th><th>Applicability</th></tr></thead><tbody>${state.irpPolicies.map(p => `<tr><td class="code">${esc(registrations.find(r=>r.id===p.registrationId)?.gstin)}</td><td class="date-cell">${dateLabel(p.effectiveFrom)}</td><td>${esc(({required:"Required",exempt:"Exempt","below-threshold":"Below threshold"})[p.status])}</td></tr>`).join("")}</tbody></table></div>` : ""}
      <form id="gst-irp-policy" class="form-grid"><label>Registration<select name="registrationId">${registrationOptions()}</select></label>
      ${field("effectiveFrom","Effective from",todayISO(),'type="date" required')}
      <label>Applicability<select name="status" required><option value="">Choose status</option><option value="required">E-invoicing required</option><option value="exempt">Exempt above threshold</option><option value="below-threshold">Below the applicable threshold</option></select></label>
      <label data-window hidden>IRP reporting window<select name="window"><option value="">Standard</option><option value="30">30 days</option></select></label>
      <label class="wide" data-declaration hidden>Rule 46(s) declaration for this registration<textarea name="declaration" maxlength="1200" rows="3"></textarea></label>
      <div class="wide actions"><button type="submit">Save applicability</button></div>${message}</form></details>` : "";
    const itemRows = items.map(item => `<tr><th scope="row"><button class="link gst-edit-master" type="button" data-edit-item="${esc(item.id)}" aria-label="Edit ${esc(item.name)}">${esc(item.name)}</button><small class="gst-detail">${esc(item.kind === "service" ? "Service" : "Goods")}</small>${item.kind === "goods" ? `<small class="gst-detail"><a href="${book}/stock-item/${encodeURIComponent(item.id)}">Stock ledger and costing</a></small>` : ""}</th><td class="code">${esc(item.hsnSac)}</td><td>${esc(item.unit)}</td><td class="gst-num">${item.kind === "goods" ? esc(state.inventory?.find(row => row.itemId === item.id)?.quantity || item.openingQuantity) : "—"}</td><td class="gst-num">${decimal(item.gstRateBps)}%</td><td class="figure">${money(item.pricePaise)}</td></tr>`).join("");
    const partyRows = parties.map(party => `<tr><th scope="row"><button class="link gst-edit-master" type="button" data-edit-party="${esc(party.id)}" aria-label="Edit ${esc(party.name)}">${esc(party.name)}</button>${compositionDealerPill(party)}${Number.isInteger(party.creditDays) ? `<small class="quiet">${party.creditDays === 1 ? "1 credit day" : `${party.creditDays} credit days`}</small>` : ""}</th><td>${party.gstin ? `<span class="code">${esc(party.gstin)}</span>` : '<span class="quiet">Unregistered</span>'}</td><td>${esc(stateName(party.stateCode))}</td><td>${esc(ROLES[party.kind] || party.kind)}</td></tr>`).join("");
    render("GST setup & catalog", `<section class="subsection"><h2>Business registration</h2>${registrations.length ? `<label class="gst-registration-choice">Registration<select data-registration-choice>${registrationOptions()}<option value="">Add another registration</option></select></label>` : `<p class="subsection-intro">Enter the GSTIN and address that will print on your invoices.</p>`}<form id="gst-registration" class="form-grid">
      <input type="hidden" name="id" value="${esc(registration.id || "")}">
      ${field("name", "Registration name", registration.name || company.name, 'required maxlength="80"')}
      ${field("legalName", "Legal business name", registration.legalName || company.name, 'required maxlength="120"')}
      ${field("gstin", "GSTIN", registration.gstin, 'required minlength="15" maxlength="15" autocapitalize="characters" spellcheck="false" class="code"')}
      <label>State or territory<select name="stateCode" required>${stateOptions(registration.stateCode)}</select></label>
      ${addressField("address", "Business address", registration.address)}
      ${field("pincode", "PIN code", registration.pincode, 'inputmode="numeric" pattern="[0-9]{6}" maxlength="6"')}
      ${field("phone", "Phone", registration.phone, 'type="tel" maxlength="30"')}
      ${field("email", "Email", registration.email, 'type="email" maxlength="120"')}
      ${field("invoicePrefix", "Invoice series prefix", registration.invoicePrefix || "", 'maxlength="4" pattern="[A-Za-z0-9]{1,4}" title="Up to 4 letters or digits"')}
      <div class="wide actions"><button type="submit">Save registration</button></div>${message}
    </form><div class="details-list">${turnoverSection}${irpSection}</div></section>
    <section class="subsection"><div class="section-title"><h2>Products & services</h2><span class="hint">${items.length} saved</span></div>
      <div class="table-scroll"><table><thead><tr><th>Name</th><th>HSN/SAC</th><th>Unit</th><th class="gst-num">Stock</th><th class="gst-num">GST rate</th><th class="figure">Price (₹)</th></tr></thead><tbody>${itemRows || '<tr><td colspan="6" class="quiet">Add a product or service below to reuse its HSN/SAC, unit and tax rate on invoices.</td></tr>'}</tbody></table></div>
      <div class="details-list"><details${items.length ? "" : " open"}><summary data-item-summary>Add a product or service</summary><form id="gst-item" class="form-grid"><input type="hidden" name="id" value="">
        ${field("name", "Item name", "", 'required maxlength="120"')}
        <label>Kind<select name="kind"><option value="goods">Goods</option><option value="service">Service</option></select></label>
        <div class="wide gst-hsn-search"><label>Search the HSN/SAC directory<input type="search" name="hsnSearch" placeholder="Code or description" autocomplete="off"></label><div data-hsn-results class="gst-hsn-results" role="group" aria-label="HSN/SAC results"></div><p data-hsn-message class="hint" role="status"></p><div data-hsn-pages class="book-toolbar"></div></div>
        ${field("hsnSac", "HSN/SAC code", "", 'required inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" title="4 to 8 digits" class="code"')}
        ${field("unit", "Unit (UQC)", "NOS", 'required maxlength="12"')}
        ${field("price", "Selling price (₹)", "0.00", 'required inputmode="decimal"')}
        ${field("purchasePrice", "Purchase price (₹)", "0.00", 'required inputmode="decimal"')}
        ${field("gstRate", "GST rate (%)", "0", 'required type="number" min="0" max="100" step="0.01"')}
        ${field("cessRate", "Cess rate (%)", "0", 'required type="number" min="0" max="1000" step="0.01"')}
        <label>Supply status<select name="supplyStatus">${statusOptions(state, esc, "taxable")}</select></label>
        ${field("openingQuantity", "Opening stock quantity", "0", 'required inputmode="decimal"')}
        <div class="wide actions"><button type="submit">Save item</button><button type="button" class="ghost" data-new-item>New item</button></div>${message}
      </form></details></div>
    </section>
    <section class="subsection"><div class="section-title"><h2>Customers & suppliers</h2><span class="hint">${parties.length} saved</span></div>
      <div class="table-scroll"><table><thead><tr><th>Name</th><th>GSTIN</th><th>State or territory</th><th>Role</th></tr></thead><tbody>${partyRows || '<tr><td colspan="4" class="quiet">Add a customer or supplier below before creating an invoice.</td></tr>'}</tbody></table></div>
      <div class="details-list"><details${parties.length ? "" : " open"}><summary data-party-summary>Add a customer or supplier</summary><form id="gst-party" class="form-grid"><input type="hidden" name="id" value="">
        ${field("name", "Party name", "", 'required maxlength="120"')}
        <label>Role<select name="kind"><option value="customer">Customer</option><option value="supplier">Supplier</option><option value="both">Customer and supplier</option></select></label>
        ${field("gstin", "GSTIN (leave empty if unregistered)", "", 'maxlength="15" autocapitalize="characters" spellcheck="false" class="code"')}
        <label>State or territory<select name="stateCode" required>${stateOptions("")}</select></label>
        ${addressField()}
        ${field("pincode", "PIN code", "", 'inputmode="numeric" pattern="[0-9]{6}" maxlength="6"')}
        ${field("phone", "Phone", "", 'type="tel" maxlength="30"')}
        ${field("email", "Email", "", 'type="email" maxlength="120"')}
        <label>Credit days (optional)<input name="creditDays" type="number" inputmode="numeric" min="0" max="3650" step="1"><span class="field-note">Due date for ageing is the document date plus these days</span></label>
        ${compositionDealerField()}
        <div class="wide actions"><button type="submit">Save party</button><button type="button" class="ghost" data-new-party>New party</button></div>${message}
      </form></details></div>
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
    bindMaster("#gst-party", "parties", form => ({ ...object(form), creditDays: form.get("creditDays") === "" ? null : Number(form.get("creditDays")), compositionDealer: compositionDealerValue(root.querySelector("#gst-party")) }), "Party saved.");
    bindMaster("#gst-item", "items", form => ({ id: form.get("id") || undefined, name: form.get("name"), kind: form.get("kind"), hsnSac: form.get("hsnSac"), unit: form.get("unit"), pricePaise: parseRupees(form.get("price")), purchasePricePaise: parseRupees(form.get("purchasePrice")), gstRateBps: rateBps(form.get("gstRate")), cessRateBps: rateBps(form.get("cessRate")), supplyStatus: form.get("supplyStatus"), openingQuantity: form.get("kind") === "goods" ? form.get("openingQuantity") : "0" }), "Item saved.");
    const itemSummary = root.querySelector("[data-item-summary]");
    const partySummary = root.querySelector("[data-party-summary]");
    for (const button of root.querySelectorAll("[data-edit-item]")) button.addEventListener("click", () => {
      const item = items.find(row => row.id === button.dataset.editItem);
      const form = root.querySelector("#gst-item");
      form.closest("details").open = true;
      itemSummary.textContent = `Edit ${item.name}`;
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
      partySummary.textContent = `Edit ${party.name}`;
      for (const name of ["id", "name", "kind", "gstin", "stateCode", "address", "pincode", "phone", "email", "creditDays"]) form.elements[name].value = party[name] ?? "";
      setCompositionDealer(form, party);
      form.elements.name.focus();
      form.scrollIntoView({ block: "center" });
    });
    root.querySelector("[data-new-item]").addEventListener("click", () => {
      const form = root.querySelector("#gst-item"); form.reset(); form.elements.openingQuantity.disabled = false; itemSummary.textContent = "Add a product or service"; form.elements.name.focus();
    });
    root.querySelector("[data-new-party]").addEventListener("click", () => { const form = root.querySelector("#gst-party"); form.reset(); setCompositionDealer(form, null); partySummary.textContent = "Add a customer or supplier"; form.elements.name.focus(); });
    root.querySelector('#gst-item [name="kind"]').addEventListener("change", event => {
      const opening = root.querySelector('#gst-item [name="openingQuantity"]');
      opening.disabled = event.target.value === "service";
      if (opening.disabled) opening.value = "0";
    });
    bindHsnLookup(root.querySelector("#gst-item"), api, esc, still, token);
    for (const form of root.querySelectorAll("form")) bindGstinState(form);
    return true;
  }

  if (route.name === "gst-document") {
    const { invoice, acknowledgement, irpStatus } = await api(`${base}/invoices/${encodeURIComponent(route.detail || "")}`);
    if (!still(token)) return true;
    const irpPrint = acknowledgement ? `<section class="gst-irp-print" aria-label="IRP acknowledgement">
      <img src="/api/companies/${encodeURIComponent(company.id)}/gst-exchange/${encodeURIComponent(invoice.id)}/qr.svg" alt="Signed QR code from the imported IRP acknowledgement">
      <dl class="kv"><dt>Invoice reference number</dt><dd class="code">${esc(acknowledgement.irn)}</dd><dt>Acknowledgement number</dt><dd class="code">${esc(acknowledgement.acknowledgementNumber)}</dd><dt>Acknowledgement date</dt><dd>${esc(dateLabel(acknowledgement.acknowledgementDate))}</dd></dl></section>` : "";
    const pending = irpStatus?.pending;
    const title = pending ? documentTitle(invoice) + " draft" : documentTitle(invoice);
    const docStatus = pending
      ? `<span class="pill warn">Awaiting IRN</span>${irpStatus.reportBy ? ` <span>Report to the IRP by ${esc(dateLabel(irpStatus.reportBy))}.</span>` : ""}`
      : acknowledgement ? '<span class="pill ok">IRP acknowledgement imported</span>' : '<span class="pill ok">Posted in books</span>';
    const links = [
      invoice.reverseCharge ? `<a class="button" href="${book}/gst-rcm">Review RCM payments and credit</a>` : "",
      invoice.direction === "sales" ? `<a class="button" href="${book}/gst-exchange/${esc(invoice.id)}">Prepare e-invoice and e-way bill</a>` : "",
    ].join("");
    render(title, `<div class="actions gst-toolbar"><button type="button" data-gst-print>Print ${esc(documentTitle(invoice).toLowerCase())}</button>${links}</div>${tallyInvoiceReferences(invoice,company.id,esc)}<p class="gst-filing-status">${docStatus}</p>${documentMarkup(invoice, { esc, money, stateName, irpPrint, title, declaration: irpStatus?.declaration || "" })}`, "In");
    root.querySelector("[data-gst-print]").addEventListener("click", () => window.print());
    return true;
  }

  await composeInvoice({ route, token, ui, state, base, book, render, field, addressField, stateOptions, registrationOptions, money, showError });
  return true;
}

function statusOptions(state, esc, selected) {
  const statuses = state.supportedStatuses || ["taxable", "exempt", "nil-rated", "non-gst", "zero-rated"];
  return statuses.map(status => {
    const value = typeof status === "string" ? status : status.id || status.value;
    const label = typeof status === "string" ? STATUS_NAMES[status] || status : status.name || status.label;
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
      results.innerHTML = value.items.map((row,index)=>`<button type="button" class="ghost" data-hsn-index="${index}"><span class="code">${esc(row.code)}</span><span>${esc(row.description)}</span></button>`).join("");
      results.scrollTop=0;
      message.textContent=value.total ? `${offset+1}–${offset+value.items.length} of ${value.total} matching codes` : "No matching codes in this category. Try a shorter word or the first digits of the code.";
      pages.innerHTML=[...(offset ? [[offset-size,"Previous codes"]] : []),...(offset+size<value.total ? [[offset+size,"Next codes"]] : [])].map(([next,label])=>`<button type="button" class="ghost" data-offset="${next}">${label}</button>`).join("");
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
        message.textContent=`Selected ${item.code}: ${item.description}`;
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

function controlLabel(control) {
  const aria = control.getAttribute("aria-label");
  if (aria) return aria;
  const label = control.labels?.[0];
  if (!label) return control.name || "Field";
  const copy = label.cloneNode(true);
  for (const nested of copy.querySelectorAll("input, select, textarea, small")) nested.remove();
  return copy.textContent.replace(/\s+/g, " ").trim() || control.name || "Field";
}

function controlProblem(control) {
  const v = control.validity;
  if (v.valueMissing) return control.type === "checkbox" ? "Tick to confirm." : control.tagName === "SELECT" ? "Choose one." : "Required.";
  if (v.badInput) return "Enter a number.";
  if (v.patternMismatch) return (control.title || "Check the format") + ".";
  if (v.rangeUnderflow) return `Use ${control.min} or more.`;
  if (v.rangeOverflow) return `Use ${control.max} or less.`;
  if (v.stepMismatch) return "Use up to two decimal places.";
  if (v.tooLong) return `Use ${control.maxLength} characters or fewer.`;
  if (v.tooShort) return `Use at least ${control.minLength} characters.`;
  if (v.typeMismatch) return "Check the format.";
  return control.validationMessage;
}

async function composeInvoice(context) {
  const { route, token, ui, state, base, book, render, field, addressField, stateOptions, registrationOptions, money, showError } = context;
  const { root, api, still, esc } = ui;
  const { company, registrations, parties, items, invoices } = state;
  const godowns = state.godowns?.length ? state.godowns : [{ id: "main", name: "Main Location" }];
  if (!registrations.length || !parties.length || !items.length) {
    const missing = [[registrations.length, "a business registration"], [parties.length, "a customer or supplier"], [items.length, "a product or service"]].filter(([count]) => !count).map(([, label]) => label);
    const list = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}` : missing[0];
    render("New invoice", `<p class="empty">Add ${esc(list)} in GST setup, then come back to create the invoice.</p><p class="actions"><a class="ink-link" href="${book}/gst">Open GST setup</a></p>`, "In");
    return;
  }
  const key = `financer-gst-draft:${company.id}`;
  const wantsRcm = new URLSearchParams(location.hash.split("?")[1] || "").get("rcm") === "true";
  let draft;
  try { draft = JSON.parse(localStorage.getItem(key) || "null"); } catch { draft = null; }
  let draftNote = draft ? "Saved draft restored" : "Draft saves on this Mac";
  /* The reverse-charge entry point wins over a forward-charge draft. That draft stays stored
     until this invoice is edited, so the person can still go back to it. */
  let setAsideDraft = false;
  if (draft && wantsRcm && draft.fields?.reverseCharge !== "true") {
    draft = null;
    setAsideDraft = true;
    draftNote = "Started a reverse-charge invoice. Your forward-charge draft is kept until you change this one.";
  }
  const freshLine = () => ({ itemId: "", godownId: godowns[0].id, quantity: "1", unitPrice: "0.00", discount: "0", gstRate: "0", cessRate: "0", supplyStatus: "taxable" });
  const initial = { type: "Sales", direction: "sales", registrationId: registrations[0].id, partyId: "", date: todayISO(), placeOfSupply: registrations[0].stateCode, pricing: "exclusive", supplyCategory: "domestic", exportMode: "lut", number: "", supplierInvoiceNumber: "", supplierInvoiceDate: "", originalInvoiceId: "", originalNumber: "", originalDate: "", shippingAddress: "", portCode: "", shippingBillNumber: "", shippingBillDate: "", destinationCountry: "", narration: "", itcEligibility: "pending", stockEffect: "none", reverseCharge: wantsRcm ? "true" : "false", rcmBasis: "", rcmReceiptDate: "", rcmSupplierDate: "", rcmSelfDate: "", rcmAssociated: "false", rcmConfirmed: "" };
  const fields = { ...initial, ...(draft?.fields || {}) };
  let lines = Array.isArray(draft?.lines) && draft.lines.length ? draft.lines : [freshLine()];
  const requestId = draft?.requestId || crypto.randomUUID();
  const select = (name, label, options) => `<label>${label}<select name="${name}">${options}</select></label>`;
  render("New invoice", `<form id="gst-compose" class="gst-compose">
    <div class="gst-draft-status"><span><span data-draft-status role="status">${esc(draftNote)}</span>${setAsideDraft ? ` <a href="${book}/gst-invoice" data-set-aside-draft>Return to the forward-charge draft</a>` : ""}</span><button type="button" class="danger" data-discard-draft>Clear draft</button></div>
    <div class="form-grid">
      ${select("type", "Document type", TYPES.map(type => `<option>${type}</option>`).join(""))}
      ${select("registrationId", "Business registration", registrationOptions())}
      <label>Customer or supplier<select name="partyId" required><option value="">Choose a party</option>${parties.map(row => `<option value="${esc(row.id)}">${esc(row.name)} (${row.gstin ? esc(row.gstin) : "unregistered"})</option>`).join("")}</select></label>
      ${field("date", "Document date", fields.date, `type="date" required min="${esc(company.booksFrom)}"`)}
      <label>Place of supply<select name="placeOfSupply" required>${stateOptions(fields.placeOfSupply)}</select></label>
      ${select("pricing", "Item prices", '<option value="exclusive">Tax exclusive</option><option value="inclusive">Tax inclusive</option>')}
      ${select("reverseCharge", "Tax responsibility", '<option value="false">Forward charge</option><option value="true">Reverse charge</option>')}
      ${field("number", "Document number (automatic when empty)", fields.number, `maxlength="16" pattern="${INVOICE_NUMBER_PATTERN}" title="${INVOICE_NUMBER_HINT}" autocapitalize="characters" spellcheck="false" class="code"`)}
      <label data-purchase-field hidden>Supplier invoice number<input name="supplierInvoiceNumber" maxlength="16" value="${esc(fields.supplierInvoiceNumber)}" class="code" spellcheck="false"></label>
      <label data-forward-purchase-date hidden>Supplier document date<input type="date" name="supplierInvoiceDate" value="${esc(fields.supplierInvoiceDate)}"><small class="field-note">Leave blank to use the posting date.</small></label>
      <label data-purchase-field hidden>Input tax credit review<select name="itcEligibility"><option value="pending">Pending review</option><option value="eligible">Eligible</option><option value="ineligible">Ineligible</option></select></label>
      <label data-note-field hidden>Stock treatment<select name="stockEffect"><option value="none">Financial adjustment only</option><option value="quantity">Goods return or quantity adjustment</option></select></label>
      <label data-note-field hidden>Note applies to<select name="direction"><option value="sales">Sales</option><option value="purchase">Purchases</option></select></label>
      <label data-note-field hidden>Original invoice<select name="originalInvoiceId"><option value="">Not in these books (enter its number and date)</option>${invoices.filter(row => row.type === "Sales" || row.type === "Purchase").map(row => `<option value="${esc(row.id)}">${esc(row.number)}, ${esc(row.party?.name)}, ${dateLabel(row.date)}</option>`).join("")}</select></label>
      <label data-note-field hidden>Original invoice number<input name="originalNumber" maxlength="16" value="${esc(fields.originalNumber)}" class="code" spellcheck="false"></label>
      <label data-note-field hidden>Original invoice date<input name="originalDate" type="date" value="${esc(fields.originalDate)}"></label>
      <fieldset data-rcm-fields hidden class="gst-rcm-facts"><legend>Reverse-charge facts</legend><div class="form-grid">
        <label class="wide">Applicable section and notification reference<input name="rcmBasis" value="${esc(fields.rcmBasis)}" maxlength="240"></label>
        <label class="wide check"><input type="checkbox" name="rcmConfirmed"><span>RCM applicability and the notification conditions have been reviewed for this supply.</span></label>
        <label data-rcm-inward>Supply received on<input type="date" name="rcmReceiptDate" value="${esc(fields.rcmReceiptDate)}"></label>
        <label data-rcm-inward>Supplier document date<input type="date" name="rcmSupplierDate" value="${esc(fields.rcmSupplierDate)}"></label>
        <label data-rcm-self>Recipient self-invoice date<input type="date" name="rcmSelfDate" value="${esc(fields.rcmSelfDate)}"></label>
        <label data-rcm-inward>Imported services from an associated enterprise<select name="rcmAssociated"><option value="false">No</option><option value="true">Yes</option></select></label>
        <p class="wide form-note">RCM supplier consideration excludes the recipient's tax. Liability, cash discharge and input-credit review are linked in the reverse charge workspace.</p>
      </div></fieldset>
    </div>
    <h2 class="gst-compose-heading">Items</h2>
    <div class="table-scroll"><table class="gst-entry-table"><thead><tr><th>Item</th><th class="gst-num">Quantity</th><th class="figure">Unit price (₹)</th><th class="gst-num">Discount (%)</th><th class="gst-num">GST (%)</th><th class="gst-num">Cess (%)</th><th>Supply status</th><th><span class="sr">Remove</span></th></tr></thead><tbody data-invoice-lines></tbody></table></div>
    <div class="actions"><button type="button" class="ghost" data-add-item>Add item</button></div>
    <div class="details-list gst-delivery"><details><summary>Delivery and export details</summary><div class="form-grid">
      ${select("supplyCategory", "Supply category", '<option value="domestic">Domestic</option><option value="export">Export</option><option value="sez">SEZ</option>')}
      <label data-export-field hidden>Export or SEZ tax treatment<select name="exportMode"><option value="lut">Under LUT or bond without payment of tax</option><option value="with-payment">With payment of integrated tax</option></select></label>
      <label data-customs-field hidden>Destination country code<input name="destinationCountry" maxlength="2" placeholder="US" value="${esc(fields.destinationCountry || "")}" class="code"></label>
      <label data-customs-field hidden>Customs port code<input name="portCode" maxlength="6" value="${esc(fields.portCode || "")}" class="code"></label>
      <label data-customs-field hidden>Shipping bill number<input name="shippingBillNumber" inputmode="numeric" pattern="[0-9]{3,7}" maxlength="7" title="3 to 7 digits, as printed on the shipping bill" value="${esc(fields.shippingBillNumber || "")}" class="code"></label>
      <label data-customs-field hidden>Shipping bill date<input type="date" name="shippingBillDate" value="${esc(fields.shippingBillDate || "")}"></label>
      ${addressField("shippingAddress", "Delivery address, if different", fields.shippingAddress)}
      ${addressField("narration", "Narration or terms", fields.narration)}
    </div></details></div>
    <h2 class="gst-compose-heading">Review and post</h2>
    <div class="gst-preview" data-invoice-preview aria-live="polite"><p class="quiet">Complete the invoice details to review the amounts.</p></div>
    <div class="attention-rule gst-checklist" data-invalid-list hidden></div>
    <div class="gst-post actions"><button type="submit" data-post-invoice disabled aria-keyshortcuts="Meta+Enter Control+Enter"><span data-post-label>Post invoice</span> <kbd aria-hidden="true">⌘↩</kbd></button></div>
    <p data-form-message class="form-message" role="alert"></p>
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
  const postLabel = form.querySelector("[data-post-label]");
  const previewTarget = form.querySelector("[data-invoice-preview]");
  const checklist = form.querySelector("[data-invalid-list]");
  let invalidControls = [];
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
      setAsideDraft = false;
      form.querySelector("[data-set-aside-draft]")?.remove();
      form.querySelector("[data-draft-status]").textContent = "Draft saved on this Mac";
    } catch {
      form.querySelector("[data-draft-status]").textContent = "Draft storage is full. Keep this page open until posting.";
    }
  };
  const linkedOriginal = () => form.elements.type.value.includes("Note") && invoices.find(invoice => invoice.id === form.elements.originalInvoiceId.value);
  const itemCode = item => item ? `<span class="code">${esc(item.hsnSac)}</span><span>${esc(item.unit || "Service")}</span>` : "";
  const drawLines = () => {
    const original = linkedOriginal();
    rows.innerHTML = lines.map((line, index) => {
      const historical = original && line.originalLineIndex !== undefined && line.originalLineIndex !== "" ? original.items[Number(line.originalLineIndex)] : null;
      const item = original ? historical : items.find(row => row.id === line.itemId);
      const n = index + 1;
      const selector = original
        ? `<select data-field="originalLineIndex" aria-label="Original invoice line ${n}" required><option value="">Choose the original invoice line</option>${original.items.map((source, i) => `<option value="${i}"${historical === source ? " selected" : ""}>Line ${i + 1}: ${esc(source.name)}, ${esc(source.quantity)} ${esc(source.unit || "")}, ${esc(decimal(source.gstRateBps))}%</option>`).join("")}</select><input type="hidden" data-field="itemId" value="${esc(historical?.itemId || "")}">`
        : `<select data-field="itemId" aria-label="Item ${n}" required><option value="">Choose an item</option>${items.map(row => `<option value="${esc(row.id)}"${line.itemId === row.id ? " selected" : ""}>${esc(row.name)}</option>`).join("")}</select>`;
      return `<tr data-line="${index}"><td>${selector}<small class="gst-item-code">${itemCode(item)}</small><label class="gst-line-godown"${item?.kind === "service" ? " hidden" : ""}>Godown<select data-field="godownId" aria-label="Godown ${n}"${item?.kind === "service" ? " disabled" : " required"}><option value="">Choose a godown</option>${godowns.map(location => `<option value="${esc(location.id)}"${(line.godownId ?? godowns[0].id) === location.id ? " selected" : ""}>${esc(location.name)}</option>`).join("")}</select></label></td>
        <td><input data-field="quantity" aria-label="Quantity ${n}" value="${esc(line.quantity)}" inputmode="decimal" required></td>
        <td class="figure"><input data-field="unitPrice" aria-label="Unit price ${n}" value="${esc(line.unitPrice)}" inputmode="decimal" required></td>
        <td><input data-field="discount" aria-label="Discount percent ${n}" value="${esc(line.discount)}" type="number" min="0" max="100" step="0.01" required></td>
        <td><input data-field="gstRate" aria-label="GST rate percent ${n}" value="${esc(line.gstRate)}" type="number" min="0" max="100" step="0.01" required></td>
        <td><input data-field="cessRate" aria-label="Cess rate percent ${n}" value="${esc(line.cessRate)}" type="number" min="0" max="1000" step="0.01" required></td>
        <td><select data-field="supplyStatus" aria-label="Supply status ${n}">${statusOptions(state, esc, line.supplyStatus)}</select></td>
        <td><button type="button" class="danger gst-remove" data-remove-item="${index}" aria-label="Remove item ${n}"${lines.length === 1 ? " disabled" : ""}>Remove</button></td></tr>`;
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
    form.querySelector("[data-forward-purchase-date]").hidden = !purchase || reverseCharge;
    form.elements.supplierInvoiceDate.disabled = !purchase || reverseCharge;
    form.elements.supplierInvoiceDate.max = form.elements.date.value;
    form.elements.number.maxLength = purchase && !reverseCharge ? 24 : 16;
    if (purchase && !reverseCharge) form.elements.number.removeAttribute("pattern");
    else form.elements.number.pattern = "[A-Za-z0-9/\\-]+";
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
    postLabel.textContent = note ? "Post note" : "Post invoice";
  };
  const payload = () => {
    const data = new FormData(form);
    const type = data.get("type");
    const quantityMovement = !type.includes("Note") || data.get("stockEffect") === "quantity";
    const entryLines = captureLines();
    return {
      type, direction: type.includes("Note") ? data.get("direction") : type === "Purchase" ? "purchase" : "sales",
      registrationId: data.get("registrationId"), partyId: data.get("partyId"), date: data.get("date"), placeOfSupply: data.get("placeOfSupply"), pricing: data.get("pricing"),
      number: data.get("number") || undefined, supplierInvoiceNumber: data.get("supplierInvoiceNumber") || undefined,
      ...(data.get("supplierInvoiceDate") ? { supplierInvoiceDate: data.get("supplierInvoiceDate") } : {}),
      originalInvoiceId: type.includes("Note") ? data.get("originalInvoiceId") || undefined : undefined,
      originalNumber: type.includes("Note") ? data.get("originalNumber") || undefined : undefined,
      originalDate: type.includes("Note") ? data.get("originalDate") || undefined : undefined,
      supplyCategory: data.get("supplyCategory"), exportMode: data.get("supplyCategory") === "domestic" ? undefined : data.get("exportMode"),
      ...(data.get("supplyCategory") === "export" ? {destinationCountry:data.get("destinationCountry"),portCode:data.get("portCode"),shippingBillNumber:data.get("shippingBillNumber"),shippingBillDate:data.get("shippingBillDate")} : {}),
      shippingAddress: data.get("shippingAddress"), narration: data.get("narration"), reverseCharge: data.get("reverseCharge") === "true", requestId,
      rcm: data.get("reverseCharge") === "true" ? { applicabilityConfirmed: form.elements.rcmConfirmed.checked, basisReference: data.get("rcmBasis"), receiptDate: data.get("rcmReceiptDate") || data.get("date"), supplierInvoiceDate: data.get("rcmSupplierDate") || data.get("date"), selfInvoiceDate: data.get("rcmSelfDate") || data.get("date"), associatedEnterprise: data.get("rcmAssociated") === "true" } : undefined,
      itcEligibility: data.get("itcEligibility"), stockEffect: type.includes("Note") ? data.get("stockEffect") : "quantity",
      ...(linkedOriginal() ? { originalLineMap: entryLines.map(line => line.originalLineIndex === "" ? null : Number(line.originalLineIndex)) } : {}),
      items: entryLines.map(line => ({ itemId: line.itemId, ...(quantityMovement && items.find(item => item.id === line.itemId)?.kind === "goods" ? { godownId: line.godownId } : {}), quantity: line.quantity, unitPricePaise: parseRupees(line.unitPrice), discountBps: rateBps(line.discount), gstRateBps: rateBps(line.gstRate), cessRateBps: rateBps(line.cessRate), supplyStatus: line.supplyStatus })),
    };
  };
  const setPreview = (markup, stateName) => {
    if (previewTarget.dataset.state === stateName && stateName !== "amounts") return;
    previewTarget.dataset.state = stateName;
    previewTarget.innerHTML = markup;
  };
  const markInvalid = () => {
    invalidControls = [];
    for (const control of form.elements) {
      if (!control.willValidate || control.type === "submit" || control.type === "button") continue;
      if (control.validity.valid) control.removeAttribute("aria-invalid");
      else { control.setAttribute("aria-invalid", "true"); invalidControls.push(control); }
    }
    checklist.hidden = !invalidControls.length;
    checklist.innerHTML = invalidControls.length ? `<p>${invalidControls.length === 1 ? "One field needs" : `${invalidControls.length} fields need`} attention before this can be posted. Choose a field to go to it.</p><ul>${invalidControls.map((control, index) => `<li><button type="button" class="link" data-focus-invalid="${index}">${esc(controlLabel(control))}</button> <span class="hint">${esc(controlProblem(control))}</span></li>`).join("")}</ul>` : "";
    return invalidControls.length === 0;
  };
  const preview = async () => {
    clearTimeout(previewTimer);
    const current = ++sequence;
    postButton.disabled = true;
    if (!markInvalid()) {
      setPreview('<p class="quiet">Complete the fields listed below to review the amounts.</p>', "incomplete");
      return;
    }
    try {
      await prepareRcm();
      const { invoice } = await api(`${base}/preview`, { method: "POST", body: payload() });
      if (!still(token) || current !== sequence || posting) return;
      const tax = invoice.totals;
      setPreview(`<p class="gst-preview-number">Document number <strong class="code">${esc(invoice.number)}</strong></p><dl class="doc-totals gst-preview-breakdown"><div><dt>Taxable value</dt><dd>₹ ${money(tax.taxablePaise)}</dd></div>${COMPONENTS.filter(([, key]) => tax[key]).map(([name, key]) => `<div><dt>${name}</dt><dd>₹ ${money(tax[key])}</dd></div>`).join("")}<div class="doc-total gst-preview-total"><dt>${invoice.reverseCharge ? "Party amount due" : "Document total"}</dt><dd>₹ ${money(invoice.partyDuePaise ?? tax.totalPaise)}</dd></div></dl>`, "amounts");
      postButton.disabled = false;
    } catch (error) {
      if (still(token) && current === sequence) setPreview(`<p class="form-message alert">${esc(error.message)}</p>`, "error:" + error.message);
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
    if (input.dataset.field === "originalLineIndex") {
      const historical = input.value !== "" && linkedOriginal()?.items[Number(input.value)];
      const row = input.closest("tr");
      row.querySelector('[data-field="itemId"]').value = historical?.itemId || "";
      if (historical) {
        row.querySelector('[data-field="unitPrice"]').value = rupees(historical.unitPricePaise);
        row.querySelector('[data-field="discount"]').value = decimal(historical.discountBps);
        row.querySelector('[data-field="gstRate"]').value = decimal(historical.gstRateBps);
        row.querySelector('[data-field="cessRate"]').value = decimal(historical.cessRateBps);
        row.querySelector('[data-field="supplyStatus"]').value = historical.supplyStatus;
        row.querySelector(".gst-item-code").innerHTML = itemCode(historical);
      }
    }
    if (input.dataset.field === "itemId") {
      const item = items.find(row => row.id === input.value);
      if (item) {
        const row = input.closest("tr");
        const purchase = form.elements.type.value === "Purchase" || (form.elements.type.value.includes("Note") && form.elements.direction.value === "purchase");
        row.querySelector('[data-field="unitPrice"]').value = rupees(purchase ? item.purchasePricePaise ?? item.pricePaise : item.pricePaise);
        row.querySelector('[data-field="gstRate"]').value = decimal(item.gstRateBps);
        row.querySelector('[data-field="cessRate"]').value = decimal(item.cessRateBps);
        row.querySelector('[data-field="supplyStatus"]').value = item.supplyStatus;
        row.querySelector(".gst-item-code").innerHTML = itemCode(item);
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
        form.elements.supplyCategory.value = original.supplyCategory;
        if (original.exportMode) form.elements.exportMode.value = original.exportMode;
        form.elements.originalNumber.value = original.supplierInvoiceNumber || original.number;
        form.elements.originalDate.value = original.supplierInvoiceDate || original.date;
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
    if (input.name === "type" || input.name === "originalInvoiceId") {
      lines = captureLines();
      const original = linkedOriginal();
      for (const line of lines) {
        delete line.originalLineIndex;
        if (!original) continue;
        const matches = original.items.flatMap((source, i) => source.itemId === line.itemId ? [i] : []);
        if (matches.length === 1) {
          const index = matches[0], source = original.items[index];
          Object.assign(line, { originalLineIndex: String(index), gstRate: decimal(source.gstRateBps), cessRate: decimal(source.cessRateBps), supplyStatus: source.supplyStatus });
        }
      }
      drawLines();
    }
    conditionalFields();
    remember();
    schedulePreview();
  });
  form.querySelector("[data-add-item]").addEventListener("click", () => {
    lines = captureLines(); lines.push(freshLine()); drawLines(); conditionalFields(); remember(); schedulePreview();
    rows.lastElementChild.querySelector("select").focus();
  });
  rows.addEventListener("click", event => {
    const button = event.target.closest("[data-remove-item]");
    if (!button || lines.length === 1) return;
    const index = Number(button.dataset.removeItem);
    lines = captureLines();
    const item = items.find(row => row.id === lines[index]?.itemId);
    if (item && !window.confirm(`Remove item ${index + 1}, ${item.name}, from this invoice?`)) return;
    lines.splice(index, 1); drawLines(); conditionalFields(); remember(); schedulePreview();
    (rows.children[Math.min(index, rows.children.length - 1)]?.querySelector("select") || form.querySelector("[data-add-item]")).focus();
  });
  const revealControl = control => {
    for (let details = control.closest("details"); details; details = details.parentElement?.closest("details")) details.open = true;
    control.focus({ preventScroll: true });
    control.scrollIntoView({ block: "center" });
  };
  checklist.addEventListener("click", event => {
    const button = event.target.closest("[data-focus-invalid]");
    const control = button && invalidControls[Number(button.dataset.focusInvalid)];
    if (!control) return;
    form.dataset.attempted = "true";
    revealControl(control);
  });
  form.querySelector("[data-discard-draft]").addEventListener("click", async () => {
    const question = setAsideDraft
      ? "Clear the saved forward-charge invoice draft? Its party, items and amounts will be removed from this Mac."
      : "Clear this invoice draft? The party, items and amounts entered here will be removed from this Mac.";
    if (!window.confirm(question)) return;
    clearTimeout(previewTimer); ++sequence;
    localStorage.removeItem(key);
    await viewGst(route, token, ui);
  });
  const focusable = () => [...form.querySelectorAll("input, select, textarea, button, summary")].filter(control => !control.disabled && control.tabIndex >= 0 && control.type !== "hidden" && control.getClientRects().length);
  form.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing) return;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      if (posting) return;
      if (!postButton.disabled) { form.requestSubmit(); return; }
      /* The shortcut cannot post yet: take the person to the first field that is holding it back. */
      if (!markInvalid()) { form.dataset.attempted = "true"; revealControl(invalidControls[0]); }
      return;
    }
    /* Plain Enter moves to the next field instead of posting the invoice by implicit submission. */
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    event.preventDefault();
    const order = focusable();
    const next = order[order.indexOf(target) + (event.shiftKey ? -1 : 1)];
    next?.focus();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (posting || postButton.disabled) return;
    if (!form.reportValidity()) { form.dataset.attempted = "true"; markInvalid(); return; }
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
  if (invoice.type === "Credit Note" || invoice.type === "Debit Note") return invoice.type.charAt(0) + invoice.type.slice(1).toLowerCase();
  return invoice.items.every(row => row.supplyStatus === "exempt" || row.supplyStatus === "nil-rated" || row.supplyStatus === "non-gst") ? "Bill of supply" : "Tax invoice";
}

function documentMarkup(invoice, helpers) {
  const { esc, money, stateName } = helpers;
  const registration = invoice.registration || {};
  const party = invoice.party || {};
  const purchase = invoice.direction === "purchase" || invoice.type === "Purchase";
  const selfInvoice = Boolean(invoice.rcm?.selfInvoiceRequired);
  const note = invoice.type === "Credit Note" || invoice.type === "Debit Note";
  const supplier = purchase ? party : registration;
  const recipient = purchase ? registration : party;
  const totals = invoice.totals || {};
  const issuer = selfInvoice ? recipient : supplier;
  const components = COMPONENTS.filter(([, key]) => totals[key]);
  const showDiscount = invoice.items.some(row => row.discountPaise);
  const legal = entity => entity.legalName || entity.name || "";
  const block = (heading, entity) => {
    const lines = String(entity.address || "").split(/\n+/).map(line => line.trim()).filter(Boolean);
    if (entity.pincode && lines.length) lines[lines.length - 1] += ` ${entity.pincode}`;
    else if (entity.pincode) lines.push(`PIN ${entity.pincode}`);
    return `<section><h2>${heading}</h2>
      <p><strong>${esc(legal(entity))}</strong></p>
      ${entity.legalName && entity.name && entity.name !== entity.legalName ? `<p>Trading as ${esc(entity.name)}</p>` : ""}
      ${lines.map(line => `<p>${esc(line)}</p>`).join("")}
      <p>${entity.gstin ? `GSTIN <span class="code">${esc(entity.gstin)}</span>` : "Not registered for GST"}</p>
      <p>State ${esc(stateName(entity.stateCode))}</p>
      ${entity.phone ? `<p>Phone ${esc(entity.phone)}</p>` : ""}
      ${entity.email ? `<p>${esc(entity.email)}</p>` : ""}
    </section>`;
  };
  const head = [
    [note ? "Note number" : purchase && !selfInvoice ? "Record number" : "Invoice number", `<strong class="code">${esc(invoice.number)}</strong>`],
    [note ? "Note date" : "Invoice date", `<strong class="gst-plain">${dateLabel(invoice.date)}</strong>`],
    purchase && !selfInvoice ? [invoice.type === "Credit Note" ? "Supplier credit note" : invoice.type === "Debit Note" ? "Supplier debit note" : "Supplier invoice", `<strong class="code">${esc(invoice.supplierInvoiceNumber || invoice.number)}</strong>`] : null,
    purchase && !selfInvoice && invoice.supplierInvoiceDate ? ["Supplier document date", `<strong class="gst-plain">${dateLabel(invoice.supplierInvoiceDate)}</strong>`] : null,
    invoice.originalNumber || invoice.originalInvoiceId ? ["Against invoice", `<strong class="code">${esc(invoice.originalNumber || invoice.originalInvoiceId)}</strong>`] : null,
    invoice.originalDate ? ["Original invoice date", `<strong class="gst-plain">${dateLabel(invoice.originalDate)}</strong>`] : null,
    ["Place of supply", `<strong class="gst-plain">${esc(stateName(invoice.placeOfSupply))}</strong>`],
    ["Reverse charge", `<strong class="gst-plain">${invoice.reverseCharge ? "Yes" : "No"}</strong>`],
  ].filter(Boolean);
  let exportText = "";
  if (["export", "sez"].includes(invoice.supplyCategory)) {
    exportText = invoice.exportMode === "with-payment" ? "Supply meant for export / supply to SEZ unit or SEZ developer for authorised operations on payment of integrated tax" : "Supply meant for export / supply to SEZ unit or SEZ developer for authorised operations under bond or letter of undertaking without payment of integrated tax";
  }
  const customs = [
    ["Destination country", invoice.destinationCountry, true],
    ["Port code", invoice.portCode, true],
    ["Shipping bill number", invoice.shippingBillNumber, true],
    ["Shipping bill date", invoice.shippingBillDate && dateLabel(invoice.shippingBillDate), false],
  ].filter(([, value]) => value);
  const rate = (row, key) => key === "cessPaise" ? decimal(row.cessRateBps) : key === "igstPaise" ? decimal(row.gstRateBps) : String(row.gstRateBps / 200);
  const taxCells = row => components.map(([, key]) => row[key] ? `<td class="figure">${money(row[key])}<small class="gst-rate">${esc(rate(row, key))}%</small></td>` : '<td class="figure quiet">—</td>').join("");
  const itemRows = invoice.items.map((row, index) => `<tr><td class="gst-num">${index + 1}</td><th scope="row">${esc(row.name)}${row.supplyStatus && row.supplyStatus !== "taxable" ? `<small class="gst-detail">${esc(STATUS_NAMES[row.supplyStatus] || row.supplyStatus)}</small>` : ""}</th><td class="code">${esc(row.hsnSac)}</td><td class="gst-num">${amountOnlyService(invoice, index) ? "Amount only" : `${esc(row.quantity)} ${esc(row.unit || "")}`}</td><td class="figure">${amountOnlyService(invoice, index) ? '<span class="quiet">—</span>' : money(row.unitPricePaise)}</td>${showDiscount ? `<td class="figure">${money(row.discountPaise)}</td>` : ""}<td class="figure">${money(row.taxablePaise)}</td>${taxCells(row)}<td class="figure">${money(row.totalPaise)}</td></tr>`).join("");
  const columns = 7 + (showDiscount ? 1 : 0) + components.length;
  const totalRow = `<tr class="total"><th colspan="${showDiscount ? 6 : 5}" scope="row">Total</th><td class="figure">${money(totals.taxablePaise)}</td>${components.map(([, key]) => `<td class="figure">${money(totals[key])}</td>`).join("")}<td class="figure">${money(totals.totalPaise)}</td></tr>`;
  const payable = invoice.reverseCharge ? invoice.partyDuePaise : totals.totalPaise;
  return `<article class="doc gst-document">
    <header class="gst-doc-letterhead">
      <div><p class="gst-doc-issuer">${esc(legal(registration))}</p>${registration.legalName && registration.name && registration.name !== registration.legalName ? `<p>Trading as ${esc(registration.name)}</p>` : ""}</div>
      <h2 class="gst-doc-title">${esc(helpers.title || documentTitle(invoice))}</h2>
    </header>
    <div class="doc-head">${head.map(([label, value]) => `<div><span>${label}</span>${value}</div>`).join("")}</div>
    ${helpers.irpPrint || ""}
    ${exportText ? `<p class="doc-endorsement">${esc(exportText)}</p>` : ""}
    ${invoice.reverseCharge ? `<p class="doc-endorsement">Tax is payable by the recipient under reverse charge.${invoice.rcm?.basisReference ? ` ${esc(invoice.rcm.basisReference)}` : ""}</p>` : ""}
    <div class="doc-parties">${block(selfInvoice ? "Supplier (unregistered)" : "Supplier", supplier)}${block("Recipient", recipient)}</div>
    ${invoice.shippingAddress ? `<section class="gst-doc-delivery"><h2>Delivery address</h2>${String(invoice.shippingAddress).split(/\n+/).map(line => `<p>${esc(line)}</p>`).join("")}</section>` : ""}
    ${customs.length ? `<dl class="kv gst-doc-customs">${customs.map(([label, value, code]) => `<dt>${label}</dt><dd${code ? ' class="code"' : ""}>${esc(value)}</dd>`).join("")}</dl>` : ""}
    <div class="table-scroll"><table class="gst-doc-table"><thead><tr><th class="gst-num">No.</th><th>Description</th><th>HSN/SAC</th><th class="gst-num">Quantity</th><th class="figure">Rate (₹)</th>${showDiscount ? '<th class="figure">Discount (₹)</th>' : ""}<th class="figure">Taxable value (₹)</th>${components.map(([label]) => `<th class="figure">${label} (₹)</th>`).join("")}<th class="figure">${invoice.reverseCharge ? "Assessed value (₹)" : "Amount (₹)"}</th></tr></thead><tbody>${itemRows || `<tr><td colspan="${columns}" class="quiet">No items.</td></tr>`}</tbody><tfoot>${totalRow}</tfoot></table></div>
    <p class="hint gst-doc-pricing">Rates ${invoice.pricing === "inclusive" ? "include" : "exclude"} tax.</p>
    <div class="gst-doc-close">
      <div class="gst-doc-foot">
        <div class="gst-doc-notes"><p class="gst-doc-words"><span>Amount in words</span> ${esc(amountInWords(payable))}</p>${invoice.narration ? `<p class="gst-doc-terms"><span>Terms</span> ${esc(invoice.narration).replace(/\n/g, "<br>")}</p>` : ""}</div>
        <dl class="doc-totals"><div><dt>Taxable value</dt><dd>₹ ${money(totals.taxablePaise)}</dd></div>${components.map(([label, key]) => `<div><dt>${label}</dt><dd>₹ ${money(totals[key])}</dd></div>`).join("")}<div${invoice.reverseCharge ? "" : ' class="doc-total"'}><dt>${invoice.reverseCharge ? "Assessed value including RCM tax" : "Total"}</dt><dd>₹ ${money(totals.totalPaise)}</dd></div>${invoice.reverseCharge ? `<div class="doc-total"><dt>${purchase ? "Amount payable to supplier" : "Amount due from recipient"}</dt><dd>₹ ${money(invoice.partyDuePaise)}</dd></div>` : ""}</dl>
      </div>
      ${helpers.declaration ? `<p class="doc-endorsement">${esc(helpers.declaration)}</p>` : ""}
      <div class="doc-signature"><p>For ${esc(legal(issuer))}</p><span>Authorised signatory</span></div>
    </div>
  </article>`;
}
