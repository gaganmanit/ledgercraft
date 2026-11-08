const TOOL_NAMES = new Set(["group-summary", "cash-bank", "outstanding", "transfer", "voucher-print"]);

function dateLabel(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.split("-").reverse().join("-") : value || "";
}

/* The printed voucher is the document itself: in print the sheet heading and any
   page message give way to the letterhead below. The rule lives with the view so it
   disappears as soon as another page renders. */
const VOUCHER_PRINT_STYLE = `<style>
.voucher-doc > header { display: grid; gap: 4px; padding-bottom: 14px; }
.voucher-doc .voucher-letterhead { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -.01em; }
.voucher-doc .voucher-letterhead-detail { margin: 0; font-size: 13px; color: var(--ink-2); white-space: pre-line; }
.voucher-doc > header h2 { margin: 6px 0 0; font-size: 18px; }
.voucher-doc .voucher-narration { margin: 20px 0 0; }
.voucher-doc .voucher-narration h3 { font-size: 13px; font-weight: 500; color: var(--ink-2); }
.voucher-doc .voucher-narration p { margin: 4px 0 0; white-space: pre-wrap; }
@media print {
  .sheet > .sheet-head, .sheet > .print-company, .sheet > .alert, .sheet > .status, .voucher-print-tools { display: none !important; }
  .voucher-doc { margin-top: 0; break-inside: avoid; }
  .voucher-doc .voucher-letterhead { font-size: 16pt; }
  .voucher-doc > header h2 { font-size: 13pt; }
  .voucher-doc .voucher-letterhead-detail { color: #333; font-size: 9.5pt; }
  .voucher-doc .voucher-narration, .voucher-doc .voucher-signatures { break-inside: avoid; }
  .voucher-doc .voucher-signatures { break-before: avoid; margin-top: 56pt; }
}
</style>`;

export async function viewBookTool(route, token, ui) {
  if (!TOOL_NAMES.has(route.name)) return false;
  const { root, api, still, page, esc, readPeriod, periodBar, bindPeriod, formatINR } = ui;
  const bundle = route.id ? await api(`/api/companies/${encodeURIComponent(route.id)}${route.name === "voucher-print" ? `/vouchers/${encodeURIComponent(route.detail || "")}` : route.name === "transfer" ? "/masters" : "/meta"}`) : null;
  if (!still(token)) return true;
  const company = bundle?.company;
  const id = company?.id;
  const base = id ? `/api/companies/${encodeURIComponent(id)}` : "";
  const range = company ? readPeriod(company) : null;
  const query = range ? `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : "";
  const money = (amount) => esc(formatINR(amount));
  const ledgerLink = (row) => `<a href="#/c/${esc(id)}/ledger/${esc(row.ledgerId)}">${esc(row.name)}</a>`;
  const closing = (row) => `${money(row.closing.paise)} <span class="dc">${esc(row.closing.dc)}</span>`;
  const amountCell = (paise) => paise ? `<td class="figure">${money(paise)}</td>` : `<td class="figure quiet">—</td>`;
  const emptyRow = (columns, text) => `<tr><td colspan="${columns}" class="quiet">${text}</td></tr>`;
  const scroll = (table) => `<div class="table-scroll">${table}</div>`;
  const render = (title, body) => {
    document.title = company ? `${title} · ${company.name}` : `${title} · Ledgercraft`;
    root.innerHTML = page({ company, title, body });
    root.querySelector("[data-print]")?.addEventListener("click", () => window.print());
    if (company && route.name !== "voucher-print" && route.name !== "transfer") bindPeriod(company);
  };

  if (route.name === "transfer") {
    const tallySource = company?.source?.system === "tally" && company.source.archive !== "accounting-only";
    const exports = [["daybook", "Download day book XML"], ["trial-balance", "Download trial balance XML"], ["vouchers", "Download vouchers XML"]];
    const downloads = company
      ? `<section class="transfer-section"><h2>Save a copy of these books</h2><p>The company backup holds every ledger and voucher.${tallySource ? " Original Tally files and source details travel with it." : ""}</p><div class="book-toolbar"><a class="button" href="${base}/backup" download>Download company backup</a></div><h3>Export the current period</h3><p>Exports cover ${esc(dateLabel(range.from))} to ${esc(dateLabel(range.to))}. <button type="button" class="link" data-focus-period>Change period</button></p><div class="book-toolbar">${exports.map(([name, label]) => `<a class="button ghost" href="${base}/export/${name}?${query}" download>${label}</a>`).join("")}</div></section>`
      : `<section class="transfer-section"><h2>Save a copy of a company</h2><p>Open a company from <a href="#/">the companies list</a> to download its backup or export its books. To bring books onto this Mac, import them below.</p></section>`;
    render("Import & export", `${downloads}<section class="transfer-section"><h2>Import a company</h2><p>Choose a Ledgercraft backup, or select both company.json and vouchers.json from a company folder. The imported company opens as a new set of books.</p><form id="book-import"><label for="book-files">Company files</label><input id="book-files" name="files" type="file" accept=".json,application/json" multiple required/><div class="book-toolbar"><button type="submit">Import company</button></div><p id="import-status" class="form-message" role="status" aria-live="polite"></p></form></section>`);
    const form = root.querySelector("#book-import");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector("button");
      const status = form.querySelector("#import-status");
      button.disabled = true;
      status.className = "form-message quiet";
      status.setAttribute("role", "status");
      status.textContent = "Reading the company files…";
      try {
        const files = [...form.elements.files.files];
        if (files.length < 1 || files.length > 2 || files.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) throw new Error("Choose one Ledgercraft backup, or company.json and vouchers.json together. The selection can total up to 64 MB.");
        let input;
        if (files.length === 1) input = JSON.parse(await files[0].text());
        else {
          const companyFile = files.find((file) => file.name.toLowerCase() === "company.json");
          const vouchersFile = files.find((file) => file.name.toLowerCase() === "vouchers.json");
          if (!companyFile || !vouchersFile) throw new Error("Two files were chosen, but they are not company.json and vouchers.json. Choose those two files from the company folder, or a single backup file.");
          input = { company: JSON.parse(await companyFile.text()), vouchers: JSON.parse(await vouchersFile.text()) };
        }
        const imported = await api("/api/import", { method: "POST", body: input });
        if (!still(token)) return;
        sessionStorage.setItem("financer-flash", "Company imported. All ledgers and vouchers are ready.");
        location.hash = `#/c/${encodeURIComponent(imported.company.id)}`;
      } catch (error) {
        status.className = "form-message alert";
        status.setAttribute("role", "alert");
        status.textContent = error instanceof SyntaxError ? "One of the selected files is not valid JSON. Choose the backup file Ledgercraft saved, or company.json and vouchers.json from the company folder." : error.message;
        status.scrollIntoView({ block: "nearest" });
      } finally {
        button.disabled = false;
      }
    });
    return true;
  }

  if (!company) throw new Error("Open a company to view this statement");
  if (route.name === "voucher-print") {
    const voucher = bundle.voucher;
    if (!voucher) throw new Error("That voucher is not in this company. Open the day book to find it.");
    const names = new Map(company.ledgers.map((ledger) => [ledger.id, ledger.name]));
    const total = voucher.lines.reduce((sum, line) => sum + (line.dc === "Dr" ? line.paise : 0), 0);
    const lines = voucher.lines.map((line) => `<tr><th scope="row">${esc(names.get(line.ledgerId) || "Ledger no longer in these books")}</th>${amountCell(line.dc === "Dr" ? line.paise : 0)}${amountCell(line.dc === "Cr" ? line.paise : 0)}</tr>`).join("");
    /* With a single GST registration its address and GSTIN complete the letterhead. With several, the
       voucher does not say which one it belongs to, so only the company name is printed. */
    const registrations = company.gst?.registrations || [];
    const seller = registrations.length === 1 ? registrations[0] : null;
    const letterhead = seller
      ? `${seller.address ? `<p class="voucher-letterhead-detail">${esc([seller.address, seller.pincode].filter(Boolean).join(" "))}</p>` : ""}<p class="voucher-letterhead-detail">GSTIN <span class="code">${esc(seller.gstin)}</span></p>`
      : "";
    const title = `${voucher.type} voucher`;
    render(`${title} ${voucher.number}`, `${VOUCHER_PRINT_STYLE}<div class="actions voucher-print-tools"><button type="button" data-print>Print voucher</button><a href="#/c/${esc(id)}/v/${encodeURIComponent(voucher.type)}/${encodeURIComponent(voucher.id)}">Back to voucher</a></div>
      <article class="doc voucher-doc" aria-label="${esc(title)} ${esc(voucher.number)}">
        <header><p class="voucher-letterhead">${esc(company.name)}</p>${letterhead}<h2>${esc(title)}</h2></header>
        <div class="doc-head"><div><span>Voucher number</span><strong class="code">${esc(voucher.number)}</strong></div><div><span>Date</span><strong>${esc(dateLabel(voucher.date))}</strong></div></div>
        <table class="voucher-lines"><thead><tr><th>Particulars</th><th class="figure">Debit (₹)</th><th class="figure">Credit (₹)</th></tr></thead><tbody>${lines}</tbody><tfoot><tr class="total"><th scope="row">Total</th><td class="figure">${money(total)}</td><td class="figure">${money(total)}</td></tr></tfoot></table>
        ${voucher.narration ? `<section class="voucher-narration"><h3>Narration</h3><p>${esc(voucher.narration)}</p></section>` : ""}
        <div class="voucher-signatures"><span>Prepared by</span><span>Authorised by</span></div>
      </article>`);
    return true;
  }

  const detail = route.name === "group-summary" && route.detail ? `&group=${encodeURIComponent(route.detail)}` : "";
  const report = await api(`${base}/reports/${route.name}?${query}${detail}`);
  if (!still(token)) return true;
  const toolbar = periodBar(range);
  if (route.name === "group-summary") {
    const groupRow = (row) => `<tr><th scope="row"><a href="#/c/${esc(id)}/group-summary/${esc(row.groupId)}">${esc(row.name)}</a>${row.path && row.path !== row.name ? `<div class="quiet group-path">${esc(row.path)}</div>` : ""}</th>${amountCell(row.periodDr)}${amountCell(row.periodCr)}${amountCell(row.debit)}${amountCell(row.credit)}</tr>`;
    const rows = report.group
      ? (report.childGroups || []).map(groupRow).concat(report.ledgers.map((row) => `<tr><th scope="row">${ledgerLink(row)}</th>${amountCell(row.periodDr)}${amountCell(row.periodCr)}${amountCell(row.closing.dc === "Dr" ? row.closing.paise : 0)}${amountCell(row.closing.dc === "Cr" ? row.closing.paise : 0)}</tr>`))
      : report.rows.map(groupRow);
    const empty = report.group
      ? "No ledger in this group has a balance in this period. Widen the period in the top bar, or pass a voucher to one of its ledgers."
      : "No group has a balance in this period. Widen the period in the top bar, or pass a voucher to start the books.";
    render(report.group?.name || "Group summary", `${toolbar}${report.group ? `<p class="actions"><a href="#/c/${esc(id)}/group-summary">All groups</a></p>` : ""}${scroll(`<table><thead><tr><th>${report.group ? (report.childGroups?.length ? "Subgroup or ledger" : "Ledger") : "Group"}</th><th class="figure">Period debit</th><th class="figure">Period credit</th><th class="figure">Closing debit</th><th class="figure">Closing credit</th></tr></thead><tbody>${rows.join("") || emptyRow(5, empty)}</tbody><tfoot><tr class="total"><th scope="row" colspan="3">Closing totals</th><td class="figure">${money(report.debit)}</td><td class="figure">${money(report.credit)}</td></tr></tfoot></table>`)}`);
    return true;
  }
  if (route.name === "cash-bank") {
    const balances = report.balances.map((row) => `<tr><th scope="row">${ledgerLink(row)}</th><td class="figure">${money(row.opening.paise)} <span class="dc">${esc(row.opening.dc)}</span></td>${amountCell(row.periodDr)}${amountCell(row.periodCr)}<td class="figure">${closing(row)}</td></tr>`).join("");
    const vouchers = report.rows.map((row) => `<tr><td class="date-cell">${esc(dateLabel(row.date))}</td><td><a class="code" href="#/c/${esc(id)}/v/${encodeURIComponent(row.type)}/${esc(row.id)}">${esc(row.number)}</a></td><td>${esc(row.particulars)}${row.narration ? `<div class="quiet">${esc(row.narration)}</div>` : ""}</td><td class="figure">${money(row.paise)}</td></tr>`).join("");
    render("Cash & bank book", `${toolbar}${scroll(`<table><thead><tr><th>Account</th><th class="figure">Opening</th><th class="figure">Receipts</th><th class="figure">Payments</th><th class="figure">Closing</th></tr></thead><tbody>${balances || emptyRow(5, `No cash or bank ledger yet. Add one under Cash-in-hand or Bank accounts on the <a href="#/c/${esc(id)}/ledgers">ledgers page</a>.`)}</tbody><tfoot><tr class="total"><th scope="row" colspan="4">Net cash & bank</th><td class="figure">${money(Math.abs(report.cashBank))} <span class="dc">${report.cashBank < 0 ? "Cr" : "Dr"}</span></td></tr></tfoot></table>`)}<h2>Vouchers through cash & bank</h2>${scroll(`<table><thead><tr><th>Date</th><th>Voucher</th><th>Particulars</th><th class="figure">Amount (₹)</th></tr></thead><tbody>${vouchers || emptyRow(4, `No cash or bank vouchers in this period. Widen the period in the top bar, or pass a <a href="#/c/${esc(id)}/v/Receipt">receipt</a> or <a href="#/c/${esc(id)}/v/Payment">payment</a>.`)}</tbody></table>`)}`);
    return true;
  }
  const partyEmpty = {
    debtors: `No customer has a balance on ${esc(dateLabel(range.to))}. Pass a <a href="#/c/${esc(id)}/v/Sales">sales voucher</a> to a customer ledger, or move the period end in the top bar.`,
    creditors: `No supplier has a balance on ${esc(dateLabel(range.to))}. Pass a <a href="#/c/${esc(id)}/v/Purchase">purchase voucher</a> to a supplier ledger, or move the period end in the top bar.`,
  };
  /* Ageing buckets arrive in a fixed order (current, 1-30, 31-60, 61-90, 91-180, over180); the
     column headings follow the labels the report sends so custom limits still read correctly. */
  const ageing = report.ageing || {};
  const bucketTemplate = ageing.receivable?.buckets || ageing.payable?.buckets || [];
  const bucketHeading = (label) => label === "current" ? "Current" : /^over\d+$/.test(label) ? `Over ${label.slice(4)}` : label;
  const bucketCells = (buckets) => bucketTemplate.map((_, index) => amountCell(buckets?.[index]?.paise || 0)).join("");
  const columns = 4 + bucketTemplate.length;
  const partyRow = (row) => {
    const notes = [
      row.msme && row.msmeOverduePaise ? `<div class="quiet">₹${money(row.msmeOverduePaise)} beyond 45 days</div>` : "",
      row.advancePaise ? `<div class="quiet">₹${money(row.advancePaise)} paid in advance</div>` : "",
    ].join("");
    return `<tr><th scope="row"><a href="#/c/${esc(id)}/parties/${esc(row.ledgerId)}">${esc(row.name)}</a>${row.msme ? ` <span class="pill warn">MSME</span>` : ""}${notes}</th><td class="figure">${closing(row)}</td>${bucketCells(row.ageing)}${amountCell(row.overduePaise || 0)}<td><a class="button ghost" href="#/c/${esc(id)}/ledger/${esc(row.ledgerId)}" aria-label="Ledger report for ${esc(row.name)}">Ledger</a></td></tr>`;
  };
  const partyRows = (key) => report[key].map(partyRow).join("") || emptyRow(columns, partyEmpty[key]);
  const total = (amount, normal) => `${money(Math.abs(amount))}${amount < 0 ? ` <span class="dc">${normal === "Dr" ? "Cr" : "Dr"}</span>` : ""}`;
  const sections = [
    ["debtors", "Sundry debtors", "Net receivable", report.receivable, "Dr", ageing.receivable],
    ["creditors", "Sundry creditors", "Net payable", report.payable, "Cr", ageing.payable],
  ];
  const visible = sections.filter(([key]) => !route.detail || route.detail === key);
  const head = `<thead><tr><th>Party</th><th class="figure">Closing (₹)</th>${bucketTemplate.map((bucket) => `<th class="figure">${esc(bucketHeading(bucket.label))}</th>`).join("")}<th class="figure">Overdue (₹)</th><th><span class="sr">Ledger report</span></th></tr></thead>`;
  const body = visible.map(([key, title, label, amount, normal, side]) => `<section class="subsection"><h2>${title}</h2>${scroll(`<table>${head}<tbody>${partyRows(key)}</tbody><tfoot><tr class="total"><th scope="row">${label}</th><td class="figure">${total(amount, normal)}</td>${bucketCells(side?.buckets)}${amountCell(side?.overduePaise || 0)}<td></td></tr></tfoot></table>`)}</section>`).join("");
  const tile = (label, amount, suffix = "") => `<div><span>${esc(label)}</span><strong>₹${money(Math.abs(amount))}${suffix ? ` <small>${esc(suffix)}</small>` : ""}</strong></div>`;
  const tiles = [];
  if (visible.some(([key]) => key === "debtors")) {
    tiles.push(tile(report.receivable < 0 ? "Customer advances" : "Net receivable", report.receivable));
    tiles.push(tile("Receivable overdue", ageing.receivable?.overduePaise || 0));
  }
  if (visible.some(([key]) => key === "creditors")) {
    tiles.push(tile(report.payable < 0 ? "Supplier advances" : "Net payable", report.payable));
    tiles.push(tile("Payable overdue", ageing.payable?.overduePaise || 0));
    if (report.msmeOverduePaise) tiles.push(tile("MSME beyond 45 days", report.msmeOverduePaise));
  }
  const explain = `<p class="subsection-intro">Balances on ${esc(dateLabel(report.asOf || range.to))}. Ageing columns count days past each bill's due date: the due date saved on the bill, otherwise the bill date plus the party's credit days. Overdue is the part more than 30 days past due.${report.msmeOverduePaise ? " MSME amounts are unpaid more than 45 days after the bill date." : ""}</p>`;
  render(route.detail === "debtors" ? "Receivables" : route.detail === "creditors" ? "Payables" : "Outstanding balances", `${toolbar}<div class="summary-strip">${tiles.join("")}</div>${explain}${body}`);
  return true;
}
