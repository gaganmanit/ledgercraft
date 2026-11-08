import { formatINR, parseRupees } from "./money.js";

export function nextLineAction(rows) {
  let gap = 0;
  for (const {debit,credit} of rows) {
    if (debit.trim() && credit.trim()) throw new Error("A line is either debit or credit");
    gap += parseRupees(debit) - parseRupees(credit);
    if (!Number.isSafeInteger(gap)) throw new Error("The voucher amount is too large");
  }
  if (!gap) return { index: rows.length, side: null, paise: 0, label: "Add line" };
  const blank = rows.findIndex(row => !row.debit.trim() && !row.credit.trim());
  const side = gap > 0 ? "credit" : "debit";
  const paise = Math.abs(gap);
  return { index: blank < 0 ? rows.length : blank, side, paise,
    label: (blank < 0 ? "Add " : "Fill ") + side + " ₹" + formatINR(paise) };
}
