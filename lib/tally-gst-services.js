import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { buildGstInvoice, assertGstSnapshot, GST_COMPONENTS, quantityMicros, formatQuantity } from "./gst.js";
import { isIsoDate } from "./money.js";
import * as tallyStock from "./tally-stock.js";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = value => String(value || "").trim().toLocaleLowerCase("en-IN");
const posting = voucher => ({ type: voucher.type, date: voucher.date, number: voucher.number, narration: voucher.narration, lines: voucher.lines });
const postingHash = voucher => digest(posting(voucher));
const serviceRole = row => `service:${row.sourceLineId}`;
const sourceReferences = transport => ({ irn: transport.IRN || "", acknowledgementNumber: transport.IRNACKNO || transport.ACKNO || "", acknowledgementDate: transport.IRNACKDATE || transport.ACKDATE || "", ewayBillNumber: transport.EWAYBILLNUMBER || "", ewayBillDate: transport.EWAYBILLDATE || "" });
function text(value, label, maximum = 120) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`Enter ${label} within ${maximum} characters`);
  return value.trim();
}
function inGroup(company, ledgerId, groups) {
  let group = company.ledgers.find(row => row.id === ledgerId)?.groupId;
  const seen = new Set();
  while (group && !seen.has(group)) {
    if (groups.includes(group)) return true;
    seen.add(group);
    group = company.groups.find(row => row.id === group)?.parentId;
  }
  return false;
}
export function normalizeTallyServiceMappings(input) {
  if (!Array.isArray(input) || input.length > 500 || new Set(input.map(row => row?.sourceLineId)).size !== input.length) throw new Error("Map every service source row once");
  return input.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(field => !["sourceLineId", "itemId", "classificationConfirmed", "completionReview"].includes(field)) || !/^ledger-entry:\d{1,8}$/.test(row.sourceLineId || "")) throw new Error("Choose an immutable source service row");
    const result = { sourceLineId: row.sourceLineId, itemId: text(row.itemId, "the GST service item", 48) };
    if (row.classificationConfirmed !== undefined) {
      if (typeof row.classificationConfirmed !== "boolean") throw new Error("Explicitly review the service classification");
      result.classificationConfirmed = row.classificationConfirmed;
    }
    if (row.completionReview !== undefined) {
      const review = row.completionReview;
      if (!review || typeof review !== "object" || Array.isArray(review) || Object.keys(review).some(field => !["status", "date", "reference"].includes(field)) || !["confirmed", "pending"].includes(review.status)) throw new Error("Record confirmed or pending service receipt/completion evidence");
      result.completionReview = { status: review.status };
      if (review.status === "confirmed") {
        if (!isIsoDate(review.date)) throw new Error("Enter the actual evidenced service completion date");
        result.completionReview.date = review.date;
        result.completionReview.reference = text(review.reference, "the dated service receipt/completion evidence", 500);
      } else {
        if (review.date) throw new Error("A pending service cannot assert an actual receipt date");
        if (review.reference) result.completionReview.reference = text(review.reference, "the pending service review reference", 500);
      }
    }
    return result;
  });
}
function factValue(fact, localValue, field, mapping, reviews, allowSource = true) {
  const reason = mapping.sourceCorrections?.[field];
  if (fact.status === "conflict" && !reason || fact.status === "supplied" && !allowSource && fact.value !== localValue && !reason) throw new Error(`${field}: supplied source facts require explicit review or a correction reason`);
  const chosen = fact.status === "supplied" && allowSource && !reason ? fact.value : localValue;
  reviews.push({ field, status: fact.status === "absent" ? "absent" : reason ? "corrected" : "matching", chosenBasis: fact.status === "supplied" && !reason ? "source" : "local-mapping", chosenValue: chosen, localMasterValue: localValue, sourceValue: fact.value, ...(reason ? { reason } : {}), evidence: structuredClone(fact.evidence), superseded: structuredClone(fact.superseded), issues: [...fact.issues] });
  return chosen;
}
function goodsLineMap(journal, source, invoice) {
  let index = 0, allocated = 0n;
  return (journal?.lines || []).map(line => {
    const row = source.items[index], item = invoice.items[index];
    if (!row || row.kind !== "goods" || !item || item.itemId !== line.itemId) throw new Error("Original goods stock rows no longer follow their source inventory order");
    const target = index;
    allocated += quantityMicros(line.quantity);
    const actual = quantityMicros(row.actualQuantity);
    if (allocated > actual) throw new Error("The original goods stock split exceeds its actual source quantity");
    if (allocated === actual) { index++; allocated = 0n; }
    return target;
  });
}
export function buildTallyGstServicePromotion(company, vouchers, records, record, mapping, sourceHash, context, source) {
  const voucher = context.vouchers.get(record.voucherId), purchase = voucher.type === "Purchase";
  const services = source.items.filter(row => row.kind === "service"), goods = source.items.filter(row => row.kind === "goods");
  if (!services.length) throw new Error("Confirm the actual service source classification from named evidence; a generic income or Purchase ledger is not a service by inference");
  if (source.serviceIssues.length) throw new Error(source.serviceIssues.map(row => row.message).join("; "));
  if (source.serviceCandidates.length) throw new Error("Review every unclassified source amount before treating it as a service or activating this invoice");
  const registration = context.registrations.get(mapping.registrationId), party = context.parties.get(mapping.partyId);
  if (!registration || !party || (purchase ? party.supplierLedgerId : party.customerLedgerId) !== source.partyLedgerId || mapping.accounts.party !== source.partyLedgerId) throw new Error("The service invoice must retain its original supplier or customer party ledger");
  if ((source.gstin || (purchase ? source.taxFacts.sellerGstin : source.taxFacts.buyerGstin).status === "supplied") && !party.gstin) throw new Error("A registered source party cannot silently become an unregistered party");
  if (purchase && (!source.sourceInvoiceNumber || !isIsoDate(source.sourceInvoiceDate) || !source.placeOfSupply)) throw new Error("Confirm the actual supplier document number, date and explicit place of supply");
  if (!purchase && mapping.purchaseReview) throw new Error("Purchase receipt details do not apply to an issued service sale");
  if (!goods.length && (mapping.stockMode !== "financial-only" || source.receivedDate)) throw new Error("Pure services use amount-only financial reporting and service evidence, not a goods receipt or stock movement");
  if (goods.length && !["source", "report-only"].includes(mapping.stockMode)) throw new Error("Choose the original goods stock basis separately from the service amounts");
  if (mapping.serviceItems?.length !== services.length || services.some(row => !mapping.serviceItems.some(item => item.sourceLineId === row.sourceLineId))) throw new Error("Map every actual source service row to its GST service item exactly once");
  const goodsNames = new Set(goods.map(row => key(row.sourceName)));
  if (mapping.items.length !== goodsNames.size || mapping.items.some(row => !goodsNames.has(key(row.sourceName)))) throw new Error("Map only the unique native goods rows in the goods section");
  const taxFactReview = [];
  factValue(source.taxFacts.sellerGstin, purchase ? party.gstin : registration.gstin, "sellerGstin", mapping, taxFactReview, false);
  factValue(source.taxFacts.buyerGstin, purchase ? registration.gstin : party.gstin, "buyerGstin", mapping, taxFactReview, false);
  const overrides = new Map(), serviceItems = [];
  const items = source.items.map((row, index) => {
    const service = row.kind === "service";
    const selected = service ? mapping.serviceItems.find(item => item.sourceLineId === row.sourceLineId) : mapping.items.find(item => key(item.sourceName) === key(row.sourceName));
    const master = context.gstItems.get(selected?.itemId), stock = context.stockItems.get(selected?.itemId);
    if (!master || master.kind !== row.kind) throw new Error(`Choose a ${row.kind} GST item for ${row.sourceName}`);
    if (service) {
      if (master.stockItemId || key(master.unit) !== "oth") throw new Error("Amount-only source services need a non-stock service master with unit OTH");
      if (row.classificationRequired && selected.classificationConfirmed !== true) throw new Error("Explicitly confirm the unexported service classification against named evidence");
      if (purchase && !selected.completionReview) throw new Error("Explicitly record confirmed or pending receipt for each purchased service");
      serviceItems.push({ ...structuredClone(selected), sourceLedgerId: row.sourceLedgerId, invoiceLineIndex: index });
    } else if (!stock || master.stockItemId !== stock.id || key(master.name) !== key(row.sourceName) || key(master.unit) !== key(row.unit)) throw new Error("Goods must retain their original stock identity, name and simple unit");
    const facts = source.taxFacts.items[index], prefix = service ? `service:${row.sourceLineId}:` : `item:${row.sourceName}:`;
    const hsnSac = factValue(facts.hsnSac, master.hsnSac, prefix + "hsnSac", mapping, taxFactReview);
    const gstRateBps = factValue(facts.gstRateBps, master.gstRateBps, prefix + "gstRateBps", mapping, taxFactReview);
    const kind = factValue(facts.supplyType, master.kind, prefix + "supplyType", mapping, taxFactReview);
    const supplyStatus = factValue(facts.taxability, master.supplyStatus, prefix + "taxability", mapping, taxFactReview);
    if (kind !== row.kind || supplyStatus !== "taxable" || master.cessRateBps || service && !/^99\d{4}$/.test(hsnSac)) throw new Error("Source services need a valid six-digit SAC and regular domestic taxable classification without cess");
    const prior = overrides.get(master.id);
    if (prior && ["hsnSac", "kind", "unit"].some(field => prior[field] !== ({ hsnSac, kind, unit: master.unit })[field])) throw new Error("Distinct source classifications require separate GST item identities");
    overrides.set(master.id, { ...master, hsnSac, gstRateBps, kind, supplyStatus });
    return { itemId: master.id, quantity: row.quantity, unitPricePaise: row.unitPricePaise, discountBps: row.discountBps || 0, gstRateBps, supplyStatus };
  });
  const invoiceCompany = { ...company, gst: { ...company.gst, items: company.gst.items.map(item => overrides.get(item.id) || item) } };
  const invoice = buildGstInvoice(invoiceCompany, vouchers.filter(row => row.id !== voucher.id), { type: voucher.type, registrationId: registration.id, partyId: party.id, number: purchase ? voucher.number : source.sourceInvoiceNumber, date: voucher.date, narration: voucher.narration, placeOfSupply: source.placeOfSupply, pricing: "exclusive", stockEffect: goods.length && mapping.stockMode === "source" ? "quantity" : "none",
    ...(purchase ? { supplierInvoiceNumber: source.sourceInvoiceNumber, supplierInvoiceDate: source.sourceInvoiceDate, itcEligibility: "pending" } : {}), items }, voucher.id);
  invoice.number = purchase ? voucher.number : source.sourceInvoiceNumber;
  if (purchase && goods.length) invoice.receivedDate = source.receivedDate;
  invoice.items.forEach((line, index) => { if (line.taxablePaise !== source.items[index].valuePaise) throw new Error(`Source row ${index + 1} does not reconcile to its declared goods or amount-only service basis`); });
  for (const head of GST_COMPONENTS) if (source.taxes[`${head}Paise`] && source.taxes[`${head}Paise`] !== invoice.totals[`${head}Paise`]) throw new Error(`The identifiable source ${head.toUpperCase()} does not reconcile to the invoice`);
  const accounts = structuredClone(mapping.accounts), servicePostings = new Map();
  for (const row of services) {
    const role = serviceRole(row);
    accounts[role] = row.sourceLedgerId;
    for (const index of row.sourcePostingIndexes) {
      if (servicePostings.has(index)) throw new Error("A source posting cannot belong to two service rows");
      servicePostings.set(index, role);
    }
  }
  if (!goods.length && (accounts.sales || accounts.purchase)) throw new Error("Pure service invoices use their original service ledgers; omit the goods base posting role");
  const postingRoles = voucher.lines.map((line, index) => {
    const role = servicePostings.get(index) || ["party", purchase ? "purchase" : "sales", ...GST_COMPONENTS].find(role => accounts[role] === line.ledgerId);
    if (!role) throw new Error(`Assign every non-service source posting its exact goods, party or tax role: ${context.ledgers.get(line.ledgerId)?.name || line.ledgerId}`);
    const name = context.ledgers.get(line.ledgerId)?.name || "", stated = GST_COMPONENTS.find(head => new RegExp(`\\b${head}\\b`, "i").test(name));
    if (stated && stated !== role || purchase && GST_COMPONENTS.includes(role) && /\boutput\b/i.test(name)) throw new Error(`Source ${name} cannot be mapped to ${role}`);
    return role;
  });
  let journal = context.stockJournals.get(voucher.id), stockJournal = null;
  const servicePostingIndexes = [...servicePostings.keys()];
  if (mapping.stockMode !== "source") {
    if (journal || goods.some(row => row.actualQuantity !== null)) throw new Error("Reporting-only goods cannot hide a supplied physical quantity or an existing movement");
  } else {
    if (goods.some(row => row.actualQuantity === null)) throw new Error("Source stock requires the actual exported goods quantities");
    if (!journal || journal.id.startsWith("sj-tally-service-")) {
      const rebuilt = tallyStock.buildTallyServiceStockJournal(company, voucher, records, { recordId: record.recordId, servicePostingIndexes });
      if (journal && !isDeepStrictEqual(journal, rebuilt)) throw new Error("The reviewed goods-only stock projection changed from its original source");
      if (!journal) stockJournal = rebuilt;
      journal = rebuilt;
    }
    if (!journal || ![record.recordId, `tally-service:${record.recordId}`].includes(journal.sourceRef)) throw new Error("An unrelated existing movement cannot become this invoice's goods stock projection");
  }
  source.taxablePaise = invoice.totals.taxablePaise; source.taxPaise = invoice.totals.taxPaise; source.classification = "reviewed";
  source.unresolvedAdjustmentsPaise = source.totalPaise - invoice.totals.totalPaise;
  const references = sourceReferences(source.transport), discrepancies = [];
  for (const fact of taxFactReview) if (["absent", "corrected"].includes(fact.status)) discrepancies.push({ code: `source-tax-fact-${fact.status}`, message: fact.status === "absent" ? `${fact.field}: supplied by the named local review, not exported source facts` : `${fact.field}: corrected by explicit review: ${fact.reason}`, sourceValue: fact.sourceValue ?? "", mappedValue: fact.chosenValue });
  invoice.tallyOrigin = { version: 4, recordId: record.recordId, sourceHash, recordHash: digest({ type: record.type, node: record.node }), originalInvoiceNumber: source.sourceVoucherNumber, internalVoucherNumber: voucher.number, originalPostingType: voucher.type,
    postingHash: postingHash(voucher), postings: structuredClone(voucher.lines), postingRoles, accounts, mappingHash: digest(mapping), evidence: structuredClone(mapping.evidence), source: structuredClone(source), taxFactReview, serviceItems,
    sourceReferences: references, sourceReferenceHash: digest(references), sourceReferenceStatus: "source-unverified", stockMode: mapping.stockMode, stockJournalId: journal?.id || null, stockJournalHash: journal ? digest(journal) : null, stockLineMap: goodsLineMap(journal, source, invoice), discrepancies };
  const promoted = { ...voucher, gst: invoice }, checkedCompany = stockJournal ? { ...company, stock: { ...company.stock, journals: [...company.stock.journals, stockJournal] } } : company;
  assertGstSnapshot(checkedCompany, promoted);
  assertTallyServiceMapping(mapping, invoice);
  return { promoted, source, discrepancies, stockJournal };
}
export function tallyGstServicePostingLines(invoice) {
  const origin = invoice.tallyOrigin, source = origin?.source, purchase = invoice.direction === "purchase";
  if (!origin || origin.version !== 4 || !["sales", "purchase"].includes(invoice.direction) || !["Sales", "Purchase"].includes(invoice.type) || invoice.type !== (purchase ? "Purchase" : "Sales") || invoice.reverseCharge || invoice.supplyCategory !== "domestic" || source?.direction !== invoice.direction || source.type !== invoice.type || source.serviceReview !== true || !Array.isArray(source.items) || source.items.length !== invoice.items.length || !Array.isArray(origin.postings) || !origin.postings.length || origin.postingRoles?.length !== origin.postings.length) throw new Error("Invalid reviewed service invoice linkage");
  const services = source.items.flatMap((row, index) => row.kind === "service" ? [{ row, index }] : []), goods = source.items.filter(row => row.kind === "goods");
  if (!services.length || source.hasGoods !== Boolean(goods.length) || source.serviceOnly !== !goods.length || source.items.some((row, index) => row.kind !== invoice.items[index].kind) || source.items.slice(0, goods.length).some(row => row.kind !== "goods") || source.items.slice(goods.length).some(row => row.kind !== "service")) throw new Error("Service and goods rows lost their explicit source ordering or classification");
  const base = purchase ? "purchase" : "sales", expected = new Map([["party", BigInt(invoice.totals.totalPaise)], [base, goods.reduce((total, _, index) => total + BigInt(invoice.items[index].taxablePaise), 0n)], ...GST_COMPONENTS.map(head => [head, BigInt(invoice.totals[`${head}Paise`])])]);
  const claimedIndexes = new Map();
  for (const { row, index } of services) {
    const item = invoice.items[index], role = serviceRole(row);
    if (expected.has(role) || !/^ledger-entry:\d{1,8}$/.test(row.sourceLineId) || row.sourceKind !== "ledger" || row.quantityBasis !== "amount-only" || row.quantity !== "1" || row.actualQuantity !== null || row.actualBasis !== "not-applicable" || key(row.unit) !== "oth" || item.quantity !== "1" || key(item.unit) !== "oth" || item.discountBps !== 0 || item.unitPricePaise !== row.valuePaise || row.unitPricePaise !== row.valuePaise || row.sourceAmountPaise !== (purchase ? -1 : 1) * row.valuePaise || origin.accounts[role] !== row.sourceLedgerId || !Array.isArray(row.sourcePostingIndexes) || !row.sourcePostingIndexes.length) throw new Error("A source service must retain its amount-only basis and original ledger");
    expected.set(role, BigInt(item.taxablePaise));
    for (const postingIndex of row.sourcePostingIndexes) {
      if (!Number.isSafeInteger(postingIndex) || postingIndex < 0 || claimedIndexes.has(postingIndex) || origin.postings[postingIndex]?.ledgerId !== row.sourceLedgerId || origin.postingRoles[postingIndex] !== role) throw new Error("Every service amount must retain its exact original source posting");
      claimedIndexes.set(postingIndex, role);
    }
  }
  const totals = new Map([...expected.keys()].map(role => [role, 0n]));
  origin.postings.forEach((line, index) => {
    const role = origin.postingRoles[index];
    const side = role === "party" ? purchase ? "Cr" : "Dr" : purchase ? "Dr" : "Cr";
    if (!totals.has(role) || origin.accounts[role] !== line.ledgerId || line.dc !== side || !Number.isSafeInteger(line.paise) || line.paise <= 0 || role.startsWith("service:") && claimedIndexes.get(index) !== role) throw new Error("Each source posting needs one exact party, goods, service or tax role");
    totals.set(role, totals.get(role) + BigInt(line.paise));
  });
  for (const [role, amount] of expected) if (totals.get(role) !== amount) throw new Error(`Reviewed ${role} postings do not reconcile to the calculated invoice`);
  if (Object.keys(origin.accounts).some(role => !expected.has(role))) throw new Error("A reviewed service invoice contains an unrelated posting role");
  if (source.totalPaise !== invoice.totals.totalPaise || source.items.some((row, index) => row.valuePaise !== invoice.items[index].taxablePaise || row.quantity !== invoice.items[index].quantity || row.unitPricePaise !== invoice.items[index].unitPricePaise) || origin.originalPostingType !== invoice.type || origin.originalInvoiceNumber !== source.sourceVoucherNumber || source.sourceVoucherDate !== invoice.date || invoice.number !== (purchase ? origin.internalVoucherNumber : source.sourceInvoiceNumber) || origin.accounts.party !== (purchase ? invoice.party.supplierLedgerId : invoice.party.customerLedgerId) || origin.postingHash !== postingHash({ ...invoice, number: origin.internalVoucherNumber, lines: origin.postings })) throw new Error("The preserved service document, original source values or posting identity changed");
  if (purchase && (invoice.itcEligibility !== "pending" || invoice.supplierInvoiceNumber !== source.sourceInvoiceNumber.toUpperCase() || invoice.supplierInvoiceDate !== source.sourceInvoiceDate)) throw new Error("The supplier service document and pending ITC basis must remain unchanged");
  if (!isDeepStrictEqual(origin.sourceReferences, sourceReferences(source.transport || {})) || origin.sourceReferenceHash !== digest(origin.sourceReferences) || origin.sourceReferenceStatus !== "source-unverified") throw new Error("Preserved source references changed");
  const normalized = normalizeTallyServiceMappings(origin.serviceItems.map(({ sourceLedgerId, invoiceLineIndex, ...row }) => row));
  if (normalized.length !== services.length || origin.serviceItems.some((row, index) => row.sourceLineId !== services[index].row.sourceLineId || row.sourceLedgerId !== services[index].row.sourceLedgerId || row.invoiceLineIndex !== services[index].index || row.itemId !== invoice.items[row.invoiceLineIndex].itemId || purchase && !row.completionReview)) throw new Error("Service receipt/completion evidence lost its source ledger or invoice line linkage");
  return structuredClone(origin.postings);
}
export function assertTallyServiceLedgerGroups(company, voucher) {
  const invoice = voucher.gst, origin = invoice.tallyOrigin, purchase = invoice.direction === "purchase";
  for (const [role, ledgerId] of Object.entries(origin.accounts)) {
    let valid;
    if (role.startsWith("service:")) valid = inGroup(company, ledgerId, purchase ? ["g-purchase", "g-direct-exp", "g-indirect-exp"] : ["g-sales", "g-direct-inc", "g-indirect-inc"]);
    else if (role === "party") valid = inGroup(company, ledgerId, [purchase ? "g-creditors" : "g-debtors"]);
    else if (role === "sales" || role === "purchase") valid = inGroup(company, ledgerId, [role === "sales" ? "g-sales" : "g-purchase"]);
    else if (GST_COMPONENTS.includes(role)) valid = inGroup(company, ledgerId, ["g-duties"]) || purchase && inGroup(company, ledgerId, ["g-current-assets"]) && !inGroup(company, ledgerId, ["g-bank", "g-cash", "g-debtors", "g-stock", "g-deposits", "g-advances"]);
    if (!valid) throw new Error(`The reviewed ${role} posting has an unsupported account group`);
  }
}
export function assertTallyServiceStockLink(company, voucher) {
  const invoice = voucher.gst, origin = invoice.tallyOrigin, source = origin.source, goods = source.items.filter(row => row.kind === "goods");
  const linked = (company.stock?.journals || []).filter(row => row.accountingVoucherId === voucher.id);
  if (!goods.length) {
    if (origin.stockMode !== "financial-only" || invoice.stockEffect !== "none" || invoice.receivedDate !== undefined || linked.length || origin.stockJournalId !== null || origin.stockJournalHash !== null || origin.stockLineMap.length) throw new Error("A pure service invoice cannot invent a goods receipt or stock movement");
    return null;
  }
  if (origin.stockMode === "report-only") {
    if (invoice.stockEffect !== "none" || linked.length || origin.stockJournalId !== null || origin.stockJournalHash !== null || origin.stockLineMap.length || goods.some(row => row.actualQuantity !== null) || company.stock?.tally?.hasSourceGaps !== true) throw new Error("Goods reporting-only mode must retain unresolved physical quantities without hiding stock");
    return null;
  }
  const purchase = invoice.direction === "purchase", journal = linked.find(row => row.id === origin.stockJournalId);
  if (purchase && (invoice.receivedDate !== source.receivedDate || source.receivedDate && (!isIsoDate(source.receivedDate) || source.receivedDate > invoice.date))) throw new Error("The mixed invoice goods receipt date changed independently of its original source review");
  if (origin.stockMode !== "source" || invoice.stockEffect !== "quantity" || linked.length !== 1 || !journal || journal.type !== (purchase ? "receipt" : "issue") || journal.financialKind !== (purchase ? "purchase" : "sale") || ![origin.recordId, `tally-service:${origin.recordId}`].includes(journal.sourceRef) || journal.date !== voucher.date || journal.number !== origin.originalInvoiceNumber || digest(journal) !== origin.stockJournalHash || origin.stockLineMap.length !== journal.lines.length) throw new Error("A mixed invoice must retain its one exact original goods-only movement");
  const totals = goods.map(() => ({ q: 0n, b: 0n, v: 0n }));
  journal.lines.forEach((line, index) => {
    const target = origin.stockLineMap[index], item = invoice.items[target], amount = purchase ? line.valuePaise : line.revenuePaise;
    if (!Number.isSafeInteger(target) || !item || item.kind !== "goods" || !totals[target] || line.itemId !== item.itemId || !Number.isSafeInteger(amount) || amount < 0) throw new Error("A service row cannot acquire a goods stock allocation");
    totals[target].q += quantityMicros(line.quantity); totals[target].b += quantityMicros(line.billedQuantity || line.quantity); totals[target].v += BigInt(amount);
  });
  totals.forEach((row, index) => {
    if (row.q !== quantityMicros(source.items[index].actualQuantity) || row.b !== quantityMicros(invoice.items[index].quantity) || row.v !== BigInt(invoice.items[index].taxablePaise)) throw new Error("Original goods physical, billed and cost/revenue amounts do not reconcile independently of services");
  });
  return journal;
}
export function assertTallyServiceMapping(mapping, invoice) {
  const origin = invoice.tallyOrigin;
  const saved = origin.serviceItems.map(({ sourceLedgerId, invoiceLineIndex, ...row }) => row);
  const reviewed = normalizeTallyServiceMappings(mapping.serviceItems);
  if (reviewed.length !== saved.length || reviewed.some(row => !isDeepStrictEqual(row, saved.find(item => item.sourceLineId === row.sourceLineId)))) throw new Error("The immutable service receipt/classification mapping changed after activation");
  for (const entry of origin.serviceItems) {
    const row = origin.source.items[entry.invoiceLineIndex];
    if (!row || row.kind !== "service" || row.sourceLineId !== entry.sourceLineId || row.sourceLedgerId !== entry.sourceLedgerId || invoice.items[entry.invoiceLineIndex].itemId !== entry.itemId) throw new Error("Service mapping and source ledger identity no longer describe the same invoice line");
  }
}
