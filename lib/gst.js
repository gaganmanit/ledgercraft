import { invoiceExportFields } from "./gst-export-particulars.js";
import { assertTallyGstPosting, tallyGstPostingLines } from "./tally-gst.js";
import { stockState } from "./stock-engine.js";
import { validateIrpPolicies } from "./gst-irp-policy.js";
import { turnoverFor, minimumHsnDigits, validateTurnover } from "./gst-turnover.js";
import { randomBytes, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fyStart, isIsoDate, todayISO } from "./money.js";
import { assertRcmInvoice, buildRcmSnapshot, rcmAccountIds, rcmPostingLines } from "./gst-rcm.js";

// State codes use the GST return convention. Foreign-country POS is 96.
export const GST_STATES = [
  ["01", "Jammu and Kashmir"], ["02", "Himachal Pradesh"], ["03", "Punjab"],
  ["04", "Chandigarh"], ["05", "Uttarakhand"], ["06", "Haryana"], ["07", "Delhi"],
  ["08", "Rajasthan"], ["09", "Uttar Pradesh"], ["10", "Bihar"], ["11", "Sikkim"],
  ["12", "Arunachal Pradesh"], ["13", "Nagaland"], ["14", "Manipur"], ["15", "Mizoram"],
  ["16", "Tripura"], ["17", "Meghalaya"], ["18", "Assam"], ["19", "West Bengal"],
  ["20", "Jharkhand"], ["21", "Odisha"], ["22", "Chhattisgarh"], ["23", "Madhya Pradesh"],
  ["24", "Gujarat"], ["26", "Dadra and Nagar Haveli and Daman and Diu"], ["27", "Maharashtra"],
  ["29", "Karnataka"], ["30", "Goa"], ["31", "Lakshadweep"], ["32", "Kerala"],
  ["33", "Tamil Nadu"], ["34", "Puducherry"], ["35", "Andaman and Nicobar Islands"],
  ["36", "Telangana"], ["37", "Andhra Pradesh"], ["38", "Ladakh"],
  ["96", "Foreign country"], ["97", "Other territory"],
].map(([code, name]) => ({ code, name }));
export const GST_STATUSES = ["taxable", "exempt", "nil-rated", "non-gst", "zero-rated"];
export const GST_COMPONENTS = ["cgst", "sgst", "utgst", "igst", "cess"];
const UTGST_STATES = new Set(["04", "26", "31", "35", "38", "97"]);
const PAISA_FIELDS = ["grossPaise", "discountPaise", "taxablePaise", ...GST_COMPONENTS.map(key => `${key}Paise`), "taxPaise", "totalPaise"];
const DOCUMENT_TYPES = ["Sales", "Purchase", "Credit Note", "Debit Note"];
const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

function text(value, label, maximum = 120, required = true) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new Error(`Enter ${label}`);
  const result = value.trim();
  if ((required && !result) || result.length > maximum) throw new Error(`Enter ${label} within ${maximum} characters`);
  return result;
}
function stateCode(value, foreign = false) {
  const code = String(value ?? "").padStart(2, "0");
  if (!GST_STATES.some(state => state.code === code) || (!foreign && code === "96")) throw new Error("Choose a valid GST state code");
  return code;
}
function integer(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`Enter a valid ${label}`);
  return value;
}
function safe(value) {
  if (value < 0n || value > MAX) throw new Error("The invoice amount exceeds the supported paise limit");
  return Number(value);
}
function round(numerator, denominator) {
  return safe((numerator + denominator / 2n) / denominator);
}
export function quantityMicros(value, allowZero = false) {
  const raw = String(value ?? "").trim();
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(raw)) throw new Error("Enter a quantity with up to six decimal places");
  const [whole, fraction = ""] = raw.split(".");
  const micros = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  if ((!allowZero && micros === 0n) || micros > MAX) throw new Error("Enter a supported quantity greater than zero");
  return micros;
}
export function formatQuantity(micros) {
  const sign = micros < 0n ? "-" : "";
  const absolute = micros < 0n ? -micros : micros;
  const fraction = String(absolute % 1000000n).padStart(6, "0").replace(/0+$/, "");
  return `${sign}${absolute / 1000000n}${fraction ? `.${fraction}` : ""}`;
}
export function gstinCheckDigit(firstFourteen) {
  if (!/^[0-9A-Z]{14}$/.test(firstFourteen)) throw new Error("A GSTIN prefix needs fourteen characters");
  let sum = 0;
  let factor = 2;
  for (let index = 13; index >= 0; index -= 1) {
    const product = alphabet.indexOf(firstFourteen[index]) * factor;
    sum += Math.floor(product / 36) + product % 36;
    factor = factor === 2 ? 1 : 2;
  }
  return alphabet[(36 - sum % 36) % 36];
}
export function normalizeGstin(value, required = true) {
  const gstin = text(value, "GSTIN", 15, required).toUpperCase();
  if (!gstin && !required) return "";
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin) || gstinCheckDigit(gstin.slice(0, 14)) !== gstin[14]) {
    throw new Error("Enter a regular GSTIN with a valid format and checksum");
  }
  stateCode(gstin.slice(0, 2));
  return gstin;
}
function contact(input, label, foreign = false) {
  const state = stateCode(input.stateCode, foreign);
  const gstin = normalizeGstin(input.gstin, false);
  if (gstin && gstin.slice(0, 2) !== state) throw new Error("GSTIN and state code must match");
  const pincode = text(input.pincode, "PIN code", 12, false);
  if (pincode && state !== "96" && !/^\d{6}$/.test(pincode)) throw new Error("Enter a six-digit Indian PIN code");
  return {
    name: text(input.name || input.legalName, `${label} name`),
    legalName: text(input.legalName || input.name, `${label} legal name`),
    gstin, stateCode: state, address: text(input.address, `${label} address`, 500), pincode,
    phone: text(input.phone, "phone", 40, false), email: text(input.email, "email", 120, false),
  };
}
function gstMasters(company) {
  if (!company.gst) company.gst = { version: 1, registrations: [], parties: [], items: [] };
  return company.gst;
}
function addAccount(company, name, groupId) {
  const id = `l-gst-${randomBytes(7).toString("hex")}`;
  if (company.ledgers.some(ledger => ledger.name.toLowerCase() === name.toLowerCase())) throw new Error("A generated GST ledger name already exists. Use a different master name");
  company.ledgers.push({ id, name, groupId, opening: { dc: "Dr", paise: 0 } });
  return id;
}
export function saveRegistration(company, input, vouchers = []) {
  const masters = gstMasters(company);
  const existing = input.id ? masters.registrations.find(item => item.id === input.id) : null;
  if (input.id && !existing) throw new Error("Unknown GST registration");
  const registration = { ...contact(input, "registration"), gstin: normalizeGstin(input.gstin) };
  if (registration.gstin.slice(0, 2) !== registration.stateCode) throw new Error("GSTIN and state code must match");
  if (masters.registrations.some(item => item.id !== existing?.id && item.gstin === registration.gstin)) throw new Error("That GSTIN is already registered in these books");
  if (existing && vouchers.some(voucher => voucher.gst?.registrationId === existing.id) && existing.gstin !== registration.gstin) throw new Error("An invoiced registration keeps its GSTIN. Add the new registration separately");
  registration.id = existing?.id || `r-${randomBytes(6).toString("hex")}`;
  registration.invoicePrefix = text(input.invoicePrefix || existing?.invoicePrefix || `R${masters.registrations.length + 1}`, "invoice prefix", 4).toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(registration.invoicePrefix)) throw new Error("Use one to four letters or digits for the invoice prefix");
  if (masters.registrations.some(item => item.id !== existing?.id && item.invoicePrefix === registration.invoicePrefix)) throw new Error("Choose a unique registration invoice prefix");
  registration.accounts = existing?.accounts || {
    sales: addAccount(company, `${registration.invoicePrefix} GST Sales`, "g-sales"),
    purchase: addAccount(company, `${registration.invoicePrefix} GST Purchases`, "g-purchase"),
    nonCreditTax: addAccount(company, `${registration.invoicePrefix} Non-creditable Purchase Tax`, "g-purchase"),
  };
  if (!existing) {
    for (const component of GST_COMPONENTS) {
      registration.accounts[`input-${component}`] = addAccount(company, `${registration.invoicePrefix} Input ${component.toUpperCase()}`, "g-current-assets");
      registration.accounts[`output-${component}`] = addAccount(company, `${registration.invoicePrefix} Output ${component.toUpperCase()}`, "g-duties");
    }
    masters.registrations.push(registration);
  } else Object.assign(existing, registration);
  return registration;
}
export function saveParty(company, input, vouchers = []) {
  const masters = gstMasters(company);
  const existing = input.id ? masters.parties.find(item => item.id === input.id) : null;
  if (input.id && !existing) throw new Error("Unknown GST party");
  const party = { ...contact(input, "party", true), kind: input.kind || "both" };
  if (!["customer", "supplier", "both"].includes(party.kind)) throw new Error("Choose customer, supplier or both for the party");
  if (masters.parties.some(item => item.id !== existing?.id && item.name.toLowerCase() === party.name.toLowerCase())) throw new Error("A party with that name already exists");
  if (existing) {
    const history = vouchers.filter(voucher => voucher.gst?.partyId === existing.id).map(voucher => voucher.gst);
    if (history.length && (existing.gstin !== party.gstin || existing.stateCode !== party.stateCode)) throw new Error("An invoiced party keeps its GSTIN and state. Add a separate party for the new registration");
    if ((party.kind === "supplier" && history.some(invoice => invoice.direction === "sales")) || (party.kind === "customer" && history.some(invoice => invoice.direction === "purchase"))) throw new Error("The party type must retain its invoiced sales and purchase roles");
  }
  party.id = existing?.id || `p-${randomBytes(6).toString("hex")}`;
  const customerLedgerId = input.customerLedgerId || existing?.customerLedgerId;
  if (customerLedgerId && !company.ledgers.some(ledger => ledger.id === customerLedgerId && ledger.groupId === "g-debtors")) throw new Error("Choose an existing debtor ledger for the GST customer");
  if (existing && customerLedgerId !== existing.customerLedgerId && vouchers.some(voucher => voucher.gst?.partyId === existing.id)) throw new Error("An invoiced party keeps its posting ledger");
  if (customerLedgerId && party.gstin && masters.parties.some(item => item.id !== existing?.id && item.customerLedgerId === customerLedgerId && item.gstin === party.gstin)) throw new Error("This buyer GST registration is already linked to the selected debtor ledger");
  party.customerLedgerId = customerLedgerId || addAccount(company, `${party.name.slice(0, 54)} [${party.id.slice(-6)}] Receivable`, "g-debtors");
  party.supplierLedgerId = existing?.supplierLedgerId || addAccount(company, `${party.name.slice(0, 54)} [${party.id.slice(-6)}] Payable`, "g-creditors");
  if (existing) Object.assign(existing, party);
  else masters.parties.push(party);
  return party;
}
function itemValues(input) {
  const kind = input.kind || "goods";
  if (!["goods", "service"].includes(kind)) throw new Error("Choose goods or service");
  const hsnSac = text(input.hsnSac, "HSN or SAC", 8);
  if (!(kind === "goods" ? /^(\d{4}|\d{6}|\d{8})$/ : /^(\d{4}|\d{6})$/).test(hsnSac)) throw new Error("Use a 4, 6 or 8 digit HSN for goods or a 4 or 6 digit SAC for services");
  const supplyStatus = input.supplyStatus || "taxable";
  if (!GST_STATUSES.includes(supplyStatus)) throw new Error("Choose a supported supply status");
  const gstRateBps = integer(input.gstRateBps ?? 0, "GST rate in basis points", 10000);
  const cessRateBps = integer(input.cessRateBps ?? 0, "ad valorem cess rate in basis points", 100000);
  if (["exempt", "nil-rated", "non-gst"].includes(supplyStatus) && (gstRateBps || cessRateBps)) throw new Error("Exempt, nil-rated and non-GST items must have zero tax rates");
  if (input.cessPerUnitPaise) throw new Error("Specific cess per unit needs a separate calculation and is not supported by this invoice");
  return {
    name: text(input.name, "item name"), kind, hsnSac,
    unit: text(input.unit || (kind === "service" ? "OTH" : ""), "unit", 12), supplyStatus, gstRateBps, cessRateBps,
    pricePaise: integer(input.pricePaise ?? 0, "selling price in paise"),
    purchasePricePaise: integer(input.purchasePricePaise ?? input.pricePaise ?? 0, "purchase price in paise"),
    openingQuantity: kind === "goods" ? formatQuantity(quantityMicros(input.openingQuantity ?? "0", true)) : "0",
  };
}
export function saveItem(company, input, vouchers = []) {
  const masters = gstMasters(company);
  const existing = (input.id || input.stockItemId) ? masters.items.find(item => item.id === (input.id || input.stockItemId)) : null;
  if (input.id && !existing && input.id !== input.stockItemId) throw new Error("Unknown GST item");
  const item = itemValues(input);
  const stockItemId = input.stockItemId || existing?.stockItemId;
  if (existing?.stockItemId && stockItemId !== existing.stockItemId) throw new Error("An enriched source stock item keeps its original identity");
  if (stockItemId) {
    const stockItem = company.stock?.masters?.find(row => row.id === stockItemId);
    if (!stockItem || item.kind !== "goods" || item.name.toLowerCase() !== stockItem.name.toLowerCase() || item.unit.toLowerCase() !== stockItem.unit.toLowerCase() || item.openingQuantity !== stockItem.openingQuantity || existing && existing.id !== stockItem.id) throw new Error("GST enrichment must retain the source stock item's name, simple unit, opening quantity and identity");
    item.stockItemId = stockItemId;
  }
  if (masters.items.some(value => value.id !== existing?.id && value.name.toLowerCase() === item.name.toLowerCase())) throw new Error("An item with that name already exists");
  if (existing && vouchers.some(voucher => voucher.gst?.items.some(line => line.itemId === existing.id)) && (item.openingQuantity !== existing.openingQuantity || item.kind !== existing.kind || item.unit !== existing.unit)) throw new Error("An invoiced item keeps its opening quantity, kind and unit");
  item.id = existing?.id || stockItemId || `i-${randomBytes(6).toString("hex")}`;
  if (existing) Object.assign(existing, item);
  else masters.items.push(item);
  return item;
}
function directionFor(type, direction) {
  if (type === "Sales") return "sales";
  if (type === "Purchase") return "purchase";
  if (!["sales", "purchase"].includes(direction)) throw new Error("Choose sales or purchase for this note");
  return direction;
}
function invoiceSeries(registration, type, direction, date) {
  const prefix = direction === "sales" ? "S" : "P";
  const document = type === "Credit Note" ? "C" : type === "Debit Note" ? "D" : "I";
  const start = Number(fyStart(date).slice(0, 4));
  return `${registration.invoicePrefix}${prefix}${document}${String(start).slice(-2)}${String(start + 1).slice(-2)}/`;
}
export function nextInvoiceNumber(registration, vouchers, type, direction, date) {
  const series = invoiceSeries(registration, type, direction, date);
  let maximum = 0;
  for (const voucher of vouchers) {
    const invoice = voucher.gst;
    if (invoice?.registrationId !== registration.id || !invoice.number.startsWith(series)) continue;
    const tail = invoice.number.slice(series.length);
    if (/^\d+$/.test(tail)) maximum = Math.max(maximum, Number(tail));
  }
  const number = `${series}${String(maximum + 1).padStart(5, "0")}`;
  if (number.length > 16) throw new Error("This invoice series has reached its sixteen-character number limit");
  return number;
}
function calculateLine(item, input, context) {
  const quantity = formatQuantity(quantityMicros(input.quantity));
  const unitPricePaise = integer(input.unitPricePaise ?? (context.direction === "purchase" ? item.purchasePricePaise : item.pricePaise), "unit price in paise");
  const discountBps = integer(input.discountBps ?? 0, "line discount in basis points", 10000);
  const supplyStatus = input.supplyStatus || item.supplyStatus;
  const gstRateBps = integer(input.gstRateBps ?? item.gstRateBps, "GST rate in basis points", 10000);
  const cessRateBps = integer(input.cessRateBps ?? item.cessRateBps, "ad valorem cess rate in basis points", 100000);
  if (!GST_STATUSES.includes(supplyStatus)) throw new Error("Choose a supported supply status");
  if (input.cessPerUnitPaise) throw new Error("Specific cess per unit is not supported by this invoice");
  if (["exempt", "nil-rated", "non-gst"].includes(supplyStatus) && (gstRateBps || cessRateBps)) throw new Error("Exempt, nil-rated and non-GST supplies must have zero tax rates");
  if (supplyStatus === "zero-rated" && context.supplyCategory === "domestic") throw new Error("Zero-rated supplies need export or SEZ details");
  if (context.supplyCategory !== "domestic" && supplyStatus !== "zero-rated") throw new Error("Export and SEZ lines must be recorded as zero-rated supplies");
  const chargeTax = ["taxable", "zero-rated"].includes(supplyStatus) && !(supplyStatus === "zero-rated" && context.exportMode === "lut");
  const effectiveGst = chargeTax ? BigInt(gstRateBps) : 0n;
  const effectiveCess = chargeTax ? BigInt(cessRateBps) : 0n;
  const grossPaise = round(quantityMicros(quantity) * BigInt(unitPricePaise), 1000000n);
  const discountPaise = round(BigInt(grossPaise) * BigInt(discountBps), 10000n);
  const net = BigInt(grossPaise - discountPaise);
  const denominator = context.pricing === "inclusive" ? 10000n + effectiveGst + effectiveCess : 10000n;
  const component = rate => round(net * rate, denominator);
  let cgstPaise = 0;
  let sgstPaise = 0;
  let utgstPaise = 0;
  let igstPaise = 0;
  if (context.interState) igstPaise = component(effectiveGst);
  else {
    cgstPaise = round(net * effectiveGst, denominator * 2n);
    if (context.utgst) utgstPaise = cgstPaise;
    else sgstPaise = cgstPaise;
  }
  const cessPaise = component(effectiveCess);
  const taxPaise = safe(BigInt(cgstPaise) + BigInt(sgstPaise) + BigInt(utgstPaise) + BigInt(igstPaise) + BigInt(cessPaise));
  const taxablePaise = context.pricing === "inclusive" ? safe(net - BigInt(taxPaise)) : Number(net);
  const totalPaise = safe(BigInt(taxablePaise) + BigInt(taxPaise));
  return {
    itemId: item.id || item.itemId, name: item.name, kind: item.kind, hsnSac: item.hsnSac, unit: item.unit,
    quantity, unitPricePaise, discountBps, gstRateBps, cessRateBps, supplyStatus,
    grossPaise, discountPaise, taxablePaise, cgstPaise, sgstPaise, utgstPaise, igstPaise, cessPaise, taxPaise, totalPaise,
  };
}
function taxContext(registration, party, input, direction) {
  const reverseCharge = input.reverseCharge ?? false;
  if (typeof reverseCharge !== "boolean") throw new Error("Choose a valid reverse-charge setting");
  const placeOfSupply = stateCode(input.placeOfSupply, true);
  const pricing = input.pricing || "exclusive";
  if (!["exclusive", "inclusive"].includes(pricing)) throw new Error("Choose inclusive or exclusive pricing");
  const supplyCategory = input.supplyCategory || "domestic";
  if (!["domestic", "export", "sez"].includes(supplyCategory)) throw new Error("Choose domestic, export or SEZ supply");
  if (direction === "purchase" && (supplyCategory === "export" || (party.stateCode === "96" && !reverseCharge))) throw new Error("Import purchases need customs and bill-of-entry accounting. Use the import workflow for those books");
  if (supplyCategory === "export" && (party.stateCode !== "96" || placeOfSupply !== "96" || party.gstin)) throw new Error("Exports need a foreign recipient and foreign place of supply");
  if (supplyCategory === "domestic" && placeOfSupply === "96") throw new Error("Choose export for a foreign place of supply");
  const exportMode = supplyCategory === "domestic" ? null : input.exportMode;
  if (supplyCategory !== "domestic" && !["lut", "with-payment"].includes(exportMode)) throw new Error("Choose LUT/bond without tax or payment of IGST for this zero-rated supply");
  const supplierState = direction === "sales" ? registration.stateCode : party.stateCode;
  const interState = supplyCategory !== "domestic" || supplierState !== placeOfSupply;
  const itcEligibility = direction === "purchase" ? input.itcEligibility || "pending" : null;
  if (direction === "purchase" && !["eligible", "ineligible", "pending"].includes(itcEligibility)) throw new Error("Choose the purchase ITC eligibility");
  const stockEffect = input.stockEffect || (["Credit Note", "Debit Note"].includes(input.type) ? "none" : "quantity");
  if (!["quantity", "none"].includes(stockEffect)) throw new Error("Choose a quantity movement or a financial adjustment");
  return { direction, placeOfSupply, pricing, supplyCategory, exportMode, interState, utgst: !interState && UTGST_STATES.has(supplierState), reverseCharge, itcEligibility, stockEffect };
}
function calculateTotals(items) {
  return Object.fromEntries(PAISA_FIELDS.map(field => [field, safe(items.reduce((sum, item) => sum + BigInt(item[field]), 0n))]));
}
function referenceFor(input, vouchers, registration, party, direction) {
  if (!["Credit Note", "Debit Note"].includes(input.type)) return { originalInvoiceId: null, originalNumber: "", originalDate: "" };
  const original = input.originalInvoiceId ? vouchers.find(voucher => voucher.gst?.id === input.originalInvoiceId)?.gst : null;
  if (input.originalInvoiceId && !original) throw new Error("Choose an original invoice in these books");
  if (original && (original.registrationId !== registration.id || original.partyId !== party.id || original.direction !== direction || !["Sales", "Purchase"].includes(original.type))) throw new Error("The original invoice must match this registration, party and direction");
  const originalNumber = (original?.direction === "purchase" ? original.supplierInvoiceNumber : original?.number) || text(input.originalNumber, "original invoice number", 16);
  const originalDate = original?.date || input.originalDate;
  if (!isIsoDate(originalDate) || originalDate > input.date) throw new Error("The original invoice date must be on or before the note date");
  return { originalInvoiceId: original?.id || null, originalNumber, originalDate };
}
export function assertGstReferences(invoice, vouchers) {
  if (!["Credit Note", "Debit Note"].includes(invoice.type)) return;
  if (!invoice.originalNumber || invoice.originalNumber.length > 16 || !isIsoDate(invoice.originalDate) || invoice.originalDate > invoice.date) throw new Error("A GST note needs its original document number and date");
  if (!invoice.originalInvoiceId) return;
  const original = vouchers.find(voucher => voucher.gst?.id === invoice.originalInvoiceId)?.gst;
  if (!original || !["Sales", "Purchase"].includes(original.type) || original.registrationId !== invoice.registrationId || original.partyId !== invoice.partyId || original.direction !== invoice.direction) throw new Error("The note's original invoice linkage is invalid");
  if (Boolean(invoice.reverseCharge) !== Boolean(original.reverseCharge) || (invoice.reverseCharge && invoice.rcm?.basisReference !== original.rcm?.basisReference)) throw new Error("A note must retain the original reverse-charge treatment and legal basis");
  if (invoice.originalNumber !== (original.direction === "purchase" ? original.supplierInvoiceNumber : original.number) || invoice.originalDate !== original.date || invoice.placeOfSupply !== original.placeOfSupply || invoice.supplyCategory !== original.supplyCategory || invoice.exportMode !== original.exportMode) throw new Error("The note must retain the original invoice reference and supply treatment");
  for (const item of invoice.items) {
    if (!original.items.some(row => row.itemId === item.itemId && row.gstRateBps === item.gstRateBps && row.cessRateBps === item.cessRateBps && row.supplyStatus === item.supplyStatus)) throw new Error("A linked note must use an original invoice item and its tax rate");
  }
  const related = vouchers.filter(voucher => voucher.gst?.originalInvoiceId === original.id && voucher.id !== invoice.id).map(voucher => voucher.gst);
  if (invoice.type === "Credit Note") {
    let available = BigInt(original.totals.totalPaise);
    for (const note of related) available += (note.type === "Credit Note" ? -1n : 1n) * BigInt(note.totals.totalPaise);
    if (BigInt(invoice.totals.totalPaise) > available) throw new Error("The credit exceeds the original invoice plus debit notes less earlier credits");
    if (invoice.stockEffect === "quantity") {
      const remaining = new Map();
      const add = (document, sign) => {
        if (document.stockEffect !== "quantity") return;
        for (const [index, item] of document.items.entries()) if (item.kind === "goods") {
          let quantity = quantityMicros(item.quantity);
          if (document.tallyOrigin?.stockMode === "source") {
            const physical = quantityMicros(document.tallyOrigin.source.items[index].actualQuantity);
            if (physical < quantity) quantity = physical;
          }
          remaining.set(item.itemId, (remaining.get(item.itemId) || 0n) + sign * quantity);
        }
      };
      add(original, 1n);
      for (const note of related) add(note, note.type === "Credit Note" ? -1n : 1n);
      add(invoice, -1n);
      if ([...remaining.values()].some(quantity => quantity < 0n)) throw new Error("The return quantity exceeds the linked invoice's remaining goods");
    }
  }
}

export function gstRequestHash(input) {
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
    return value;
  }
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}
export function buildGstInvoice(company, vouchers, input, id = `v-gst-${randomBytes(8).toString("hex")}`) {
  const masters = company.gst;
  const registration = masters?.registrations.find(value => value.id === input.registrationId);
  const party = masters?.parties.find(value => value.id === input.partyId);
  if (!registration || !party) throw new Error("Choose a GST registration and a party");
  if (!DOCUMENT_TYPES.includes(input.type)) throw new Error("Choose sales, purchase, credit note or debit note");
  if (!isIsoDate(input.date) || input.date < company.booksFrom) throw new Error("Enter an invoice date on or after the books begin");
  const direction = directionFor(input.type, input.direction);
  if ((direction === "sales" && party.kind === "supplier") || (direction === "purchase" && party.kind === "customer")) throw new Error("The party type does not match the invoice direction");
  if (party.gstin && party.gstin === registration.gstin) throw new Error("Choose a different supplier or recipient GSTIN");
  const context = taxContext(registration, party, input, direction);
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 500) throw new Error("Add between one and five hundred invoice lines");
  const items = input.items.map(row => {
    const item = masters.items.find(value => value.id === row.itemId);
    if (!item) throw new Error("Choose an existing item for every invoice line");
    return calculateLine(item, row, context);
  });
  const turnover = turnoverFor(company, registration, input.date);
  const minimum = minimumHsnDigits(turnover, input.date);
  if (direction === "sales" && minimum && items.some(item => item.hsnSac.length < minimum)) {
    throw new Error(`Enter at least ${minimum} HSN/SAC digits for the selected financial year's turnover band`);
  }
  const totals = calculateTotals(items);
  if (totals.totalPaise === 0) throw new Error("The invoice total must be greater than zero");
  if (direction === "purchase" && totals.taxPaise && !party.gstin && !context.reverseCharge) throw new Error("An unregistered supplier cannot charge forward GST. Record the actual non-GST supply or use reverse-charge accounting");
  const number = input.number ? text(input.number, "invoice number", 16).toUpperCase() : nextInvoiceNumber(registration, vouchers, input.type, direction, input.date);
  if (!/^[A-Za-z0-9][A-Za-z0-9/-]{0,15}$/.test(number)) throw new Error("Use up to sixteen letters, digits, slashes or hyphens for the invoice number");
  const financialYear = fyStart(input.date).slice(0, 4);
  if (vouchers.some(voucher => voucher.gst?.registrationId === registration.id && voucher.gst.financialYear === financialYear && voucher.gst.number.toUpperCase() === number)) throw new Error("That invoice number is already used for this GST registration and financial year");
  const supplierInvoiceNumber = direction === "purchase" ? text(input.supplierInvoiceNumber || (context.reverseCharge && !party.gstin ? number : ""), "supplier document number", 16).toUpperCase() : "";
  if (direction === "purchase" && vouchers.some(voucher => voucher.gst?.registrationId === registration.id && voucher.gst.partyId === party.id && voucher.gst.direction === direction && voucher.gst.type === input.type && voucher.gst.financialYear === financialYear && voucher.gst.supplierInvoiceNumber.toUpperCase() === supplierInvoiceNumber)) throw new Error("That supplier document is already recorded for this party and financial year");
  const reference = referenceFor(input, vouchers, registration, party, direction);
  const documentLabel = input.type === "Credit Note" || input.type === "Debit Note" ? input.type : items.every(item => ["exempt", "nil-rated", "non-gst"].includes(item.supplyStatus)) ? "Bill of Supply" : "Tax Invoice";
  const invoice = {
    version: 1, documentLabel, ...(turnover ? { hsnProfile: { ...turnover } } : {}), id, voucherId: id, number, type: input.type, direction, date: input.date, financialYear,
    registrationId: registration.id, partyId: party.id, registration: structuredClone(registration), party: structuredClone(party),
    ...context, ...reference, ...invoiceExportFields(input), supplierInvoiceNumber, items, totals,
    shippingAddress: text(input.shippingAddress, "delivery address", 500, false),
    narration: text(input.narration, "narration", 280, false),
    requestId: input.requestId ? text(input.requestId, "save identifier", 80) : null,
    requestHash: gstRequestHash(input),
  };
  if (invoice.reverseCharge) {
    invoice.partyDuePaise = invoice.totals.taxablePaise;
    invoice.rcm = buildRcmSnapshot(company, invoice, input, vouchers);
    if (invoice.rcm.selfInvoiceRequired) invoice.documentLabel = "Self-invoice";
  }
  assertGstReferences(invoice, vouchers);
  return invoice;
}
export function gstPostingLines(invoice) {
  if (invoice.tallyOrigin !== undefined) return tallyGstPostingLines(invoice);
  if (invoice.reverseCharge) return rcmPostingLines(invoice);
  const output = invoice.direction === "sales";
  const reducing = invoice.type === "Credit Note";
  const normal = output ? "Cr" : "Dr";
  const side = reducing ? (normal === "Cr" ? "Dr" : "Cr") : normal;
  const otherSide = side === "Dr" ? "Cr" : "Dr";
  const accounts = invoice.registration.accounts;
  const lines = [{ ledgerId: output ? invoice.party.customerLedgerId : invoice.party.supplierLedgerId, dc: otherSide, paise: invoice.totals.totalPaise }];
  const add = (ledgerId, paise) => { if (paise) lines.push({ ledgerId, dc: side, paise }); };
  add(output ? accounts.sales : accounts.purchase, invoice.totals.taxablePaise);
  if (!output && invoice.itcEligibility === "ineligible") add(accounts.nonCreditTax, invoice.totals.taxPaise);
  else for (const component of GST_COMPONENTS) add(accounts[`${output ? "output" : "input"}-${component}`], invoice.totals[`${component}Paise`]);
  return lines;
}
export function gstVoucher(invoice) {
  return { id: invoice.id, type: invoice.type, date: invoice.date, number: invoice.number, narration: invoice.narration, lines: gstPostingLines(invoice), gst: invoice };
}
export function gstAccountIds(company) {
  const masters = company.gst;
  return new Set([
    ...(masters?.registrations || []).flatMap(registration => Object.values(registration.accounts)),
    ...(masters?.parties || []).flatMap(party => [party.customerLedgerId, party.supplierLedgerId]),
    ...rcmAccountIds(company),
  ]);
}
export function gstInventory(company, vouchers, date = "9999-12-31") {
  const nativeGoods = new Set((company.gst?.items || []).filter(item=>item.kind === "goods").map(item=>item.id));
  if (!nativeGoods.size) return [];
  return stockState(company,vouchers,{to:date}).items.filter(item=>nativeGoods.has(item.itemId))
    .map(({itemId,name,unit,openingQuantity,quantity})=>({itemId,name,unit,openingQuantity,quantity}));
}
export function gstState(company, vouchers, date = todayISO()) {
  if (!isIsoDate(date)) throw new Error("Choose a valid date for the GST invoice series");
  const masters = company.gst || { version: 1, registrations: [], parties: [], items: [] };
  const nextInvoiceNumbers = Object.fromEntries(masters.registrations.map(registration => [registration.id, {
    Sales: nextInvoiceNumber(registration, vouchers, "Sales", "sales", date),
    Purchase: nextInvoiceNumber(registration, vouchers, "Purchase", "purchase", date),
    "Credit Note": nextInvoiceNumber(registration, vouchers, "Credit Note", "sales", date),
    "Debit Note": nextInvoiceNumber(registration, vouchers, "Debit Note", "sales", date),
    purchaseCreditNote: nextInvoiceNumber(registration, vouchers, "Credit Note", "purchase", date),
    purchaseDebitNote: nextInvoiceNumber(registration, vouchers, "Debit Note", "purchase", date),
  }]));
  return { company: { id: company.id, name: company.name, booksFrom: company.booksFrom }, ...masters,
    invoices: vouchers.filter(voucher => voucher.gst).map(voucher => voucher.gst), inventory: gstInventory(company, vouchers, date),
    states: GST_STATES, supportedStatuses: GST_STATUSES, taxComponents: GST_COMPONENTS, nextInvoiceNumbers };
}

export function assertGstSnapshot(company, voucher) {
  const invoice = voucher.gst;
  if (!invoice || invoice.version !== 1 || invoice.id !== voucher.id || invoice.voucherId !== voucher.id) throw new Error("Invalid linked GST invoice snapshot");
  const sourceIdentity = invoice.tallyOrigin !== undefined;
  if (sourceIdentity) assertTallyGstPosting(company, voucher);
  if (!DOCUMENT_TYPES.includes(invoice.type) || invoice.type !== voucher.type || invoice.date !== voucher.date || !sourceIdentity && invoice.number !== voucher.number || invoice.narration !== voucher.narration || invoice.financialYear !== fyStart(invoice.date).slice(0, 4)) throw new Error("GST invoice and journal identity do not match");
  const registration = invoice.registration;
  const party = invoice.party;
  if (!registration || !party || registration.id !== invoice.registrationId || party.id !== invoice.partyId) throw new Error("Invalid GST invoice party or registration snapshot");
  contact(registration, "registration");
  normalizeGstin(registration.gstin);
  contact(party, "party", true);
  if (!company.gst?.registrations.some(value => value.id === registration.id) || !company.gst?.parties.some(value => value.id === party.id)) throw new Error("The GST invoice references a missing registration or party");
  if (directionFor(invoice.type, invoice.direction) !== invoice.direction) throw new Error("Invalid GST invoice direction");
  if (!/^[A-Za-z0-9][A-Za-z0-9/-]{0,15}$/.test(invoice.number) || typeof invoice.shippingAddress !== "string" || invoice.shippingAddress.length > 500 || typeof invoice.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(invoice.requestHash)) throw new Error("Invalid GST invoice number, address or request hash");
  if (invoice.requestId !== null && (typeof invoice.requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(invoice.requestId))) throw new Error("Invalid GST invoice save identifier");
  const masterRegistration = company.gst.registrations.find(value => value.id === registration.id);
  const masterParty = company.gst.parties.find(value => value.id === party.id);
  if (masterRegistration.gstin !== registration.gstin || !isDeepStrictEqual(masterRegistration.accounts, registration.accounts) || masterParty.customerLedgerId !== party.customerLedgerId || masterParty.supplierLedgerId !== party.supplierLedgerId) throw new Error("The GST invoice's posting master linkage changed");
  for (const [key, value] of Object.entries(invoiceExportFields(invoice))) {
    if (invoice[key] !== value) throw new Error("Invalid saved export shipping particulars");
  }
  const context = taxContext(registration, party, invoice, invoice.direction);
  if (Object.keys(context).some(key => !isDeepStrictEqual(context[key], invoice[key]))) throw new Error("The GST invoice supply treatment does not match its saved location and options");
  if (!Array.isArray(invoice.items) || !invoice.items.length || invoice.items.length > 500) throw new Error("Invalid GST invoice lines");
  const computedItems = invoice.items.map(item => {
    itemValues({ ...item, pricePaise: item.unitPricePaise, openingQuantity: "0" });
    if (!company.gst.items.some(value => value.id === item.itemId)) throw new Error("The GST invoice references a missing item");
    return calculateLine({ ...item, id: item.itemId }, item, context);
  });
  if (!isDeepStrictEqual(computedItems, invoice.items) || !isDeepStrictEqual(calculateTotals(computedItems), invoice.totals)) throw new Error("The GST invoice amounts do not match its saved tax calculation");
  if (invoice.totals.totalPaise <= 0 || (invoice.direction === "purchase" && invoice.totals.taxPaise && !party.gstin && !invoice.reverseCharge)) throw new Error("Invalid GST invoice value or supplier tax registration");
  const label = invoice.type === "Credit Note" || invoice.type === "Debit Note" ? invoice.type : invoice.items.every(item => ["exempt", "nil-rated", "non-gst"].includes(item.supplyStatus)) ? "Bill of Supply" : "Tax Invoice";
  if (invoice.documentLabel !== (invoice.reverseCharge && invoice.rcm?.selfInvoiceRequired ? "Self-invoice" : label)) throw new Error("The GST document label does not match its supply status");
  assertRcmInvoice(company, invoice);
  const posting = gstPostingLines(invoice);
  if (!isDeepStrictEqual(posting, voucher.lines)) throw new Error("The GST invoice does not match its double-entry postings");
  for (const line of posting) if (!company.ledgers.some(ledger => ledger.id === line.ledgerId)) throw new Error("The GST invoice references a missing posting ledger");
  return structuredClone(invoice);
}
export function assertGstMasters(company) {
  if (company.gst === undefined) return;
  const masters = company.gst;
  if (!masters || masters.version !== 1 || !Array.isArray(masters.registrations) || !Array.isArray(masters.parties) || !Array.isArray(masters.items)) throw new Error("Invalid GST master data");
  validateTurnover(masters);
  validateIrpPolicies(masters);
  for (const list of [masters.registrations, masters.parties, masters.items]) {
    if (list.length > 10000 || new Set(list.map(item => item.id)).size !== list.length || list.some(item => !/^[a-z0-9-]{1,48}$/.test(item.id))) throw new Error("Invalid or duplicate GST master identity");
  }
  for (const registration of masters.registrations) {
    contact(registration, "registration");
    normalizeGstin(registration.gstin);
    if (!/^[A-Z0-9]{1,4}$/.test(registration.invoicePrefix)) throw new Error("Invalid GST invoice prefix");
    for (const key of ["sales", "purchase", "nonCreditTax", ...GST_COMPONENTS.flatMap(value => [`input-${value}`, `output-${value}`])]) {
      const expectedGroup = key === "sales" ? "g-sales" : ["purchase", "nonCreditTax"].includes(key) ? "g-purchase" : key.startsWith("input-") ? "g-current-assets" : "g-duties";
      if (!company.ledgers.some(ledger => ledger.id === registration.accounts?.[key] && ledger.groupId === expectedGroup)) throw new Error("A GST registration posting ledger is missing or has the wrong group");
    }
  }
  for (const party of masters.parties) {
    contact(party, "party", true);
    if (!["customer", "supplier", "both"].includes(party.kind) || !company.ledgers.some(ledger => ledger.id === party.customerLedgerId && ledger.groupId === "g-debtors") || !company.ledgers.some(ledger => ledger.id === party.supplierLedgerId && ledger.groupId === "g-creditors")) throw new Error("Invalid GST party posting ledgers");
  }
  for (const field of ["gstin", "invoicePrefix"]) if (new Set(masters.registrations.map(item => item[field])).size !== masters.registrations.length) throw new Error("Duplicate GST registration or invoice prefix");
  for (const list of [masters.parties, masters.items]) if (new Set(list.map(item => item.name.toLowerCase())).size !== list.length) throw new Error("Duplicate GST master names");
  for (const item of masters.items) itemValues(item);
}
