import assert from "node:assert/strict";
import test from "node:test";
import { previewTally, restoreTallyArchive } from "../lib/tally-import.js";
import { exportTallyDayBook, exportTallyMasters } from "../lib/tally-export.js";
import { legacyStockOptions } from "../lib/tally-stock.js";
import { stockState } from "../lib/stock-engine.js";

// Synthetic books only: no private company data. Each source is a minimal Tally XML export.
const options = { companyName: "Synthetic coverage traders", booksFrom: "2026-04-01" };
const file = (name, text) => ({ name, base64: Buffer.from(text).toString("base64") });
const envelope = body => `<ENVELOPE><BODY><DATA><TALLYMESSAGE>${body}</TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
const archiveOf = preview => ({ format: "financer-tally-archive", version: 1, company: preview.company, vouchers: preview.vouchers, sources: preview.sources, records: preview.records, sourceBookHash: null });
const reportOf = (preview, to = "2026-04-30") => stockState(preview.company, preview.vouchers, { to });
const ledgers = `<LEDGER NAME="Cash"><PARENT>Cash-in-Hand</PARENT></LEDGER><LEDGER NAME="Sales"><PARENT>Sales Accounts</PARENT></LEDGER><LEDGER NAME="Purchases"><PARENT>Purchase Accounts</PARENT></LEDGER>`;
const unit = (name, places) => `<UNIT NAME="${name}"><NAME>${name}</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>${places}</DECIMALPLACES></UNIT>`;
const rupees = paise => `${Math.trunc(paise / 100)}.${String(Math.abs(paise) % 100).padStart(2, "0")}`;
function sale(guid, date, number, item, qty, paise, batches = "") {
  return `<VOUCHER VCHTYPE="Sales"><GUID>${guid}</GUID><DATE>${date}</DATE><VOUCHERNUMBER>${number}</VOUCHERNUMBER>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${rupees(paise)}</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${rupees(paise)}</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${item}</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><ACTUALQTY>${qty}</ACTUALQTY><BILLEDQTY>${qty}</BILLEDQTY><AMOUNT>${rupees(paise)}</AMOUNT>${batches}</ALLINVENTORYENTRIES.LIST>
</VOUCHER>`;
}
function purchase(guid, date, number, item, qty, paise, batches = "") {
  return `<VOUCHER VCHTYPE="Purchase"><GUID>${guid}</GUID><DATE>${date}</DATE><VOUCHERNUMBER>${number}</VOUCHERNUMBER>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchases</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${rupees(paise)}</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${rupees(paise)}</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${item}</STOCKITEMNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ACTUALQTY>${qty}</ACTUALQTY><BILLEDQTY>${qty}</BILLEDQTY><AMOUNT>-${rupees(paise)}</AMOUNT>${batches}</ALLINVENTORYENTRIES.LIST>
</VOUCHER>`;
}

// ---------- (1) Tally Average Cost ----------
function averageSource({ method = "Avg. Cost", closing = "<CLOSINGBALANCE>10 nos</CLOSINGBALANCE><CLOSINGVALUE>-1112.50</CLOSINGVALUE>" } = {}) {
  const masters = envelope(`${unit("nos", 0)}${ledgers}<STOCKITEM NAME="Average Widget"><NAME>Average Widget</NAME><BASEUNITS>nos</BASEUNITS><COSTINGMETHOD>${method}</COSTINGMETHOD><OPENINGBALANCE>10 nos</OPENINGBALANCE><OPENINGVALUE>-1000.00</OPENINGVALUE>${closing}</STOCKITEM>`);
  // Opening 10 @ ₹100; sell 4; buy 6 @ ₹130; sell 2. Tally's period average is
  // (1000 + 780) / 16 = ₹111.25, so its closing for 10 nos is ₹1,112.50. The perpetual
  // moving average is ₹115 after the purchase, so Ledgercraft closes at ₹1,150.
  const vouchers = envelope([
    sale("avg-sale-1", "20260401", "S-1", "Average Widget", "4 nos", 80000),
    purchase("avg-buy-1", "20260402", "P-1", "Average Widget", "6 nos", 78000),
    sale("avg-sale-2", "20260403", "S-2", "Average Widget", "2 nos", 40000),
  ].join(""));
  return [file("AverageMasters.xml", masters), file("AverageVouchers.xml", vouchers)];
}

test("Tally Avg. Cost items import as moving average with a disclosed periodic-average difference", () => {
  const preview = previewTally(averageSource(), options);
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
  assert.equal(preview.summary.stockProjection.exceptions, 0, JSON.stringify(preview.issues));
  assert.equal(preview.company.stock.tally.hasSourceGaps, false);
  const id = preview.company.stock.masters[0].id;
  assert.equal(preview.company.stock.items[id].costingMethod, "moving-average");
  const report = reportOf(preview), item = report.items[0];
  assert.equal(item.costingMethod, "moving-average");
  assert.equal(item.quantity, "10");
  assert.equal(item.valuePaise, 115000);
  assert.equal(report.totals.complete, true);
  const disclosure = preview.issues.filter(issue => issue.code === "tally-costing-mapped");
  assert.equal(disclosure.length, 1);
  assert.equal(disclosure[0].severity, "info");
  assert.equal(disclosure[0].itemId, id);
  assert.equal(disclosure[0].sourceClosingValuePaise, 111250);
  assert.equal(disclosure[0].ledgercraftClosingValuePaise, 115000);
  assert.equal(disclosure[0].differencePaise, -3750);
  assert.equal(disclosure[0].asOf, "2026-04-03");
  assert.match(disclosure[0].message, /Average Widget/);
  assert.match(disclosure[0].message, /periodic average/);
  assert.match(disclosure[0].message, /03-04-2026/);
  assert.match(disclosure[0].message, /37\.50/);
  assert.ok(!preview.company.stock.tally.sourceGaps.length, "An informational disclosure is not a source gap");
  assert.deepEqual(restoreTallyArchive(archiveOf(preview)).company.stock, preview.company.stock);
});

test("Avg. Cost round-trips through Tally XML and the full-word spelling maps the same way", () => {
  const preview = previewTally(averageSource(), options);
  const masters = exportTallyMasters(preview.company);
  assert.match(masters, /<COSTINGMETHOD>Avg\. Cost<\/COSTINGMETHOD>/);
  const daybook = exportTallyDayBook(preview.company, preview.vouchers, "2026-04-01", "2026-04-30");
  const again = previewTally([file("masters.xml", masters), file("daybook.xml", daybook)], options);
  assert.equal(again.canCommit, true, JSON.stringify(again.issues));
  assert.equal(again.company.stock.items[again.company.stock.masters[0].id].costingMethod, "moving-average");
  assert.equal(reportOf(again).items[0].valuePaise, 115000);
  const spelled = previewTally(averageSource({ method: "Average Cost" }), options);
  assert.equal(spelled.summary.stockProjection.exceptions, 0);
  assert.equal(reportOf(spelled).items[0].costingMethod, "moving-average");
});

test("the Avg. Cost disclosure explains when the source gives no closing value or a different closing quantity", () => {
  const none = previewTally(averageSource({ closing: "" }), options);
  const missing = none.issues.find(issue => issue.code === "tally-costing-mapped");
  assert.equal(missing.severity, "info");
  assert.equal(missing.differencePaise, null);
  assert.match(missing.message, /no closing quantity and value/);
  const other = previewTally(averageSource({ closing: "<CLOSINGBALANCE>9 nos</CLOSINGBALANCE><CLOSINGVALUE>-1001.25</CLOSINGVALUE>" }), options);
  const differs = other.issues.find(issue => issue.code === "tally-costing-mapped");
  assert.equal(differs.differencePaise, null);
  assert.match(differs.message, /closing quantity 9 nos differs/);
});

test("LIFO, standard, last purchase, zero and monthly costing stay review exceptions with specific reasons", () => {
  for (const [method, reason] of [
    ["LIFO Perpetual", /LIFO/], ["LIFO Annual", /LIFO/], ["Std. Cost", /standard cost/i], ["Standard Cost", /standard cost/i],
    ["Last Purchase Cost", /latest purchase rate/], ["At Zero Cost", /zero/i], ["Zero Cost", /zero/i],
    ["Monthly Avg. Cost", /each month/], ["FIFO", /annual/], ["Bespoke valuation", /not a supported cost formula/],
  ]) {
    const preview = previewTally(averageSource({ method }), options);
    assert.equal(preview.canCommit, true);
    const row = preview.summary.stockProjection && preview.issues.find(issue => issue.code === "tally-stock-source-exception");
    assert.ok(row, method);
    assert.match(row.message, reason, method);
    assert.match(row.message, new RegExp(method.replace(/[.]/g, "\\.")), method);
    assert.ok(!preview.issues.some(issue => issue.code === "tally-costing-mapped"));
    assert.equal(reportOf(preview).totals.complete, false);
    assert.deepEqual(restoreTallyArchive(archiveOf(preview)).company.stock, preview.company.stock);
  }
});

test("archives saved before Avg. Cost mapping keep their recorded costing exception on restore", () => {
  const legacy = previewTally(averageSource(), { ...options, legacyStockAverageCost: true });
  const gap = legacy.company.stock.tally.sourceGaps.find(row => row.message.includes("differs from Ledgercraft perpetual FIFO and is not activated"));
  assert.ok(gap, JSON.stringify(legacy.company.stock.tally.sourceGaps));
  assert.equal(legacyStockOptions(legacy.company.stock.tally).legacyAverageCost, true);
  assert.equal(legacy.company.stock.masters.length, 0);
  assert.deepEqual(restoreTallyArchive(archiveOf(legacy)).company.stock, legacy.company.stock);
  const modern = previewTally(averageSource(), options);
  assert.equal(legacyStockOptions(modern.company.stock.tally).legacyAverageCost, false);
});

// ---------- (2) Named batches ----------
const batch = (godown, name, quantity, amount, { opening = false, made = "", expiry = "" } = {}) =>
  `<BATCHALLOCATIONS.LIST><GODOWNNAME>${godown}</GODOWNNAME><BATCHNAME>${name}</BATCHNAME>${made ? `<MFDON>${made}</MFDON>` : ""}${expiry ? `<EXPIRYPERIOD P="${expiry}">${expiry}</EXPIRYPERIOD>` : ""}` +
  (opening ? `<OPENINGBALANCE>${quantity}</OPENINGBALANCE><OPENINGVALUE>${amount}</OPENINGVALUE>` : `<ACTUALQTY>${quantity}</ACTUALQTY><BILLEDQTY>${quantity}</BILLEDQTY><AMOUNT>${amount}</AMOUNT>`) +
  "</BATCHALLOCATIONS.LIST>";
function batchSource({ saleBatch = "B2", saleQuantity = "3 nos", salePaise = 60000 } = {}) {
  const masters = envelope(`${unit("nos", 0)}<GODOWN NAME="Cold Room"><NAME>Cold Room</NAME><PARENT>Primary</PARENT></GODOWN>${ledgers}
<STOCKITEM NAME="Batch Syrup"><NAME>Batch Syrup</NAME><BASEUNITS>nos</BASEUNITS><ISBATCHWISEON>Yes</ISBATCHWISEON><ISPERISHABLEON>Yes</ISPERISHABLEON><COSTINGMETHOD>FIFO Perpetual</COSTINGMETHOD><OPENINGBALANCE>10 nos</OPENINGBALANCE><OPENINGVALUE>-1120.00</OPENINGVALUE>
${batch("Main Location", "B1", "4 nos", "-400.00", { opening: true, made: "20260101", expiry: "31-Dec-2026" })}
${batch("Main Location", "B2", "6 nos", "-720.00", { opening: true, made: "20260201", expiry: "28-Feb-2027" })}
</STOCKITEM>`);
  const vouchers = envelope([
    purchase("batch-buy", "20260402", "P-1", "Batch Syrup", "5 nos", 65000, batch("Main Location", "B3", "5 nos", "-650.00", { made: "20260401", expiry: "30-Jun-2027" })),
    sale("batch-sale-named", "20260403", "S-1", "Batch Syrup", saleQuantity, salePaise, batch("Main Location", saleBatch, saleQuantity, rupees(salePaise))),
    sale("batch-sale-any", "20260404", "S-2", "Batch Syrup", "5 nos", 100000, batch("Main Location", "Primary Batch", "5 nos", "1000.00")),
    `<VOUCHER VCHTYPE="Stock Journal"><GUID>batch-transfer</GUID><DATE>20260405</DATE><VOUCHERNUMBER>T-1</VOUCHERNUMBER>
<INVENTORYENTRIESOUT.LIST><STOCKITEMNAME>Batch Syrup</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><ACTUALQTY>2 nos</ACTUALQTY>${batch("Main Location", "B3", "2 nos", "")}</INVENTORYENTRIESOUT.LIST>
<INVENTORYENTRIESIN.LIST><STOCKITEMNAME>Batch Syrup</STOCKITEMNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ACTUALQTY>2 nos</ACTUALQTY>${batch("Cold Room", "B3", "2 nos", "")}</INVENTORYENTRIESIN.LIST>
</VOUCHER>`,
  ].join("").replaceAll("<AMOUNT></AMOUNT>", ""));
  return [file("BatchMasters.xml", masters), file("BatchVouchers.xml", vouchers)];
}

test("named Tally batches import as lots with expiry and manufacturing dates and batch-specific FIFO", () => {
  const preview = previewTally(batchSource(), options);
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
  assert.equal(preview.summary.stockProjection.exceptions, 0, JSON.stringify(preview.issues.filter(issue => issue.code === "tally-stock-source-exception")));
  const settings = preview.company.stock.items[preview.company.stock.masters[0].id];
  assert.deepEqual(settings.openingAllocations, [
    { godownId: "main", quantity: "4", valuePaise: 40000, batch: "B1", manufacturedDate: "2026-01-01", expiryDate: "2026-12-31" },
    { godownId: "main", quantity: "6", valuePaise: 72000, batch: "B2", manufacturedDate: "2026-02-01", expiryDate: "2027-02-28" },
  ]);
  const receipt = preview.company.stock.journals.find(row => row.number === "P-1");
  assert.equal(receipt.lines[0].batch, "B3");
  assert.equal(receipt.lines[0].expiryDate, "2027-06-30");
  const transfer = preview.company.stock.journals.find(row => row.number === "T-1");
  assert.deepEqual(transfer.lines.map(line => [line.batch, line.fromGodownId, line.quantity]), [["B3", "main", "2"]]);
  // S-1 names B2: three units at ₹120 come from B2 although B1 is older.
  // S-2 names no batch: FIFO by date takes B1's four units at ₹100, then one B2 unit at ₹120.
  const report = reportOf(preview), item = report.items[0];
  assert.equal(report.totals.complete, true, JSON.stringify(report.issues));
  const sold = item.movements.filter(row => row.financialKind === "sale").map(row => [row.number, row.valuePaise, row.batch ?? null]);
  assert.deepEqual(sold, [["S-1", -36000, "B2"], ["S-2", -52000, null]]);
  assert.equal(item.quantity, "7");
  assert.equal(item.valuePaise, 89000);
  assert.deepEqual(item.batches, [
    { name: "B2", quantity: "2", valuePaise: 24000, knownValuePaise: 24000, expiry: "2027-02-28", manufactured: "2026-02-01" },
    { name: "B3", quantity: "5", valuePaise: 65000, knownValuePaise: 65000, expiry: "2027-06-30", manufactured: "2026-04-01" },
  ]);
  assert.deepEqual(item.godowns.filter(row => row.quantity !== "0").map(row => [row.name, row.quantity]), [["Main Location", "5"], ["Cold Room", "2"]]);
  assert.deepEqual(item.lots.filter(lot => lot.godownId !== "main").map(lot => [lot.batch, lot.quantity, lot.valuePaise]), [["B3", "2", 26000]]);
  assert.deepEqual(restoreTallyArchive(archiveOf(preview)).company.stock, preview.company.stock);
});

test("a sale naming a batch cannot consume another batch, and batches round-trip through Tally XML", () => {
  const short = previewTally(batchSource({ saleBatch: "B1", saleQuantity: "6 nos", salePaise: 120000 }), options);
  assert.equal(short.summary.stockProjection.exceptions, 0);
  const item = reportOf(short, "2026-04-03").items[0];
  assert.ok(item.issues.some(issue => issue.code === "negative-stock"), "Batch B1 holds only four units");
  assert.deepEqual(item.batches.map(row => [row.name, row.quantity]), [["B1", "-2"], ["B2", "6"], ["B3", "5"]]);

  const preview = previewTally(batchSource(), options);
  const masters = exportTallyMasters(preview.company);
  assert.match(masters, /<ISBATCHWISEON>Yes<\/ISBATCHWISEON>/);
  assert.match(masters, /<BATCHNAME>B1<\/BATCHNAME><MFDON>20260101<\/MFDON><EXPIRYPERIOD>20261231<\/EXPIRYPERIOD>/);
  const daybook = exportTallyDayBook(preview.company, preview.vouchers, "2026-04-01", "2026-04-30");
  assert.match(daybook, /<BATCHNAME>B3<\/BATCHNAME>/);
  const again = previewTally([file("masters.xml", masters), file("daybook.xml", daybook)], options);
  assert.equal(again.canCommit, true, JSON.stringify(again.issues));
  assert.equal(again.summary.stockProjection.exceptions, 0, JSON.stringify(again.issues.filter(issue => issue.code === "tally-stock-source-exception")));
  assert.deepEqual(reportOf(again).items[0].batches, reportOf(preview).items[0].batches);
});

test("batch relabelling in a stock journal and archives saved before batch import stay explicit", () => {
  const relabel = batchSource().map(entry => entry.name === "BatchVouchers.xml"
    ? file(entry.name, Buffer.from(entry.base64, "base64").toString("utf8").replace("<GODOWNNAME>Cold Room</GODOWNNAME><BATCHNAME>B3", "<GODOWNNAME>Cold Room</GODOWNNAME><BATCHNAME>B9"))
    : entry);
  const changed = previewTally(relabel, options);
  assert.ok(changed.issues.some(issue => issue.code === "tally-stock-source-exception" && /batch/i.test(issue.message) && /T-1/.test(issue.message)));
  const legacy = previewTally(batchSource(), { ...options, legacyStockBatches: true });
  assert.ok(legacy.company.stock.tally.sourceGaps.some(gap => /ISBATCHWISEON inventory policy is not supported/.test(gap.message)));
  assert.equal(legacyStockOptions(legacy.company.stock.tally).legacyBatches, true);
  assert.deepEqual(restoreTallyArchive(archiveOf(legacy)).company.stock, legacy.company.stock);
});

// ---------- (3) Alternate units ----------
function bagSource({ basePlaces = 3, saleQuantity = "37.5 kg = 1 bag", purchaseQuantity = "3 bag", purchasePaise = 562500 } = {}) {
  // 2 bag = 75 kg: one bag is 37.5 kg, a ratio that is not a whole number.
  const masters = envelope(`${unit("kg", basePlaces)}${unit("bag", 0)}${ledgers}
<STOCKITEM NAME="Rice"><NAME>Rice</NAME><BASEUNITS>kg</BASEUNITS><ADDITIONALUNITS>bag</ADDITIONALUNITS><DENOMINATOR> 2</DENOMINATOR><CONVERSION> 75</CONVERSION><COSTINGMETHOD>FIFO Perpetual</COSTINGMETHOD><OPENINGBALANCE>100 kg</OPENINGBALANCE><OPENINGVALUE>-5000.00</OPENINGVALUE></STOCKITEM>`);
  const vouchers = envelope([
    purchase("bag-buy", "20260402", "P-1", "Rice", purchaseQuantity, purchasePaise),
    sale("bag-sale", "20260403", "S-1", "Rice", saleQuantity, 250000),
  ].join(""));
  return [file("BagMasters.xml", masters), file("BagVouchers.xml", vouchers)];
}

test("alternate-unit quantities convert exactly into the base unit with a non-integer ratio", () => {
  const preview = previewTally(bagSource(), options);
  assert.equal(preview.canCommit, true, JSON.stringify(preview.issues));
  assert.equal(preview.summary.stockProjection.exceptions, 0, JSON.stringify(preview.issues.filter(issue => issue.code === "tally-stock-source-exception")));
  const master = preview.company.stock.masters[0];
  assert.deepEqual(master.alternateUnits, [{ name: "bag", factorNumerator: 75, factorDenominator: 2 }]);
  const buy = preview.company.stock.journals.find(row => row.number === "P-1").lines[0];
  assert.equal(buy.quantity, "112.5");
  assert.equal(buy.billedQuantity, "112.5");
  assert.equal(buy.sourceQuantity, "3 bag");
  assert.equal(preview.company.stock.journals.find(row => row.number === "S-1").lines[0].quantity, "37.5");
  const item = reportOf(preview).items[0];
  assert.equal(item.quantity, "175");
  assert.deepEqual(item.alternateUnits, [{ name: "bag", factorNumerator: 75, factorDenominator: 2 }]);
  // 100 kg @ ₹50 opening, 112.5 kg @ ₹50 bought; FIFO sells 37.5 kg of the opening at ₹1,875.
  assert.equal(item.valuePaise, 875000);
  assert.deepEqual(restoreTallyArchive(archiveOf(preview)).company.stock, preview.company.stock);
  const masters = exportTallyMasters(preview.company);
  assert.match(masters, /<ADDITIONALUNITS>bag<\/ADDITIONALUNITS><DENOMINATOR>2<\/DENOMINATOR><CONVERSION>75<\/CONVERSION>/);
  assert.match(masters, /<UNIT NAME="bag"/);
  const again = previewTally([file("masters.xml", masters), file("daybook.xml", exportTallyDayBook(preview.company, preview.vouchers, "2026-04-01", "2026-04-30"))], options);
  assert.equal(again.canCommit, true, JSON.stringify(again.issues));
  assert.equal(reportOf(again).items[0].valuePaise, 875000);
});

test("an unknown unit or an inexact alternate conversion stays a review exception", () => {
  const unknown = previewTally(bagSource({ saleQuantity: "2 crate" }), options);
  const exception = unknown.issues.find(issue => issue.code === "tally-stock-source-exception");
  assert.ok(exception);
  assert.match(exception.message, /2 crate/);
  assert.match(exception.message, /neither the base unit kg nor the declared alternate unit bag/);
  assert.equal(unknown.company.stock.tally.hasSourceGaps, true);
  assert.equal(reportOf(unknown).totals.complete, false);
  const inexact = previewTally(bagSource({ basePlaces: 0, saleQuantity: "75 kg" }), options);
  const rounding = inexact.issues.find(issue => issue.code === "tally-stock-source-exception");
  assert.ok(rounding);
  assert.match(rounding.message, /112\.5 kg/);
  assert.match(rounding.message, /0 decimal places/);
  const legacy = previewTally(bagSource(), { ...options, legacyStockAlternateUnits: true });
  assert.ok(legacy.company.stock.tally.sourceGaps.some(gap => gap.message.includes("Alternate or compound stock units require conversion review")));
  assert.equal(legacyStockOptions(legacy.company.stock.tally).legacyAlternateUnits, true);
  assert.deepEqual(restoreTallyArchive(archiveOf(legacy)).company.stock, legacy.company.stock);
});
