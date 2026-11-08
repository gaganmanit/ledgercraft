import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { gstinCheckDigit } from "../lib/gst.js";
import { returnWorkbook } from "../lib/gst-returns.js";
import { gstrWorkbook } from "../lib/gst-workbook.js";
import { createStore } from "../lib/store.js";

const execute = promisify(execFile);
const resources = fileURLToPath(new URL("../lib/resources/", import.meta.url));
const columns = JSON.parse(await readFile(path.join(resources, "gstr1-columns.json"), "utf8"));
const template = path.join(resources, "GSTR1_Excel_Workbook_Template_V2.2.xlsx");
const manifest = path.join(resources, "gstr1-template.json");
const checker = fileURLToPath(new URL("./gst-workbook-check.py", import.meta.url));
const gstin = (state, pan = "ABCDE1234F") => {
  const prefix = `${state}${pan}1Z`;
  return prefix + gstinCheckDigit(prefix);
};
async function verify(report, additional) {
  const temporary = await mkdtemp(path.join(tmpdir(), "financer-xlsx-test-"));
  try {
    const file = path.join(temporary, "return.xlsx");
    const expected = path.join(temporary, "expected.json");
    const buffer = await gstrWorkbook(report);
    assert.equal(buffer.subarray(0, 2).toString(), "PK");
    await writeFile(file, buffer);
    await writeFile(expected, JSON.stringify({ report, ...additional }));
    const { stdout } = await execute(process.env.LEDGERCRAFT_PYTHON || "python3", [checker, file, template, manifest, expected], { timeout: 120000 });
    const checked = JSON.parse(stdout);
    assert.equal(checked.passed, true);
    if (additional.recalculate && process.env.FINANCER_TEST_RECALCULATE === "1") assert.equal(checked.recalculated, true);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

test("official XLSX preserves Excel-specific column order, data types, master lists and summaries", async () => {
  const sheets = Object.fromEntries(Object.keys(columns).map(name => [name, []]));
  const recipient = gstin("27", "PQRST5678L");
  sheets["b2b,sez,de"] = [
    [recipient, "=2+2", "00001", "31-Dec-26", "341.00", "27-Maharashtra", "N", "", "Regular B2B", "", 18, "200.00", "0.00"],
    [recipient, "=2+2", "00001", "31-Dec-26", "341.00", "27-Maharashtra", "N", "", "Regular B2B", "", 5, "100.00", "0.00"],
  ];
  sheets.b2cs = [["OE", "23-Madhya Pradesh", 5, "", "80.00", "0.00", ""]];
  sheets["hsn(b2b)"] = [["010121", "Synthetic goods", "NOS-NUMBERS", "2.5", "236.00", "200.00", "36.00", "0.00", "0.00", "0.00", 18]];
  sheets.exp = [["WPAY", "00002", "01-Dec-26", "118.00", "INBOM1", "0001234", "30-Nov-26", 18, "100.00", "0.00"]];
  sheets.docs = [["Invoices for outward supply", "00001", "00002", 2, 0]];
  const report = { month: "2026-12", registration: { gstin: gstin("23") }, sheets };
  await verify(report, { cached: [
    { sheet: "b2b,sez,de", cell: "A3", value: 1 }, { sheet: "b2b,sez,de", cell: "C3", value: 1 },
    { sheet: "b2b,sez,de", cell: "E3", value: "341.00", formulaContains: "MATCH" },
    { sheet: "b2b,sez,de", cell: "L3", value: "300.00" },
    { sheet: "b2cs", cell: "E3", value: "80.00" }, { sheet: "hsn(b2b)", cell: "G3", value: "200.00" },
    { sheet: "exp", cell: "I3", value: "100.00" }, { sheet: "exp", cell: "J3", value: "0.00" },
    { sheet: "docs", cell: "D3", value: 2 },
  ] });
});

test("posted mixed-rate invoice and credit note reconcile exact return totals through XLSX", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "financer-xlsx-books-"));
  const store = createStore(temporary);
  try {
    const { company } = await store.create({ name: "Synthetic XLSX Books", booksFrom: "2026-04-01" });
    const { registration } = await store.saveGstMaster(company.id, "registration", { name: "Synthetic Supplier", gstin: gstin("23"), stateCode: "23", address: "Synthetic supplier address" });
    const { party } = await store.saveGstMaster(company.id, "party", { name: "Synthetic Customer", gstin: gstin("27", "PQRST5678L"), stateCode: "27", address: "Synthetic recipient address", kind: "customer" });
    const goods = [];
    for (const [name, code, rate] of [["Synthetic Goods A", "854140", 1800], ["Synthetic Goods B", "010121", 500]]) goods.push((await store.saveGstMaster(company.id, "item", { name, kind: "goods", hsnSac: code, unit: "NOS", pricePaise: 10000, gstRateBps: rate, openingQuantity: "10" })).item);
    const payload = { type: "Sales", registrationId: registration.id, partyId: party.id, date: "2026-11-01", placeOfSupply: "27", pricing: "exclusive", items: [{ itemId: goods[0].id, quantity: "2", unitPricePaise: 10000 }, { itemId: goods[1].id, quantity: "1", unitPricePaise: 10000 }] };
    const sale = (await store.passGstInvoice(company.id, payload)).invoice;
    const { invoice: credit } = await store.passGstInvoice(company.id, { ...payload, type: "Credit Note", direction: "sales", originalInvoiceId: sale.id, date: "2026-11-30", stockEffect: "quantity", items: [{ itemId: goods[0].id, quantity: "1", unitPricePaise: 10000 }] });
    await store.saveCreditReview(company.id,{invoiceId:credit.id,requestId:"synthetic-workbook-credit",revision:0,declarationDate:"2026-12-11",
      annualReturnStatus:"not-filed",recipientBasis:"not-availed",adjustmentGround:"goods-returned",groundConfirmed:true,reference:"Synthetic delivery and credit evidence"});
    const book = await store.get(company.id);
    const report = returnWorkbook(book.company, book.vouchers, registration.id, "2026-11");
    assert.equal(report.sheets["b2b,sez,de"].length, 2);
    assert.equal(report.sheets.cdnr.length, 1);
    await verify(report, { mode: "end-to-end", netValuePaise: 22300, netTaxablePaise: 20000, cached: [
      { sheet: "b2b,sez,de", cell: "E3", value: "341.00" }, { sheet: "cdnr", cell: "I3", value: "118.00" },
      { sheet: "hsn(b2b)", cell: "E3", value: "223.00" }, { sheet: "hsn(b2b)", cell: "G3", value: "200.00" },
      { sheet: "hsn(b2b)", cell: "H3", value: "23.00" },
    ] });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("unsupported or inexact workbook input rejects without a partial artifact", async () => {
  await assert.rejects(gstrWorkbook({}), /registration and return month/);
  const sheets = Object.fromEntries(Object.keys(columns).map(name => [name, []]));
  const report = { month: "2026-11", registration: { gstin: gstin("23") }, sheets };
  const invalidColumns = structuredClone(report);
  invalidColumns.sheets.b2cs.push(["OE"]);
  await assert.rejects(gstrWorkbook(invalidColumns), /unexpected column count|exact INR paise/);
  const inexact = structuredClone(report);
  inexact.sheets.b2cs = [["OE", "23-Madhya Pradesh", 18, "", "90071992547409.91", "0.00", ""]];
  await assert.rejects(gstrWorkbook(inexact), /fifteen significant digits/);
});


test("literal document identifiers have exact distinct summaries", async () => {
  const sheets = Object.fromEntries(Object.keys(columns).map(name => [name, []]));
  const recipient = gstin("27", "PQRST5678L");
  for (const [number, amount] of [["0001", "118.00"], ["0001", "118.00"], ["1", "236.00"], ["A*1", "354.00"], ["AB1", "472.00"], ["A?1", "590.00"], ["A~1", "708.00"]]) {
    sheets["b2b,sez,de"].push([recipient, "Synthetic Customer", number, "01-Dec-26", amount, "27-Maharashtra", "N", "", "Regular B2B", "", 18, "100.00", "0.00"]);
  }
  await verify({ month: "2026-12", registration: { gstin: gstin("23") }, sheets }, {
    recalculate: true,
    cached: [{ sheet: "b2b,sez,de", cell: "C3", value: 6, formulaContains: "MATCH" }, { sheet: "b2b,sez,de", cell: "E3", value: "2478.00" }],
  });
});
