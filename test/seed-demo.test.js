import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_NAME, seedDemo } from "../tools/seed-demo.mjs";
import { createStore } from "../lib/store.js";
import { trialBalance } from "../lib/engine.js";
import { HSN_DIRECTORY, missingResources } from "./helpers/resources.mjs";

async function withHome(run) {
  const home = await mkdtemp(path.join(tmpdir(), "ledgercraft-seed-demo-"));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test("seed-demo builds a balanced, lived-in company through the public API", async () => {
  await withHome(async (home) => {
    const result = await seedDemo({ home });
    assert.equal(result.name, DEFAULT_NAME);
    assert.match(result.companyId, /^saraswati-traders-[a-f0-9]{6}$/);
    const { checks, summary } = result;
    assert.equal(checks.trialBalanceDifferencePaise, 0);
    assert.ok(checks.ownerReviewEntries >= 30);
    assert.ok(checks.gstInvoices >= 13);
    assert.equal(checks.stockItems, 4);
    assert.ok(checks.stockClosingValuePaise > 0, "stock valuation is complete");
    assert.ok(checks.bankStatementRows >= 3 && checks.bankMatchedRows >= 3);
    assert.equal(checks.partlyPaidBills, 1);
    assert.ok(checks.itcDocuments >= 2);
    assert.equal(checks.rcmDocuments, 1);
    if (!missingResources(HSN_DIRECTORY).length) {
      assert.ok(checks.gstReturnDocuments > 0);
      assert.equal(checks.gstReturnWarnings, 0);
    }
    assert.ok(summary.netProfitPaise > 0, "the demo book shows a modest profit");

    // The saved files load through the ordinary store and agree with the API's view.
    const { company, vouchers } = await createStore(path.join(home, "data")).get(result.companyId);
    assert.equal(trialBalance(company, vouchers, company.booksFrom, "2026-11-30").difference, 0);
    const invoices = vouchers.filter(v => v.gst).map(v => v.gst);
    assert.ok(invoices.some(i => i.direction === "sales" && i.totals.igstPaise > 0), "an inter-state sale");
    assert.ok(invoices.some(i => i.direction === "sales" && !i.party.gstin), "a B2C sale");
    assert.ok(invoices.some(i => i.type === "Credit Note" && i.originalInvoiceId), "a linked credit note");
    assert.ok(invoices.some(i => i.direction === "purchase" && i.reverseCharge), "an RCM purchase");
    assert.equal(invoices.filter(i => i.type === "Purchase").length, 4);
    for (const type of ["Receipt", "Payment", "Contra", "Journal"]) assert.ok(vouchers.some(v => v.type === type && !v.gst && !v.gstRcm), type);
    assert.ok(invoices.every(i => i.date >= "2026-04-01" && i.date <= "2026-11-30"));
    assert.equal(new Set(company.gst.items.map(i => i.gstRateBps)).size >= 3, true);
  });
});

test("seed-demo refuses an existing company name unless forced, and never replaces it", async () => {
  await withHome(async (home) => {
    const first = await seedDemo({ home });
    await assert.rejects(seedDemo({ home, name: "  saraswati   TRADERS " }), (error) => error.code === "EXISTS" && error.message.includes(first.companyId));
    const second = await seedDemo({ home, force: true });
    assert.notEqual(second.companyId, first.companyId);
    const listed = await createStore(path.join(home, "data")).list();
    assert.deepEqual(listed.map(c => c.id).sort(), [first.companyId, second.companyId].sort());
  });
});
