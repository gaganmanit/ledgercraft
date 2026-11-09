import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { start } from "../server.js";
import { createStore } from "../lib/store.js";
import { gstinCheckDigit } from "../lib/gst.js";

const gstin = stem => stem + gstinCheckDigit(stem);

async function book(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ledgercraft-3b-settings-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = createStore(dataDir);
  const { company } = await store.create({ name: "Public 3B settings book", booksFrom: "2026-04-01" });
  const { registration } = await store.saveGstMaster(company.id, "registration", { name: "Synthetic seller", gstin: gstin("23ABCDE1234F1Z"), stateCode: "23", address: "Public test address" });
  const server = await start({ port: 0, dataDir });
  t.after(() => new Promise(done => server.close(done)));
  const base = "http://127.0.0.1:" + server.address().port + "/api/companies/" + company.id + "/gst-returns";
  const call = async (method, route, body, status = 200) => {
    const res = await fetch(base + route, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await res.json();
    assert.equal(res.status, status, JSON.stringify(result));
    return result;
  };
  const audit = async () => (await readFile(path.join(dataDir, "companies", company.id, "audit.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { store, id: company.id, registration, call, audit, settings: "/3b/settings?registration=" + registration.id };
}

test("GSTR-3B settings per registration: defaults, validation, saved through the store with an edit-log entry and replayed by request id", async t => {
  const f = await book(t);
  const initial = await f.call("GET", f.settings);
  assert.deepEqual({ ...initial }, { registrationId: f.registration.id, gstin: f.registration.gstin, frequency: "monthly", aggregateTurnoverPaise: null, updatedAt: null, requestId: null, source: "default",
    defaults: { frequency: "monthly", aggregateTurnoverPaise: null }, qrmpTurnoverLimitPaise: 5000000000 });
  await f.call("GET", "/3b/settings?registration=missing", undefined, 400);

  const valid = { frequency: "quarterly", aggregateTurnoverPaise: 1200000000, requestId: "gstr3b-settings-save-0001" };
  for (const [body, message] of [
    [{ ...valid, frequency: "yearly" }, /monthly or quarterly/],
    [{ ...valid, aggregateTurnoverPaise: -1 }, /whole paise/],
    [{ ...valid, aggregateTurnoverPaise: 12.5 }, /whole paise/],
    [{ ...valid, aggregateTurnoverPaise: "1200000000" }, /whole paise/],
    [{ ...valid, aggregateTurnoverPaise: 5000000001 }, /Rs 5 crore/],
    [{ ...valid, requestId: "short" }, /save identifier/],
    [{ frequency: "monthly", aggregateTurnoverPaise: null }, /save identifier/],
    [[], /Enter the GSTR-3B settings/],
  ]) assert.match((await f.call("POST", f.settings, body, 400)).error, message);
  assert.match((await f.call("POST", "/3b/settings?registration=missing", valid, 400)).error, /saved GST registration/);
  assert.equal((await f.store.get(f.id)).company.gst.returns3b, undefined);

  const before = (await f.audit()).length;
  const saved = await f.call("POST", f.settings, valid);
  assert.equal(saved.replayed, false);
  assert.equal(saved.settings.source, "saved");
  assert.equal(saved.settings.frequency, "quarterly");
  assert.equal(saved.settings.aggregateTurnoverPaise, 1200000000);
  assert.equal(saved.settings.requestId, valid.requestId);
  const stored = (await f.store.get(f.id)).company.gst.returns3b[f.registration.id];
  assert.deepEqual(Object.keys(stored).sort(), ["aggregateTurnoverPaise", "frequency", "requestId", "updatedAt"]);
  assert.ok(Number.isFinite(Date.parse(stored.updatedAt)));
  const log = await f.audit();
  assert.equal(log.length, before + 1);
  assert.equal(log.at(-1).entity, "gst-master");
  assert.equal(log.at(-1).id, "gstr3b-settings-" + f.registration.id);
  assert.equal(log.at(-1).action, "create");
  assert.equal(log.at(-1).requestId, valid.requestId);
  assert.match(log.at(-1).summary, /quarterly/);

  const again = await f.call("POST", f.settings, valid);
  assert.equal(again.replayed, true);
  assert.equal((await f.audit()).length, before + 1);
  assert.match((await f.call("POST", f.settings, { ...valid, frequency: "monthly" }, 400)).error, /different GSTR-3B settings/);
  assert.match((await f.call("POST", f.settings, { frequency: "monthly", aggregateTurnoverPaise: 1200000000, requestId: "gstr3b-settings-save-0002", expected: { updatedAt: "2026-01-01T00:00:00.000Z" } }, 400)).error, /changed while you were editing/);

  // GET /3b takes the saved frequency and turnover as defaults; the query still overrides them.
  const quarter = await f.call("GET", "/3b?registration=" + f.registration.id + "&month=2026-06&filingDate=2026-07-22");
  assert.equal(quarter.frequency, "quarterly");
  assert.deepEqual(quarter.months, ["2026-04", "2026-05", "2026-06"]);
  assert.equal(quarter.lateFee.turnoverBasis, "entered");
  assert.equal(quarter.settings.source, "saved");
  assert.deepEqual(quarter.settings.overridden, []);
  const monthly = await f.call("GET", "/3b?registration=" + f.registration.id + "&month=2026-06&frequency=monthly&turnover=60000000");
  assert.equal(monthly.frequency, "monthly");
  assert.deepEqual(monthly.months, ["2026-06"]);
  assert.deepEqual(monthly.settings.overridden, ["frequency", "aggregateTurnoverPaise"]);

  const altered = await f.call("POST", f.settings, { frequency: "monthly", aggregateTurnoverPaise: 9000000000, requestId: "gstr3b-settings-save-0003", expected: { updatedAt: stored.updatedAt } });
  assert.equal(altered.settings.frequency, "monthly");
  assert.equal((await f.audit()).at(-1).action, "alter");
  assert.equal((await f.call("GET", f.settings)).aggregateTurnoverPaise, 9000000000);
});
