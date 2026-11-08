import { isIsoDate } from "./money.js";

export function tallyDate(text) {
  const raw = String(text ?? "").trim();
  const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  const named = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  let iso = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : raw;
  if (named) iso = `${named[3]}-${months[named[2].toLowerCase()] || "00"}-${named[1].padStart(2, "0")}`;
  if (!isIsoDate(iso)) throw new Error(`Unsupported or missing Tally date ${raw || "(empty)"}`);
  return iso;
}

export function tallyAmount(input, emptyIsZero = false) {
  let text = String(input ?? "").trim();
  if (!text && emptyIsZero) return 0;
  text = text.replace(/^(?:₹|Rs\.?|INR)\s*/i, "").replace(/,/g, "").trim();
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`Amount needs exact INR paise: ${String(input).slice(0, 70)}`);
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace(/^[+-]/, "").split(".");
  const paise = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The source amount exceeds exact integer paise");
  return Number(paise) * (negative ? -1 : 1);
}

