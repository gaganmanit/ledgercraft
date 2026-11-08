import { start } from "../../server.js";
import { createStore } from "../../lib/store.js";
import { gstinCheckDigit } from "../../lib/gst.js";
import { todayISO } from "../../lib/money.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Run with --serve to create a disposable synthetic server. Test discovery stays read-only.
async function startSyntheticFixture() {
  const home = await mkdtemp(path.join(tmpdir(), "financer-reconciliation-ui-"));
  const store = createStore(path.join(home, "data"));
  const { company } = await store.create({ name: "Synthetic Reconciliation Books", booksFrom: "2026-04-01" });
  const id = company.id;
  for (const input of [
    { name: "Test Bank", groupId: "g-bank", openingPaise: 100000, openingDc: "Dr" },
    { name: "Customer A", groupId: "g-debtors", openingPaise: 20000, openingDc: "Dr" },
    { name: "Supplier A", groupId: "g-creditors", openingPaise: 0, openingDc: "Cr" },
    { name: "Capital", groupId: "g-capital", openingPaise: 120000, openingDc: "Cr" },
    { name: "Sales", groupId: "g-sales", openingPaise: 0, openingDc: "Cr" },
    { name: "Purchases", groupId: "g-purchase", openingPaise: 0, openingDc: "Dr" },
  ]) await store.addLedger(id, input);
  const snapshot = await store.get(id);
  const ids = Object.fromEntries(snapshot.company.ledgers.map(row => [row.name, row.id]));
  const post = async (type, number, date, dr, cr, paise) => (await store.passVoucher(id, {
    type, number, date, narration: number,
    lines: [{ ledgerId: ids[dr], dc: "Dr", paise }, { ledgerId: ids[cr], dc: "Cr", paise }],
  })).voucher;
  const sale = await post("Sales", "INV-001", "2026-04-02", "Customer A", "Sales", 10000);
  const receipt = await post("Receipt", "RCT-001", "2026-04-05", "Test Bank", "Customer A", 6000);
  const purchase = await post("Purchase", "PUR-001", "2026-04-03", "Purchases", "Supplier A", 8000);
  const payment = await post("Payment", "PAY-001", "2026-04-06", "Supplier A", "Test Bank", 4000);
  await writeFile(path.join(home, "statement.csv"), 'Date,Details,Reference,Debit,Credit\r\n05/04/2026,"Customer, A",RCT-001,,60.00\r\n06/04/2026,Supplier,PAY-001,40.00,\r\n');
  await writeFile(path.join(home, "signed.csv"), "Date,Description,Amount,Ref\n2026-05-01,Account fee,-3.00,FEE-001\n");
  const { registration } = await store.saveGstMaster(id, "registration", { name: "Main", legalName: "Synthetic Books", gstin: "23ABCDE1234F1Z8", stateCode: "23", address: "Test Road" });
  const gstinBase = "23ABCDE1234F2Z";
  const { party } = await store.saveGstMaster(id, "party", { name: "GST Customer", kind: "customer", stateCode: "23", gstin: gstinBase + gstinCheckDigit(gstinBase), address: "Test Road" });
  const { item } = await store.saveGstMaster(id, "item", { name: "Test goods", kind: "goods", hsnSac: "8541", unit: "NOS", gstRateBps: 1800, pricePaise: 10000, openingQuantity: "10" });
  const { invoice } = await store.passGstInvoice(id, { type: "Sales", registrationId: registration.id, partyId: party.id, date: todayISO(), placeOfSupply: "23", items: [{ itemId: item.id, quantity: "1", unitPricePaise: 10000 }] });
  const server = await start({ port: 0, home });
  const fixture = { url: `http://127.0.0.1:${server.address().port}`, home, id, ids, sale: sale.id, receipt: receipt.id, payment: payment.id, purchase: purchase.id, invoice: invoice.id };
  const fixtureFile = path.join(home, "fixture.json");
  await writeFile(fixtureFile, JSON.stringify(fixture));
  console.log(JSON.stringify({ ...fixture, fixtureFile }));
  const close = () => server.close(async () => { await rm(home, { recursive: true, force: true }); process.exit(0); });
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}

if (process.argv.includes("--serve")) await startSyntheticFixture();
