import { bindCreditReview, creditReviewMarkup } from "./gst-credit-review-ui.js";
import { showMatches } from "./gst-2b-ui.js";
import { parseRupees } from "./money.js";

const labels = {"b2b,sez,de":"Registered customers and SEZ","b2cl":"Large interstate consumer invoices","b2cs":"Other consumer supplies","cdnr":"Registered credit and debit notes","cdnur":"Unregistered credit and debit notes","exp":"Exports","b2ba":"Amended registered invoices (B2BA)","b2cla":"Amended large consumer invoices (B2CLA)","expa":"Amended exports (EXPA)","cdnra":"Amended registered notes (CDNRA)","cdnura":"Amended unregistered notes (CDNURA)","exemp":"Nil-rated, exempt and non-GST","hsn(b2b)":"HSN summary for B2B supplies","hsn(b2c)":"HSN summary for B2C supplies","docs":"Documents issued"};
/* Sections of the GSTR-1 upload file, in the order the summary reports them. */
const JSON_SECTIONS = [["b2b","Registered customers and SEZ"],["b2ba","Amended registered invoices"],["b2cl","Large interstate consumer invoices"],["b2cla","Amended large consumer invoices"],["b2cs","Other consumer supplies, one row per rate and state"],["cdnr","Registered credit and debit notes"],["cdnra","Amended registered notes"],["cdnur","Unregistered credit and debit notes"],["cdnura","Amended unregistered notes"],["exp","Exports"],["expa","Amended exports"]];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const FY_MONTHS = [4,5,6,7,8,9,10,11,12,1,2,3];
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.split("-").reverse().join("-") : value || "";
const monthLabel = value => MONTH_PATTERN.test(value || "") ? `${MONTHS[Number(value.slice(5, 7)) - 1]} ${value.slice(0, 4)}` : value || "";
const fyOf = value => { const [year, month] = value.split("-").map(Number); return month >= 4 ? year : year - 1; };
const fyText = year => `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
const monthValue = (fy, month) => `${month >= 4 ? fy : fy + 1}-${String(month).padStart(2, "0")}`;
const monthOptions = (fy, selected) => FY_MONTHS.map(month => { const value = monthValue(fy, month); return `<option value="${value}"${value === selected ? " selected" : ""}>${monthLabel(value)}</option>`; }).join("");
const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
/* Money columns end in ₹ or carry the GSTR-1 offline-tool amount names; identifier columns hold GSTINs, document numbers and codes. */
const columnType = name => /₹$|Value$|Amount$|\sSupplies$|^Exempted/.test(name) ? "figure" : /GSTIN|Invoice Number$|Note Number$|^HSN$|Shipping Bill Number|^Sr\. No\.|Port Code/.test(name) ? "code" : /(^|\s)date$/i.test(name) ? "date-cell" : "";
const savedLabel = value => {
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return String(value || "");
  const pad = n => String(n).padStart(2, "0");
  return `${pad(when.getDate())}-${pad(when.getMonth() + 1)}-${when.getFullYear()} at ${pad(when.getHours())}:${pad(when.getMinutes())}`;
};

export async function viewReturns(route, token, ui, selectedCreditId) {
  const {root,api,esc,page,still,formatINR,todayISO,readPeriod} = ui;
  const id=encodeURIComponent(route.id), base="/api/companies/"+id;
  const {company, registrations}=await api(base+"/gst/registrations");
  if (!still(token)) return;
  document.title="GST returns · "+company.name;
  const href="#/c/"+id, money=n=>esc(formatINR(n));
  if (!registrations.length) {
    root.innerHTML=page({company,title:"GST returns",body:`<p class="empty">Add the company's GST registration in GST setup to prepare its returns.</p><p class="actions"><a class="ink-link" href="${href}/gst">Set up GST</a></p>`});
    return;
  }
  const params=new URLSearchParams(location.hash.split("?")[1]);
  const books=readPeriod(company);
  const registration=params.get("registration")||registrations[0].id;
  const month=MONTH_PATTERN.test(params.get("month")||"")?params.get("month"):books.to.slice(0,7);
  const query=new URLSearchParams({ registration,month });
  const report=await api(base+"/gst-returns?"+query);
  if (!still(token)) return;
  const {sheets,columns,issues,evidence}=report;
  const selectedFy=fyOf(month);
  const firstFy=Math.min(fyOf(company.booksFrom.slice(0,7)),selectedFy), lastFy=Math.max(fyOf(todayISO().slice(0,7)),fyOf(books.to.slice(0,7)),selectedFy);
  const fyChoices=[];
  for (let fy=lastFy; fy>=firstFy; fy--) fyChoices.push(`<option value="${fy}"${fy===selectedFy?" selected":""}>FY ${fyText(fy)}</option>`);
  const form=`<form class="toolbar" id="return-period"><label class="grow">Registration <select name="registration">${registrations.map(r=>`<option value="${esc(r.id)}"${r.id===registration?" selected":""}>${esc(r.name)} (${esc(r.gstin)})</option>`).join("")}</select></label><label>Financial year <select data-return-fy>${fyChoices.join("")}</select></label><label>Tax period <select data-return-month>${monthOptions(selectedFy,month)}</select></label><input type="hidden" name="month" value="${esc(month)}"><button type="submit">Show returns</button></form><p class="form-message alert" role="alert" data-return-period-message></p><p class="only-print">GSTIN ${esc(report.registration.gstin)}. Tax period ${esc(monthLabel(month))}.</p>`;
  const cells=(head,row)=>`<tr>${row.map((c,i)=>{ const type=columnType(head[i]||""); return `<td${type?` class="${type}"`:""}>${esc(c)}</td>`; }).join("")}</tr>`;
  const grid=(head,rows,empty="")=>`<div class="table-scroll"><table><thead><tr>${head.map(c=>`<th${columnType(c)==="figure"?' class="figure"':""}>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.length?rows.map(row=>typeof row==="string"?row:cells(head,row)).join(""):`<tr><td colspan="${head.length}" class="quiet">${empty}</td></tr>`}</tbody></table></div>`;
  const worksheet=name=>`<details><summary>${esc(labels[name] || name)} <small>${count(sheets[name].length,"row")}</small></summary><p class="actions"><a class="button" download href="${base}/gst-returns/csv/${encodeURIComponent(name)}?${esc(query.toString())}">Download worksheet CSV</a></p>${grid(columns[name],sheets[name].slice(0,100))}${sheets[name].length>100?'<p class="hint">Showing the first 100 rows. The CSV has the full worksheet.</p>':""}</details>`;
  const sourceLink=v=>`<a class="code" href="${href}/gst-document/${encodeURIComponent(v.id)}">${esc(v.number)}</a>`;
  const exceptional=issues.length?`<div class="attention-rule"><h2>Classification review</h2><p>Classify ${issues.length===1?"this document":"these documents"} before filing.</p><ul>${issues.map(v=>`<li>${v.voucherId?`<a class="code" href="${href}/v/${encodeURIComponent(v.type)}/${encodeURIComponent(v.voucherId)}">${esc(v.number)}</a>`:sourceLink(v)}: ${esc(v.reason)}</li>`).join("")}</ul></div>`:"";
  const hsnReview = report.hsnCheck.checks.length ? `<div class="attention-rule"><h2>HSN and SAC review</h2><p>Correct these codes in <a href="${href}/gst">GST setup</a> before filing.</p>
    <ul>${report.hsnCheck.checks.map(check => `<li>${sourceLink(check)} uses <span class="code">${esc(check.code)}</span>. ${esc(check.message)}</li>`).join("")}</ul></div>` : "";
  const amendments = report.amendments;
  const correctionLink = row => `${href}/gst-amendments/${encodeURIComponent(row.invoiceId)}?${new URLSearchParams({registration,month:row.amendmentPeriod})}`;
  const snapshotTotal = (snapshot,field) => (snapshot.rates || []).reduce((sum,row)=>sum+(row[field]||0),0);
  const taxTotal = snapshot => ["igstPaise","cgstPaise","sgstPaise","utgstPaise","cessPaise"].reduce((sum,key)=>sum+snapshotTotal(snapshot,key),0);
  const amendmentHead=["Posted document","Original period","Return table","Status","Taxable change ₹","IGST change ₹","CGST change ₹","SGST / UTGST change ₹","Cess change ₹"];
  const amendmentRows = amendments?.rows?.length ? `<div class="subsection" data-return-amendments><h2>Prepared return differentials</h2><p>These signed differences form this period's correction working paper.</p>${grid(amendmentHead,amendments.rows.map(row=>{ const filed=(row.effectiveStatus || row.status) === "filed"; return `<tr><td><a class="code" href="${correctionLink(row)}">${esc(row.number)}</a></td><td>${esc(monthLabel(row.originalPeriod))}</td><td>${esc(row.section.toUpperCase())}</td><td>${row.heldReason ? `<span class="pill bad">Held</span><div class="quiet">${esc(row.heldReason)}</div>` : `<span class="pill ${filed?"ok":"warn"}">${filed?"External filing recorded":"Prepared, not filed"}</span>`}</td><td class="figure">${money(row.delta.taxablePaise)}</td><td class="figure">${money(row.delta.igstPaise)}</td><td class="figure">${money(row.delta.cgstPaise)}</td><td class="figure">${money(row.delta.sgstPaise+row.delta.utgstPaise)}</td><td class="figure">${money(row.delta.cessPaise)}</td></tr>`; }))}</div>` : "";
  const comparatorHead=["Document","Book date","Filed taxable ₹","Book taxable ₹","Filed tax ₹","Book tax ₹","Correction period"];
  const reportedComparators = amendments?.comparators?.length ? `<div class="details-list"><details data-return-filed-comparators><summary>Known prior-filed figures and chronological books <small>${count(amendments.comparators.length,"document")}</small></summary><p>Historical return working uses the captured prior-filed figures for these documents. Book dates and values stay visible alongside them.</p>${grid(comparatorHead,amendments.comparators.map(row=>`<tr><td><a class="code" href="${correctionLink(row)}">${esc(row.number)}</a></td><td class="date-cell">${esc(dateLabel(row.revised.date))}</td><td class="figure">${money(snapshotTotal(row.originalReported,"taxablePaise"))}</td><td class="figure">${money(snapshotTotal(row.revised,"taxablePaise"))}</td><td class="figure">${money(taxTotal(row.originalReported))}</td><td class="figure">${money(taxTotal(row.revised))}</td><td>${esc(monthLabel(row.amendmentPeriod))}</td></tr>`))}</details></div>` : "";
  const savedMarkup = statements => statements.length ? `<details><summary>Saved GSTR-2B statements <small>${count(statements.length,"statement")}</small></summary><div class="table-scroll"><table><thead><tr><th>Saved on</th><th>Original files</th><th><span class="sr">Action</span></th></tr></thead><tbody>${statements.slice().reverse().map(s=>`<tr><td class="date-cell">${esc(savedLabel(s.savedAt))}</td><td>${s.files.map((f,i)=>`<a download href="${base}/gst-returns/statements/${encodeURIComponent(s.id)}/files/${i}">${esc(f.name)}</a>`).join(", ")}</td><td><button class="ghost" type="button" data-match-saved="${esc(s.id)}">Match against current books</button></td></tr>`).join("")}</tbody></table></div></details>` : "";
  const taxHead=["IGST ₹","CGST ₹","SGST / UTGST ₹","Cess ₹"];
  const signedTax=(row,sign)=>`<td class="figure">${money(row.igstPaise*sign)}</td><td class="figure">${money(row.cgstPaise*sign)}</td><td class="figure">${money((row.sgstPaise+row.utgstPaise)*sign)}</td><td class="figure">${money(row.cessPaise*sign)}</td>`;
  const reconciliation=report.hsnCheck.reconciliation;
  const outward=Object.keys(sheets).filter(n=>sheets[n].length);
  root.innerHTML=page({company,title:"GST returns",body:`${form}<p class="actions"><a class="button" data-return-corrections href="${href}/gst-amendments?${esc(query.toString())}">Review outward return corrections</a></p>${creditReviewMarkup(report.creditReviews || [],esc)}${exceptional}${hsnReview}${reportedComparators}${amendmentRows}
    <div class="subsection"><h2>GSTR-1 worksheets</h2><p>Outward documents recorded for <span class="code">${esc(report.registration.gstin)}</span> in ${esc(monthLabel(month))}.</p><p class="actions"><a class="button" download href="${base}/gst-returns/workbook?${esc(query.toString())}">Download GSTR-1 workbook</a><a class="button" download href="${base}/gst-returns/json?${esc(query.toString())}">Download GSTR-1 JSON</a><a class="button" download data-gstr3b-download aria-disabled="true">Download GSTR-3B JSON</a></p><p class="hint" data-gstr3b-file aria-live="polite">The GSTR-3B file is ready once the GSTR-3B working below has run.</p>
    <section aria-labelledby="upload-check-title"><h3 id="upload-check-title">Upload file check</h3><p class="subsection-intro">The JSON file is for the GST portal’s offline tool or the upload on the Returns dashboard. The checks below compare it with the published GSTN structure before you download.</p><div data-upload-check aria-live="polite" aria-busy="true"><p class="quiet">Checking the upload file for ${esc(monthLabel(month))}.</p></div></section>
    <div class="details-list">${reconciliation.some(x=>x.supplyPaise || x.hsnPaise) ? `<details${reconciliation.some(x=>x.differencePaise)?" open":""}><summary>Table 12 reconciliation${reconciliation.some(x=>x.differencePaise)?' <span class="pill warn">Difference</span>':""}</summary>${grid(["Supply type","Supply tables ₹","HSN summary ₹","Difference ₹"],reconciliation.map(r=>[r.type.toUpperCase(),formatINR(r.supplyPaise),formatINR(r.hsnPaise),formatINR(r.differencePaise)]))}</details>` : ""}
    ${outward.map(worksheet).join("")}</div>${outward.length?"":`<p class="empty">No outward documents are recorded for this month. <a href="${href}/gst-invoice">Post a sales invoice</a> dated in this month to start the worksheets.</p>`}</div>
    ${gstr3bShell({esc,registration:report.registration,month})}
    <div class="subsection"><h2>Purchase credit decisions</h2><p>Tables 4(A)(5), 4(B) and 4(D) of GSTR-3B take forward-charge credit from the decisions recorded in <a href="${href}/gst-itc">Purchase ITC review</a>.</p>
    ${report.itc.issues.length || report.itc.rows.length ? "" : `<p class="quiet">No credit decisions are recorded for ${esc(monthLabel(month))}.</p>`}
    ${report.itc.issues.length ? `<ul class="attention-rule">${report.itc.issues.map(i=>`<li>${esc(i.message)} <a href="${href}/gst-itc/${encodeURIComponent(i.invoiceId)}">Review entry</a></li>`).join("")}</ul>` : ""}
    ${report.itc.rows.length ? `<div class="details-list"><details><summary>Credit decisions for the period <small>${count(report.itc.rows.length,"decision")}</small></summary>${grid(["Review date","Purchase","Table","Reason",...taxHead],report.itc.rows.map(r=>`<tr><td class="date-cell">${esc(dateLabel(r.date))}</td><td><a class="code" href="${href}/gst-itc/${encodeURIComponent(r.invoiceId)}">${esc(r.number)}</a></td><td>${esc(r.table)}</td><td>${esc(r.reason)}</td>${signedTax(r,r.sign)}</tr>`))}</details></div>` : ""}
    </div>
    ${report.rcmRows.length ? `<div class="details-list"><details><summary>Reverse-charge entries for this period <small>${report.rcmRows.length} ${report.rcmRows.length===1?"entry":"entries"}</small></summary>${grid(["Date","Document","Entry",...taxHead],report.rcmRows.map(v=>`<tr><td class="date-cell">${esc(dateLabel(v.date))}</td><td>${sourceLink({id:v.invoiceId,number:v.number})}</td><td>${esc(v.reason)}</td>${signedTax(v,v.sign||1)}</tr>`))}</details></div>` : ""}
    <div class="subsection"><h2>Reconcile GSTR-2B</h2><p>Match the GSTR-2B statement from the GST portal against the purchase documents in these books.</p><form id="two-b" class="form-grid"><label class="wide">GSTR-2B JSON files from the GST portal <input type="file" accept=".json,application/json" multiple required></label><label class="check wide"><input type="checkbox" name="keep" checked><span>Save original files with this company<small>Saved statements can be matched again later and cited as ITC evidence.</small></span></label><div class="actions wide"><button type="submit">Match purchase documents</button></div></form><p class="form-message alert" role="alert" data-two-b-message></p><div class="details-list" data-saved-statements>${savedMarkup(report.statements || [])}</div><p class="form-message alert" role="alert" data-saved-message></p><p class="sr" role="status" data-two-b-status></p><div data-matches></div></div>
    <div class="details-list"><details><summary>Source documents <small>${count(evidence.length,"document")}</small></summary>${grid(["Date","Document","Party","Value ₹"],evidence.map(v=>`<tr><td class="date-cell">${esc(dateLabel(v.date))}</td><td>${sourceLink(v)}</td><td>${esc(v.party)}</td><td class="figure">${money(v.totalPaise)}</td></tr>`),"No GST documents are dated in this month. Post an invoice dated in it to see it here.")}</details></div>`});
  const periodForm=root.querySelector("#return-period");
  const fySelect=periodForm.querySelector("[data-return-fy]"), monthSelect=periodForm.querySelector("[data-return-month]"), monthField=periodForm.elements.month;
  fySelect.onchange=()=>{
    const fy=Number(fySelect.value), position=Math.max(0,FY_MONTHS.indexOf(Number(monthField.value.slice(5,7))));
    monthSelect.innerHTML=monthOptions(fy,monthValue(fy,FY_MONTHS[position]));
    monthField.value=monthSelect.value;
  };
  monthSelect.onchange=()=>{ monthField.value=monthSelect.value; };
  periodForm.onsubmit=e=>{
    e.preventDefault();
    const message=root.querySelector("[data-return-period-message]");
    if (!MONTH_PATTERN.test(monthField.value)) { message.textContent="Choose a financial year and a tax period month."; message.scrollIntoView({block:"nearest"}); return; }
    message.textContent="";
    location.hash=href+"/gst-returns?"+new URLSearchParams({registration:periodForm.elements.registration.value,month:monthField.value});
  };
  if (selectedCreditId && (report.creditReviews || []).some(row=>row.id===selectedCreditId)) root.querySelector("#section34-note").value=selectedCreditId;
  bindCreditReview(root,report.creditReviews || [],{
    esc,revision:report.creditReviewRevision,
    save:body=>api(base+"/gst-returns/credit-review",{method:"POST",body}),
    refresh:id=>still(token) && viewReturns(route,token,ui,id)
  });
  const savedBox=root.querySelector("[data-saved-statements]");
  const target=root.querySelector("[data-matches]"), status=root.querySelector("[data-two-b-status]");
  const formMessage=root.querySelector("[data-two-b-message]"), savedMessage=root.querySelector("[data-saved-message]");
  const announce=result=>{ status.textContent=`${count(result.results.length,"row")} compared.`; };
  const fail=(element,text)=>{ target.replaceChildren(); status.textContent=""; element.textContent=text; element.scrollIntoView({block:"nearest"}); };
  savedBox.onclick=async e=>{
    const button=e.target.closest("[data-match-saved]");
    if(!button)return;
    button.disabled=true; savedMessage.textContent=""; formMessage.textContent="";
    try {
      const result=await api(base+"/gst-returns/statements/"+encodeURIComponent(button.dataset.matchSaved));
      if(still(token)){showMatches(target,result,{esc,href,formatINR});announce(result);}
    } catch(error){ if(still(token))fail(savedMessage,error.message); } finally{button.disabled=false;}
  };
  root.querySelector("#two-b").onsubmit=async e=>{
    e.preventDefault();const form=e.currentTarget, button=form.querySelector("button");button.disabled=true;
    formMessage.textContent=""; savedMessage.textContent="";
    try{
      const files=[...form.querySelector('input[type="file"]').files];
      if(files.reduce((n,f)=>n+f.size,0)>32*1024*1024)throw new Error("Choose up to 32 MB of statement files");
      let result;
      if(form.elements.keep.checked) {
        const sources=await Promise.all(files.map(file=>new Promise((resolve,reject)=>{
          const reader=new FileReader();reader.onerror=()=>reject(new Error("The selected file could not be read. Choose the file again."));
          reader.onload=()=>resolve({name:file.name,base64:String(reader.result).split(",")[1]});reader.readAsDataURL(file);
        })));
        result=await api(base+"/gst-returns/statements?"+query,{method:"POST",body:{files:sources}});
        if(!still(token))return;
        report.statements ||= [];
        if(!report.statements.some(s=>s.id===result.statement.id))report.statements.push(result.statement);
        savedBox.innerHTML=savedMarkup(report.statements);
      } else result=await api(base+"/gst-returns/reconcile-2b?"+query,{method:"POST",body:await Promise.all(files.map(async file=>JSON.parse(await file.text())))});
      if(!still(token))return;
      showMatches(target,result,{ esc,href,formatINR });
      announce(result);
    }catch(err){ if(still(token))fail(formMessage,err instanceof SyntaxError?"Choose a valid GSTR-2B JSON file from the GST portal.":err.message); }finally{button.disabled=false;}
  };
  showUploadCheck();
  const shownIssues=new Set([...issues.map(v=>issueKey(v)),...report.itc.issues.map(i=>issueKey(i))]);
  mountGstr3b({root,api,esc,formatINR,still,token,base,href,company,registrations,registration,month,shownIssues});

  /* The upload summary is fetched after the page is on screen so the worksheets never wait for it. */
  async function showUploadCheck() {
    const box=root.querySelector("[data-upload-check]");
    if(!box)return;
    let check;
    try { check=await api(base+"/gst-returns/json/summary?"+query); }
    catch(error){ if(still(token)){ box.innerHTML=`<p class="quiet">The upload file check could not run. ${esc(error.message)}</p>`; box.setAttribute("aria-busy","false"); } return; }
    if(!still(token))return;
    box.innerHTML=uploadCheckMarkup(check);
    box.setAttribute("aria-busy","false");
  }
  function uploadCheckMarkup(check) {
    const used=JSON_SECTIONS.filter(([name])=>check.sections?.[name]?.documents);
    const amount=paise=>paise?`<td class="figure">${money(paise)}</td>`:'<td class="figure quiet">—</td>';
    const sectionRows=used.map(([name,label])=>{ const t=check.sections[name]; return `<tr><th scope="row"><span class="code">${esc(name)}</span><small>${esc(label)}</small></th><td class="gst-num">${Number(t.documents)||0}</td><td class="gst-num">${Number(t.items)||0}</td>${amount(t.invoiceValuePaise)}${amount(t.taxablePaise)}${amount(t.igstPaise)}${amount(t.cgstPaise)}${amount(t.sgstPaise)}${amount(t.cessPaise)}</tr>`; });
    const hsn=check.hsn||{}, docs=check.docIssue||{}, nil=check.nil||{};
    const hsnText=hsn.layout==="split"?`Split into B2B and B2C tables, ${count(hsn.b2b?.rows||0,"B2B row")} and ${count(hsn.b2c?.rows||0,"B2C row")}`:`One combined table, ${count((hsn.b2b?.rows||0)+(hsn.b2c?.rows||0),"row")}`;
    const docText=`${count(docs.ranges||0,"number range")} across ${docs.categories===1?"1 document type":`${docs.categories||0} document types`}. ${count(docs.documents||0,"document")} issued, ${docs.cancelled||0} cancelled.`;
    const headsText=check.taxHeads==="derived"?"Worked out from rate and taxable value":"Taken from the booked vouchers";
    const problems=[
      ...(check.issues||[]).map(issue=>`<li>${issue.voucherId?`<a class="code" href="${href}/v/${encodeURIComponent(issue.type)}/${encodeURIComponent(issue.voucherId)}">${esc(issue.number)}</a>`:issue.id?sourceLink(issue):`<span class="code">${esc(issue.number||"")}</span>`}: ${esc(issue.reason||issue.message||"")}</li>`),
      ...(check.warnings||[]).map(warning=>`<li><span class="code">${esc(warning.path)}</span> holds ${/\.qty$/.test(warning.path||"")?`a negative quantity of ${esc(Math.abs(Number(warning.value)))}`:`a negative amount of ₹${esc(formatINR(Math.abs(Math.round(Number(warning.value)*100))))}`}. ${esc(warning.message)}.</li>`),
      ...(check.hsnComplete===false?[`<li>The HSN summary is not complete. Settle the HSN and SAC review and the Table 12 reconciliation on this page first.</li>`]:[])
    ];
    const head=["Section","Documents","Items","Invoice value ₹","Taxable ₹","IGST ₹","CGST ₹","SGST ₹","Cess ₹"];
    return `<p>${check.ready?'<span class="pill ok">Ready to upload</span>':'<span class="pill warn">Check before uploading</span>'}</p>
      <dl class="kv"><dt>File name</dt><dd class="code">${esc(check.fileName)}</dd><dt>Return period</dt><dd><span class="code">${esc(check.fp)}</span> for ${esc(monthLabel(check.month))}</dd><dt>Version</dt><dd class="code">${esc(check.version)}</dd><dt>Tax heads</dt><dd>${headsText}</dd><dt>HSN summary</dt><dd>${hsnText}</dd><dt>Documents issued</dt><dd>${docText}</dd><dt>Nil, exempt and non-GST</dt><dd>${count(nil.rows||0,"row")}</dd></dl>
      ${problems.length?`<div class="attention-rule"><p>Settle ${problems.length===1?"this point":"these points"} before uploading the file.</p><ul>${problems.join("")}</ul></div>`:""}
      ${used.length?`<div class="table-scroll"><table><thead><tr>${head.map((c,i)=>`<th${i>2?' class="figure"':i?' class="gst-num"':""}>${esc(c)}</th>`).join("")}</tr></thead><tbody>${sectionRows.join("")}</tbody></table></div>`:`<p class="empty">The file has no invoice or note sections for this month. <a href="${href}/gst-invoice">Post a sales invoice</a> dated in it to fill them.</p>`}`;
  }
}

/* ---------- GSTR-3B: header entries, the portal tables and the cash payable ---------- */

const HEADS = ["igst","cgst","sgst","cess"];
const HEAD_SHORT = {igst:"IGST",cgst:"CGST",sgst:"SGST/UTGST",cess:"Cess"};
const HEAD_TITLE = {igst:"Integrated tax",cgst:"Central tax",sgst:"State/UT tax",cess:"Cess"};
const HEAD_WORDS = {igst:"integrated tax",cgst:"central tax",sgst:"State/UT tax",cess:"cess"};
const cap = word => word[0].toUpperCase() + word.slice(1);
/* Header entries the books do not hold. Field names are the query names of GET .../gst-returns/3b. */
const GSTR3B_GROUPS = [
  {prefix:"credit",legend:"Electronic credit ledger balance before this return",what:"the credit ledger balance",note:"Credit already in the ledger is used together with this period's net credit in Table 4(C).",heads:HEADS},
  {prefix:"cash",legend:"Electronic cash ledger balance",what:"the cash ledger balance",note:"Cash already in the ledger reduces what you deposit now. Credited by the due date, it also leaves the interest base.",heads:HEADS,dates:[["cashDate","Date this balance was credited"]]},
  {prefix:"reversal",legend:"Credit wrongly availed and utilised",what:"the wrongly availed credit",note:"Interest under section 50(3) runs from the date it was utilised to the date it was reversed.",heads:HEADS,dates:[["reversalUtilisedDate","Date it was utilised"],["reversalDate","Date it was reversed"]]},
  {prefix:"importGoods",legend:"Import of goods, Table 4(A)(1)",what:"import of goods",note:"Take these from your bills of entry. The books do not record them.",heads:["igst","cess"]},
  {prefix:"isd",legend:"Credit from an input service distributor, Table 4(A)(4)",what:"ISD credit",note:"Take these from the ISD invoices. The books do not record them.",heads:HEADS},
];
const AMOUNT_WHAT = new Map([["turnover","the preceding year's aggregate turnover"],...GSTR3B_GROUPS.flatMap(g=>g.heads.map(h=>[g.prefix+cap(h),`${HEAD_SHORT[h]} in ${g.what}`]))]);
const PERIOD_FIELDS = ["dueDate","paymentDate","filingDate",...GSTR3B_GROUPS.flatMap(g=>[...g.heads.map(h=>g.prefix+cap(h)),...(g.dates||[]).map(([name])=>name)])];
const LEDGER_FIELDS = PERIOD_FIELDS.filter(name=>!["dueDate","paymentDate","filingDate"].includes(name));
/* Proviso to rule 61(5) (Notification 82/2020-CT): quarterly returns are due on the 22nd for these State codes, the 24th for the rest. */
const QRMP_22 = new Set(["22","23","24","25","26","27","29","30","31","32","33","34","35","36","37","97"]);
const nextMonth = month => { const n=Number(month.slice(0,4))*12+Number(month.slice(5,7)); return `${Math.floor(n/12)}-${String(n%12+1).padStart(2,"0")}`; };
const statutoryDue = (month,frequency,stateCode) => nextMonth(month)+(frequency==="quarterly"?(QRMP_22.has(stateCode)?"-22":"-24"):"-20");
const quarterEnd = month => `${month.slice(0,4)}-${String(Math.ceil(Number(month.slice(5,7))/3)*3).padStart(2,"0")}`;
const quarterLabel = end => { const m=Number(end.slice(5,7)); return `${MONTHS[m-3]} to ${MONTHS[m-1]} ${end.slice(0,4)}`; };
const periodOptions = (fy,frequency,selected) => frequency==="quarterly"
  ? [6,9,12,3].map(m=>{ const value=monthValue(fy,m); return `<option value="${value}"${value===selected?" selected":""}>${quarterLabel(value)}</option>`; }).join("")
  : monthOptions(fy,selected);
const periodText = working => working.frequency==="quarterly" ? quarterLabel(working.month) : monthLabel(working.month);
const draftKey = (companyId,registrationId) => `ledgercraft-gstr3b:${companyId}:${registrationId}`;
function readDraft(key) {
  try { const value=JSON.parse(localStorage.getItem(key)||"null"); return value && typeof value==="object" ? { frequency:value.frequency==="quarterly"?"quarterly":"monthly", turnover:String(value.turnover||""), periods:value.periods&&typeof value.periods==="object"?value.periods:{} } : null; }
  catch { return null; }
}
function writeDraft(key,draft) { try { localStorage.setItem(key,JSON.stringify(draft)); } catch { /* storage full or unavailable: entries still work for this visit */ } }
const issueKey = issue => [issue.voucherId||issue.id||issue.invoiceId||"",issue.number||"",issue.reason||issue.message||""].join("|");

function gstr3bShell({esc,registration,month}) {
  const fy=fyOf(month);
  const amount=(name,label)=>`<label>${esc(label)}<input name="${esc(name)}" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0.00"></label>`;
  const groups=GSTR3B_GROUPS.map(g=>`<fieldset><legend>${esc(g.legend)}</legend><p class="field-note">${esc(g.note)}</p><div class="gstr3b-heads">${g.heads.map(h=>amount(g.prefix+cap(h),`${HEAD_SHORT[h]} (₹)`)).join("")}${(g.dates||[]).map(([name,label])=>`<label>${esc(label)}<input type="date" name="${esc(name)}"></label>`).join("")}</div></fieldset>`).join("");
  return `<section class="subsection gstr3b" aria-labelledby="gstr3b-title">
    <h2 id="gstr3b-title">GSTR-3B</h2>
    <p>Enter what the books cannot know, then work out the return. The tables follow the portal's numbering and end in the cash to deposit.</p>
    <form id="gstr3b-header" class="form-grid" novalidate aria-describedby="gstr3b-keep">
      <label>Return period<select name="month">${periodOptions(fy,"monthly",month)}</select></label>
      <label>Filing frequency<select name="frequency"><option value="monthly">Monthly</option><option value="quarterly">Quarterly (QRMP scheme)</option></select></label>
      <label>Extended due date<input type="date" name="dueDate"><span class="field-note" data-gstr3b-due></span></label>
      <label>Preceding year's aggregate turnover (₹)<input name="turnover" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0.00"><span class="field-note">Sets the late fee cap. Count every registration on this PAN.</span></label>
      <label>Payment date<input type="date" name="paymentDate"><span class="field-note">Interest runs from the due date to this date.</span></label>
      <label>Filing date<input type="date" name="filingDate"><span class="field-note">Late fee runs from the due date to this date.</span></label>
      <div class="wide actions"><button type="button" class="ghost" data-gstr3b-save-settings>Save frequency and turnover</button><p class="field-note" role="status" data-gstr3b-settings-status>Reading the saved filing frequency and turnover.</p></div>
      <div class="details-list wide"><details data-gstr3b-ledgers><summary>Ledger balances and credit the books do not record <small data-gstr3b-ledger-count></small></summary><div class="gstr3b-groups">${groups}</div></details></div>
      <div class="actions wide"><button type="submit">Work out GSTR-3B <kbd>⌘↩</kbd></button><button type="button" class="ghost" data-gstr3b-clear>Clear this period's entries</button></div>
      <p class="field-note wide" id="gstr3b-keep">Entries stay on this Mac for ${esc(registration.gstin)}, one set per return period. Return moves to the next field.</p>
    </form>
    <p class="sr" role="status" data-gstr3b-status></p>
    <p class="quiet" data-gstr3b-stale hidden>The entries have changed. Work out GSTR-3B again to update the figures and the JSON file.</p>
    <div data-gstr3b-result aria-busy="true"><p class="quiet">Working out GSTR-3B for ${esc(monthLabel(month))}.</p></div>
  </section>`;
}

function mountGstr3b(ctx) {
  const {root,api,esc,formatINR,still,token,base,href,company,registrations,registration,month:pageMonth,shownIssues}=ctx;
  const form=root.querySelector("#gstr3b-header");
  if(!form)return;
  const reg=registrations.find(r=>r.id===registration)||registrations[0];
  const key=draftKey(company.id,reg.id);
  const draft=readDraft(key)||{frequency:"monthly",turnover:"",periods:{}};
  const result=root.querySelector("[data-gstr3b-result]"), status=root.querySelector("[data-gstr3b-status]"), stale=root.querySelector("[data-gstr3b-stale]");
  const download=root.querySelector("[data-gstr3b-download]"), fileLine=root.querySelector("[data-gstr3b-file]");
  const dueNote=form.querySelector("[data-gstr3b-due]"), ledgers=form.querySelector("[data-gstr3b-ledgers]"), ledgerCount=form.querySelector("[data-gstr3b-ledger-count]");
  const submit=form.querySelector('button[type="submit"]');
  const fy=fyOf(pageMonth);
  const el=name=>form.elements[name];
  let sequence=0;

  const fillPeriod=()=>{
    const saved=draft.periods[el("month").value]||{};
    for(const name of PERIOD_FIELDS) el(name).value=typeof saved[name]==="string"?saved[name]:"";
    for(const name of PERIOD_FIELDS) el(name).removeAttribute("aria-invalid");
    ledgers.open=LEDGER_FIELDS.some(name=>el(name).value.trim());
  };
  const setPeriodChoices=selected=>{
    const frequency=el("frequency").value;
    const value=frequency==="quarterly"?quarterEnd(selected):selected;
    el("month").innerHTML=periodOptions(fy,frequency,value);
    el("month").value=value;
  };
  const showDue=()=>{
    const due=statutoryDue(el("month").value,el("frequency").value,reg.stateCode);
    dueNote.textContent=`The return is due on ${dateLabel(due)} under rule 61(5). Enter a date here only when a notification extends it.`;
  };
  const countLedgers=()=>{
    const n=LEDGER_FIELDS.filter(name=>el(name).value.trim()).length;
    ledgerCount.textContent=n?`${n} ${n===1?"entry":"entries"}`:"None entered";
  };
  const remember=()=>{
    const values=Object.fromEntries(PERIOD_FIELDS.map(name=>[name,el(name).value.trim()]).filter(([,v])=>v));
    if(Object.keys(values).length) draft.periods[el("month").value]=values; else delete draft.periods[el("month").value];
    writeDraft(key,draft);
  };
  const alertBox=()=>{
    let box=form.querySelector("[data-form-error]");
    if(!box){ box=document.createElement("p"); box.className="form-message alert wide"; box.setAttribute("role","alert"); box.setAttribute("tabindex","-1"); box.dataset.formError="1"; form.prepend(box); }
    return box;
  };
  const showAlert=message=>{ const box=alertBox(); box.textContent=message; box.scrollIntoView({block:"nearest"}); box.focus({preventScroll:true}); };
  const clearAlert=()=>{ const box=form.querySelector("[data-form-error]"); if(box) box.textContent=""; };
  /* Amounts are rupee text; the server parses them with the same rules, so a bad entry is caught here first and named. */
  const checkAmounts=()=>{
    for(const [name,what] of AMOUNT_WHAT){
      const input=el(name), raw=input.value.trim();
      input.removeAttribute("aria-invalid");
      if(!raw)continue;
      let message="";
      if(/^-/.test(raw)) message=`${cap(what)} cannot be negative. Enter it as a positive amount.`;
      else { try { parseRupees(raw); } catch { message=`Enter ${what} in rupees, such as 1,500.50.`; } }
      if(message){
        input.setAttribute("aria-invalid","true");
        if(input.closest("details")) input.closest("details").open=true;
        showAlert(message); input.focus(); return false;
      }
    }
    return true;
  };
  const headerQuery=()=>{
    const query=new URLSearchParams({registration:reg.id,month:el("month").value,frequency:el("frequency").value});
    for(const name of ["turnover",...PERIOD_FIELDS]){
      const raw=el(name).value.trim();
      if(raw) query.set(name,AMOUNT_WHAT.has(name)?raw.replace(/[\s,₹]/g,""):raw);
    }
    return query;
  };
  const setDownload=(query,working)=>{
    if(working){
      download.href=`${base}/gst-returns/3b.json?${query}`;
      download.removeAttribute("aria-disabled");
      fileLine.innerHTML=`GSTR-3B file name <span class="code">${esc(`GSTR3B_${working.registration.gstin}_${working.returnPeriod}.json`)}</span>, for ${esc(periodText(working))} with the entries in the GSTR-3B working below.`;
    } else {
      download.removeAttribute("href");
      download.setAttribute("aria-disabled","true");
      fileLine.textContent="Correct the GSTR-3B entries below to download its JSON file.";
    }
  };
  /* Filing frequency and the preceding year's turnover are saved per registration on the server
     (GET and POST .../gst-returns/3b/settings). The fields start from the saved settings. A change
     works out the return at once with the new entries and stays unsaved until Save. */
  const settingsPath=`${base}/gst-returns/3b/settings?${new URLSearchParams({registration:reg.id})}`;
  const saveButton=form.querySelector("[data-gstr3b-save-settings]"), settingsStatus=form.querySelector("[data-gstr3b-settings-status]");
  let settings=null, settingsError="", settingsRequest=null, settingsBusy=false;
  const turnoverText=paise=>Number.isInteger(paise)?formatINR(paise):"";
  const turnoverPaise=()=>{ const raw=el("turnover").value.trim().replace(/[\s,₹]/g,""); return raw?parseRupees(raw):null; };
  const settingsChanged=()=>{
    if(!settings)return false;
    let paise;
    try { paise=turnoverPaise(); } catch { return true; }
    return el("frequency").value!==settings.frequency||paise!==settings.aggregateTurnoverPaise;
  };
  const showSettings=()=>{
    if(!settings){ settingsStatus.textContent=settingsError?`The saved frequency and turnover could not be read. ${settingsError}. Monthly filing is assumed until they are saved.`:"Reading the saved filing frequency and turnover."; return; }
    if(settingsChanged()){
      const blank=!el("turnover").value.trim()&&Number.isInteger(settings.aggregateTurnoverPaise);
      settingsStatus.textContent=`Not saved. The working uses these entries for now; Save keeps them for every return period of ${reg.gstin}.${blank?` With the turnover blank, the working still uses the saved ₹${formatINR(settings.aggregateTurnoverPaise)}.`:""}`;
    }
    else if(settings.source==="saved") settingsStatus.textContent=`Saved for ${reg.gstin} on ${savedLabel(settings.updatedAt)}.`;
    else settingsStatus.textContent=`Default: monthly filing with no turnover entered. Save to keep a frequency and turnover for ${reg.gstin}.`;
  };
  const takeSettings=next=>{
    settings=next;
    el("frequency").value=next.frequency==="quarterly"?"quarterly":"monthly";
    el("turnover").value=turnoverText(next.aggregateTurnoverPaise);
    el("turnover").removeAttribute("aria-invalid");
  };
  saveButton.addEventListener("click",async()=>{
    if(settingsBusy)return;
    const raw=el("turnover").value.trim();
    let paise;
    try { if(/^-/.test(raw)) throw new Error(); paise=turnoverPaise(); }
    catch { el("turnover").setAttribute("aria-invalid","true"); showAlert(`Enter ${AMOUNT_WHAT.get("turnover")} in rupees, such as 1,500.50, or leave it blank.`); el("turnover").focus(); return; }
    clearAlert();
    const body={frequency:el("frequency").value,aggregateTurnoverPaise:paise};
    /* The same entries keep their request identifier, so a retry after a lost answer is not saved twice. */
    const same=JSON.stringify(body);
    if(settingsRequest?.body!==same) settingsRequest={body:same,id:crypto.randomUUID()};
    settingsBusy=true; saveButton.disabled=true; saveButton.setAttribute("aria-busy","true");
    try {
      const answer=await api(settingsPath,{method:"POST",body:{...body,requestId:settingsRequest.id,...(settings?{expected:{updatedAt:settings.updatedAt??null}}:{})}});
      if(!still(token))return;
      settingsRequest=null;
      settingsError="";
      takeSettings(answer.settings);
      showSettings();
    } catch(error){
      if(!still(token)||error.signIn)return;
      showAlert(error.message);
    } finally {
      settingsBusy=false; saveButton.disabled=false; saveButton.removeAttribute("aria-busy");
    }
  });
  async function workOut({focusResult=false}={}){
    if(!checkAmounts())return;
    clearAlert();
    remember();
    const query=headerQuery(), mine=++sequence;
    result.setAttribute("aria-busy","true");
    submit.disabled=true;
    let working;
    try { working=await api(`${base}/gst-returns/3b?${query}`); }
    catch(error){
      if(!still(token)||mine!==sequence)return;
      submit.disabled=false;
      result.setAttribute("aria-busy","false");
      setDownload(query,null);
      result.innerHTML=`<p class="quiet">The GSTR-3B figures are not shown until the entries above are corrected.</p>`;
      showAlert(error.message);
      return;
    }
    if(!still(token)||mine!==sequence)return;
    submit.disabled=false;
    stale.hidden=true;
    result.innerHTML=gstr3bMarkup(working,{esc,formatINR,href,shownIssues});
    result.setAttribute("aria-busy","false");
    setDownload(query,working);
    status.textContent=`GSTR-3B worked out for ${periodText(working)}. Total to deposit ₹${formatINR(working.summary.depositRequiredPaise)}.`;
    if(focusResult) result.querySelector("h3")?.scrollIntoView({block:"nearest"});
  }

  el("frequency").value="monthly";
  setPeriodChoices(pageMonth);
  fillPeriod(); showDue(); countLedgers();

  form.addEventListener("input",event=>{
    if(event.target.name==="month"||event.target.name==="frequency")return;
    event.target.removeAttribute("aria-invalid");
    remember(); countLedgers();
    if(event.target.name==="turnover") showSettings();
    if(result.querySelector("table")) stale.hidden=false;
  });
  el("frequency").addEventListener("change",()=>{ setPeriodChoices(el("month").value); fillPeriod(); showDue(); countLedgers(); showSettings(); workOut(); });
  el("month").addEventListener("change",()=>{ fillPeriod(); showDue(); countLedgers(); workOut(); });
  form.querySelector("[data-gstr3b-clear]").addEventListener("click",()=>{
    delete draft.periods[el("month").value];
    writeDraft(key,draft);
    fillPeriod(); countLedgers(); clearAlert();
    status.textContent=`Entries for ${el("month").selectedOptions[0]?.textContent||""} cleared.`;
    workOut();
  });
  form.addEventListener("submit",event=>{ event.preventDefault(); workOut({focusResult:true}); });
  const focusable=()=>[...form.querySelectorAll("input, select, button, summary")].filter(c=>!c.disabled&&c.tabIndex>=0&&c.type!=="hidden"&&c.getClientRects().length);
  form.addEventListener("keydown",event=>{
    if(event.key!=="Enter"||event.isComposing)return;
    if(event.metaKey||event.ctrlKey){ event.preventDefault(); form.requestSubmit(); return; }
    const target=event.target;
    if(!(target instanceof HTMLInputElement||target instanceof HTMLSelectElement))return;
    event.preventDefault();
    const order=focusable(), next=order[order.indexOf(target)+(event.shiftKey?-1:1)];
    if(next){ next.focus(); if(next instanceof HTMLInputElement&&next.type!=="date") next.select(); }
  });
  /* The return is worked out once the saved frequency and turnover are in the fields. */
  (async()=>{
    try { takeSettings(await api(settingsPath)); }
    catch(error){ if(!still(token)||error.signIn)return; settingsError=String(error.message||"").replace(/\.$/,""); }
    if(!still(token))return;
    setPeriodChoices(el("month").value); fillPeriod(); showDue(); countLedgers();
    showSettings();
    workOut();
  })();
}

/* Negative figures the portal rejects in the upload file; mirrors the checks in gstr3bExport. */
function negativeFigures(w) {
  const out=[];
  const check=(label,value)=>{ if(value<0) out.push([label,value]); };
  const fields31={a:["taxablePaise",...HEADS.map(h=>h+"Paise")],b:["taxablePaise","igstPaise","cessPaise"],c:["taxablePaise"],d:["taxablePaise",...HEADS.map(h=>h+"Paise")],e:["taxablePaise"]};
  const fieldName=f=>f==="taxablePaise"?"taxable value":HEAD_SHORT[f.replace("Paise","")];
  for(const [row,fields] of Object.entries(fields31)) for(const f of fields) check(`Table 3.1(${row}) ${fieldName(f)}`,w.table31[row][f]);
  for(const [kind,label] of [["unregistered","unregistered persons"],["composition","composition dealers"],["uin","UIN holders"]]) for(const r of w.table32[kind]) { check(`Table 3.2 ${label}, ${r.posName}, taxable value`,r.taxablePaise); check(`Table 3.2 ${label}, ${r.posName}, IGST`,r.igstPaise); }
  const t4=[["4(A)(1)",w.table4.A.importGoods],["4(A)(2)",w.table4.A.importServices],["4(A)(3)",w.table4.A.inwardRcm],["4(A)(4)",w.table4.A.isd],["4(A)(5)",w.table4.A.allOther],["4(B)(1)",w.table4.B.rules],["4(B)(2)",w.table4.B.others],["4(C)",w.table4.C],["4(D)(1)",w.table4.D.reclaimed],["4(D)(2)",w.table4.D.restricted]];
  for(const [label,row] of t4) for(const h of HEADS) check(`Table ${label} ${HEAD_SHORT[h]}`,row[h+"Paise"]);
  for(const [kind,label] of [["gst","exempt, nil-rated and composition"],["nonGst","non-GST"]]) { check(`Table 5 ${label}, inter-State`,w.table5[kind].interPaise); check(`Table 5 ${label}, intra-State`,w.table5[kind].intraPaise); }
  return out;
}

function gstr3bMarkup(w,{esc,formatINR,href,shownIssues}) {
  const rupee=paise=>`${paise<0?"-":""}₹${formatINR(Math.abs(paise||0))}`;
  const na=`<td class="figure quiet"><span aria-hidden="true">—</span><span class="sr">Not applicable</span></td>`;
  const cell=(paise,applicable=true)=>applicable?`<td class="figure${paise?"":" quiet"}">${esc(formatINR(paise||0))}</td>`:na;
  const sum=(value,keys=HEADS)=>keys.reduce((s,h)=>s+(value[h+"Paise"]||0),0);
  const headCols=`<th class="figure">IGST ₹</th><th class="figure">CGST ₹</th><th class="figure">SGST/UTGST ₹</th><th class="figure">Cess ₹</th>`;
  const headCells=(row,applies=[true,true,true,true])=>HEADS.map((h,i)=>cell(row[h+"Paise"],applies[i])).join("");
  const period=periodText(w);
  const t31=w.table31, t32=w.table32, t4=w.table4, t5=w.table5, t6=w.table6, s=w.summary;

  /* Nil return, said plainly. Nothing recorded at all is a nil return; liability alone being nil is not. */
  const anySupply=Object.values(t31).some(r=>r.taxablePaise||sum(r)) || ["unregistered","composition","uin"].some(k=>t32[k].length);
  const anyCredit=[...Object.values(t4.A).filter(r=>r&&typeof r==="object"),...Object.values(t4.B),t4.C,...Object.values(t4.D)].some(r=>sum(r));
  const anyInward=t5.totals.interPaise||t5.totals.intraPaise;
  const nilLine=s.nil&&!anySupply&&!anyCredit&&!anyInward
    ? `<p class="gstr3b-verdict"><span class="pill ok">Nil return</span> Every figure in GSTR-3B for ${esc(period)} is zero, so file it as a nil return.</p>`
    : s.nil ? `<p class="gstr3b-verdict"><span class="pill info">No tax payable</span> No tax is payable for ${esc(period)}. File the tables below all the same.</p>` : "";
  const cashUsed=s.cashPayableTotalPaise-s.depositRequiredPaise;
  const strip=`<div class="summary-strip">
    <div><span>Tax payable in cash</span><strong>${esc(rupee(s.cashTaxPaise))}</strong></div>
    <div><span>Interest</span><strong>${esc(rupee(s.interestPaise))}</strong></div>
    <div><span>Late fee</span><strong>${esc(rupee(s.lateFeePaise))}</strong></div>
    <div><span>Total to deposit</span><strong>${esc(rupee(s.depositRequiredPaise))}</strong>${cashUsed>0?`<small>After ${esc(rupee(cashUsed))} already in the cash ledger</small>`:""}</div>
    <div><span>Credit carried forward</span><strong>${esc(rupee(s.creditCarriedForwardPaise))}</strong></div>
  </div>`;
  const details=`<dl class="kv"><dt>GSTIN</dt><dd class="code">${esc(w.registration.gstin)}</dd><dt>Return period</dt><dd>${esc(period)}${w.frequency==="quarterly"?", quarterly":""} <span class="quiet">(<span class="code">${esc(w.returnPeriod)}</span> in the file)</span></dd><dt>Due date</dt><dd>${esc(dateLabel(w.dueDate))}</dd><dt>Payment date</dt><dd>${w.paymentDate?esc(dateLabel(w.paymentDate)):'<span class="quiet">Not entered</span>'}</dd><dt>Filing date</dt><dd>${w.filingDate?esc(dateLabel(w.filingDate)):'<span class="quiet">Not entered</span>'}</dd></dl>`;

  /* Issues from the working, less the ones the page already lists above. */
  const link=issue=>issue.voucherId?`<a class="code" href="${href}/v/${encodeURIComponent(issue.type||"Journal")}/${encodeURIComponent(issue.voucherId)}">${esc(issue.number||"Voucher")}</a>: `
    :issue.invoiceId?`<a class="code" href="${href}/gst-itc/${encodeURIComponent(issue.invoiceId)}">${esc(issue.number||"Purchase entry")}</a>: `
    :issue.id?`<a class="code" href="${href}/gst-document/${encodeURIComponent(issue.id)}">${esc(issue.number||"Document")}</a>: `:"";
  const fresh=w.issues.filter(i=>!shownIssues.has(issueKey(i)));
  const repeated=w.issues.length-fresh.length;
  const negatives=negativeFigures(w);
  const points=[...fresh.map(i=>`<li>${link(i)}${esc(String(i.reason||i.message||"").replace(/\bRs (?=\d)/g,"₹"))}${/[.?]$/.test(i.reason||i.message||"")?"":"."}</li>`),
    ...negatives.map(([label,value])=>`<li>${esc(label)} is ${esc(rupee(value))}. The portal does not accept a negative figure there, so settle it before uploading the JSON file.</li>`)];
  const attention=points.length
    ? `<div class="attention-rule"><h3>Before you file</h3><p>Settle ${points.length===1?"this point":"these points"} for ${esc(period)}.${repeated?" The points listed higher on this page apply too.":""}</p><ul>${points.join("")}</ul></div>`
    : `<p class="quiet">Nothing in the working holds this return back.${repeated?" Settle the points listed higher on this page first.":""}</p>`;

  /* 3.1: cells the portal greys out are shown as not applicable. */
  const rows31=[["a",[true,true,true,true]],["b",[true,false,false,true]],["c",[false,false,false,false]],["d",[true,true,true,true]],["e",[false,false,false,false]]];
  const table31=`<h3>3.1 Outward supplies and inward supplies liable to reverse charge</h3><div class="table-scroll"><table><thead><tr><th>Nature of supplies</th><th class="figure">Total taxable value ₹</th>${headCols}</tr></thead><tbody>${rows31.map(([k,applies])=>`<tr><th scope="row">(${k}) ${esc(t31[k].label)}</th>${cell(t31[k].taxablePaise)}${headCells(t31[k],applies)}</tr>`).join("")}</tbody></table></div>
    <p class="quiet">3.1.1 is left at zero: the books do not record supplies under section 9(5) made through an e-commerce operator.</p>`;

  /* 3.2: one row per place of supply, the three recipient groups side by side. */
  const posRows=new Map();
  for(const kind of ["unregistered","composition","uin"]) for(const r of t32[kind]){ if(!posRows.has(r.pos)) posRows.set(r.pos,{pos:r.pos,posName:r.posName}); posRows.get(r.pos)[kind]=r; }
  const pair=r=>cell(r?.taxablePaise||0)+cell(r?.igstPaise||0);
  const table32=`<h3>3.2 Inter-State supplies to unregistered persons, composition dealers and UIN holders</h3>${posRows.size?`<div class="table-scroll"><table><thead><tr><th rowspan="2">Place of supply</th><th colspan="2" class="gstr3b-span">Unregistered persons</th><th colspan="2" class="gstr3b-span">Composition dealers</th><th colspan="2" class="gstr3b-span">UIN holders</th></tr><tr>${'<th class="figure">Taxable value ₹</th><th class="figure">IGST ₹</th>'.repeat(3)}</tr></thead>
    <tbody>${[...posRows.values()].sort((a,b)=>a.pos.localeCompare(b.pos)).map(r=>`<tr><th scope="row">${esc(r.posName)} <span class="code quiet">${esc(r.pos)}</span></th>${pair(r.unregistered)}${pair(r.composition)}${pair(r.uin)}</tr>`).join("")}</tbody>
    <tfoot><tr class="total"><th scope="row">Total</th>${pair(t32.totals.unregistered)}${pair(t32.totals.composition)}${pair(t32.totals.uin)}</tr></tfoot></table></div>`
    :`<p class="quiet">No inter-State supplies to unregistered persons, composition dealers or UIN holders in ${esc(period)}.</p>`}`;

  /* 4: A1 to A5, B1 B2, C, D1 D2. */
  const entered=`<small class="quiet">Entered above</small>`;
  const row4=(r,note="")=>`<tr><th scope="row">${esc(r.label)}${note}</th>${headCells(r)}</tr>`;
  const group=label=>`<tr class="gstr3b-group"><th scope="rowgroup" colspan="5">${esc(label)}</th></tr>`;
  const table4=`<h3>4 Eligible ITC</h3><div class="table-scroll"><table><thead><tr><th>Details</th>${headCols}</tr></thead><tbody>
    ${group("(A) ITC available, whether in full or part")}${row4(t4.A.importGoods,entered)}${row4(t4.A.importServices)}${row4(t4.A.inwardRcm)}${row4(t4.A.isd,entered)}${row4(t4.A.allOther)}
    ${group("(B) ITC reversed")}${row4(t4.B.rules)}${row4(t4.B.others)}
    <tr class="total"><th scope="row">(C) Net ITC available, (A) less (B)</th>${headCells(t4.C)}</tr>
    ${group("(D) Other details")}${row4(t4.D.reclaimed)}${row4(t4.D.restricted)}</tbody></table></div>`;

  /* 5: GST and non-GST, inter and intra. */
  const table5=`<h3>5 Exempt, nil-rated and non-GST inward supplies</h3><div class="table-scroll"><table><thead><tr><th>Nature of supplies</th><th class="figure">Inter-State supplies ₹</th><th class="figure">Intra-State supplies ₹</th></tr></thead><tbody>
    <tr><th scope="row">From a supplier under the composition scheme, exempt and nil-rated supplies</th>${cell(t5.gst.interPaise)}${cell(t5.gst.intraPaise)}</tr>
    <tr><th scope="row">Non-GST supplies</th>${cell(t5.nonGst.interPaise)}${cell(t5.nonGst.intraPaise)}</tr></tbody>
    <tfoot><tr class="total"><th scope="row">Total</th>${cell(t5.totals.interPaise)}${cell(t5.totals.intraPaise)}</tr></tfoot></table></div>`;

  /* 6.1: liability per head, credit used by source head, cash, interest and late fee. */
  const used=t6.creditUtilised, interest=w.interest.totalPaise, fee=w.lateFee;
  const creditApplies={igst:{igst:true,cgst:true,sgst:true,cess:false},cgst:{igst:true,cgst:true,sgst:false,cess:false},sgst:{igst:true,cgst:false,sgst:true,cess:false},cess:{igst:false,cgst:false,sgst:false,cess:true}};
  const feeFor=h=>h==="cgst"?fee.cgstPaise:h==="sgst"?fee.sgstPaise:0;
  const forwardRow=h=>`<tr><th scope="row">${HEAD_TITLE[h]}</th>${cell(t6.liability.forwardDue[h+"Paise"])}${HEADS.map(from=>cell(used[from][h+"Paise"],creditApplies[h][from])).join("")}${cell(t6.cashTax.forwardCharge[h+"Paise"])}${cell(interest[h+"Paise"])}${cell(feeFor(h),h==="cgst"||h==="sgst")}</tr>`;
  const reverseRow=h=>`<tr><th scope="row">${HEAD_TITLE[h]}</th>${cell(t6.liability.reverseCharge[h+"Paise"])}${na.repeat(4)}${cell(t6.cashTax.reverseCharge[h+"Paise"])}${na}${na}</tr>`;
  const usedFrom=from=>sum(used[from]);
  const table61=`<h3>6.1 Payment of tax</h3><div class="table-scroll"><table><thead>
      <tr><th rowspan="2">Description</th><th rowspan="2" class="figure">Tax payable ₹</th><th colspan="4" class="gstr3b-span">Paid through ITC</th><th rowspan="2" class="figure">Tax paid in cash ₹</th><th rowspan="2" class="figure">Interest ₹</th><th rowspan="2" class="figure">Late fee ₹</th></tr>
      <tr><th class="figure">From IGST credit ₹</th><th class="figure">From CGST credit ₹</th><th class="figure">From SGST/UTGST credit ₹</th><th class="figure">From cess credit ₹</th></tr></thead>
    <tbody>${group9("(A) Other than reverse charge",esc)}${HEADS.map(forwardRow).join("")}${group9("(B) Reverse charge",esc)}${HEADS.map(reverseRow).join("")}</tbody>
    <tfoot><tr class="total"><th scope="row">Total</th>${cell(sum(t6.liability.total))}${HEADS.map(from=>cell(usedFrom(from))).join("")}${cell(sum(t6.cashTax.total))}${cell(w.interest.total)}${cell(fee.totalPaise)}</tr></tfoot></table></div>`;

  /* Rule 88A order, written out as the steps actually taken. */
  const steps=t6.utilisation.length
    ? `<ol class="gstr3b-steps">${t6.utilisation.map(step=>`<li>${esc(cap(HEAD_WORDS[step.from]))} credit of ${esc(rupee(step.paise))} set against ${esc(HEAD_WORDS[step.to])}.</li>`).join("")}</ol>`
    : `<p class="quiet">No credit was set off: ${sum(t6.creditAvailable)?"there is no forward-charge tax to pay.":"there is no credit in the ledger or in Table 4(C)."}</p>`;
  const order=`<h4>How the credit was used</h4><p class="subsection-intro">Sections 49 and 49A and rule 88A set the order: integrated tax credit first, against integrated tax and then central and State/UT tax; then central tax credit against central tax and integrated tax, and State/UT tax credit against State/UT tax and integrated tax; cess credit against cess only. Central and State/UT tax credit never pay each other. Reverse-charge tax is paid in cash.</p>${steps}`;

  /* Ledger position per head after the return. */
  const ledgerRow=h=>`<tr><th scope="row">${HEAD_TITLE[h]}</th>${cell(t6.creditAvailable[h+"Paise"])}${cell(t6.creditAvailable[h+"Paise"]-t6.creditBalanceCarried[h+"Paise"])}${cell(t6.creditBalanceCarried[h+"Paise"])}${cell(t6.cashTax.total[h+"Paise"])}${cell(t6.openingCashLedger[h+"Paise"])}${cell(t6.cashToDeposit[h+"Paise"])}</tr>`;
  const ledgerTable=`<h4>Credit and cash by head</h4><div class="table-scroll"><table><thead><tr><th>Head</th><th class="figure">Credit available ₹</th><th class="figure">Credit used ₹</th><th class="figure">Credit carried forward ₹</th><th class="figure">Tax payable in cash ₹</th><th class="figure">Already in cash ledger ₹</th><th class="figure">Cash to deposit ₹</th></tr></thead>
    <tbody>${HEADS.map(ledgerRow).join("")}</tbody>
    <tfoot><tr class="total"><th scope="row">Total</th>${cell(sum(t6.creditAvailable))}${cell(sum(t6.creditAvailable)-sum(t6.creditBalanceCarried))}${cell(sum(t6.creditBalanceCarried))}${cell(sum(t6.cashTax.total))}${cell(sum(t6.openingCashLedger))}${cell(sum(t6.cashToDeposit))}</tr></tfoot></table></div>`;

  /* Interest and late fee, each in one or two sentences. */
  const i1=w.interest.section50_1, i3=w.interest.section50_3;
  const rate=bps=>`${bps/100}% a year`;
  const days=n=>`${n} ${n===1?"day":"days"}`;
  const interest1=!i1.paymentDate?"Enter the payment or filing date to work it out."
    :!i1.days?`None. Tax is paid by the due date, ${dateLabel(i1.dueDate)}.`
    :`${rupee(sum(i1.interestPaise))} at ${rate(i1.rateBps)} for ${days(i1.days)}, from ${dateLabel(i1.dueDate)} to ${dateLabel(i1.paymentDate)}, on ${rupee(sum(i1.basePaise))} of tax paid in cash.${i1.cashLedgerRelief?" The cash ledger balance credited by the due date is left out of that base.":""}`;
  const interest3=!sum(i3.basePaise)?"None. No wrongly availed and utilised credit is entered."
    :!i3.toDate?"Enter the date the credit was reversed to work it out."
    :`${rupee(sum(i3.interestPaise))} at ${rate(i3.rateBps)} for ${days(i3.days)}, from ${dateLabel(i3.fromDate)} to ${dateLabel(i3.toDate)}, on ${rupee(sum(i3.basePaise))} of credit.`;
  const slab={"nil":"the nil-return cap","up-to-1.5cr":"turnover up to ₹1.5 crore","up-to-5cr":"turnover up to ₹5 crore","above-5cr":"turnover above ₹5 crore"}[fee.slab]||"";
  const basis={entered:"the turnover entered above","saved-band":"the turnover band saved in GST setup",none:"no recorded turnover, so the highest cap applies"}[fee.turnoverBasis]||"";
  const lateText=!w.filingDate?"Enter the filing date to work it out."
    :fee.applicable===null?"Not worked out for tax periods before June 2021, which follow earlier waiver notifications."
    :!fee.days?"None. The return is filed by the due date."
    :`${rupee(fee.totalPaise)} for ${days(fee.days)} late: ${rupee(fee.perDayPaise.cgstPaise)} a day each for CGST and SGST, capped at ${rupee(fee.capPaise.cgstPaise)} each for ${slab}.${fee.slab==="nil"?"":` The cap follows ${basis}.`}`;
  const charges=`<h4>Interest and late fee</h4><dl class="kv"><dt>Interest under section 50(1)</dt><dd>${esc(interest1)}</dd><dt>Interest under section 50(3)</dt><dd>${esc(interest3)}</dd><dt>Late fee under section 47</dt><dd>${esc(lateText)}</dd></dl>`;

  /* Sources: the Table 5 documents and the rules the working follows. */
  const docRows=t5.documents.map(d=>`<tr><td class="date-cell">${esc(dateLabel(d.date))}</td><td><a class="code" href="${href}/gst-document/${encodeURIComponent(d.id)}">${esc(d.number)}</a></td><td>${esc(d.party||"")}${d.composition?' <span class="pill info">Composition dealer</span>':""}</td><td>${d.inter?"Inter-State":"Intra-State"}</td>${cell(d.valuePaise)}</tr>`).join("");
  const sources=`<div class="details-list">
    ${t5.documents.length?`<details><summary>Purchases in Table 5 <small>${count(t5.documents.length,"document")}</small></summary><div class="table-scroll"><table><thead><tr><th>Date</th><th>Document</th><th>Supplier</th><th>Supply</th><th class="figure">Value ₹</th></tr></thead><tbody>${docRows}</tbody></table></div></details>`:""}
    <details><summary>Rules and portal references <small>${count(w.sources.length,"source")}</small></summary><ul class="gstr3b-sources">${w.sources.map(src=>`<li><a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">${esc(src.title)}</a></li>`).join("")}</ul></details>
  </div>`;

  return `${nilLine}${strip}${details}${attention}
    <div class="gstr3b-tables">${table31}${table32}${table4}${table5}${table61}${order}${ledgerTable}${charges}</div>
    ${sources}`;
}
const group9=(label,esc)=>`<tr class="gstr3b-group"><th scope="rowgroup" colspan="9">${esc(label)}</th></tr>`;
