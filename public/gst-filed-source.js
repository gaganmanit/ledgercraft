// GSTN GSTR-1 offline JSON. Read as reported: never derive a missing tax amount from the rate.
const sections = new Set(["b2b", "b2cl", "exp", "cdnr", "cdnur"]);
const utStates = new Set(["04", "26", "31", "35", "38", "97"]);
const invoiceTypes = new Map([["R","Regular B2B"],["SEWP","SEZ supplies with payment"],["SEWOP","SEZ supplies without payment"]]);
const urTypes = new Set(["B2CL", "EXPWP", "EXPWOP"]);
export const maxFiledReturnBytes = 32 * 1024 * 1024;

function hundredths(value, field) {
  const text = String(value ?? "");
  if (!/^\d{1,14}(\.\d{1,2})?$/.test(text)) throw new Error("Invalid " + field + " in the return file");
  const [units, fraction = ""] = text.split(".");
  const n = Number(BigInt(units) * 100n + BigInt(fraction.padEnd(2, "0")));
  if (!Number.isSafeInteger(n)) throw new Error("The reported " + field + " exceeds the supported amount");
  return n;
}

function reportDate(value) {
  const parts = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(value));
  if (!parts) throw new Error("Expected a DD-MM-YYYY document date");
  const date = parts[3] + "-" + parts[2] + "-" + parts[1];
  const time = new Date(date + "T00:00:00Z");
  if (!Number.isFinite(time.valueOf()) || time.toISOString().slice(0,10) !== date) throw new Error("Invalid calendar date in the return");
  return date;
}

function reportedRates(doc, section, gstin) {
  if (!Array.isArray(doc.itms) || !doc.itms.length) throw new Error("Missing reported rate lines");
  const grouped = new Map();
  for (const row of doc.itms) {
    const source = section === "exp" ? row : row?.itm_det;
    const rate = hundredths(source?.rt, "GST rate");
    if (rate > 10000) throw new Error("Invalid GST rate");
    const localHead = utStates.has(gstin.slice(0,2)) ? "utgstPaise" : "sgstPaise";
    if (!grouped.has(rate)) grouped.set(rate, { gstRateBps:rate, taxablePaise:0, igstPaise:0, cgstPaise:0, sgstPaise:0, utgstPaise:0, cessPaise:0 });
    const target = grouped.get(rate);
    for (const [sourceKey,field] of [["txval","taxablePaise"],["iamt","igstPaise"],["camt","cgstPaise"],["samt",localHead],["csamt","cessPaise"]]) {
      if (sourceKey !== "txval" && source[sourceKey] === undefined) continue;
      const total = target[field] + hundredths(source[sourceKey], sourceKey);
      if (!Number.isSafeInteger(total)) throw new Error("The reported rate totals exceed the supported amount");
      target[field] = total;
    }
  }
  return [...grouped.values()].sort((a,b) => a.gstRateBps - b.gstRateBps);
}

function originalSnapshot(section, group, doc, gstin) {
  const note = section === "cdnr" || section === "cdnur";
  const registered = section === "b2b" || section === "cdnr";
  if (!doc || typeof doc !== "object") throw new Error("Missing document");
  if ([doc.flag,group.flag].some(flag => ["D","R"].includes(flag))) throw new Error("The return marks this record as deleted or rejected");
  if (doc.etin || doc.ec_gstin || (doc.diff_percent != null && Number(doc.diff_percent) !== 1)) throw new Error("E-commerce or differential-rate return entry needs a separate review");
  if (registered && !invoiceTypes.has(doc.inv_typ)) throw new Error("Unsupported registered invoice type in this GSTR-1 section");
  if (registered && !/^[0-9A-Z]{15}$/.test(group.ctin || "")) throw new Error("Missing or invalid recipient GSTIN");
  const number = note ? doc.nt_num : doc.inum;
  if (typeof number !== "string" || !number.trim()) throw new Error("Missing document number");
  if (registered && !["Y","N"].includes(doc.rchrg)) throw new Error("Missing or invalid reverse-charge status");
  if (note && !["C","D"].includes(doc.ntty)) throw new Error("Unknown note type");
  const urType = section === "cdnur" ? doc.typ : null;
  if (section === "cdnur" && !urTypes.has(urType)) throw new Error("Unknown unregistered note type");
  const exportType = section === "exp" ? group.exp_typ : urType === "EXPWP" ? "WPAY" : urType === "EXPWOP" ? "WOPAY" : null;
  if (section === "exp" && !["WPAY","WOPAY"].includes(exportType)) throw new Error("Unknown export type");
  const placeOfSupply = section === "b2cl" ? group.pos : exportType ? (doc.pos || "96") : doc.pos;
  if (!/^\d{2}$/.test(placeOfSupply || "")) throw new Error("Missing or invalid reported place of supply");
  return {
    section, number, date:reportDate(note ? doc.nt_dt : doc.idt),
    recipientGstin:registered ? group.ctin : "", recipientName:registered ? (group.cname || group.trade_name || "") : "",
    placeOfSupply, reverseCharge:doc.rchrg === "Y", invoiceType:registered ? invoiceTypes.get(doc.inv_typ) : null,
    exportType, urType, noteType:note ? doc.ntty : null, invoiceValuePaise:hundredths(doc.val, "document value"),
    portCode:doc.sbpcode || "", shippingBillNumber:String(doc.sbnum ?? ""), shippingBillDate:doc.sbdt ? reportDate(doc.sbdt) : "",
    rates:reportedRates(doc, section, gstin)
  };
}

export function indexOriginalSection(json, gstin, section) {
  if (!sections.has(section)) throw new Error("Choose a supported original GSTR-1 section");
  const header = json?.gstin ? json : json?.data;
  if (typeof header?.gstin !== "string" || header.gstin !== gstin) throw new Error("The return file must show the selected supplier GSTIN");
  if (header.docdata || !/^(0[1-9]|1[0-2])\d{4}$/.test(header.fp)) throw new Error("Use a GSTR-1 file containing its original return period");
  const period = header.fp.slice(2) + "-" + header.fp.slice(0,2);
  const groups = header[section];
  if (!Array.isArray(groups)) throw new Error("No original " + section.toUpperCase() + " section in this file");
  const records = [];
  for (const [g, group] of groups.entries()) {
    const docs = section === "cdnur" ? [group] : group?.[section === "cdnr" ? "nt" : "inv"];
    if (!Array.isArray(docs)) throw new Error("Unrecognised GSTR-1 document list in " + section);
    for (const [i, doc] of docs.entries()) {
      const key = [section,g,i].join("/");
      const label = [doc?.inum || doc?.nt_num || "(no number)", doc?.idt || doc?.nt_dt, group?.ctin, doc?.val === undefined ? "" : "₹" + doc.val].filter(Boolean).join(" · ");
      records.push({key,label,group,doc});
    }
  }
  const indexed = new Map(records.map(row => [row.key,row]));
  function lookup(key) {
    const row = indexed.get(key);
    if (!row) return undefined;
    try { return {key,label:row.label,original:originalSnapshot(section,row.group,row.doc,gstin)}; }
    catch (error) { return {key,label:row.label,problem:error.message}; }
  }
  return {period,records,lookup};
}

export function readOriginalSection(json, gstin, section) {
  const index = indexOriginalSection(json,gstin,section);
  return {period:index.period,records:index.records.map(row => index.lookup(row.key))};
}
