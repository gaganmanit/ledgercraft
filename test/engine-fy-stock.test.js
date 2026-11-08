import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../lib/store.js";
import { balanceSheet, PL_BROUGHT_FORWARD_ID, profitAndLoss, trialBalance } from "../lib/engine.js";
import { stockForStatements } from "../lib/stock-accounts.js";
import { start } from "../server.js";
import { gstinCheckDigit } from "../lib/gst.js";

// An integrated-stock book that trades in FY 2026-27 and again in FY 2027-28.
test("with integrated stock the balance sheet carries last year's profit, stock adjustment included, as retained profit", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "financer-engine-fy-stock-"));
  let server;
  try {
    const store = createStore(dataDir);
    const { company } = await store.create({ name: "FY stock book", booksFrom: "2026-04-01" });
    const regGstin = "23ABCDE1234F1Z", partyGstin = "23PQRST5678L1Z";
    const { registration } = await store.saveGstMaster(company.id, "registration", { name: "Seller", legalName: "Seller", address: "Registered address", stateCode: "23", gstin: regGstin + gstinCheckDigit(regGstin) });
    const { party } = await store.saveGstMaster(company.id, "party", { name: "Counterparty", kind: "both", stateCode: "23", address: "Party address", gstin: partyGstin + gstinCheckDigit(partyGstin) });
    const { item } = await store.saveGstMaster(company.id, "item", { name: "Goods A", kind: "goods", hsnSac: "854140", unit: "NOS", pricePaise: 20000, purchasePricePaise: 12000, gstRateBps: 1800, openingQuantity: "4" });
    server = await start({ port: 0, dataDir });
    const base = `http://127.0.0.1:${server.address().port}/api/companies/${company.id}`;
    const req = async (route, method = "GET", body, status = 200) => {
      const res = await fetch(base + route, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const data = await res.json();
      assert.equal(res.status, status, JSON.stringify(data));
      return data;
    };
    await req(`/stock/items/${item.id}`, "PUT", { revision: 0, requestId: "fy-stock-opening-0001", costingMethod: "fifo", openingValuePaise: 40000, openingAllocations: [] });
    await store.addLedger(company.id, { name: "Opening merchandise", groupId: "g-stock", openingDc: "Dr", openingPaise: 40000 });
    await store.addLedger(company.id, { name: "Owner contribution", groupId: "g-capital", openingDc: "Cr", openingPaise: 40000 });
    await req("/stock/settings", "PUT", { revision: 1, requestId: "fy-stock-integrate-01", integrateAccounts: true });
    const fields = { registrationId: registration.id, partyId: party.id, placeOfSupply: "23", itcEligibility: "eligible" };
    const line = { itemId: item.id, quantity: "6", unitPricePaise: 12000 };
    await req("/gst/invoices", "POST", { ...fields, type: "Purchase", date: "2026-04-02", supplierInvoiceNumber: "SUP-1", items: [line] }, 201);
    await req("/gst/invoices", "POST", { ...fields, type: "Sales", date: "2026-04-04", items: [{ ...line, quantity: "3", unitPricePaise: 20000 }] }, 201);
    await req("/gst/invoices", "POST", { ...fields, type: "Sales", date: "2027-05-10", items: [{ ...line, quantity: "1", unitPricePaise: 20000 }] }, 201);

    const { company: book, vouchers } = await store.get(company.id);
    const firstYear = profitAndLoss(book, vouchers, "2026-04-01", "2027-03-31");
    assert.equal(firstYear.netProfit, 30000);
    const secondYear = profitAndLoss(book, vouchers, "2027-04-01", "2028-03-31");
    assert.equal(secondYear.netProfit, 10000); // one opening unit costed at 10,000 paise sold for 20,000
    const sheet = balanceSheet(book, vouchers, "2028-03-31");
    assert.equal(sheet.retainedProfit, firstYear.netProfit);
    assert.equal(sheet.currentProfit, secondYear.netProfit);
    assert.equal(sheet.profit, secondYear.netProfit);
    assert.equal(sheet.difference, 0);
    const capital = sheet.liabilityGroups.find((group) => group.groupName === "Capital Account");
    assert.equal(capital.ledgers.find((row) => row.ledgerId === PL_BROUGHT_FORWARD_ID).paise, 30000);
    // The cumulative profit is unchanged by the split.
    const cumulative = stockForStatements(book, vouchers, book.booksFrom, "2028-03-31");
    assert.ok(cumulative.complete);
    assert.equal(trialBalance(book, vouchers, "2027-04-01", "2028-03-31").difference, 0);
    // Same date served over HTTP, with the split visible to the client.
    const http = await req("/reports/balance-sheet?to=2028-03-31");
    assert.equal(http.retainedProfit, 30000);
    assert.equal(http.difference, 0);
  } finally {
    if (server) await new Promise((done) => server.close(done));
    await rm(dataDir, { recursive: true, force: true });
  }
});
