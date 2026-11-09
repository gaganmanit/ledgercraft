import { formatINR } from "/money.js";
import { installTallyGstReview } from "/tally-gst-ui.js";

const TYPE_NAMES = { LEDGER: "Ledgers & contacts", GROUP: "Account groups", VOUCHER: "Vouchers", STOCKITEM: "Stock items & HSN", STOCKGROUP: "Stock groups", STOCKCATEGORY: "Stock categories", UNIT: "Units", GODOWN: "Godowns", COSTCENTRE: "Cost centres", COSTCATEGORY: "Cost categories", VOUCHERTYPE: "Voucher types", COMPANY: "Company" };
const STATUS_NAMES = { voucher: "Posted", ledger: "Ledger", group: "Group", "reference-master": "Source master", "mapped-reserved-group": "Standard group", nonposting: "Retained without posting", "duplicate-source": "Identical source copy", exception: "Needs review" };
const STATUS_TONES = { voucher: "ok", exception: "bad" };
const FIELD_NAMES = { NAME: "Name", PARENT: "Under", DATE: "Date", VOUCHERTYPENAME: "Voucher type", VOUCHERNUMBER: "Voucher number", EFFECTIVEDATE: "Effective date", NARRATION: "Narration", PARTYLEDGERNAME: "Party ledger", PARTYGSTIN: "Party GSTIN", PLACEOFSUPPLY: "Place of supply", GSTREGISTRATIONTYPE: "GST registration type", PARTYMAILINGNAME: "Party mailing name", PARTYSTATENAME: "Party state", COUNTRYNAME: "Country", LEDSTATENAME: "State", STATENAME: "State", PINCODE: "PIN code", EMAIL: "Email", LEDGERPHONE: "Phone", LEDGERMOBILE: "Mobile", INCOMETAXNUMBER: "PAN", OPENINGBALANCE: "Opening balance", OPENINGVALUE: "Opening value", OPENINGRATE: "Opening rate", BASEUNITS: "Base unit", ADDITIONALUNITS: "Additional unit", CONVERSION: "Conversion", ISSIMPLEUNIT: "Simple unit", DECIMALPLACES: "Decimal places", CATEGORY: "Category", GUID: "GUID", MASTERID: "Master ID", ALTERID: "Alteration ID", REFERENCE: "Reference", REFERENCEDATE: "Reference date", ISCANCELLED: "Cancelled", ISOPTIONAL: "Optional", ISPOSTDATED: "Post-dated", STOCKITEMNAME: "Stock item", ACTUALQTY: "Actual quantity", BILLEDQTY: "Billed quantity", RATE: "Rate", AMOUNT: "Amount", ISDEEMEDPOSITIVE: "Debit flag", GODOWNNAME: "Godown", DESTINATIONGODOWNNAME: "Destination godown", BATCHNAME: "Batch", ORDERNO: "Order number", TRACKINGNUMBER: "Tracking number", LEDGERNAME: "Ledger", GSTCLASS: "GST class", GSTNATURE: "GST nature", BILLTYPE: "Bill type", BILLDATE: "Bill date", ISADVANCE: "Advance flag", BILLCREDITPERIOD: "Credit period", DUEDATE: "Due date", BANKNAME: "Bank", TRANSACTIONTYPE: "Transaction type", PAYMENTFAVOURING: "Favouring", INSTRUMENTNUMBER: "Instrument number", INSTRUMENTDATE: "Instrument date", BANKPARTYNAME: "Bank party", UNIQUEREFERENCENUMBER: "Unique reference", BANKACCOUNTNUMBER: "Bank account", IFSCODE: "IFSC", APPLICABLEFROM: "Applicable from", HSNCODE: "HSN", HSN: "HSN", TAXABILITY: "Taxability", GSTREGISTRATIONNUMBER: "GSTIN", GSTIN: "GSTIN", GSTRATEDUTYHEAD: "Tax head", GSTRATE: "Tax rate" };
/* Source fields people compare character by character, and source fields that carry amounts. */
const CODE_FIELDS = new Set(["VOUCHERNUMBER", "PARTYGSTIN", "INCOMETAXNUMBER", "GUID", "MASTERID", "ALTERID", "REFERENCE", "INSTRUMENTNUMBER", "UNIQUEREFERENCENUMBER", "BANKACCOUNTNUMBER", "IFSCODE", "HSNCODE", "HSN", "GSTREGISTRATIONNUMBER", "GSTIN", "ORDERNO", "TRACKINGNUMBER", "IRN", "IRNACKNO", "EWAYBILLNUMBER", "TRANSPORTERID", "TRANSPORTDOCNO", "VEHICLENUMBER"]);
const FIGURE_FIELDS = new Set(["AMOUNT", "OPENINGBALANCE", "OPENINGVALUE", "OPENINGRATE", "RATE"]);
const fileBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",")[1]);
  reader.onerror = () => reject(new Error(`Could not read ${file.name}. Choose the file again.`));
  reader.readAsDataURL(file);
});
/* Dates shown to people are dd-mm-yyyy. Tally writes source dates as yyyymmdd; Ledgercraft as yyyy-mm-dd. */
const dateLabel = (value) => {
  const text = String(value ?? "");
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) || /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  return iso ? `${iso[3]}-${iso[2]}-${iso[1]}` : text || "—";
};
/* Source fields that hold a date (DATE, BILLDATE, EWAYBILLDATE, APPLICABLEFROM and the like) are shown as dd-mm-yyyy. */
const isDateField = (key) => /DATE$/.test(key) || key === "APPLICABLEFROM";
const fieldValue = (key, value) => isDateField(key) && /^(\d{8}|\d{4}-\d{2}-\d{2})$/.test(String(value ?? "")) ? dateLabel(value) : value;
const plural = (count, one, many = `${one}s`) => `${count} ${Number(count) === 1 ? one : many}`;

/* One inline message per form: quiet progress, a status, or an alert the person must act on. */
function setMessage(node, text, tone = "quiet", extra = "") {
  node.className = `${extra ? `${extra} ` : ""}form-message ${tone}`;
  node.setAttribute("role", tone === "alert" ? "alert" : "status");
  node.textContent = text;
  if (tone === "alert" && text) node.scrollIntoView({ block: "nearest" });
}

export async function viewTally(route, token, ui) {
  if (!["tally-import", "tally-source"].includes(route.name)) return false;
  const { root, api, still, page, esc } = ui;
  const money = (amount) => esc(formatINR(amount));
  const fieldName = (key) => FIELD_NAMES[key] || key;
  const statusPill = (status) => `<span class="pill ${STATUS_TONES[status] || ""}">${esc(STATUS_NAMES[status] || status)}</span>`;
  const company = route.id ? (await api(`/api/companies/${encodeURIComponent(route.id)}/meta`)).company : undefined;
  if (!still(token)) return true;
  const book = company ? `#/c/${encodeURIComponent(company.id)}` : "#";
  const accountingExport = (standalone) => company ? `<section class="${standalone ? "subsection " : ""}tally-export-section"><h2>Export accounting books to Tally</h2><p>The XML carries account groups, ledger openings and accounting voucher postings.</p><div class="toolbar tally-download"><label>Accounting XML<select data-accounting-format><option value="masters">All masters</option><option value="daybook">Day book</option></select></label><a class="button ghost" data-accounting-download href="/api/tally/companies/${encodeURIComponent(company.id)}/export/masters" download>Download Tally XML</a></div></section>` : "";
  const render = (title, body) => {
    document.title = company ? `${title} · ${company.name}` : `${title} · Ledgercraft`;
    root.innerHTML = page({ company, title, body: `<div class="tally-workspace">${body}</div>` });
    const format = root.querySelector("[data-accounting-format]");
    format?.addEventListener("change", () => { root.querySelector("[data-accounting-download]").href = `/api/tally/companies/${encodeURIComponent(company.id)}/export/${format.value}`; });
    const original = root.querySelector("[data-original-file]");
    original?.addEventListener("change", () => { root.querySelector("[data-original-download]").href = `/api/tally/companies/${encodeURIComponent(company.id)}/file/${original.value}`; });
  };

  if (route.name === "tally-import") {
    render("Import from Tally", `<div class="details-list tally-guide"><details><summary>Get your company exports from Tally</summary><ol><li>Open the original company in TallyPrime or Tally.ERP 9. Export All Masters with the original ledger opening balances.</li><li>Open Day Book, choose the full books period and export All Vouchers with narration and dependent details. Choose XML Data Interchange or native JSON Data Exchange. Supported TallyPrime default Excel workbooks or their single-workbook ZIP can also be imported.</li><li>Choose both exports below and enter the original books beginning date.</li></ol><p>For a native company folder or backup, use the <a href="/tally-bridge.ps1" download>Windows Tally export companion</a> with your licensed Tally installation.</p><p>Tally’s own guides cover <a href="https://help.tallysolutions.com/how-to-export-import-entire-data-masters-transactions-to-a-new-company/" target="_blank" rel="noreferrer">exporting masters and transactions</a> and <a href="https://help.tallysolutions.com/tally-prime-integration-using-json-1/" target="_blank" rel="noreferrer">the native JSON format</a>.</p></details></div><form id="tally-preview-form" class="form-grid tally-import-form"><label>Company name<input name="companyName" maxlength="80" placeholder="Name in Tally"/></label><label>Original books beginning date<input type="date" name="booksFrom"/></label><label class="wide">Tally exports, Excel workbook or full Ledgercraft Tally archive<input type="file" name="files" multiple required accept=".txt,.xml,.json,.xlsx,.900,.tsf,.zip,.tbk"/></label><p class="wide form-note">Up to 24 files and 40 MB of source data. Full Ledgercraft Tally archives carry their company name and dates.</p><div class="wide actions"><button type="submit">Preview import</button></div><p id="tally-message" class="wide form-message" role="status" aria-live="polite"></p></form><section id="tally-preview" aria-live="polite"></section>${accountingExport(true)}`);
    const form = root.querySelector("#tally-preview-form");
    const message = root.querySelector("#tally-message");
    const signChoices = Object.create(null);
    const accountGroupMappings = Object.create(null);
    const overlapChoices = Object.create(null);
    let useBilledAsActual = false, inputGeneration = 0, previewRequest = 0, committing = false;
    const invalidatePreview = () => {
      inputGeneration++;
      const target = root.querySelector("#tally-preview");
      target.querySelector("#tally-confirm")?.remove();
      const button = form.querySelector("button");
      if (target.childElementCount || button.disabled) setMessage(message, "Import settings changed. Select Preview import or Recalculate preview to use them.", "notice", "wide");
      if (!committing) button.disabled = false;
    };
    const choiceSection = (extra = "") => {
      const section = document.createElement("section");
      section.className = `subsection tally-choice${extra ? ` ${extra}` : ""}`;
      return section;
    };
    const placeChoice = (target, section) => {
      target.querySelector("#tally-confirm")?.before(section);
      if (!section.isConnected) target.append(section);
    };
    form.elements.files.addEventListener("change", () => {
      invalidatePreview();
      useBilledAsActual = false;
      for (const key of Object.keys(signChoices)) delete signChoices[key];
      for (const key of Object.keys(accountGroupMappings)) delete accountGroupMappings[key];
      for (const key of Object.keys(overlapChoices)) delete overlapChoices[key];
      root.querySelector("#tally-preview").innerHTML = "";
    });
    form.addEventListener("input", event => {
      if (!["companyName", "booksFrom"].includes(event.target.name)) return;
      invalidatePreview();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector("button");
      const target = root.querySelector("#tally-preview");
      const generation = inputGeneration, request = ++previewRequest;
      const currentPreview = () => still(token) && form.isConnected && generation === inputGeneration && request === previewRequest;
      const settings = { signChoices: { ...signChoices }, accountGroupMappings: { ...accountGroupMappings }, overlapChoices: { ...overlapChoices }, useBilledAsActual, companyName: form.elements.companyName.value, booksFrom: form.elements.booksFrom.value };
      button.disabled = true;
      setMessage(message, "Reading the source files and checking accounting postings…", "quiet", "wide");
      target.innerHTML = "";
      try {
        const files = [...form.elements.files.files];
        if (!files.length || files.length > 24 || files.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) throw new Error("Choose up to 24 files. Source exports can total 40 MB and full archives 64 MB.");
        const payload = { ...settings, files: await Promise.all(files.map(async (file) => ({ name: file.name, base64: await fileBase64(file) }))) };
        if (!currentPreview()) return;
        const preview = await api("/api/tally/preview", { method: "POST", body: payload });
        if (!currentPreview()) return;
        setMessage(message, "Preview ready. Review it below.", "quiet", "wide");
        const summary = preview.summary;
        const reconciliation = summary.reconciliation;
        const issues = preview.issues;
        const issueTone = { blocking: "bad", review: "warn" };
        const issueLabel = { blocking: "Resolve", review: "Review" };
        const trialDifference = summary.trial ? Math.abs(summary.trial.difference) : 0;
        target.innerHTML = `<h2>${esc(summary.companyName || "Company preview")}</h2>`
          + `<div class="summary-strip"><div><span>Ledgers</span><strong>${esc(summary.ledgers)}</strong></div><div><span>Accounting vouchers</span><strong>${esc(summary.vouchers)}</strong></div><div><span>Additional source masters</span><strong>${esc(summary.referenceMasters || 0)}</strong></div></div>`
          + (reconciliation
            ? `<h3>Accounting reconciliation</h3><div class="table-scroll"><table><thead><tr><th>Postings</th><th class="figure">Debit (₹)</th><th class="figure">Credit (₹)</th></tr></thead><tbody><tr><th scope="row">Source accounting postings</th><td class="figure">${money(reconciliation.sourceDebitPaise)}</td><td class="figure">${money(reconciliation.sourceCreditPaise)}</td></tr></tbody><tfoot><tr class="total"><th scope="row">Ledgercraft postings</th><td class="figure">${money(reconciliation.postedDebitPaise)}</td><td class="figure">${money(reconciliation.postedCreditPaise)}</td></tr></tfoot></table></div><dl class="kv"><dt>Source vouchers</dt><dd>${esc(reconciliation.sourceVouchers)}</dd><dt>Posted</dt><dd>${esc(reconciliation.postedVouchers)}</dd><dt>Retained without posting</dt><dd>${esc(reconciliation.excludedVouchers)}</dd><dt>Identical duplicates</dt><dd>${esc(reconciliation.duplicateVouchers || 0)}</dd><dt>Exceptions</dt><dd>${esc(reconciliation.failedVouchers)}${reconciliation.failedVouchers ? ' <span class="pill bad">Resolve</span>' : ""}</dd></dl>`
            : `<p>Restoring the saved company and its original Tally source files.</p>`)
          + (summary.trial ? `<p>The projected trial balance totals ₹${money(summary.trial.debit)} debit and ₹${money(summary.trial.credit)} credit. ${trialDifference ? `<span class="pill warn">Off by ₹${money(trialDifference)}</span>` : '<span class="pill ok">Balanced</span>'}</p>` : "")
          + `<h3>Source files</h3><ul class="tally-source-files">${preview.files.map((file) => `<li><strong>${esc(file.name)}</strong> <span class="quiet">${esc(file.encoding || "Original bytes")}</span><small>SHA-256 <span class="code">${esc(file.sha256)}</span></small></li>`).join("")}</ul>`
          + (issues.length
            ? `<h3>Import review</h3><ul class="tally-issues">${issues.slice(0, 100).map((issue) => `<li><span class="pill ${issueTone[issue.severity] || ""}">${issueLabel[issue.severity] || "Retained"}</span> ${esc(issue.message)}</li>`).join("")}</ul>${issues.length > 100 ? `<p>${issues.length === 101 ? "One further entry is" : `${issues.length - 100} further entries are`} in the complete import report.</p>` : ""}`
            : `<p>The source accounting postings passed the import checks.</p>`)
          + `<p><a href="/api/tally/preview/${preview.token}/report" download>Download complete import report</a></p>`
          + (preview.canCommit
            ? `<form id="tally-confirm"><label class="check"><input type="checkbox" required/><span>I reviewed the postings and source details for this import.</span></label><div class="actions"><button type="submit">Create imported company</button></div><p data-commit-status class="form-message" role="status"></p></form>`
            : `<p class="alert">This import cannot be created yet. Resolve each item marked Resolve, using the choices below where they appear or by correcting the exports in Tally, then preview again.</p>`);
        const heading = target.querySelector("h2");
        if (summary.billReferences) {
          const bills = summary.billReferences;
          heading.insertAdjacentHTML("afterend", `<p class="tally-bill-preview">Bill-wise projection: ${esc(plural(bills.billsReady, "bill reference"))} and ${esc(plural(bills.allocationsReady, "settlement allocation"))} are ready. ${esc(plural(bills.exceptions, "source exception"))} retained.</p>`);
        }
        if (summary.stockProjection) {
          const stock = summary.stockProjection;
          heading.insertAdjacentHTML("afterend", `<p>Stock from Tally: ${esc(plural(stock.items, "item"))}, ${esc(plural(stock.receiptLines, "receipt line"))}, ${esc(plural(stock.issueLines, "issue line"))} and ${esc(plural(stock.transferLines, "transfer line"))}. ${esc(plural(stock.exceptions, "source exception"))} retained.</p>`);
        }
        if (summary.openingScope) {
          const scope = summary.openingScope;
          heading.insertAdjacentHTML("afterend", `<p class="tally-opening-scope"><span class="pill ${scope.transactionOnly ? "warn" : ""}">${scope.transactionOnly ? "Transactions only" : "Opening balance scope"}</span> ${esc(scope.message)}</p>`);
        }
        if (summary.openingScope?.billedOnlyLines) {
          const section = choiceSection();
          section.innerHTML = `<h3>Physical stock quantities</h3><p>${esc(plural(summary.openingScope.billedOnlyLines, "source item line"))} give billed quantities without actual quantities.</p><label class="check"><input type="checkbox" data-billed-as-actual${useBilledAsActual ? " checked" : ""}><span>Actual quantities match billed quantities where the workbook omits actual quantities.</span></label><p class="actions"><button type="button" class="ghost" data-recheck-quantities>Recalculate preview</button></p>`;
          section.querySelector("[data-billed-as-actual]").addEventListener("change", event => { useBilledAsActual = event.target.checked; invalidatePreview(); });
          section.querySelector("[data-recheck-quantities]").addEventListener("click", () => form.requestSubmit());
          placeChoice(target, section);
        }
        if (summary.gstReadiness) {
          const gst = summary.gstReadiness;
          const sentences = [`GST source: ${esc(gst.sourceSales || 0)} sales with source item value ₹${money(gst.itemValuePaise ?? gst.sourceItemValuePaise ?? gst.taxablePaise)} and tax ₹${money(gst.taxPaise)}.`];
          if (gst.sourcePurchases !== undefined) sentences.push(`${esc(gst.sourcePurchases)} purchases with source item value ₹${money(gst.sourcePurchaseItemValuePaise)} and tax ₹${money(gst.purchaseTaxPaise)}.`);
          heading.insertAdjacentHTML("afterend", `<p class="tally-gst-preview">${sentences.join(" ")} After import, review seller and buyer registrations, party and HSN mappings in Tally source.</p>`);
        }
        if (preview.accountGroupMappings?.length) {
          const section = choiceSection();
          section.innerHTML = `<h3>Referenced ledger groups</h3><p>Choose the account group for ledgers whose role the workbook does not state, then recalculate to check the resulting books.</p><div class="form-grid">${preview.accountGroupMappings.map(row => `<label><span>${esc(row.sourceName)}${row.required ? ' <span class="pill warn">Required</span>' : ""}</span><select data-account-group="${esc(row.sourceName)}"><option value="">Choose account group</option>${preview.accountGroups.map(group => `<option value="${esc(group.id)}"${(accountGroupMappings[row.sourceName] || row.groupId) === group.id ? " selected" : ""}>${esc(group.name)}</option>`).join("")}</select>${row.reason ? `<small>${esc(row.reason)}</small>` : ""}</label>`).join("")}</div><p class="actions"><button type="button" class="ghost" data-recheck-groups>Recalculate preview</button></p>`;
          for (const select of section.querySelectorAll("[data-account-group]")) select.addEventListener("change", () => {
            accountGroupMappings[select.dataset.accountGroup] = select.value;
            invalidatePreview();
          });
          section.querySelector("[data-recheck-groups]").addEventListener("click", () => form.requestSubmit());
          placeChoice(target, section);
        }
        if (preview.overlaps?.length) {
          const section = choiceSection("tally-overlap-review");
          section.innerHTML = `<h3>Overlapping voucher exports</h3><p>These source records share a voucher type, date and number across files. Choose the authoritative source to post once, or confirm that every listed record is a separate transaction.</p><div class="form-grid">${preview.overlaps.map(group => `<label><span>${esc(group.type)} <span class="code">${esc(group.number)}</span> dated ${esc(dateLabel(group.date))}</span><select data-overlap-choice="${esc(group.key)}"><option value="">Choose which source to post</option>${group.records.map(record => `<option value="${esc(record.recordId)}"${(overlapChoices[group.key] || group.choice) === record.recordId ? " selected" : ""}>${esc(record.file)}, ${esc(record.party || "source party")}, ₹${money(record.amountPaise)}</option>`).join("")}<option value="distinct"${(overlapChoices[group.key] || group.choice) === "distinct" ? " selected" : ""}>All listed records are distinct transactions</option></select></label>`).join("")}</div><p class="actions"><button type="button" class="ghost" data-recheck-overlaps>Recalculate preview</button></p>`;
          for (const select of section.querySelectorAll("[data-overlap-choice]")) select.addEventListener("change", () => { overlapChoices[select.dataset.overlapChoice] = select.value; invalidatePreview(); });
          section.querySelector("[data-recheck-overlaps]").addEventListener("click", () => form.requestSubmit());
          placeChoice(target, section);
        }
        const conflicts = issues.filter(i => i.code === "posting-sign-conflict");
        if (conflicts.length) {
          const section = choiceSection();
          const signLines = (lines) => lines.map(line => `<tr><th scope="row">${esc(line.ledger)}</th>${line.dc === "Dr" ? `<td class="figure">${money(line.paise)}</td><td class="figure quiet">—</td>` : `<td class="figure quiet">—</td><td class="figure">${money(line.paise)}</td>`}</tr>`).join("");
          section.innerHTML = `<h3>Resolve posting signs</h3>${conflicts.map(i => `<p>${esc(i.message)}</p><label class="tally-sign-choice">Source of debit and credit for this voucher<select data-sign-choice="${esc(i.reference)}"><option value="">Choose the source of debit and credit</option><option value="signed-amounts">Signed amounts</option><option value="debit-credit-flags">Debit and credit flags</option></select></label>`).join("")}${preview.mapping.filter(m => m.signChoice).map(m => `<h4>${esc(m.type)} <span class="code">${esc(m.number)}</span></h4><div class="table-scroll"><table><thead><tr><th>Ledger</th><th class="figure">Debit (₹)</th><th class="figure">Credit (₹)</th></tr></thead><tbody>${signLines(m.lines)}</tbody></table></div>`).join("")}<p class="actions"><button type="button" class="ghost" data-recheck>Recalculate preview</button></p>`;
          for (const select of section.querySelectorAll("[data-sign-choice]")) {
            select.value = signChoices[select.dataset.signChoice] || "";
            select.onchange = () => { signChoices[select.dataset.signChoice] = select.value; invalidatePreview(); };
          }
          section.querySelector("[data-recheck]").onclick = () => form.requestSubmit();
          placeChoice(target, section);
        }
        target.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
        const confirm = target.querySelector("#tally-confirm");
        confirm?.addEventListener("submit", async (commitEvent) => {
          commitEvent.preventDefault();
          if (!currentPreview()) { invalidatePreview(); return; }
          const action = confirm.querySelector("button");
          const status = confirm.querySelector("[data-commit-status]");
          const controls = [...form.elements, ...target.querySelectorAll("input,select,button")];
          const previousDisabled = controls.map(control => control.disabled);
          committing = true;
          for (const control of controls) control.disabled = true;
          action.disabled = true;
          setMessage(status, "Creating the company and preserving its source files…");
          try {
            const created = await api("/api/tally/commit", { method: "POST", body: { token: preview.token, acknowledge: true, compact: true } });
            if (!currentPreview()) return;
            sessionStorage.setItem("financer-flash", "Tally company imported. Original files and source details are available in Tally source.");
            location.hash = `#/c/${encodeURIComponent(created.company.id)}/tally-source`;
          } catch (error) { if (currentPreview()) setMessage(status, error.message, "alert"); }
          finally { committing = false; if (form.isConnected) controls.forEach((control, index) => { control.disabled = previousDisabled[index]; }); }
        });
      } catch (error) { if (currentPreview()) setMessage(message, error.message, "alert", "wide"); }
      finally { if (request === previewRequest && !committing) button.disabled = false; }
    });
    return true;
  }

  if (!company) throw new Error("Open an imported Tally company to view its source records");
  const base = `/api/tally/companies/${encodeURIComponent(company.id)}`;
  const originalFiles = await api(`${base}/files`);
  if (!still(token)) return true;
  const capturedFiles = originalFiles.files || [];
  const originalDownload = `<section class="tally-export-section"><h2>Original Tally files</h2>${capturedFiles.length
    ? `<p>${originalFiles.unchangedSinceImport === true ? "The imported books match their original import state." : "These files contain the original captured Tally snapshot."}</p><div class="toolbar tally-download"><label>Original file<select data-original-file>${capturedFiles.map((file) => `<option value="${esc(file.index)}">${esc(file.name)}</option>`).join("")}</select></label><a class="button ghost" data-original-download href="${base}/file/${encodeURIComponent(capturedFiles[0].index)}" download>Download original file</a></div>`
    : `<p>No original Tally files were kept with this company. The source records below are what the import retained.</p>`}</section>`;
  const tools = `<div class="actions tally-toolbar"><a href="${book}/tally-source">All source records</a><a href="${base}/archive" download>Download full Tally archive</a><a href="#/tally-import">Import another company</a></div><div class="details-list"><details class="tally-export-menu"><summary>Export files</summary>${accountingExport(false)}${originalDownload}</details></div>`;
  const fields = (input) => `<dl class="kv tally-fields">${Object.entries(input).map(([key, entry]) => `<dt>${esc(fieldName(key))}</dt><dd${CODE_FIELDS.has(key) ? ' class="code"' : ""}>${esc(fieldValue(key, entry))}</dd>`).join("")}</dl>`;
  const table = (title, rows) => {
    if (!rows?.length) return "";
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const headClass = (key) => FIGURE_FIELDS.has(key) ? ' class="figure"' : "";
    const cellClass = (key) => FIGURE_FIELDS.has(key) ? ' class="figure"' : CODE_FIELDS.has(key) ? ' class="code"' : "";
    return `<section class="tally-data-section"><h2>${esc(title)}</h2><div class="table-scroll"><table><thead><tr>${columns.map((key) => `<th${headClass(key)}>${esc(fieldName(key))}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((key) => `<td${cellClass(key)}>${esc(fieldValue(key, row[key] ?? "—"))}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>`;
  };
  if (route.detail) {
    const { record } = await api(`${base}/record/${encodeURIComponent(route.detail)}`);
    if (!still(token)) return true;
    render(record.name, `${tools}<dl class="kv"><dt>Record type</dt><dd>${esc(TYPE_NAMES[record.type] || record.type)}</dd><dt>Import status</dt><dd>${statusPill(record.status)}</dd><dt>Source file</dt><dd>${esc(record.file)}</dd></dl>${record.reason ? `<p>${esc(record.reason)}</p>` : ""}${record.editedAfterImport ? `<p class="notice">The accounting voucher was edited after import. These are its original Tally source details.</p>` : ""}${record.deletedAfterImport ? `<p class="notice">The accounting voucher was deleted after import. Its original Tally source details are retained.</p>` : ""}${record.voucherId && !record.deletedAfterImport ? `<p><a href="${book}/v/${encodeURIComponent(record.voucherType || record.sourceType)}/${encodeURIComponent(record.voucherId)}">Open accounting voucher</a></p>` : ""}<h2>Source fields</h2>${fields(record.fields)}${record.address.length ? `<h2>Address</h2><p>${record.address.map(esc).join("<br/>")}</p>` : ""}${record.hsn.length ? `<h2>HSN</h2><p>${record.hsn.map((code) => `<span class="code">${esc(code)}</span>`).join(", ")}</p>` : ""}${table("Inventory lines", record.inventory)}${table("Batches & godowns", record.batches)}${table("Accounting allocations", record.accounting)}${table("Bill references", record.bills)}${table("Bank references", record.banks)}${table("Cost allocations", record.costs)}${table("Tax source details", record.taxes)}${record.transport && Object.keys(record.transport).length ? table("Transport and e-invoice source references", [record.transport]) : ""}${(record.spreadsheet || []).map(row => table(`Spreadsheet source: ${row.sheet}, row ${row.row}`, row.cells)).join("")}<div class="details-list"><details class="tally-original"><summary>Complete source fields</summary><pre>${esc(JSON.stringify(record.original, null, 2))}</pre></details></div>`);
    return true;
  }
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const result = await api(`${base}/records?${params}`);
  if (!still(token)) return true;
  const details = (record) => [record.date && `<span>${esc(dateLabel(record.date))}</span>`, record.parent && `<span>${esc(record.parent)}</span>`, record.hsn && `<span class="code">${esc(record.hsn)}</span>`, record.gstin && `<span class="code">${esc(record.gstin)}</span>`].filter(Boolean).join("");
  const pageLink = (offset, label) => `<a href="${book}/tally-source?${new URLSearchParams({ ...Object.fromEntries(params), offset: String(offset) })}">${label}</a>`;
  render("Tally source", `${tools}<dl class="kv tally-counts">${Object.entries(result.counts).map(([type, count]) => `<dt>${esc(TYPE_NAMES[type] || type)}</dt><dd>${esc(count)}</dd>`).join("")}</dl><form id="tally-source-filter" class="toolbar"><label>Record type<select name="type"><option value="">All source records</option>${Object.keys(result.counts).map((type) => `<option value="${esc(type)}"${params.get("type") === type ? " selected" : ""}>${esc(TYPE_NAMES[type] || type)}</option>`).join("")}</select></label><label class="grow">Find a name, GSTIN, HSN or date<input type="search" name="q" value="${esc(params.get("q") || "")}"/></label><button type="submit">Find records</button></form><p class="quiet">${esc(plural(result.total, "matching record"))}</p><div class="table-scroll"><table class="tally-records"><thead><tr><th>Name or number</th><th>Type</th><th>Details</th><th>Status</th></tr></thead><tbody>${result.records.map((record) => `<tr><th scope="row"><a href="${book}/tally-source/${encodeURIComponent(record.recordId)}">${esc(record.name)}</a></th><td>${esc(record.type === "VOUCHER" ? record.sourceType : TYPE_NAMES[record.type] || record.type)}</td><td class="tally-record-details">${details(record)}</td><td>${statusPill(record.status)}</td></tr>`).join("") || '<tr><td colspan="4" class="quiet">No source records match. Clear the search or choose All source records, then select Find records.</td></tr>'}</tbody></table></div><div class="actions">${result.offset > 0 ? pageLink(Math.max(0, result.offset - 100), "Previous 100 records") : ""}${result.offset + 100 < result.total ? pageLink(result.offset + 100, "Next 100 records") : ""}</div>`);
  installTallyGstReview({ root, api, esc, base, book, still, token, focus: params.get("review") === "gst" });
  installTallyBillReview({ root, api, esc, base, book, still, token });
  installTallyStockReview({ root, api, esc, base, book, still, token, focus: params.get("review") === "stock" });
  root.querySelector("#tally-source-filter").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    location.hash = `${book.slice(1)}/tally-source?${new URLSearchParams({ type: form.elements.type.value, q: form.elements.q.value })}`;
  });
  return true;
}

/* Shows a review error where the person will see it: inside the opened review, scrolled into view. */
function showReviewError(section, text, reveal = true) {
  const node = section.querySelector("[role=alert]");
  node.textContent = text;
  if (!text) return;
  const details = node.closest("details");
  if (details) details.open = true;
  if (reveal) node.scrollIntoView({ block: "nearest" });
}

async function installTallyStockReview({ root, api, esc, base, book, still, token, focus }) {
  const section = document.createElement("section");
  section.className = "subsection tally-review";
  section.innerHTML = '<h2>Stock from Tally</h2><p data-stock-source-summary role="status">Reading stock masters and movements…</p><div class="details-list"><details data-stock-source-details><summary>Review stock activation</summary><div data-stock-source-rows></div><div data-stock-source-actions></div><p data-stock-source-error class="form-message alert" role="alert"></p></details></div>';
  root.querySelector(".tally-workspace").append(section);
  let state, offset = 0;
  const tone = { exception: "bad", active: "ok" };
  const label = { exception: "Source exception", active: "Active" };
  const show = async () => {
    try {
      state = await api(`${base}/stock?offset=${offset}`);
      if (!still(token)) return;
      const summary = state.summary;
      section.querySelector("[data-stock-source-summary]").innerHTML = `${esc(plural(summary.items, "supported item"))}, ${esc(plural(summary.journals, "stock journal"))} and ${esc(plural(summary.exceptions, "source exception"))}. ${summary.alreadyActive ? '<span class="pill ok">Activated</span>' : '<span class="pill warn">Awaiting review</span>'}`;
      const value = (row) => row.valuePaise === undefined ? '<td class="figure quiet">—</td>' : row.valuePaise === null ? '<td class="figure quiet">Missing</td>' : `<td class="figure">${esc(formatINR(row.valuePaise))}</td>`;
      /* Avg. Cost items carry an informational costing disclosure. It sits under its item and is not a fault to resolve. */
      const costingNotes = state.issues.filter(issue => issue.code === "tally-costing-mapped");
      const noteFor = new Map(costingNotes.map(issue => [issue.reference, issue]));
      const noteText = (issue, unit = "") => Number.isSafeInteger(issue.differencePaise) && Number.isSafeInteger(issue.sourceClosingValuePaise) && Number.isSafeInteger(issue.ledgercraftClosingValuePaise)
        ? `On ${dateLabel(issue.asOf)}, Tally's periodic average values the closing ${[issue.sourceClosingQuantity, unit].filter(Boolean).join(" ")} at ₹${formatINR(issue.sourceClosingValuePaise)}; Ledgercraft's moving average values it at ₹${formatINR(issue.ledgercraftClosingValuePaise)}. ${issue.differencePaise ? `Disclosed difference ₹${formatINR(Math.abs(issue.differencePaise))}, Tally ${issue.differencePaise > 0 ? "higher" : "lower"}.` : "No difference."}`
        : issue.message;
      const noteRow = (row) => noteFor.has(row.recordId) ? `<tr class="tally-stock-note"><td colspan="4"><span class="pill info">Costing note</span> ${esc(noteText(noteFor.get(row.recordId), row.unit))}</td></tr>` : "";
      const shownRows = new Set(state.rows.map(row => row.recordId));
      const otherNotes = costingNotes.filter(issue => !shownRows.has(issue.reference));
      /* A source exception already shows its reason in its row; the list below keeps everything else that needs review. */
      const inRow = new Set(state.rows.filter(row => row.status === "exception").map(row => `${row.recordId}\u0000${row.message}`));
      const attention = state.issues.filter(issue => issue.severity !== "info" && !inRow.has(`${issue.reference}\u0000${issue.message}`));
      section.querySelector("[data-stock-source-rows]").innerHTML = `<div class="table-scroll"><table class="tally-stock-review"><thead><tr><th>Source</th><th>Opening quantity</th><th class="figure">Opening value (₹)</th><th>Status</th></tr></thead><tbody>${state.rows.map(row => `<tr class="tally-stock-item"><th scope="row"><a href="${book}/tally-source/${encodeURIComponent(row.recordId)}">${esc(row.name)}</a></th><td>${row.quantity !== undefined ? esc(`${row.quantity} ${row.unit}`) : "—"}</td>${value(row)}<td><span class="pill ${tone[row.status] || ""}">${esc(label[row.status] || "Ready")}</span>${row.message ? `<small>${esc(row.message)}</small>` : ""}</td></tr>${noteRow(row)}`).join("") || '<tr><td colspan="4" class="quiet">No stock masters or movements were exported. Include stock items and stock vouchers in the Tally exports to review stock here.</td></tr>'}</tbody></table></div>${otherNotes.length ? `<ul class="tally-stock-notes">${otherNotes.slice(0, 30).map(issue => `<li><span class="pill info">Costing note</span> ${esc(noteText(issue))}</li>`).join("")}</ul>` : ""}${attention.length ? `<ul class="attention-rule">${attention.slice(0, 30).map(issue => `<li>${esc(issue.message)}</li>`).join("")}</ul>${attention.length > 30 ? `<p class="quiet">${esc(plural(attention.length - 30, "further entry", "further entries"))} in the complete stock review.</p>` : ""}` : ""}<div class="actions">${offset ? '<button class="ghost" type="button" data-stock-source-previous>Previous stock records</button>' : ""}${offset + 100 < state.total ? '<button class="ghost" type="button" data-stock-source-next>More stock records</button>' : ""}</div>`;
      section.querySelector("[data-stock-source-actions]").innerHTML = `<div class="actions"><a href="${book}/stock">Open stock register</a><a href="${base}/stock/report" download>Download complete stock review</a>${state.canActivate ? `<button type="button" data-activate-tally-stock>${summary.emptySource ? "Confirm empty stock source" : "Activate supported stock"}</button>` : ""}</div>`;
      section.querySelector("[data-stock-source-previous]")?.addEventListener("click", () => { offset = Math.max(0, offset - 100); show(); });
      section.querySelector("[data-stock-source-next]")?.addEventListener("click", () => { offset += 100; show(); });
      section.querySelector("[data-activate-tally-stock]")?.addEventListener("click", async event => {
        const button = event.currentTarget;
        button.disabled = true;
        button.dataset.requestId ||= crypto.randomUUID();
        showReviewError(section, "");
        try {
          await api(`${base}/stock/activate`, { method: "POST", body: { reviewHash: state.reviewHash, requestId: button.dataset.requestId } });
          if (!still(token)) return;
          await show();
        } catch (error) { showReviewError(section, error.message); button.disabled = false; }
      });
    } catch (error) {
      section.querySelector("[data-stock-source-summary]").textContent = "The stock source review could not open. Reload this page to try again.";
      showReviewError(section, error.message, false);
    }
  };
  await show();
  if (focus && still(token)) { section.querySelector("details").open = true; section.scrollIntoView({ block: "start" }); }
}

async function installTallyBillReview({ root, api, esc, base, book, still, token }) {
  const section = document.createElement("section");
  section.className = "subsection tally-review";
  section.innerHTML = '<h2>Bill-wise references</h2><p data-bill-review-summary role="status">Reading source references…</p><div class="details-list"><details><summary>Review bill activation</summary><form data-bill-review-filter class="toolbar"><label>Reference or party<input name="q" type="search"></label><label>Reference status<select name="status"><option value="">All references</option><option value="ready">Ready to activate</option><option value="exception">Retained source exceptions</option><option value="active">Active references</option><option value="edited">Edited after activation</option><option value="on-account">On account</option><option value="removed">Removed after activation</option></select></label><button type="submit" class="ghost">Filter references</button></form><div data-bill-review-rows></div><div data-bill-review-actions></div><p data-bill-review-error class="form-message alert" role="alert"></p></details></div>';
  root.querySelector(".tally-workspace").append(section);
  let state, offset = 0;
  const label = { ready: "Ready", active: "Active", edited: "Edited", reused: "Existing reference", removed: "Removed", exception: "Source exception", "on-account": "On account", pending: "Source review" };
  const tone = { ready: "info", active: "ok", edited: "warn", exception: "bad", pending: "warn" };
  const filter = section.querySelector("[data-bill-review-filter]");
  const show = async () => {
    const query = new URLSearchParams({ ...Object.fromEntries(new FormData(filter)), offset: String(offset) });
    const filtered = Boolean(filter.elements.q.value.trim() || filter.elements.status.value);
    try {
      const current = await api(`${base}/bills?${query}`);
      if (!still(token)) return;
      state = current;
      const summary = current.summary;
      section.querySelector("[data-bill-review-summary]").textContent = `${plural(summary.activeBills, "active bill reference")} and ${plural(summary.activeAllocations, "active allocation")}. ${summary.billsReady + summary.allocationsReady} ready to activate. ${plural(summary.exceptions, "source exception")} retained.`;
      section.querySelector("[data-bill-review-rows]").innerHTML = `<div class="table-scroll"><table><thead><tr><th>Party</th><th>Reference</th><th>Bill date</th><th class="figure">Amount (₹)</th><th>Status</th></tr></thead><tbody>${current.rows.map(row => `<tr><th scope="row">${esc(row.partyName)}<small><a href="${book}/tally-source/${encodeURIComponent(row.recordId)}">Open source record</a></small></th><td>${row.reference ? `<span class="code">${esc(row.reference)}</span>` : "—"}<small>${esc(row.method)}</small></td><td class="date-cell">${esc(dateLabel(row.date))}${row.dueDate ? `<small>Due ${esc(dateLabel(row.dueDate))}</small>` : ""}</td><td class="figure">${esc(formatINR(row.paise))}</td><td><span class="pill ${tone[row.status] || ""}">${esc(label[row.status] || row.status)}</span>${row.message ? `<small>${esc(row.message)}</small>` : ""}</td></tr>`).join("") || `<tr><td colspan="5" class="quiet">${filtered ? "No bill references match this filter. Clear the reference or choose All references, then select Filter references." : "This import carries no bill-wise references. Include bill allocations in the Tally day book export, then import it again to review them here."}</td></tr>`}</tbody></table></div><p class="quiet">${esc(plural(current.total, "matching source reference"))}</p><div class="actions">${offset ? '<button type="button" class="ghost" data-bill-previous>Previous bill references</button>' : ""}${offset + 100 < current.total ? '<button type="button" class="ghost" data-bill-next>More bill references</button>' : ""}</div>`;
      section.querySelector("[data-bill-review-actions]").innerHTML = `<div class="actions"><a href="${base}/bills/report" download>Download complete bill reference review</a>${current.canActivate ? '<button type="button" data-activate-tally-bills>Activate supported bill references</button>' : ""}</div>`;
      section.querySelector("[data-bill-previous]")?.addEventListener("click", () => { offset = Math.max(0, offset - 100); show(); });
      section.querySelector("[data-bill-next]")?.addEventListener("click", () => { offset += 100; show(); });
      section.querySelector("[data-activate-tally-bills]")?.addEventListener("click", async event => {
        const button = event.currentTarget;
        button.disabled = true;
        button.dataset.requestId ||= crypto.randomUUID();
        showReviewError(section, "");
        try {
          const response = await api(`${base}/bills/activate`, { method: "POST", body: { revision: state.revision, reviewHash: state.reviewHash, requestId: button.dataset.requestId } });
          if (!still(token)) return;
          await show();
          section.querySelector("[data-bill-review-summary]").textContent += ` Saved ${plural(response.result.activatedBills, "bill reference")} and ${plural(response.result.activatedAllocations, "allocation")}.`;
        } catch (error) {
          showReviewError(section, error.message);
          button.disabled = false;
        }
      });
    } catch (error) {
      section.querySelector("[data-bill-review-summary]").textContent = "The bill source review could not open. Reload this page to try again.";
      showReviewError(section, error.message, false);
    }
  };
  filter.addEventListener("submit", event => { event.preventDefault(); offset = 0; show(); });
  await show();
}
