const recipientLabels = {
  "reversed": "Recipient reversed the attributable credit",
  "not-availed": "Recipient did not take the attributable credit",
  "incidence-not-passed": "Tax incidence was not passed on",
  "unconfirmed": "Evidence pending or withdrawn"
};
const grounds = {
  "goods-returned": "Goods returned",
  "deficiency": "Goods or services were deficient",
  "excess-value-or-tax": "Invoiced value or tax exceeded the amount payable",
  "post-supply-discount": "Post-supply discount",
  "unconfirmed": "Grounds awaiting evidence"
};

export function creditReviewMarkup(rows, esc) {
  if (!rows.length) return "";
  return `<div class="subsection" data-section34><h2>Outward credit note review</h2><p>A credit note that reduces tax is included in the return workings only while Section 34(2) allows it. Record the evidence for each note here.</p>
    <div class="toolbar"><label class="grow">Credit note<select id="section34-note">${rows.map(row =>
      `<option value="${esc(row.id)}">${esc(row.number)} for ${esc(row.party)} (${row.eligible ? "included" : "held"})</option>`).join("")}</select></label></div>
    <div data-section34-detail></div></div>`;
}

export function bindCreditReview(root, rows, { esc, save, refresh, revision }) {
  const select = root.querySelector("#section34-note");
  if (!select) return;
  const detail = root.querySelector("[data-section34-detail]");
  function options(labels, selected) {
    return '<option value="">Choose…</option>' + Object.entries(labels).map(([value,label]) =>
      `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`).join("");
  }
  function open() {
    const row = rows.find(entry => entry.id === select.value), prior = row.review;
    detail.innerHTML = `<p data-section34-status><span class="pill ${row.eligible ? "ok" : "bad"}">${row.eligible ? "Included in return workings" : "Held from return workings"}</span> ${esc(row.reason)}</p>
      <dl class="kv"><dt>Original invoice</dt><dd><span class="code">${esc(row.originalNumber || "unresolved")}</span></dd>${row.deadline ? `<dt>Deadline</dt><dd>${esc(row.deadline.split("-").reverse().join("-"))}</dd>` : ""}</dl>
      <form data-section34-review class="form-grid">
      <label>Intended declaration date<input name="declarationDate" type="date" required min="${esc(row.date)}" value="${esc(prior?.declarationDate || "")}"></label>
      <label>Annual return for the original supply year<select name="annualReturnStatus" required>${options({"not-filed":"Not yet filed","filed":"Filed"},prior?.annualReturnStatus)}</select></label>
      <label data-annual-date>Annual return filing date<input name="annualReturnDate" type="date" value="${esc(prior?.annualReturnDate || "")}"></label>
      <label>Reason for the credit note<select name="adjustmentGround" required>${options(grounds,prior?.adjustmentGround)}</select></label>
      <label class="check wide"><input type="checkbox" name="groundConfirmed"${prior?.groundConfirmed ? " checked" : ""}><span>The supporting document confirms this reason</span></label>
      <div class="check-group wide" data-discount>
        <label class="check"><input type="checkbox" name="discountAgreementConfirmed"${prior?.discountAgreementConfirmed ? " checked" : ""}><span>The discount was agreed at or before the supply</span></label>
        <label class="check"><input type="checkbox" name="discountInvoiceLinked"${prior?.discountInvoiceLinked ? " checked" : ""}><span>The discount is linked to the relevant invoice</span></label>
      </div>
      <label>Recipient evidence<select name="recipientBasis" required></select></label>
      <label class="wide">Supporting document or review reference<input name="reference" maxlength="500" required value="${esc(prior?.reference || "")}"></label>
      ${prior ? '<label class="wide">Reason for changing the review<input name="correctionReason" required maxlength="500"></label>' : ""}
      <div class="actions wide"><button type="submit">${prior ? "Update credit review" : "Save credit review"}</button></div><p class="form-message alert wide" data-review-error role="alert"></p></form>`;
    const form = detail.querySelector("form");
    function updateBasis(selected) {
      const modern = form.elements.declarationDate.value >= "2025-10-01";
      const keys = row.registered && modern ? ["reversed","not-availed","unconfirmed"] : ["incidence-not-passed","unconfirmed"];
      form.elements.recipientBasis.innerHTML = options(Object.fromEntries(keys.map(key=>[key,recipientLabels[key]])),selected);
    }
    function annualDate() {
      const filed = form.elements.annualReturnStatus.value === "filed";
      form.querySelector("[data-annual-date]").hidden = !filed;
      form.elements.annualReturnDate.disabled = !filed;
      form.elements.annualReturnDate.required = filed;
    }
    function showDiscount() {
      form.querySelector("[data-discount]").hidden = form.elements.adjustmentGround.value !== "post-supply-discount";
    }
    showDiscount();
    form.elements.adjustmentGround.onchange = showDiscount;
    annualDate();
    updateBasis(prior?.recipientBasis);
    form.elements.annualReturnStatus.onchange = annualDate;
    form.elements.declarationDate.onchange = () => updateBasis(form.elements.recipientBasis.value);
    let lastBody, requestId;
    form.onsubmit = async event => {
      event.preventDefault();
      const body = { ...Object.fromEntries(new FormData(form)), invoiceId: row.id, revision };
      body.groundConfirmed = form.elements.groundConfirmed.checked;
      for (const field of ["discountAgreementConfirmed","discountInvoiceLinked"]) {
        if (body.adjustmentGround === "post-supply-discount") body[field] = form.elements[field].checked;
        else delete body[field];
      }
      if (prior) body.supersedes = prior.id;
      const key = JSON.stringify(body);
      if (key !== lastBody) { lastBody = key; requestId = crypto.randomUUID(); }
      const button = form.querySelector("button");
      button.disabled = select.disabled = true;
      try { await save({ ...body, requestId }); await refresh(row.id); }
      catch (error) { const message = form.querySelector("[data-review-error]"); message.textContent = error.message; message.scrollIntoView({ block: "nearest" }); }
      finally { button.disabled = select.disabled = false; }
    };
  }
  select.onchange = open;
  open();
}
