import { indexOriginalSection, maxFiledReturnBytes } from "./gst-filed-source.js";

let index, digest;
self.onmessage = async ({data}) => {
  try {
    if (data.type === "open") {
      if (!data.file?.size || data.file.size > maxFiledReturnBytes) throw new Error("Choose a GSTR-1 JSON file up to 32 MB");
      const bytes = await data.file.arrayBuffer();
      index = indexOriginalSection(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)),data.gstin,data.section);
      const hash = await crypto.subtle.digest("SHA-256",bytes);
      digest = Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,"0")).join("");
    }
    if (data.type === "open" || data.type === "search") {
      const needle = (data.query || "").trim().toLowerCase();
      const matches = []; let total = 0;
      for (const row of index.records) {
        if (needle && !row.label.toLowerCase().includes(needle)) continue;
        if (total < 100) matches.push({key:row.key,label:row.label});
        total++;
      }
      self.postMessage({type:"list",query:data.query || "",period:index.period,matches,total});
    } else if (data.type === "select") {
      const row=index.lookup(data.key);
      if (!row?.original) throw new Error(row?.problem || "Choose a reported document");
      self.postMessage({type:"selected", key:row.key, original:row.original,period:index.period,digest});
    }
  } catch (error) { self.postMessage({type:"error",message:error.message}); }
};
