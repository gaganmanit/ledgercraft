import { formatINR } from "/money.js";
import { installTallyGstReview } from "/tally-gst-ui.js";

const TYPE_NAMES = { LEDGER: "Ledgers & contacts", GROUP: "Account groups", VOUCHER: "Vouchers", STOCKITEM: "Stock items & HSN", STOCKGROUP: "Stock groups", STOCKCATEGORY: "Stock categories", UNIT: "Units", GODOWN: "Godowns", COSTCENTRE: "Cost centres", COSTCATEGORY: "Cost categories", VOUCHERTYPE: "Voucher types", COMPANY: "Company" };
const STATUS_NAMES = { voucher: "Posted", ledger: "Ledger", group: "Group", "reference-master": "Source master", "mapped-reserved-group": "Standard group", nonposting: "Retained without posting", "duplicate-source": "Identical source copy", exception: "Needs review" };
const FIELD_NAMES = { NAME: "Name", PARENT: "Under", DATE: "Date", VOUCHERTYPENAME: "Voucher type", VOUCHERNUMBER: "Voucher number", EFFECTIVEDATE: "Effective date", NARRATION: "Narration", PARTYLEDGERNAME: "Party ledger", PARTYGSTIN: "Party GSTIN", PLACEOFSUPPLY: "Place of supply", GSTREGISTRATIONTYPE: "GST registration type", PARTYMAILINGNAME: "Party mailing name", PARTYSTATENAME: "Party state", COUNTRYNAME: "Country", LEDSTATENAME: "State", STATENAME: "State", PINCODE: "PIN code", EMAIL: "Email", LEDGERPHONE: "Phone", LEDGERMOBILE: "Mobile", INCOMETAXNUMBER: "PAN", OPENINGBALANCE: "Opening balance", OPENINGVALUE: "Opening value", OPENINGRATE: "Opening rate", BASEUNITS: "Base unit", ADDITIONALUNITS: "Additional unit", CONVERSION: "Conversion", ISSIMPLEUNIT: "Simple unit", DECIMALPLACES: "Decimal places", CATEGORY: "Category", GUID: "GUID", MASTERID: "Master ID", ALTERID: "Alteration ID", REFERENCE: "Reference", REFERENCEDATE: "Reference date", ISCANCELLED: "Cancelled", ISOPTIONAL: "Optional", ISPOSTDATED: "Post-dated", STOCKITEMNAME: "Stock item", ACTUALQTY: "Actual quantity", BILLEDQTY: "Billed quantity", RATE: "Rate", AMOUNT: "Amount", ISDEEMEDPOSITIVE: "Debit flag", GODOWNNAME: "Godown", DESTINATIONGODOWNNAME: "Destination godown", BATCHNAME: "Batch", ORDERNO: "Order number", TRACKINGNUMBER: "Tracking number", LEDGERNAME: "Ledger", GSTCLASS: "GST class", GSTNATURE: "GST nature", BILLTYPE: "Bill type", BILLDATE: "Bill date", ISADVANCE: "Advance flag", BILLCREDITPERIOD: "Credit period", DUEDATE: "Due date", BANKNAME: "Bank", TRANSACTIONTYPE: "Transaction type", PAYMENTFAVOURING: "Favouring", INSTRUMENTNUMBER: "Instrument number", INSTRUMENTDATE: "Instrument date", BANKPARTYNAME: "Bank party", UNIQUEREFERENCENUMBER: "Unique reference", BANKACCOUNTNUMBER: "Bank account", IFSCODE: "IFSC", APPLICABLEFROM: "Applicable from", HSNCODE: "HSN", HSN: "HSN", TAXABILITY: "Taxability", GSTREGISTRATIONNUMBER: "GSTIN", GSTIN: "GSTIN", GSTRATEDUTYHEAD: "Tax head", GSTRATE: "Tax rate" };
const fileBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",")[1]);
  reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
  reader.readAsDataURL(file);
});

export async function viewTally(route, token, ui) {
  if (!["tally-import", "tally-source"].includes(route.name)) return false;
  const { root, api, still, page, esc } = ui;
  const money = (amount) => esc(formatINR(amount));
  const fieldName = (key) => FIELD_NAMES[key] || key;
  const company = route.id ? (await api(`/api/companies/${encodeURIComponent(route.id)}/meta`)).company : undefined;
  if (!still(token)) return true;
  const book = company ? `#/c/${encodeURIComponent(company.id)}` : "#";
  const accountingExport = company ? `<section class="tally-export-section"><h2>Export accounting books to Tally</h2><p>Account groups, ledger openings and accounting voucher postings.</p><div class="tally-download"><label>Accounting XML<select data-accounting-format><option value="masters">All Masters</option><option value="daybook">Day Book</option></select></label><a data-accounting-download href="/api/tally/companies/${encodeURIComponent(company.id)}/export/masters" download>Download XML</a></div></section>` : "";
  const render = (title, body) => {
    document.title = company ? `${title} · ${company.name}` : `${title} · Ledgercraft`;
    root.innerHTML = page({ company, title, folio: "Tl", kicker: "Tally", body: `<div class="tally-workspace">${body}</div>` });
    const format = root.querySelector("[data-accounting-format]");
    format?.addEventListener("change", () => { root.querySelector("[data-accounting-download]").href = `/api/tally/companies/${encodeURIComponent(company.id)}/export/${format.value}`; });
    const original = root.querySelector("[data-original-file]");
    original?.addEventListener("change", () => { root.querySelector("[data-original-download]").href = `/api/tally/companies/${encodeURIComponent(company.id)}/file/${original.value}`; });
  };

  if (route.name === "tally-import") {
    render("Import from Tally", `<details class="tally-guide"><summary>Get your company exports</summary><ol><li>Open the original company in TallyPrime or Tally.ERP 9. Export All Masters with the original ledger opening balances.</li><li>Open Day Book, choose the full books period and export All Vouchers with narration and dependent details. Choose XML Data Interchange or native JSON Data Exchange. A TallyPrime sales GST Excel workbook or its official ZIP can also be imported.</li><li>Choose both exports below and enter the original books beginning date.</li></ol><p>For a native company folder or backup, use the <a href="/tally-bridge.ps1" download>Windows Tally export companion</a> with your licensed Tally installation.</p><p><a href="https://help.tallysolutions.com/how-to-export-import-entire-data-masters-transactions-to-a-new-company/" target="_blank" rel="noreferrer">Tally export instructions</a> · <a href="https://help.tallysolutions.com/tally-prime-integration-using-json-1/" target="_blank" rel="noreferrer">Tally native JSON format</a></p></details><form id="tally-preview-form" class="tally-import-form"><label>Company name<input name="companyName" maxlength="80" placeholder="Name in Tally"/></label><label>Original books beginning date<input type="date" name="booksFrom"/></label><label class="tally-wide">Tally exports, Excel workbook or full Ledgercraft Tally archive<input type="file" name="files" multiple required accept=".txt,.xml,.json,.xlsx,.900,.tsf,.zip,.tbk"/></label><p class="tally-wide quiet">Up to 24 files and 40 MB of source data. Full Ledgercraft Tally archives carry their company name and dates.</p><p id="tally-message" class="tally-wide" role="status" aria-live="polite"></p><div class="tally-wide actions"><button type="submit">Preview import</button></div></form><section id="tally-preview" aria-live="polite"></section>${accountingExport}`);
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
      if (target.childElementCount || button.disabled) message.textContent = "Import settings changed. Preview again to use these settings.";
      if (!committing) button.disabled = false;
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
      message.className = "tally-wide quiet";
      message.textContent = "Reading the source files and checking accounting postings…";
      target.innerHTML = "";
      try {
        const files = [...form.elements.files.files];
        if (!files.length || files.length > 24 || files.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) throw new Error("Choose up to 24 files. Source exports support 40 MB; full archives support 64 MB.");
        const payload = { ...settings, files: await Promise.all(files.map(async (file) => ({ name: file.name, base64: await fileBase64(file) }))) };
        if (!currentPreview()) return;
        const preview = await api("/api/tally/preview", { method: "POST", body: payload });
        if (!currentPreview()) return;
        message.textContent = "Preview ready.";
        const summary = preview.summary;
        const reconciliation = summary.reconciliation;
        const issues = preview.issues;
        target.innerHTML = `<h2>${esc(summary.companyName || "Company preview")}</h2><p>${summary.ledgers} ledgers · ${summary.vouchers} accounting vouchers · ${summary.referenceMasters || 0} additional source masters</p>${reconciliation ? `<table><thead><tr><th>Accounting reconciliation</th><th class="figure">Debit</th><th class="figure">Credit</th></tr></thead><tbody><tr><th>Source accounting postings</th><td class="figure">${money(reconciliation.sourceDebitPaise)}</td><td class="figure">${money(reconciliation.sourceCreditPaise)}</td></tr><tr class="total"><th>Ledgercraft postings</th><td class="figure">${money(reconciliation.postedDebitPaise)}</td><td class="figure">${money(reconciliation.postedCreditPaise)}</td></tr></tbody></table><p>${reconciliation.sourceVouchers} source vouchers · ${reconciliation.postedVouchers} posted · ${reconciliation.excludedVouchers} nonposting · ${reconciliation.duplicateVouchers || 0} identical duplicates · ${reconciliation.failedVouchers} exceptions</p>` : `<p>Restoring the saved company and its original Tally source files.</p>`}${summary.trial ? `<p>Projected trial balance ${money(summary.trial.debit)} Dr = ${money(summary.trial.credit)} Cr. Difference ${money(Math.abs(summary.trial.difference))}.</p>` : ""}<h3>Source files</h3><ul class="tally-source-files">${preview.files.map((file) => `<li><strong>${esc(file.name)}</strong> · ${esc(file.encoding || "original bytes")}<small>SHA-256 ${esc(file.sha256)}</small></li>`).join("")}</ul>${issues.length ? `<h3>Import review</h3><ol class="tally-issues">${issues.slice(0, 100).map((issue) => `<li class="${issue.severity === "blocking" ? "tally-blocker" : ""}"><strong>${issue.severity === "blocking" ? "Resolve" : issue.severity === "review" ? "Review" : "Retained"}</strong> — ${esc(issue.message)}</li>`).join("")}</ol>${issues.length > 100 ? `<p>${issues.length - 100} further entries are included in the complete import report.</p>` : ""}` : `<p>The source accounting postings passed the import checks.</p>`}<p><a href="/api/tally/preview/${preview.token}/report" download>Download complete import report</a></p>${preview.canCommit ? `<form id="tally-confirm"><label class="tally-confirm"><input type="checkbox" required/>I reviewed the postings and source details for this import.</label><div class="actions"><button type="submit">Create imported company</button></div><p data-commit-status role="status"></p></form>` : `<p class="alert">Resolve the listed exceptions and preview the exports again.</p>`}`;
        if (summary.billReferences) {
          const bills = summary.billReferences;
          target.querySelector("h2").insertAdjacentHTML("afterend", `<p class="tally-bill-preview">Bill-wise projection · ${bills.billsReady} bill references · ${bills.allocationsReady} settlement allocations · ${bills.exceptions} source exceptions retained</p>`);
        }
        if (summary.stockProjection) {
          const stock = summary.stockProjection;
          target.querySelector("h2").insertAdjacentHTML("afterend", `<p>Stock from Tally · ${stock.items} items · ${stock.receiptLines} receipt lines · ${stock.issueLines} issue lines · ${stock.transferLines} transfer lines · ${stock.exceptions} source exceptions retained</p>`);
        }
        if (summary.openingScope) {
          const scope = summary.openingScope;
          target.querySelector("h2").insertAdjacentHTML("afterend", `<p class="tally-opening-scope"><strong>${scope.transactionOnly ? "Transactions only" : "Opening balance scope"}</strong> · ${esc(scope.message)}</p>`);
        }
        if (summary.openingScope?.billedOnlyLines) {
          const section = document.createElement("section");
          section.className = "tally-group-mappings";
          section.innerHTML = `<h3>Physical stock quantities</h3><p>${esc(summary.openingScope.billedOnlyLines)} source item lines supply billed quantities without actual quantities.</p><label class="tally-confirm"><input type="checkbox" data-billed-as-actual${useBilledAsActual ? " checked" : ""}>Actual quantities match billed quantities where the workbook omits actual quantities.</label><button type="button" class="ghost" data-recheck-quantities>Recalculate preview</button>`;
          section.querySelector("[data-billed-as-actual]").addEventListener("change", event => { useBilledAsActual = event.target.checked; invalidatePreview(); });
          section.querySelector("[data-recheck-quantities]").addEventListener("click", () => form.requestSubmit());
          target.querySelector("#tally-confirm")?.before(section);
          if (!section.isConnected) target.append(section);
        }
        if (summary.gstReadiness) {
          const gst = summary.gstReadiness;
          target.querySelector("h2").insertAdjacentHTML("afterend", `<p class="tally-gst-preview">GST source · ${esc(gst.sourceSales)} sales · source item value ₹${money(gst.itemValuePaise ?? gst.sourceItemValuePaise ?? gst.taxablePaise)} · tax ₹${money(gst.taxPaise)}. Review seller registration, customer and HSN mappings in Tally source after import.</p>`);
        }
        if (preview.accountGroupMappings?.length) {
          const section = document.createElement("section");
          section.className = "tally-group-mappings";
          section.innerHTML = `<h3>Referenced ledger groups</h3><p>Choose the account group for ledgers whose role is absent from the workbook. Recalculate to check the resulting books.</p>${preview.accountGroupMappings.map(row => `<label>${esc(row.sourceName)}${row.required ? " · required" : ""}<select data-account-group="${esc(row.sourceName)}"><option value="">Choose account group</option>${preview.accountGroups.map(group => `<option value="${esc(group.id)}"${(accountGroupMappings[row.sourceName] || row.groupId) === group.id ? " selected" : ""}>${esc(group.name)}</option>`).join("")}</select><small>${esc(row.reason || "")}</small></label>`).join("")}<button type="button" class="ghost" data-recheck-groups>Recalculate preview</button>`;
          for (const select of section.querySelectorAll("[data-account-group]")) select.addEventListener("change", () => {
            accountGroupMappings[select.dataset.accountGroup] = select.value;
            invalidatePreview();
          });
          section.querySelector("[data-recheck-groups]").addEventListener("click", () => form.requestSubmit());
          target.querySelector("#tally-confirm")?.before(section);
          if (!section.isConnected) target.append(section);
        }
        if (preview.overlaps?.length) {
          const section = document.createElement("section");
          section.className = "tally-group-mappings tally-overlap-review";
          section.innerHTML = `<h3>Overlapping voucher exports</h3><p>These source records share a voucher type, date and number across files. Choose the authoritative source to post once, or confirm that every listed record is a separate transaction.</p>${preview.overlaps.map(group => `<label>${esc(group.type)} ${esc(group.number)} · ${esc(/^\d{4}-\d{2}-\d{2}$/.test(group.date || "") ? group.date.split("-").reverse().join("-") : group.date)}<select data-overlap-choice="${esc(group.key)}"><option value="">Choose which source to post</option>${group.records.map(record => `<option value="${esc(record.recordId)}"${(overlapChoices[group.key] || group.choice) === record.recordId ? " selected" : ""}>${esc(record.file)} · ${esc(record.party || "Source party")} · ₹${money(record.amountPaise)}</option>`).join("")}<option value="distinct"${(overlapChoices[group.key] || group.choice) === "distinct" ? " selected" : ""}>All listed records are distinct transactions</option></select></label>`).join("")}<button type="button" class="ghost" data-recheck-overlaps>Recalculate preview</button>`;
          for (const select of section.querySelectorAll("[data-overlap-choice]")) select.addEventListener("change", () => { overlapChoices[select.dataset.overlapChoice] = select.value; invalidatePreview(); });
          section.querySelector("[data-recheck-overlaps]").addEventListener("click", () => form.requestSubmit());
          target.querySelector("#tally-confirm")?.before(section);
          if (!section.isConnected) target.append(section);
        }
        const conflicts = issues.filter(i=>i.code==="posting-sign-conflict");
        if (conflicts.length) {
          const section = document.createElement("section");
          section.innerHTML = `<h3>Resolve posting signs</h3>${conflicts.map(i=>`<p>${esc(i.message)}</p><label>Use for this voucher <select data-sign-choice="${esc(i.reference)}"><option value="">Choose the source of debit and credit</option><option value="signed-amounts">Signed amounts</option><option value="debit-credit-flags">Debit and credit flags</option></select></label>`).join("")}
            ${preview.mapping.filter(m=>m.signChoice).map(m=>`<p>${esc(m.type)} ${esc(m.number)} · ${m.lines.map(l=>esc(l.ledger)+" "+esc(l.dc)+" ₹"+money(l.paise)).join(" · ")}</p>`).join("")}
            <p><button type="button" class="secondary" data-recheck>Recalculate preview</button></p>`;
          for (const select of section.querySelectorAll("[data-sign-choice]")) {
            select.value = signChoices[select.dataset.signChoice] || "";
            select.onchange = () => { signChoices[select.dataset.signChoice] = select.value; invalidatePreview(); };
          }
          section.querySelector("[data-recheck]").onclick = () => form.requestSubmit();
          target.querySelector("#tally-confirm")?.before(section);
          if (!section.isConnected) target.append(section);
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
          status.textContent = "Creating the company and preserving its source files…";
          try {
            const created = await api("/api/tally/commit", { method: "POST", body: { token: preview.token, acknowledge: true, compact: true } });
            if (!currentPreview()) return;
            sessionStorage.setItem("financer-flash", "Tally company imported. Original files and source details are available in Tally source.");
            location.hash = `#/c/${encodeURIComponent(created.company.id)}/tally-source`;
          } catch (error) { if (currentPreview()) { status.className = "alert"; status.textContent = error.message; } }
          finally { committing = false; if (form.isConnected) controls.forEach((control, index) => { control.disabled = previousDisabled[index]; }); }
        });
      } catch (error) { if (currentPreview()) { message.className = "tally-wide alert"; message.textContent = error.message; } }
      finally { if (request === previewRequest && !committing) button.disabled = false; }
    });
    return true;
  }

  if (!company) throw new Error("Open an imported Tally company to view its source records");
  const base = `/api/tally/companies/${encodeURIComponent(company.id)}`;
  const originalFiles = await api(`${base}/files`);
  if (!still(token)) return true;
  const originalDownload = `<section class="tally-export-section"><h2>Original Tally files</h2><p>${originalFiles.unchangedSinceImport === true ? "The imported books match their original import state." : "These files contain the original captured Tally snapshot."}</p><div class="tally-download"><label>Original file<select data-original-file>${originalFiles.files.map((file) => `<option value="${file.index}">${esc(file.name)}</option>`).join("")}</select></label><a data-original-download href="${base}/file/0" download>Download original file</a></div></section>`;
  const tools = `<div class="actions tally-toolbar"><a href="${book}/tally-source">Source records</a><a href="${base}/archive" download>Download full Tally archive</a><a href="#/tally-import">Import another company</a></div><details class="tally-export-menu"><summary>Export files</summary>${accountingExport}${originalDownload}</details>`;
  const fields = (input) => `<dl class="tally-fields">${Object.entries(input).map(([key, entry]) => `<dt>${esc(fieldName(key))}</dt><dd>${esc(entry)}</dd>`).join("")}</dl>`;
  const table = (title, rows) => {
    if (!rows.length) return "";
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    return `<section class="tally-data-section"><h2>${esc(title)}</h2><div class="tally-table-scroll"><table><thead><tr>${columns.map((key) => `<th>${esc(fieldName(key))}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((key) => `<td>${esc(row[key] ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>`;
  };
  if (route.detail) {
    const { record } = await api(`${base}/record/${encodeURIComponent(route.detail)}`);
    if (!still(token)) return true;
    render(record.name, `${tools}<p>${esc(TYPE_NAMES[record.type] || record.type)} · ${esc(STATUS_NAMES[record.status] || record.status)} · ${esc(record.file)}</p>${record.reason ? `<p>${esc(record.reason)}</p>` : ""}${record.editedAfterImport ? `<p class="status">The accounting voucher was edited after import. These are its original Tally source details.</p>` : ""}${record.deletedAfterImport ? `<p class="status">The accounting voucher was deleted after import. Its original Tally source details are retained.</p>` : ""}${record.voucherId && !record.deletedAfterImport ? `<p><a href="${book}/v/${encodeURIComponent(record.voucherType || record.sourceType)}/${encodeURIComponent(record.voucherId)}">Open accounting voucher</a></p>` : ""}${fields(record.fields)}${record.address.length ? `<h2>Address</h2><p>${record.address.map(esc).join("<br/>")}</p>` : ""}${record.hsn.length ? `<h2>HSN</h2><p>${record.hsn.map(esc).join(", ")}</p>` : ""}${table("Inventory lines", record.inventory)}${table("Batches & godowns", record.batches)}${table("Accounting allocations", record.accounting)}${table("Bill references", record.bills)}${table("Bank references", record.banks)}${table("Cost allocations", record.costs)}${table("Tax source details", record.taxes)}${record.transport && Object.keys(record.transport).length ? table("Transport and e-invoice source references", [record.transport]) : ""}${(record.spreadsheet || []).map(row => table(`Spreadsheet source · ${row.sheet} · row ${row.row}`, row.cells)).join("")}<details class="tally-original"><summary>Complete source fields</summary><pre>${esc(JSON.stringify(record.original, null, 2))}</pre></details>`);
    return true;
  }
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const result = await api(`${base}/records?${params}`);
  if (!still(token)) return true;
  render("Tally source", `${tools}<p>${Object.entries(result.counts).map(([type, count]) => `${count} ${TYPE_NAMES[type] || type.toLowerCase()}`).join(" · ")}</p><form id="tally-source-filter" class="tally-source-filter"><label>Record type<select name="type"><option value="">All source records</option>${Object.keys(result.counts).map((type) => `<option value="${esc(type)}"${params.get("type") === type ? " selected" : ""}>${esc(TYPE_NAMES[type] || type)}</option>`).join("")}</select></label><label>Find name, GSTIN, HSN or date<input type="search" name="q" value="${esc(params.get("q") || "")}"/></label><button type="submit">Find</button></form><p>${result.total} matching records</p><table><thead><tr><th>Name / number</th><th>Type</th><th>Details</th><th>Status</th></tr></thead><tbody>${result.records.map((record) => `<tr><th><a href="${book}/tally-source/${encodeURIComponent(record.recordId)}">${esc(record.name)}</a></th><td>${esc(record.type === "VOUCHER" ? record.sourceType : TYPE_NAMES[record.type] || record.type)}</td><td>${esc([record.date, record.parent, record.hsn, record.gstin].filter(Boolean).join(" · "))}</td><td>${esc(STATUS_NAMES[record.status] || record.status)}</td></tr>`).join("") || '<tr><td colspan="4">No matching source records.</td></tr>'}</tbody></table><div class="actions">${result.offset > 0 ? `<a href="${book}/tally-source?${new URLSearchParams({ ...Object.fromEntries(params), offset: String(Math.max(0, result.offset - 100)) })}">Previous 100</a>` : ""}${result.offset + 100 < result.total ? `<a href="${book}/tally-source?${new URLSearchParams({ ...Object.fromEntries(params), offset: String(result.offset + 100) })}">Next 100</a>` : ""}</div>`);
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

async function installTallyStockReview({ root, api, esc, base, book, still, token, focus }) {
  const section = document.createElement("section");
  section.className = "tally-bill-review";
  section.innerHTML = '<h2>Stock from Tally</h2><p data-stock-source-summary role="status">Reading stock masters and movements…</p><details data-stock-source-details><summary>Review stock activation</summary><div data-stock-source-rows></div><div data-stock-source-actions></div><p data-stock-source-error role="alert"></p></details>';
  root.querySelector(".tally-workspace").append(section);
  let state, offset = 0;
  const show = async () => {
    try {
      state = await api(`${base}/stock?offset=${offset}`);
      if (!still(token)) return;
      const summary = state.summary;
      section.querySelector("[data-stock-source-summary]").textContent = `${summary.items} supported items · ${summary.journals} stock journals · ${summary.exceptions} source exceptions · ${summary.alreadyActive ? "Activated" : "Source review"}`;
      section.querySelector("[data-stock-source-rows]").innerHTML = `<table><thead><tr><th>Source</th><th>Opening quantity / value</th><th>Status</th></tr></thead><tbody>${state.rows.map(row => `<tr><th scope="row"><a href="${book}/tally-source/${encodeURIComponent(row.recordId)}">${esc(row.name)}</a></th><td>${row.quantity !== undefined ? esc(row.quantity + " " + row.unit) : "—"}${row.valuePaise !== undefined ? `<small>${row.valuePaise === null ? "Opening value missing" : esc(formatINR(row.valuePaise))}</small>` : ""}</td><td><strong>${esc(row.status === "exception" ? "Source exception" : row.status === "active" ? "Active" : "Ready")}</strong><small>${esc(row.message)}</small></td></tr>`).join("") || '<tr><td colspan="3">No stock masters or movements were exported.</td></tr>'}</tbody></table>${state.issues.length ? `<ul>${state.issues.slice(0, 30).map(issue => `<li>${esc(issue.message)}</li>`).join("")}</ul>` : ""}<div class="actions">${offset ? '<button class="ghost" type="button" data-stock-source-previous>Previous stock records</button>' : ""}${offset + 100 < state.total ? '<button class="ghost" type="button" data-stock-source-next>More stock records</button>' : ""}</div>`;
      section.querySelector("[data-stock-source-actions]").innerHTML = `<p><a href="${book}/stock">Open stock register</a> · <a href="${base}/stock/report" download>Download complete stock review</a></p>${state.canActivate ? `<button type="button" data-activate-tally-stock>${summary.emptySource ? "Confirm empty stock source" : "Activate supported stock"}</button>` : ""}`;
      section.querySelector("[data-stock-source-previous]")?.addEventListener("click", () => { offset = Math.max(0, offset - 100); show(); });
      section.querySelector("[data-stock-source-next]")?.addEventListener("click", () => { offset += 100; show(); });
      section.querySelector("[data-activate-tally-stock]")?.addEventListener("click", async event => {
        const button = event.currentTarget;
        button.disabled = true;
        button.dataset.requestId ||= crypto.randomUUID();
        try {
          await api(`${base}/stock/activate`, { method: "POST", body: { reviewHash: state.reviewHash, requestId: button.dataset.requestId } });
          if (!still(token)) return;
          await show();
        } catch (error) { section.querySelector("[data-stock-source-error]").textContent = error.message; button.disabled = false; }
      });
    } catch (error) {
      section.querySelector("[data-stock-source-error]").textContent = error.message;
      section.querySelector("[data-stock-source-summary]").textContent = "Stock source review could not open.";
    }
  };
  await show();
  if (focus && still(token)) { section.querySelector("details").open = true; section.scrollIntoView({ block: "start" }); }
}

async function installTallyBillReview({ root, api, esc, base, book, still, token }) {
  const section = document.createElement("section");
  section.className = "tally-bill-review";
  section.innerHTML = '<h2>Bill-wise references</h2><p data-bill-review-summary role="status">Reading source references…</p><details><summary>Review bill activation</summary><form data-bill-review-filter class="tally-bill-filters"><label>Reference or party<input name="q" type="search"></label><label>Reference status<select name="status"><option value="">All references</option><option value="ready">Ready to activate</option><option value="exception">Retained source exceptions</option><option value="active">Active references</option><option value="edited">Edited after activation</option><option value="on-account">On account</option><option value="removed">Removed after activation</option></select></label><button type="submit" class="ghost">Apply reference filter</button></form><div data-bill-review-rows></div><div data-bill-review-actions></div><p data-bill-review-error role="alert"></p></details>';
  root.querySelector(".tally-workspace").append(section);
  let state, offset = 0;
  const label = { ready: "Ready", active: "Active", edited: "Edited", reused: "Existing reference", removed: "Removed", exception: "Source exception", "on-account": "On account", pending: "Source review" };
  const dateLabel = date => /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date.split("-").reverse().join("-") : "—";
  const filter = section.querySelector("[data-bill-review-filter]");
  const show = async () => {
    const query = new URLSearchParams({ ...Object.fromEntries(new FormData(filter)), offset: String(offset) });
    try {
      const current = await api(`${base}/bills?${query}`);
      if (!still(token)) return;
      state = current;
      const summary = current.summary;
      section.querySelector("[data-bill-review-summary]").textContent = `${summary.activeBills} active bill references · ${summary.activeAllocations} active allocations · ${summary.billsReady + summary.allocationsReady} ready · ${summary.exceptions} source exceptions`;
      section.querySelector("[data-bill-review-rows]").innerHTML = `<table><thead><tr><th>Party / source</th><th>Reference / method</th><th>Bill / due date</th><th class="figure">Amount ₹</th><th>Status</th></tr></thead><tbody>${current.rows.map(row => `<tr><th scope="row">${esc(row.partyName)}<small><a href="${book}/tally-source/${encodeURIComponent(row.recordId)}">Open source record</a></small></th><td>${esc(row.reference || "—")}<small>${esc(row.method)}</small></td><td>${dateLabel(row.date)}<small>Due ${dateLabel(row.dueDate)}</small></td><td class="figure">${esc(formatINR(row.paise))}</td><td><strong>${esc(label[row.status] || row.status)}</strong><small>${esc(row.message)}</small></td></tr>`).join("") || '<tr><td colspan="5" class="quiet">No bill references match this filter.</td></tr>'}</tbody></table><p class="quiet">${current.total} matching source references</p><div class="actions">${offset ? '<button type="button" class="ghost" data-bill-previous>Previous bill references</button>' : ""}${offset + 100 < current.total ? '<button type="button" class="ghost" data-bill-next>More bill references</button>' : ""}</div>`;
      section.querySelector("[data-bill-review-actions]").innerHTML = `<p><a href="${base}/bills/report" download>Download complete bill reference review</a></p>${current.canActivate ? '<button type="button" data-activate-tally-bills>Activate supported bill references</button>' : ""}`;
      section.querySelector("[data-bill-previous]")?.addEventListener("click", () => { offset = Math.max(0, offset - 100); show(); });
      section.querySelector("[data-bill-next]")?.addEventListener("click", () => { offset += 100; show(); });
      section.querySelector("[data-activate-tally-bills]")?.addEventListener("click", async event => {
        const button = event.target;
        button.disabled = true;
        button.dataset.requestId ||= crypto.randomUUID();
        try {
          const response = await api(`${base}/bills/activate`, { method: "POST", body: { revision: state.revision, reviewHash: state.reviewHash, requestId: button.dataset.requestId } });
          if (!still(token)) return;
          await show();
          section.querySelector("[data-bill-review-summary]").textContent += ` · Saved ${response.result.activatedBills} bill references and ${response.result.activatedAllocations} allocations`;
        } catch (error) {
          section.querySelector("[data-bill-review-error]").textContent = error.message;
          button.disabled = false;
        }
      });
    } catch (error) {
      section.querySelector("[data-bill-review-error]").textContent = error.message;
      section.querySelector("[data-bill-review-summary]").textContent = "Bill source review could not open.";
    }
  };
  filter.addEventListener("submit", event => { event.preventDefault(); offset = 0; show(); });
  await show();
}
