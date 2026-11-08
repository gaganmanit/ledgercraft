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
