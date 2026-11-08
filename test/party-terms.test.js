import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../lib/store.js";

async function withStore(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ledgercraft-terms-"));
  try { await run(createStore(dir), dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("ledgers carry MSME status and credit days for the ageing reports", () => withStore(async (store, dir) => {
  const { company: { id } } = await store.create({ name: "Terms Test", booksFrom: "2026-04-01" });
  const added = await store.addLedger(id, { name: "Mahakal Electricals", groupId: "g-creditors", openingPaise: 0, openingDc: "Cr", msme: true, creditDays: 45 });
  const ledger = added.company.ledgers.find((row) => row.name === "Mahakal Electricals");
  assert.equal(ledger.msme, true);
  assert.equal(ledger.creditDays, 45);
  await assert.rejects(store.addLedger(id, { name: "Bad", groupId: "g-creditors", openingPaise: 0, openingDc: "Cr", creditDays: 4000 }), /0 to 3650/);
  await assert.rejects(store.addLedger(id, { name: "Bad", groupId: "g-creditors", openingPaise: 0, openingDc: "Cr", msme: "yes" }), /MSME/);
  const updated = await store.updateLedger(id, ledger.id, { name: ledger.name, groupId: ledger.groupId, creditDays: 30, msme: false, expected: { name: ledger.name, groupId: ledger.groupId, opening: ledger.opening } });
  const after = updated.company.ledgers.find((row) => row.id === ledger.id);
  assert.equal(after.creditDays, 30);
  assert.equal(after.msme, undefined);
  const log = (await readFile(path.join(dir, "companies", id, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const last = log.at(-1);
  assert.equal(last.entity, "ledger");
  assert.match(last.summary, /credit days 45 to 30/);
  assert.match(last.summary, /MSME mark removed/);
  const cleared = await store.updateLedger(id, ledger.id, { name: ledger.name, groupId: ledger.groupId, creditDays: null, expected: { name: ledger.name, groupId: ledger.groupId, opening: ledger.opening } });
  assert.equal(cleared.company.ledgers.find((row) => row.id === ledger.id).creditDays, undefined);
  const plain = await store.addLedger(id, { name: "Plain", groupId: "g-debtors", openingPaise: 0, openingDc: "Dr" });
  const plainLedger = plain.company.ledgers.find((row) => row.name === "Plain");
  assert.equal("msme" in plainLedger, false);
  assert.equal("creditDays" in plainLedger, false);
}));

test("GST parties keep credit days and reject impossible values", () => withStore(async (store) => {
  const { company: { id } } = await store.create({ name: "Party Terms", booksFrom: "2026-04-01" });
  const { party } = await store.saveGstMaster(id, "party", { name: "Patil Power", address: "Pune", stateCode: "27", kind: "customer", creditDays: 30 });
  assert.equal(party.creditDays, 30);
  const { party: edited } = await store.saveGstMaster(id, "party", { id: party.id, name: "Patil Power", address: "Pune", stateCode: "27", kind: "customer", creditDays: 15 });
  assert.equal(edited.creditDays, 15);
  await assert.rejects(store.saveGstMaster(id, "party", { name: "Bad Party", address: "Pune", stateCode: "27", kind: "customer", creditDays: -1 }), /0 to 3650/);
  const { party: plain } = await store.saveGstMaster(id, "party", { name: "Plain Party", address: "Pune", stateCode: "27", kind: "customer" });
  assert.equal("creditDays" in plain, false);
}));
