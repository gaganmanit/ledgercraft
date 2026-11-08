import { attribute, children, keyName, value } from "./tally-format.js";
import { tallyDate } from "./tally-values.js";
import { normalizeGstin, GST_STATES } from "./gst.js";
import { tallyXlsxRows } from "./tally-xlsx.js";

// Tally's GSTDETAILS/HSNDETAILS effective dates are independent of selling-price dates.
export const TALLY_GST_SCHEMA_SOURCES = ["https://help.tallysolutions.com/what-are-the-changes-in-xml-tags/", "https://help.tallysolutions.com/developer-reference/schema-and-invoice-changes/gst-schema/", "https://help.tallysolutions.com/gst-rate-details-are-overridden/"];
const key = input => String(input || "").replace(/^\u0004\s*/, "").trim().toLowerCase();
const name = record => attribute(record.node, "NAME") || value(record.node, "NAME");
const empty = () => ({ status: "absent", value: null, evidence: [], superseded: [], issues: [] });
const dateValue = raw => tallyDate(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(raw) ? raw.slice(0, 10) : raw);
const percent = raw => {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?\s*%?$/.exec(String(raw).trim());
  if (!match) throw new Error("The source GST percentage is not an exact supported rate");
  const bps = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (bps > 10000) throw new Error("The source GST percentage exceeds the supported rate");
  return bps;
};
function excelPercentage(raw) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(raw));
  if (!match) throw new Error("Source Excel GST percentage is not an exact decimal");
  const denominator = 10n ** BigInt((match[2] || "").length), scaled = BigInt(match[1] + (match[2] || "")) * 10000n;
  if (scaled % denominator) throw new Error("Source Excel GST percentage exceeds two decimal places");
  const bps = scaled / denominator;
  return `${bps / 100n}.${String(bps % 100n).padStart(2, "0")}`;
}
function info(record) {
  const paths = new Map(), parents = new Map();
  function visit(node, path, parent = null) {
    paths.set(node, path); parents.set(node, parent);
    const counts = new Map();
    for (const entry of node.children) {
      const tag = keyName(entry.tag), index = counts.get(tag) || 0; counts.set(tag, index + 1);
      visit(entry, `${path}/${tag}[${index}]`, node);
    }
  }
  visit(record.node, record.type);
  return { record, paths, parents, rows: tallyXlsxRows(record.node), taxUnits: [...paths.keys()].filter(node => keyName(node.tag) === "TAXUNIT") };
}
export function tallyGstFactIndex(records) {
  const byId = new Map(), stock = new Map(), ledgers = new Map(), companies = [];
  for (const record of records) {
    if (record.disposition === "duplicate-source") continue;
    const item = info(record); byId.set(record.recordId, item);
    const target = record.type === "STOCKITEM" ? stock : record.type === "LEDGER" ? ledgers : null;
    if (target) { const id = key(name(record)); if (!target.has(id)) target.set(id, []); target.get(id).push(item); }
    if (record.type === "COMPANY") companies.push(item);
  }
  return { byId, stock, ledgers, companies, masterCache: new Map(), buyerCache: new Map(), serviceCache: new Map() };
}
function evidence(item, node, effective = null, extras = {}) {
  const voucher = item.record.node, purchase = item.documentDirection === "purchase" || key(value(voucher, "VOUCHERTYPENAME") || attribute(voucher, "VCHTYPE")) === "purchase";
  const dateTag = effective && effective.children.find(child => ["APPLICABLEFROM", "FROMDATE"].includes(keyName(child.tag))) || (item.record.type === "VOUCHER" ? (purchase && voucher.children.find(child => keyName(child.tag) === "REFERENCEDATE") || voucher.children.find(child => keyName(child.tag) === "DATE")) : null);
  const raw = dateTag?.text.trim() || "";
  let effectiveFrom = "", issue = "";
  if (raw) { try { effectiveFrom = dateValue(raw); } catch { issue = "Source effective date is invalid"; } }
  const reviewedDocumentDate = item.reviewedDocumentDate && (!dateTag || ["DATE", "REFERENCEDATE"].includes(keyName(dateTag.tag))) ? item.reviewedDocumentDate : "";
  if (reviewedDocumentDate) { effectiveFrom = dateValue(reviewedDocumentDate); issue = ""; }
  return { recordId: item.record.recordId, file: item.record.file || "", fieldPath: item.paths.get(node), sourceValue: node.text.trim(), effectiveFrom, ...(dateTag ? { effectiveFieldPath: item.paths.get(dateTag), effectiveSourceValue: dateTag.text.trim(), effectiveBasis: ["DATE", "REFERENCEDATE"].includes(keyName(dateTag.tag)) ? "document-date" : "applicable-from" } : {}), ...(reviewedDocumentDate ? { effectiveBasis: "reviewed-document-date", reviewedDocumentDate } : {}), ...extras, ...(issue ? { issue } : {}) };
}
function scalar(item, scope, tags, options = {}) {
  const output = [];
  const add = (node, effective = null) => {
    const proof = evidence(item, node, effective), candidate = { value: node.text.trim(), evidence: [proof], effectiveFrom: proof.effectiveFrom, priority: options.priority || 0, issue: proof.issue || "" };
    if (candidate.value) output.push(candidate);
  };
  for (const entry of scope.children) if (tags.includes(keyName(entry.tag))) add(entry);
  for (const groupTag of options.groups || []) for (const group of children(scope, groupTag)) for (const entry of group.children) if (tags.includes(keyName(entry.tag))) add(entry, group);
  return output;
}
const headerKey = text => key(text).replace(/[\s_/-]+/g, " ");
function excel(item, field, { priority = 0, itemName = "", ledgerName = "", sourceRow = "", kind = "master", direction = "sales" } = {}) {
  const headers = {
    companyGstin: ["Company GSTIN", "Company - GSTIN/UIN", ...(direction === "purchase" ? ["Buyer GSTIN", "Buyer - GSTIN/UIN"] : ["Seller GSTIN", "Seller - GSTIN/UIN"])],
    partyGstin: kind === "invoice" ? ["Buyer/Supplier - GSTIN/UIN", ...(direction === "purchase" ? ["Supplier GSTIN", "Supplier - GSTIN/UIN", "Seller GSTIN", "Seller - GSTIN/UIN"] : [])] : ["GSTIN/UIN", "GST Registration - GSTIN/UIN"],
    hsnSac: ["HSN/SAC", "HSN/SAC Code", "HSN Code", "HSN Details - HSN/SAC", "GST Details - HSN/SAC"],
    gstRateBps: ["GST Rate", "GST Rate (%)", "GST Details - GST Rate", "GST Rate - Integrated Tax"],
    supplyType: ["GST Type of Supply", "GST Details - Type of Supply"], taxability: ["Taxability", "GST Details - Taxability"],
  }[field].map(headerKey);
  const dateHeaders = (field === "hsnSac" ? ["HSN Details - Applicable From", "HSN/SAC Applicable From", "GST Details - Applicable From"] : ["GST Details - Applicable From", "GST Rate Applicable From", "GST Rate - Applicable From"]).map(headerKey);
  const result = [];
  for (const row of item.rows) {
    if (itemName && kind === "invoice" && key(row.cells.find(cell => headerKey(cell.header) === "item name")?.value) !== key(itemName)) continue;
    if (ledgerName && kind === "invoice" && (key(row.cells.find(cell => headerKey(cell.header) === "ledger name")?.value) !== key(ledgerName) || sourceRow && String(row.row) !== String(sourceRow))) continue;
    for (const cell of row.cells.filter(cell => headers.includes(headerKey(cell.header)) && cell.value !== "")) {
      const dateCell = row.cells.find(entry => dateHeaders.includes(headerKey(entry.header)) && entry.value !== "");
      let effectiveFrom = "", issue = cell.error ? "Source GST cell is unresolved" : "";
      if (dateCell) { try { effectiveFrom = dateValue(dateCell.value); } catch { issue = "Source GST effective date is invalid"; } }
      if (field === "gstRateBps" && !dateCell && kind !== "invoice") issue = "Undated master GST rates do not establish the invoice-date rate";
      let supplied = cell.value;
      if (field === "hsnSac" && /^\d+$/.test(cell.value) && /^(?:0{4}|0{6}|0{8})$/.test(cell.format)) supplied = cell.value.padStart(cell.format.length, "0");
      if (field === "gstRateBps" && /%/.test(cell.format)) { try { supplied = excelPercentage(cell.value); } catch (error) { issue = error.message; } }
      result.push({ value: supplied, effectiveFrom, priority, issue, evidence: [{ recordId: item.record.recordId, file: item.record.file || "", fieldPath: `XLSX:${row.sheet}!${cell.ref}`, sourceValue: cell.value, rawValue: cell.raw, numberFormat: cell.format, effectiveFrom, ...(dateCell ? { effectiveFieldPath: `XLSX:${row.sheet}!${dateCell.ref}`, effectiveSourceValue: dateCell.value } : {}), header: cell.header }] });
    }
  }
  return result;
}
function select(candidates, date, validate = input => input) {
  const result = empty();
  const current = candidates.filter(candidate => !candidate.effectiveFrom || candidate.effectiveFrom <= date);
  result.superseded = candidates.filter(candidate => candidate.effectiveFrom > date).flatMap(candidate => candidate.evidence.map(proof => ({ ...proof, reason: "future-effective" })));
  if (!current.length) { if (candidates.length) result.issues.push("No supplied source value is effective on the invoice date"); return result; }
  const priority = Math.max(...current.map(candidate => candidate.priority));
  const relevant = current.filter(candidate => candidate.priority === priority);
  const latest = relevant.reduce((date, candidate) => candidate.effectiveFrom > date ? candidate.effectiveFrom : date, "");
  const chosen = relevant.filter(candidate => candidate.effectiveFrom === latest || !latest && !candidate.effectiveFrom);
  result.superseded.push(...current.filter(candidate => !chosen.includes(candidate)).flatMap(candidate => candidate.evidence.map(proof => ({ ...proof, reason: candidate.priority < priority ? "invoice-override" : "earlier-effective" }))));
  const values = new Set();
  for (const candidate of chosen) {
    result.evidence.push(...candidate.evidence);
    if (candidate.issue) result.issues.push(candidate.issue);
    try { values.add(validate(candidate.value)); } catch (error) { result.issues.push(error.message); }
  }
  if (result.issues.length || values.size !== 1) { result.status = "conflict"; if (values.size > 1) result.issues.push("Conflicting source values share the selected date and precedence"); return result; }
  result.status = "supplied"; result.value = [...values][0];
  return result;
}
function hsnCandidates(item, scope, priority) {
  return [...scalar(item, scope, ["HSNCODE", "GSTHSNNAME"], { priority, groups: ["HSNDETAILS", "GSTDETAILS"] }), ...excel(item, "hsnSac", { priority, itemName: value(scope, "STOCKITEMNAME"), ledgerName: value(scope, "LEDGERNAME"), sourceRow: value(scope, "XLSXROWNUMBER"), kind: scope === item.record.node && item.record.type !== "VOUCHER" ? "master" : "invoice" })];
}
function classification(item, scope, field, priority) {
  return [...scalar(item, scope, field === "supplyType" ? ["GSTTYPEOFSUPPLY", "SUPPLYTYPE", "GSTOVRDNTYPEOFSUPPLY"] : ["TAXABILITY", "GSTOVRDNTAXABILITY"], { priority, groups: ["GSTDETAILS"] }), ...excel(item, field, { priority, itemName: value(scope, "STOCKITEMNAME"), ledgerName: value(scope, "LEDGERNAME"), sourceRow: value(scope, "XLSXROWNUMBER"), kind: item.record.type === "VOUCHER" ? "invoice" : "master" })];
}
function rateCandidates(item, scope, priority, supplierState, supplyKind = "goods") {
  const result = [];
  const groups = children(scope, "GSTDETAILS");
  if (children(scope, "RATEDETAILS").length || children(scope, "STATEWISEDETAILS").length) groups.push(scope);
  for (const group of groups) {
    const proofDate = evidence(item, group, group), base = { effectiveFrom: proofDate.effectiveFrom, priority };
    let issue = proofDate.issue || "";
    if (!base.effectiveFrom && item.record.type !== "VOUCHER") issue = "Undated master GST rates do not establish the invoice-date rate";
    if (children(group, "GSTSLABRATES").length || /^(yes|true|1)$/i.test(value(group, "ISREVERSECHARGEAPPLICABLE"))) issue = "Slab or reverse-charge source rates need their separate classification workflow";
    const taxability = value(group, "TAXABILITY"), supplyType = value(group, "SUPPLYTYPE") || value(scope, "GSTTYPEOFSUPPLY");
    const allowedTypes = supplyKind === "service" ? ["service", "services"] : ["goods", "goods taxable"];
    if (taxability && key(taxability) !== "taxable" || supplyType && !allowedTypes.includes(key(supplyType))) issue = `The source rate is not classified as domestic taxable ${supplyKind === "service" ? "services" : "goods"}`;
    const stateGroups = children(group, "STATEWISEDETAILS");
    let chosen = stateGroups;
    if (stateGroups.length) {
      const matches = stateGroups.filter(node => supplierState && (key(value(node, "STATENAME")) === key(supplierState) || GST_STATES.some(state => state.code === supplierState && key(state.name) === key(value(node, "STATENAME")))));
      chosen = matches.length ? matches : stateGroups.filter(node => ["any", "all states", "all"].includes(key(value(node, "STATENAME"))));
      if (!chosen.length) { result.push({ ...base, value: "", issue: "No source GST rate applies to the selected seller state", evidence: [proofDate] }); continue; }
    } else chosen = [group];
    for (const stateGroup of chosen) {
      let problem = issue;
      if (children(stateGroup, "GSTSLABRATES").length) problem = "Source slab rates need a separate classification review";
      const heads = new Map(), proofs = [];
      for (const rate of children(stateGroup, "RATEDETAILS")) {
        const raw = value(rate, "GSTRATE"), duty = value(rate, "GSTRATEDUTYHEAD"), method = value(rate, "GSTRATEVALUATIONTYPE");
        const field = rate.children.find(node => keyName(node.tag) === "GSTRATE");
        proofs.push(evidence(item, field || rate, group, { dutyHead: duty, stateName: value(stateGroup, "STATENAME"), valuationType: method }));
        if (raw === "") { problem ||= "A source GST rate head has no explicit percentage"; continue; }
        const head = /^(central tax|cgst)$/i.test(duty) ? "cgst" : /^(state tax|sgst)$/i.test(duty) ? "sgst" : /^(ut tax|union territory tax|utgst)$/i.test(duty) ? "utgst" : /^(integrated tax|igst)$/i.test(duty) ? "igst" : /cess/i.test(duty) ? "cess" : "";
        if (!head || method && !/^based on value$/i.test(method) || value(rate, "GSTRATEPERUNIT") && Number(value(rate, "GSTRATEPERUNIT"))) { problem ||= "Unsupported source GST head or quantity-based valuation"; continue; }
        try { const bps = percent(raw); if (heads.has(head) && heads.get(head) !== bps) problem ||= "Conflicting percentages for one source GST head"; heads.set(head, bps); } catch (error) { problem ||= error.message; }
      }
      const split = heads.has("cgst") && (heads.has("sgst") || heads.has("utgst")) ? heads.get("cgst") + (heads.get("sgst") ?? heads.get("utgst")) : null;
      const total = heads.get("igst") ?? split;
      if (heads.get("cess") || total === null || total === undefined || heads.has("igst") && split !== null && heads.get("igst") !== split) problem ||= "Source GST heads are incomplete, contradictory or include unsupported cess";
      result.push({ ...base, value: total, issue: problem, evidence: proofs.length ? proofs : [proofDate] });
    }
  }
  result.push(...excel(item, "gstRateBps", { priority, itemName: value(scope, "STOCKITEMNAME"), ledgerName: value(scope, "LEDGERNAME"), sourceRow: value(scope, "XLSXROWNUMBER"), kind: item.record.type === "VOUCHER" ? "invoice" : "master" }).map(candidate => { try { return { ...candidate, value: percent(candidate.value) }; } catch (error) { return { ...candidate, issue: error.message }; } }));
  return result;
}
export function sourceTaxFacts(index, record, date, sourceItems, registrationState = "", correctedSeller = false, options = {}) {
  const node = record.node;
  const purchase = options.direction === "purchase" || !options.direction && (key(record.targetType) === "purchase" || key(value(node, "VOUCHERTYPENAME") || attribute(node, "VCHTYPE")) === "purchase");
  const direction = purchase ? "purchase" : "sales";
  const invoice = { ...index.byId.get(record.recordId), documentDirection: direction, ...(purchase && options.documentDate ? { reviewedDocumentDate: dateValue(options.documentDate) } : {}) };
  const companyCandidates = scalar(invoice, node, ["CMPGSTIN"], { priority: 2 });
  companyCandidates.push(...excel(invoice, "companyGstin", { priority: 2, kind: "invoice", direction }));
  const requested = key(value(node, "GSTREGISTRATION"));
  for (const company of index.companies) {
    companyCandidates.push(...scalar(company, company.record.node, ["GSTREGISTRATIONNUMBER", "GSTREGNUMBER", "GSTIN"], { groups: ["GSTREGISTRATIONDETAILS"], priority: 0 }));
    for (const scope of company.taxUnits) if (!requested || key(attribute(scope, "NAME") || value(scope, "NAME")) === requested) companyCandidates.push(...scalar(company, scope, ["GSTREGNUMBER", "GSTIN"], { groups: ["GSTREGISTRATIONDETAILS"], priority: 1 }));
  }
  const companyGstin = select(companyCandidates, date, normalizeGstin);
  const partyCandidates = [...scalar(invoice, node, ["PARTYGSTIN"], { priority: 2 }), ...excel(invoice, "partyGstin", { priority: 2, kind: "invoice", direction })];
  for (const master of index.ledgers.get(key(value(node, "PARTYLEDGERNAME"))) || []) {
    if (!index.buyerCache.has(master.record.recordId)) index.buyerCache.set(master.record.recordId, [...scalar(master, master.record.node, ["PARTYGSTIN", "GSTREGISTRATIONNUMBER", "GSTIN"], { groups: ["LEDGSTREGDETAILS"], priority: 0 }), ...excel(master, "partyGstin")]);
    partyCandidates.push(...index.buyerCache.get(master.record.recordId));
  }
  const partyGstin = select(partyCandidates, date, normalizeGstin);
  const sellerGstin = purchase ? partyGstin : companyGstin, buyerGstin = purchase ? companyGstin : partyGstin;
  const partyStates = purchase ? scalar(invoice, node, ["PARTYSTATENAME"], { priority: 2 }) : [];
  if (purchase) for (const master of index.ledgers.get(key(value(node, "PARTYLEDGERNAME"))) || []) partyStates.push(...scalar(master, master.record.node, ["LEDSTATENAME", "STATENAME"], { groups: ["LEDGSTREGDETAILS"] }));
  const partyState = select(partyStates, date, raw => {
    const normalized = /^\d{1,2}$/.test(raw) ? raw.padStart(2, "0") : GST_STATES.find(state => key(state.name) === key(raw))?.code;
    if (!GST_STATES.some(state => state.code === normalized)) throw new Error("Source supplier state is unsupported");
    return normalized;
  });
  const sellerState = purchase ? (correctedSeller ? options.supplierState || "" : partyState.status === "supplied" ? partyState.value : options.supplierState || "") : registrationState;
  const supplierState = correctedSeller ? sellerState : sellerGstin.status === "supplied" ? sellerGstin.value.slice(0, 2) : sellerState;
  const entries = [...children(node, "ALLINVENTORYENTRIES"), ...children(node, "INVENTORYENTRIES")];
  const allLedgerEntries = children(node, "ALLLEDGERENTRIES");
  const ledgerEntries = allLedgerEntries.length ? allLedgerEntries : children(node, "LEDGERENTRIES");
  const items = sourceItems.map((source, lineIndex) => {
    const service = source.sourceKind === "ledger", supplyKind = service ? "service" : "goods";
    const entry = service ? ledgerEntries[source.sourceLedgerEntryIndex] : entries[lineIndex];
    if (!entry || service && key(value(entry, "LEDGERNAME")) !== key(source.sourceLedgerName || source.sourceName)) throw new Error("The source tax line no longer identifies its original entry");
    // The fact index already belongs to one frozen source snapshot. Service
    // discovery and final invoice construction select these same facts twice.
    const cacheKey = service ? JSON.stringify([record.recordId, date, supplierState, direction, invoice.reviewedDocumentDate || '', source.sourceLedgerEntryIndex, source.sourceLineId || '', source.sourceName, source.sourceLedgerName || '']) : '';
    if (service && index.serviceCache?.has(cacheKey)) return structuredClone(index.serviceCache.get(cacheKey));
    const masters = (service ? index.ledgers : index.stock).get(key(source.sourceLedgerName || source.sourceName)) || [];
    const hsn = [], rate = [], types = [], taxes = [];
    for (const master of masters) {
      const cacheKey = `${master.record.recordId}:${supplierState}${service ? ":service" : ""}`;
      if (!index.masterCache.has(cacheKey)) index.masterCache.set(cacheKey, { hsn: hsnCandidates(master, master.record.node, 0), rate: rateCandidates(master, master.record.node, 0, supplierState, supplyKind), types: classification(master, master.record.node, "supplyType", 0), taxes: classification(master, master.record.node, "taxability", 0) });
      const cached = index.masterCache.get(cacheKey);
      hsn.push(...cached.hsn); rate.push(...cached.rate); types.push(...cached.types); taxes.push(...cached.taxes);
    }
    hsn.push(...hsnCandidates(invoice, entry, 2)); rate.push(...rateCandidates(invoice, entry, 2, supplierState, supplyKind));
    types.push(...classification(invoice, entry, "supplyType", 2)); taxes.push(...classification(invoice, entry, "taxability", 2));
    const supplyType = select(types, date, raw => /^goods$/i.test(raw) ? "goods" : /^services?$/i.test(raw) ? "service" : (() => { throw new Error("Unsupported source supply type"); })());
    const taxability = select(taxes, date, raw => key(raw));
    const hsnSac = select(hsn, date, raw => {
      if (service) { if (!/^99\d{4}$/.test(raw)) throw new Error("Source service SAC must retain an explicit 6 digit service code"); }
      else { if (!/^(?:\d{4}|\d{6}|\d{8})$/.test(raw)) throw new Error("Source HSN must retain an explicit 4, 6 or 8 digit code"); if (raw.startsWith("99")) throw new Error("Source SAC classifies this line as services; goods promotion needs review"); }
      return raw;
    });
    const gstRateBps = select(rate, date, raw => { if (!Number.isInteger(raw) || raw < 0 || raw > 10000) throw new Error("Source GST rate is not a supported exact percentage"); return raw; });
    if (supplyType.status === "supplied" && supplyType.value !== supplyKind || taxability.status === "supplied" && taxability.value !== "taxable") {
      if (gstRateBps.status !== "absent") { gstRateBps.status = "conflict"; gstRateBps.value = null; gstRateBps.issues.push(`The selected source classification is not domestic taxable ${service ? "services" : "goods"}`); }
    }
    const result = { sourceName: source.sourceName, ...(service ? { sourceLineId: source.sourceLineId, sourceKind: 'ledger' } : {}), hsnSac, gstRateBps, supplyType, taxability };
    if (service) (index.serviceCache ??= new Map()).set(cacheKey, structuredClone(result));
    return result;
  });
  return { sellerGstin, buyerGstin, items };
}
