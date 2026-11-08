// Voucher numbering series. Each voucher type has a prefix, a counter padded to
// `width` digits (0 means no padding) and a suffix. Either side may contain the
// token {fy}, which renders as the financial year of the voucher date ("26-27"
// for FY 2026-27). A series can restart its counter every financial year; its
// numbers are then unique per type within each financial year rather than across
// the whole book. With no saved configuration the series reproduce the original
// suggestions (RCT-1, RCT-2, ...).
import { VOUCHER_TYPES } from "./groups.js";
import { fyStart, isIsoDate, todayISO } from "./money.js";

export const DEFAULT_PREFIXES = {
  Payment: "PMT-",
  Receipt: "RCT-",
  Contra: "CTR-",
  Journal: "JRN-",
  Sales: "SAL-",
  Purchase: "PUR-",
  "Debit Note": "DBN-",
  "Credit Note": "CRN-",
};

const PART_RE = /^[A-Za-z0-9/-]*$/;
const FY_TOKEN = /\{fy\}/g;
const MAX_NUMBER = 24;
// A counter shorter than this still fits within the 24-character voucher number.
const COUNTER_ROOM = 4;

export function defaultSeries(type) {
  return { prefix: DEFAULT_PREFIXES[type], suffix: "", width: 0, restartEachFY: false };
}

/** The effective series for every voucher type: saved settings over the defaults. */
export function numberingConfig(company) {
  const saved = company?.numbering && typeof company.numbering === "object" ? company.numbering : {};
  return Object.fromEntries(VOUCHER_TYPES.map((type) => {
    const series = saved[type];
    if (!series || typeof series !== "object") return [type, defaultSeries(type)];
    const next = { ...defaultSeries(type), ...pick(series) };
    return [type, next];
  }));
}

function pick(series) {
  const out = {};
  for (const key of ["prefix", "suffix", "width", "restartEachFY", "next"]) if (series[key] !== undefined) out[key] = series[key];
  if (out.next === null) delete out.next;
  return out;
}

export function seriesFor(company, type) {
  return numberingConfig(company)[type] || defaultSeries(type);
}

/** "26-27" for any date in FY 2026-27. */
export function fyToken(date) {
  const start = Number(fyStart(date).slice(0, 4));
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
}

function render(part, date) {
  return String(part || "").replace(FY_TOKEN, () => fyToken(date));
}

export function formatNumber(series, counter, date) {
  const digits = String(counter).padStart(series.width || 0, "0");
  return `${render(series.prefix, date)}${digits}${render(series.suffix, date)}`;
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

// The counter of a number written in this series for the given date, or null.
function seriesCounter(series, number, date) {
  const prefix = render(series.prefix, date);
  const suffix = render(series.suffix, date);
  const match = new RegExp(`^${escape(prefix)}(\\d+)${escape(suffix)}$`).exec(number);
  return match ? Number(match[1]) : null;
}

// Fallback for numbers written outside the configured series (imported books,
// earlier prefixes, Tally numbers such as INV/26-27/0012): the trailing run of
// digits, after dropping a trailing financial-year token such as "/26-27" or
// "-2026-27", so that "SAL-5/26-27" reads as 5 and not 27.
export function trailingCounter(number) {
  const text = String(number ?? "").trim();
  const withoutYear = text.replace(/[/-]?(\d{4}|\d{2})-(\d{2})$/, (token, first, second, offset) =>
    offset > 0 && (Number(first) + 1) % 100 === Number(second) ? "" : token);
  const match = /(\d+)$/.exec(withoutYear);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function sameScope(series, a, b) {
  return !series.restartEachFY || fyStart(a) === fyStart(b);
}

/** Next number for one voucher type, within the financial year of `date` when the series restarts yearly. */
export function nextNumberFor(company, vouchers, type, date = todayISO()) {
  const series = seriesFor(company, type);
  const day = isIsoDate(date) ? date : todayISO();
  let inSeries = 0;
  let anyInSeries = false;
  let fallback = 0;
  for (const voucher of vouchers) {
    if (voucher.type !== type || !isIsoDate(voucher.date) || !sameScope(series, voucher.date, day)) continue;
    const own = seriesCounter(series, String(voucher.number), voucher.date);
    if (own !== null && Number.isSafeInteger(own)) {
      anyInSeries = true;
      inSeries = Math.max(inSeries, own);
      continue;
    }
    const other = trailingCounter(voucher.number);
    if (other !== null) fallback = Math.max(fallback, other);
  }
  // Default series continue after the highest number of the type, as Ledgercraft always
  // has. Once a series is configured, numbers already written in it decide the next one;
  // a configured series without any numbers yet continues after the highest number.
  const configured = Boolean(company?.numbering?.[type]);
  const highest = configured && anyInSeries ? inSeries : Math.max(inSeries, fallback);
  let counter = Math.max(highest + 1, Number.isSafeInteger(series.next) ? series.next : 1);
  let number = formatNumber(series, counter, day);
  // Never suggest a number that is already taken in its scope.
  const taken = new Set(vouchers.filter((v) => v.type === type && isIsoDate(v.date) && sameScope(series, v.date, day)).map((v) => v.number));
  while (taken.has(number)) number = formatNumber(series, ++counter, day);
  return number;
}

/** Suggested next number for each voucher type on `date` (today by default). */
export function nextNumbers(company, vouchers, date = todayISO()) {
  return Object.fromEntries(VOUCHER_TYPES.map((type) => [type, nextNumberFor(company, vouchers, type, date)]));
}

/** True when two vouchers of `type` dated `a` and `b` must not share a number. */
export function numberScopeShared(company, type, a, b) {
  const series = seriesFor(company, type);
  if (!series.restartEachFY || !isIsoDate(a) || !isIsoDate(b)) return true;
  return fyStart(a) === fyStart(b);
}

/** Key under which a voucher number must be unique in this book. */
export function numberKey(company, voucher) {
  const series = seriesFor(company, voucher.type);
  const scope = series.restartEachFY && isIsoDate(voucher.date) ? fyStart(voucher.date) : "";
  return `${voucher.type}\u0000${scope}\u0000${voucher.number}`;
}

function checkedPart(value, label, type) {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`${type}: the ${label} must be text`);
  const text = value.trim();
  if (text.length > 12) throw new Error(`${type}: the ${label} can be up to 12 characters`);
  if (!PART_RE.test(text.replace(FY_TOKEN, ""))) throw new Error(`${type}: the ${label} can use letters, digits, / and -, and the {fy} token`);
  return text;
}

/** Validate one series. Returns the stored form. */
export function checkedSeries(type, input) {
  if (!VOUCHER_TYPES.includes(type)) throw new Error(`Unknown voucher type ${type}`);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${type}: choose a prefix, suffix and width`);
  const prefix = checkedPart(input.prefix, "prefix", type);
  const suffix = checkedPart(input.suffix, "suffix", type);
  const width = input.width ?? 0;
  if (!Number.isInteger(width) || width < 0 || width > 8) throw new Error(`${type}: the width is a whole number from 0 to 8`);
  if (input.restartEachFY !== undefined && typeof input.restartEachFY !== "boolean") throw new Error(`${type}: restart each financial year is yes or no`);
  const series = { prefix, suffix, width, restartEachFY: input.restartEachFY === true };
  if (input.next !== undefined && input.next !== null) {
    if (!Number.isSafeInteger(input.next) || input.next < 1 || input.next > 999_999_999) throw new Error(`${type}: the next number is a whole number from 1 to 999999999`);
    series.next = input.next;
  }
  const sample = formatNumber(series, 1, "2026-04-01").length - 1;
  if (sample + Math.max(width, COUNTER_ROOM) > MAX_NUMBER) throw new Error(`${type}: the prefix, suffix and width leave too little room within the 24-character voucher number`);
  return series;
}

/** Validate a saved numbering map (on import and on save). */
export function assertNumbering(numbering) {
  if (numbering === undefined) return;
  if (!numbering || typeof numbering !== "object" || Array.isArray(numbering)) throw new Error("Invalid voucher numbering settings");
  for (const [type, series] of Object.entries(numbering)) {
    const checked = checkedSeries(type, series);
    for (const key of Object.keys(series)) if (!["prefix", "suffix", "width", "restartEachFY", "next"].includes(key)) throw new Error(`${type}: unknown numbering setting ${key}`);
    if (checked.prefix !== series.prefix || checked.suffix !== (series.suffix ?? "") || checked.width !== (series.width ?? 0)) throw new Error("Invalid voucher numbering settings");
  }
}

/** Numbers that would collide if `type` stopped restarting each financial year. */
export function crossYearDuplicate(vouchers, type) {
  const seen = new Map();
  for (const voucher of vouchers) {
    if (voucher.type !== type) continue;
    const prior = seen.get(voucher.number);
    if (prior !== undefined && prior !== voucher.id) return voucher.number;
    seen.set(voucher.number, voucher.id);
  }
  return null;
}

/** The effective configuration and the next number of every type for `date`. */
export function numberingView(company, vouchers, date = todayISO()) {
  return { numbering: numberingConfig(company), preview: nextNumbers(company, vouchers, date), date };
}
