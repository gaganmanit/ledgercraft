import { rcmLiabilityRows, rcmReturnRows, rcmState } from "./gst-rcm.js";

export function rcmPeriod(company, vouchers, registrationId, month) {
  const lastDay = new Date(Date.UTC(Number(month.slice(0,4)), Number(month.slice(5,7)), 0)).getUTCDate();
  const from = month + "-01", to = month + "-" + lastDay;
  const invoices = new Map(vouchers.filter(v=>v.gst?.reverseCharge && v.gst.registrationId === registrationId).map(v=>[v.id, v.gst]));
  if (!invoices.size) return { rows: [], issues: [] };
  const inRegistration = row => row.registrationId === registrationId;
  const liabilities = rcmLiabilityRows(company, vouchers, from, to).filter(inRegistration);
  const credits = rcmReturnRows(company, vouchers, from, to).filter(inRegistration);
  const rows = [];
  for (const row of liabilities) rows.push({ ...row, bucket: "inwardRcm", number: invoices.get(row.invoiceId).number });
  for (const row of credits) {
    const invoice = invoices.get(row.invoiceId);
    const claimBucket = row.importOfServices || invoice.party.stateCode === "96" ? "rcmImportCredit" : "rcmDomesticCredit";
    const isReversal = row.action === "itc-reversal";
    const bucket = isReversal ? ({
      "credit-note": claimBucket,
      "permanent-ineligibility": "rcmPermanentReversals",
      "temporary-reversal": "rcmTemporaryReversals",
    }[row.reversalReason] || "rcmReviewReversals") : claimBucket;
    const sign = isReversal && row.reversalReason === "credit-note" ? -1 : 1;
    rows.push({ ...row, number: invoice.number, bucket, sign, reason: isReversal ? row.reversalReason : row.action });
  }
  const issues = [];
  for (const doc of rcmState(company,vouchers,to).documents.filter(inRegistration)) {
    if (doc.date > to) continue;
    const issue = reason => issues.push({ id: doc.id, number: doc.number, reason });
    if (doc.lateSelfInvoice && doc.date >= from) issue("Self-invoice recorded after the 30-day issue window");
    if (Object.values(doc.reversalRequired).some(n=>n>0)) issue("Reverse-charge input credit needs reversal review");
    if (Object.values(doc.expenseReversalRequired).some(n=>n>0)) issue("Reverse-charge expense needs reversal review");
  }
  return { rows, issues };
}
