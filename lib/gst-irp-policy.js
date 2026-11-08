import { isIsoDate, todayISO } from "./money.js";
const statuses = new Set(["required", "exempt", "below-threshold"]);
function validateProfile(row) {
  if (!isIsoDate(row.effectiveFrom) || !statuses.has(row.status)) throw new Error("Choose the effective date and e-invoice applicability");
  if (typeof row.thirtyDayWindow !== "boolean" || (row.status !== "required" && row.thirtyDayWindow)) throw new Error("The IRP reporting window applies to a covered registration");
  if (typeof row.declaration !== "string" || row.declaration.length > 1200 || (row.status === "exempt" && !row.declaration.trim())) throw new Error("Enter the registration's Rule 46(s) exemption declaration");
}
export function saveIrpPolicy(company, input) {
  const registration = company.gst?.registrations.find(r => r.id === input.registrationId);
  if (!registration) throw new Error("Select a saved GST registration");
  const row = { registrationId: registration.id, effectiveFrom: input.effectiveFrom, status: input.status,
    thirtyDayWindow: input.thirtyDayWindow === true, declaration: input.status === "exempt" ? String(input.declaration || "").trim() : "" };
  validateProfile(row);
  const rows = (company.gst.irpPolicies || []).filter(r => r.registrationId !== row.registrationId || r.effectiveFrom !== row.effectiveFrom);
  rows.push(row);
  company.gst.irpPolicies = rows.sort((a,b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return row;
}
export function validateIrpPolicies(gst) {
  if (gst.irpPolicies === undefined) return;
  if (!Array.isArray(gst.irpPolicies)) throw new Error("Invalid e-invoice applicability records");
  const seen = new Set(), ids = new Set(gst.registrations.map(r=>r.id));
  for (const row of gst.irpPolicies) {
    validateProfile(row);
    const key = row.registrationId + "|" + row.effectiveFrom;
    if (!ids.has(row.registrationId) || seen.has(key)) throw new Error("Invalid registration or duplicate effective date for e-invoicing");
    seen.add(key);
  }
}
export function invoiceIrpStatus(company, invoice, acknowledgement, asOf = todayISO()) {
  const applicableSupply = invoice.direction === "sales" && invoice.documentLabel !== "Bill of Supply" &&
    Boolean(invoice.party.gstin || invoice.supplyCategory === "export");
  const policy = (company.gst?.irpPolicies || []).filter(p => p.registrationId === invoice.registrationId &&
    p.effectiveFrom <= invoice.date).sort((a,b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  const required = applicableSupply && policy?.status === "required";
  let reportBy = null;
  if (required && policy.thirtyDayWindow) {
    const deadline = new Date(invoice.date + "T00:00:00Z");
    deadline.setUTCDate(deadline.getUTCDate() + 29);
    reportBy = deadline.toISOString().slice(0,10);
  }
  return { status: policy?.status || "unrecorded", required, pending: Boolean(required && !acknowledgement),
    reportBy, overdue: Boolean(reportBy && !acknowledgement && asOf > reportBy),
    declaration: invoice.direction === "sales" && policy?.status === "exempt" && invoice.documentLabel === "Tax Invoice" ? policy.declaration : "" };
}
