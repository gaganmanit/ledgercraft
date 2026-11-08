import test from "node:test";
import assert from "node:assert/strict";
import { formatINR, groupIndian, parseRupees, numberInWords, rupeesInWords, fyLabel, fyStart } from "../lib/money.js";

test("Indian digit grouping and paise formatting", () => {
  assert.equal(groupIndian("1234567"), "12,34,567");
  assert.equal(groupIndian("100"), "100");
  assert.equal(groupIndian("1000"), "1,000");
  assert.equal(formatINR(123456789), "12,34,567.89");
  assert.equal(formatINR(-5), "-0.05");
  assert.equal(formatINR(0), "0.00");
});

test("rupee parsing accepts commas and a rupee sign and rejects three decimals", () => {
  assert.equal(parseRupees("1,500.50"), 150050);
  assert.equal(parseRupees("₹2,000"), 200000);
  assert.equal(parseRupees(""), 0);
  assert.throws(() => parseRupees("1.234"), /rupees/);
});

test("numbers in words follow the crore, lakh, thousand system", () => {
  assert.equal(numberInWords(0), "zero");
  assert.equal(numberInWords(19), "nineteen");
  assert.equal(numberInWords(45), "forty-five");
  assert.equal(numberInWords(100), "one hundred");
  assert.equal(numberInWords(1001), "one thousand one");
  assert.equal(numberInWords(99_999), "ninety-nine thousand nine hundred ninety-nine");
  assert.equal(numberInWords(1_00_000), "one lakh");
  assert.equal(numberInWords(12_34_567), "twelve lakh thirty-four thousand five hundred sixty-seven");
  assert.equal(numberInWords(1_00_00_000), "one crore");
  assert.equal(numberInWords(123_45_67_890), "one hundred twenty-three crore forty-five lakh sixty-seven thousand eight hundred ninety");
});

test("rupees in words read like an Indian invoice", () => {
  assert.equal(rupeesInWords(1250050), "Rupees twelve thousand five hundred and fifty paise only");
  assert.equal(rupeesInWords(100), "Rupees one only");
  assert.equal(rupeesInWords(0), "Rupees zero only");
  assert.equal(rupeesInWords(75), "Seventy-five paise only");
  assert.equal(rupeesInWords(1_00_000_00), "Rupees one lakh only");
  assert.equal(rupeesInWords(-500), "Minus rupees five only");
  assert.throws(() => rupeesInWords(1.5), /whole number/);
});

test("financial year helpers pivot on April", () => {
  assert.equal(fyStart("2026-03-31"), "2025-04-01");
  assert.equal(fyStart("2026-04-01"), "2026-04-01");
  assert.equal(fyLabel("2026-11-08"), "2026–27");
});
