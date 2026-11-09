/* Party statements: an ageing index of sundry debtors and creditors, and a printable statement of account per party. */

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dateLabel = value => ISO.test(value || "") ? value.split("-").reverse().join("-") : value || "";
const withQuery = (path, values) => { const query = new URLSearchParams(values).toString(); return query ? `${path}?${query}` : path; };
const bucketLabel = label => label === "current" ? "Current" : /^over(\d+)$/.test(label) ? `Over ${label.slice(4)} days` : `${label.replace("-", "–")} days`;
const dayCount = days => `${Number(days).toLocaleString("en-IN")} ${Number(days) === 1 ? "day" : "days"}`;
const DEFAULT_BUCKETS = ["current", "1-30", "31-60", "61-90", "91-180", "over180"].map(label => ({ label, paise: 0 }));

/* Composition dealer flag on the GST party master (compositionDealer, boolean). GSTR-3B reads it:
   inter-State sales to such a party go to Table 3.2 and every purchase from it goes to Table 5.
   The party form and the party table import these so the field reads the same wherever it appears. */
export function compositionDealerField(checked = false) {
  return `<label class="check wide"><input type="checkbox" name="compositionDealer" value="true"${checked ? " checked" : ""}><span>Composition dealer (section 10)<small>Inter-State sales to this party go to Table 3.2 of GSTR-3B. Purchases from it go to Table 5.</small></span></label>`;
}
export const compositionDealerValue = form => form.elements.compositionDealer?.checked === true;
export function setCompositionDealer(form, party) {
  if (form.elements.compositionDealer) form.elements.compositionDealer.checked = party?.compositionDealer === true;
}
export const compositionDealerPill = party => party?.compositionDealer === true ? ` <span class="pill info">Composition dealer</span>` : "";

export async function viewParties(route, token, ui) {
  if (route.name !== "parties") return false;
  if (!route.id) throw new Error("Open a company to review party statements");
  const { api, still, readPeriod } = ui;
  const meta = await api(`/api/companies/${encodeURIComponent(route.id)}/meta`);
  if (!still(token)) return true;
  const company = meta.company;
  /* The books period comes from the top bar. A link may pin its own range with ?from and ?to. */
  const period = readPeriod(company);
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const from = ISO.test(params.get("from") || "") ? params.get("from") : period.from;
  const to = ISO.test(params.get("to") || "") ? params.get("to") : period.to;
  const pinned = from !== period.from || to !== period.to;
  const context = { ...ui, company, from, to, pinned, base: `/api/companies/${encodeURIComponent(route.id)}`, book: `#/c/${encodeURIComponent(route.id)}` };
  if (route.detail) await viewStatement(route, token, context);
  else await viewIndex(route, token, context);
  return true;
}

function rangeTools({ esc, from, to, pinned }, here, actions) {
  const echo = pinned
    ? `<span class="period-echo">${esc(dateLabel(from))} to ${esc(dateLabel(to))}, as linked. <a href="${here}">Use the books period</a></span>`
    : `<span class="period-echo">${esc(dateLabel(from))} to ${esc(dateLabel(to))} <button type="button" class="link" data-focus-period>Change period</button></span>`;
  return `<div class="sheet-tools">${echo}<span class="sheet-actions">${actions}</span></div>`;
}

async function viewIndex(route, token, context) {
  const { root, api, still, page, esc, formatINR, company, from, to, pinned, base, book } = context;
  const report = await api(`${base}/reports/outstanding?${new URLSearchParams({ from, to })}`);
  if (!still(token)) return;
  const range = pinned ? { from, to } : {};
  const rows = [...(report.debtors || []).map(row => ({ ...row, sideLabel: "Receivable" })), ...(report.creditors || []).map(row => ({ ...row, sideLabel: "Payable" }))];
  const headBuckets = report.ageing?.receivable?.buckets || rows[0]?.ageing || DEFAULT_BUCKETS;
  const money = (paise, dc = "") => paise ? `<td class="figure">${esc(formatINR(Math.abs(paise)))}${dc ? `<span class="dc">${esc(dc)}</span>` : ""}</td>` : `<td class="figure quiet">—</td>`;
  const buckets = list => headBuckets.map(head => money((list || []).find(bucket => bucket.label === head.label)?.paise || 0)).join("");
  const rowHtml = row => {
    const msme = row.msme ? ` <span class="pill warn">MSME</span>` : "";
    const msmeLate = row.msme && row.msmeOverduePaise ? `<small>₹${esc(formatINR(row.msmeOverduePaise))} unpaid more than 45 days after the bill date</small>` : "";
    const terms = row.creditDays ? `<small>${esc(dayCount(row.creditDays))} credit</small>` : "";
    return `<tr data-party-row data-search="${esc(`${row.name} ${row.sideLabel} ${row.msme ? "msme" : ""}`.toLowerCase())}">
      <th scope="row"><a href="${withQuery(`${book}/parties/${encodeURIComponent(row.ledgerId)}`, range)}">${esc(row.name)}</a>${msme}${terms}${msmeLate}</th>
      <td>${esc(row.sideLabel)}</td>
      ${money(row.closing?.paise, row.closing?.paise ? row.closing.dc : "")}
      ${money(row.overduePaise)}
      ${buckets(row.ageing)}</tr>`;
  };
  const totalRow = (label, amount, side) => {
    const ageing = report.ageing?.[side] || {};
    const dc = amount < 0 ? (side === "receivable" ? "Cr" : "Dr") : (side === "receivable" ? "Dr" : "Cr");
    return `<tr class="total"><th scope="row" colspan="2">${esc(label)}</th>${money(Math.abs(amount || 0), amount ? dc : "")}${money(ageing.overduePaise)}${buckets(ageing.buckets)}</tr>`;
  };
  const columns = 4 + headBuckets.length;
  const advances = ["receivable", "payable"].filter(side => report.ageing?.[side]?.advancePaise).map(side => `${side === "receivable" ? "Customers" : "Suppliers"} hold ₹${esc(formatINR(report.ageing[side].advancePaise))} of payments not yet set against a bill.`);
  const table = rows.length
    ? `<div class="toolbar"><label class="grow">Find a party <input type="search" id="party-search" placeholder="Party name, receivable, payable or MSME" autocomplete="off"></label></div>
      <div class="table-scroll"><table class="party-table"><thead><tr><th>Party</th><th>Side</th><th class="figure">Closing balance (₹)</th><th class="figure">Overdue over 30 days (₹)</th>${headBuckets.map(head => `<th class="figure">${esc(bucketLabel(head.label))}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(rowHtml).join("")}<tr data-party-empty hidden data-export-skip><td colspan="${columns}" class="quiet">No party matches this search. Clear it to see every party.</td></tr></tbody>
      <tfoot>${report.debtors?.length ? totalRow("Total receivable", report.receivable, "receivable") : ""}${report.creditors?.length ? totalRow("Total payable", report.payable, "payable") : ""}</tfoot></table></div>
      ${advances.length ? `<p class="quiet">${advances.join(" ")}</p>` : ""}
      ${report.msmeOverduePaise ? `<ul class="attention-rule"><li>₹${esc(formatINR(report.msmeOverduePaise))} owed to MSME suppliers is unpaid more than 45 days after the bill date. Under Section 43B(h) of the Income-tax Act it is deductible only in the year it is paid.</li></ul>` : ""}`
    : `<p class="empty">No sundry debtor or creditor has a balance at ${esc(dateLabel(to))}. Parties appear here once a sale, purchase, receipt or opening balance is posted to a ledger under Sundry Debtors or Sundry Creditors. <a href="${book}/ledgers">Open ledgers</a></p>`;
  document.title = `Party statements · ${company.name}`;
  root.innerHTML = page({ company, title: "Party statements",
    lede: `Balances and ageing at ${dateLabel(to)}. Ageing counts days past each bill's due date. Open a party for its statement of account.`,
    body: `${rangeTools(context, `${book}/parties`, `<button type="button" class="ghost" data-export-csv>Download CSV</button><button type="button" class="ghost" data-print-sheet>Print</button>`)}
      <p class="only-print">Ageing at ${esc(dateLabel(to))}, period ${esc(dateLabel(from))} to ${esc(dateLabel(to))}.</p>
      ${table}` });
  const search = root.querySelector("#party-search");
  search?.addEventListener("input", () => {
    const needle = search.value.toLowerCase().trim();
    let shown = 0;
    for (const row of root.querySelectorAll("[data-party-row]")) {
      row.hidden = needle !== "" && !row.dataset.search.includes(needle);
      if (!row.hidden) shown += 1;
    }
    root.querySelector("[data-party-empty]").hidden = shown > 0;
  });
}

async function viewStatement(route, token, context) {
  const { root, api, still, page, esc, formatINR, company, from, to, pinned, base, book } = context;
  const ledgerId = route.detail;
  const query = new URLSearchParams({ from, to });
  const statement = await api(`${base}/parties/${encodeURIComponent(ledgerId)}/statement?${query}`);
  if (!still(token)) return;
  const { party, ageing = {}, totals = {} } = statement;
  const range = pinned ? { from, to } : {};
  const amount = (paise, dc = "") => paise ? `<td class="figure">${esc(formatINR(paise))}${dc ? `<span class="dc">${esc(dc)}</span>` : ""}</td>` : `<td class="figure quiet">—</td>`;
  const balance = value => `<td class="figure">${esc(formatINR(value?.paise || 0))}${value?.paise ? `<span class="dc">${esc(value.dc)}</span>` : ""}</td>`;
  const voucherHref = (voucherId, type, isDocument) => {
    if (!voucherId) return "";
    if (isDocument || /^v-gst-/.test(voucherId)) return `${book}/gst-document/${encodeURIComponent(voucherId)}`;
    return type ? `${book}/v/${encodeURIComponent(type)}/${encodeURIComponent(voucherId)}` : "";
  };
  const reference = (text, href) => href ? `<a class="voucher-ref" href="${esc(href)}">${esc(text)}</a>` : `<span class="voucher-ref">${esc(text)}</span>`;
  const lineHtml = line => `<tr>
      <td class="date-cell">${esc(dateLabel(line.date))}</td>
      <td>${reference(line.number || "", voucherHref(line.voucherId, line.type, Boolean(line.documentNumber)))}<small>${esc(line.type || "")}</small></td>
      <td>${esc(line.particulars || "")}${line.narration ? `<div class="quiet">${esc(line.narration)}</div>` : ""}</td>
      ${amount(line.debitPaise)}${amount(line.creditPaise)}${balance(line.balance)}
      <td class="date-cell">${line.dueDate ? esc(dateLabel(line.dueDate)) : ""}</td>
      <td>${line.overdueDays ? `<span class="pill warn">${esc(dayCount(line.overdueDays))}</span>` : ""}</td></tr>`;
  const lines = statement.lines || [];
  const opening = `<tr><td class="date-cell">${esc(dateLabel(statement.period?.from || from))}</td><td></td><th scope="row">Opening balance</th>${amount(0)}${amount(0)}${balance(statement.opening)}<td></td><td></td></tr>`;
  const empty = lines.length ? "" : `<tr data-export-skip><td colspan="8" class="quiet">No entries for this party between ${esc(dateLabel(from))} and ${esc(dateLabel(to))}. Change the period to see earlier entries.</td></tr>`;
  const closingDc = statement.closing?.paise ? statement.closing.dc : "";
  const oldest = ageing.oldestDate ? dateLabel(ageing.oldestDate) : "None open";
  const sideLabel = party.side === "payable" ? "Payable" : "Receivable";
  const openItems = ageing.openItems || [];
  const typeOf = new Map(lines.map(line => [line.voucherId, line.type]));
  const openNote = item => {
    if (item.billWise) return "";
    const note = item.kind === "opening" ? "Opening balance" : "Not allocated to a bill";
    return item.reference === note ? "" : `<small>${note}</small>`;
  };
  const openTable = openItems.length
    ? `<div class="table-scroll"><table><thead><tr><th>Reference</th><th>Bill date</th><th>Due date</th><th>Days overdue</th><th class="figure">Open amount (₹)</th></tr></thead><tbody>${openItems.map(item => `<tr>
        <td>${item.reference ? `${reference(item.reference, voucherHref(item.voucherId, typeOf.get(item.voucherId), false))}${openNote(item)}` : esc(item.kind === "opening" ? "Opening balance" : "On account, not allocated to a bill")}</td>
        <td class="date-cell">${esc(dateLabel(item.date))}</td><td class="date-cell">${esc(dateLabel(item.dueDate))}</td>
        <td>${item.days > 0 ? `<span class="pill warn">${esc(dayCount(item.days))}</span>` : `<span class="quiet">Not yet due</span>`}</td>
        ${amount(item.openPaise)}</tr>`).join("")}</tbody></table></div>`
    : `<p class="quiet">Nothing is open for this party at ${esc(dateLabel(ageing.asOf || to))}.</p>`;
  const msmeNote = party.msme && party.side === "payable" && ageing.msmeOverduePaise
    ? `<ul class="attention-rule"><li>₹${esc(formatINR(ageing.msmeOverduePaise))} is unpaid more than 45 days after the bill date. Under Section 43B(h) of the Income-tax Act it is deductible only in the year it is paid.</li></ul>` : "";
  const csvHref = withQuery(`${base}/parties/${encodeURIComponent(ledgerId)}/statement.csv`, { from, to });
  const here = `${book}/parties/${encodeURIComponent(ledgerId)}`;
  document.title = `${party.name} statement · ${company.name}`;
  root.innerHTML = page({ company, title: party.name,
    body: `<div class="actions"><a href="${withQuery(`${book}/parties`, range)}">All party statements</a><a href="${book}/ledger/${encodeURIComponent(ledgerId)}">Ledger report</a></div>
      ${rangeTools(context, here, `<a class="button ghost" href="${esc(csvHref)}" download>Download CSV</a><button type="button" class="ghost" data-print-sheet>Print</button>`)}
      <div class="only-print party-letterhead"><p>${statement.company?.gstin ? `GSTIN <span class="code">${esc(statement.company.gstin)}</span>` : ""}</p><p>Statement of account from ${esc(dateLabel(from))} to ${esc(dateLabel(to))}</p></div>
      <dl class="kv party-block">
        <dt>Party</dt><dd>${esc(party.name)}${party.msme ? ` <span class="pill warn">MSME</span>` : ""}</dd>
        <dt>Side</dt><dd>${esc(sideLabel)}</dd>
        ${party.gstin ? `<dt>GSTIN</dt><dd class="code">${esc(party.gstin)}</dd>` : ""}
        ${party.address ? `<dt>Address</dt><dd>${esc(party.address)}</dd>` : ""}
      </dl>
      <div class="summary-strip party-summary">
        <div><span>Closing balance</span><strong>₹${esc(formatINR(statement.closing?.paise || 0))}${closingDc ? ` <small>${esc(closingDc)}</small>` : ""}</strong></div>
        <div><span>Overdue over 30 days</span><strong>₹${esc(formatINR(ageing.overduePaise || 0))}</strong></div>
        <div><span>Credit days</span><strong>${esc(String(party.creditDays ?? 0))}</strong></div>
        <div><span>Oldest open item</span><strong>${esc(oldest)}</strong></div>
      </div>
      ${msmeNote}
      <div class="table-scroll"><table><thead><tr><th>Date</th><th>Voucher</th><th>Particulars</th><th class="figure">Debit (₹)</th><th class="figure">Credit (₹)</th><th class="figure">Balance (₹)</th><th>Due date</th><th>Overdue</th></tr></thead>
        <tbody>${opening}${lines.map(lineHtml).join("")}${empty}</tbody>
        <tfoot><tr class="party-period-total"><th scope="row" colspan="3">Total for the period</th>${amount(totals.debitPaise)}${amount(totals.creditPaise)}<td></td><td></td><td></td></tr>
        <tr class="total"><th scope="row" colspan="3">Closing balance at ${esc(dateLabel(statement.period?.to || to))}</th><td></td><td></td>${balance(statement.closing)}<td></td><td></td></tr></tfoot></table></div>
      <div class="details-list party-open-items"><details${openItems.length ? " open" : ""}><summary>Open items <small>${esc(openItems.length === 1 ? "1 item" : `${openItems.length} items`)}${ageing.advancePaise ? `, ₹${esc(formatINR(ageing.advancePaise))} advance not set against a bill` : ""}</small></summary>${openTable}</details></div>` });
}
