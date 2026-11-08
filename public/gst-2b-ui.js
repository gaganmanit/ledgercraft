const fields = { type: "Type", number: "Number", date: "Date", taxable: "Taxable ₹", cgst: "CGST ₹", sgst: "SGST / UTGST ₹", igst: "IGST ₹", cess: "Cess ₹", total: "Total ₹", placeOfSupply: "Place of supply", reverseCharge: "Reverse charge" };
const monetary = new Set(["taxable","cgst","sgst","igst","cess","total"]);
const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.split("-").reverse().join("-") : value || "";
const STATUS_TONE = { Matched: "ok", Mismatch: "bad", Duplicate: "bad", Ambiguous: "warn", "Only in 2B": "warn", "Only in books": "warn", "Absent from selected pages": "warn" };
const ITC_LABEL = { Y: "ITC available", N: "ITC not available" };

export function showMatches(target, result, { esc, href, formatINR }) {
  let page = 0;
  const size = 50;
  const counts = new Map();
  for (const row of result.results) counts.set(row.status, (counts.get(row.status) || 0) + 1);
  const pill = status => `<span class="pill${STATUS_TONE[status] ? " " + STATUS_TONE[status] : ""}">${esc(status)}</span>`;
  const total = result.results.length;
  target.innerHTML = `<h3>Matching results</h3>
    <p>${total} ${total === 1 ? "row" : "rows"} compared for <span class="code">${esc(result.gstin)}</span>.</p>
    ${counts.size ? `<div class="summary-strip">${[...counts].map(([status, n]) => `<div><span>${esc(status)}</span><strong>${n}</strong></div>`).join("")}</div>` : ""}
    ${result.partial ? `<p class="notice">Compared with ${result.pageCount} selected document ${result.pageCount === 1 ? "page" : "pages"}. Include the GSTN file-count summary to check that the statement is complete.</p>` : ""}
    ${result.exceptions.length ? `<ul class="attention-rule">${result.exceptions.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
    <div class="toolbar"><label>Match status <select data-filter><option value="">All results</option>${[...counts].map(([s, n]) => `<option value="${esc(s)}">${esc(s)} (${n})</option>`).join("")}</select></label>
    <button type="button" class="ghost" data-export>Export matching report</button></div><div data-table></div>`;
  const filter = target.querySelector("[data-filter]"), table = target.querySelector("[data-table]");
  const format = (field, value) => value === undefined ? "—" : monetary.has(field) ? formatINR(value) : field === "date" ? dateLabel(value) : String(value);
  const amountCell = value => `<td class="figure${value === undefined ? " quiet" : ""}">${esc(format("total", value))}</td>`;
  const bookLink = (id, label) => `<a class="code" href="${href}/gst-document/${encodeURIComponent(id)}">${esc(label)}</a>`;
  const rows = () => result.results.filter(row => !filter.value || row.status === filter.value);
  function draw() {
    const list = rows(), start = size * page;
    const body = list.slice(start, start + size).map(r => {
      const section = [r.section ? r.section.toUpperCase() : "", dateLabel(r.date)].filter(Boolean).join(", ");
      const original = r.original ? `<div class="quiet">Originally ${esc(r.original.type)} <span class="code">${esc(r.original.number)}</span> dated ${esc(dateLabel(r.original.date))}</div>` : "";
      const detail = r.differences.map(field => {
        const pair = r.values[field];
        return `<div>${esc(fields[field])}: ${esc(format(field, pair.book))} in books, ${esc(format(field, pair.portal))} in 2B</div>`;
      }).join("");
      const match = r.bookId ? bookLink(r.bookId, r.values.number.book) : (r.candidates || []).map(c => bookLink(c.id, c.number)).join(", ");
      const itc = [ITC_LABEL[r.statementITC] || r.statementITC, r.reason].filter(Boolean).map(text => `<div>${esc(text)}</div>`).join("");
      return `<tr><td>${pill(r.status)}</td><td class="code">${esc(r.gstin)}</td><td><span class="code">${esc(r.number)}</span>${section ? `<div class="quiet">${esc(section)}</div>` : ""}${original}</td><td>${match || "—"}${r.bookDate ? `<div class="quiet">Posted ${esc(dateLabel(r.bookDate))}</div>` : ""}</td>${amountCell(r.bookValue)}${amountCell(r.portalValue)}<td>${detail || "—"}</td><td>${itc || "—"}</td><td>${esc(r.imsStatus || "—")}</td></tr>`;
    }).join("");
    const head = [["Status"], ["Supplier GSTIN"], ["Document"], ["Book entry"], ["Books ₹", "figure"], ["2B ₹", "figure"], ["Differences, books then 2B"], ["2B ITC"], ["IMS"]];
    table.innerHTML = `<div class="table-scroll"><table><thead><tr>${head.map(([label, type]) => `<th${type ? ` class="${type}"` : ""}>${esc(label)}</th>`).join("")}</tr></thead><tbody>${body || `<tr><td colspan="9" class="quiet">No rows have this status. Choose All results to see every row.</td></tr>`}</tbody></table></div>
      ${list.length > size ? `<div class="actions"><button type="button" class="ghost" data-prev ${page === 0 ? "disabled" : ""}>Previous rows</button><span>Rows ${start + 1} to ${Math.min(list.length, start + size)} of ${list.length}</span><button type="button" class="ghost" data-next ${start + size >= list.length ? "disabled" : ""}>Next rows</button></div>` : ""}`;
    const prev = table.querySelector("[data-prev]"), next = table.querySelector("[data-next]");
    if (prev) prev.onclick = () => { page--; draw(); };
    if (next) next.onclick = () => { page++; draw(); };
  }
  filter.onchange = () => { page = 0; draw(); };
  target.querySelector("[data-export]").onclick = () => {
    const header = ["Match status","GSTIN","Section","Document","Book posting date","Original number","Original date","ITC","Reason","IMS","Candidates","Differences",
      ...Object.values(fields).flatMap(label=>[label+" (books)",label+" (2B)"])];
    const csvRows = rows().map(r=>[r.status,r.gstin,r.section,r.number,r.bookDate || (r.bookId ? r.date : ""),r.original?.number,r.original?.date,r.statementITC,r.reason,r.imsStatus,
      r.candidates?.map(c=>c.number).join(" | "),r.differences.map(f=>fields[f]).join(", "),
      ...Object.keys(fields).flatMap(f=>["book","portal"].map(side => {
        const value = r.values[f][side];
        return value === undefined ? "" : monetary.has(f) ? formatINR(value).replaceAll(",","") : value;
      }))]);
    for (const exception of result.exceptions) csvRows.push(["Separate review","","","","","","","",exception]);
    const cell = value => {
      const raw = String(value ?? "");
      const safe = /^[\s]*[=+@-]/.test(raw) && !/^-?\d+(\.\d+)?$/.test(raw) ? "'" + raw : raw;
      return '"' + safe.replaceAll('"','""') + '"';
    };
    const data = [header,...csvRows].map(r=>r.map(cell).join(",")).join("\r\n")+"\r\n";
    const blob = URL.createObjectURL(new Blob(["\uFEFF",data],{type:"text/csv;charset=utf-8"}));
    const a=document.createElement("a"); a.href=blob; a.download=`GSTR-2B-${result.gstin}-${result.month}.csv`; target.append(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(blob), 60000);
  };
  draw();
}
