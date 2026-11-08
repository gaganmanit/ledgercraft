import { showMatches } from "./gst-2b-ui.js";
const labels = {"b2b,sez,de":"Registered customers and SEZ","b2cl":"Large interstate consumer invoices","b2cs":"Other consumer supplies","cdnr":"Registered credit and debit notes","cdnur":"Unregistered credit and debit notes","exp":"Exports","b2ba":"Amended registered invoices · B2BA","b2cla":"Amended large consumer invoices · B2CLA","expa":"Amended exports · EXPA","cdnra":"Amended registered notes · CDNRA","cdnura":"Amended unregistered notes · CDNURA","exemp":"Nil-rated, exempt and non-GST","hsn(b2b)":"HSN · B2B","hsn(b2c)":"HSN · B2C","docs":"Documents issued"};
export async function viewReturns(route, token, {root,api,esc,page,still,formatINR,todayISO}) {
  const id=encodeURIComponent(route.id), base="/api/companies/"+id;
  const {company, registrations}=await api(base+"/gst/registrations");
  if (!still(token)) return;
  document.title="GST returns · "+company.name;
  const href="#/c/"+id, money=n=>esc(formatINR(n));
  if (!registrations.length) {
    root.innerHTML=page({company,kicker:"Returns",title:"GST returns",body:`<p>Set up the company's GST registration to prepare its returns.</p><a class="ink-link" href="${href}/gst">Set up GST ↗</a>`});
    return;
  }
  const params=new URLSearchParams(location.hash.split("?")[1]);
  const registration=params.get("registration")||registrations[0].id, month=params.get("month")||todayISO().slice(0,7);
  const query=new URLSearchParams({ registration,month });
  const report=await api(base+"/gst-returns?"+query);
  if (!still(token)) return;
  const {summary,sheets,columns,issues,evidence}=report;
  const form=`<form class="period" id="return-period"><label>Registration<select name="registration">${registrations.map(r=>`<option value="${esc(r.id)}"${r.id===registration?" selected":""}>${esc(r.gstin)} · ${esc(r.name)}</option>`).join("")}</select></label><label>Tax period<input name="month" type="month" required value="${esc(month)}"></label><button>Show returns</button></form>`;
  const threeB=[["3.1(a)","Taxable outward supplies",summary.outwardTaxable],["3.1(b)","Zero-rated outward supplies",summary.zeroRated],["3.1(c)","Nil-rated and exempt outward supplies",summary.nilExempt],["3.1(d)","Inward reverse charge due this period",summary.inwardRcm],["3.1(e)","Non-GST outward supplies",summary.nonGst],["Books","Outward reverse charge · recipient liable",summary.outwardRcm],["4(A)(2)","Net RCM credit · imported services",summary.rcmImportCredit],["4(A)(3)","Net RCM credit · domestic supplies",summary.rcmDomesticCredit],["4(B)(1)","Permanent RCM credit reversals",summary.rcmPermanentReversals],["4(B)(2)","Temporary RCM credit reversals",summary.rcmTemporaryReversals],["Review","Other RCM reversals to classify",summary.rcmReviewReversals],["Books","Inward purchases before ITC review",summary.purchases],["At entry","Purchase tax marked eligible",summary.eligibleInput],["At entry","Purchase tax pending review",summary.pendingInput],["At entry","Purchase tax marked ineligible",summary.ineligibleInput]];
  const forwardLabels={"4A(5)":"Other eligible credit including reclaims","4B(1)":"Permanent reversals","4B(2)":"Other reversals","4D(1)":"Reclaimed tax disclosure","4D(2)":"Section 16(4) / place-of-supply disclosure"};
  const creditRows=Object.entries(forwardLabels).map(([k,label])=>[k,label,report.itc.table4[k]]);
  const creditCells=([key,label,t])=>cells([key,label,formatINR(t.igstPaise),formatINR(t.cgstPaise),formatINR(t.sgstPaise+t.utgstPaise),formatINR(t.cessPaise)]);
  const grid=(head,rows)=>`<div class="gst-scroll"><table><thead><tr>${head.map(c=>`<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  const cells=row=>`<tr>${row.map(c=>`<td>${esc(c)}</td>`).join("")}</tr>`;
  const worksheet=name=>`<details class="range-details"><summary>${esc(labels[name] || name)} · ${sheets[name].length} row(s)</summary><p><a class="ink-link" download href="${base}/gst-returns/csv/${encodeURIComponent(name)}?${esc(query.toString())}">Download worksheet CSV</a></p>${grid(columns[name],sheets[name].slice(0,100).map(cells))}${sheets[name].length>100?"<p>Showing 100 rows. The download includes the full worksheet.</p>":""}</details>`;
  const sourceLink=v=>`<a href="${href}/gst-document/${encodeURIComponent(v.id)}">${esc(v.number)}</a>`;
  const exceptional=issues.length?`<details class="range-details" open><summary>Classification review · ${issues.length}</summary><ul>${issues.map(v=>`<li>${v.voucherId?`<a href="${href}/v/${encodeURIComponent(v.type)}/${encodeURIComponent(v.voucherId)}">${esc(v.number)}</a>`:sourceLink(v)} · ${esc(v.reason)}</li>`).join("")}</ul></details>`:"";
  const hsnReview = report.hsnCheck.checks.length ? `<details class="range-details" open><summary>HSN / SAC review · ${report.hsnCheck.checks.length}</summary>
    <ul>${report.hsnCheck.checks.map(check => `<li>${sourceLink(check)} · ${esc(check.code)} · ${esc(check.message)}</li>`).join("")}</ul><a href="${href}/gst">Open GST setup</a></details>` : "";
  const amendments = report.amendments;
  const correctionLink = row => `${href}/gst-amendments/${encodeURIComponent(row.invoiceId)}?${new URLSearchParams({registration,month:row.amendmentPeriod})}`;
  const snapshotTotal = (snapshot,field) => (snapshot.rates || []).reduce((sum,row)=>sum+(row[field]||0),0);
  const amendmentRows = amendments?.rows?.length ? `<section data-return-amendments><h2>Prepared return differentials</h2><p>These signed differences form the current period's correction working paper.</p>${grid(["Posted document","Original period","Return table","Status","Taxable change ₹","IGST change ₹","CGST change ₹","SGST / UTGST change ₹","Cess change ₹"],amendments.rows.map(row=>`<tr><td><a href="${correctionLink(row)}">${esc(row.number)}</a></td><td>${esc(row.originalPeriod)}</td><td>${esc(row.section.toUpperCase())}</td><td>${esc((row.effectiveStatus || row.status) === "filed" ? "External filing recorded" : "Prepared")}</td><td class="figure">${money(row.delta.taxablePaise)}</td><td class="figure">${money(row.delta.igstPaise)}</td><td class="figure">${money(row.delta.cgstPaise)}</td><td class="figure">${money(row.delta.sgstPaise+row.delta.utgstPaise)}</td><td class="figure">${money(row.delta.cessPaise)}</td></tr>`))}</section>` : "";
  const reportedComparators = amendments?.comparators?.length ? `<details class="range-details" data-return-filed-comparators><summary>Known prior-filed figures and chronological books · ${amendments.comparators.length}</summary><p>Historical return working uses the captured prior-filed figures for these documents. Book dates and values remain visible separately.</p>${grid(["Document","Book date","Filed taxable ₹","Book taxable ₹","Filed tax ₹","Book tax ₹","Correction period"],amendments.comparators.map(row=>`<tr><td><a href="${correctionLink(row)}">${esc(row.number)}</a></td><td>${esc(row.revised.date.split("-").reverse().join("-"))}</td><td class="figure">${money(snapshotTotal(row.originalReported,"taxablePaise"))}</td><td class="figure">${money(snapshotTotal(row.revised,"taxablePaise"))}</td><td class="figure">${money(["igstPaise","cgstPaise","sgstPaise","utgstPaise","cessPaise"].reduce((sum,key)=>sum+snapshotTotal(row.originalReported,key),0))}</td><td class="figure">${money(["igstPaise","cgstPaise","sgstPaise","utgstPaise","cessPaise"].reduce((sum,key)=>sum+snapshotTotal(row.revised,key),0))}</td><td>${esc(row.amendmentPeriod)}</td></tr>`))}</details>` : "";
  const savedMarkup = statements => statements.length ? `<details class="range-details"><summary>Saved GSTR-2B statements · ${statements.length}</summary>${statements.slice().reverse().map(s=>`<section><p>${esc(new Date(s.savedAt).toLocaleString("en-GB"))} · ${s.files.map((f,i)=>`<a download href="${base}/gst-returns/statements/${s.id}/files/${i}">${esc(f.name)}</a>`).join(", ")}</p><button class="secondary" type="button" data-match-saved="${s.id}">Match against current books</button></section>`).join("")}</details>` : "";
  root.innerHTML=page({company,title:"GST returns",kicker:"Returns",body:`${form}<p><a class="ink-link" data-return-corrections href="${href}/gst-amendments?${esc(query.toString())}">Review outward return corrections</a></p>${exceptional}${hsnReview}${reportedComparators}${amendmentRows}
    <section><h2>GSTR-1 worksheets</h2><p>Outward documents recorded for ${esc(report.registration.gstin)}. </p><p><a class="button" download href="${base}/gst-returns/workbook?${esc(query.toString())}">Download GSTR-1 workbook</a></p>
    ${report.hsnCheck.reconciliation.some(x=>x.supplyPaise || x.hsnPaise) ? `<details class="range-details"${report.hsnCheck.reconciliation.some(x=>x.differencePaise)?" open":""}><summary>Table 12 reconciliation</summary>${grid(["Supplies","Supply tables ₹","HSN summary ₹","Difference ₹"],report.hsnCheck.reconciliation.map(r=>cells([r.type.toUpperCase(),formatINR(r.supplyPaise),formatINR(r.hsnPaise),formatINR(r.differencePaise)])))}</details>` : ""}
    ${Object.keys(sheets).filter(n=>sheets[n].length).map(worksheet).join("")||"<p>No outward documents for this period.</p>"}</section>
    <section><h2>GSTR-3B working figures</h2>${grid(["Table","Supply","Taxable ₹","IGST ₹","CGST ₹","SGST / UTGST ₹","Cess ₹"],threeB.map(([n,l,t])=>cells([n,l,formatINR(t.taxablePaise),formatINR(t.igstPaise),formatINR(t.cgstPaise),formatINR(t.sgstPaise+t.utgstPaise),formatINR(t.cessPaise)])))}</section>
    <section><h2>Purchase credit decisions</h2><p><a href="${href}/gst-itc">Open purchase ITC review</a></p>
    ${grid(["Table","Forward-charge purchases","IGST ₹","CGST ₹","SGST / UTGST ₹","Cess ₹"],creditRows.map(creditCells))}
    ${report.itc.issues.map(i=>`<p><a href="${href}/gst-itc/${encodeURIComponent(i.invoiceId)}">Review entry</a> · ${esc(i.message)}</p>`).join("")}
    ${report.itc.rows.length ? `<details class="range-details"><summary>Credit decisions for the period · ${report.itc.rows.length}</summary>${grid(["Review date","Purchase","Table","Reason","IGST ₹","CGST ₹","SGST / UTGST ₹","Cess ₹"],report.itc.rows.map(r=>`<tr><td>${esc(r.date.split("-").reverse().join("-"))}</td><td><a href="${href}/gst-itc/${encodeURIComponent(r.invoiceId)}">${esc(r.number)}</a></td><td>${esc(r.table)}</td><td>${esc(r.reason)}</td><td>${money(r.igstPaise*r.sign)}</td><td>${money(r.cgstPaise*r.sign)}</td><td>${money((r.sgstPaise+r.utgstPaise)*r.sign)}</td><td>${money(r.cessPaise*r.sign)}</td></tr>`))}</details>` : ""}
    ${grid(["","Reviewed credit","IGST ₹","CGST ₹","SGST / UTGST ₹","Cess ₹"],[creditCells(["4(C)","Net from recorded forward and reverse-charge decisions",report.itc.reviewedNet])])}</section>
    ${report.rcmRows.length ? `<details class="range-details"><summary>Reverse-charge entries for this period · ${report.rcmRows.length}</summary>${grid(["Date","Document","Entry","IGST ₹","CGST ₹","SGST / UTGST ₹","Cess ₹"],report.rcmRows.map(v=>`<tr><td>${esc(v.date.split("-").reverse().join("-"))}</td><td>${sourceLink({id:v.invoiceId,number:v.number})}</td><td>${esc(v.reason)}</td><td>${money(v.igstPaise*(v.sign||1))}</td><td>${money(v.cgstPaise*(v.sign||1))}</td><td>${money((v.sgstPaise+v.utgstPaise)*(v.sign||1))}</td><td>${money(v.cessPaise*(v.sign||1))}</td></tr>`))}</details>` : ""}
    <section><h2>Reconcile GSTR-2B</h2><form id="two-b"><label>GST Portal statement or document pages<input type="file" accept=".json,application/json" multiple required></label><label><input type="checkbox" name="keep" checked> Save original files with this company</label><button>Match purchase documents</button></form><div data-saved-statements>${savedMarkup(report.statements || [])}</div><div data-matches role="status"></div></section>
    <details class="range-details"><summary>Source documents · ${evidence.length}</summary>${grid(["Date","Document","Party","Value ₹"],evidence.map(v=>`<tr><td>${esc(v.date.split("-").reverse().join("-"))}</td><td>${sourceLink(v)}</td><td>${esc(v.party)}</td><td class="figure">${money(v.totalPaise)}</td></tr>`))}</details>`});
  root.querySelector("#return-period").onsubmit=e=>{e.preventDefault();location.hash=href+"/gst-returns?"+new URLSearchParams(new FormData(e.currentTarget));};
  const savedBox=root.querySelector("[data-saved-statements]");
  savedBox.onclick=async e=>{
    const button=e.target.closest("[data-match-saved]");
    if(!button)return;
    button.disabled=true;
    const target=root.querySelector("[data-matches]");
    try {
      const result=await api(base+"/gst-returns/statements/"+button.dataset.matchSaved);
      if(still(token))showMatches(target,result,{esc,href,formatINR});
    } catch(error){target.textContent=error.message;} finally{button.disabled=false;}
  };
  root.querySelector("#two-b").onsubmit=async e=>{
    e.preventDefault();const form=e.currentTarget, button=form.querySelector("button"),target=root.querySelector("[data-matches]");button.disabled=true;
    try{
      const files=[...form.querySelector('input[type="file"]').files];
      if(files.reduce((n,f)=>n+f.size,0)>32*1024*1024)throw new Error("Choose up to 32 MB of statement files");
      let result;
      if(form.elements.keep.checked) {
        const sources=await Promise.all(files.map(file=>new Promise((resolve,reject)=>{
          const reader=new FileReader();reader.onerror=()=>reject(new Error("Could not read the selected file"));
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
    }catch(err){target.textContent=err instanceof SyntaxError?"Choose a valid GSTR-2B JSON file.":err.message;}finally{button.disabled=false;}
  };
}
