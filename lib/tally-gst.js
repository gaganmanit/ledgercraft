import { createHash } from "node:crypto";
import { sourceTallyServiceLines, tallyServiceSourceLookups } from "./tally-service-source.js";
import { normalizeTallyServiceMappings, buildTallyGstServicePromotion, tallyGstServicePostingLines, assertTallyServiceLedgerGroups, assertTallyServiceStockLink, assertTallyServiceMapping } from "./tally-gst-services.js";
import { isTallyNote, normalizeTallyNoteReview, sourceTallyGstNote, buildTallyGstNotePromotion, tallyGstNotePostingLines, assertTallyGstNoteFamily, assertTallyGstNoteStockLink } from "./tally-gst-notes.js";
import { isDeepStrictEqual } from "node:util";
import { buildGstInvoice, assertGstSnapshot, GST_COMPONENTS, GST_STATES, quantityMicros, formatQuantity, normalizeGstin } from "./gst.js";
import { attribute, children, findNodes, keyName, value } from "./tally-format.js";
import { tallyAmount, tallyDate } from "./tally-values.js";
import { isIsoDate } from "./money.js";
import { assertUniqueGstDocuments } from "./gst-document-identity.js";
import { tallyXlsxRows } from "./tally-xlsx.js";
import { tallyGstFactIndex, sourceTaxFacts } from "./tally-gst-facts.js";

export const TALLY_GST_SOURCES = ["https://help.tallysolutions.com/tally-prime/download-sample-excel-files-with-data-for-import/", "https://cbic-gst.gov.in/gst-invoice-rules.html"];
const digest = input => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const key = input => String(input || "").trim().toLocaleLowerCase("en-IN");
const roles = ["party", "sales", "purchase", "cgst", "sgst", "utgst", "igst", "cess"];
const invoiceRoles = invoice => roles.filter(role => role !== (invoice.direction === "purchase" ? "sales" : "purchase"));
const invoiceSourceType = (record, voucher) => voucher?.type || record.targetType || value(record.node, "VOUCHERTYPENAME") || attribute(record.node, "VCHTYPE");
const hashPattern = /^[a-f0-9]{64}$/;
const requestPattern = /^[a-zA-Z0-9-]{16,80}$/;
const sum = values => {
  const total = values.reduce((result, amount) => result + BigInt(amount), 0n);
  if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Source GST totals exceed exact paise");
  return Number(total);
};
const posting = voucher => ({ type: voucher.type, date: voucher.date, number: voucher.number, narration: voucher.narration, lines: voucher.lines });
const postingHash = voucher => digest(posting(voucher));
const nodeHash = record => digest({ type: record.type, node: record.node });
const sourceHash = records => digest(records.filter(record => record.disposition !== "duplicate-source").map(record => [record.recordId, nodeHash(record)]).sort(([a], [b]) => a.localeCompare(b)));
const stockHash = journal => digest(journal);
const sourceReferences = transport => ({ irn: transport.IRN || "", acknowledgementNumber: transport.IRNACKNO || transport.ACKNO || "", acknowledgementDate: transport.IRNACKDATE || transport.ACKDATE || "", ewayBillNumber: transport.EWAYBILLNUMBER || "", ewayBillDate: transport.EWAYBILLDATE || "" });
const blank = () => ({ version: 1, revision: 0, mappings: [], activations: [], audit: [] });
const section = company => structuredClone(company.gst?.tallyPromotion || blank());
const requireText = (input, label, maximum = 240) => {
  if (typeof input !== "string" || !input.trim() || input.length > maximum) throw new Error(`Enter ${label} within ${maximum} characters`);
  return input.trim();
};
function promotionContext(company, vouchers, records) {
  const references = new Map(), serviceLookups = tallyServiceSourceLookups(company);
  for (const record of records.filter(record => record.type === "VOUCHER" && record.disposition !== "duplicate-source")) {
    const refs = sourceReferences(Object.fromEntries(["IRN", "IRNACKNO", "ACKNO", "EWAYBILLNUMBER"].map(tag => [tag, value(record.node, tag)])));
    for (const [field, text] of Object.entries(refs)) if (text) references.set(`${field}:${text}`, (references.get(`${field}:${text}`) || 0) + 1);
  }
  return { assertRegularSource: assertRegularPurchaseSource, sourceExportAllocations: purchaseExportAllocations, facts: tallyGstFactIndex(records), factCache: new Map(), serviceLookups, references, records: new Map(records.map(record => [record.recordId, record])), vouchers: new Map(vouchers.map(voucher => [voucher.id, voucher])), ledgers: new Map(company.ledgers.map(ledger => [ledger.id, ledger])), ledgerNames: new Map(company.ledgers.map(ledger => [key(ledger.name), ledger])), gstItems: new Map((company.gst?.items || []).map(item => [item.id, item])), stockItems: new Map((company.stock?.masters || []).map(item => [item.id, item])), stockNames: new Map((company.stock?.masters || []).map(item => [key(item.name), item])), parties: new Map((company.gst?.parties || []).map(party => [party.id, party])), registrations: new Map((company.gst?.registrations || []).map(registration => [registration.id, registration])), stockJournals: new Map((company.stock?.journals || []).filter(journal => journal.accountingVoucherId).map(journal => [journal.accountingVoucherId, journal])) };
}
function suggestions(source, context) {
  const facts = source.taxFacts, result = { items: [] };
  const own = source.direction === "purchase" ? facts.buyerGstin : facts.sellerGstin;
  const counterparty = source.direction === "purchase" ? facts.sellerGstin : facts.buyerGstin;
  if (own.status === "supplied") result.registration = { gstin: own.value, stateCode: own.value.slice(0, 2) };
  if (counterparty.status === "supplied") result.party = { gstin: counterparty.value, stateCode: counterparty.value.slice(0, 2) };
  for (const item of facts.items) {
    const row = { sourceName: item.sourceName, stockItemId: context.stockNames.get(key(item.sourceName))?.id };
    if (item.hsnSac.status === "supplied") row.hsnSac = item.hsnSac.value;
    if (item.gstRateBps.status === "supplied") row.gstRateBps = item.gstRateBps.value;
    if (item.supplyType.status === "supplied" && (item.supplyType.value === "goods" || source.serviceReview && item.supplyType.value === "service")) row.kind = item.supplyType.value;
    if (item.sourceKind === "ledger") row.sourceLineId = item.sourceLineId;
    if (item.taxability.status === "supplied" && item.taxability.value === "taxable") row.supplyStatus = "taxable";
    if (Object.keys(row).length > 2) result.items.push(row);
  }
  return result;
}
function chooseFact(fact, localValue, field, mapping, review, allowSource = true) {
  const reason = mapping.sourceCorrections?.[field] || "";
  if (fact.status === "conflict" && !reason || fact.status === "supplied" && !allowSource && fact.value !== localValue && !reason) throw new Error(`${field}: supplied source facts require review. ${fact.issues.join("; ") || "Choose a matching local master or record an explicit correction reason"}`);
  const useSource = fact.status === "supplied" && allowSource && !reason;
  const chosenValue = useSource ? fact.value : localValue;
  review.push({ field, status: fact.status === "absent" ? "absent" : reason ? "corrected" : "matching", chosenBasis: useSource || fact.status === "supplied" && fact.value === localValue && !reason ? "source" : "local-mapping", chosenValue, localMasterValue: localValue, sourceValue: fact.value, ...(reason ? { reason } : {}), evidence: structuredClone(fact.evidence), superseded: structuredClone(fact.superseded), issues: [...fact.issues] });
  return chosenValue;
}
function inGroup(company, ledgerId, groupId) {
  let id = company.ledgers.find(ledger => ledger.id === ledgerId)?.groupId;
  const seen = new Set();
  while (id && !seen.has(id)) { if (id === groupId) return true; seen.add(id); id = company.groups.find(group => group.id === id)?.parentId; }
  return false;
}
function state(input) {
  const text = String(input || "").trim();
  const code = /^\d{1,2}$/.test(text) ? text.padStart(2, "0") : GST_STATES.find(item => key(item.name) === key(text))?.code;
  if (!code || !GST_STATES.some(item => item.code === code) || code === "96") throw new Error(`Source place of supply ${text || "(missing)"} needs an explicit supported Indian state`);
  return code;
}
function qty(input) {
  const match = /^(\d+(?:\.\d+)?)(?:\s+(.+))?$/.exec(String(input || "").trim().replace(/,/g, ""));
  if (!match) throw new Error("Source quantity needs an explicit simple unit");
  return { quantity: formatQuantity(quantityMicros(match[1])), unit: match[2] || "" };
}
function assertRegularPurchaseSource(node) {
  const specialNature = /\b(?:sez|imports?|exports?|reverse\s*charge|lut|bond|composition|exempt|nil[ -]?rated|non[ -]?gst)\b/i;
  const natureFields = ["GSTNATUREOFTRANSACTION", "NATUREOFTRANSACTION", "GSTCLASS", "GSTOVRDNNATURE", "GSTREGISTRATIONTYPE", "PARTYGSTREGTYPE"];
  for (const field of natureFields) for (const entry of findNodes(node, field)) {
    if (specialNature.test(entry.text)) throw new Error(`${field}: this source purchase treatment needs its separate GST workflow`);
  }
  for (const field of ["BILLOFENTRYNO", "BILLOFENTRYNUMBER", "BILLOFENTRYDATE"]) {
    if (findNodes(node, field).some(entry => entry.text.trim())) throw new Error(`${field}: customs and SEZ purchases need their separate GST workflow`);
  }
  for (const field of ["ISSEZPARTY", "ISBILLOFENTRYAVAILABLE", "ISREVERSECHARGEAPPLICABLE"]) {
    if (findNodes(node, field).some(entry => /^(yes|true|1)$/i.test(entry.text.trim()))) throw new Error(`${field} needs its specific GST workflow`);
  }
}
function purchaseExportAllocations(node) {
  const hasData = entry => Boolean(entry.text.trim() || Object.values(entry.attrs).some(text => String(text).trim()) || entry.children.some(hasData));
  const unsupported = new Set(), bills = [], capturedBills = new Set();
  const all = children(node, "ALLLEDGERENTRIES");
  const direct = all.length ? all : children(node, "LEDGERENTRIES");
  let postingIndex = 0;
  for (const entry of direct) {
    const nonzero = tallyAmount(value(entry, "AMOUNT"), true) !== 0;
    for (const bill of children(entry, "BILLALLOCATIONS").filter(hasData)) {
      bills.push({ postingIndex: nonzero ? postingIndex : null, node: structuredClone(bill) });
      capturedBills.add(bill);
    }
    if (nonzero) postingIndex++;
  }
  const visit = entry => {
    const tag = keyName(entry.tag);
    if (hasData(entry)) {
      if ((tag.endsWith("ALLOCATIONS") && !["BATCHALLOCATIONS", "ACCOUNTINGALLOCATIONS", "BILLALLOCATIONS"].includes(tag)) || ["ADDITIONALCOSTDETAILS", "COSTTRACKALLOCATIONS"].includes(tag)) unsupported.add(tag);
      if (tag === "ACCOUNTINGALLOCATIONS" && entry.children.some(child => hasData(child) && !["LEDGERNAME", "AMOUNT", "ISDEEMEDPOSITIVE"].includes(keyName(child.tag)))) unsupported.add(tag);
      if (tag === "BILLALLOCATIONS" && !capturedBills.has(entry)) unsupported.add(tag);
    }
    entry.children.forEach(visit);
  };
  visit(node);
  return { exportUnsupportedAllocations: [...unsupported].sort(), exportBillAllocations: bills };
}
function purchaseSourceFields(node, voucher, mapping) {
  const review = mapping.purchaseReview || {};
  const reference = value(node, "REFERENCE");
  const rawDate = value(node, "REFERENCEDATE");
  let sourceDate = "";
  if (rawDate) {
    const midnight = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/.exec(rawDate);
    try { sourceDate = tallyDate(midnight ? midnight[1] : rawDate); }
    catch (error) {
      if (!review.supplierInvoiceDate || !mapping.sourceCorrections?.supplierInvoiceDate) throw error;
      sourceDate = rawDate;
    }
  }
  const reviewed = (field, supplied) => {
    const selected = review[field] || supplied;
    if (supplied && selected !== supplied && !mapping.sourceCorrections?.[field]) throw new Error(`${field}: preserve the source supplier document or record an explicit correction reason`);
    return selected;
  };
  const supplierInvoiceNumber = reviewed("supplierInvoiceNumber", reference);
  const supplierInvoiceDate = reviewed("supplierInvoiceDate", sourceDate);
  const receivedDate = review.receivedDate || "";
  const suppliedPlace = value(node, "PLACEOFSUPPLY");
  const placeOfSupply = review.placeOfSupply ? state(review.placeOfSupply) : suppliedPlace ? state(suppliedPlace) : "";
  if (suppliedPlace && review.placeOfSupply && state(suppliedPlace) !== placeOfSupply && !mapping.sourceCorrections?.placeOfSupply) throw new Error("placeOfSupply: preserve the source place of supply or record an explicit correction reason");
  if (supplierInvoiceDate && (!isIsoDate(supplierInvoiceDate) || supplierInvoiceDate > voucher.date)) throw new Error("The supplier invoice date must be valid and on or before its accounting date");
  if (receivedDate && (!isIsoDate(receivedDate) || receivedDate > voucher.date)) throw new Error("The reviewed receipt date must be valid and on or before its accounting date");
  return { type: "Purchase", direction: "purchase", sourceVoucherNumber: value(node, "VOUCHERNUMBER"), sourceVoucherDate: voucher.date, sourceVoucherType: value(node, "VOUCHERTYPENAME") || attribute(node, "VCHTYPE"),
    sourceInvoiceNumber: supplierInvoiceNumber, sourceInvoiceDate: supplierInvoiceDate, receivedDate, placeOfSupply, placeOfSupplyEvidence: { sourceValue: suppliedPlace, chosenBasis: review.placeOfSupply ? "reviewed" : suppliedPlace ? "source" : "unresolved" },
    supplierDocument: { sourceNumber: reference, sourceDate, numberBasis: review.supplierInvoiceNumber ? "reviewed" : reference ? "source" : "unresolved", dateBasis: review.supplierInvoiceDate ? "reviewed" : sourceDate ? "source" : "unresolved" } };
}
function sourceInvoice(company, voucher, record, context, registrationState = "", correctedSeller = false, mapping = {}) {
  const node = record.node;
  if (isTallyNote(voucher)) return sourceTallyGstNote(company, voucher, record, context, mapping);
  if (record.disposition !== "voucher" || !voucher || !["Sales", "Purchase"].includes(voucher.type)) throw new Error("Only an imported, posted Sales or Purchase invoice is supported for GST promotion");
  const purchase = voucher.type === "Purchase";
  if (purchase) assertRegularPurchaseSource(node);
  if (!record.originalPosting || postingHash(record.originalPosting) !== postingHash(voucher)) throw new Error("The source accounting voucher changed after import");
  for (const field of ["ISCANCELLED", "ISOPTIONAL", "ISDELETED", "ISPOSTDATED", "ISREVERSECHARGEAPPLICABLE"]) if (/^(yes|true|1)$/i.test(value(node, field))) throw new Error(`${field} needs its specific GST workflow`);
  const inventory = [...children(node, "ALLINVENTORYENTRIES"), ...children(node, "INVENTORYENTRIES")];
  const purchaseFields = purchase ? { ...purchaseSourceFields(node, voucher, mapping), ...purchaseExportAllocations(node) } : {};
  const factDate = purchase ? purchaseFields.sourceInvoiceDate : voucher.date;
  const legacy = [1, 2].includes(voucher.gst?.tallyOrigin?.version);
  const services = legacy ? { items: [], candidates: [], issues: [] } : sourceTallyServiceLines(company, voucher, record, context.facts, {
    lookups: context.serviceLookups,
    date: factDate, direction: purchase ? "purchase" : "sales", registrationState,
    supplierState: context.parties.get(mapping.partyId)?.stateCode || "", correctedSeller,
    reviewedSourceLineIds: (mapping.serviceItems || []).filter(row => row.classificationConfirmed).map(row => row.sourceLineId),
    ...(purchase && mapping.purchaseReview?.supplierInvoiceDate ? { documentDate: factDate } : {}),
  });
  const serviceReview = services.items.length > 0 || services.candidates.length > 0 || services.issues.length > 0;
  if (!inventory.length && !serviceReview) throw new Error("Source invoice has no supported item lines");
  if (["ADDITIONALCOSTDETAILS", "COSTTRACKALLOCATIONS"].some(tag => findNodes(node, tag).length)) throw new Error("Additional inventory allocations require a separate tax and valuation review");
  const goods = inventory.map(entry => {
    const sourceName = value(entry, "STOCKITEMNAME"), billed = qty(value(entry, "BILLEDQTY"));
    const actualText = value(entry, "ACTUALQTY") || (record.sourceFormat === "xlsx" && company.tallyWorkbook?.useBilledAsActual === true ? value(entry, "BILLEDQTY") : "");
    const actual = actualText ? qty(actualText) : null;
    if (!sourceName || !billed.unit || actual && key(actual.unit) !== key(billed.unit)) throw new Error("Actual and billed item quantities need one explicit simple unit; alternate units require conversion review");
    const rate = /^(\d+(?:\.\d{1,2})?)\s*(?:\/\s*(.+))?$/.exec(value(entry, "RATE").replace(/,/g, ""));
    if (!rate || rate[2] && key(rate[2]) !== key(billed.unit)) throw new Error(`Item ${sourceName} needs an exact unit rate in its source unit`);
    const amount = tallyAmount(value(entry, "AMOUNT"));
    const flag = value(entry, "ISDEEMEDPOSITIVE");
    if ((purchase ? amount >= 0 : amount <= 0) || flag && /^(yes|true|1)$/i.test(flag) !== purchase) throw new Error("Source item amount or direction is unsupported");
    const discountText = purchase ? value(entry, "DISCOUNT").replace(/\s*%$/, "").trim() : "";
    const discountBps = discountText ? tallyAmount(discountText) : 0;
    if (discountBps < 0 || discountBps > 10000) throw new Error("Source purchase discount needs an explicit percentage between zero and one hundred");
    return { sourceName, ...billed, ...(purchase ? { discountBps, sourceAmountPaise: amount, sourceDirectionFlag: flag,
      discountEvidence: value(entry, "DISCOUNT") ? { recordId: record.recordId, fieldPath: `VOUCHER/${entry.tag.replace(/\.LIST$/i, "")}[${children(node, entry.tag).indexOf(entry)}]/DISCOUNT[0]`, sourceValue: value(entry, "DISCOUNT"), chosenBps: discountBps } : null } : {}), actualQuantity: actual?.quantity || null, actualBasis: value(entry, "ACTUALQTY") ? "source" : actual ? "reviewed-billed" : "unresolved", unitPricePaise: tallyAmount(rate[1]), valuePaise: Math.abs(amount) };
  });
  const items = serviceReview ? [...goods.map(row => ({ ...row, kind: "goods" })), ...services.items.map(row => ({ ...row, discountBps: 0 }))] : goods;
  const name = value(node, "PARTYLEDGERNAME");
  const account = context.ledgerNames.get(key(name));
  if (!account || !inGroup(company, account.id, purchase ? "g-creditors" : "g-debtors")) throw new Error(purchase ? "Source purchase party must be a supported creditor ledger" : "Source sales party must be a supported debtor ledger");
  const partySide = purchase ? "Cr" : "Dr";
  const debit = sum(voucher.lines.filter(line => line.dc === partySide).map(line => line.paise));
  if (voucher.lines.some(line => line.dc === partySide && line.ledgerId !== account.id)) throw new Error("Source invoice has non-party settlement postings; discounts, charges and mixed settlements need their own review");
  const taxNames = { cgst: /\bcgst\b|central.*tax/i, sgst: /\bsgst\b|state.*tax/i, utgst: /\butgst\b|union.*tax/i, igst: /\bigst\b|integrated.*tax/i, cess: /\bcess\b/i };
  const taxes = Object.fromEntries(GST_COMPONENTS.map(component => [`${component}Paise`, sum(voucher.lines.filter(line => line.dc === (purchase ? "Dr" : "Cr") && taxNames[component].test(context.ledgers.get(line.ledgerId)?.name || "")).map(line => line.paise))]));
  const transport = Object.fromEntries(["IRN", "ACKNO", "ACKDATE", "IRNACKNO", "IRNACKDATE", "EWAYBILLNUMBER", "EWAYBILLDATE", "TRANSPORTERID", "TRANSPORTERNAME", "TRANSPORTMODE", "VEHICLENO", "VEHICLENUMBER", "TRANSPORTDOCNO", "TRANSPORTDOCDATE", "DISPATCHFROM", "DESTINATION"].map(field => [field, value(node, field)]).filter(([, text]) => text));
  let gstinChecksumValid = null;
  if (value(node, "PARTYGSTIN")) { try { normalizeGstin(value(node, "PARTYGSTIN")); gstinChecksumValid = true; } catch { gstinChecksumValid = false; } }
  const itemValuePaise = sum(items.map(item => item.valuePaise)), taxPaise = sum(Object.values(taxes));
  const unresolvedAdjustmentsPaise = debit - itemValuePaise - taxPaise;
  if (!Number.isSafeInteger(unresolvedAdjustmentsPaise)) throw new Error("Source adjustments exceed exact paise");
  const factKey = `${record.recordId}:${registrationState}:${correctedSeller}:${purchase ? factDate + ":" + (mapping.partyId || "") : ""}${serviceReview ? ":services:" + items.filter(row => row.kind === "service").map(row => row.sourceLineId).join(",") : ""}`;
  if (!context.factCache.has(factKey)) context.factCache.set(factKey, sourceTaxFacts(context.facts, record, factDate, items, registrationState, correctedSeller, purchase ? { direction: "purchase", supplierState: context.parties.get(mapping.partyId)?.stateCode || "", ...(mapping.purchaseReview?.supplierInvoiceDate ? { documentDate: factDate } : {}) } : undefined));
  return { sourceInvoiceNumber: value(node, "VOUCHERNUMBER"), ...purchaseFields,
    ...(serviceReview ? { serviceReview: true, hasGoods: goods.length > 0, serviceOnly: goods.length === 0, direction: purchase ? "purchase" : "sales", type: voucher.type,
      sourceVoucherType: value(node, "VOUCHERTYPENAME") || attribute(node, "VCHTYPE"), sourceVoucherNumber: value(node, "VOUCHERNUMBER"), sourceVoucherDate: voucher.date,
      serviceCandidates: services.candidates, serviceIssues: services.issues, ...purchaseExportAllocations(node) } : {}), partyName: name, partyLedgerId: account.id, gstin: value(node, "PARTYGSTIN"), gstinChecksumValid, placeOfSupply: purchase ? purchaseFields.placeOfSupply : state(value(node, "PLACEOFSUPPLY") || value(node, "PARTYSTATENAME")), items, postings: voucher.lines.map(line => ({ ...line, name: context.ledgers.get(line.ledgerId)?.name || "" })), taxes, itemValuePaise, taxablePaise: null, taxPaise, identifiedSourceTaxPaise: taxPaise, classification: "source-only", unresolvedAdjustmentsPaise, totalPaise: debit, transport, transportStatus: "source-unverified", workbookRows: tallyXlsxRows(node), taxFacts: structuredClone(context.factCache.get(factKey)) };
}

// Each original posting has exactly one reviewed role; no netting can hide an extra debit or credit.
export function tallyGstPostingLines(invoice) {
  if (invoice.tallyOrigin?.version === 4) return tallyGstServicePostingLines(invoice);
  if (invoice.tallyOrigin?.version === 3) return tallyGstNotePostingLines(invoice);
  const origin = invoice.tallyOrigin;
  const purchase = invoice.direction === "purchase";
  const expectedType = purchase ? "Purchase" : "Sales";
  if (!origin || origin.version !== (purchase ? 2 : 1) || invoice.type !== expectedType || invoice.direction !== (purchase ? "purchase" : "sales") || invoice.reverseCharge || invoice.supplyCategory !== "domestic" || !Array.isArray(origin.postings) || !origin.postings.length || !Array.isArray(origin.postingRoles) || origin.postingRoles.length !== origin.postings.length) throw new Error("Invalid reviewed Tally GST posting linkage");
  const activeRoles = invoiceRoles(invoice);
  const totals = Object.fromEntries(activeRoles.map(role => [role, 0n]));
  for (const [index, line] of origin.postings.entries()) {
    const role = origin.postingRoles[index];
    if (!activeRoles.includes(role) || !line || typeof line.ledgerId !== "string" || !Number.isSafeInteger(line.paise) || line.paise <= 0 || line.dc !== (role === "party" ? purchase ? "Cr" : "Dr" : purchase ? "Dr" : "Cr") || origin.accounts?.[role] !== line.ledgerId) throw new Error("A source GST posting lacks one exact reviewed role");
    totals[role] += BigInt(line.paise);
  }
  for (const role of activeRoles) if (totals[role] !== BigInt(role === "party" ? invoice.totals.totalPaise : ["sales", "purchase"].includes(role) ? invoice.totals.taxablePaise : invoice.totals[`${role}Paise`])) throw new Error(`Reviewed source ${role} postings do not equal calculated GST totals`);
  if ((purchase ? origin.internalVoucherNumber : origin.originalInvoiceNumber) !== invoice.number || (purchase ? origin.source?.sourceVoucherNumber !== origin.originalInvoiceNumber : origin.source?.sourceInvoiceNumber !== invoice.number) || typeof origin.internalVoucherNumber !== "string" || origin.accounts.party !== (purchase ? invoice.party.supplierLedgerId : invoice.party.customerLedgerId) || !hashPattern.test(origin.postingHash || "") || origin.postingHash !== postingHash({ ...invoice, number: origin.internalVoucherNumber, lines: origin.postings })) throw new Error("The original source posting order, amounts or identity changed");
  if (purchase && (invoice.itcEligibility !== "pending" || origin.source?.direction !== "purchase" || invoice.supplierInvoiceNumber !== origin.source.sourceInvoiceNumber.toUpperCase() || invoice.supplierInvoiceDate !== origin.source.sourceInvoiceDate || invoice.receivedDate !== origin.source.receivedDate || !isIsoDate(invoice.supplierInvoiceDate) || invoice.supplierInvoiceDate > invoice.date || invoice.receivedDate && (!isIsoDate(invoice.receivedDate) || invoice.receivedDate > invoice.date))) throw new Error("The reviewed supplier document, receipt date or initial pending ITC treatment changed");
  if (!isDeepStrictEqual(origin.sourceReferences, sourceReferences(origin.source?.transport || {})) || origin.sourceReferenceHash !== digest(origin.sourceReferences) || origin.sourceReferenceStatus !== "source-unverified") throw new Error("The preserved source IRN and transport references changed");
  return structuredClone(origin.postings);
}
export function assertTallyGstPosting(company, voucher) {
  const origin = voucher.gst?.tallyOrigin;
  if (!origin) return;
  if ([3, 4].includes(origin.version) && (voucher.type !== origin.originalPostingType || voucher.source?.originalType !== origin.source?.sourceVoucherType)) throw new Error("The source note accounting voucher type changed");
  if (voucher.source?.system !== "tally" || voucher.source.recordId !== origin.recordId || voucher.source.originalNumber !== origin.originalInvoiceNumber || voucher.number !== origin.internalVoucherNumber || !hashPattern.test(origin.sourceHash || "") || !hashPattern.test(origin.recordHash || "") || !isDeepStrictEqual(tallyGstPostingLines(voucher.gst), voucher.lines)) throw new Error("The source GST invoice differs from its original posting");
  if (origin.version === 4) { assertTallyServiceLedgerGroups(company, voucher); assertTallyGstStockLink(company, voucher); return; }
  const purchase = voucher.gst.direction === "purchase";
  for (const [role, ledgerId] of Object.entries(origin.accounts)) {
    const group = role === "party" ? purchase ? "g-creditors" : "g-debtors" : role === "sales" ? "g-sales" : role === "purchase" ? "g-purchase" : "g-duties";
    const nonTaxAsset = ["g-bank", "g-cash", "g-deposits", "g-advances", "g-stock", "g-debtors"].some(id => inGroup(company, ledgerId, id));
    const matches = inGroup(company, ledgerId, group) || purchase && GST_COMPONENTS.includes(role) && inGroup(company, ledgerId, "g-current-assets") && !nonTaxAsset;
    if (!invoiceRoles(voucher.gst).includes(role) || !matches) throw new Error(`Reviewed source ${role} ledger has the wrong account group`);
  }
  assertTallyGstStockLink(company, voucher);
}
export function assertTallyGstStockLink(company, voucher) {
  const invoice = voucher.gst, origin = invoice?.tallyOrigin;
  if (!origin) return null;
  if (origin.version === 4) return assertTallyServiceStockLink(company, voucher);
  if (origin.version === 3) return assertTallyGstNoteStockLink(company, voucher);
  if (origin.stockMode === "report-only") {
    if (invoice.stockEffect !== "none" || origin.stockJournalId !== null || origin.stockJournalHash !== null || !Array.isArray(origin.stockLineMap) || origin.stockLineMap.length || company.stock?.journals?.some(journal => journal.accountingVoucherId === voucher.id) || !origin.source?.items?.length || origin.source.items.some(item => item.actualQuantity !== null) || company.stock?.tally?.hasSourceGaps !== true) throw new Error("GST reporting-only promotion must retain the unresolved source stock quantity and cannot hide an existing movement");
    return null;
  }
  if (origin.stockMode !== "source") throw new Error("Choose the reviewed source stock basis");
  const purchase = invoice.direction === "purchase";
  const journal = company.stock?.journals?.find(row => row.id === origin.stockJournalId);
  if (!journal || journal.type !== (purchase ? "receipt" : "issue") || journal.financialKind !== (purchase ? "purchase" : "sale") || journal.sourceRef !== origin.recordId || journal.accountingVoucherId !== voucher.id || journal.date !== voucher.date || journal.number !== origin.originalInvoiceNumber || company.stock.journals.filter(row => row.accountingVoucherId === voucher.id).length !== 1 || stockHash(journal) !== origin.stockJournalHash || !Array.isArray(origin.stockLineMap) || origin.stockLineMap.length !== journal.lines.length || invoice.stockEffect !== "quantity") throw new Error("Promoted GST invoice needs its unchanged original stock movement");
  const mapped = invoice.items.map(() => ({ q: 0n, b: 0n, v: 0n }));
  journal.lines.forEach((line, index) => {
    const target = origin.stockLineMap[index], item = invoice.items[target];
    const sourceValue = purchase ? line.valuePaise : line.revenuePaise;
    if (!Number.isSafeInteger(target) || !item || item.kind !== "goods" || item.itemId !== line.itemId || !Number.isSafeInteger(sourceValue) || sourceValue < 0 || purchase && line.revenuePaise !== undefined) throw new Error("Source stock lines do not match the reviewed GST items");
    mapped[target].q += quantityMicros(line.quantity); mapped[target].b += quantityMicros(line.billedQuantity || line.quantity); mapped[target].v += BigInt(sourceValue);
  });
  mapped.forEach((entry, index) => {
    if (!origin.source?.items?.[index]?.actualQuantity || entry.q !== quantityMicros(origin.source.items[index].actualQuantity) || entry.b !== quantityMicros(invoice.items[index].quantity) || entry.v !== BigInt(invoice.items[index].taxablePaise)) throw new Error("Original actual/billed stock quantities and values do not reconcile to each reviewed GST invoice line");
  });
  return journal;
}

function normalizeMapping(input) {
  const noteReview = input.noteReview === undefined ? undefined : normalizeTallyNoteReview(input.noteReview);
  const serviceItems = input.serviceItems === undefined ? undefined : normalizeTallyServiceMappings(input.serviceItems);
  if (!Array.isArray(input.items) || !input.items.length && !noteReview && serviceItems === undefined || input.items.length > 500 || new Set(input.items.map(item => key(item.sourceName))).size !== input.items.length) throw new Error("Map every unique source item name once");
  const accounts = {};
  for (const role of roles) if (input.accounts?.[role]) accounts[role] = requireText(input.accounts[role], `${role} posting ledger`, 48);
  if (Object.keys(input.accounts || {}).some(role => !roles.includes(role)) || new Set(Object.values(accounts)).size !== Object.values(accounts).length) throw new Error("Each reviewed source posting ledger must have one distinct GST role");
  const stockMode = noteReview ? noteReview.stockEffect === "none" ? "financial-only" : "source" : input.stockMode || "source";
  if (!(["source", "report-only"].includes(stockMode) || (noteReview || serviceItems !== undefined) && stockMode === "financial-only")) throw new Error("Choose source stock or GST reporting only");
  const sourceCorrections = {};
  if (input.sourceCorrections !== undefined && (!input.sourceCorrections || typeof input.sourceCorrections !== "object" || Array.isArray(input.sourceCorrections))) throw new Error("Source corrections need a reason for each reviewed field");
  const allowed = new Set([...(serviceItems || []).flatMap(row => ["hsnSac", "gstRateBps", "supplyType", "taxability"].map(field => `service:${row.sourceLineId}:${field}`)), "sellerGstin", "buyerGstin", "supplierInvoiceNumber", "supplierInvoiceDate", "supplierNoteNumber", "supplierNoteDate", "originalNumber", "originalDate", "placeOfSupply", ...input.items.flatMap(item => ["hsnSac", "gstRateBps", "supplyType", "taxability"].map(field => `item:${item.sourceName}:${field}`))]);
  for (const field of Object.keys(input.sourceCorrections || {}).sort()) { if (!allowed.has(field)) throw new Error("A source correction references an unmapped GST field"); sourceCorrections[field] = requireText(input.sourceCorrections[field], "source correction reason", 500); }
  let purchaseReview;
  if (input.purchaseReview !== undefined) {
    const review = input.purchaseReview;
    if (!review || typeof review !== "object" || Array.isArray(review) || Object.keys(review).some(field => !["itcEligibility", "supplierInvoiceNumber", "supplierInvoiceDate", "receivedDate", "placeOfSupply"].includes(field))) throw new Error("Enter the supported purchase document and receipt review fields");
    if (review.itcEligibility !== undefined && review.itcEligibility !== "pending") throw new Error("Imported purchases start with pending ITC; review eligibility and claims in the dated ITC desk");
    purchaseReview = {};
    for (const field of ["supplierInvoiceNumber", "supplierInvoiceDate", "receivedDate"]) if (review[field]) {
      purchaseReview[field] = requireText(review[field], field, field === "supplierInvoiceNumber" ? 16 : 10);
      if (field !== "supplierInvoiceNumber" && !isIsoDate(purchaseReview[field])) throw new Error("Enter a valid reviewed supplier invoice and receipt date");
    }
    if (review.placeOfSupply) purchaseReview.placeOfSupply = state(requireText(review.placeOfSupply, "reviewed place of supply", 60));
    if (review.itcEligibility !== undefined) purchaseReview.itcEligibility = "pending";
  }
  return { recordId: requireText(input.recordId, "source record", 48), registrationId: requireText(input.registrationId, "GST registration", 48), partyId: requireText(input.partyId, "GST party", 48), items: input.items.map(item => ({ sourceName: requireText(item.sourceName, "source item name", 120), itemId: requireText(item.itemId, "GST item", 48) })), accounts, stockMode, ...(serviceItems !== undefined ? { serviceItems } : {}), ...(noteReview ? { noteReview } : {}), ...(purchaseReview ? { purchaseReview } : {}), ...(Object.keys(sourceCorrections).length ? { sourceCorrections } : {}), evidence: { name: requireText(input.evidence?.name, "supporting evidence name", 120), reference: requireText(input.evidence?.reference, "supporting evidence reference", 500) } };
}
function buildPromotion(company, vouchers, records, record, mapping, hash, context = promotionContext(company, vouchers, records)) {
  const voucher = context.vouchers.get(record.voucherId);
  if (isTallyNote(voucher)) return buildTallyGstNotePromotion(company, vouchers, records, record, mapping, hash, context);
  if (mapping.noteReview) throw new Error("Note review cannot be applied to an ordinary invoice");
  const registration = context.registrations.get(mapping.registrationId);
  const source = sourceInvoice(company, voucher, record, context, registration?.stateCode, Boolean(mapping.sourceCorrections?.sellerGstin), mapping);
  if (source.serviceReview) return buildTallyGstServicePromotion(company, vouchers, records, record, mapping, hash, context, source);
  if (mapping.serviceItems?.length) throw new Error("The selected service rows are absent from the preserved source");
  const purchase = voucher.type === "Purchase";
  const party = context.parties.get(mapping.partyId), taxFactReview = [];
  if (!party || (purchase ? party.supplierLedgerId : party.customerLedgerId) !== source.partyLedgerId || mapping.accounts.party !== source.partyLedgerId) throw new Error(purchase ? "The reviewed GST supplier must link to the original creditor ledger" : "The reviewed GST party must link to the original debtor ledger");
  if ((source.gstin || (purchase ? source.taxFacts.sellerGstin : source.taxFacts.buyerGstin).status === "supplied") && !party.gstin) throw new Error("A source registered counterparty cannot be silently changed to an unregistered party");
  if (!registration) throw new Error("Choose a GST registration");
  if (purchase && (!source.sourceInvoiceNumber || !source.sourceInvoiceDate)) throw new Error("Review the supplier invoice number and supplier invoice date from REFERENCE/REFERENCEDATE or named document evidence; the accounting voucher number and date do not establish them");
  if (purchase && !source.placeOfSupply) throw new Error("Review an explicit purchase place of supply; the supplier state does not establish the goods destination");
  if (!purchase && mapping.purchaseReview) throw new Error("Purchase document review cannot be applied to a Sales invoice");
  chooseFact(source.taxFacts.sellerGstin, purchase ? party.gstin : registration.gstin, "sellerGstin", mapping, taxFactReview, false);
  chooseFact(source.taxFacts.buyerGstin, purchase ? registration.gstin : party.gstin, "buyerGstin", mapping, taxFactReview, false);
  const journal = context.stockJournals.get(voucher.id);
  if (mapping.stockMode === "report-only") {
    if (journal || source.items.some(item => item.actualQuantity !== null)) throw new Error("GST reporting only applies when physical quantities are unresolved and no source stock movement is active");
  } else if (!journal || source.items.some(item => item.actualQuantity === null)) throw new Error("Review the original physical quantities and activate the source stock projection, or select GST reporting only while quantities are unresolved");
  const unique = [...new Set(source.items.map(item => item.sourceName))];
  if (mapping.items.length !== unique.length || unique.some(name => !mapping.items.some(item => key(item.sourceName) === key(name)))) throw new Error("Map all source items exactly once without unrelated mappings");
  const itemOverrides = new Map();
  const items = source.items.map((row, index) => {
    const selected = mapping.items.find(item => key(item.sourceName) === key(row.sourceName));
    const item = context.gstItems.get(selected.itemId);
    const original = context.stockItems.get(selected.itemId);
    if (!item || item.kind !== "goods" || !original || item.stockItemId !== original.id || key(item.name) !== key(row.sourceName) || key(item.unit) !== key(row.unit)) throw new Error(`Enrich source stock item ${row.sourceName} with its confirmed HSN, unit and tax rate`);
    const facts = source.taxFacts.items[index], prefix = `item:${row.sourceName}:`;
    const hsnSac = chooseFact(facts.hsnSac, item.hsnSac, prefix + "hsnSac", mapping, taxFactReview);
    const gstRateBps = chooseFact(facts.gstRateBps, item.gstRateBps, prefix + "gstRateBps", mapping, taxFactReview);
    const kind = chooseFact(facts.supplyType, item.kind, prefix + "supplyType", mapping, taxFactReview);
    const supplyStatus = chooseFact(facts.taxability, item.supplyStatus, prefix + "taxability", mapping, taxFactReview);
    if (kind !== "goods" || supplyStatus !== "taxable" || item.cessRateBps) throw new Error("This source promotion supports domestic forward taxable goods without cess");
    if (purchase && itemOverrides.has(item.id) && itemOverrides.get(item.id).hsnSac !== hsnSac) throw new Error("Repeated source item lines have different HSN classifications; review distinct source item identities before promotion");
    itemOverrides.set(item.id, { ...item, hsnSac, gstRateBps, kind, supplyStatus });
    return { itemId: item.id, quantity: row.quantity, unitPricePaise: row.unitPricePaise, discountBps: purchase ? row.discountBps : 0, gstRateBps, supplyStatus };
  });
  const invoiceCompany = { ...company, gst: { ...company.gst, items: company.gst.items.map(item => itemOverrides.get(item.id) || item) } };
  if (!(purchase ? source.sourceVoucherNumber : source.sourceInvoiceNumber) || (purchase ? source.sourceVoucherNumber : source.sourceInvoiceNumber) !== voucher.source?.originalNumber) throw new Error("The source statutory invoice number is absent or differs from the original voucher linkage");
  const invoice = buildGstInvoice(invoiceCompany, vouchers.filter(row => row.id !== voucher.id), { type: voucher.type, registrationId: mapping.registrationId, partyId: mapping.partyId, number: purchase ? voucher.number : source.sourceInvoiceNumber, ...(purchase ? { supplierInvoiceNumber: source.sourceInvoiceNumber, supplierInvoiceDate: source.sourceInvoiceDate, itcEligibility: "pending" } : {}), date: voucher.date, narration: voucher.narration, placeOfSupply: source.placeOfSupply, pricing: "exclusive", stockEffect: mapping.stockMode === "report-only" ? "none" : "quantity", items }, voucher.id);
  invoice.number = purchase ? voucher.number : source.sourceInvoiceNumber;
  if (purchase) invoice.receivedDate = source.receivedDate;
  invoice.items.forEach((line, index) => { if (line.taxablePaise !== source.items[index].valuePaise) throw new Error(`Source item ${index + 1} value does not equal quantity × reviewed unit price`); });
  source.taxablePaise = invoice.totals.taxablePaise;
  source.taxPaise = invoice.totals.taxPaise;
  source.classification = "reviewed";
  for (const component of GST_COMPONENTS) if (source.taxes[`${component}Paise`] && source.taxes[`${component}Paise`] !== invoice.totals[`${component}Paise`]) throw new Error(`Identifiable source ${component.toUpperCase()} does not reconcile to the reviewed invoice`);
  source.unresolvedAdjustmentsPaise = source.totalPaise - source.taxablePaise - source.taxPaise;
  const postingRoles = voucher.lines.map(line => {
    const role = invoiceRoles(invoice).find(role => mapping.accounts[role] === line.ledgerId);
    if (!role) throw new Error(`Assign every source posting a GST role: ${context.ledgers.get(line.ledgerId)?.name || line.ledgerId}`);
    const ledgerName = context.ledgers.get(line.ledgerId)?.name || "";
    const statedHead = GST_COMPONENTS.find(head => new RegExp(`\\b${head}\\b`, "i").test(ledgerName));
    if (statedHead && role !== statedHead || purchase && GST_COMPONENTS.includes(role) && /\boutput\b/i.test(ledgerName)) throw new Error(`Source ${ledgerName} cannot be mapped to ${role}`);
    return role;
  });
  let purchaseLineIndex = 0, allocatedQuantity = 0n;
  const stockLineMap = (journal?.lines || []).map(line => {
    if (purchase) {
      // The preserved projection emits each source inventory entry and its
      // godown splits in document order. Retain that order for repeated items.
      const item = invoice.items[purchaseLineIndex];
      if (!item || item.itemId !== line.itemId) throw new Error("Source receipt lines do not retain their original inventory entry order");
      const target = purchaseLineIndex;
      allocatedQuantity += quantityMicros(line.quantity);
      const actual = quantityMicros(source.items[target].actualQuantity);
      if (allocatedQuantity > actual) throw new Error("Source receipt splits exceed the original item quantity");
      if (allocatedQuantity === actual) { purchaseLineIndex++; allocatedQuantity = 0n; }
      return target;
    }
    const matches = invoice.items.flatMap((item, index) => item.itemId === line.itemId ? [index] : []);
    if (matches.length !== 1) throw new Error("Repeated source item lines require an explicit stock-to-GST line allocation");
    return matches[0];
  });
  const references = sourceReferences(source.transport);
  invoice.tallyOrigin = { version: purchase ? 2 : 1, recordId: record.recordId, sourceHash: hash, recordHash: nodeHash(record), originalInvoiceNumber: purchase ? source.sourceVoucherNumber : source.sourceInvoiceNumber, internalVoucherNumber: voucher.number, postingHash: postingHash(voucher), postings: structuredClone(voucher.lines), postingRoles, accounts: structuredClone(mapping.accounts), mappingHash: digest(mapping), evidence: structuredClone(mapping.evidence), source: structuredClone(source), taxFactReview, sourceReferences: references, sourceReferenceHash: digest(references), sourceReferenceStatus: "source-unverified", stockMode: mapping.stockMode, stockJournalId: journal?.id || null, stockJournalHash: journal ? stockHash(journal) : null, stockLineMap };
  const promoted = { ...voucher, gst: invoice };
  assertGstSnapshot(company, promoted);
  assertTallyGstPosting(company, promoted);
  const discrepancies = [];
  if (purchase) {
    for (const [field, supplied, chosen] of [["supplierInvoiceNumber", source.supplierDocument.sourceNumber, source.sourceInvoiceNumber], ["supplierInvoiceDate", source.supplierDocument.sourceDate, source.sourceInvoiceDate]]) {
      if (!supplied) discrepancies.push({ code: "source-document-fact-absent", message: `${field}: supplied by the named purchase document review`, sourceValue: "", mappedValue: chosen });
      else if (supplied !== chosen) discrepancies.push({ code: "source-document-fact-corrected", message: `${field}: corrected by explicit review: ${mapping.sourceCorrections[field]}`, sourceValue: supplied, mappedValue: chosen });
    }
    if (!source.placeOfSupplyEvidence.sourceValue) discrepancies.push({ code: "source-place-of-supply-absent", message: "Place of supply: supplied by the named purchase document review", sourceValue: "", mappedValue: source.placeOfSupply });
    else if (mapping.sourceCorrections?.placeOfSupply) discrepancies.push({ code: "source-place-of-supply-corrected", message: `Place of supply: corrected by explicit review: ${mapping.sourceCorrections.placeOfSupply}`, sourceValue: source.placeOfSupplyEvidence.sourceValue, mappedValue: source.placeOfSupply });
    if (!source.receivedDate) discrepancies.push({ code: "purchase-receipt-date-unreviewed", message: "Physical receipt date remains unreviewed; the preserved stock movement uses its original accounting date", sourceValue: "", mappedValue: "" });
  }
  for (const fact of taxFactReview) {
    if (fact.status === "absent") discrepancies.push({ code: "source-tax-fact-absent", message: `${fact.field}: no applicable source fact; supplied by the reviewed local mapping`, sourceValue: "", mappedValue: fact.chosenValue });
    else if (fact.status === "corrected") discrepancies.push({ code: "source-tax-fact-corrected", message: `${fact.field}: source discrepancy corrected by explicit review: ${fact.reason}`, sourceValue: fact.sourceValue, mappedValue: fact.chosenValue });
    if (fact.superseded.some(proof => proof.reason === "invoice-override")) discrepancies.push({ code: "source-invoice-override", message: `${fact.field}: document-specific source overrides supporting master facts`, sourceValue: fact.sourceValue, mappedValue: fact.chosenValue });
  }
  for (const item of source.items) if (item.actualQuantity !== item.quantity) discrepancies.push({ code: "stock-billed-quantity-difference", message: item.actualQuantity === null ? `${item.sourceName}: GST/HSN uses billed quantity ${item.quantity}; physical quantity is unresolved and no inventory movement is created` : `${item.sourceName}: GST/HSN uses billed quantity ${item.quantity}; inventory uses actual quantity ${item.actualQuantity}. Linked physical returns remain bounded by both the billed entitlement and the original physical quantity`, sourceValue: item.actualQuantity || "unresolved", mappedValue: item.quantity });
  for (const [field, text] of Object.entries(references).filter(([field, text]) => text && ["irn", "acknowledgementNumber", "ewayBillNumber"].includes(field))) {
    const count = context.references.get(`${field}:${text}`) || 0;
    if (count > 1) discrepancies.push({ code: "duplicate-source-reference", message: `The source repeats ${field} across ${count} vouchers. It remains an unverified source reference`, sourceValue: text, mappedValue: "source-unverified" });
  }
  invoice.tallyOrigin.discrepancies = structuredClone(discrepancies);
  return { promoted, source, discrepancies };
}

export function planTallyGstPromotion(company, vouchers, records, context = promotionContext(company, vouchers, records)) {
  const meta = section(company), hash = sourceHash(records);
  const mappings = new Map(meta.mappings.map(item => [item.recordId, item.mapping]));
  const rows = records.filter(record => record.type === "VOUCHER" && record.disposition !== "duplicate-source" && ["sales", "purchase", "credit note", "debit note"].includes(key(invoiceSourceType(record, context.vouchers.get(record.voucherId))))).map(record => {
    const voucher = context.vouchers.get(record.voucherId), mapping = mappings.get(record.recordId) || null;
    const row = { type: invoiceSourceType(record, voucher), recordId: record.recordId, voucherId: voucher?.id || record.voucherId || "", number: voucher?.number || value(record.node, "VOUCHERNUMBER"), sourceNumber: value(record.node, "VOUCHERNUMBER"), date: voucher?.date || "", status: "blocked", source: null, mapping, blockers: [], discrepancies: [] };
    try {
      if (voucher?.gst?.tallyOrigin) { assertTallyGstPosting(company, voucher); row.source = voucher.gst.tallyOrigin.source; row.suggestions = suggestions(row.source, context); row.discrepancies = structuredClone(voucher.gst.tallyOrigin.discrepancies || []); row.status = "active"; return row; }
      if (voucher?.gst) throw new Error("This voucher already has an independently linked GST invoice");
      row.source = sourceInvoice(company, voucher, record, context, context.registrations.get(mapping?.registrationId)?.stateCode, Boolean(mapping?.sourceCorrections?.sellerGstin), mapping || {});
      row.suggestions = suggestions(row.source, context);
      if (!mapping && row.source.serviceCandidates?.length && !row.source.items.length) throw new Error("Source invoice has no classified goods or service item lines. Unconfirmed service candidates need explicit classification and named evidence that reconciles to the source amounts; otherwise keep this voucher accounting-only");
      if (!mapping && isTallyNote(voucher)) throw new Error("Review the note direction, verified original invoice, original HSN/rate allocations and explicit stock treatment with named evidence");
      if (!mapping) throw new Error(voucher.type === "Purchase" ? "Review the buyer registration, supplier creditor ledger and document dates, every item HSN/rate and each debit/credit posting role with named supporting evidence" : "Review the seller registration, original party ledger, every item HSN/rate and every posting role with named supporting evidence");
      const built = buildPromotion(company, vouchers, records, record, mapping, hash, context);
      row.source = built.source; row.discrepancies = built.discrepancies; row.status = "ready";
    } catch (error) { row.blockers.push({ code: "tally-gst-review-required", message: error.message }); }
    return row;
  });
  const summary = { sourceInvoices: rows.length, ready: rows.filter(row => row.status === "ready").length, blocked: rows.filter(row => row.status === "blocked").length, active: rows.filter(row => row.status === "active").length,
    totalPaise: sum(rows.map(row => row.source?.totalPaise || 0)), sourceItemValuePaise: sum(rows.map(row => row.source?.itemValuePaise || 0)), taxablePaise: sum(rows.map(row => row.source?.taxablePaise || 0)), taxPaise: sum(rows.map(row => row.source?.taxPaise || 0)) };
  const reviewHash = digest({ sourceHash: hash, meta, gst: company.gst, ledgers: company.ledgers, stock: company.stock, vouchers });
  const originalInvoiceCount = vouchers.filter(row => ["Sales", "Purchase"].includes(row.gst?.type)).length;
  return { revision: meta.revision, sourceHash: hash, reviewHash, rows, summary, originalInvoices: [], originalInvoiceCount, registrations: structuredClone(company.gst?.registrations || []), parties: structuredClone(company.gst?.parties || []), items: structuredClone(company.gst?.items || []), ledgers: company.ledgers.map(({ id, name, groupId }) => ({ id, name, groupId })), sourceStockItems: structuredClone(company.stock?.masters || []), states: GST_STATES };
}


function originalInvoiceDescriptor(invoice, includeItems = false) {
  const party = invoice.party, registration = invoice.registration;
  const descriptor = {
    id: invoice.id, type: invoice.type, direction: invoice.direction, number: invoice.number, date: invoice.date,
    registrationId: invoice.registrationId, partyId: invoice.partyId,
    party: { id: party.id, name: party.name, gstin: party.gstin, customerLedgerId: party.customerLedgerId, supplierLedgerId: party.supplierLedgerId },
    registration: { id: registration.id, name: registration.name, gstin: registration.gstin },
    issuer: { name: invoice.direction === "purchase" ? party.name : registration.name, gstin: invoice.direction === "purchase" ? party.gstin : registration.gstin },
    supplierInvoiceNumber: invoice.supplierInvoiceNumber || "", supplierInvoiceDate: invoice.supplierInvoiceDate || "",
    stockEffect: invoice.stockEffect, lineCount: invoice.items.length,
    totals: Object.fromEntries(["taxablePaise", ...GST_COMPONENTS.map(head => `${head}Paise`), "taxPaise", "totalPaise"].map(field => [field, invoice.totals[field]])),
  };
  if (includeItems) {
    const fields = ["itemId", "name", "kind", "hsnSac", "unit", "quantity", "unitPricePaise", "discountBps", "gstRateBps", "cessRateBps", "supplyStatus", "taxablePaise", ...GST_COMPONENTS.map(head => `${head}Paise`), "taxPaise", "totalPaise"];
    descriptor.items = invoice.items.map(line => Object.fromEntries(fields.map(field => [field, line[field]])));
  }
  return descriptor;
}

// Catalog reads are bounded and descriptive. The selected original is fully
// validated against its actual saved snapshot during mapping activation.
export function tallyGstOriginalInvoicePage(vouchers, input = {}) {
  const q = String(input.q || "").trim().toLocaleLowerCase("en-IN");
  const requested = String(input.offset || "0");
  if (q.length > 200 || !/^\d{1,12}$/.test(requested) || input.direction && !["sales", "purchase"].includes(input.direction)) throw new Error("Choose a valid original invoice search and page");
  for (const field of ["partyId", "registrationId", "partyLedgerId", "selected"]) if (input[field] && (typeof input[field] !== "string" || !/^[a-z0-9-]{1,48}$/.test(input[field]))) throw new Error("Choose valid original invoice filters");
  const eligible = vouchers.map(row => row.gst).filter(invoice => {
    if (!invoice || !["Sales", "Purchase"].includes(invoice.type) || invoice.reverseCharge || invoice.supplyCategory !== "domestic" || !invoice.party || !invoice.registration || !Array.isArray(invoice.items)) return false;
    if (input.direction && invoice.direction !== input.direction || input.partyId && invoice.partyId !== input.partyId || input.registrationId && invoice.registrationId !== input.registrationId) return false;
    const ledgerId = invoice.direction === "purchase" ? invoice.party.supplierLedgerId : invoice.party.customerLedgerId;
    return !input.partyLedgerId || ledgerId === input.partyLedgerId;
  });
  const selected = input.selected ? eligible.find(invoice => invoice.id === input.selected) : null;
  const words = q.split(/\s+/).filter(Boolean);
  const matches = eligible.filter(invoice => {
    const searchable = [invoice.number, invoice.date, invoice.supplierInvoiceNumber, invoice.supplierInvoiceDate, invoice.party.name, invoice.party.gstin, invoice.registration.gstin].filter(Boolean).join(" ").toLocaleLowerCase("en-IN");
    return words.every(word => searchable.includes(word));
  }).sort((a, b) => b.date.localeCompare(a.date) || a.number.localeCompare(b.number) || a.id.localeCompare(b.id));
  const limit = 20, offset = Math.min(Number(requested), Math.max(0, Math.floor((matches.length - 1) / limit) * limit));
  return { rows: matches.slice(offset, offset + limit).map(invoice => originalInvoiceDescriptor(invoice)), page: { offset, limit, total: matches.length }, selectedInvoice: selected ? originalInvoiceDescriptor(selected, true) : null };
}

function priorRequest(meta, input, requestHash) {
  if (!requestPattern.test(input.requestId || "")) throw new Error("Source GST review needs a valid save identifier");
  const prior = meta.audit.find(item => item.requestId === input.requestId);
  if (prior && prior.requestHash !== requestHash) throw new Error("This source GST save identifier belongs to a different request");
  return prior;
}
function finish(company, vouchers, meta, input, requestHash, action, result, records) {
  meta.revision++;
  meta.audit.push({ requestId: input.requestId, requestHash, action, at: new Date().toISOString(), result: structuredClone(result) });
  company.gst.tallyPromotion = meta;
  assertTallyGstBook(company, vouchers);
  return { company, vouchers, result, replayed: false, report: planTallyGstPromotion(company, vouchers, records) };
}
export function saveTallyGstMapping(current, sourceVouchers, records, input) {
  const company = structuredClone(current), vouchers = structuredClone(sourceVouchers), meta = section(company), mapping = normalizeMapping(input);
  const requestHash = digest({ action: "mapping", mapping }), prior = priorRequest(meta, input, requestHash);
  if (prior) return { company, vouchers, result: prior.result, replayed: true, report: planTallyGstPromotion(company, vouchers, records) };
  if (input.revision !== meta.revision) throw new Error("The source GST review changed; reload before saving this mapping");
  const record = records.find(record => record.recordId === input.recordId && record.type === "VOUCHER" && record.disposition !== "duplicate-source");
  if (!record) throw new Error("Choose an original source invoice");
  if (vouchers.some(voucher => voucher.source?.recordId === record.recordId && voucher.gst)) throw new Error("An activated source invoice keeps its reviewed mapping and evidence");
  if (!company.gst?.registrations.some(item => item.id === mapping.registrationId) || !company.gst?.parties.some(item => item.id === mapping.partyId) || [...mapping.items, ...(mapping.serviceItems || [])].some(row => !company.gst.items.some(item => item.id === row.itemId))) throw new Error("Choose existing local GST masters for this mapping");
  if (mapping.noteReview) {
    const original = vouchers.find(row => row.gst?.id === mapping.noteReview.originalInvoiceId);
    if (!original || !["Sales", "Purchase"].includes(original.gst.type) || original.gst.reverseCharge || original.gst.supplyCategory !== "domestic") throw new Error("Choose a saved regular domestic original GST invoice");
    assertGstSnapshot(company, original);
  }
  meta.mappings.push({ id: `tgm-${digest([input.requestId, mapping]).slice(0, 20)}`, recordId: record.recordId, sourceHash: sourceHash(records), recordHash: nodeHash(record), at: new Date().toISOString(), mapping });
  return finish(company, vouchers, meta, input, requestHash, "mapping", { recordId: record.recordId, mappingSaved: true }, records);
}
export function activateTallyGstPromotion(current, sourceVouchers, records, input) {
  const company = structuredClone(current), vouchers = structuredClone(sourceVouchers), meta = section(company);
  if (!Array.isArray(input.recordIds) || !input.recordIds.length || input.recordIds.length > 10000 || new Set(input.recordIds).size !== input.recordIds.length) throw new Error("Select distinct reviewed source invoices to activate");
  const requestHash = digest({ action: "activate", recordIds: [...input.recordIds].sort() }), prior = priorRequest(meta, input, requestHash);
  if (prior) return { company, vouchers, result: prior.result, replayed: true, report: planTallyGstPromotion(company, vouchers, records) };
  const context = promotionContext(company, vouchers, records), plan = planTallyGstPromotion(company, vouchers, records, context), rows = new Map(plan.rows.map(row => [row.recordId, row]));
  if (input.revision !== meta.revision || input.reviewHash !== plan.reviewHash) throw new Error("The imported books or GST masters changed after this review; review them again");
  const targets = [];
  for (const id of input.recordIds) {
    const row = rows.get(id);
    if (!row || !["ready", "active"].includes(row.status)) throw new Error(row?.blockers[0]?.message || "Selected source invoice is not ready for GST activation");
    if (row.status === "active") continue;
    const record = context.records.get(id), built = buildPromotion(company, vouchers, records, record, row.mapping, plan.sourceHash, context);
    if (built.stockJournal) {
      if (company.stock?.journals?.some(row => row.id === built.stockJournal.id || row.accountingVoucherId === built.promoted.id)) throw new Error("A reviewed note cannot create a second stock movement");
      company.stock.journals.push(built.stockJournal);
      context.stockJournals.set(built.promoted.id, built.stockJournal);
    }
    const index = vouchers.findIndex(voucher => voucher.id === built.promoted.id);
    vouchers[index] = built.promoted;
    context.vouchers.set(built.promoted.id, built.promoted);
    targets.push({ recordId: id, voucherId: built.promoted.id, mappingHash: digest(row.mapping), postingHash: postingHash(built.promoted), invoiceHash: digest(built.promoted.gst), discrepancies: built.discrepancies });
  }
  const result = { activated: targets.length, alreadyActive: input.recordIds.length - targets.length, recordIds: targets.map(item => item.recordId) };
  meta.activations.push({ id: `tga-${digest(input.requestId).slice(0, 20)}`, sourceHash: plan.sourceHash, at: new Date().toISOString(), targets });
  return finish(company, vouchers, meta, input, requestHash, "activate", result, records);
}

export function assertTallyGstBook(company, vouchers) {
  const meta = company.gst?.tallyPromotion, promoted = vouchers.filter(voucher => voucher.gst?.tallyOrigin);
  if (!meta) { if (promoted.length) throw new Error("Source GST invoices require their mapping and activation history"); return; }
  if (meta.version !== 1 || !Number.isSafeInteger(meta.revision) || meta.revision < 0 || !Array.isArray(meta.mappings) || !Array.isArray(meta.activations) || !Array.isArray(meta.audit) || meta.revision !== meta.audit.length || new Set(meta.audit.map(item => item.requestId)).size !== meta.audit.length) throw new Error("Invalid source GST promotion history");
  assertUniqueGstDocuments(vouchers);
  for (const item of meta.mappings) if (!item || item.recordId !== item.mapping?.recordId || !hashPattern.test(item.sourceHash || "") || !hashPattern.test(item.recordHash || "") || !isDeepStrictEqual(normalizeMapping(item.mapping), item.mapping)) throw new Error("Invalid preserved source GST mapping");
  const targets = new Map();
  for (const event of meta.activations) {
    if (!hashPattern.test(event.sourceHash || "") || !Array.isArray(event.targets)) throw new Error("Invalid source GST activation event");
    for (const target of event.targets) { if (targets.has(target.voucherId)) throw new Error("A source GST invoice was activated more than once"); targets.set(target.voucherId, { target, event }); }
  }
  if (targets.size !== promoted.length) throw new Error("A promoted source GST invoice or activation event is missing");
  for (const voucher of promoted) {
    const original = voucher.gst.tallyOrigin, activation = targets.get(voucher.id), mapping = meta.mappings.find(item => item.recordId === original.recordId && digest(item.mapping) === original.mappingHash);
    const mappedAccounts = original.version === 4 ? Object.fromEntries(Object.entries(original.accounts).filter(([role]) => !role.startsWith("service:"))) : original.accounts;
    if (!activation || !mapping || activation.target.recordId !== original.recordId || activation.event.sourceHash !== original.sourceHash || mapping.sourceHash !== original.sourceHash || mapping.recordHash !== original.recordHash || activation.target.mappingHash !== original.mappingHash || activation.target.postingHash !== postingHash(voucher) || activation.target.invoiceHash !== digest(voucher.gst) || !isDeepStrictEqual(mapping.mapping.accounts, mappedAccounts) || !isDeepStrictEqual(mapping.mapping.evidence, original.evidence) || !isDeepStrictEqual(mapping.mapping.noteReview, original.noteReview) || !isDeepStrictEqual(activation.target.discrepancies, original.discrepancies)) throw new Error("Preserved source GST mapping, invoice or activation evidence changed");
    assertTallyGstPosting(company, voucher);
    if (original.version === 4) assertTallyServiceMapping(mapping.mapping, voucher.gst);
    assertTallyGstNoteFamily(vouchers, voucher);
  }
}
export function assertTallyGstOrigins(company, vouchers, records) {
  assertTallyGstBook(company, vouchers);
  const hash = sourceHash(records), context = promotionContext(company, vouchers, records);
  const mappingHashes = new Map((company.gst?.tallyPromotion?.mappings || []).map(item => [digest(item.mapping), item.mapping]));
  for (const mapping of company.gst?.tallyPromotion?.mappings || []) {
    const record = context.records.get(mapping.recordId);
    if (!record || mapping.sourceHash !== hash || mapping.recordHash !== nodeHash(record)) throw new Error("Source GST mapping differs from the preserved original records");
  }
  for (const voucher of vouchers.filter(voucher => voucher.gst?.tallyOrigin)) {
    const record = context.records.get(voucher.gst.tallyOrigin.recordId);
    const mapping = mappingHashes.get(voucher.gst.tallyOrigin.mappingHash);
    if (!record || !mapping) throw new Error("Source GST invoice has no original record and reviewed mapping");
    // Dated master edits do not rewrite the invoice snapshot. Rebuild with the original confirmed snapshots.
    const snapshotCompany = structuredClone(company);
    snapshotCompany.gst.registrations = snapshotCompany.gst.registrations.map(item => item.id === voucher.gst.registrationId ? voucher.gst.registration : item);
    snapshotCompany.gst.parties = snapshotCompany.gst.parties.map(item => item.id === voucher.gst.partyId ? voucher.gst.party : item);
    const reviewedFacts = new Map(voucher.gst.tallyOrigin.taxFactReview.map(fact => [fact.field, fact.localMasterValue]));
    const originalItems = new Map(voucher.gst.items.map(line => [line.itemId, line]));
    snapshotCompany.gst.items = snapshotCompany.gst.items.map(item => {
      const line = originalItems.get(item.id);
      if (!line) return item;
      const sourceRow = voucher.gst.tallyOrigin.source.items[voucher.gst.items.findIndex(row => row.itemId === item.id)];
      const prefix = voucher.gst.tallyOrigin.version === 4 && sourceRow.kind === "service" ? `service:${sourceRow.sourceLineId}:` : `item:${line.name}:`;
      return { ...item, ...(voucher.gst.tallyOrigin.version === 4 ? { cessRateBps: line.cessRateBps } : {}), hsnSac: reviewedFacts.get(prefix + "hsnSac"), gstRateBps: reviewedFacts.get(prefix + "gstRateBps"), kind: reviewedFacts.get(prefix + "supplyType"), supplyStatus: reviewedFacts.get(prefix + "taxability") };
    });
    const snapshotContext = { ...context, gstItems: new Map(snapshotCompany.gst.items.map(item => [item.id, item])), parties: new Map(snapshotCompany.gst.parties.map(item => [item.id, item])), registrations: new Map(snapshotCompany.gst.registrations.map(item => [item.id, item])) };
    const expected = buildPromotion(snapshotCompany, vouchers, records, record, mapping, hash, snapshotContext);
    if (!isDeepStrictEqual(expected.promoted.gst, voucher.gst)) throw new Error("Promoted GST invoice differs from its original source and confirmed snapshots");
  }
}
