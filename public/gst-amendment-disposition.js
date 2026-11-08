import { todayISO } from "/money.js";

export function mountAmendmentDispositions(root, {records,revision,endpoint,api,refresh,still}) {
  const byId = new Map(records.map(record => [record.id,record]));
  for (const mount of root.querySelectorAll("[data-amendment-disposition]")) {
    const record = byId.get(mount.dataset.amendmentDisposition);
    if (!record || record.effectiveStatus !== "prepared") continue;
    mount.innerHTML = `<details><summary>Update filing status</summary>
      <form class="gst-form"><label>Action<select name="action">
        <option value="record-filing">Record external filing</option>
        <option value="withdraw">Withdraw unfiled preparation</option>
      </select></label><label>Record date<input name="date" type="date" required></label>
      <label data-filed-date>Actual filing date<input name="filedDate" type="date" required></label>
      <label><span data-reference-label>Filing reference or ARN</span><input name="reference" required maxlength="240"></label>
      <label>Reason or supporting evidence<input name="basis" required maxlength="500"></label>
      <label><input name="confirmed" type="checkbox" required> <span data-confirmation></span></label>
      <div><button type="submit">Record external filing</button></div><p role="status" aria-live="polite"></p></form></details>`;
    const form=mount.querySelector("form"), inputs=form.elements;
    const submit=form.querySelector('button[type=submit]'), status=form.querySelector('[role=status]');
    let requestId=crypto.randomUUID();
    inputs.date.value=todayISO();
    function actionChanged() {
      const withdrawing=inputs.action.value === "withdraw";
      form.querySelector("[data-filed-date]").hidden=withdrawing;
      inputs.filedDate.required=!withdrawing;
      inputs.filedDate.disabled=withdrawing;
      form.querySelector("[data-reference-label]").textContent=withdrawing ? "Review reference" : "Filing reference or ARN";
      form.querySelector("[data-confirmation]").textContent=withdrawing ? "I checked that this correction has not been filed." : "I checked that this correction is included in the filed GSTR-1 for " + record.amendmentPeriod + ".";
      inputs.confirmed.checked=false; submit.textContent=withdrawing ? "Withdraw preparation" : "Record external filing";
    }
    actionChanged(); inputs.action.onchange=actionChanged;
    form.oninput=()=>{requestId=crypto.randomUUID();status.textContent="";};
    form.onsubmit=async event=>{
      event.preventDefault();
      if (submit.disabled || !form.reportValidity()) return;
      const action=inputs.action.value, body={amendmentId:record.id,revision,requestId,date:inputs.date.value,reference:inputs.reference.value,basis:inputs.basis.value};
      if (action === "withdraw") body.confirmedUnfiled=inputs.confirmed.checked;
      else body.filing={form:"GSTR-1",period:record.amendmentPeriod,reference:body.reference,filedDate:inputs.filedDate.value,confirmedFiled:inputs.confirmed.checked};
      submit.disabled=true; status.textContent="Saving…";
      try {
        await api(endpoint+"/events/"+action,{method:"POST",body});
        if (still()) await refresh();
      } catch (error) {
        if (still()) {status.textContent=error.message;submit.disabled=false;}
      }
    };
  }
}
