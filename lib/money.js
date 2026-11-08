export function formatINR(paise) {
  const n = Number(paise);
  if (!Number.isInteger(n)) return "";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const rupees = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${groupIndian(String(rupees))}.${frac}`;
}

export function groupIndian(digits) {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  const parts = [];
  let rest = head;
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return `${parts.join(",")},${tail}`;
}

export function parseRupees(input) {
  const raw = String(input ?? "").trim().replace(/,/g, "").replace(/^\u20b9/, "");
  if (!raw || raw === ".") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error("Enter an amount in rupees, such as 1,500.50");
  }
  const [rupees, frac = ""] = raw.split(".");
  return Number(rupees) * 100 + Number(frac.padEnd(2, "0"));
}

export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function todayISO(now = new Date()) {
  const z = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${z(now.getMonth() + 1)}-${z(now.getDate())}`;
}

export function fyStart(iso) {
  const [y, m] = iso.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-04-01`;
}

export function fyLabel(iso) {
  const start = Number(fyStart(iso).slice(0, 4));
  return `${start}\u2013${String(start + 1).slice(-2)}`;
}

const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function belowThousand(n) {
  const parts = [];
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} hundred`); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "")); }
  else if (n > 0) parts.push(ONES[n]);
  return parts.join(" ");
}

/** Indian-system words for a whole number: crore, lakh, thousand, hundred. */
export function numberInWords(value) {
  let n = Math.trunc(Math.abs(Number(value)));
  if (!Number.isSafeInteger(n)) throw new Error("The amount is too large to write in words");
  if (n === 0) return "zero";
  const parts = [];
  const crore = Math.floor(n / 10_000_000); n %= 10_000_000;
  const lakh = Math.floor(n / 100_000); n %= 100_000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(`${numberInWords(crore)} crore`);
  if (lakh) parts.push(`${belowThousand(lakh)} lakh`);
  if (thousand) parts.push(`${belowThousand(thousand)} thousand`);
  if (n) parts.push(belowThousand(n));
  return parts.join(" ");
}

/** "Rupees twelve thousand five hundred and fifty paise only", as printed on Indian invoices. */
export function rupeesInWords(paise) {
  const n = Number(paise);
  if (!Number.isInteger(n)) throw new Error("Amounts in words need a whole number of paise");
  const abs = Math.abs(n);
  const rupees = Math.floor(abs / 100);
  const frac = abs % 100;
  const words = [];
  if (rupees || !frac) words.push(`Rupees ${numberInWords(rupees)}`);
  if (frac) words.push(`${rupees ? "and " : ""}${numberInWords(frac)} paise`);
  const text = `${words.join(" ")} only`;
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return n < 0 ? `Minus ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}` : sentence;
}
