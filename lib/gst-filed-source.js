import { normalizeReportedSnapshot } from "./gst-outward-amendments.js";
import { isDeepStrictEqual } from "node:util";
import { indexOriginalSection } from "../public/gst-filed-source.js";

export function filedRecords(company) {
  return (company.gst?.outwardAmendments?.records || []).filter(row => row.originalFiling?.source);
}

function compareOriginal(parsed, record) {
  const original = record.originalReported;
  // The offline invoice has rate totals. Any documented HSN allocation is supplied separately.
  for (const [field,value] of Object.entries(normalizeReportedSnapshot(parsed))) {
    if (!isDeepStrictEqual(value,original[field])) throw new Error("The original GSTR-1 JSON record differs from the saved " + field);
  }
}

export function verifyFiledRecords(bytes, company, records) {
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)); }
  catch { throw new Error("The original GSTR-1 file must contain UTF-8 JSON"); }
  const sections = new Map();
  for (const record of records) {
    const source = record.originalFiling.source;
    const gstin = company.gst.registrations.find(reg => reg.id === record.registrationId)?.gstin;
    const cacheKey = gstin + "/" + source.section;
    if (!sections.has(cacheKey)) {
      sections.set(cacheKey,indexOriginalSection(parsed,gstin,source.section));
    }
    const view = sections.get(cacheKey), row = view.lookup(source.documentKey);
    if (view.period !== record.originalPeriod || !row?.original) throw new Error("The linked original GSTR-1 document or period differs from the return file");
    compareOriginal(row.original, record);
  }
}
