import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { buildGstInvoice, assertGstSnapshot, assertGstReferences, GST_COMPONENTS, GST_STATES, quantityMicros, formatQuantity, normalizeGstin } from "./gst.js";
import { attribute, children, findNodes, value } from "./tally-format.js";
import { tallyAmount, tallyDate } from "./tally-values.js";
import { isIsoDate } from "./money.js";
import { sourceTaxFacts } from "./tally-gst-facts.js";
import * as tallyStock from "./tally-stock.js";

const digest = input => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const key = input => String(input || "").trim().toLocaleLowerCase("en-IN");
const rolesFor = direction => ["party", direction === "purchase" ? "purchase" : "sales", ...GST_COMPONENTS];
const posting = voucher => ({ type: voucher.type, date: voucher.date, number: voucher.number, narration: voucher.narration, lines: voucher.lines });
const postingHash = voucher => digest(posting(voucher));
const text = (input, label, maximum = 120) => {
  if (typeof input !== "string" || !input.trim() || input.length > maximum) throw new Error(`Enter ${label} within ${maximum} characters`);
  return input.trim();
};
const safeSum = values => {
  const total = values.reduce((sum, amount) => sum + BigInt(amount), 0n);
  if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Source note totals exceed exact paise");
  return Number(total);
};
const sourceReferences = transport => ({ irn: transport.IRN || "", acknowledgementNumber: transport.IRNACKNO || transport.ACKNO || "", acknowledgementDate: transport.IRNACKDATE || transport.ACKDATE || "", ewayBillNumber: transport.EWAYBILLNUMBER || "", ewayBillDate: transport.EWAYBILLDATE || "" });
export const isTallyNote = voucher => ["Credit Note", "Debit Note"].includes(voucher?.type);
function inGroup(company, ledgerId, expected) {
  let group = company.ledgers.find(row => row.id === ledgerId)?.groupId;
  const seen = new Set();
  while (group && !seen.has(group)) { if (group === expected) return true; seen.add(group); group = company.groups.find(row => row.id === group)?.parentId; }
  return false;
}
function date(input) {
  const midnight = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/.exec(input);
  return tallyDate(midnight ? midnight[1] : input);
}
function quantity(input, allowZero = false) {
  const match = /^(\d+(?:\.\d+)?)(?:\s+(.+))?$/.exec(String(input || "").trim().replace(/,/g, ""));
  if (!match || !match[2]) throw new Error("Source note quantities need one explicit simple unit");
  return { quantity: formatQuantity(quantityMicros(match[1], allowZero)), unit: match[2] };
}
export function normalizeTallyNoteReview(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Review the note direction, original invoice and stock treatment");
  const allowed = ["direction", "originalInvoiceId", "originalNumber", "originalDate", "stockEffect", "supplierDocumentConfirmed", "supplierNoteNumber", "supplierNoteDate", "lines"];
  if (Object.keys(input).some(field => !allowed.includes(field)) || !["sales", "purchase"].includes(input.direction) || !["none", "quantity"].includes(input.stockEffect)) throw new Error("Choose the note direction and explicit financial-only or physical treatment");
  const review = { direction: input.direction, originalInvoiceId: text(input.originalInvoiceId, "the verified original invoice", 48), originalNumber: text(input.originalNumber, "the original invoice number", 16), originalDate: text(input.originalDate, "the original invoice date", 10), stockEffect: input.stockEffect };
  if (!isIsoDate(review.originalDate)) throw new Error("Enter the original invoice date");
  if (input.supplierDocumentConfirmed !== undefined) {
    if (typeof input.supplierDocumentConfirmed !== "boolean") throw new Error("Confirm whether the actual supplier note is held");
    review.supplierDocumentConfirmed = input.supplierDocumentConfirmed;
  }
  for (const field of ["supplierNoteNumber", "supplierNoteDate"]) if (input[field]) {
    review[field] = text(input[field], field, field === "supplierNoteNumber" ? 16 : 10);
    if (field === "supplierNoteDate" && !isIsoDate(review[field])) throw new Error("Enter the actual supplier note date");
  }
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 500) throw new Error("Allocate every note line to the original invoice's HSN/rate lines");
  review.lines = input.lines.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(field => !["sourceLineIndex", "originalLineIndex", "quantity", "unitPricePaise", "discountBps"].includes(field)) || !Number.isSafeInteger(row.originalLineIndex) || row.originalLineIndex < 0) throw new Error("Choose an original invoice line for every note allocation");
    if (row.sourceLineIndex !== undefined) {
      if (!Number.isSafeInteger(row.sourceLineIndex) || row.sourceLineIndex < 0 || ["quantity", "unitPricePaise", "discountBps"].some(field => row[field] !== undefined)) throw new Error("Native note lines retain their source quantities, rate and discount");
      return { sourceLineIndex: row.sourceLineIndex, originalLineIndex: row.originalLineIndex };
    }
    const q = formatQuantity(quantityMicros(row.quantity));
    if (!Number.isSafeInteger(row.unitPricePaise) || row.unitPricePaise <= 0 || !Number.isSafeInteger(row.discountBps ?? 0) || (row.discountBps ?? 0) < 0 || (row.discountBps ?? 0) > 10000) throw new Error("Enter exact financial note allocation values");
    return { originalLineIndex: row.originalLineIndex, quantity: q, unitPricePaise: row.unitPricePaise, discountBps: row.discountBps ?? 0 };
  });
  return review;
}
function selectedFact(supplied, chosen, field, mapping) {
  const selected = chosen || supplied;
  if (supplied && supplied !== selected && !mapping.sourceCorrections?.[field]) throw new Error(`${field}: the original source reference differs; record an explicit correction reason`);
  return selected;
}
export function sourceTallyGstNote(company, voucher, record, context, mapping = {}) {
  if (record.disposition !== "voucher" || !isTallyNote(voucher)) throw new Error("Choose an imported, posted credit or debit note");
  if (!record.originalPosting || postingHash(record.originalPosting) !== postingHash(voucher)) throw new Error("The source accounting note changed after import");
  const node = record.node, review = mapping.noteReview;
  context.assertRegularSource(node);
  for (const flag of ["ISCANCELLED", "ISOPTIONAL", "ISDELETED", "ISPOSTDATED", "ISREVERSECHARGEAPPLICABLE"]) if (findNodes(node, flag).some(row => /^(yes|true|1)$/i.test(row.text.trim()))) throw new Error(`${flag} needs its separate GST workflow`);
  const sourcePartyName = value(node, "PARTYLEDGERNAME");
  const postedParties = [...new Set(voucher.lines.map(row => row.ledgerId))].filter(id => inGroup(company, id, "g-debtors") || inGroup(company, id, "g-creditors"));
  const account = sourcePartyName ? context.ledgerNames.get(key(sourcePartyName)) : postedParties.length === 1 ? context.ledgers.get(postedParties[0]) : null;
  const partyName = account?.name || sourcePartyName;
  const direction = account && inGroup(company, account.id, "g-debtors") ? "sales" : account && inGroup(company, account.id, "g-creditors") ? "purchase" : "";
  if (!direction) throw new Error("A source note must identify the original Sales or Purchase debtor or creditor party ledger");
  if (review && review.direction !== direction) throw new Error("The reviewed note direction does not match its source party ledger");
  const purchase = direction === "purchase";
  const type = purchase ? voucher.type === "Debit Note" ? "Credit Note" : "Debit Note" : voucher.type;
  const reducing = type === "Credit Note", itemDebit = purchase !== reducing, partySide = itemDebit ? "Cr" : "Dr";
  if (voucher.lines.some(line => line.dc === partySide && line.ledgerId !== account.id)) throw new Error("This Sales or Purchase note has extra settlement postings requiring separate review");
  const inventory = [...children(node, "ALLINVENTORYENTRIES"), ...children(node, "INVENTORYENTRIES")];
  const items = inventory.map(entry => {
    const billed = quantity(value(entry, "BILLEDQTY"));
    const actual = value(entry, "ACTUALQTY") ? quantity(value(entry, "ACTUALQTY"), true) : null;
    const rate = /^(\d+(?:\.\d{1,2})?)\s*(?:\/\s*(.+))?$/.exec(value(entry, "RATE").replace(/,/g, ""));
    const amount = tallyAmount(value(entry, "AMOUNT")), flag = value(entry, "ISDEEMEDPOSITIVE");
    if (!rate || rate[2] && key(rate[2]) !== key(billed.unit) || actual && key(actual.unit) !== key(billed.unit)) throw new Error("Source note quantities and rate need the same simple unit");
    if (!amount || amount < 0 !== itemDebit || !/^(yes|no|true|false|1|0)$/i.test(flag) || /^(yes|true|1)$/i.test(flag) !== itemDebit) throw new Error("The source note inventory amount or debit direction contradicts its statutory treatment");
    const discountBps = value(entry, "DISCOUNT") ? tallyAmount(value(entry, "DISCOUNT").replace(/\s*%$/, "").trim()) : 0;
    if (discountBps < 0 || discountBps > 10000) throw new Error("Source note discount needs an exact percentage");
    return { sourceName: text(value(entry, "STOCKITEMNAME"), "source note item"), ...billed, actualQuantity: actual?.quantity ?? null, actualBasis: actual ? "source" : "unresolved", unitPricePaise: tallyAmount(rate[1]), discountBps, valuePaise: Math.abs(amount), sourceAmountPaise: amount, sourceDirectionFlag: flag, basis: "source-inventory" };
  });
  const rawSupplierNumber = purchase ? value(node, "REFERENCE") : "", rawSupplierDate = purchase ? value(node, "REFERENCEDATE") : "";
  let supplierDate = "";
  if (rawSupplierDate) { try { supplierDate = date(rawSupplierDate); } catch (error) { if (!review?.supplierNoteDate || !mapping.sourceCorrections?.supplierNoteDate) throw error; supplierDate = rawSupplierDate; } }
  const sourceInvoiceNumber = purchase ? selectedFact(rawSupplierNumber, review?.supplierNoteNumber, "supplierNoteNumber", mapping) : value(node, "VOUCHERNUMBER");
  const sourceInvoiceDate = purchase ? selectedFact(supplierDate, review?.supplierNoteDate, "supplierNoteDate", mapping) : voucher.date;
  const rawOriginalNumber = value(node, "ORIGINALINVOICENO"), rawOriginalDate = value(node, "ORIGINALINVOICEDATE");
  let originalDate = "";
  if (rawOriginalDate) { try { originalDate = date(rawOriginalDate); } catch (error) { if (!review?.originalDate || !mapping.sourceCorrections?.originalDate) throw error; originalDate = rawOriginalDate; } }
  const originalDocument = { sourceNumber: rawOriginalNumber, sourceDate: originalDate, chosenNumber: selectedFact(rawOriginalNumber, review?.originalNumber, "originalNumber", mapping), chosenDate: selectedFact(originalDate, review?.originalDate, "originalDate", mapping) };
  if (sourceInvoiceDate && (!isIsoDate(sourceInvoiceDate) || sourceInvoiceDate > voucher.date)) throw new Error("The statutory source note date must be on or before its accounting date");
  const taxNames = { cgst: /\bcgst\b|central.*tax/i, sgst: /\bsgst\b|state.*tax/i, utgst: /\butgst\b|union.*tax/i, igst: /\bigst\b|integrated.*tax/i, cess: /\bcess\b/i };
  const taxes = Object.fromEntries(GST_COMPONENTS.map(head => [`${head}Paise`, safeSum(voucher.lines.filter(line => line.dc !== partySide && taxNames[head].test(context.ledgers.get(line.ledgerId)?.name || "")).map(line => line.paise))]));
  const facts = sourceTaxFacts(context.facts, record, sourceInvoiceDate, items, context.registrations.get(mapping.registrationId)?.stateCode || "", Boolean(mapping.sourceCorrections?.sellerGstin), { direction, supplierState: context.parties.get(mapping.partyId)?.stateCode || "", ...(purchase && review?.supplierNoteDate ? { documentDate: sourceInvoiceDate } : {}) });
  const transport = Object.fromEntries(["IRN", "ACKNO", "ACKDATE", "IRNACKNO", "IRNACKDATE", "EWAYBILLNUMBER", "EWAYBILLDATE"].map(field => [field, value(node, field)]).filter(([, supplied]) => supplied));
  let gstinChecksumValid = null;
  if (value(node, "PARTYGSTIN")) { try { normalizeGstin(value(node, "PARTYGSTIN")); gstinChecksumValid = true; } catch { gstinChecksumValid = false; } }
  const totalPaise = safeSum(voucher.lines.filter(line => line.dc === partySide).map(line => line.paise)), itemValuePaise = safeSum(items.map(item => item.valuePaise)), taxPaise = safeSum(Object.values(taxes));
  return { ...context.sourceExportAllocations(node), note: true, noteInventory: inventory.length > 0, direction, type, sourceVoucherType: value(node, "VOUCHERTYPENAME") || attribute(node, "VCHTYPE"), sourceVoucherNumber: value(node, "VOUCHERNUMBER"), sourceVoucherDate: voucher.date, sourceInvoiceNumber, sourceInvoiceDate, originalDocument,
    ...(purchase ? { supplierDocument: { sourceNumber: rawSupplierNumber, sourceDate: supplierDate, numberBasis: review?.supplierNoteNumber ? "reviewed" : rawSupplierNumber ? "source" : "unresolved", dateBasis: review?.supplierNoteDate ? "reviewed" : supplierDate ? "source" : "unresolved" } } : {}),
    partyName, partyBasis: sourcePartyName ? "source-header" : "unique-posted-party", partyLedgerId: account.id, gstin: value(node, "PARTYGSTIN"), gstinChecksumValid, placeOfSupply: value(node, "PLACEOFSUPPLY"), items, taxFacts: facts, postings: voucher.lines.map(line => ({ ...line, name: context.ledgers.get(line.ledgerId)?.name || "" })), taxes, itemValuePaise, taxablePaise: null, taxPaise, totalPaise, identifiedSourceTaxPaise: taxPaise, unresolvedAdjustmentsPaise: totalPaise - itemValuePaise - taxPaise, classification: "source-only", transport, transportStatus: "source-unverified", workbookRows: [] };
}
function reviewFact(fact, chosen, field, mapping, reviews) {
  const reason = mapping.sourceCorrections?.[field];
  if (fact.status === "conflict" && !reason || fact.status === "supplied" && fact.value !== chosen && !reason) throw new Error(`${field}: source facts differ from the verified original; record an explicit correction reason`);
  reviews.push({ field, status: fact.status === "absent" ? "absent" : reason ? "corrected" : "matching", chosenBasis: "original-invoice", chosenValue: chosen, localMasterValue: chosen, sourceValue: fact.value, ...(reason ? { reason } : {}), evidence: structuredClone(fact.evidence), superseded: structuredClone(fact.superseded), issues: [...fact.issues] });
}
export function buildTallyGstNotePromotion(company, vouchers, records, record, mapping, sourceHash, context) {
  const voucher = context.vouchers.get(record.voucherId), source = sourceTallyGstNote(company, voucher, record, context, mapping), review = mapping.noteReview;
  if (!review) throw new Error("Review the note direction, verified original invoice, line allocations and financial-only or physical treatment");
  const originalVoucher = context.vouchers.get(review.originalInvoiceId), original = originalVoucher?.gst;
  if (!original || !["Sales", "Purchase"].includes(original.type) || original.direction !== source.direction || original.partyId !== mapping.partyId || original.registrationId !== mapping.registrationId || original.reverseCharge || original.supplyCategory !== "domestic") throw new Error("Link a verified regular domestic original GST invoice with the same party, registration and direction");
  assertGstSnapshot(company, originalVoucher);
  const originalRecord = context.records.get(originalVoucher.source?.recordId);
  source.originalExportEvidence = originalRecord ? { originalInvoiceId: original.id, sourceVoucherType: value(originalRecord.node, "VOUCHERTYPENAME") || attribute(originalRecord.node, "VCHTYPE"), ...context.sourceExportAllocations(originalRecord.node) } : null;
  const purchase = source.direction === "purchase";
  const party = context.parties.get(mapping.partyId), registration = context.registrations.get(mapping.registrationId);
  if (!party || !registration || (purchase ? party.supplierLedgerId : party.customerLedgerId) !== source.partyLedgerId || mapping.accounts.party !== source.partyLedgerId) throw new Error("The note must retain the linked original supplier or customer posting ledger");
  const originalNumber = purchase ? original.supplierInvoiceNumber : original.number, originalDate = original.supplierInvoiceDate || original.date;
  if (review.originalNumber !== originalNumber || review.originalDate !== originalDate || source.originalDocument.chosenNumber !== originalNumber || source.originalDocument.chosenDate !== originalDate) throw new Error("The reviewed original reference and date must equal the verified original GST invoice");
  if (purchase && (review.supplierDocumentConfirmed !== true || !source.sourceInvoiceNumber || !isIsoDate(source.sourceInvoiceDate))) throw new Error("Hold and explicitly confirm the actual supplier GST credit/debit note, with its own note number, date and named evidence; a buyer accounting note alone is insufficient");
  if (!source.sourceVoucherNumber || source.sourceVoucherNumber !== voucher.source?.originalNumber) throw new Error("The note's original source voucher identity changed");
  if (source.placeOfSupply) {
    const supplied = /^\d{1,2}$/.test(source.placeOfSupply) ? source.placeOfSupply.padStart(2, "0") : source.placeOfSupply;
    const originalState = original.placeOfSupply;
    const matches = supplied === originalState;
    // Native state names are normalised by the same public state catalogue as ordinary invoices.
    if (!matches && !mapping.sourceCorrections?.placeOfSupply) {
      if (!GST_STATES.some(row => row.code === originalState && key(row.name) === key(supplied))) throw new Error("The source note place of supply differs from its verified original invoice");
    }
  }
  const taxFactReview = [];
  reviewFact(source.taxFacts.sellerGstin, purchase ? party.gstin : registration.gstin, "sellerGstin", mapping, taxFactReview);
  reviewFact(source.taxFacts.buyerGstin, purchase ? registration.gstin : party.gstin, "buyerGstin", mapping, taxFactReview);
  if (review.lines.length !== (source.noteInventory ? source.items.length : review.lines.length)) throw new Error("Allocate every source note inventory row exactly once");
  const native = source.noteInventory;
  if (native && (new Set(review.lines.map(row => row.sourceLineIndex)).size !== source.items.length || source.items.some((_, index) => !review.lines.some(row => row.sourceLineIndex === index))) || !native && review.lines.some(row => row.sourceLineIndex !== undefined)) throw new Error("Native note rows and explicit financial allocations must retain their separate source basis");
  if (!native && (review.stockEffect !== "none" || mapping.items.length)) throw new Error("An accounting-only note needs financial-only HSN/rate allocations and creates no goods movement");
  const ordered = native ? source.items.map((_, index) => review.lines.find(row => row.sourceLineIndex === index)) : review.lines;
  const originalLineMap = ordered.map(row => row.originalLineIndex), overrides = new Map();
  const items = ordered.map((allocation, index) => {
    const originalLine = original.items[allocation.originalLineIndex];
    if (!originalLine) throw new Error("A reviewed note allocation references a missing original invoice line");
    if (originalLine.kind !== "goods" && native || originalLine.cessRateBps || originalLine.supplyStatus !== "taxable") throw new Error("Source notes support regular taxable original lines without cess");
    const prior = overrides.get(originalLine.itemId);
    if (prior && ["hsnSac", "kind", "unit"].some(field => prior[field] !== originalLine[field])) throw new Error("One item identity has conflicting original invoice classifications");
    overrides.set(originalLine.itemId, { ...originalLine, id: originalLine.itemId });
    let row = allocation;
    if (native) {
      row = source.items[index];
      const mapped = mapping.items.find(item => key(item.sourceName) === key(row.sourceName));
      if (!mapped || mapped.itemId !== originalLine.itemId || key(row.sourceName) !== key(originalLine.name) || key(row.unit) !== key(originalLine.unit)) throw new Error("Match each native note item to its exact original invoice item and unit");
      const facts = source.taxFacts.items[index], prefix = `item:${row.sourceName}:`;
      for (const [field, chosen] of [["hsnSac", originalLine.hsnSac], ["gstRateBps", originalLine.gstRateBps], ["supplyType", originalLine.kind], ["taxability", originalLine.supplyStatus]]) reviewFact(facts[field], chosen, prefix + field, mapping, taxFactReview);
    } else {
      source.items.push({ sourceName: originalLine.name, unit: originalLine.unit, quantity: row.quantity, actualQuantity: null, actualBasis: "none", unitPricePaise: row.unitPricePaise, discountBps: row.discountBps, valuePaise: null, basis: "reviewed-financial-allocation", originalLineIndex: allocation.originalLineIndex });
      for (const [field, chosen] of [["hsnSac", originalLine.hsnSac], ["gstRateBps", originalLine.gstRateBps], ["supplyType", originalLine.kind], ["taxability", originalLine.supplyStatus]]) taxFactReview.push({ field: `item:${originalLine.name}:${field}`, status: "inherited", chosenBasis: "original-invoice", chosenValue: chosen, localMasterValue: chosen, sourceValue: chosen, evidence: [{ originalInvoiceId: original.id, originalLineIndex: allocation.originalLineIndex }], superseded: [], issues: [] });
    }
    return { itemId: originalLine.itemId, quantity: row.quantity, unitPricePaise: row.unitPricePaise, discountBps: row.discountBps || 0, gstRateBps: originalLine.gstRateBps, supplyStatus: originalLine.supplyStatus };
  });
  if (native) {
    const names = new Set(source.items.map(row => key(row.sourceName)));
    if (mapping.items.length !== names.size || mapping.items.some(row => !names.has(key(row.sourceName)))) throw new Error("Map every unique native note item once without unrelated mappings");
  }
  const snapshotCompany = { ...company, gst: { ...company.gst, items: company.gst.items.map(row => overrides.get(row.id) || row) } };
  const invoice = buildGstInvoice(snapshotCompany, vouchers.filter(row => row.id !== voucher.id), { type: source.type, direction: source.direction, registrationId: mapping.registrationId, partyId: mapping.partyId, number: purchase ? voucher.number : source.sourceVoucherNumber, date: voucher.date, narration: voucher.narration,
    ...(purchase ? { supplierInvoiceNumber: source.sourceInvoiceNumber, supplierInvoiceDate: source.sourceInvoiceDate, itcEligibility: "pending" } : {}), placeOfSupply: original.placeOfSupply, pricing: "exclusive", stockEffect: review.stockEffect, originalInvoiceId: original.id, originalLineMap, items }, voucher.id, review.stockEffect === "quantity" ? { actualQuantities: source.items.map(row => row.actualQuantity) } : undefined);
  invoice.number = purchase ? voucher.number : source.sourceVoucherNumber;
  invoice.originalLineMap = originalLineMap;
  invoice.items.forEach((line, index) => {
    if (native && line.taxablePaise !== source.items[index].valuePaise) throw new Error("Source note quantities, rate and discount do not equal its item amount");
    if (!native) source.items[index].valuePaise = line.taxablePaise;
  });
  for (const head of GST_COMPONENTS) if (source.taxes[`${head}Paise`] && source.taxes[`${head}Paise`] !== invoice.totals[`${head}Paise`]) throw new Error(`Source note ${head.toUpperCase()} does not reconcile to the linked original's rate`);
  source.taxablePaise = invoice.totals.taxablePaise; source.taxPaise = invoice.totals.taxPaise; source.itemValuePaise = invoice.totals.taxablePaise; source.unresolvedAdjustmentsPaise = source.totalPaise - invoice.totals.totalPaise; source.classification = "reviewed";
  const postingRoles = voucher.lines.map(line => {
    const role = rolesFor(source.direction).find(role => mapping.accounts[role] === line.ledgerId);
    if (!role) throw new Error("Assign one exact reviewed GST role to every original note posting");
    const name = context.ledgers.get(line.ledgerId)?.name || "", statedHead = GST_COMPONENTS.find(head => new RegExp(`\\b${head}\\b`, "i").test(name));
    if (statedHead && statedHead !== role || purchase && GST_COMPONENTS.includes(role) && /\boutput\b/i.test(name)) throw new Error(`Source ${name} cannot be mapped to ${role}`);
    return role;
  });
  if (!voucher.gst?.tallyOrigin && company.stock?.journals?.some(row => row.accountingVoucherId === voucher.id)) throw new Error("This source note already has an independent stock movement; review it before GST activation");
  const { journal, stockLineMap } = tallyStock.buildTallyNoteStockJournal(company, voucher, records, { recordId: record.recordId, direction: source.direction, type: source.type, stockEffect: review.stockEffect, originalInvoiceId: original.id, originalInvoice: original, originalLineMap, items: invoice.items, sourceItems: source.items });
  const references = sourceReferences(source.transport), discrepancies = [];
  if (mapping.sourceCorrections?.placeOfSupply) discrepancies.push({ code: "source-note-fact-corrected", message: `Place of supply: source discrepancy corrected by explicit review: ${mapping.sourceCorrections.placeOfSupply}`, sourceValue: source.placeOfSupply, mappedValue: original.placeOfSupply });
  for (const [field, supplied, chosen] of [["originalNumber", source.originalDocument.sourceNumber, review.originalNumber], ["originalDate", source.originalDocument.sourceDate, review.originalDate], ...(purchase ? [["supplierNoteNumber", source.supplierDocument.sourceNumber, source.sourceInvoiceNumber], ["supplierNoteDate", source.supplierDocument.sourceDate, source.sourceInvoiceDate]] : [])]) {
    if (!supplied || supplied !== chosen) discrepancies.push({ code: supplied ? "source-note-fact-corrected" : "source-note-fact-absent", message: supplied ? `${field}: explicitly corrected from named note evidence: ${mapping.sourceCorrections[field]}` : `${field}: confirmed by named note evidence and the linked original`, sourceValue: supplied, mappedValue: chosen });
  }
  invoice.tallyOrigin = { version: 3, recordId: record.recordId, sourceHash, recordHash: digest({ type: record.type, node: record.node }), originalInvoiceNumber: source.sourceVoucherNumber, internalVoucherNumber: voucher.number, originalPostingType: voucher.type, statutoryType: source.type,
    postingHash: postingHash(voucher), postings: structuredClone(voucher.lines), postingRoles, accounts: structuredClone(mapping.accounts), mappingHash: digest(mapping), evidence: structuredClone(mapping.evidence), source: structuredClone(source), taxFactReview, sourceReferences: references, sourceReferenceHash: digest(references), sourceReferenceStatus: "source-unverified", stockMode: review.stockEffect === "none" ? "financial-only" : "source", stockJournalId: journal?.id || null, stockJournalHash: journal ? digest(journal) : null, stockLineMap,
    originalInvoiceId: original.id, originalInvoiceHash: digest(original), originalLineMap, noteReview: structuredClone(review), discrepancies };
  const promoted = { ...voucher, gst: invoice }, checkedCompany = journal ? { ...company, stock: { ...company.stock, journals: [...(company.stock?.journals || []).filter(row => row.id !== journal.id), journal] } } : company;
  assertGstSnapshot(checkedCompany, promoted);
  assertGstReferences(invoice, vouchers.filter(row => row.id !== voucher.id));
  assertTallyGstNoteFamily(vouchers, promoted);
  return { promoted, source, discrepancies, stockJournal: journal };
}
function assertReviewedNoteAllocations(invoice) {
  const origin = invoice.tallyOrigin, source = origin.source, review = origin.noteReview;
  if (source.note !== true || !Array.isArray(origin.originalLineMap) || typeof source.noteInventory !== "boolean" || !Array.isArray(source.items) || source.items.length !== invoice.items.length || review.lines.length !== invoice.items.length || review.direction !== invoice.direction || review.stockEffect !== invoice.stockEffect || review.originalInvoiceId !== invoice.originalInvoiceId || source.sourceVoucherDate !== invoice.date || source.originalDocument?.chosenNumber !== invoice.originalNumber || source.originalDocument?.chosenDate !== invoice.originalDate) throw new Error("The preserved note review differs from its statutory identity or allocations");
  if (invoice.direction === "sales" && (source.sourceInvoiceNumber !== invoice.number || source.sourceInvoiceDate !== invoice.date)) throw new Error("The issued source note identity differs from its GST snapshot");
  if (!source.noteInventory && (invoice.stockEffect !== "none" || review.lines.some(row => row.sourceLineIndex !== undefined))) throw new Error("Financial note allocations cannot acquire a native inventory basis");
  const itemDebit = (invoice.direction === "purchase") !== (invoice.type === "Credit Note");
  for (const [index, item] of invoice.items.entries()) {
    const row = source.items[index];
    const matches = source.noteInventory ? review.lines.filter(line => line.sourceLineIndex === index) : [review.lines[index]];
    if (matches.length !== 1 || matches[0].originalLineIndex !== origin.originalLineMap[index]) throw new Error("The note review and original line map no longer describe the same allocations");
    if (!row || row.quantity !== item.quantity || row.unitPricePaise !== item.unitPricePaise || row.discountBps !== item.discountBps || row.valuePaise !== item.taxablePaise || key(row.sourceName) !== key(item.name) || key(row.unit) !== key(item.unit)) throw new Error("Preserved source note values differ from the calculated GST line");
    const allocation = matches[0];
    if (!source.noteInventory) {
      if (allocation.quantity !== item.quantity || allocation.unitPricePaise !== item.unitPricePaise || allocation.discountBps !== item.discountBps || row.originalLineIndex !== allocation.originalLineIndex || row.basis !== "reviewed-financial-allocation" || row.actualQuantity !== null) throw new Error("The explicit financial note evidence differs from its saved allocation");
    } else if (row.basis !== "source-inventory" || row.sourceAmountPaise !== (itemDebit ? -1 : 1) * item.taxablePaise || !/^(yes|no|true|false|1|0)$/i.test(row.sourceDirectionFlag) || /^(yes|true|1)$/i.test(row.sourceDirectionFlag) !== itemDebit) throw new Error("The preserved native note amount or direction changed");
  }
}
export function tallyGstNotePostingLines(invoice) {
  const origin = invoice.tallyOrigin, purchase = invoice.direction === "purchase", reducing = invoice.type === "Credit Note";
  const nativeType = purchase ? reducing ? "Debit Note" : "Credit Note" : invoice.type;
  if (!origin || origin.version !== 3 || !["Credit Note", "Debit Note"].includes(invoice.type) || !["sales", "purchase"].includes(invoice.direction) || invoice.reverseCharge || invoice.supplyCategory !== "domestic" || origin.originalPostingType !== nativeType || origin.statutoryType !== invoice.type || origin.source?.direction !== invoice.direction || origin.source.type !== invoice.type || !Array.isArray(origin.postings) || !origin.postings.length || origin.postingRoles?.length !== origin.postings.length) throw new Error("Invalid reviewed Tally GST note linkage");
  const roles = rolesFor(invoice.direction), itemDebit = purchase !== reducing, totals = Object.fromEntries(roles.map(role => [role, 0n]));
  for (const [index, line] of origin.postings.entries()) {
    const role = origin.postingRoles[index], expectedSide = (role === "party" ? !itemDebit : itemDebit) ? "Dr" : "Cr";
    if (!roles.includes(role) || line.dc !== expectedSide || !Number.isSafeInteger(line.paise) || line.paise <= 0 || origin.accounts?.[role] !== line.ledgerId) throw new Error("Every source note posting needs one exact role and debit/credit direction");
    totals[role] += BigInt(line.paise);
  }
  for (const role of roles) if (totals[role] !== BigInt(role === "party" ? invoice.totals.totalPaise : ["sales", "purchase"].includes(role) ? invoice.totals.taxablePaise : invoice.totals[`${role}Paise`])) throw new Error(`Reviewed note ${role} postings do not equal its GST totals`);
  if (origin.originalInvoiceNumber !== origin.source.sourceVoucherNumber || origin.accounts.party !== (purchase ? invoice.party.supplierLedgerId : invoice.party.customerLedgerId) || invoice.number !== (purchase ? origin.internalVoucherNumber : origin.originalInvoiceNumber) || origin.postingHash !== postingHash({ ...invoice, type: nativeType, number: origin.internalVoucherNumber, lines: origin.postings })) throw new Error("The original accounting note identity or posting changed");
  if (purchase && (invoice.itcEligibility !== "pending" || origin.noteReview?.supplierDocumentConfirmed !== true || invoice.supplierInvoiceNumber !== origin.source.sourceInvoiceNumber.toUpperCase() || invoice.supplierInvoiceDate !== origin.source.sourceInvoiceDate || !isIsoDate(invoice.supplierInvoiceDate) || invoice.supplierInvoiceDate > invoice.date)) throw new Error("The actual supplier GST note evidence or pending ITC treatment changed");
  if (!isDeepStrictEqual(origin.sourceReferences, sourceReferences(origin.source.transport || {})) || origin.sourceReferenceHash !== digest(origin.sourceReferences) || origin.sourceReferenceStatus !== "source-unverified" || !isDeepStrictEqual(invoice.originalLineMap, origin.originalLineMap) || !isDeepStrictEqual(normalizeTallyNoteReview(origin.noteReview), origin.noteReview)) throw new Error("The reviewed note references or original-line allocation changed");
  assertReviewedNoteAllocations(invoice);
  return structuredClone(origin.postings);
}
export function assertTallyGstNoteFamily(vouchers, voucher) {
  const invoice = voucher.gst, origin = invoice?.tallyOrigin;
  if (origin?.version !== 3) return;
  const originalVoucher = vouchers.find(row => row.gst?.id === invoice.originalInvoiceId), original = originalVoucher?.gst;
  if (!original || !["Sales", "Purchase"].includes(original.type) || origin.originalInvoiceId !== invoice.originalInvoiceId || origin.originalInvoiceHash !== digest(original) || original.registrationId !== invoice.registrationId || original.partyId !== invoice.partyId || original.direction !== invoice.direction || origin.noteReview.originalInvoiceId !== original.id || origin.noteReview.originalNumber !== invoice.originalNumber || origin.noteReview.originalDate !== invoice.originalDate) throw new Error("The source note must retain its unchanged verified original GST invoice and legal reference");
  if (voucher.type !== origin.originalPostingType || origin.originalLineMap.length !== invoice.items.length || origin.originalLineMap.some((index, lineIndex) => !Number.isSafeInteger(index) || index < 0 || !original.items[index] || ["itemId", "hsnSac", "unit", "gstRateBps", "cessRateBps", "supplyStatus"].some(field => invoice.items[lineIndex][field] !== original.items[index][field]))) throw new Error("The note's underlying voucher type or original HSN/rate line identity changed");
  assertGstReferences(invoice, vouchers.filter(row => row.id !== voucher.id));
}
export function assertTallyGstNoteStockLink(company, voucher) {
  const invoice = voucher.gst, origin = invoice.tallyOrigin;
  const linked = (company.stock?.journals || []).filter(row => row.accountingVoucherId === voucher.id);
  if (origin.stockMode === "financial-only") {
    if (invoice.stockEffect !== "none" || origin.stockJournalId !== null || origin.stockJournalHash !== null || !Array.isArray(origin.stockLineMap) || origin.stockLineMap.length || linked.length || origin.source.items.some(row => row.actualQuantity !== null && quantityMicros(row.actualQuantity, true) !== 0n)) throw new Error("A financial-only source note cannot create or hide a physical stock movement");
    return null;
  }
  const purchase = invoice.direction === "purchase", reducing = invoice.type === "Credit Note", inward = purchase !== reducing;
  const journal = linked.find(row => row.id === origin.stockJournalId);
  const kind = purchase ? reducing ? "purchase-return" : "purchase" : reducing ? "sales-return" : "sale";
  if (origin.stockMode !== "source" || invoice.stockEffect !== "quantity" || linked.length !== 1 || !journal || journal.type !== (inward ? "receipt" : "issue") || journal.financialKind !== kind || journal.sourceRef !== `tally-note:${origin.recordId}` || journal.originalSourceId !== invoice.originalInvoiceId || journal.date !== voucher.date || journal.number !== origin.originalInvoiceNumber || digest(journal) !== origin.stockJournalHash || origin.stockLineMap.length !== journal.lines.length) throw new Error("The source GST note needs its one unchanged reviewed physical movement");
  const totals = invoice.items.map(() => ({ q: 0n, b: 0n, v: 0n }));
  journal.lines.forEach((line, index) => {
    const target = origin.stockLineMap[index], item = invoice.items[target];
    if (!Number.isSafeInteger(target) || !item || item.kind !== "goods" || line.itemId !== item.itemId || line.sourceLineIndex !== target || line.originalLineIndex !== origin.originalLineMap[target] || !Number.isSafeInteger(line.sourceValuePaise) || line.sourceValuePaise < 0) throw new Error("Source note stock lines differ from their original item allocation");
    totals[target].q += quantityMicros(line.quantity); totals[target].b += quantityMicros(line.billedQuantity || line.quantity, true); totals[target].v += BigInt(line.sourceValuePaise);
  });
  totals.forEach((row, index) => {
    const source = origin.source.items[index];
    if (!source?.actualQuantity || row.q !== quantityMicros(source.actualQuantity) || row.b !== quantityMicros(invoice.items[index].quantity) || row.v !== BigInt(invoice.items[index].taxablePaise)) throw new Error("Physical, billed and monetary source note quantities do not reconcile");
  });
  return journal;
}
