import { formatINR, parseRupees, todayISO } from "/money.js";

const COMPONENTS = ["cgst", "sgst", "utgst", "igst", "cess"];
const LABELS = { "supplier-payment": "Supplier payment record", "supplier-refund": "Supplier refund record", "cash-deposit": "GST cash deposit", "cash-refund": "Unused GST cash refund", "tax-payment": "RCM tax discharge", "tax-refund": "RCM tax refund", "tax-recredit": "RCM tax recredit", "itc-claim": "Claim eligible RCM credit", "itc-reversal": "Reverse RCM credit", expense: "Recognise ineligible tax cost", "expense-reversal": "Reverse ineligible tax cost" };
const moneyTotal = (values = {}) => COMPONENTS.reduce((sum, component) => sum + (values[`${component}Paise`] || 0), 0);
const dateLabel = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.split("-").reverse().join("-") : value || "—";

export async function viewRcm(route, token, ui) {
  if (!["gst-rcm", "gst-rcm-document"].includes(route.name)) return false;
  const { root, api, still, page, esc } = ui;
  const to = new URLSearchParams(location.hash.split("?")[1] || "").get("to") || todayISO();
  const base = `/api/companies/${encodeURIComponent(route.id)}/gst/rcm`;
  const state = await api(`${base}?to=${encodeURIComponent(to)}`);
  if (!still(token)) return true;
  const { company, documents, invoices, records, banks, registrations, cash } = state;
  const book = `#/c/${encodeURIComponent(company.id)}`;
  const money = (amount) => esc(formatINR(amount || 0));
  const render = (title, body) => {
    document.title = `${title} · ${company.name}`;
    root.innerHTML = page({ company, title, folio: "Rc", kicker: "Reverse charge", body: `<div class="rcm-workspace">${body}</div>` });
  };

  if (route.name === "gst-rcm-document") {
    const record = records.find((entry) => entry.id === route.detail);
    const invoice = invoices.find((entry) => entry.id === record?.invoiceId);
    if (!record || !invoice) throw new Error("That RCM record is not in this review period");
    const supplierPayment = record.action === "supplier-payment";
    const title = supplierPayment ? "RCM payment voucher" : LABELS[record.action];
    const person = (entity) => `<strong>${esc(entity.legalName || entity.name)}</strong><p>${esc(entity.address || "").replace(/\n/g, "<br>")}</p><p>GSTIN ${esc(entity.gstin || "Unregistered")}</p>`;
    render(title, `<div class="actions"><a href="${book}/gst-rcm">Back to RCM</a><button type="button" data-rcm-print>Print record</button></div><article class="rcm-document"><div class="rcm-identity"><p><strong>${esc(record.number)}</strong></p><p>${dateLabel(record.documentDate || record.date)}</p></div><div class="two"><section><h2>Supplier</h2>${person(invoice.party)}</section><section><h2>Recipient</h2>${person(invoice.registration)}</section></div><p>Against ${esc(invoice.supplierInvoiceNumber || invoice.number)} · ${dateLabel(invoice.date)}</p><p>Place of supply ${esc(invoice.placeOfSupply)} · Reverse charge applies</p><table><thead><tr><th>Goods / services</th><th>HSN / SAC</th><th class="figure">GST rate</th><th class="figure">Cess rate</th></tr></thead><tbody>${invoice.items.map((item) => `<tr><th>${esc(item.name)}</th><td>${esc(item.hsnSac)}</td><td class="figure">${invoice.interState ? `IGST ${esc(String(item.gstRateBps / 100))}%` : `CGST ${esc(String(item.gstRateBps / 200))}% + ${invoice.utgst ? "UTGST" : "SGST"} ${esc(String(item.gstRateBps / 200))}%`}</td><td class="figure">${esc(String(item.cessRateBps / 100))}%</td></tr>`).join("")}</tbody></table><dl class="rcm-record-values"><div><dt>${supplierPayment ? "Amount paid to supplier" : "Recorded amount"}</dt><dd>₹ ${money(record.amountPaise)}</dd></div>${COMPONENTS.filter((component) => record.components[`${component}Paise`]).map((component) => `<div><dt>${component.toUpperCase()} ${supplierPayment ? "payable under RCM" : "recorded"}</dt><dd>₹ ${money(record.components[`${component}Paise`])}</dd></div>`).join("")}</dl><p>Reference ${esc(record.reference)}</p>${record.review ? `<p>ITC eligibility review ${esc(record.review.basis)}</p>` : ""}<p>${esc(invoice.rcm.basisReference)}</p><div class="rcm-signature"><p>For ${esc(invoice.registration.legalName || invoice.registration.name)}</p><span>Authorised signatory</span></div></article>`);
    root.querySelector("[data-rcm-print]").addEventListener("click", () => window.print());
    return true;
  }

  const reviews = documents.flatMap((document) => [
    moneyTotal(document.reversalRequired) ? `${document.number} requires an ITC reversal of ₹ ${formatINR(moneyTotal(document.reversalRequired))}.` : "",
    moneyTotal(document.expenseReversalRequired) ? `${document.number} requires an ineligible-cost reversal of ₹ ${formatINR(moneyTotal(document.expenseReversalRequired))}.` : "",
    moneyTotal(document.earlyTaxPaid) ? `${document.number} has ₹ ${formatINR(moneyTotal(document.earlyTaxPaid))} discharged before its calculated liability timing. Credit remains held for timing review.` : "",
    document.lateSelfInvoice ? `${document.number} records a self-invoice later than thirty days after receipt.` : "",
  ].filter(Boolean));
  const cashRows = registrations.map((registration) => `<tr><th>${esc(registration.name)}<small class="gst-detail">${esc(registration.gstin)}</small></th>${COMPONENTS.map((component) => `<td class="figure">${money(cash[registration.id]?.[`${component}Paise`])}</td>`).join("")}</tr>`).join("");
  const documentRows = documents.map((document) => `<tr><th><a href="${book}/gst-document/${esc(document.id)}">${esc(document.number)}</a><small class="gst-detail">${esc(document.partyName)}</small></th><td class="figure">${money(document.supplierDue)}${document.supplierOverpaid ? `<small class="gst-detail">Overpaid ${money(document.supplierOverpaid)}</small>` : ""}</td><td class="figure">${money(moneyTotal(document.netTax))}<small class="gst-detail">Due ${money(moneyTotal(document.statutoryDue))}</small></td><td class="figure">${money(moneyTotal(document.paid))}${moneyTotal(document.earlyTaxPaid) ? `<small class="gst-detail">Timing review ${money(moneyTotal(document.earlyTaxPaid))}</small>` : ""}</td><td class="figure">${money(moneyTotal(document.claimed))}</td><td class="figure">${money(moneyTotal(document.overpaid))}</td></tr>`).join("");
  render("Reverse charge", `<div class="actions"><a href="${book}/gst-invoice?rcm=true">New RCM invoice</a></div><form id="rcm-period" class="rcm-date"><label>Review as of<input type="date" name="to" value="${esc(to)}" required></label><button type="submit">Apply date</button></form>${reviews.length ? `<section class="rcm-review"><h2>Credit and timing review</h2><ul>${reviews.map((entry) => `<li>${esc(entry)}</li>`).join("")}</ul></section>` : ""}<h2>Inward RCM documents</h2><table><thead><tr><th>Document / supplier</th><th class="figure">Supplier due ₹</th><th class="figure">Assessed RCM ₹</th><th class="figure">Tax discharged ₹</th><th class="figure">ITC claimed ₹</th><th class="figure">Tax overpaid ₹</th></tr></thead><tbody>${documentRows || '<tr><td colspan="6">No inward RCM invoices at this date.</td></tr>'}</tbody></table><h2>Electronic cash controls</h2><table><thead><tr><th>Registration</th>${COMPONENTS.map((component) => `<th class="figure">${component.toUpperCase()}</th>`).join("")}</tr></thead><tbody>${cashRows || '<tr><td colspan="6">Save a GST registration to set up RCM ledgers.</td></tr>'}</tbody></table>${documents.length ? `<section class="rcm-entry"><h2>Record settlement or credit review</h2><form id="rcm-action" class="rcm-form"><label>Document<select name="invoiceId">${documents.map((document) => `<option value="${esc(document.id)}">${esc(document.number)} · ${esc(document.partyName)}</option>`).join("")}</select></label><label>Action<select name="action">${Object.entries(LABELS).map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join("")}</select></label><p data-action-help class="rcm-wide quiet"></p><label>Entry date<input type="date" name="date" required value="${esc(to)}" min="${esc(company.booksFrom)}"></label><label data-bank-field>Cash / bank ledger<select name="bankLedgerId">${banks.map((bank) => `<option value="${esc(bank.id)}">${esc(bank.name)}</option>`).join("")}</select></label><label data-supplier-field>Supplier amount ₹<input name="amount" inputmode="decimal" value="0.00"></label><label data-supplier-field>Bank debit date<input type="date" name="bankDebitDate" value="${esc(to)}"></label><label data-supplier-field class="rcm-wide rcm-check"><input type="checkbox" name="proRata">Apply this settlement proportionately across the document's taxable consideration.</label><div data-components class="rcm-wide rcm-components">${COMPONENTS.map((component) => `<label>${component.toUpperCase()} ₹<input name="${component}" value="0.00" inputmode="decimal"></label>`).join("")}</div><label class="rcm-wide">Payment, ledger debit or review reference<input name="reference" required maxlength="120"></label><label data-evidence-field>Total amount covered by this reference ₹<input name="evidenceTotal" inputmode="decimal" placeholder="Same as this entry when empty"></label><label data-discharge-field class="rcm-wide rcm-check"><input type="checkbox" name="discharged">The electronic cash ledger debit discharging this tax has been recorded.</label><label data-reversal-field class="rcm-wide">Reason for reversing ITC<select name="reversalReason"><option value="">Choose review classification</option><option value="credit-note">Credit note / assessment reduction</option><option value="permanent-ineligibility">Permanent ineligibility / blocked credit</option><option value="temporary-reversal">Temporary reversal</option><option value="time-barred">Time-barred credit · return classification review</option></select></label><fieldset data-itc-field class="rcm-wide"><legend>ITC eligibility review</legend><label class="rcm-check"><input type="checkbox" name="received">Goods or services have been received.</label><label class="rcm-check"><input type="checkbox" name="businessUse">The supply is used for eligible business purposes.</label><label class="rcm-check"><input type="checkbox" name="notBlocked">Section17 blocked-credit and apportionment conditions have been reviewed.</label><label class="rcm-check"><input type="checkbox" name="documentsHeld">The required invoice and tax-payment evidence are held.</label><label>Eligibility basis<input name="reviewBasis" maxlength="240"></label><label>Annual return filed on · if already filed<input type="date" name="annualReturnFiledDate"></label></fieldset><p data-action-message class="rcm-wide" role="status" aria-live="polite"></p><div class="actions rcm-wide"><button type="submit">Save bookkeeping entry</button></div></form></section>` : ""}<h2>Recorded RCM activity</h2><table><thead><tr><th>Date</th><th>Record</th><th>Action</th><th>Reference</th><th class="figure">Amount ₹</th></tr></thead><tbody>${records.slice().sort((a, b) => b.date.localeCompare(a.date) || b.sequence - a.sequence).map((record) => `<tr><td>${dateLabel(record.date)}</td><th><a href="${book}/gst-rcm-document/${esc(record.id)}">${esc(record.number)}</a></th><td>${esc(LABELS[record.action])}</td><td>${esc(record.reference)}</td><td class="figure">${money(record.amountPaise)}</td></tr>`).join("") || '<tr><td colspan="5">No RCM settlement or credit review records yet.</td></tr>'}</tbody></table>`);
  root.querySelector("#rcm-period").addEventListener("submit", (event) => { event.preventDefault(); location.hash = `${book.slice(1)}/gst-rcm?to=${event.currentTarget.elements.to.value}`; });
  const form = root.querySelector("#rcm-action");
  if (!form) return true;
  let requestId = crypto.randomUUID();
  const help = {
    "supplier-payment": "Records consideration paid to the supplier. The linked payment voucher retains the RCM tax details.",
    "supplier-refund": "Records a supplier refund against an overpaid document.",
    "cash-deposit": "Records a completed bank payment into the GST electronic cash controls.",
    "cash-refund": "Records unused GST cash returned to the bank.",
    "tax-payment": "Records the actual electronic cash ledger debit that discharged this RCM liability.",
    "tax-refund": "Records a completed government refund of overpaid RCM tax.",
    "tax-recredit": "Records an actual recredit of overpaid RCM tax into the electronic cash controls.",
    "itc-claim": "Moves paid, reviewed RCM tax from pending input tax into the input-credit accounts.",
    "itc-reversal": "Reverses previously claimed RCM credit back to pending review.",
    expense: "Moves pending tax into non-creditable purchase cost.",
    "expense-reversal": "Moves an earlier non-creditable tax cost back to pending review.",
  };
  const conditional = () => {
    const action = form.elements.action.value;
    const supplier = action.startsWith("supplier-");
    const bank = ["supplier-payment", "supplier-refund", "cash-deposit", "cash-refund", "tax-refund"].includes(action);
    for (const field of form.querySelectorAll("[data-bank-field]")) field.hidden = !bank;
    for (const field of form.querySelectorAll("[data-supplier-field]")) field.hidden = !supplier;
    form.querySelector("[data-components]").hidden = supplier;
    form.querySelector("[data-itc-field]").hidden = action !== "itc-claim";
    form.querySelector("[data-reversal-field]").hidden = action !== "itc-reversal";
    form.elements.reversalReason.required = action === "itc-reversal";
    form.querySelector("[data-discharge-field]").hidden = action !== "tax-payment";
    form.querySelector("[data-evidence-field]").hidden = ["itc-claim", "itc-reversal", "expense", "expense-reversal"].includes(action);
    form.elements.discharged.required = action === "tax-payment";
    form.elements.proRata.required = supplier;
    for (const name of ["received", "businessUse", "notBlocked", "documentsHeld", "reviewBasis"]) form.elements[name].required = action === "itc-claim";
    form.querySelector("[data-action-help]").textContent = help[action];
    const position = documents.find((document) => document.id === form.elements.invoiceId.value);
    if (action === "itc-reversal" && moneyTotal(position.reversalRequired)) form.elements.reversalReason.value = "credit-note";
    const suggested = action === "tax-payment" ? position.statutoryDue : action === "itc-claim" ? position.availableCredit : action === "itc-reversal" ? position.reversalRequired : action === "expense" ? position.pending : action === "expense-reversal" ? position.expenseReversalRequired : ["tax-refund", "tax-recredit"].includes(action) ? position.overpaid : position.due;
    for (const component of COMPONENTS) form.elements[component].value = formatINR(Math.max(0, suggested[`${component}Paise`] || 0));
    form.elements.amount.value = formatINR(action === "supplier-refund" ? position.supplierOverpaid : position.supplierDue);
  };
  form.elements.action.addEventListener("change", conditional);
  form.elements.invoiceId.addEventListener("change", conditional);
  form.addEventListener("input", () => { requestId = crypto.randomUUID(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const message = form.querySelector("[data-action-message]");
    button.disabled = true;
    message.className = "rcm-wide quiet";
    message.textContent = "Saving the linked bookkeeping entry…";
    try {
      const data = new FormData(form);
      const action = data.get("action");
      const input = {
        requestId, invoiceId: data.get("invoiceId"), date: data.get("date"), reference: data.get("reference"),
        bankLedgerId: data.get("bankLedgerId"), bankDebitDate: data.get("bankDebitDate") || undefined,
        allocationMethod: form.elements.proRata.checked ? "pro-rata" : undefined,
        amountPaise: action.startsWith("supplier-") ? parseRupees(data.get("amount")) : undefined,
        components: Object.fromEntries(COMPONENTS.map((component) => [`${component}Paise`, parseRupees(data.get(component))])),
        evidenceTotalPaise: data.get("evidenceTotal") ? parseRupees(data.get("evidenceTotal")) : undefined,
        reversalReason: action === "itc-reversal" ? data.get("reversalReason") : undefined,
        evidenceType: form.elements.discharged.checked ? "cash-ledger-debit" : undefined,
        review: action === "itc-claim" ? { received: form.elements.received.checked, businessUse: form.elements.businessUse.checked, notBlocked: form.elements.notBlocked.checked, documentsHeld: form.elements.documentsHeld.checked, basis: data.get("reviewBasis"), annualReturnFiledDate: data.get("annualReturnFiledDate") || undefined } : undefined,
      };
      const result = await api(`${base}/${action}`, { method: "POST", body: input });
      if (!still(token)) return;
      location.hash = `${book}/gst-rcm-document/${encodeURIComponent(result.record.id)}`;
    } catch (error) { message.className = "rcm-wide alert"; message.textContent = error.message; button.disabled = false; }
  });
  conditional();
  return true;
}
