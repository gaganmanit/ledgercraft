import { bindCreditReview, creditReviewMarkup } from "./gst-credit-review-ui.js";
import { showMatches } from "./gst-2b-ui.js";

const labels = {"b2b,sez,de":"Registered customers and SEZ","b2cl":"Large interstate consumer invoices","b2cs":"Other consumer supplies","cdnr":"Registered credit and debit notes","cdnur":"Unregistered credit and debit notes","exp":"Exports","b2ba":"Amended registered invoices (B2BA)","b2cla":"Amended large consumer invoices (B2CLA)","expa":"Amended exports (EXPA)","cdnra":"Amended registered notes (CDNRA)","cdnura":"Amended unregistered notes (CDNURA)","exemp":"Nil-rated, exempt and non-GST","hsn(b2b)":"HSN summary for B2B supplies","hsn(b2c)":"HSN summary for B2C supplies","docs":"Documents issued"};
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
  const {summary,sheets,columns,issues,evidence}=report;
  const selectedFy=fyOf(month);
  const firstFy=Math.min(fyOf(company.booksFrom.slice(0,7)),selectedFy), lastFy=Math.max(fyOf(todayISO().slice(0,7)),fyOf(books.to.slice(0,7)),selectedFy);
  const fyChoices=[];
  for (let fy=lastFy; fy>=firstFy; fy--) fyChoices.push(`<option value="${fy}"${fy===selectedFy?" selected":""}>FY ${fyText(fy)}</option>`);
  const form=`<form class="toolbar" id="return-period"><label class="grow">Registration <select name="registration">${registrations.map(r=>`<option value="${esc(r.id)}"${r.id===registration?" selected":""}>${esc(r.name)} (${esc(r.gstin)})</option>`).join("")}</select></label><label>Financial year <select data-return-fy>${fyChoices.join("")}</select></label><label>Tax period <select data-return-month>${monthOptions(selectedFy,month)}</select></label><input type="hidden" name="month" value="${esc(month)}"><button type="submit">Show returns</button></form><p class="form-message alert" role="alert" data-return-period-message></p><p class="only-print">GSTIN ${esc(report.registration.gstin)}. Tax period ${esc(monthLabel(month))}.</p>`;
  const threeB=[["3.1(a)","Taxable outward supplies",summary.outwardTaxable],["3.1(b)","Zero-rated outward supplies",summary.zeroRated],["3.1(c)","Nil-rated and exempt outward supplies",summary.nilExempt],["3.1(d)","Inward reverse charge due this period",summary.inwardRcm],["3.1(e)","Non-GST outward supplies",summary.nonGst],["Books","Outward reverse charge where the recipient is liable",summary.outwardRcm],["4(A)(2)","Net RCM credit on imported services",summary.rcmImportCredit],["4(A)(3)","Net RCM credit on domestic supplies",summary.rcmDomesticCredit],["4(B)(1)","Permanent RCM credit reversals",summary.rcmPermanentReversals],["4(B)(2)","Temporary RCM credit reversals",summary.rcmTemporaryReversals],["Review","Other RCM reversals to classify",summary.rcmReviewReversals],["Books","Inward purchases before ITC review",summary.purchases],["At entry","Purchase tax marked eligible",summary.eligibleInput],["At entry","Purchase tax pending review",summary.pendingInput],["At entry","Purchase tax marked ineligible",summary.ineligibleInput]];
  const forwardLabels={"4A(5)":"Other eligible credit including reclaims","4B(1)":"Permanent reversals","4B(2)":"Other reversals","4D(1)":"Reclaimed tax disclosure","4D(2)":"Section 16(4) and place-of-supply disclosure"};
  const creditRows=Object.entries(forwardLabels).map(([k,label])=>[k,label,report.itc.table4[k]]);
  const creditCells=([key,label,t])=>[key,label,formatINR(t.igstPaise),formatINR(t.cgstPaise),formatINR(t.sgstPaise+t.utgstPaise),formatINR(t.cessPaise)];
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
    <div class="subsection"><h2>GSTR-1 worksheets</h2><p>Outward documents recorded for <span class="code">${esc(report.registration.gstin)}</span> in ${esc(monthLabel(month))}.</p><p class="actions"><a class="button" download href="${base}/gst-returns/workbook?${esc(query.toString())}">Download GSTR-1 workbook</a></p>
    <div class="details-list">${reconciliation.some(x=>x.supplyPaise || x.hsnPaise) ? `<details${reconciliation.some(x=>x.differencePaise)?" open":""}><summary>Table 12 reconciliation${reconciliation.some(x=>x.differencePaise)?' <span class="pill warn">Difference</span>':""}</summary>${grid(["Supply type","Supply tables ₹","HSN summary ₹","Difference ₹"],reconciliation.map(r=>[r.type.toUpperCase(),formatINR(r.supplyPaise),formatINR(r.hsnPaise),formatINR(r.differencePaise)]))}</details>` : ""}
    ${outward.map(worksheet).join("")}</div>${outward.length?"":`<p class="empty">No outward documents are recorded for this month. <a href="${href}/gst-invoice">Post a sales invoice</a> dated in this month to start the worksheets.</p>`}</div>
    <div class="subsection"><h2>GSTR-3B working figures</h2>${grid(["Table","Supply","Taxable ₹",...taxHead],threeB.map(([n,l,t])=>[n,l,formatINR(t.taxablePaise),formatINR(t.igstPaise),formatINR(t.cgstPaise),formatINR(t.sgstPaise+t.utgstPaise),formatINR(t.cessPaise)]))}</div>
    <div class="subsection"><h2>Purchase credit decisions</h2><p>Forward-charge credit recorded in <a href="${href}/gst-itc">Purchase ITC review</a>.</p>
    ${grid(["Table","Forward-charge purchases",...taxHead],creditRows.map(creditCells))}
    ${report.itc.issues.length ? `<ul class="attention-rule">${report.itc.issues.map(i=>`<li>${esc(i.message)} <a href="${href}/gst-itc/${encodeURIComponent(i.invoiceId)}">Review entry</a></li>`).join("")}</ul>` : ""}
    ${report.itc.rows.length ? `<div class="details-list"><details><summary>Credit decisions for the period <small>${count(report.itc.rows.length,"decision")}</small></summary>${grid(["Review date","Purchase","Table","Reason",...taxHead],report.itc.rows.map(r=>`<tr><td class="date-cell">${esc(dateLabel(r.date))}</td><td><a class="code" href="${href}/gst-itc/${encodeURIComponent(r.invoiceId)}">${esc(r.number)}</a></td><td>${esc(r.table)}</td><td>${esc(r.reason)}</td>${signedTax(r,r.sign)}</tr>`))}</details></div>` : ""}
    ${grid(["Table","Reviewed credit",...taxHead],[creditCells(["4(C)","Net from recorded forward and reverse-charge decisions",report.itc.reviewedNet])])}</div>
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
}
