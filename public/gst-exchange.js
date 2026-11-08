import { tallyInvoiceReferences } from "/tally-invoice-references.js";
import { formatINR } from "/money.js";

function dateLabel(value) {
  if (!value) return "—";
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.split("-").reverse().join("-") : value;
}

export async function viewGstExchange(route, token, ui) {
  if (route.name !== "gst-exchange") return false;
  const { root, api, still, page, esc } = ui;
  const base = `/api/companies/${encodeURIComponent(route.id)}/gst-exchange/${encodeURIComponent(route.detail)}`;
  const [state, { company }] = await Promise.all([api(base), api(`/api/companies/${encodeURIComponent(route.id)}/meta`)]);
  if (!still(token)) return true;
  const { invoice, history, capabilities } = state;
  const documentLink = `#/c/${encodeURIComponent(route.id)}/gst-document/${encodeURIComponent(invoice.id)}`;
  const draftKey = `financer-exchange-draft:${route.id}:${invoice.id}`;
  let preparation = state.preparation;
  let dirty = false;
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey) || "null");
    if (saved) { preparation = saved; dirty = true; }
  } catch { localStorage.removeItem(draftKey); }
  const stateName = code => {
    const found = state.states.find(value => value.code === code);
    return found ? `${found.name} (${found.code})` : code || "Not recorded";
  };
  const identifier = 'autocapitalize="characters" spellcheck="false" class="code"';
  const input = (section, field, label, options = "") => `<label>${label}<input name="${section}.${field}" value="${esc(preparation[section]?.[field] ?? "")}" ${options}></label>`;
  const address = (section, label, optional = false) => `<fieldset class="exchange-address"><legend>${label}</legend>
    ${optional ? `<label class="check"><input type="checkbox" name="${section}.enabled"${preparation[section]?.enabled ? " checked" : ""}><span>Use a different ${section === "dispatch" ? "dispatch" : "delivery"} address</span></label>` : ""}
    <div class="form-grid" data-address="${section}">
      ${input(section, "legalName", "Legal or location name", 'maxlength="100"')}
      ${input(section, "location", "Town or city", 'maxlength="50"')}
      ${input(section, "address1", "Address line 1", 'maxlength="100"')}
      ${input(section, "address2", "Address line 2", 'maxlength="100"')}
      ${input(section, "pincode", "PIN code", 'inputmode="numeric" minlength="6" maxlength="6"')}
      ${optional ? `<label>State or territory<select name="${section}.stateCode">${state.states.map(value => `<option value="${esc(value.code)}"${value.code === preparation[section]?.stateCode ? " selected" : ""}>${esc(value.name)} (${esc(value.code)})</option>`).join("")}</select></label>` : `<p class="exchange-fixed"><span>State or territory</span>${esc(stateName(preparation[section]?.stateCode))}</p>`}
      ${section === "ship" ? input(section, "gstin", "Delivery GSTIN, if registered", `maxlength="15" ${identifier}`) : ""}
    </div></fieldset>`;
  /* A file that cannot be built yet stays visible as a disabled secondary control with the reason beside it. */
  const download = (kind, title) => {
    const { ready, reason } = capabilities[kind];
    const reasonId = `exchange-${kind}-reason`;
    return `<div class="exchange-download">${ready
      ? `<a class="ink-link" data-download="${kind}" href="${base}/${kind}" download>${title}</a>`
      : `<a class="button ghost" data-download="${kind}" role="link" aria-disabled="true" aria-describedby="${reasonId}">${title}</a><p class="hint" id="${reasonId}">${esc(reason)}</p>`}</div>`;
  };
  const proofPill = record => record.trust === "signature-verified"
    ? '<span class="pill ok">Official production signature verified</span>'
    : record.signature?.status === "historical-signature-match"
      ? '<span class="pill ok">Historical official signature matches</span>'
      : '<span class="pill">Imported report</span>';
  const bindingText = record => record.binding === "submitted-request-with-reported-result"
    ? "Bound through the supplied submission file."
    : record.binding === "reported-document-details" ? "Bound through reported document details." : "Bound through the signed invoice payload.";
  const acknowledgementRows = history.acknowledgements.map(record => `<tr>
    <th scope="row">${record.kind === "irp" ? "IRP" : "E-way bill"}</th>
    <td><span class="code exchange-reference">${esc(record.reference)}</span>${record.acknowledgementNumber ? `<div class="quiet">Acknowledgement <span class="code">${esc(record.acknowledgementNumber)}</span>${record.acknowledgementDate ? ` dated ${esc(dateLabel(record.acknowledgementDate))}` : ""}</div>` : ""}</td>
    <td class="date-cell">${esc(dateLabel(record.importedAt))}</td>
    <td>${proofPill(record)}<div class="quiet">Invoice identifiers and amounts matched.</div><div class="quiet">${esc(bindingText(record))}</div>${record.rawSHA256 ? `<div class="quiet">Source file SHA-256 <span class="code exchange-reference">${esc(record.rawSHA256)}</span></div>` : ""}</td>
  </tr>`).join("");
  const versions = history.preparations.length;
  document.title = `E-invoice & e-way bill · ${invoice.number}`;
  root.innerHTML = page({ company, kicker: "Invoice exchange", folio: "Ex", title: "E-invoice & e-way bill", body: `
    <div class="actions"><a href="${documentLink}">Back to ${esc(invoice.number)}</a></div>
    ${tallyInvoiceReferences(invoice, route.id, esc)}
    <div class="summary-strip exchange-identity">
      <div><span>Invoice</span><strong class="code">${esc(invoice.number)}</strong></div>
      <div><span>Invoice date</span><strong>${esc(dateLabel(invoice.date))}</strong></div>
      <div><span>Invoice total</span><strong>₹ ${esc(formatINR(invoice.totals.totalPaise))}</strong></div>
    </div>
    <form id="exchange-preparation" class="exchange-form">
      ${address("seller", "Supplier")}${address("buyer", "Recipient")}
      ${address("dispatch", "Dispatch location", true)}${address("ship", "Delivery location", true)}
      <fieldset><legend>Transport</legend><div class="form-grid">
        <label>Mode<select name="transport.mode"><option value="1">Road</option><option value="2">Rail</option><option value="3">Air</option><option value="4">Ship</option></select></label>
        ${input("transport", "distanceKm", "Distance in km", 'type="number" min="0" max="4000" step="1"')}
        ${input("transport", "vehicleNo", "Vehicle number", `maxlength="15" ${identifier}`)}
        <label>Vehicle type<select name="transport.vehicleType"><option value="R">Regular</option><option value="O">Over-dimensional cargo</option></select></label>
        ${input("transport", "transporterId", "Transporter GSTIN or TRANSIN", `maxlength="15" ${identifier}`)}
        ${input("transport", "transporterName", "Transporter name", 'maxlength="100"')}
        ${input("transport", "documentNumber", "Transport document number", `maxlength="15" ${identifier}`)}
        ${input("transport", "documentDate", "Transport document date", 'type="date"')}
        <label class="check wide"><input type="checkbox" name="transport.partAOnly"${preparation.transport?.partAOnly ? " checked" : ""}><span>Prepare Part A for the transporter</span></label>
      </div></fieldset>
      ${invoice.supplyCategory === "export" ? `<fieldset><legend>Export details</legend><div class="form-grid">${input("export", "countryCode", "Destination country code", `maxlength="2" ${identifier}`)}${input("export", "portCode", "Port code", `maxlength="6" ${identifier}`)}${input("export", "shippingBillNumber", "Shipping bill number", `maxlength="7" ${identifier}`)}${input("export", "shippingBillDate", "Shipping bill date", 'type="date"')}</div></fieldset>` : ""}
      <div class="actions"><button type="submit">Save preparation</button><span class="quiet">${versions} saved version${versions === 1 ? "" : "s"}</span></div>
      <p class="form-message" data-preparation-message role="alert"></p>
    </form>
    <section class="subsection exchange-section"><h2>Prepare a submission file</h2>
      <p class="subsection-intro">Each file is built from the last saved preparation. Upload it on the government portal yourself.</p>
      <div class="exchange-downloads">${download("irp", "Download IRP bulk JSON")}${download("ewaybill", state.movementMode === "combined" ? "Download IRP invoice with e-way bill details" : state.movementMode === "by-irn" ? "Download e-way bill by IRN JSON" : "Download NIC e-way bill API JSON")}</div>
    </section>
    <section class="subsection exchange-section"><h2>Import the official result</h2>
      <form id="exchange-acknowledgement" class="exchange-form"><div class="form-grid">
        <label>Result type<select name="kind"><option value="irp">IRP signed invoice result</option><option value="ewaybill">NIC e-way bill result</option></select></label>
        <label>Result JSON file<input type="file" name="result" accept=".json,application/json" required></label>
        <label class="wide">Submitted e-way bill request, when the result omits invoice details<input type="file" name="submittedRequest" accept=".json,application/json"></label>
      </div><div class="actions"><button type="submit">Import acknowledgement</button></div><p data-ack-message class="form-message" role="alert"></p></form>
      ${history.acknowledgements.length
        ? `<div class="table-scroll exchange-table"><table><thead><tr><th>Type</th><th>Reference</th><th>Imported</th><th>Evidence</th></tr></thead><tbody>${acknowledgementRows}</tbody></table></div>`
        : '<p class="empty">No acknowledgement imported yet. Choose the result file from the portal above to import it.</p>'}
    </section>
    <div class="details-list exchange-registry"><details><summary>Signature registry and file formats</summary>
      <p>Signature checks use production certificates bundled from the official IRP registry. Imported reports keep their original JSON and their invoice binding.</p>
      <ul class="exchange-list">${state.signingRegistry.map(record => `<li><span class="code">${esc(record.id)}</span>. Certificate expires on ${esc(dateLabel(new Date(record.validTo).toISOString()))}. <a href="${esc(record.source)}" target="_blank" rel="noreferrer">Official signing-key registry</a></li>`).join("")}</ul>
      <ul class="exchange-list"><li><a href="${esc(state.sources.irp)}" target="_blank" rel="noreferrer">IRP schema 1.1</a></li><li><a href="${esc(state.sources.ewaybill)}" target="_blank" rel="noreferrer">NIC e-way bill API 1.03</a></li></ul>
    </details></div>` });
  const form = root.querySelector("#exchange-preparation");
  form.elements["transport.mode"].value = preparation.transport?.mode || "1";
  form.elements["transport.vehicleType"].value = preparation.transport?.vehicleType || "R";
  const showMessage = (target, text) => {
    target.className = "form-message alert";
    target.textContent = text;
    target.scrollIntoView({ block: "nearest" });
  };
  const readForm = () => {
    const values = Object.fromEntries(new FormData(form));
    const result = {};
    for (const section of ["seller", "buyer", "dispatch", "ship", "transport", "export"]) {
      result[section] = { ...(preparation[section] || {}) };
      for (const [key, value] of Object.entries(values)) if (key.startsWith(`${section}.`)) result[section][key.slice(section.length + 1)] = value;
    }
    for (const section of ["dispatch", "ship"]) result[section].enabled = form.elements[`${section}.enabled`].checked;
    result.transport.partAOnly = form.elements["transport.partAOnly"].checked;
    result.transport.distanceKm = Number(result.transport.distanceKm);
    return result;
  };
  const updateAddresses = () => {
    for (const section of ["dispatch", "ship"]) {
      const enabled = form.elements[`${section}.enabled`].checked;
      root.querySelector(`[data-address="${section}"]`).hidden = !enabled;
    }
  };
  updateAddresses();
  const remember = () => {
    dirty = true;
    localStorage.setItem(draftKey, JSON.stringify(readForm()));
    updateAddresses();
  };
  form.addEventListener("input", remember);
  form.addEventListener("change", remember);
  for (const link of root.querySelectorAll("[data-download]")) link.addEventListener("click", event => {
    /* Unsaved edits come first: saving them may be what makes an unavailable file ready. */
    if (!dirty) { if (link.getAttribute("aria-disabled") === "true") event.preventDefault(); return; }
    event.preventDefault();
    showMessage(root.querySelector("[data-preparation-message]"), "Save the current preparation before downloading its submission file.");
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const fields = readForm();
    const controls = [...form.elements].filter(control => !control.disabled);
    for (const control of controls) control.disabled = true;
    const message = root.querySelector("[data-preparation-message]");
    try {
      await api(base, { method: "PUT", body: fields });
      localStorage.removeItem(draftKey);
      if (still(token)) await viewGstExchange(route, token, ui);
    } catch (error) {
      for (const control of controls) control.disabled = false;
      showMessage(message, error.message);
    }
  });
  const acknowledgementForm = root.querySelector("#exchange-acknowledgement");
  acknowledgementForm.addEventListener("submit", async event => {
    event.preventDefault();
    const button = acknowledgementForm.querySelector("button");
    if (button.disabled) return;
    button.disabled = true;
    const message = root.querySelector("[data-ack-message]");
    try {
      const resultFile = acknowledgementForm.elements.result.files[0];
      const submissionFile = acknowledgementForm.elements.submittedRequest.files[0];
      if (!resultFile || resultFile.size + (submissionFile?.size || 0) > 900000) throw new Error("Choose JSON files totalling at most 900 KB");
      const result = JSON.parse(await resultFile.text());
      const submittedRequest = submissionFile ? JSON.parse(await submissionFile.text()) : undefined;
      await api(`${base}/acknowledgements`, { method: "POST", body: { kind: acknowledgementForm.elements.kind.value, result, submittedRequest } });
      if (still(token)) await viewGstExchange(route, token, ui);
    } catch (error) {
      button.disabled = false;
      showMessage(message, error instanceof SyntaxError ? "The selected file contains invalid JSON. Choose the result file exactly as the portal provided it." : error.message);
    }
  });
  return true;
}
