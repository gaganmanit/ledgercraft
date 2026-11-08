import { todayISO } from "/money.js";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value || "") ? `${MONTH_NAMES[Number(value.slice(5, 7)) - 1]} ${value.slice(0, 4)}` : value || "";

export function mountAmendmentDispositions(root, {records,revision,endpoint,api,refresh,still}) {
  const byId = new Map(records.map(record => [record.id,record]));
  for (const mount of root.querySelectorAll("[data-amendment-disposition]")) {
    const record = byId.get(mount.dataset.amendmentDisposition);
    if (!record || record.effectiveStatus !== "prepared") continue;
    const period = monthLabel(record.amendmentPeriod);
    mount.innerHTML = `<details class="amendment-disposition"><summary>Update filing status</summary>
      <form class="form-grid"><label>Action<select name="action">
        <option value="record-filing">Record external filing</option>
        <option value="withdraw">Withdraw unfiled preparation</option>
      </select></label><label>Record date<input name="date" type="date" required></label>
      <label data-filed-date>Actual filing date<input name="filedDate" type="date" required></label>
      <label><span data-reference-label>Filing reference or ARN</span><input name="reference" required maxlength="240" spellcheck="false"></label>
      <label class="wide">Reason or supporting evidence<input name="basis" required maxlength="500"></label>
      <label class="check wide"><input name="confirmed" type="checkbox" required><span data-confirmation></span></label>
      <div class="actions wide"><button type="submit">Record external filing</button><span class="form-note amendment-transient" role="status" aria-live="polite"></span></div></form>
      <p class="form-message alert" role="alert" data-disposition-error></p></details>`;
    const form=mount.querySelector("form"), inputs=form.elements;
    const submit=form.querySelector('button[type=submit]'), status=form.querySelector('[role=status]'), failure=mount.querySelector('[data-disposition-error]');
    let requestId=crypto.randomUUID();
    inputs.date.value=todayISO();
    function actionChanged() {
      const withdrawing=inputs.action.value === "withdraw";
      form.querySelector("[data-filed-date]").hidden=withdrawing;
      inputs.filedDate.required=!withdrawing;
      inputs.filedDate.disabled=withdrawing;
      form.querySelector("[data-reference-label]").textContent=withdrawing ? "Review reference" : "Filing reference or ARN";
      form.querySelector("[data-confirmation]").textContent=withdrawing ? "I checked that this correction has not been filed." : "I checked that this correction is included in the filed GSTR-1 for " + period + ".";
      inputs.confirmed.checked=false; submit.textContent=withdrawing ? "Withdraw preparation" : "Record external filing";
      submit.className=withdrawing ? "danger" : "";
    }
    actionChanged(); inputs.action.onchange=actionChanged;
    form.oninput=()=>{requestId=crypto.randomUUID();status.textContent="";failure.textContent="";};
    form.onsubmit=async event=>{
      event.preventDefault();
      if (submit.disabled || !form.reportValidity()) return;
      const action=inputs.action.value, body={amendmentId:record.id,revision,requestId,date:inputs.date.value,reference:inputs.reference.value,basis:inputs.basis.value};
      if (action === "withdraw" && !confirm(`Withdraw the prepared correction to ${record.revised?.number || "this document"} for the ${period} return? It stays in the history marked as withdrawn.`)) return;
      if (action === "withdraw") body.confirmedUnfiled=inputs.confirmed.checked;
      else body.filing={form:"GSTR-1",period:record.amendmentPeriod,reference:body.reference,filedDate:inputs.filedDate.value,confirmedFiled:inputs.confirmed.checked};
      submit.disabled=true; failure.textContent=""; status.textContent="Saving…";
      try {
        await api(endpoint+"/events/"+action,{method:"POST",body});
        if (still()) await refresh();
      } catch (error) {
        if (still()) {status.textContent="";failure.textContent=error.message;submit.disabled=false;failure.scrollIntoView({block:"nearest"});}
      }
    };
  }
}
