const fields = { type: "Type", number: "Number", date: "Date", taxable: "Taxable ₹", cgst: "CGST ₹", sgst: "SGST / UTGST ₹", igst: "IGST ₹", cess: "Cess ₹", total: "Total ₹", placeOfSupply: "Place of supply", reverseCharge: "Reverse charge" };
const monetary = new Set(["taxable","cgst","sgst","igst","cess","total"]);
const humanDate = v => v && v.split("-").reverse().join("-");

export function showMatches(target, result, { esc, href, formatINR }) {
  let page = 0;
  const size = 50;
  const counts = new Map();
  for (const row of result.results) counts.set(row.status, (counts.get(row.status) || 0) + 1);
  target.innerHTML = `<h3>Matching results · ${result.results.length}</h3>
    ${result.partial ? `<p>Compared with ${result.pageCount} selected document page(s). Include the GSTN file-count summary to check completeness.</p>` : ""}
    ${result.exceptions.map(e=>`<p>${esc(e)}</p>`).join("")}
    <div class="book-toolbar"><label>Match status <select data-filter><option value="">All results</option>${[...counts].map(([s,n])=>`<option value="${esc(s)}">${esc(s)} (${n})</option>`).join("")}</select></label>
    <button type="button" class="secondary" data-export>Export matching report</button></div><div data-table></div>`;
  const filter = target.querySelector("[data-filter]"), table = target.querySelector("[data-table]");
  const format = (field, value) => value === undefined ? "—" : monetary.has(field) ? formatINR(value) : field === "date" ? humanDate(value) : String(value);
  const bookLink = (id, label) => `<a href="${href}/gst-document/${encodeURIComponent(id)}">${esc(label)}</a>`;
  const rows = () => result.results.filter(row => !filter.value || row.status === filter.value);
  function draw() {
    const list = rows(), start = size * page;
    const body = list.slice(start, start + size).map(r => {
      const original = r.original ? `<small class="gst-detail">Originally ${esc(r.original.type)} ${esc(r.original.number)} · ${esc(humanDate(r.original.date))}</small>` : "";
      const detail = r.differences.map(field => {
        const pair = r.values[field];
        return `<div>${esc(fields[field])} · ${esc(format(field,pair.book))} → ${esc(format(field,pair.portal))}</div>`;
      }).join("");
      const match = r.bookId ? bookLink(r.bookId, r.values.number.book) : (r.candidates || []).map(c => bookLink(c.id, c.number)).join(", ");
      return `<tr><td>${esc(r.status)}</td><td>${esc(r.gstin)}</td><td>${esc(r.number)}<small class="gst-detail">${esc(r.section.toUpperCase())} · ${esc(humanDate(r.date))}</small>${original}</td><td>${match || "—"}${r.bookDate ? `<small class="gst-detail">Posted ${esc(humanDate(r.bookDate))}</small>` : ""}</td><td>${esc(format("total",r.bookValue))}</td><td>${esc(format("total",r.portalValue))}</td><td>${detail || "—"}</td><td>${esc([r.statementITC,r.reason].filter(Boolean).join(" · ") || "—")}</td><td>${esc(r.imsStatus || "—")}</td></tr>`;
    }).join("");
    table.innerHTML = `<div class="gst-scroll"><table><thead><tr>${["Status","Supplier GSTIN","Document","Book entry","Books ₹","2B ₹","Differences (books → 2B)","2B ITC","IMS"].map(x=>`<th>${x}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>
      ${list.length > size ? `<div class="book-toolbar"><button class="secondary" data-prev ${page===0?"disabled":""}>Previous</button><span>${start+1}–${Math.min(list.length,start+size)} of ${list.length}</span><button class="secondary" data-next ${start+size>=list.length?"disabled":""}>Next</button></div>` : ""}`;
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
