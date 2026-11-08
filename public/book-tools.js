const TOOL_NAMES = new Set(["group-summary", "cash-bank", "outstanding", "transfer", "voucher-print"]);

function dateLabel(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split("-").reverse().join("-") : value;
}

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
  const closing = (row) => `${money(row.closing.paise)} <span class="dc">${row.closing.dc}</span>`;
  const render = (title, body, folio) => {
    document.title = company ? `${title} · ${company.name}` : `${title} · Ledgercraft`;
    root.innerHTML = page({ company, folio, kicker: title, title, body });
    root.querySelector("[data-print]")?.addEventListener("click", () => window.print());
    if (company && route.name !== "voucher-print" && route.name !== "transfer") bindPeriod(company);
  };

  if (route.name === "transfer") {
    const tallySource = company?.source?.system === "tally" && company.source.archive !== "accounting-only";
    const downloads = company ? `<section class="transfer-section"><h2>Save a copy of these books</h2><p>The company backup includes every ledger and voucher.${tallySource ? " Original Tally files and source details travel with this backup." : ""}</p><div class="book-toolbar"><a class="button" href="${base}/backup" download>Download company backup</a></div><h3>Export the current period</h3><p>${dateLabel(range.from)} to ${dateLabel(range.to)}</p><div class="book-toolbar">${[["daybook", "Day book XML"], ["trial-balance", "Trial balance XML"], ["vouchers", "Vouchers XML"]].map(([name, label]) => `<a class="button secondary" href="${base}/export/${name}?${query}" download>${label}</a>`).join("")}</div></section>` : "";
    render("Import & export", `${downloads}<section class="transfer-section"><h2>Import a company</h2><p>Choose a Ledgercraft backup, or select both company.json and vouchers.json from a company folder. The imported company opens as a new set of books.</p><form id="book-import"><label for="book-files">Company files</label><input id="book-files" name="files" type="file" accept=".json,application/json" multiple required/><p id="import-status" role="status" aria-live="polite"></p><div class="book-toolbar"><button type="submit">Import company</button></div></form></section>`, "Io");
    const form = root.querySelector("#book-import");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector("button");
      const status = form.querySelector("#import-status");
      button.disabled = true;
      status.className = "quiet";
      status.textContent = "Reading the company files…";
      try {
        const files = [...form.elements.files.files];
        if (files.length < 1 || files.length > 2 || files.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) throw new Error("Choose one backup or the two company files, up to 64 MB");
        let input;
        if (files.length === 1) input = JSON.parse(await files[0].text());
        else {
          const companyFile = files.find((file) => file.name.toLowerCase() === "company.json");
          const vouchersFile = files.find((file) => file.name.toLowerCase() === "vouchers.json");
          if (!companyFile || !vouchersFile) throw new Error("Choose company.json and vouchers.json together");
          input = { company: JSON.parse(await companyFile.text()), vouchers: JSON.parse(await vouchersFile.text()) };
        }
        const imported = await api("/api/import", { method: "POST", body: input });
        if (!still(token)) return;
        sessionStorage.setItem("financer-flash", "Company imported. All ledgers and vouchers are ready.");
        location.hash = `#/c/${encodeURIComponent(imported.company.id)}`;
      } catch (error) {
        status.className = "alert";
        status.textContent = error instanceof SyntaxError ? "One of the selected files contains invalid JSON" : error.message;
      } finally {
        button.disabled = false;
      }
    });
    return true;
  }

  if (!company) throw new Error("Open a company to view this statement");
  if (route.name === "voucher-print") {
    const voucher = bundle.voucher;
    if (!voucher) throw new Error("That voucher is not in this company");
    const names = new Map(company.ledgers.map((ledger) => [ledger.id, ledger.name]));
    const total = voucher.lines.reduce((sum, line) => sum + (line.dc === "Dr" ? line.paise : 0), 0);
    render(`${voucher.type} voucher`, `<div class="book-toolbar actions"><a href="#/c/${esc(id)}/v/${encodeURIComponent(voucher.type)}/${esc(voucher.id)}">Back to voucher</a><button type="button" data-print>Print voucher</button></div><div class="voucher-identity"><p><strong>${esc(voucher.number)}</strong></p><p>${dateLabel(voucher.date)}</p></div><table><thead><tr><th>Particulars</th><th class="figure">Debit</th><th class="figure">Credit</th></tr></thead><tbody>${voucher.lines.map((line) => `<tr><th scope="row">${esc(names.get(line.ledgerId))}</th><td class="figure">${line.dc === "Dr" ? money(line.paise) : "—"}</td><td class="figure">${line.dc === "Cr" ? money(line.paise) : "—"}</td></tr>`).join("")}</tbody><tfoot><tr class="total"><th>Total</th><td class="figure">${money(total)}</td><td class="figure">${money(total)}</td></tr></tfoot></table>${voucher.narration ? `<p class="voucher-narration">${esc(voucher.narration)}</p>` : ""}<div class="voucher-signatures"><span>Prepared by</span><span>Authorised by</span></div>`, "Vp");
    return true;
  }

  const detail = route.name === "group-summary" && route.detail ? `&group=${encodeURIComponent(route.detail)}` : "";
  const report = await api(`${base}/reports/${route.name}?${query}${detail}`);
  if (!still(token)) return true;
  const toolbar = periodBar(range);
  if (route.name === "group-summary") {
    const rows = report.group ? report.ledgers.map((row) => `<tr><th scope="row">${ledgerLink(row)}</th><td class="figure">${row.periodDr ? money(row.periodDr) : "—"}</td><td class="figure">${row.periodCr ? money(row.periodCr) : "—"}</td><td class="figure">${row.closing.dc === "Dr" ? money(row.closing.paise) : "—"}</td><td class="figure">${row.closing.dc === "Cr" ? money(row.closing.paise) : "—"}</td></tr>`) : report.rows.map((row) => `<tr><th scope="row"><a href="#/c/${esc(id)}/group-summary/${esc(row.groupId)}">${esc(row.name)}</a><div class="quiet group-path">${esc(row.path)}</div></th><td class="figure">${money(row.periodDr)}</td><td class="figure">${money(row.periodCr)}</td><td class="figure">${row.debit ? money(row.debit) : "—"}</td><td class="figure">${row.credit ? money(row.credit) : "—"}</td></tr>`);
    render(report.group?.name || "Group summary", `${toolbar}${report.group ? `<p class="actions"><a href="#/c/${esc(id)}/group-summary">All groups</a></p>` : ""}<table><thead><tr><th>${report.group ? "Ledger" : "Group"}</th><th class="figure">Period debit</th><th class="figure">Period credit</th><th class="figure">Closing debit</th><th class="figure">Closing credit</th></tr></thead><tbody>${rows.join("") || '<tr><td colspan="5" class="quiet">No balances in this group for the period.</td></tr>'}</tbody><tfoot><tr class="total"><th colspan="3">Closing totals</th><td class="figure">${money(report.debit)}</td><td class="figure">${money(report.credit)}</td></tr></tfoot></table>`, "Gs");
    return true;
  }
  if (route.name === "cash-bank") {
    render("Cash & bank book", `${toolbar}<table><thead><tr><th>Account</th><th class="figure">Opening</th><th class="figure">Receipts</th><th class="figure">Payments</th><th class="figure">Closing</th></tr></thead><tbody>${report.balances.map((row) => `<tr><th scope="row">${ledgerLink(row)}</th><td class="figure">${money(row.opening.paise)} <span class="dc">${row.opening.dc}</span></td><td class="figure">${money(row.periodDr)}</td><td class="figure">${money(row.periodCr)}</td><td class="figure">${closing(row)}</td></tr>`).join("") || '<tr><td colspan="5" class="quiet">No cash or bank balances.</td></tr>'}</tbody><tfoot><tr class="total"><th colspan="4">Net cash & bank</th><td class="figure">${money(Math.abs(report.cashBank))} <span class="dc">${report.cashBank < 0 ? "Cr" : "Dr"}</span></td></tr></tfoot></table><h2>Vouchers through cash & bank</h2><table><thead><tr><th>Date</th><th>No.</th><th>Particulars</th><th class="figure">Amount</th></tr></thead><tbody>${report.rows.map((row) => `<tr><td>${dateLabel(row.date)}</td><td><a href="#/c/${esc(id)}/v/${encodeURIComponent(row.type)}/${esc(row.id)}">${esc(row.number)}</a></td><td>${esc(row.particulars)}${row.narration ? `<div class="quiet">${esc(row.narration)}</div>` : ""}</td><td class="figure">${money(row.paise)}</td></tr>`).join("") || '<tr><td colspan="4" class="quiet">No cash or bank vouchers in this period.</td></tr>'}</tbody></table>`, "Cb");
    return true;
  }
  const partyRows = (rows) => rows.map((row) => `<tr><th scope="row">${ledgerLink(row)}</th><td class="figure">${closing(row)}</td></tr>`).join("") || '<tr><td colspan="2" class="quiet">No outstanding balances.</td></tr>';
  const total = (amount, normal) => `${money(Math.abs(amount))}${amount < 0 ? ` <span class="dc">${normal === "Dr" ? "Cr" : "Dr"}</span>` : ""}`;
  const sections = [["debtors", "Sundry debtors", "Net receivable", report.receivable, "Dr"], ["creditors", "Sundry creditors", "Net payable", report.payable, "Cr"]];
  const visible = sections.filter(([key]) => !route.detail || route.detail === key);
  const body = visible.map(([key,title,label,amount,normal]) => `<section><h2>${title}</h2><table><thead><tr><th>Party</th><th class="figure">Closing</th></tr></thead><tbody>${partyRows(report[key])}</tbody><tfoot><tr class="total"><th>${label}</th><td class="figure">${total(amount, normal)}</td></tr></tfoot></table></section>`).join("");
  render(route.detail === "debtors" ? "Receivables" : route.detail === "creditors" ? "Payables" : "Outstanding balances", `${toolbar}<div class="${visible.length === 2 ? "two" : ""}">${body}</div>`, "Os");
  return true;
}
