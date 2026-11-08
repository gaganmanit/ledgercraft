#!/usr/bin/env node
// Builds a lived-in demonstration company ("Saraswati Traders", an electrical and solar
// goods trader in Indore) so every screen can be reviewed with data and README
// screenshots show a real-looking book.
//
// Usage:
//   node tools/seed-demo.mjs --home <LEDGERCRAFT_HOME dir> [--name "Saraswati Traders"] [--force]
//
// Everything goes through the HTTP API of a server this script starts itself, so the same
// validation runs as when a person keys the entries in. Nothing is written to disk directly.
// The script refuses to run when a company with the same name already exists in that home,
// unless --force is given, in which case a second company with the same name is added beside
// the first one (nothing is deleted or overwritten).
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { start } from "../server.js";
import { gstinCheckDigit } from "../lib/gst.js";

export const DEFAULT_NAME = "Saraswati Traders";
const BOOKS_FROM = "2026-04-01";
const RETURN_MONTH = "2026-10";

const rupees = value => Math.round(value * 100);
const gstin = stem => stem + gstinCheckDigit(stem);
const sameName = (a, b) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();
const signed = balance => balance.dc === "Dr" ? balance.paise : -balance.paise;
const inr = paise => {
  const sign = paise < 0 ? "-" : "";
  const [whole, fraction] = (Math.abs(paise) / 100).toFixed(2).split(".");
  const last = whole.slice(-3), rest = whole.slice(0, -3);
  return `${sign}₹${rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," : ""}${last}.${fraction}`;
};

function client(port, token) {
  // The URL host makes fetch send "Host: 127.0.0.1:<port>", the only host the server accepts,
  // and the bearer token is the one this script handed to the server it started.
  const base = `http://127.0.0.1:${port}`;
  return async function api(method, route, body) {
    const response = await fetch(base + route, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!response.ok) {
      const error = new Error(`${method} ${route} failed with ${response.status}: ${json.error || text}`);
      error.status = response.status;
      throw error;
    }
    return json;
  };
}

/**
 * Seeds the demonstration company through a server started on a free loopback port.
 * Returns { companyId, name, summary, checks, skipped }.
 */
export async function seedDemo({ home, name = DEFAULT_NAME, force = false, log = () => {} } = {}) {
  if (!home) throw new Error("Choose the Ledgercraft home folder with --home");
  // A private session token keeps other local programs out while the seed runs.
  const token = randomBytes(24).toString("hex");
  const server = await start({ port: 0, home: path.resolve(home), token });
  try {
    return await seed(client(server.address().port, token), { name, force, log });
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

async function seed(api, { name, force, log }) {
  const skipped = [];
  const requestId = label => `seed-${label}-${randomUUID()}`.slice(0, 80);

  const { companies } = await api("GET", "/api/companies");
  const existing = companies.filter(company => sameName(company.name, name));
  if (existing.length && !force) {
    const error = new Error(`A company named "${existing[0].name}" already exists in this home (${existing.map(c => c.id).join(", ")}). Use --force to add another one beside it.`);
    error.code = "EXISTS";
    throw error;
  }

  // ---- Company and chart of accounts -------------------------------------------------
  const { company } = await api("POST", "/api/companies", { name, booksFrom: BOOKS_FROM });
  const id = encodeURIComponent(company.id);
  const at = route => `/api/companies/${id}${route}`;
  log(`Created ${company.name} (${company.id}), books from ${BOOKS_FROM}`);

  const ledgers = { cash: "l-cash" };
  async function ledger(key, ledgerName, groupId, openingPaise = 0, openingDc = "Dr") {
    const book = await api("POST", at("/ledgers"), { name: ledgerName, groupId, openingPaise, openingDc });
    ledgers[key] = book.company.ledgers.find(row => row.name === ledgerName).id;
  }
  // Opening stock at cost, split across the shop and the warehouse (see stockOpening below).
  const stockOpening = {
    fan: { quantity: "40", allocations: [["main", "25", rupees(45000)], ["warehouse", "15", rupees(27000)]] },
    wire: { quantity: "50", allocations: [["main", "30", rupees(37500)], ["warehouse", "20", rupees(25000)]] },
    module: { quantity: "12", allocations: [["warehouse", "12", rupees(144000)]] },
    heater: { quantity: "5", allocations: [["main", "2", rupees(36000)], ["warehouse", "3", rupees(54000)]] },
  };
  const openingStockPaise = Object.values(stockOpening).flatMap(row => row.allocations).reduce((sum, row) => sum + row[2], 0);
  const openings = { cash: rupees(48500), sbi: rupees(750000), hdfc: rupees(375000) };
  const capitalPaise = openings.cash + openings.sbi + openings.hdfc + openingStockPaise;

  // The default Cash ledger exists already; give it the cash counted on 1 April.
  const cashLedger = company.ledgers.find(row => row.id === "l-cash");
  await api("PUT", at("/ledgers/l-cash"), { name: cashLedger.name, groupId: cashLedger.groupId, openingPaise: openings.cash, openingDc: "Dr", expected: cashLedger });
  await ledger("sbi", "State Bank of India - Current A/c 3021", "g-bank", openings.sbi);
  await ledger("hdfc", "HDFC Bank - Current A/c 5517", "g-bank", openings.hdfc);
  await ledger("capital", "Capital - Ramesh Agrawal", "g-capital", capitalPaise, "Cr");
  await ledger("stock", "Opening Stock", "g-stock", openingStockPaise);
  await ledger("rent", "Shop Rent", "g-indirect-exp");
  await ledger("salaries", "Staff Salaries", "g-indirect-exp");
  await ledger("electricity", "Electricity Charges", "g-indirect-exp");
  await ledger("bankCharges", "Bank Charges", "g-indirect-exp");
  await ledger("discom", "MP Paschim Kshetra Vidyut Vitaran Co.", "g-creditors");

  // ---- GST registration, parties and items --------------------------------------------
  // Saving the registration creates the GST sales, purchase, input and output ledgers and
  // the reverse-charge control ledgers the GST module posts to.
  const registration = (await api("PUT", at("/gst/settings"), {
    name, legalName: "Ramesh Agrawal", gstin: gstin("23AKUPA4821M1Z"), stateCode: "23",
    address: "14, Siyaganj Main Road, Indore, Madhya Pradesh", pincode: "452007",
    phone: "0731 254 3180", email: "accounts@saraswatitraders.in", invoicePrefix: "ST",
  })).registration;
  const regAccounts = registration.accounts;
  log(`GST registration ${registration.gstin} (prefix ${registration.invoicePrefix})`);

  const parties = {};
  async function party(key, input) {
    parties[key] = (await api("POST", at("/gst/parties"), input)).party;
  }
  await party("mahakal", { name: "Shree Mahakal Electricals", legalName: "Shree Mahakal Electricals", kind: "customer", gstin: gstin("23AAMFS7314Q1Z"), stateCode: "23", address: "22, Freeganj, Ujjain, Madhya Pradesh", pincode: "456010", phone: "0734 251 7720" });
  await party("patil", { name: "Patil Power Solutions", legalName: "Patil Power Solutions LLP", kind: "customer", gstin: gstin("27AAJFP6610M1Z"), stateCode: "27", address: "Plot 41, Bhosari MIDC, Pune, Maharashtra", pincode: "411026", phone: "020 2712 4455" });
  await party("verma", { name: "Dr. Anjali Verma", legalName: "Dr. Anjali Verma", kind: "customer", gstin: "", stateCode: "23", address: "B-118, Scheme No. 54, Vijay Nagar, Indore, Madhya Pradesh", pincode: "452010", phone: "98260 41190" });
  await party("malwa", { name: "Malwa Roadways", legalName: "Malwa Roadways (Goods Transport Agency)", kind: "supplier", gstin: "", stateCode: "23", address: "Shop 7, Transport Nagar, Indore, Madhya Pradesh", pincode: "452014", phone: "98930 22417" });
  await party("bharat", { name: "Bharat Electricals Distributors", legalName: "Bharat Electricals Distributors", kind: "supplier", gstin: gstin("23AADFB2291H1Z"), stateCode: "23", address: "8, Ibrahimpura Market, Bhopal, Madhya Pradesh", pincode: "462001", phone: "0755 274 6631" });
  await party("surya", { name: "Surya Solar Industries", legalName: "Surya Solar Industries Private Limited", kind: "supplier", gstin: gstin("24AAQCS5108N1Z"), stateCode: "24", address: "Plot 112, Phase II, GIDC Vatva, Ahmedabad, Gujarat", pincode: "382445", phone: "079 2583 0912" });
  log(`Parties: ${Object.values(parties).map(p => p.name).join(", ")}`);

  const items = {};
  async function item(key, input) {
    items[key] = (await api("POST", at("/gst/items"), { cessRateBps: 0, supplyStatus: "taxable", ...input })).item;
  }
  await item("fan", { name: "Ceiling fan 1200 mm", kind: "goods", hsnSac: "841451", unit: "NOS", gstRateBps: 1800, pricePaise: rupees(2450), purchasePricePaise: rupees(1850), openingQuantity: stockOpening.fan.quantity });
  await item("wire", { name: "Copper wire 1.5 sq mm, 90 m coil", kind: "goods", hsnSac: "854449", unit: "ROL", gstRateBps: 1800, pricePaise: rupees(1650), purchasePricePaise: rupees(1280), openingQuantity: stockOpening.wire.quantity });
  await item("module", { name: "Solar PV module 540 Wp", kind: "goods", hsnSac: "854143", unit: "NOS", gstRateBps: 500, pricePaise: rupees(14900), purchasePricePaise: rupees(12200), openingQuantity: stockOpening.module.quantity });
  await item("heater", { name: "Solar water heater 200 LPD", kind: "goods", hsnSac: "841912", unit: "NOS", gstRateBps: 1200, pricePaise: rupees(22000), purchasePricePaise: rupees(18500), openingQuantity: stockOpening.heater.quantity });
  await item("install", { name: "Electrical installation service", kind: "service", hsnSac: "995461", unit: "OTH", gstRateBps: 1800, pricePaise: rupees(3500), purchasePricePaise: 0 });
  await item("freight", { name: "Goods transport by road (GTA)", kind: "service", hsnSac: "996791", unit: "OTH", gstRateBps: 500, pricePaise: 0, purchasePricePaise: rupees(18000) });
  log(`Items: ${Object.values(items).map(i => `${i.name} (${i.hsnSac}, ${i.gstRateBps / 100}%)`).join("; ")}`);

  // ---- Stock: a second godown and opening quantities and values -----------------------
  let stockRevision = (await api("GET", at(`/stock?to=${BOOKS_FROM}`))).revision;
  async function stockChange(method, route, body) {
    const saved = await api(method, at(`/stock${route}`), { ...body, revision: stockRevision, requestId: requestId("stock") });
    stockRevision = saved.revision;
    return saved.result;
  }
  const godowns = { main: "main" };
  godowns.warehouse = (await stockChange("POST", "/godowns", { name: "Sanwer Road Warehouse" })).id;
  for (const [key, opening] of Object.entries(stockOpening)) {
    await stockChange("PUT", `/items/${encodeURIComponent(items[key].id)}`, {
      costingMethod: "fifo",
      openingValuePaise: opening.allocations.reduce((sum, row) => sum + row[2], 0),
      openingAllocations: opening.allocations.map(([godown, quantity, valuePaise]) => ({ godownId: godowns[godown], quantity, valuePaise })),
    });
  }
  log(`Stock opening ${inr(openingStockPaise)} across Main Location and Sanwer Road Warehouse`);
  try {
    await stockChange("PUT", "/settings", { integrateAccounts: true });
    log("Inventory is integrated with the accounts (closing stock flows into the statements)");
  } catch (error) {
    skipped.push(`Inventory integration with the accounts was not switched on: ${error.message}`);
  }

  // ---- GST invoices ---------------------------------------------------------------------
  const invoices = {};
  async function invoice(key, input) {
    const lines = input.items.map(([itemKey, quantity, price, godown]) => ({
      itemId: items[itemKey].id, quantity, unitPricePaise: rupees(price), ...(godown ? { godownId: godowns[godown] } : {}),
    }));
    const party = parties[input.party];
    const body = { pricing: "exclusive", placeOfSupply: party.stateCode, ...input, party: undefined, items: lines, registrationId: registration.id, partyId: party.id, requestId: requestId("gst") };
    delete body.party;
    const saved = await api("POST", at("/gst/invoices"), body);
    invoices[key] = saved.voucher;
    return saved.voucher;
  }
  // Purchases first within each date so stock never goes below zero.
  await invoice("p1", { type: "Purchase", party: "bharat", date: "2026-04-06", supplierInvoiceNumber: "BED/26-27/0142", itcEligibility: "eligible", narration: "Fans and wire for summer season", items: [["fan", "60", 1850], ["wire", "50", 1280]] });
  await invoice("s1", { type: "Sales", party: "mahakal", date: "2026-04-14", narration: "Order MAH/APR/07", items: [["fan", "20", 2450], ["wire", "10", 1650]] });
  await invoice("p2", { type: "Purchase", party: "surya", date: "2026-05-02", supplierInvoiceNumber: "SSI/2627/0388", itcEligibility: "pending", narration: "Solar stock, received at warehouse", items: [["module", "80", 12200, "warehouse"], ["heater", "6", 18500, "warehouse"]] });
  await invoice("s2", { type: "Sales", party: "patil", date: "2026-05-09", narration: "PO PPS/0412, dispatched from warehouse", shippingAddress: "Site: Chakan Industrial Area, Pune 410501", items: [["module", "40", 14900, "warehouse"]] });
  await invoice("s3", { type: "Sales", party: "verma", date: "2026-06-03", narration: "Rooftop heater with installation", items: [["heater", "1", 22000], ["install", "1", 3500]] });
  await invoice("s4", { type: "Sales", party: "mahakal", date: "2026-07-11", narration: "Order MAH/JUL/03", items: [["fan", "15", 2450], ["wire", "20", 1650]] });
  await invoice("cn1", { type: "Credit Note", direction: "sales", party: "mahakal", date: "2026-07-25", originalInvoiceId: invoices.s4.id, stockEffect: "quantity", narration: "3 fans returned, regulator fault", items: [["fan", "3", 2450]] });
  await invoice("s5", { type: "Sales", party: "patil", date: "2026-08-18", narration: "PO PPS/0587", items: [["heater", "3", 21500, "warehouse"], ["module", "10", 14900, "warehouse"]] });
  await invoice("s10", { type: "Sales", party: "mahakal", date: "2026-08-28", narration: "Rooftop solar kit for Ujjain school, with installation", shippingAddress: "Saraswati Shishu Mandir, Nanakheda, Ujjain 456010", items: [["module", "10", 14900, "warehouse"], ["heater", "4", 22000, "warehouse"], ["install", "6", 3500]] });
  await invoice("p3", { type: "Purchase", party: "bharat", date: "2026-09-15", supplierInvoiceNumber: "BED/26-27/0517", itcEligibility: "eligible", narration: "Festive season restock", items: [["wire", "40", 1280], ["fan", "30", 1850]] });
  await invoice("s7", { type: "Sales", party: "mahakal", date: "2026-10-07", narration: "Order MAH/OCT/02 with site wiring", items: [["wire", "25", 1650], ["fan", "10", 2450], ["install", "4", 3500]] });
  await invoice("s6", { type: "Sales", party: "verma", date: "2026-10-16", narration: "Clinic fans with fitting", items: [["fan", "4", 2450], ["install", "2", 3500]] });
  await invoice("p4", { type: "Purchase", party: "malwa", date: "2026-10-09", supplierInvoiceNumber: "LR-2381", reverseCharge: true, narration: "Freight Ahmedabad to Indore, LR-2381", items: [["freight", "1", 18000]], rcm: {
    applicabilityConfirmed: true, basisReference: "Section 9(3), Notification 13/2017-CT(Rate) Sl. 1: GTA road transport",
    receiptDate: "2026-10-09", supplierInvoiceDate: "2026-10-09", selfInvoiceDate: "2026-10-09" } });
  await invoice("s8", { type: "Sales", party: "patil", date: "2026-10-22", narration: "PO PPS/0644", items: [["module", "30", 14900, "warehouse"]] });
  await invoice("s9", { type: "Sales", party: "mahakal", date: "2026-11-04", narration: "Order MAH/NOV/01", items: [["fan", "12", 2450]] });
  const gstDocs = Object.values(invoices);
  log(`GST documents: ${gstDocs.filter(v => v.type === "Sales").length} sales, ${gstDocs.filter(v => v.type === "Purchase").length} purchases, ${gstDocs.filter(v => v.type === "Credit Note").length} credit note`);

  // ---- Ordinary vouchers -----------------------------------------------------------------
  const vouchers = {};
  const counters = {};
  const prefix = { Payment: "PMT", Receipt: "RCT", Contra: "CTR", Journal: "JRN" };
  // Entries are planned first and posted in date order, so voucher numbers run with the calendar.
  const plan = [];
  const voucher = (key, type, date, narration, lines) => plan.push({ key, type, date, narration, lines });
  const total = key => invoices[key].gst.totals.totalPaise / 100;
  const receivable = key => parties[key].customerLedgerId;
  const payable = key => parties[key].supplierLedgerId;
  const months = ["04", "05", "06", "07", "08", "09", "10", "11"];
  const monthName = m => new Date(`2026-${m}-01T00:00:00Z`).toLocaleString("en-IN", { month: "long", timeZone: "UTC" });
  const lastDay = m => new Date(Date.UTC(2026, Number(m), 0)).toISOString().slice(0, 10);
  for (const m of months) voucher(`rent-${m}`, "Payment", `2026-${m}-05`, `Shop rent for ${monthName(m)} 2026, Siyaganj`, [[ledgers.rent, "Dr", 18000], [ledgers.sbi, "Cr", 18000]]);
  for (const m of months.slice(0, -1)) voucher(`salary-${m}`, "Payment", lastDay(m), `Salaries for ${monthName(m)} 2026, two staff`, [[ledgers.salaries, "Dr", 24000], [ledgers.hdfc, "Cr", 24000]]);
  voucher("r-mahakal-1", "Receipt", "2026-05-20", "Part payment against April invoice, NEFT", [[ledgers.sbi, "Dr", 50000], [receivable("mahakal"), "Cr", 50000]]);
  voucher("p-bharat-1", "Payment", "2026-05-25", "Bharat Electricals bill BED/26-27/0142, RTGS", [[payable("bharat"), "Dr", total("p1")], [ledgers.sbi, "Cr", total("p1")]]);
  voucher("r-verma-1", "Receipt", "2026-06-03", "Cash received on installation", [[ledgers.cash, "Dr", total("s3")], [receivable("verma"), "Cr", total("s3")]]);
  voucher("contra-1", "Contra", "2026-06-10", "Cash deposited into SBI", [[ledgers.sbi, "Dr", 25000], [ledgers.cash, "Cr", 25000]]);
  voucher("r-patil-1", "Receipt", "2026-06-12", "Patil Power Solutions, PO PPS/0412, RTGS", [[ledgers.hdfc, "Dr", total("s2")], [receivable("patil"), "Cr", total("s2")]]);
  voucher("p-surya-1", "Payment", "2026-06-15", "Surya Solar part payment, SSI/2627/0388", [[payable("surya"), "Dr", 600000], [ledgers.hdfc, "Cr", 600000]]);
  voucher("r-mahakal-2", "Receipt", "2026-08-05", "Mahakal July invoice net of returned fans, NEFT", [[ledgers.sbi, "Dr", total("s4") - total("cn1")], [receivable("mahakal"), "Cr", total("s4") - total("cn1")]]);
  voucher("r-patil-2", "Receipt", "2026-09-10", "Patil Power Solutions, PO PPS/0587, RTGS", [[ledgers.hdfc, "Dr", total("s5")], [receivable("patil"), "Cr", total("s5")]]);
  voucher("r-mahakal-4", "Receipt", "2026-09-18", "Mahakal school solar kit, RTGS", [[ledgers.sbi, "Dr", total("s10")], [receivable("mahakal"), "Cr", total("s10")]]);
  voucher("p-surya-2", "Payment", "2026-09-20", "Surya Solar balance, SSI/2627/0388, RTGS from SBI", [[payable("surya"), "Dr", total("p2") - 600000], [ledgers.sbi, "Cr", total("p2") - 600000]]);
  voucher("j-electricity", "Journal", "2026-09-30", "MPPKVVCL bill for September, IVRS 1234567890", [[ledgers.electricity, "Dr", 8640], [ledgers.discom, "Cr", 8640]]);
  voucher("p-electricity", "Payment", "2026-10-10", "MPPKVVCL bill paid through BBPS", [[ledgers.discom, "Dr", 8640], [ledgers.sbi, "Cr", 8640]]);
  voucher("r-verma-2", "Receipt", "2026-10-16", "Cash received for clinic fans", [[ledgers.cash, "Dr", total("s6")], [receivable("verma"), "Cr", total("s6")]]);
  voucher("r-mahakal-3", "Receipt", "2026-10-28", "Mahakal October invoice, NEFT", [[ledgers.sbi, "Dr", total("s7")], [receivable("mahakal"), "Cr", total("s7")]]);
  voucher("bank-charges", "Payment", "2026-10-31", "SBI SMS and account charges for the quarter", [[ledgers.bankCharges, "Dr", 236], [ledgers.sbi, "Cr", 236]]);
  for (const entry of plan.sort((a, b) => a.date.localeCompare(b.date))) {
    counters[entry.type] = (counters[entry.type] || 0) + 1;
    const saved = await api("POST", at("/vouchers"), {
      type: entry.type, date: entry.date, number: `${prefix[entry.type]}-${counters[entry.type]}`, narration: entry.narration, requestId: requestId("voucher"),
      lines: entry.lines.map(([ledgerId, dc, amount]) => ({ ledgerId, dc, paise: rupees(amount) })),
    });
    vouchers[entry.key] = saved.voucher;
  }
  log(`Ordinary vouchers: ${Object.keys(vouchers).length} (receipts, payments, a contra and a journal)`);

  // ---- Reverse charge: supplier payment, cash deposit, tax discharge and credit ----------
  const rcm = {};
  async function rcmAction(key, action, date, reference, fields) {
    rcm[key] = (await api("POST", at(`/gst/rcm/${action}`), { invoiceId: invoices.p4.id, date, reference, requestId: requestId("rcm"), ...fields })).voucher;
  }
  const rcmTax = { cgstPaise: invoices.p4.gst.totals.cgstPaise, sgstPaise: invoices.p4.gst.totals.sgstPaise };
  await rcmAction("supplier", "supplier-payment", "2026-10-12", "HDFC NEFT N285261012345", { bankLedgerId: ledgers.hdfc, amountPaise: invoices.p4.gst.partyDuePaise, allocationMethod: "pro-rata", bankDebitDate: "2026-10-12" });
  await rcmAction("deposit", "cash-deposit", "2026-10-20", "CPIN 26102300012345", { bankLedgerId: ledgers.sbi, components: rcmTax });
  await rcmAction("discharge", "tax-payment", "2026-10-20", "Cash ledger debit DC2310260004417", { components: rcmTax, evidenceType: "cash-ledger-debit" });
  await rcmAction("claim", "itc-claim", "2026-10-20", "RCM credit review October 2026", { components: rcmTax, review: { received: true, businessUse: true, notBlocked: true, documentsHeld: true, basis: "Freight on business purchases; self-invoice and payment voucher held" } });
  log("Reverse charge: GTA freight paid, tax discharged in cash and claimed as credit");

  // ---- Purchase ITC review ----------------------------------------------------------------
  const itcEvidence = { invoiceHeld: true, received: true, businessUse: true, notBlocked: true, supplierReported: true, supplierTaxPaid: true, returnFurnished: true, paymentReview: true, noTaxDepreciation: true, annualReturnStatus: "not-filed" };
  await api("POST", at("/gst/itc/claim"), { invoiceId: invoices.p1.id, date: "2026-05-11", reference: "ITC review April 2026", requestId: requestId("itc"),
    evidence: { ...itcEvidence, basis: "Section 16(2) conditions met; supplier shows the invoice in GSTR-2B April 2026", documentReference: "GSTR-2B 04/2026 row BED/26-27/0142" } });
  await api("POST", at("/gst/itc/claim"), { invoiceId: invoices.p2.id, date: "2026-06-12", reference: "ITC review May 2026", requestId: requestId("itc"),
    evidence: { ...itcEvidence, basis: "Section 16(2) conditions met; goods received at warehouse, invoice in GSTR-2B May 2026", documentReference: "GSTR-2B 05/2026 row SSI/2627/0388" } });
  log("Purchase ITC: two purchases claimed after review; the September purchase is marked eligible and waits for its claim");
  skipped.push("No GSTR-2B statement file was attached: ITC claims cite their GSTR-2B rows as text evidence, because a portal JSON cannot be produced honestly for made-up GSTINs");

  // ---- Bill-wise references and allocations ----------------------------------------------
  let reconRevision = (await api("GET", at("/reconciliation/bank"))).revision;
  async function reconcile(action, body) {
    const saved = await api("POST", at(`/reconciliation/${action}`), { ...body, revision: reconRevision, requestId: requestId("recon") });
    reconRevision = saved.revision;
    return saved.result;
  }
  async function billFor(partyLedgerId, voucherId) {
    const report = await api("GET", at(`/reconciliation/bills?asOf=2026-11-08&ledgerId=${encodeURIComponent(partyLedgerId)}`));
    return report.rows.find(row => row.voucherId === voucherId);
  }
  const key = (voucherId, ledgerId) => `${voucherId}:${ledgerId}`;
  const plusDays = (date, days) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  async function referenceBill(partyKey, side, invoiceKey, days) {
    const ledgerId = side === "receivable" ? receivable(partyKey) : payable(partyKey);
    const derived = await billFor(ledgerId, invoices[invoiceKey].id);
    const result = await reconcile("save-bill", { id: derived.id, ledgerId, sourceKey: derived.sourceKey, reference: derived.reference, dueDate: plusDays(derived.date, days), amountPaise: derived.amountPaise });
    return { id: result.id, ledgerId };
  }
  const billS1 = await referenceBill("mahakal", "receivable", "s1", 30);
  const billS4 = await referenceBill("mahakal", "receivable", "s4", 30);
  const billS7 = await referenceBill("mahakal", "receivable", "s7", 30);
  const billS9 = await referenceBill("mahakal", "receivable", "s9", 30);
  const billS10 = await referenceBill("mahakal", "receivable", "s10", 30);
  const billS2 = await referenceBill("patil", "receivable", "s2", 45);
  const billS5 = await referenceBill("patil", "receivable", "s5", 45);
  const billS8 = await referenceBill("patil", "receivable", "s8", 45);
  const billP1 = await referenceBill("bharat", "payable", "p1", 45);
  const billP3 = await referenceBill("bharat", "payable", "p3", 45);
  const billP2 = await referenceBill("surya", "payable", "p2", 30);
  const allocate = (bill, creditVoucher, date, paise) => reconcile("allocate-bill", { ledgerId: bill.ledgerId, billId: bill.id, creditKey: key(creditVoucher.id, bill.ledgerId), date, paise });
  await allocate(billS1, vouchers["r-mahakal-1"], "2026-05-20", rupees(50000)); // partial: balance stays open
  await allocate(billS4, invoices.cn1, "2026-07-25", invoices.cn1.gst.totals.totalPaise);
  await allocate(billS4, vouchers["r-mahakal-2"], "2026-08-05", rupees(total("s4") - total("cn1")));
  await allocate(billS7, vouchers["r-mahakal-3"], "2026-10-28", invoices.s7.gst.totals.totalPaise);
  await allocate(billS10, vouchers["r-mahakal-4"], "2026-09-18", invoices.s10.gst.totals.totalPaise);
  await allocate(billS2, vouchers["r-patil-1"], "2026-06-12", invoices.s2.gst.totals.totalPaise);
  await allocate(billS5, vouchers["r-patil-2"], "2026-09-10", invoices.s5.gst.totals.totalPaise);
  await allocate(billP1, vouchers["p-bharat-1"], "2026-05-25", invoices.p1.gst.totals.totalPaise);
  await allocate(billP2, vouchers["p-surya-1"], "2026-06-15", rupees(600000));
  await allocate(billP2, vouchers["p-surya-2"], "2026-09-20", invoices.p2.gst.totals.totalPaise - rupees(600000));
  void billS8; void billS9; void billP3; // open bills shown in ageing
  log("Bill-wise: 11 bill references with due dates, 10 allocations; the April Mahakal bill is part paid");

  // ---- Bank statement for SBI, October 2026 ------------------------------------------------
  const sbiOctober = await api("GET", at(`/reports/ledger/${encodeURIComponent(ledgers.sbi)}?from=2026-10-01&to=2026-10-31`));
  const statementOpening = signed(sbiOctober.opening);
  const rows = [
    ["05/10/2026", "NEFT DR SHRI GOPAL MAHESHWARI RENT OCT", "N278261005559", "18000.00", ""],
    ["10/10/2026", "BBPS MPPKVVCL IVRS 1234567890", "BB2610100981", "8640.00", ""],
    ["20/10/2026", "GST PAYMENT CPIN 26102300012345", "CPIN26102300012345", (rcmTax.cgstPaise + rcmTax.sgstPaise) / 100 + ".00", ""],
    ["28/10/2026", "NEFT CR SHREE MAHAKAL ELECTRICALS", "N301261028771", "", total("s7").toFixed(2)],
    ["31/10/2026", "SMS AND ACCOUNT CHARGES INCL GST", "CHG2610310001", "236.00", ""],
    ["31/10/2026", "CASH DEP SELF BRANCH 0322", "CDM2610310417", "", "15000.00"],
  ];
  const movement = rows.reduce((sum, row) => sum + (row[4] ? rupees(Number(row[4])) : -rupees(Number(row[3]))), 0);
  const csv = ["Date,Narration,Ref No,Withdrawal,Deposit", ...rows.map(row => row.join(","))].join("\n") + "\n";
  const statementId = (await reconcile("import-statement", {
    ledgerId: ledgers.sbi, name: "SBI current account, October 2026", from: "2026-10-01", to: "2026-10-31",
    openingPaise: statementOpening, closingPaise: statementOpening + movement, csv, dateFormat: "dd/mm/yyyy",
    mapping: { date: "Date", narration: "Narration", reference: "Ref No", debit: "Withdrawal", credit: "Deposit" },
  })).id;
  const bank = await api("GET", at(`/reconciliation/bank?statementId=${encodeURIComponent(statementId)}`));
  const pairs = [[0, vouchers["rent-10"]], [1, vouchers["p-electricity"]], [2, rcm.deposit], [3, vouchers["r-mahakal-3"]], [4, vouchers["bank-charges"]]];
  for (const [index, entry] of pairs) {
    await reconcile("match-bank", { statementId, rowIds: [bank.rows[index].id], voucherIds: [entry.id] });
  }
  log(`Bank: SBI October statement imported with ${rows.length} rows, ${pairs.length} matched; one cash deposit left unmatched for review`);

  // ---- Checks --------------------------------------------------------------------------
  const review = await api("GET", at(`/owner-review?from=${BOOKS_FROM}&to=2026-11-30`));
  const gst = await api("GET", at("/gst?date=2026-11-08"));
  let returns = null;
  try {
    returns = await api("GET", at(`/gst-returns?registration=${encodeURIComponent(registration.id)}&month=${RETURN_MONTH}`));
  } catch (error) {
    skipped.push(`The ${RETURN_MONTH} GST return check could not run: ${error.message}`);
  }
  const stock = await api("GET", at("/stock?to=2026-11-30"));
  const bankAfter = await api("GET", at(`/reconciliation/bank?statementId=${encodeURIComponent(statementId)}`));
  const bills = await api("GET", at("/reconciliation/bills?asOf=2026-11-08"));
  const itc = await api("GET", at("/gst/itc?to=2026-11-08"));
  const rcmState = await api("GET", at("/gst/rcm?to=2026-11-08"));
  const checks = {
    ownerReviewEntries: review.count,
    trialBalanceDifferencePaise: review.difference,
    gstInvoices: gst.invoices.length,
    gstReturnDocuments: returns ? Object.values(returns.sheets).reduce((sum, sheet) => sum + sheet.length, 0) : null,
    gstReturnWarnings: returns ? returns.hsnCheck.checks.length + returns.issues.length : null,
    gstReturnHsnComplete: returns ? returns.hsnCheck.complete : null,
    stockItems: stock.items.length,
    stockClosingValuePaise: stock.totals?.valuePaise ?? null,
    bankStatementRows: bankAfter.rows.length,
    bankMatchedRows: bankAfter.rows.filter(row => row.matched).length,
    billRows: bills.rows.length,
    partlyPaidBills: bills.rows.filter(row => row.paidPaise > 0 && row.openPaise > 0).length,
    itcDocuments: Array.isArray(itc.documents) ? itc.documents.length : null,
    rcmDocuments: rcmState.documents.length,
  };
  const summary = {
    company: { id: company.id, name: company.name, booksFrom: BOOKS_FROM, gstin: registration.gstin },
    ledgers: (await api("GET", at("/masters"))).company.ledgers.length,
    parties: Object.keys(parties).length,
    items: Object.keys(items).length,
    gstDocuments: gstDocs.length,
    ordinaryVouchers: Object.keys(vouchers).length,
    rcmEntries: Object.keys(rcm).length,
    cashBankPaise: review.cashBank,
    receivablePaise: review.receivable,
    payablePaise: review.payable,
    netProfitPaise: review.netProfit,
  };
  return { companyId: company.id, name: company.name, summary, checks, skipped };
}

function printReport(result) {
  const { summary, checks, skipped } = result;
  const money = value => typeof value === "number" ? inr(value) : JSON.stringify(value);
  console.log(`\nCompany id: ${result.companyId}`);
  console.log(`${summary.company.name} · GSTIN ${summary.company.gstin} · books from ${summary.company.booksFrom}`);
  console.log(`Ledgers ${summary.ledgers} · parties ${summary.parties} · items ${summary.items} · GST documents ${summary.gstDocuments} · ordinary vouchers ${summary.ordinaryVouchers} · RCM entries ${summary.rcmEntries}`);
  console.log(`Cash and bank ${money(summary.cashBankPaise)} · receivable ${money(summary.receivablePaise)} · payable ${money(summary.payablePaise)} · net profit ${money(summary.netProfitPaise)}`);
  console.log("Checks:");
  for (const [name, value] of Object.entries(checks)) console.log(`  ${name}: ${/Paise$/.test(name) && typeof value === "number" ? inr(value) : value}`);
  if (skipped.length) {
    console.log("Not seeded through the API:");
    for (const line of skipped) console.log(`  - ${line}`);
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  let options;
  try {
    ({ values: options } = parseArgs({ options: {
      home: { type: "string" }, name: { type: "string", default: DEFAULT_NAME }, force: { type: "boolean", default: false },
      json: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false },
    } }));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  if (options.help || !options.home) {
    console.log('Usage: node tools/seed-demo.mjs --home <LEDGERCRAFT_HOME dir> [--name "Saraswati Traders"] [--force] [--json]');
    process.exit(options.help ? 0 : 2);
  }
  try {
    const result = await seedDemo({ home: options.home, name: options.name, force: options.force, log: options.json ? () => {} : line => console.log(line) });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printReport(result);
  } catch (error) {
    console.error(error.message);
    process.exit(error.code === "EXISTS" ? 3 : 1);
  }
}
