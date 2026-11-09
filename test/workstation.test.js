import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../server.js";

const seedFolder = fileURLToPath(new URL("../data/companies/specimen-8fe3bf/", import.meta.url));
const originalId = "specimen-8fe3bf";
const close = server => new Promise(resolve => server.close(resolve));
const base = server => "http://127.0.0.1:" + server.address().port;

test("desktop seed, owner review, local search, company selection and restart agree", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "financer-reopen-"));
  let server = await start({ home, seedFolder });
  const read = async url => {
    const res = await fetch(base(server) + url);
    assert.equal(res.status, 200); return res.json();
  };
  try {
    const settings = await read("/api/workstation");
    assert.equal(settings.lastCompany, originalId);
    assert.equal(settings.country, "India/SAARC");
    assert.equal(settings.uiLanguageId, 1033);
    assert.ok(settings.dictionaries.includes("Hindi"));
    const company = "/api/companies/" + originalId;
    const summary = await read(company + "/owner-review?from=2026-04-01&to=2026-11-07");
    assert.deepEqual([summary.cashBank, summary.payable, summary.netProfit, summary.difference], [26700000, 1500000, 200000, 0]);
    assert.equal(summary.latest[0].number, "PUR-1");
    assert.equal((await read(company + "/find?q=godown")).matches.some(m => m.title === "PMT-1"), true);
    assert.equal((await read(company + "/vouchers/v-specimen-receipt")).voucher.number, "RCT-1");
    assert.ok((await read(company + "/masters")).usedLedgerIds.includes("l-cash"));
    const create = await fetch(base(server) + "/api/companies", { method: "POST", body: JSON.stringify({ name: "Second company", booksFrom: "2026-04-01" }) });
    const next = (await create.json()).company.id;
    const res = await fetch(base(server) + "/api/workstation", { method: "PUT", body: JSON.stringify({ lastCompany: next }) });
    assert.equal(res.status, 200);
    await close(server);
    server = await start({ home, seedFolder });
    assert.equal((await read("/api/workstation")).lastCompany, next);
    assert.equal((await read("/api/companies")).companies.length, 2);
    assert.equal((await read("/api/companies/" + next + "/find?q=godown")).matches.length, 0);
    assert.equal((await read(company)).vouchers.length, 3);
    const blocked = await fetch(base(server) + "/api/specimen", { method:"POST", headers:{ origin:"https://foreign.invalid" } });
    assert.equal(blocked.status, 403);
    assert.equal((await read("/api/companies")).companies.length, 2);
    assert.equal(JSON.parse(await readFile(path.join(home, "workstation.json"))).lastCompany, next);
  } finally {
    await close(server);
    await rm(home, { recursive: true, force: true });
  }
});

test("read-only book snapshots are shared until either source file changes", async () => {
  const { createStore } = await import("../lib/store.js");
  const { writeFile, rename } = await import("node:fs/promises");
  const home = await mkdtemp(path.join(os.tmpdir(), "financer-reader-"));
  try {
    const store = createStore(home);
    const { company } = await store.specimen();
    const first = await store.snapshot(company.id);
    assert.equal(await store.snapshot(company.id), first);
    const write = store.addLedger(company.id, { name: "Bank charge", groupId: "g-indirect-exp", openingDc: "Dr", openingPaise: 0 });
    const edited = await store.snapshot(company.id);
    await write;
    assert.notEqual(edited, first);
    assert.equal(edited.company.ledgers.length, first.company.ledgers.length + 1);
    const file = path.join(home, "companies", company.id, "vouchers.json");
    const externallyEdited = structuredClone(edited.vouchers);
    externallyEdited[0].narration = "External correction";
    await writeFile(file + ".new", JSON.stringify(externallyEdited));
    await rename(file + ".new", file);
    assert.equal((await store.snapshot(company.id)).vouchers[0].narration, "External correction");
    await assert.rejects(store.snapshot("../"), /Unknown company/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a workstation saved before users existed keeps loading, and users never leave through get()", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { openWorkstation } = await import("../lib/workstation.js");
  const home = await mkdtemp(path.join(os.tmpdir(), "financer-users-compat-"));
  try {
    const dataDirectory = path.join(home, "data");
    await writeFile(path.join(home, "workstation.json"), JSON.stringify({ dataDirectory, defaultCompany: null, lastCompany: "old-co", loadLastCompany: true }));
    const station = await openWorkstation(home, dataDirectory);
    assert.equal(station.get().lastCompany, "old-co");
    assert.deepEqual(station.users(), []);
    const result = await station.updateUsers((users) => ({ users: [...users, { id: "u-1", name: "Asha", role: "owner", passphraseHash: "scrypt$x" }], result: "saved" }));
    assert.equal(result, "saved");
    assert.equal(station.get().users, undefined);
    assert.equal((await station.update({ lastCompany: "new-co", users: [] })).users, undefined);
    assert.equal(station.users().length, 1, "update() cannot replace the user list");
    await assert.rejects(station.updateUsers(() => { throw new Error("refused"); }), /refused/);
    assert.equal(station.users().length, 1);
    const reopened = await openWorkstation(home, dataDirectory);
    assert.deepEqual([reopened.get().lastCompany, reopened.users()[0].name], ["new-co", "Asha"]);
    assert.equal(JSON.parse(await readFile(path.join(home, "workstation.json"), "utf8")).users[0].passphraseHash, "scrypt$x");
  } finally { await rm(home, { recursive: true, force: true }); }
});
