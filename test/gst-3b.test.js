import test from "node:test";
import assert from "node:assert/strict";
import { gstr3bWorking, gstr3bExport, gstr3bJson, gstr3bDueDate, utiliseCredit, lateFeeUnderSection47, simpleInterest, daysAfter } from "../lib/gst-3b.js";
import { handleReturnRoute } from "../lib/gst-return-routes.js";
import { gstinCheckDigit } from "../lib/gst.js";

const withCheck = first14 => first14 + gstinCheckDigit(first14);
const registration = { id: "reg", name: "Synthetic company", gstin: "23ABCDE1234F1Z8", stateCode: "23" };
const uinGstin = withCheck("0718USA00001UN");
const compositionGstin = withCheck("29AAACC1234C1Z");
const parties = [
  { id: "p-comp", name: "Composition buyer", gstin: compositionGstin, stateCode: "29", compositionDealer: true },
  { id: "p-comp-supplier", name: "Composition supplier", gstin: withCheck("23AAACK1234C1Z"), stateCode: "23", compositionDealer: true },
];
const heads0 = { igstPaise: 0, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 };

function line(taxablePaise, { inter = false, rateBps = 1800, supplyStatus = "taxable", cessPaise = 0 } = {}) {
  const tax = supplyStatus === "taxable" ? taxablePaise * rateBps / 10000 : 0;
  const igstPaise = inter ? tax : 0, cgstPaise = inter ? 0 : tax / 2, sgstPaise = inter ? 0 : tax / 2;
  return { itemId: "item", kind: "goods", name: "Panel", hsnSac: "8541", unit: "NOS", quantity: "1", gstRateBps: supplyStatus === "taxable" ? rateBps : 0, supplyStatus,
    taxablePaise, igstPaise, cgstPaise, sgstPaise, utgstPaise: 0, cessPaise, taxPaise: tax + cessPaise, totalPaise: taxablePaise + tax + cessPaise };
}
function doc(number, date, party, placeOfSupply, items, changes = {}) {
  const id = number.toLowerCase();
  const totals = Object.fromEntries(["taxablePaise", "igstPaise", "cgstPaise", "sgstPaise", "utgstPaise", "cessPaise", "taxPaise", "totalPaise"].map(k => [k, items.reduce((s, l) => s + l[k], 0)]));
  return { id, date, type: changes.type || "Sales", number, gst: { id, date, number, type: "Sales", direction: "sales", registration, registrationId: "reg", partyId: party.id || "p-" + id, party,
    placeOfSupply, supplyCategory: "domestic", stockEffect: "quantity", items, totals, ...changes } };
}
const purchase = (number, date, party, items, changes = {}) => doc(number, date, party, "23", items, { type: "Purchase", direction: "purchase", supplierInvoiceNumber: number, itcEligibility: "pending", ...changes });

function book() {
  const vouchers = [
    doc("SI-1", "2026-06-01", { name: "Local dealer", gstin: "23AAACL1234C1Z5", stateCode: "23" }, "23", [line(10000)]),
    doc("SI-2", "2026-06-02", { name: "Consumer", gstin: "" }, "27", [line(20000, { inter: true })]),
    doc("SI-3", "2026-06-03", { name: "Consumer", gstin: "" }, "27", [line(5000, { inter: true })]),
    doc("SI-4", "2026-06-04", { name: "Consumer", gstin: "" }, "09", [line(8000, { inter: true }), line(1000, { supplyStatus: "exempt" })]),
    doc("SI-5", "2026-06-05", { name: "Embassy", gstin: uinGstin, identifierType: "uin", stateCode: "07" }, "07", [line(30000, { inter: true })]),
    doc("SI-6", "2026-06-06", { id: "p-comp", name: "Composition buyer", gstin: compositionGstin, stateCode: "29" }, "29", [line(40000, { inter: true })]),
    doc("SI-7", "2026-06-07", { name: "Mumbai dealer", gstin: "27ABCDE1234F1Z0", stateCode: "27" }, "27", [line(50000, { inter: true })]),
    doc("SI-8", "2026-06-08", { name: "Consumer", gstin: "" }, "23", [line(6000)]),
    purchase("PI-1", "2026-06-10", { name: "Local farm", gstin: "", stateCode: "23" }, [line(3000, { supplyStatus: "exempt" }), line(700, { supplyStatus: "nil-rated" })]),
    purchase("PI-2", "2026-06-11", { name: "Mumbai landlord", gstin: "", stateCode: "27" }, [line(4000, { supplyStatus: "non-gst" })]),
    purchase("PI-3", "2026-06-12", { id: "p-comp-supplier", name: "Composition supplier", gstin: parties[1].gstin, stateCode: "23" }, [{ ...line(2500, { supplyStatus: "taxable", rateBps: 0 }) }]),
    purchase("PI-4", "2026-06-13", { name: "Delhi exempt supplier", gstin: "07AAACD1234C1Z9", stateCode: "07" }, [line(1500, { supplyStatus: "nil-rated" })]),
    doc("PI-5", "2026-06-14", { name: "Delhi exempt supplier", gstin: "07AAACD1234C1Z9", stateCode: "07" }, "23", [line(500, { supplyStatus: "nil-rated" })],
      { type: "Credit Note", direction: "purchase", originalInvoiceId: "pi-4", originalNumber: "PI-4", originalDate: "2026-06-13", stockEffect: "none" }),
  ];
  const company = { id: "synthetic-3b", gst: { registrations: [registration], parties, turnoverByYear: [{ pan: "ABCDE1234F", year: "2026", band: "up-to-5cr" }] } };
  return { company, vouchers };
}

test("Rule 88A and section 49(5): IGST credit first, CGST and SGST never cross, CGST before SGST against IGST, cess alone", () => {
  const first = utiliseCredit({ igstPaise: 10000, cgstPaise: 5000, sgstPaise: 5000, cessPaise: 100 }, { igstPaise: 12000, cgstPaise: 1000, sgstPaise: 4000, cessPaise: 50 });
  assert.deepEqual(first.steps, [{ from: "igst", to: "igst", paise: 10000 }, { from: "igst", to: "cgst", paise: 2000 }, { from: "cgst", to: "cgst", paise: 1000 }, { from: "sgst", to: "sgst", paise: 4000 }, { from: "cess", to: "cess", paise: 50 }]);
  assert.deepEqual(first.cashPaise, { igstPaise: 0, cgstPaise: 2000, sgstPaise: 1000, cessPaise: 50 });
  assert.equal(first.used.cgst.sgstPaise, 0); assert.equal(first.used.sgst.cgstPaise, 0);
  const second = utiliseCredit({ igstPaise: 5000, cgstPaise: 0, sgstPaise: 0, cessPaise: 0 }, { igstPaise: 0, cgstPaise: 3000, sgstPaise: 4000, cessPaise: 900 });
  assert.deepEqual(second.steps, [{ from: "cgst", to: "igst", paise: 3000 }, { from: "sgst", to: "igst", paise: 2000 }]);
  assert.deepEqual(second.creditBalancePaise, { igstPaise: 0, cgstPaise: 0, sgstPaise: 2000, cessPaise: 900 });
  // Section 49A: IGST credit is used up before CGST credit, aimed first at the head its own credit cannot cover.
  const third = utiliseCredit({ igstPaise: 0, cgstPaise: 3000, sgstPaise: 3000, cessPaise: 0 }, { igstPaise: 4000, cgstPaise: 3000, sgstPaise: 0, cessPaise: 0 });
  assert.deepEqual(third.steps, [{ from: "igst", to: "sgst", paise: 3000 }, { from: "igst", to: "cgst", paise: 1000 }, { from: "cgst", to: "cgst", paise: 2000 }]);
  assert.deepEqual(third.cashPaise, heads0); assert.deepEqual(third.creditBalancePaise, { ...heads0, cgstPaise: 1000 });
  // SGST credit cannot pay CGST even with nothing else to pay.
  assert.deepEqual(utiliseCredit({ ...heads0, cgstPaise: 700 }, { ...heads0, sgstPaise: 5000 }).cashPaise, { ...heads0, cgstPaise: 700 });
});

test("due dates: 20th for monthly filers, 22nd or 24th by State group for QRMP", () => {
  assert.equal(gstr3bDueDate("2026-06"), "2026-07-20");
  assert.equal(gstr3bDueDate("2026-12"), "2027-01-20");
  assert.equal(gstr3bDueDate("2026-06", "quarterly", "23"), "2026-07-22");
  assert.equal(gstr3bDueDate("2027-03", "quarterly", "09"), "2027-04-24");
  assert.equal(daysAfter("2026-07-20", "2026-07-30"), 10);
  assert.equal(daysAfter("2026-07-20", "2026-07-10"), 0);
  const { company, vouchers } = book();
  assert.throws(() => gstr3bWorking(company, vouchers, "reg", "2026-05", { frequency: "quarterly" }), /last month of the quarter/);
  const quarter = gstr3bWorking(company, vouchers, "reg", "2026-06", { frequency: "quarterly" });
  assert.deepEqual(quarter.months, ["2026-04", "2026-05", "2026-06"]); assert.equal(quarter.dueDate, "2026-07-22"); assert.equal(quarter.returnPeriod, "062026");
});

test("section 47 late fee caps for every Notification 19/2021 slab and a nil return", () => {
  const fee = (filingDate, nil, turnover) => lateFeeUnderSection47({ month: "2026-06", dueDate: "2026-07-20", filingDate, nil, turnover });
  const crore = n => ({ paise: Math.round(n * 1_00_00_000 * 100) });
  assert.equal(fee("2026-07-20", false, crore(1)).totalPaise, 0);
  assert.deepEqual([fee("2026-07-30", false, crore(1)).cgstPaise, fee("2026-07-30", false, crore(1)).totalPaise], [25000, 50000]);
  assert.equal(fee("2026-07-30", true, null).totalPaise, 20000);
  assert.equal(fee("2026-08-19", true, null).totalPaise, 50000);
  assert.equal(fee("2026-08-19", true, null).slab, "nil");
  assert.equal(fee("2026-10-28", false, crore(1.5)).totalPaise, 200000);
  assert.equal(fee("2026-10-28", false, crore(1.5)).slab, "up-to-1.5cr");
  assert.equal(fee("2027-02-05", false, crore(4.99)).totalPaise, 500000);
  assert.equal(fee("2027-05-16", false, crore(6)).totalPaise, 1000000);
  assert.deepEqual(fee("2027-05-16", false, crore(6)).capPaise, { cgstPaise: 500000, sgstPaise: 500000 });
  const banded = fee("2027-02-05", false, { band: "up-to-5cr" });
  assert.equal(banded.totalPaise, 500000); assert.match(banded.issues[0], /1\.5 crore/);
  assert.equal(fee("2027-05-16", false, null).totalPaise, 1000000);
  assert.equal(lateFeeUnderSection47({ month: "2021-05", dueDate: "2021-06-20", filingDate: "2021-07-20", nil: false, turnover: crore(1) }).applicable, null);
  // A working with no supplies at all is a nil return.
  const empty = gstr3bWorking({ gst: { registrations: [registration] } }, [], "reg", "2026-06", { filingDate: "2026-08-29", aggregateTurnoverPaise: crore(1).paise });
  assert.equal(empty.summary.nil, true); assert.equal(empty.lateFee.totalPaise, 50000); assert.equal(empty.summary.cashPayableTotalPaise, 50000);
});

test("section 50 interest: 18% on cash tax for a 10-day delay, cash ledger relief, and 18% on wrongly utilised credit", () => {
  const { company, vouchers } = book();
  const working = gstr3bWorking(company, vouchers, "reg", "2026-06", { paymentDate: "2026-07-30", filingDate: "2026-07-30" });
  assert.equal(working.interest.section50_1.days, 10);
  const cash = working.table6.cashTax.total;
  assert.deepEqual(cash, working.table6.liability.total);
  for (const h of ["igst", "cgst", "sgst"]) {
    const expected = Math.round(cash[h + "Paise"] * 0.18 * 10 / 365 / 100) * 100;
    assert.equal(working.interest.section50_1.interestPaise[h + "Paise"], expected, h);
  }
  assert.deepEqual(simpleInterest({ ...heads0, cgstPaise: 10000000 }, 1800, 10), { ...heads0, cgstPaise: 49300 });
  // Credit taken against IGST reduces the cash, and the interest with it.
  const credited = gstr3bWorking(company, vouchers, "reg", "2026-06", { paymentDate: "2026-07-30", filingDate: "2026-07-30", openingCreditLedgerPaise: { igstPaise: 1000000 } });
  assert.equal(credited.table6.cashTax.total.igstPaise + credited.table6.cashTax.total.cgstPaise + credited.table6.cashTax.total.sgstPaise, 0);
  assert.equal(credited.interest.total, 0);
  // Rule 88B(1) proviso: cash credited by the due date is left out of the interest base.
  const deposited = gstr3bWorking(company, vouchers, "reg", "2026-06", { paymentDate: "2026-07-30", filingDate: "2026-07-30", cashLedgerDate: "2026-07-19", openingCashLedgerPaise: { igstPaise: cash.igstPaise } });
  assert.equal(deposited.interest.section50_1.cashLedgerRelief, true);
  assert.equal(deposited.interest.section50_1.interestPaise.igstPaise, 0);
  assert.equal(deposited.table6.cashToDeposit.igstPaise, 0);
  const lateDeposit = gstr3bWorking(company, vouchers, "reg", "2026-06", { paymentDate: "2026-07-30", filingDate: "2026-07-30", cashLedgerDate: "2026-07-25", openingCashLedgerPaise: { igstPaise: cash.igstPaise } });
  assert.equal(lateDeposit.interest.section50_1.cashLedgerRelief, false);
  assert.ok(lateDeposit.interest.section50_1.interestPaise.igstPaise > 0);
  const wrong = gstr3bWorking(company, vouchers, "reg", "2026-06", { filingDate: "2026-07-20", itcReversalPaise: { cgstPaise: 1000000 }, itcUtilisedDate: "2026-07-20", itcReversalDate: "2026-08-19" });
  assert.deepEqual(wrong.interest.section50_3.interestPaise, { ...heads0, cgstPaise: 14800 });
  assert.equal(wrong.interest.section50_3.days, 30);
  assert.equal(wrong.interest.section50_1.interestPaise.igstPaise, 0);
  assert.equal(wrong.summary.interestPaise, 14800);
});

test("Table 3.1, 3.2 by place of supply and Table 5 inward exempt, nil and non-GST totals", () => {
  const { company, vouchers } = book();
  const w = gstr3bWorking(company, vouchers, "reg", "2026-06", { filingDate: "2026-07-20" });
  assert.deepEqual(w.issues, []);
  assert.equal(w.table31.a.taxablePaise, 10000 + 20000 + 5000 + 8000 + 30000 + 40000 + 50000 + 6000);
  assert.equal(w.table31.a.igstPaise, (20000 + 5000 + 8000 + 30000 + 40000 + 50000) * 0.18);
  assert.equal(w.table31.c.taxablePaise, 1000);
  assert.deepEqual(w.table32.unregistered, [{ pos: "09", posName: "Uttar Pradesh", taxablePaise: 8000, igstPaise: 1440 }, { pos: "27", posName: "Maharashtra", taxablePaise: 25000, igstPaise: 4500 }]);
  assert.deepEqual(w.table32.uin, [{ pos: "07", posName: "Delhi", taxablePaise: 30000, igstPaise: 5400 }]);
  assert.deepEqual(w.table32.composition, [{ pos: "29", posName: "Karnataka", taxablePaise: 40000, igstPaise: 7200 }]);
  assert.deepEqual(w.table32.totals.unregistered, { taxablePaise: 33000, igstPaise: 5940 });
  assert.deepEqual(w.table5.gst, { interPaise: 1500 - 500, intraPaise: 3000 + 700 + 2500 });
  assert.deepEqual(w.table5.nonGst, { interPaise: 4000, intraPaise: 0 });
  assert.deepEqual(w.table5.totals, { interPaise: 5000, intraPaise: 6200 });
  assert.equal(w.table5.documents.length, 5);
  assert.equal(w.summary.nil, false);
  assert.equal(w.summary.cashTaxPaise, w.summary.liabilityPaise);
  assert.equal(w.summary.cashPayableTotalPaise, w.summary.cashTaxPaise);
});

test("Table 4 sources by GSTN row, opening credit ledger and Table 6 cash after utilisation", () => {
  const { company, vouchers } = book();
  const w = gstr3bWorking(company, vouchers, "reg", "2026-06", {
    itcImportGoodsPaise: { igstPaise: 50000, cessPaise: 1000 }, itcIsdPaise: { cgstPaise: 2000, sgstPaise: 2000 },
    openingCreditLedgerPaise: { cgstPaise: 100 }, filingDate: "2026-07-20" });
  assert.deepEqual(w.table4.A.total, { igstPaise: 50000, cgstPaise: 2000, sgstPaise: 2000, cessPaise: 1000 });
  assert.deepEqual(w.table4.C, { label: "Net ITC available (A) - (B)", igstPaise: 50000, cgstPaise: 2000, sgstPaise: 2000, cessPaise: 1000 });
  const liability = w.table6.liability.forwardDue;
  assert.deepEqual(w.table6.creditAvailable, { igstPaise: 50000, cgstPaise: 2100, sgstPaise: 2000, cessPaise: 1000 });
  // IGST credit 500 covers IGST 275.40, then the CGST and SGST shortfalls.
  assert.equal(w.table6.creditUtilised.igst.igstPaise, liability.igstPaise);
  assert.equal(w.table6.creditUtilised.cgst.sgstPaise, 0);
  assert.equal(w.summary.itcUtilisedPaise + w.summary.cashTaxPaise, w.summary.liabilityPaise);
  assert.equal(w.table6.creditBalanceCarried.cessPaise, 1000);
  assert.throws(() => gstr3bWorking(company, vouchers, "reg", "2026-06", { itcImportGoodsPaise: { cgstPaise: 1 } }), /no CGST component/);
  assert.throws(() => gstr3bWorking(company, vouchers, "reg", "2026-06", { paymentDate: "2026-02-30" }), /payment date/);
});

test("GSTR-3B upload JSON carries the GSTN field names and the working's figures", () => {
  const { company, vouchers } = book();
  const { json, fileName, warnings } = gstr3bJson(company, vouchers, "reg", "2026-06", { filingDate: "2026-07-30", paymentDate: "2026-07-30", aggregateTurnoverPaise: 100_00_000_00, itcIsdPaise: { igstPaise: 1000 } });
  assert.equal(fileName, "GSTR3B_23ABCDE1234F1Z8_062026.json");
  assert.deepEqual(warnings, []);
  assert.deepEqual(Object.keys(json), ["gstin", "ret_period", "sup_details", "inter_sup", "eco_dtls", "itc_elg", "inward_sup", "intr_ltfee"]);
  assert.equal(json.ret_period, "062026");
  assert.deepEqual(Object.keys(json.sup_details), ["osup_det", "osup_zero", "osup_nil_exmp", "isup_rev", "osup_nongst"]);
  assert.deepEqual(json.sup_details.osup_det, { txval: 1690, iamt: 275.4, camt: 14.4, samt: 14.4, csamt: 0 });
  assert.deepEqual(json.sup_details.osup_zero, { txval: 0, iamt: 0, csamt: 0 });
  assert.deepEqual(json.sup_details.osup_nil_exmp, { txval: 10 });
  assert.deepEqual(json.inter_sup.unreg_details, [{ pos: "09", txval: 80, iamt: 14.4 }, { pos: "27", txval: 250, iamt: 45 }]);
  assert.deepEqual(json.inter_sup.comp_details, [{ pos: "29", txval: 400, iamt: 72 }]);
  assert.deepEqual(json.inter_sup.uin_details, [{ pos: "07", txval: 300, iamt: 54 }]);
  assert.deepEqual(json.itc_elg.itc_avl.map(r => r.ty), ["IMPG", "IMPS", "ISRC", "ISD", "OTH"]);
  assert.deepEqual(json.itc_elg.itc_avl[3], { ty: "ISD", iamt: 10, camt: 0, samt: 0, csamt: 0 });
  assert.deepEqual(json.itc_elg.itc_rev.map(r => r.ty), ["RUL", "OTH"]);
  assert.deepEqual(json.itc_elg.itc_inelg.map(r => r.ty), ["RUL", "OTH"]);
  assert.deepEqual(json.itc_elg.itc_net, { iamt: 10, camt: 0, samt: 0, csamt: 0 });
  assert.deepEqual(json.inward_sup.isup_details, [{ ty: "GST", inter: 10, intra: 62 }, { ty: "NONGST", inter: 40, intra: 0 }]);
  assert.deepEqual(json.intr_ltfee.ltfee_details, { camt: 250, samt: 250 });
  assert.deepEqual(Object.keys(json.intr_ltfee.intr_details), ["iamt", "camt", "samt", "csamt"]);
  assert.ok(json.intr_ltfee.intr_details.iamt > 0);
  const negative = gstr3bExport({ ...gstr3bWorking(company, vouchers, "reg", "2026-06"), table5: { gst: { interPaise: -100, intraPaise: 0 }, nonGst: { interPaise: 0, intraPaise: 0 } } });
  assert.deepEqual(negative.warnings.map(w => w.path), ["inward_sup.isup_details[0].inter"]);
});

test("the return route serves the GSTR-3B working and downloads the upload JSON as an attachment", async () => {
  const books = book();
  async function get(path, query) {
    const response = {};
    const res = { writeHead: (code, headers) => Object.assign(response, { code, headers }), end: body => { response.body = String(body); } };
    const url = new URL("http://localhost/api/companies/synthetic-3b/gst-returns/" + path + "?" + new URLSearchParams({ registration: "reg", month: "2026-06", ...query }));
    const handled = await handleReturnRoute({ req: { method: "GET" }, res, parts: url.pathname.split("/").filter(Boolean), url, dataDir: "/synthetic", store: { snapshot: async () => books },
      readBody: async () => ({}), send: (_res, code, body) => Object.assign(response, { code, body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
    assert.equal(handled, true);
    return response;
  }
  const working = await get("3b", { paymentDate: "2026-07-30", filingDate: "2026-07-30", creditIgst: "100.50", cashCgst: "1", turnover: "10000000" });
  assert.equal(working.code, 200);
  const body = JSON.parse(working.body);
  assert.equal(body.table6.openingCreditLedger.igstPaise, 10050);
  assert.equal(body.table6.openingCashLedger.cgstPaise, 100);
  assert.equal(body.lateFee.slab, "up-to-1.5cr"); assert.equal(body.lateFee.totalPaise, 50000);
  assert.equal(body.interest.section50_1.days, 10);
  const file = await get("3b.json", { filingDate: "2026-07-20" });
  assert.equal(file.code, 200); assert.match(file.headers["content-type"], /^application\/json/);
  assert.equal(file.headers["content-disposition"], 'attachment; filename="GSTR3B_23ABCDE1234F1Z8_062026.json"');
  assert.equal(JSON.parse(file.body).gstin, registration.gstin);
  await assert.rejects(get("3b", { creditIgst: "-5" }), /amount in rupees/);
});
