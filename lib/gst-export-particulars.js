import { isIsoDate } from "./money.js";

export function exportShippingFields(input) {
  const portCode = String(input.portCode ?? "").trim().toUpperCase();
  const shippingBillNumber = String(input.shippingBillNumber ?? "").trim();
  const shippingBillDate = String(input.shippingBillDate ?? "").trim();
  if (portCode && !/^[A-Z0-9]{6}$/.test(portCode)) throw new Error("Enter the six-character customs port code");
  if (shippingBillNumber && !/^[A-Za-z0-9/-]{1,20}$/.test(shippingBillNumber)) throw new Error("Enter a shipping bill reference of up to 20 letters, digits, slashes or hyphens");
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
