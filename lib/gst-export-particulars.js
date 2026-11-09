import { isIsoDate } from "./money.js";

export function exportShippingFields(input) {
  const portCode = String(input.portCode ?? "").trim().toUpperCase();
  const shippingBillNumber = String(input.shippingBillNumber ?? "").trim();
  const shippingBillDate = String(input.shippingBillDate ?? "").trim();
  if (portCode && !/^[A-Z0-9]{6}$/.test(portCode)) throw new Error("Enter the six-character customs port code");
  // GSTN's GSTR-1 schema (Save GSTR1 data v4.1, sbnum) accepts a shipping bill number of 3 to 7 digits only.
  if (shippingBillNumber && !/^\d{3,7}$/.test(shippingBillNumber)) throw new Error("Enter the shipping bill number as 3 to 7 digits, as printed on the shipping bill");
  if (shippingBillDate && !isIsoDate(shippingBillDate)) throw new Error("Enter a valid shipping bill date");
  return {portCode, shippingBillNumber, shippingBillDate};
}

export function invoiceExportFields(input) {
  const fields = exportShippingFields(input);
  const destinationCountry = String(input.destinationCountry ?? "").trim().toUpperCase();
  if (destinationCountry && !/^[A-Z]{2}$/.test(destinationCountry)) throw new Error("Enter a two-letter destination country code");
  const saved = Object.fromEntries(Object.entries({...fields,destinationCountry}).filter(([,value]) => value));
  if (Object.keys(saved).length && input.supplyCategory !== "export") throw new Error("Shipping bill and destination country fields belong to an export");
  return saved;
}
