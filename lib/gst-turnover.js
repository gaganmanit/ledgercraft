import { fyStart } from "./money.js";

const bands = new Set(["up-to-5cr", "above-5cr"]);
const panOf = registration => registration.gstin.slice(2, 12);
function validateYear(value) {
  if (typeof value !== "string" || !/^20\d{2}$/.test(value) || Number(value) < 2017) throw new Error("Enter the financial year's starting year (2017 or later)");
}
export function turnoverFor(company, registration, date) {
  const year = fyStart(date).slice(0, 4);
  return company.gst?.turnoverByYear?.find(entry => entry.pan === panOf(registration) && entry.year === year) || null;
}
export function saveTurnover(company, input) {
  const gst = company.gst;
  const registration = gst?.registrations.find(r => r.id === input.registrationId);
  if (!registration) throw new Error("Select a saved GST registration");
  validateYear(input.year);
  if (!bands.has(input.band) && input.band !== "unspecified") throw new Error("Choose a preceding-year turnover band");
  const pan = panOf(registration);
  const entries = (gst.turnoverByYear || []).filter(e => e.pan !== pan || e.year !== input.year);
  const entry = { pan, year: input.year, band: input.band };
  if (entry.band !== "unspecified") entries.push(entry);
  gst.turnoverByYear = entries;
  return entry;
}
export function validateTurnover(gst) {
  if (gst.turnoverByYear === undefined) return;
  if (!Array.isArray(gst.turnoverByYear)) throw new Error("Invalid GST turnover history");
  const pans = new Set(gst.registrations.map(panOf)), keys = new Set();
  for (const entry of gst.turnoverByYear) {
    validateYear(entry.year);
    const key = entry.pan + ":" + entry.year;
    if (!pans.has(entry.pan) || !bands.has(entry.band) || keys.has(key)) throw new Error("Invalid or duplicate GST turnover profile");
    keys.add(key);
  }
}
export function minimumHsnDigits(profile, date) {
  if (!profile || date < "2021-04-01") return null;
  return profile.band === "above-5cr" ? 6 : 4;
}
