import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { buildGstInvoice, assertGstSnapshot, GST_COMPONENTS, GST_STATES, quantityMicros, formatQuantity, normalizeGstin } from "./gst.js";
import { attribute, children, findNodes, value } from "./tally-format.js";
import { tallyAmount, tallyDate } from "./tally-values.js";
import { tallyXlsxRows } from "./tally-xlsx.js";
import { tallyGstFactIndex, sourceTaxFacts } from "./tally-gst-facts.js";

export const TALLY_GST_SOURCES = ["https://help.tallysolutions.com/tally-prime/download-sample-excel-files-with-data-for-import/", "https://cbic-gst.gov.in/gst-invoice-rules.html"];
const digest = input => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const key = input => String(input || "").trim().toLocaleLowerCase("en-IN");
const roles = ["party", "sales", "cgst", "sgst", "utgst", "igst", "cess"];
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
  const references = new Map();
  for (const record of records.filter(record => record.type === "VOUCHER" && record.disposition !== "duplicate-source")) {
    const refs = sourceReferences(Object.fromEntries(["IRN", "IRNACKNO", "ACKNO", "EWAYBILLNUMBER"].map(tag => [tag, value(record.node, tag)])));
    for (const [field, text] of Object.entries(refs)) if (text) references.set(`${field}:${text}`, (references.get(`${field}:${text}`) || 0) + 1);
  }
  return { facts: tallyGstFactIndex(records), factCache: new Map(), references, records: new Map(records.map(record => [record.recordId, record])), vouchers: new Map(vouchers.map(voucher => [voucher.id, voucher])), ledgers: new Map(company.ledgers.map(ledger => [ledger.id, ledger])), ledgerNames: new Map(company.ledgers.map(ledger => [key(ledger.name), ledger])), gstItems: new Map((company.gst?.items || []).map(item => [item.id, item])), stockItems: new Map((company.stock?.masters || []).map(item => [item.id, item])), stockNames: new Map((company.stock?.masters || []).map(item => [key(item.name), item])), parties: new Map((company.gst?.parties || []).map(party => [party.id, party])), registrations: new Map((company.gst?.registrations || []).map(registration => [registration.id, registration])), stockJournals: new Map((company.stock?.journals || []).filter(journal => journal.accountingVoucherId).map(journal => [journal.accountingVoucherId, journal])) };
}
function suggestions(source, context) {
  const facts = source.taxFacts, result = { items: [] };
  if (facts.sellerGstin.status === "supplied") result.registration = { gstin: facts.sellerGstin.value, stateCode: facts.sellerGstin.value.slice(0, 2) };
  if (facts.buyerGstin.status === "supplied") result.party = { gstin: facts.buyerGstin.value, stateCode: facts.buyerGstin.value.slice(0, 2) };
  for (const item of facts.items) {
    const row = { sourceName: item.sourceName, stockItemId: context.stockNames.get(key(item.sourceName))?.id };
    if (item.hsnSac.status === "supplied") row.hsnSac = item.hsnSac.value;
    if (item.gstRateBps.status === "supplied") row.gstRateBps = item.gstRateBps.value;
    if (item.supplyType.status === "supplied" && item.supplyType.value === "goods") row.kind = "goods";
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
function sourceInvoice(company, voucher, record, context, registrationState = "", correctedSeller = false) {
  const node = record.node;
  if (record.disposition !== "voucher" || !voucher || voucher.type !== "Sales") throw new Error("Only an imported, posted Sales invoice is supported for GST promotion");
  if (!record.originalPosting || postingHash(record.originalPosting) !== postingHash(voucher)) throw new Error("The source accounting voucher changed after import");
  for (const field of ["ISCANCELLED", "ISOPTIONAL", "ISDELETED", "ISPOSTDATED", "ISREVERSECHARGEAPPLICABLE"]) if (/^(yes|true|1)$/i.test(value(node, field))) throw new Error(`${field} needs its specific GST workflow`);
  const inventory = [...children(node, "ALLINVENTORYENTRIES"), ...children(node, "INVENTORYENTRIES")];
  if (!inventory.length) throw new Error("Source sales invoice has no supported item lines");
  if (["ADDITIONALCOSTDETAILS", "COSTTRACKALLOCATIONS"].some(tag => findNodes(node, tag).length)) throw new Error("Additional inventory allocations require a separate tax and valuation review");
  const items = inventory.map(entry => {
    const sourceName = value(entry, "STOCKITEMNAME"), billed = qty(value(entry, "BILLEDQTY"));
    const actualText = value(entry, "ACTUALQTY") || (record.sourceFormat === "xlsx" && company.tallyWorkbook?.useBilledAsActual === true ? value(entry, "BILLEDQTY") : "");
    const actual = actualText ? qty(actualText) : null;
    if (!sourceName || !billed.unit || actual && key(actual.unit) !== key(billed.unit)) throw new Error("Actual and billed item quantities need one explicit simple unit; alternate units require conversion review");
    const rate = /^(\d+(?:\.\d{1,2})?)\s*(?:\/\s*(.+))?$/.exec(value(entry, "RATE").replace(/,/g, ""));
    if (!rate || rate[2] && key(rate[2]) !== key(billed.unit)) throw new Error(`Item ${sourceName} needs an exact unit rate in its source unit`);
    const amount = tallyAmount(value(entry, "AMOUNT"));
    if (amount <= 0 || /^(yes|true|1)$/i.test(value(entry, "ISDEEMEDPOSITIVE"))) throw new Error("Source sale item amount or direction is unsupported");
    return { sourceName, ...billed, actualQuantity: actual?.quantity || null, actualBasis: value(entry, "ACTUALQTY") ? "source" : actual ? "reviewed-billed" : "unresolved", unitPricePaise: tallyAmount(rate[1]), valuePaise: amount };
  });
  const name = value(node, "PARTYLEDGERNAME");
  const account = context.ledgerNames.get(key(name));
  if (!account || !inGroup(company, account.id, "g-debtors")) throw new Error("Source sales party must be a supported debtor ledger");
  const debit = sum(voucher.lines.filter(line => line.dc === "Dr").map(line => line.paise));
  if (voucher.lines.some(line => line.dc === "Dr" && line.ledgerId !== account.id)) throw new Error("Source invoice has non-party debit postings; discounts, charges and mixed settlements need their own review");
  const taxNames = { cgst: /\bcgst\b|central.*tax/i, sgst: /\bsgst\b|state.*tax/i, utgst: /\butgst\b|union.*tax/i, igst: /\bigst\b|integrated.*tax/i, cess: /\bcess\b/i };
  const taxes = Object.fromEntries(GST_COMPONENTS.map(component => [`${component}Paise`, sum(voucher.lines.filter(line => line.dc === "Cr" && taxNames[component].test(context.ledgers.get(line.ledgerId)?.name || "")).map(line => line.paise))]));
  const transport = Object.fromEntries(["IRN", "ACKNO", "ACKDATE", "IRNACKNO", "IRNACKDATE", "EWAYBILLNUMBER", "EWAYBILLDATE", "TRANSPORTERID", "TRANSPORTERNAME", "TRANSPORTMODE", "VEHICLENO", "VEHICLENUMBER", "TRANSPORTDOCNO", "TRANSPORTDOCDATE", "DISPATCHFROM", "DESTINATION"].map(field => [field, value(node, field)]).filter(([, text]) => text));
  let gstinChecksumValid = null;
  if (value(node, "PARTYGSTIN")) { try { normalizeGstin(value(node, "PARTYGSTIN")); gstinChecksumValid = true; } catch { gstinChecksumValid = false; } }
  const itemValuePaise = sum(items.map(item => item.valuePaise)), taxPaise = sum(Object.values(taxes));
  const unresolvedAdjustmentsPaise = debit - itemValuePaise - taxPaise;
  if (!Number.isSafeInteger(unresolvedAdjustmentsPaise)) throw new Error("Source adjustments exceed exact paise");
  const factKey = `${record.recordId}:${registrationState}:${correctedSeller}`;
  if (!context.factCache.has(factKey)) context.factCache.set(factKey, sourceTaxFacts(context.facts, record, voucher.date, items, registrationState, correctedSeller));
  return { sourceInvoiceNumber: value(node, "VOUCHERNUMBER"), partyName: name, partyLedgerId: account.id, gstin: value(node, "PARTYGSTIN"), gstinChecksumValid, placeOfSupply: state(value(node, "PLACEOFSUPPLY") || value(node, "PARTYSTATENAME")), items, postings: voucher.lines.map(line => ({ ...line, name: context.ledgers.get(line.ledgerId)?.name || "" })), taxes, itemValuePaise, taxablePaise: null, taxPaise, identifiedSourceTaxPaise: taxPaise, classification: "source-only", unresolvedAdjustmentsPaise, totalPaise: debit, transport, transportStatus: "source-unverified", workbookRows: tallyXlsxRows(node), taxFacts: structuredClone(context.factCache.get(factKey)) };
}

// Each original posting has exactly one reviewed role; no netting can hide an extra debit or credit.
export function tallyGstPostingLines(invoice) {
  const origin = invoice.tallyOrigin;
  if (!origin || origin.version !== 1 || invoice.type !== "Sales" || invoice.direction !== "sales" || invoice.reverseCharge || invoice.supplyCategory !== "domestic" || !Array.isArray(origin.postings) || !origin.postings.length || !Array.isArray(origin.postingRoles) || origin.postingRoles.length !== origin.postings.length) throw new Error("Invalid reviewed Tally GST posting linkage");
  const totals = Object.fromEntries(roles.map(role => [role, 0n]));
  for (const [index, line] of origin.postings.entries()) {
    const role = origin.postingRoles[index];
    if (!roles.includes(role) || !line || typeof line.ledgerId !== "string" || !Number.isSafeInteger(line.paise) || line.paise <= 0 || line.dc !== (role === "party" ? "Dr" : "Cr") || origin.accounts?.[role] !== line.ledgerId) throw new Error("A source GST posting lacks one exact reviewed role");
    totals[role] += BigInt(line.paise);
  }
  for (const role of roles) if (totals[role] !== BigInt(role === "party" ? invoice.totals.totalPaise : role === "sales" ? invoice.totals.taxablePaise : invoice.totals[`${role}Paise`])) throw new Error(`Reviewed source ${role} postings do not equal calculated GST totals`);
  if (origin.originalInvoiceNumber !== invoice.number || origin.source?.sourceInvoiceNumber !== invoice.number || typeof origin.internalVoucherNumber !== "string" || origin.accounts.party !== invoice.party.customerLedgerId || !hashPattern.test(origin.postingHash || "") || origin.postingHash !== postingHash({ ...invoice, number: origin.internalVoucherNumber, lines: origin.postings })) throw new Error("The original source posting order, amounts or identity changed");
  if (!isDeepStrictEqual(origin.sourceReferences, sourceReferences(origin.source?.transport || {})) || origin.sourceReferenceHash !== digest(origin.sourceReferences) || origin.sourceReferenceStatus !== "source-unverified") throw new Error("The preserved source IRN and transport references changed");
  return structuredClone(origin.postings);
}
export function assertTallyGstPosting(company, voucher) {
  const origin = voucher.gst?.tallyOrigin;
  if (!origin) return;
  if (voucher.source?.system !== "tally" || voucher.source.recordId !== origin.recordId || voucher.source.originalNumber !== origin.originalInvoiceNumber || voucher.number !== origin.internalVoucherNumber || !hashPattern.test(origin.sourceHash || "") || !hashPattern.test(origin.recordHash || "") || !isDeepStrictEqual(tallyGstPostingLines(voucher.gst), voucher.lines)) throw new Error("The source GST invoice differs from its original posting");
  for (const [role, ledgerId] of Object.entries(origin.accounts)) {
    if (!roles.includes(role) || !inGroup(company, ledgerId, role === "party" ? "g-debtors" : role === "sales" ? "g-sales" : "g-duties")) throw new Error(`Reviewed source ${role} ledger has the wrong account group`);
  }
  assertTallyGstStockLink(company, voucher);
}
export function assertTallyGstStockLink(company, voucher) {
  const invoice = voucher.gst, origin = invoice?.tallyOrigin;
  if (!origin) return null;
  if (origin.stockMode === "report-only") {
    if (invoice.stockEffect !== "none" || origin.stockJournalId !== null || origin.stockJournalHash !== null || !Array.isArray(origin.stockLineMap) || origin.stockLineMap.length || company.stock?.journals?.some(journal => journal.accountingVoucherId === voucher.id) || !origin.source?.items?.length || origin.source.items.some(item => item.actualQuantity !== null) || company.stock?.tally?.hasSourceGaps !== true) throw new Error("GST reporting-only promotion must retain the unresolved source stock quantity and cannot hide an existing movement");
    return null;
  }
  if (origin.stockMode !== "source") throw new Error("Choose the reviewed source stock basis");
  const journal = company.stock?.journals?.find(row => row.id === origin.stockJournalId);
  if (!journal || journal.type !== "issue" || journal.financialKind !== "sale" || journal.sourceRef !== origin.recordId || journal.accountingVoucherId !== voucher.id || journal.date !== voucher.date || journal.number !== origin.originalInvoiceNumber || stockHash(journal) !== origin.stockJournalHash || !Array.isArray(origin.stockLineMap) || origin.stockLineMap.length !== journal.lines.length || invoice.stockEffect !== "quantity") throw new Error("Promoted GST invoice needs its unchanged original stock movement");
  const mapped = invoice.items.map(() => ({ q: 0n, b: 0n, v: 0n }));
  journal.lines.forEach((line, index) => {
    const target = origin.stockLineMap[index], item = invoice.items[target];
    if (!Number.isSafeInteger(target) || !item || item.kind !== "goods" || item.itemId !== line.itemId || !Number.isSafeInteger(line.revenuePaise) || line.revenuePaise < 0) throw new Error("Source stock lines do not match the reviewed GST items");
    mapped[target].q += quantityMicros(line.quantity); mapped[target].b += quantityMicros(line.billedQuantity || line.quantity); mapped[target].v += BigInt(line.revenuePaise);
  });
  mapped.forEach((entry, index) => {
    if (!origin.source?.items?.[index]?.actualQuantity || entry.q !== quantityMicros(origin.source.items[index].actualQuantity) || entry.b !== quantityMicros(invoice.items[index].quantity) || entry.v !== BigInt(invoice.items[index].taxablePaise)) throw new Error("Original actual/billed stock quantities and values do not reconcile to each reviewed GST invoice line");
  });
  return journal;
}

function normalizeMapping(input) {
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 500 || new Set(input.items.map(item => key(item.sourceName))).size !== input.items.length) throw new Error("Map every unique source item name once");
  const accounts = {};
  for (const role of roles) if (input.accounts?.[role]) accounts[role] = requireText(input.accounts[role], `${role} posting ledger`, 48);
  if (Object.keys(input.accounts || {}).some(role => !roles.includes(role)) || new Set(Object.values(accounts)).size !== Object.values(accounts).length) throw new Error("Each reviewed source posting ledger must have one distinct GST role");
  const stockMode = input.stockMode || "source";
  if (!["source", "report-only"].includes(stockMode)) throw new Error("Choose source stock or GST reporting only");
  const sourceCorrections = {};
  if (input.sourceCorrections !== undefined && (!input.sourceCorrections || typeof input.sourceCorrections !== "object" || Array.isArray(input.sourceCorrections))) throw new Error("Source corrections need a reason for each reviewed field");
  const allowed = new Set(["sellerGstin", "buyerGstin", ...input.items.flatMap(item => ["hsnSac", "gstRateBps", "supplyType", "taxability"].map(field => `item:${item.sourceName}:${field}`))]);
  for (const field of Object.keys(input.sourceCorrections || {}).sort()) { if (!allowed.has(field)) throw new Error("A source correction references an unmapped GST field"); sourceCorrections[field] = requireText(input.sourceCorrections[field], "source correction reason", 500); }
  return { recordId: requireText(input.recordId, "source record", 48), registrationId: requireText(input.registrationId, "GST registration", 48), partyId: requireText(input.partyId, "GST party", 48), items: input.items.map(item => ({ sourceName: requireText(item.sourceName, "source item name", 120), itemId: requireText(item.itemId, "GST item", 48) })), accounts, stockMode, ...(Object.keys(sourceCorrections).length ? { sourceCorrections } : {}), evidence: { name: requireText(input.evidence?.name, "supporting evidence name", 120), reference: requireText(input.evidence?.reference, "supporting evidence reference", 500) } };
}
function buildPromotion(company, vouchers, records, record, mapping, hash, context = promotionContext(company, vouchers, records)) {
  const voucher = context.vouchers.get(record.voucherId);
  const registration = context.registrations.get(mapping.registrationId);
  const source = sourceInvoice(company, voucher, record, context, registration?.stateCode, Boolean(mapping.sourceCorrections?.sellerGstin));
  const party = context.parties.get(mapping.partyId), taxFactReview = [];
  if (!party || party.customerLedgerId !== source.partyLedgerId || mapping.accounts.party !== source.partyLedgerId) throw new Error("The reviewed GST party must link to the original debtor ledger");
  if ((source.gstin || source.taxFacts.buyerGstin.status === "supplied") && !party.gstin) throw new Error("A source registered buyer cannot be silently changed to an unregistered buyer");
  if (!registration) throw new Error("Choose a GST registration");
  chooseFact(source.taxFacts.sellerGstin, registration.gstin, "sellerGstin", mapping, taxFactReview, false);
  chooseFact(source.taxFacts.buyerGstin, party.gstin, "buyerGstin", mapping, taxFactReview, false);
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
    itemOverrides.set(item.id, { ...item, hsnSac, gstRateBps, kind, supplyStatus });
    return { itemId: item.id, quantity: row.quantity, unitPricePaise: row.unitPricePaise, discountBps: 0, gstRateBps, supplyStatus };
  });
  const invoiceCompany = { ...company, gst: { ...company.gst, items: company.gst.items.map(item => itemOverrides.get(item.id) || item) } };
  if (!source.sourceInvoiceNumber || source.sourceInvoiceNumber !== voucher.source?.originalNumber) throw new Error("The source statutory invoice number is absent or differs from the original voucher linkage");
  const invoice = buildGstInvoice(invoiceCompany, vouchers.filter(row => row.id !== voucher.id), { type: "Sales", registrationId: mapping.registrationId, partyId: mapping.partyId, number: source.sourceInvoiceNumber, date: voucher.date, narration: voucher.narration, placeOfSupply: source.placeOfSupply, pricing: "exclusive", stockEffect: mapping.stockMode === "report-only" ? "none" : "quantity", items }, voucher.id);
  invoice.number = source.sourceInvoiceNumber;
  invoice.items.forEach((line, index) => { if (line.taxablePaise !== source.items[index].valuePaise) throw new Error(`Source item ${index + 1} value does not equal quantity × reviewed unit price`); });
  source.taxablePaise = invoice.totals.taxablePaise;
  source.taxPaise = invoice.totals.taxPaise;
  source.classification = "reviewed";
  for (const component of GST_COMPONENTS) if (source.taxes[`${component}Paise`] && source.taxes[`${component}Paise`] !== invoice.totals[`${component}Paise`]) throw new Error(`Identifiable source ${component.toUpperCase()} does not reconcile to the reviewed invoice`);
  source.unresolvedAdjustmentsPaise = source.totalPaise - source.taxablePaise - source.taxPaise;
  const postingRoles = voucher.lines.map(line => {
    const role = roles.find(role => mapping.accounts[role] === line.ledgerId);
    if (!role) throw new Error(`Assign every source posting a GST role: ${context.ledgers.get(line.ledgerId)?.name || line.ledgerId}`);
    const ledgerName = context.ledgers.get(line.ledgerId)?.name || "";
    const statedHead = GST_COMPONENTS.find(head => new RegExp(`\\b${head}\\b`, "i").test(ledgerName));
    if (statedHead && role !== statedHead) throw new Error(`Source ${ledgerName} cannot be mapped to ${role}`);
    return role;
  });
  const stockLineMap = (journal?.lines || []).map(line => {
    const matches = invoice.items.flatMap((item, index) => item.itemId === line.itemId ? [index] : []);
    if (matches.length !== 1) throw new Error("Repeated source item lines require an explicit stock-to-GST line allocation");
    return matches[0];
  });
  const references = sourceReferences(source.transport);
  invoice.tallyOrigin = { version: 1, recordId: record.recordId, sourceHash: hash, recordHash: nodeHash(record), originalInvoiceNumber: source.sourceInvoiceNumber, internalVoucherNumber: voucher.number, postingHash: postingHash(voucher), postings: structuredClone(voucher.lines), postingRoles, accounts: structuredClone(mapping.accounts), mappingHash: digest(mapping), evidence: structuredClone(mapping.evidence), source: structuredClone(source), taxFactReview, sourceReferences: references, sourceReferenceHash: digest(references), sourceReferenceStatus: "source-unverified", stockMode: mapping.stockMode, stockJournalId: journal?.id || null, stockJournalHash: journal ? stockHash(journal) : null, stockLineMap };
  const promoted = { ...voucher, gst: invoice };
  assertGstSnapshot(company, promoted);
  assertTallyGstPosting(company, promoted);
  const discrepancies = [];
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
  const rows = records.filter(record => record.type === "VOUCHER" && record.disposition !== "duplicate-source").map(record => {
    const voucher = context.vouchers.get(record.voucherId), mapping = mappings.get(record.recordId) || null;
    const row = { recordId: record.recordId, voucherId: voucher?.id || record.voucherId || "", number: voucher?.number || value(record.node, "VOUCHERNUMBER"), sourceNumber: value(record.node, "VOUCHERNUMBER"), date: voucher?.date || "", status: "blocked", source: null, mapping, blockers: [], discrepancies: [] };
    try {
      if (voucher?.gst?.tallyOrigin) { assertTallyGstPosting(company, voucher); row.source = voucher.gst.tallyOrigin.source; row.suggestions = suggestions(row.source, context); row.discrepancies = structuredClone(voucher.gst.tallyOrigin.discrepancies || []); row.status = "active"; return row; }
      if (voucher?.gst) throw new Error("This voucher already has an independently linked GST invoice");
      row.source = sourceInvoice(company, voucher, record, context, context.registrations.get(mapping?.registrationId)?.stateCode, Boolean(mapping?.sourceCorrections?.sellerGstin));
      row.suggestions = suggestions(row.source, context);
      if (!mapping) throw new Error("Review the seller registration, original party ledger, every item HSN/rate and every posting role with named supporting evidence");
      const built = buildPromotion(company, vouchers, records, record, mapping, hash, context);
      row.source = built.source; row.discrepancies = built.discrepancies; row.status = "ready";
    } catch (error) { row.blockers.push({ code: "tally-gst-review-required", message: error.message }); }
    return row;
  });
  const summary = { sourceInvoices: rows.length, ready: rows.filter(row => row.status === "ready").length, blocked: rows.filter(row => row.status === "blocked").length, active: rows.filter(row => row.status === "active").length,
    totalPaise: sum(rows.map(row => row.source?.totalPaise || 0)), sourceItemValuePaise: sum(rows.map(row => row.source?.itemValuePaise || 0)), taxablePaise: sum(rows.map(row => row.source?.taxablePaise || 0)), taxPaise: sum(rows.map(row => row.source?.taxPaise || 0)) };
  const reviewHash = digest({ sourceHash: hash, meta, gst: company.gst, ledgers: company.ledgers, stock: company.stock, vouchers });
  return { revision: meta.revision, sourceHash: hash, reviewHash, rows, summary, registrations: structuredClone(company.gst?.registrations || []), parties: structuredClone(company.gst?.parties || []), items: structuredClone(company.gst?.items || []), ledgers: company.ledgers.map(({ id, name, groupId }) => ({ id, name, groupId })), sourceStockItems: structuredClone(company.stock?.masters || []), states: GST_STATES };
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
  if (!company.gst?.registrations.some(item => item.id === mapping.registrationId) || !company.gst?.parties.some(item => item.id === mapping.partyId) || mapping.items.some(row => !company.gst.items.some(item => item.id === row.itemId))) throw new Error("Choose existing local GST masters for this mapping");
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
  const invoiceNumbers = new Set();
  for (const voucher of vouchers.filter(voucher => voucher.gst)) {
    const invoice = voucher.gst, id = `${invoice.registrationId}:${invoice.financialYear}:${invoice.number.toUpperCase()}`;
    if (invoiceNumbers.has(id)) throw new Error("That statutory invoice number is already used for this GST registration and financial year");
    invoiceNumbers.add(id);
  }
  for (const item of meta.mappings) if (!item || item.recordId !== item.mapping?.recordId || !hashPattern.test(item.sourceHash || "") || !hashPattern.test(item.recordHash || "") || !isDeepStrictEqual(normalizeMapping(item.mapping), item.mapping)) throw new Error("Invalid preserved source GST mapping");
  const targets = new Map();
  for (const event of meta.activations) {
    if (!hashPattern.test(event.sourceHash || "") || !Array.isArray(event.targets)) throw new Error("Invalid source GST activation event");
    for (const target of event.targets) { if (targets.has(target.voucherId)) throw new Error("A source GST invoice was activated more than once"); targets.set(target.voucherId, { target, event }); }
  }
  if (targets.size !== promoted.length) throw new Error("A promoted source GST invoice or activation event is missing");
  for (const voucher of promoted) {
    const original = voucher.gst.tallyOrigin, activation = targets.get(voucher.id), mapping = meta.mappings.find(item => item.recordId === original.recordId && digest(item.mapping) === original.mappingHash);
    if (!activation || !mapping || activation.target.recordId !== original.recordId || activation.event.sourceHash !== original.sourceHash || mapping.sourceHash !== original.sourceHash || mapping.recordHash !== original.recordHash || activation.target.mappingHash !== original.mappingHash || activation.target.postingHash !== postingHash(voucher) || activation.target.invoiceHash !== digest(voucher.gst) || !isDeepStrictEqual(mapping.mapping.accounts, original.accounts) || !isDeepStrictEqual(mapping.mapping.evidence, original.evidence) || !isDeepStrictEqual(activation.target.discrepancies, original.discrepancies)) throw new Error("Preserved source GST mapping, invoice or activation evidence changed");
    assertTallyGstPosting(company, voucher);
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
      const prefix = `item:${line.name}:`;
      return { ...item, hsnSac: reviewedFacts.get(prefix + "hsnSac"), gstRateBps: reviewedFacts.get(prefix + "gstRateBps"), kind: reviewedFacts.get(prefix + "supplyType"), supplyStatus: reviewedFacts.get(prefix + "taxability") };
    });
    const snapshotContext = { ...context, gstItems: new Map(snapshotCompany.gst.items.map(item => [item.id, item])), parties: new Map(snapshotCompany.gst.parties.map(item => [item.id, item])), registrations: new Map(snapshotCompany.gst.registrations.map(item => [item.id, item])) };
    const expected = buildPromotion(snapshotCompany, vouchers, records, record, mapping, hash, snapshotContext);
    if (!isDeepStrictEqual(expected.promoted.gst, voucher.gst)) throw new Error("Promoted GST invoice differs from its original source and confirmed snapshots");
  }
}
