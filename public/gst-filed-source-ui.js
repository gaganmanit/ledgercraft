import { maxFiledReturnBytes } from "./gst-filed-source.js";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const monthLabel = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value || "") ? `${MONTHS[Number(value.slice(5, 7)) - 1]} ${value.slice(0, 4)}` : String(value || "");

export async function encodeFiledReturnFile(file) {
  if (!file || file.size <= 0 || file.size > maxFiledReturnBytes) throw new Error("Choose a GSTR-1 JSON file up to 32 MB");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parts = [];
  for (let i = 0; i < bytes.length; i += 16384) parts.push(String.fromCharCode(...bytes.subarray(i,i+16384)));
  return btoa(parts.join(""));
}

export function mountFiledReturnPicker(element, {gstin, section, onSelect}) {
  element.innerHTML = `<details><summary>Read an original GSTR-1 JSON file</summary>
    <div class="form-grid"><label class="wide">GSTR-1 JSON file from the GST portal <input type="file" accept=".json,application/json"></label></div>
    <div class="form-grid" data-filed-controls hidden><label>Find the reported number or GSTIN <input type="search"></label>
      <label>Reported document <select></select></label>
      <div class="actions wide"><button type="button" class="ghost">Use this document</button></div></div>
    <p class="form-note" role="status" aria-live="polite"></p><p class="form-message alert" role="alert"></p></details>`;
  const picker = element.querySelector('input[type=file]'), search = element.querySelector('input[type=search]');
  const select = element.querySelector("select"), button = element.querySelector("button"), status = element.querySelector('[role=status]');
  const alert = element.querySelector('[role=alert]');
  const controls = element.querySelector("[data-filed-controls]");
  const report = text => { status.textContent = ""; alert.textContent = text; alert.scrollIntoView({block:"nearest"}); };
  let worker;
  const stop = () => { worker?.terminate(); worker = null; };
  const observer = new MutationObserver(() => {
    if (!element.isConnected) { stop(); observer.disconnect(); }
  });
  observer.observe(document.querySelector("#root") || document.body,{childList:true,subtree:true});
  picker.onchange = () => {
    stop();
    const file = picker.files[0];
    controls.hidden = true; status.textContent = ""; alert.textContent = ""; search.value = "";
    if (!file) return;
    if (file.size === 0 || file.size > maxFiledReturnBytes) { report("Choose a GSTR-1 JSON file up to 32 MB."); return; }
    status.textContent="Reading the return on this Mac…";
    const active = new Worker("/gst-filed-source-worker.js",{type:"module"});
    worker=active;
    active.onerror=()=>{ if (worker === active) { report("This file could not be read as a GSTR-1 return. Choose the JSON file downloaded from the GST portal."); stop(); } };
    active.onmessage=({data})=>{
      if (worker !== active || !element.isConnected) return;
      if (data.type === "list") {
        if (data.query !== search.value) return;
        controls.hidden=false; button.disabled=true; alert.textContent="";
        select.replaceChildren(new Option("Choose a reported document",""));
        for (const row of data.matches) select.add(new Option(row.label,row.key));
        status.textContent=`Return period ${monthLabel(data.period)}. ${data.total} matching ${data.total === 1 ? "document" : "documents"}${data.total>100 ? ". Refine the search to see more." : "."}`;
      } else if (data.type === "selected") {
        if (select.value !== data.key) return;
        onSelect({period:data.period,original:data.original,filename:file.name,digest:data.digest,section,documentKey:data.key,bytes:file.size,file});
      } else { report(data.message); }
    };
    active.postMessage({type:"open",file,gstin,section});
  };
  search.oninput=()=>{
    button.disabled=true; select.replaceChildren(); worker?.postMessage({type:"search",query:search.value});
  };
  select.onchange=()=>{button.disabled=!select.value;};
  button.onclick=()=>{if (select.value) worker?.postMessage({type:"select",key:select.value});};
}
