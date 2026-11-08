import { fyStart } from "./money.js";

export function supplierDocumentDate(invoice) {
  return invoice.rcm?.supplierInvoiceDate || invoice.supplierInvoiceDate || invoice.date;
}

export function validGstBookNumber(invoice) {
  const number = invoice.number;
  if (typeof number !== "string") return false;
  if (invoice.direction === "purchase" && !invoice.reverseCharge) {
    return number.trim() === number && number.length > 0 && number.length <= 24 && !/[\x00-\x1f\x7f]/.test(number);
  }
  return /^[A-Za-z0-9][A-Za-z0-9/-]{0,15}$/.test(number);
}

// Registration-issued numbers and a supplier's external series have separate scopes.
export function gstBookNumberKey(invoice) {
  const series = invoice.direction === "purchase" ? invoice.type : "outward";
  return JSON.stringify([invoice.registrationId, invoice.financialYear, series, invoice.number.toUpperCase()]);
}

export function supplierDocumentKey(invoice) {
  const supplier = invoice.party?.gstin || invoice.partyId;
  const year = fyStart(supplierDocumentDate(invoice));
  return JSON.stringify([invoice.registrationId, supplier, year, invoice.type, invoice.supplierInvoiceNumber.toUpperCase()]);
}

function legacyPurchase(invoice) {
  return invoice.direction === "purchase" && invoice.purchaseIdentityVersion === undefined &&
    invoice.supplierInvoiceDate === undefined && !invoice.tallyOrigin;
}

function legacySupplierKey(invoice) {
  return JSON.stringify([invoice.registrationId, invoice.partyId, invoice.financialYear, invoice.type, invoice.supplierInvoiceNumber.toUpperCase()]);
}

// The former format allowed a supplier to have several party ledgers and used
// the booking year. Keep their historical entries readable and identify them for review.
export function legacySupplierConflicts(vouchers) {
  const first = new Map(), conflicts = new Set();
  for (const { gst } of vouchers) {
    if (!gst || !legacyPurchase(gst) || !gst.supplierInvoiceNumber) continue;
    const key = supplierDocumentKey(gst);
    if (first.has(key)) { conflicts.add(first.get(key)); conflicts.add(gst.id); }
    else first.set(key, gst.id);
  }
  return conflicts;
}

export function assertUniqueGstDocuments(vouchers) {
  const bookNumbers = new Set(), supplierNumbers = new Map(), legacyNumbers = new Set();
  for (const { gst } of vouchers) {
    if (!gst) continue;
    const number = gstBookNumberKey(gst);
    if (bookNumbers.has(number)) throw new Error("That invoice number is already used for this GST registration and financial year");
    bookNumbers.add(number);
    if (gst.direction !== "purchase") continue;
    const reference = supplierDocumentKey(gst), legacy = legacyPurchase(gst);
    const oldKey = legacy && legacySupplierKey(gst);
    const strictCollision = supplierNumbers.has(reference) && (!legacy || !supplierNumbers.get(reference));
    if (strictCollision || (legacy && legacyNumbers.has(oldKey))) {
      throw new Error("That supplier document is already recorded for this party and financial year");
    }
    supplierNumbers.set(reference, legacy);
    if (legacy) legacyNumbers.add(oldKey);
  }
}
