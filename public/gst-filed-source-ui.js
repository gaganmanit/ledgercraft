import { maxFiledReturnBytes } from "./gst-filed-source.js";

export async function encodeFiledReturnFile(file) {
  if (!file || file.size <= 0 || file.size > maxFiledReturnBytes) throw new Error("Choose a GSTR-1 JSON file up to 32 MB");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parts = [];
  for (let i = 0; i < bytes.length; i += 16384) parts.push(String.fromCharCode(...bytes.subarray(i,i+16384)));
  return btoa(parts.join(""));
}

export function mountFiledReturnPicker(element, {gstin, section, onSelect}) {
  element.innerHTML = `<details><summary>Read an original GSTR-1 JSON file</summary>
    <label>Return file<input type="file" accept=".json,application/json"></label>
    <div hidden><label>Find the reported number or GSTIN<input type="search"></label>
      <label>Reported document<select></select></label>
      <button type="button" class="secondary">Use this document</button></div>
    <p role="status" aria-live="polite"></p></details>`;
  const picker = element.querySelector('input[type=file]'), search = element.querySelector('input[type=search]');
  const select = element.querySelector("select"), button = element.querySelector("button"), status = element.querySelector('[role=status]');
  const controls = select.closest("div");
  let worker;
  const stop = () => { worker?.terminate(); worker = null; };
  const observer = new MutationObserver(() => {
    if (!element.isConnected) { stop(); observer.disconnect(); }
  });
  observer.observe(document.querySelector("#root") || document.body,{childList:true,subtree:true});
  picker.onchange = () => {
    stop();
    const file = picker.files[0];
    controls.hidden = true; status.textContent = ""; search.value = "";
    if (!file) return;
    if (file.size === 0 || file.size > maxFiledReturnBytes) { status.textContent="Choose a GSTR-1 JSON file up to 32 MB";return; }
    status.textContent="Reading the return…";
    const active = new Worker("/gst-filed-source-worker.js",{type:"module"});
    worker=active;
    active.onerror=()=>{ if (worker === active) { status.textContent="The local return reader could not open this file."; stop(); } };
    active.onmessage=({data})=>{
      if (worker !== active || !element.isConnected) return;
      if (data.type === "list") {
        if (data.query !== search.value) return;
        controls.hidden=false; button.disabled=true;
        select.replaceChildren(new Option("Choose a reported document",""));
        for (const row of data.matches) select.add(new Option(row.label,row.key));
        status.textContent=data.period+" · "+data.total+" matching documents"+(data.total>100 ? ". Refine the search to see more." : ".");
      } else if (data.type === "selected") {
        if (select.value !== data.key) return;
        onSelect({period:data.period,original:data.original,filename:file.name,digest:data.digest,section,documentKey:data.key,bytes:file.size,file});
      } else { status.textContent=data.message; }
    };
    active.postMessage({type:"open",file,gstin,section});
  };
  search.oninput=()=>{
    button.disabled=true; select.replaceChildren(); worker?.postMessage({type:"search",query:search.value});
  };
  select.onchange=()=>{button.disabled=!select.value;};
  button.onclick=()=>{if (select.value) worker?.postMessage({type:"select",key:select.value});};
}
