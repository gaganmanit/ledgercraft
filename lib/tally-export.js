import { createHash } from "node:crypto";
import { isIsoDate } from "./money.js";
import { validateTransfer } from "./transfer.js";
import { reviewedGstLineXml, tallyStockMastersXml, tallyStockVoucherXml, tallyStockJournalsXml } from "./tally-stock.js";
import { GST_STATES } from "./gst.js";
import { keyName, value } from "./tally-format.js";
import { tallyAmount } from "./tally-values.js";

function xml(input) {
  const text = String(input ?? "");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(text)) throw new Error("A name or narration contains a character that cannot be represented in accounting XML");
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]));
}

export function tallyRupees(paise, dc) {
  if (!Number.isSafeInteger(paise) || paise < 0 || !["Dr", "Cr"].includes(dc)) throw new Error("A posting contains an invalid paise amount");
  const amount = BigInt(paise);
  return `${dc === "Dr" && amount ? "-" : ""}${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`;
}

function envelope(company, reportName, content) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${reportName}</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xml(company.name)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${content}</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`;
}

const promotedPurchase = voucher => voucher.gst?.tallyOrigin?.version === 2 && voucher.gst.direction === "purchase" && voucher.gst.type === "Purchase";
const promotedService = voucher => voucher.gst?.tallyOrigin?.version === 4;
const promotedNote = voucher => voucher.gst?.tallyOrigin?.version === 3;
function linkedSalesEvidence(vouchers, selected = vouchers) {
  const result = new Map();
  for (const note of selected.filter(promotedNote)) {
    const original = vouchers.find(row => row.gst?.id === note.gst.originalInvoiceId);
    if (!original?.gst?.tallyOrigin || original.gst.type !== "Sales" || !selected.some(row => row.id === original.id)) continue;
    const proof = note.gst.tallyOrigin.source.originalExportEvidence;
    if (!proof || proof.originalInvoiceId !== original.gst.id || !proof.sourceVoucherType || !Array.isArray(proof.exportUnsupportedAllocations) || !Array.isArray(proof.exportBillAllocations)) throw new Error("Linked original Sales XML lacks complete source allocation evidence; use the full source archive");
    if (result.has(original.id) && JSON.stringify(result.get(original.id)) !== JSON.stringify(proof)) throw new Error("Linked original Sales XML has conflicting source evidence; use the full source archive");
    result.set(original.id, proof);
  }
  return result;
}
const gstState = code => {
  const state = GST_STATES.find(state => state.code === code);
  if (!state) throw new Error("Purchase XML needs a supported reviewed GST state");
  return state.name;
};
// Tally item invoice and GST field contracts: https://help.tallysolutions.com/sample-xml/
// https://help.tallysolutions.com/what-are-the-changes-in-xml-tags/
// Per-document overrides retain historical HSN/rates; destination masters only establish
// the stock/account identities, supplier registrations and represented tax-ledger heads.
function purchaseMasterDetails(vouchers, company, salesEvidence = linkedSalesEvidence(vouchers)) {
  const details = new Map(), types = new Map(), dutyHeads = { cgst: "Central Tax", sgst: "State Tax", utgst: "UT Tax", igst: "Integrated Tax" };
  const detail = id => { if (!details.has(id)) details.set(id, { registrations: new Map(), heads: new Set() }); return details.get(id); };
  for (const voucher of vouchers.filter(voucher => promotedPurchase(voucher) || promotedNote(voucher) || promotedService(voucher) || salesEvidence.has(voucher.id))) {
    const invoice = voucher.gst, origin = invoice.tallyOrigin;
    const proof = salesEvidence.get(voucher.id) || origin.source;
    const type = proof.sourceVoucherType, parent = promotedNote(voucher) ? voucher.type : invoice.type;
    if (!type) throw new Error("Source XML lacks its original voucher type; use the full source archive");
    if (type.toLowerCase() !== parent.toLowerCase()) {
      if (types.has(type) && types.get(type) !== parent) throw new Error("Source XML voucher types have conflicting accounting parents; use the full source archive");
      types.set(type, parent);
    }
    const party = detail(origin.accounts.party), date = (invoice.supplierInvoiceDate || invoice.date).replaceAll("-", "");
    const prior = party.registrations.get(date);
    if (prior && prior.gstin !== invoice.party.gstin) throw new Error("Purchase XML has conflicting supplier registrations on one date; use the full source archive");
    party.registrations.set(date, { gstin: invoice.party.gstin, state: gstState(invoice.party.stateCode) });
    if (!promotedPurchase(voucher) && !promotedService(voucher) && proof.exportBillAllocations?.length) throw new Error("Source note or linked original Sales XML bill allocations need their full source archive");
    const billPostings = new Set((origin.source.exportBillAllocations || []).filter(row => origin.postingRoles[row.postingIndex] === "party").map(row => row.postingIndex));
    for (const index of billPostings) { purchaseBillsXml(company, voucher, index); party.billwise = true; }
    for (const [role, head] of Object.entries(dutyHeads)) if (origin.accounts[role] && invoice.totals[`${role}Paise`]) detail(origin.accounts[role]).heads.add(head);
  }
  for (const entry of details.values()) if (entry.heads.size > 1 || entry.heads.size && entry.registrations.size) throw new Error("Purchase XML has conflicting ledger tax roles; use the full source archive");
  return { details, types };
}
function purchaseLedgerMasterXml(detail) {
  if (!detail) return "";
  const duty = detail.heads.size ? `<TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>${[...detail.heads][0]}</GSTDUTYHEAD>` : "";
  const registrations = [...detail.registrations].sort(([a], [b]) => a.localeCompare(b)).map(([date, row]) => `<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>${date}</APPLICABLEFROM><GSTIN>${xml(row.gstin)}</GSTIN><STATE>${xml(row.state)}</STATE></LEDGSTREGDETAILS.LIST>`).join("");
  return duty + registrations + (detail.billwise ? "<ISBILLWISEON>Yes</ISBILLWISEON>" : "");
}
// Party contact and GST details: a single linked GST party wins, otherwise the details
// retained from the original Tally ledger. Tally's own "Not Applicable" markers and
// values with control characters are left out rather than failing the export.
const usable = (text) => typeof text === "string" && text.trim() && !/[\u0000-\u001F\uFFFE\uFFFF]/.test(text) ? text.trim() : "";
function partyXml(company, ledger) {
  const retained = ledger.tally || {};
  const linked = (company.gst?.parties || []).filter((party) => party.customerLedgerId === ledger.id || party.supplierLedgerId === ledger.id);
  const native = linked.length === 1 ? linked[0] : null;
  const gstin = usable(native ? native.gstin : retained.gstin);
  const state = usable(native ? GST_STATES.find((row) => row.code === native.stateCode)?.name : retained.state);
  const list = (tag, values) => { const rows = (Array.isArray(values) ? values : [values]).map(usable).filter(Boolean); return rows.length ? `<${tag}.LIST TYPE="String">${rows.map((row) => `<${tag}>${xml(row)}</${tag}>`).join("")}</${tag}.LIST>` : ""; };
  const field = (tag, text) => usable(text) ? `<${tag}>${xml(usable(text))}</${tag}>` : "";
  return list("ADDRESS", native?.address ? String(native.address).split(/\r?\n/) : retained.address) + list("MAILINGNAME", retained.mailingName)
    + field("COUNTRYNAME", retained.country) + field("LEDSTATENAME", state) + field("PINCODE", native?.pincode || retained.pincode)
    + field("INCOMETAXNUMBER", retained.pan) + field("EMAIL", retained.email) + field("LEDGERPHONE", retained.phone)
    + field("GSTREGISTRATIONTYPE", retained.gstRegistrationType) + field("PARTYGSTIN", gstin);
}

export function exportTallyMasters(input,vouchers) {
  // A master-only caller has no voucher history against which to validate journal-linked reviews.
  const masterCopy = vouchers ? input : { ...input, reconciliation:undefined, gst:input.gst && {...input.gst,itc:undefined} };
  const { company, vouchers: checkedVouchers } = validateTransfer({ company:masterCopy,vouchers:vouchers || [] });
  const purchaseMasters = purchaseMasterDetails(checkedVouchers, company);
  const names = new Map(company.groups.map((group) => [group.id, group.name]));
  const byId = new Map(company.groups.map((group) => [group.id, group]));
  const depths = new Map();
  const depth = (group) => {
    const chain = [];
    let current = group;
    while (current && !depths.has(current.id)) { chain.push(current); current = byId.get(current.parentId); }
    let level = current ? depths.get(current.id) : 0;
    for (const entry of chain.reverse()) depths.set(entry.id, ++level);
    return depths.get(group.id);
  };
  const customGroups = company.groups.filter((group) => !group.reserved).sort((a, b) => depth(a) - depth(b) || a.name.localeCompare(b.name));
  const groups = customGroups.map((group) => `<GROUP NAME="${xml(group.name)}" ACTION="Create"><NAME>${xml(group.name)}</NAME><PARENT>${xml(names.get(group.parentId))}</PARENT></GROUP>`).join("");
  const ledgers = company.ledgers.map((ledger) => `<LEDGER NAME="${xml(ledger.name)}" ACTION="Create"><NAME>${xml(ledger.name)}</NAME><PARENT>${xml(names.get(ledger.groupId))}</PARENT>${partyXml(company, ledger)}<OPENINGBALANCE>${tallyRupees(ledger.opening.paise, ledger.opening.dc)}</OPENINGBALANCE><CURRENCYNAME>₹</CURRENCYNAME>${purchaseLedgerMasterXml(purchaseMasters.details.get(ledger.id))}</LEDGER>`).join("");
  const types = [...purchaseMasters.types].sort(([a], [b]) => a.localeCompare(b)).map(([type, parent]) => `<VOUCHERTYPE NAME="${xml(type)}" ACTION="Create"><NAME>${xml(type)}</NAME><PARENT>${xml(parent)}</PARENT></VOUCHERTYPE>`).join("");
  return envelope(company, "All Masters", groups + ledgers + types + tallyStockMastersXml(company, xml));
}

function voucherGuid(companyId, voucher) {
  if (voucher.source?.system === "tally" && voucher.source.guid) return voucher.source.guid;
  const digest = createHash("sha256").update(`financer:${companyId}:${voucher.id}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function purchaseBillsXml(company, voucher, postingIndex) {
  const origin = voucher.gst.tallyOrigin, rows = origin.source.exportBillAllocations;
  if (!Array.isArray(rows)) throw new Error("Purchase XML lacks source allocation evidence; use the full source archive");
  const result = [];
  for (const row of rows.filter(row => row.postingIndex === postingIndex)) {
    const posting = voucher.lines[postingIndex], bill = row.node;
    const fields = new Set(["NAME", "BILLTYPE", "AMOUNT", "BILLDATE", "BILLCREDITPERIOD", "DUEDATE"]);
    if (origin.postingRoles[postingIndex] !== "party" || (posting.dc !== (voucher.gst.direction === "purchase" ? "Cr" : "Dr")) || keyName(bill.tag) !== "BILLALLOCATIONS" || bill.children.some(child => !fields.has(keyName(child.tag)) || child.children.length || Object.keys(child.attrs).some(name => keyName(child.tag) !== "BILLCREDITPERIOD" || !["JD", "P"].includes(name))) || new Set(bill.children.map(child => keyName(child.tag))).size !== bill.children.length || Object.keys(bill.attrs).length || bill.text.trim() || value(bill, "BILLTYPE").toLowerCase() !== "new ref" || !value(bill, "NAME")) throw new Error("Purchase XML cannot represent this source bill allocation; use the full source archive");
    const amount = tallyAmount(value(bill, "AMOUNT"));
    const active = company.reconciliation?.bills?.find(saved => saved.voucherId === voucher.id && saved.ledgerId === posting.ledgerId && saved.reference === value(bill, "NAME") && saved.amountPaise === Math.abs(amount) && (amount < 0) === (posting.dc === "Dr") && saved.origin?.recordId === origin.recordId && (saved.origin.method || "").toLowerCase() === "new ref" && saved.date === saved.origin.date && saved.dueDate === saved.origin.dueDate);
    if (!active) throw new Error("Purchase XML needs its unchanged activated source New Ref bill; use the full source archive");
    const fieldsXml = bill.children.map(child => `<${keyName(child.tag)}${Object.entries(child.attrs).map(([name, text]) => ` ${name}="${xml(text)}"`).join("")}>${xml(child.text.trim())}</${keyName(child.tag)}>`).join("");
    // A ledger-default credit period is not present in the raw bill node. Preserve
    // the source-activated due date explicitly instead of adopting a new target default.
    const due = !value(bill, "DUEDATE") && !value(bill, "BILLCREDITPERIOD") ? `<DUEDATE>${active.dueDate.replaceAll("-", "")}</DUEDATE>` : "";
    result.push(`<BILLALLOCATIONS.LIST>${fieldsXml}${due}</BILLALLOCATIONS.LIST>`);
  }
  const total = rows.filter(row => row.postingIndex === postingIndex).reduce((sum, row) => sum + BigInt(tallyAmount(value(row.node, "AMOUNT"))), 0n);
  if (result.length && total !== BigInt(voucher.lines[postingIndex].paise) * (voucher.lines[postingIndex].dc === "Dr" ? -1n : 1n)) throw new Error("Purchase XML bill allocations do not reconcile to their source posting; use the full source archive");
  return result.join("");
}
function purchaseVoucherXml(company, voucher, guid, ledgers) {
  const invoice = voucher.gst, origin = invoice.tallyOrigin, source = origin.source;
  if (origin.version !== 2 || invoice.type !== "Purchase" || invoice.reverseCharge || invoice.supplyCategory !== "domestic" || origin.stockMode !== "source" || !source.sourceVoucherType || !Array.isArray(source.exportUnsupportedAllocations) || !Array.isArray(source.exportBillAllocations)) throw new Error("Purchase XML needs a represented source receipt and allocation evidence; use the full source archive");
  if (source.exportUnsupportedAllocations.length) throw new Error(`Purchase XML cannot represent source allocations: ${source.exportUnsupportedAllocations.join(", ")}. Use the full source archive`);
  if (source.exportBillAllocations.some(row => !Number.isSafeInteger(row.postingIndex) || !voucher.lines[row.postingIndex] || origin.postingRoles[row.postingIndex] !== "party")) throw new Error("Purchase XML has an unrepresented source bill allocation; use the full source archive");
  if (origin.postingRoles.filter(role => role === "purchase").length !== 1) throw new Error("Purchase XML cannot retain split source purchase-account postings exactly; use the full source archive");
  const postings = voucher.lines.map((line, index) => {
    if (origin.postingRoles[index] === "purchase") return "";
    const bills = purchaseBillsXml(company, voucher, index);
    return `<LEDGERENTRIES.LIST><LEDGERNAME>${xml(ledgers.get(line.ledgerId))}</LEDGERNAME><ISDEEMEDPOSITIVE>${line.dc === "Dr" ? "Yes" : "No"}</ISDEEMEDPOSITIVE>${origin.postingRoles[index] === "party" ? "<ISPARTYLEDGER>Yes</ISPARTYLEDGER>" : ""}<AMOUNT>${tallyRupees(line.paise, line.dc)}</AMOUNT>${bills}</LEDGERENTRIES.LIST>`;
  }).join("");
  const inventory = tallyStockVoucherXml(company, voucher, xml);
  if (!inventory) throw new Error("Purchase XML needs its source inventory lines; use the full source archive");
  const trace = `<!-- Ledgercraft reviewed source ${origin.recordId}; mapping ${origin.mappingHash}; original bytes remain in the full source archive. -->`;
  return `${trace}<VOUCHER VCHTYPE="${xml(source.sourceVoucherType)}" ACTION="Create" OBJVIEW="Invoice Voucher View" REMOTEID="${xml(guid)}"><GUID>${xml(guid)}</GUID><DATE>${voucher.date.replaceAll("-", "")}</DATE><VOUCHERTYPENAME>${xml(source.sourceVoucherType)}</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(source.sourceVoucherNumber)}</VOUCHERNUMBER><REFERENCE>${xml(source.sourceInvoiceNumber)}</REFERENCE><REFERENCEDATE>${invoice.supplierInvoiceDate.replaceAll("-", "")}</REFERENCEDATE><PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW><ISINVOICE>Yes</ISINVOICE><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><ISREVERSECHARGEAPPLICABLE>No</ISREVERSECHARGEAPPLICABLE><PARTYLEDGERNAME>${xml(ledgers.get(origin.accounts.party))}</PARTYLEDGERNAME><PARTYMAILINGNAME>${xml(invoice.party.name)}</PARTYMAILINGNAME><PARTYGSTIN>${xml(invoice.party.gstin)}</PARTYGSTIN><PARTYSTATENAME>${xml(gstState(invoice.party.stateCode))}</PARTYSTATENAME><CMPGSTIN>${xml(invoice.registration.gstin)}</CMPGSTIN><CMPGSTSTATE>${xml(gstState(invoice.registration.stateCode))}</CMPGSTSTATE><PLACEOFSUPPLY>${xml(gstState(invoice.placeOfSupply))}</PLACEOFSUPPLY><ISGSTOVERRIDDEN>Yes</ISGSTOVERRIDDEN><NARRATION>${xml(voucher.narration)}</NARRATION>${postings}${inventory}</VOUCHER>`;
}
// A reviewed note keeps the native accounting type and signed postings. An inward
// buyer Debit Note is not relabelled as a supplier-issued native Credit Note.
function reviewedNoteVoucherXml(company, voucher, guid, ledgers, originalProof = null) {
  const invoice = voucher.gst, origin = invoice.tallyOrigin, source = origin.source, note = origin.version === 3;
  const proof = originalProof || source, role = invoice.direction === "purchase" ? "purchase" : "sales";
  if ((!note && (origin.version !== 1 || invoice.type !== "Sales")) || invoice.reverseCharge || invoice.supplyCategory !== "domestic" || !proof.sourceVoucherType || !Array.isArray(proof.exportUnsupportedAllocations) || !Array.isArray(proof.exportBillAllocations)) throw new Error("Reviewed source XML lacks complete note or original invoice evidence; use the full source archive");
  if (proof.exportUnsupportedAllocations.length || proof.exportBillAllocations.length) throw new Error(`Reviewed source XML cannot represent allocations ${proof.exportUnsupportedAllocations.join(", ") || "BILLALLOCATIONS"}; use the full source archive`);
  const physical = invoice.stockEffect === "quantity";
  if (!physical && (source.noteInventory || invoice.items.length !== 1)) throw new Error("Financial-only note XML cannot retain native item rows or multiple allocation lines without changing their stock meaning; use the full source archive");
  if (physical && origin.postingRoles.filter(value => value === role).length !== 1) throw new Error("Reviewed source XML cannot retain split item-account postings exactly; use the full source archive");
  const postings = voucher.lines.map((line, index) => {
    if (physical && origin.postingRoles[index] === role) return "";
    return `<LEDGERENTRIES.LIST><LEDGERNAME>${xml(ledgers.get(line.ledgerId))}</LEDGERNAME><ISDEEMEDPOSITIVE>${line.dc === "Dr" ? "Yes" : "No"}</ISDEEMEDPOSITIVE>${origin.postingRoles[index] === "party" ? "<ISPARTYLEDGER>Yes</ISPARTYLEDGER>" : ""}<AMOUNT>${tallyRupees(line.paise, line.dc)}</AMOUNT></LEDGERENTRIES.LIST>`;
  }).join("");
  const inventory = physical ? tallyStockVoucherXml(company, voucher, xml, { reviewedSource: true }) : "";
  if (physical && !inventory || !physical && origin.stockMode !== "financial-only") throw new Error("Reviewed note XML cannot prove its stock treatment; use the full source archive");
  const number = note ? source.sourceVoucherNumber : origin.originalInvoiceNumber;
  const supplier = invoice.direction === "purchase" ? `<REFERENCE>${xml(source.sourceInvoiceNumber)}</REFERENCE><REFERENCEDATE>${invoice.supplierInvoiceDate.replaceAll("-", "")}</REFERENCEDATE>` : "";
  const original = note ? `<ORIGINALINVOICENO>${xml(invoice.originalNumber)}</ORIGINALINVOICENO><ORIGINALINVOICEDATE>${invoice.originalDate.replaceAll("-", "")}</ORIGINALINVOICEDATE>` : "";
  const trace = `<!-- Ledgercraft reviewed source ${origin.recordId}; mapping ${origin.mappingHash}; original bytes and independent statutory-note evidence remain in the full source archive. -->`;
  return `${trace}<VOUCHER VCHTYPE="${xml(proof.sourceVoucherType)}" ACTION="Create" OBJVIEW="Invoice Voucher View" REMOTEID="${xml(guid)}"><GUID>${xml(guid)}</GUID><DATE>${voucher.date.replaceAll("-", "")}</DATE><VOUCHERTYPENAME>${xml(proof.sourceVoucherType)}</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(number)}</VOUCHERNUMBER>${supplier}${original}<PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW><ISINVOICE>Yes</ISINVOICE><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><ISREVERSECHARGEAPPLICABLE>No</ISREVERSECHARGEAPPLICABLE><PARTYLEDGERNAME>${xml(ledgers.get(origin.accounts.party))}</PARTYLEDGERNAME><PARTYMAILINGNAME>${xml(invoice.party.name)}</PARTYMAILINGNAME><PARTYGSTIN>${xml(invoice.party.gstin)}</PARTYGSTIN><PARTYSTATENAME>${xml(gstState(invoice.party.stateCode))}</PARTYSTATENAME><CMPGSTIN>${xml(invoice.registration.gstin)}</CMPGSTIN><CMPGSTSTATE>${xml(gstState(invoice.registration.stateCode))}</CMPGSTSTATE><PLACEOFSUPPLY>${xml(gstState(invoice.placeOfSupply))}</PLACEOFSUPPLY><ISGSTOVERRIDDEN>Yes</ISGSTOVERRIDDEN><NARRATION>${xml(voucher.narration)}</NARRATION>${postings}${inventory}</VOUCHER>`;
}
function serviceVoucherXml(company, voucher, guid, ledgers) {
  const invoice = voucher.gst, origin = invoice.tallyOrigin, source = origin.source;
  const mixed = invoice.items.some(item => item.kind === "goods");
  if (!source.sourceVoucherType || !Array.isArray(source.exportUnsupportedAllocations) || source.exportUnsupportedAllocations.length ||
      !Array.isArray(source.exportBillAllocations) || source.exportBillAllocations.some(row => origin.postingRoles[row.postingIndex] !== "party")) {
    throw new Error("Unrepresented service voucher allocations require the full source archive");
  }
  if (mixed && origin.stockMode !== "source") throw new Error("This mixed invoice has unresolved goods quantities; use the full source archive");
  const goodsRole = invoice.direction === "purchase" ? "purchase" : "sales";
  const rows = new Map();
  source.items.forEach((item,index) => {
    if (item.kind !== "service") return;
    const postingIndex = item.sourcePostingIndexes?.[0];
    const line = voucher.lines[postingIndex], billLine = invoice.items[index];
    if (item.sourcePostingIndexes.length !== 1 || rows.has(postingIndex) || !line || line.ledgerId !== item.sourceLedgerId ||
        line.paise !== billLine.taxablePaise || line.dc !== (invoice.direction === "purchase" ? "Dr" : "Cr")) throw new Error("Service XML needs each exact reviewed accounting ledger and amount");
    rows.set(postingIndex,reviewedGstLineXml(invoice,billLine,xml));
  });
  if (mixed) {
    const basePostings = voucher.lines.filter((_,index)=>origin.postingRoles[index]===goodsRole);
    const itemAmounts = invoice.items.filter(line=>line.kind==="goods").map(line=>line.taxablePaise);
    if (basePostings.length !== 1 && (basePostings.length !== itemAmounts.length ||
        basePostings.some((line,index)=>line.paise !== itemAmounts[index]))) throw new Error("Mixed XML cannot reconstruct this goods posting split; use the full source archive");
  }
  const postings = voucher.lines.map((line,index) => {
    const role = origin.postingRoles[index];
    if (mixed && role === goodsRole) return "";
    const details = rows.get(index) || (role === "party" ? "<ISPARTYLEDGER>Yes</ISPARTYLEDGER>" : "");
    return `<LEDGERENTRIES.LIST><LEDGERNAME>${xml(ledgers.get(line.ledgerId))}</LEDGERNAME><ISDEEMEDPOSITIVE>${line.dc === "Dr" ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${tallyRupees(line.paise,line.dc)}</AMOUNT>${details}${purchaseBillsXml(company,voucher,index)}</LEDGERENTRIES.LIST>`;
  }).join("");
  const inventory = mixed ? tallyStockVoucherXml(company,voucher,xml,{reviewedSource:true}) : "";
  if (mixed && !inventory) throw new Error("The mixed invoice lost its goods movement; use the full source archive");
  const supplier = invoice.direction === "purchase" ? `<REFERENCE>${xml(invoice.supplierInvoiceNumber)}</REFERENCE><REFERENCEDATE>${invoice.supplierInvoiceDate.replaceAll("-","")}</REFERENCEDATE>` : "";
  return `<VOUCHER VCHTYPE="${xml(source.sourceVoucherType)}" ACTION="Create" OBJVIEW="Invoice Voucher View" REMOTEID="${xml(guid)}"><GUID>${xml(guid)}</GUID><DATE>${voucher.date.replaceAll("-","")}</DATE><VOUCHERTYPENAME>${xml(source.sourceVoucherType)}</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(origin.originalInvoiceNumber)}</VOUCHERNUMBER>${supplier}<PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW><ISINVOICE>Yes</ISINVOICE><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><ISREVERSECHARGEAPPLICABLE>No</ISREVERSECHARGEAPPLICABLE><PARTYLEDGERNAME>${xml(ledgers.get(origin.accounts.party))}</PARTYLEDGERNAME><PARTYMAILINGNAME>${xml(invoice.party.name)}</PARTYMAILINGNAME><PARTYGSTIN>${xml(invoice.party.gstin)}</PARTYGSTIN><PARTYSTATENAME>${xml(gstState(invoice.party.stateCode))}</PARTYSTATENAME><CMPGSTIN>${xml(invoice.registration.gstin)}</CMPGSTIN><CMPGSTSTATE>${xml(gstState(invoice.registration.stateCode))}</CMPGSTSTATE><PLACEOFSUPPLY>${xml(gstState(invoice.placeOfSupply))}</PLACEOFSUPPLY><ISGSTOVERRIDDEN>Yes</ISGSTOVERRIDDEN><NARRATION>${xml(voucher.narration)}</NARRATION>${postings}${inventory}</VOUCHER>`;
}
export function exportTallyDayBook(inputCompany, inputVouchers, from, to) {
  const { company, vouchers } = validateTransfer({ company: inputCompany, vouchers: inputVouchers });
  if (!isIsoDate(from) || !isIsoDate(to) || from > to || from < company.booksFrom) throw new Error("Choose a valid Tally export period");
  const ledgers = new Map(company.ledgers.map((ledger) => [ledger.id, ledger.name]));
  const selected = vouchers.filter((voucher) => voucher.date >= from && voucher.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number, "en", { numeric: true }) || a.number.localeCompare(b.number));
  const salesEvidence = linkedSalesEvidence(vouchers, selected);
  purchaseMasterDetails(selected, company, salesEvidence);
  const content = selected.map((voucher) => {
    const guid = voucherGuid(company.id, voucher);
    if (promotedService(voucher)) return serviceVoucherXml(company,voucher,guid,ledgers);
    if (promotedPurchase(voucher)) return purchaseVoucherXml(company, voucher, guid, ledgers);
    if (promotedNote(voucher) || salesEvidence.has(voucher.id)) return reviewedNoteVoucherXml(company, voucher, guid, ledgers, salesEvidence.get(voucher.id));
    const lines = voucher.lines.map((line) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(ledgers.get(line.ledgerId))}</LEDGERNAME><ISDEEMEDPOSITIVE>${line.dc === "Dr" ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${tallyRupees(line.paise, line.dc)}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join("");
    return `<VOUCHER VCHTYPE="${xml(voucher.type)}" ACTION="Create" OBJVIEW="Accounting Voucher View" REMOTEID="${xml(guid)}"><GUID>${xml(guid)}</GUID><DATE>${voucher.date.replaceAll("-", "")}</DATE><VOUCHERTYPENAME>${xml(voucher.type)}</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(voucher.number)}</VOUCHERNUMBER><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><NARRATION>${xml(voucher.narration)}</NARRATION>${lines}${tallyStockVoucherXml(company, voucher, xml)}</VOUCHER>`;
  }).join("");
  return envelope(company, "Vouchers", content + tallyStockJournalsXml(company, from, to, xml));
}

function ordered(value) {
  if (Array.isArray(value)) {
    const list = value.every((entry) => entry && typeof entry === "object" && typeof entry.id === "string") ? value.slice().sort((a, b) => a.id.localeCompare(b.id)) : value;
    return list.map(ordered);
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => !["source", "requestId"].includes(key)).map((key) => [key, ordered(value[key])]));
}

export function accountingBookHash(company, vouchers) {
  const { id, ...book } = company;
  return createHash("sha256").update(JSON.stringify(ordered({ company: book, vouchers }))).digest("hex");
}
