import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { start as startCurrent } from "../server.js";
import { reservedGroups } from "../lib/groups.js";
import { validateTransfer } from "../lib/transfer.js";

const sampleCount = 5;
const expectedHashes = {
  company: "9c939629645ad96f1e76571bcabb9d5cef8b84bb4a72d324877e6858b2f3cd5b",
  vouchers: "cc858b3843c16a00c00b3a92d6a59495374bf76123ffb07b5e752d08ee3905ed",
  response: "30c33d1848c9b92abde163e3b3cc2a50382947c647a1f201ec4dd9e65897e20a",
};

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function buildFixture() {
  const groupIds = ["g-cash", "g-capital", "g-bank", "g-creditors", "g-debtors", "g-current-liab", "g-fixed", "g-loans"];
  const ledgers = Array.from({ length: 1000 }, (_, index) => ({
    id: `l-bench-${index}`,
    name: `Benchmark Ledger ${String(index).padStart(4, "0")}`,
    groupId: groupIds[index % groupIds.length],
    opening: { dc: index % 2 ? "Cr" : "Dr", paise: 100000 },
  }));
  const company = {
    id: "bench-10000-1000",
    name: "Synthetic Benchmark Books",
    booksFrom: "2026-04-01",
    groups: reservedGroups(),
    ledgers,
  };
  const dates = ["2026-04-15", "2026-07-15", "2026-09-15", "2026-10-15"];
  const vouchers = Array.from({ length: 10000 }, (_, index) => {
    const paise = 10000 + (index % 97) * 137;
    return {
      id: `v-bench-${index}`,
      type: "Journal",
      date: dates[index % dates.length],
      number: `JRN-${index + 1}`,
      narration: `Synthetic journal ${index + 1}`,
      lines: [
        { ledgerId: ledgers[index % ledgers.length].id, dc: "Dr", paise },
        { ledgerId: ledgers[(index * 37 + 1) % ledgers.length].id, dc: "Cr", paise },
      ],
    };
  });
  validateTransfer({ company, vouchers });
  return { company, vouchers, dates };
}

function summarize(pairs) {
  function statistics(name) {
    const values = pairs.map(pair => pair[`${name}Ms`]);
    const ordered = [...values].sort((a, b) => a - b);
    return {
      meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
      medianMs: ordered[Math.floor(ordered.length / 2)],
    };
  }
  const original = statistics("original");
  const current = statistics("current");
  return {
    samples: pairs,
    original,
    current,
    medianSpeedup: original.medianMs / current.medianMs,
    meanSpeedup: original.meanMs / current.meanMs,
  };
}

async function directoryBytes(folder) {
  let total = 0;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    total += entry.isDirectory() ? await directoryBytes(file) : (await stat(file)).size;
  }
  return total;
}

async function main() {
  const originalDirectory = process.argv[2];
  if (!originalDirectory || ["--help", "-h"].includes(originalDirectory)) {
    console.log("Usage: node tools/benchmark-http.mjs ORIGINAL_PROJECT_DIRECTORY");
    console.log("Measures the original and current HTTP trial balance with identical synthetic books.");
    console.log("The benchmark uses temporary books for both source trees.");
    if (!originalDirectory) process.exitCode = 1;
    return;
  }
  assert.equal(process.argv.length, 3, "Supply one original project directory");
  const originalRoot = path.resolve(originalDirectory);
  assert.ok((await stat(originalRoot)).isDirectory(), "The original project must be a directory");
  const { start: startOriginal } = await import(pathToFileURL(path.join(originalRoot, "server.js")).href);
  assert.equal(typeof startOriginal, "function", "The original server.js must export start()");

  const { company, vouchers, dates } = buildFixture();
  const companyText = JSON.stringify(company);
  const vouchersText = JSON.stringify(vouchers);
  assert.equal(digest(companyText), expectedHashes.company, "The company fixture changed");
  assert.equal(digest(vouchersText), expectedHashes.vouchers, "The voucher fixture changed");

  const scratch = await mkdtemp(path.join(tmpdir(), "financer-http-benchmark-"));
  const servers = new Set();
  const fixtureFiles = [];
  const observedHashes = new Set();
  const observedPorts = [];
  let reference;
  let responseBytes;
  const output = {
    runtime: { processId: process.pid, node: process.version, platform: `${process.platform}-${process.arch}` },
    method: {
      timing: "HTTP fetch through response.json(); equality checks and hashing happen after timing",
      warm: "One first request per server, then five alternating pairs on those same two server instances",
      freshInstance: "Five alternating pairs, each with two new server instances and separate identical data folders",
      environment: "Both implementations run in one Node process; operating-system file caches and the JavaScript engine stay warm",
      requestTimeoutMs: 60000,
    },
  };

  async function startPair(label) {
    const pair = [];
    for (const [index, start] of [startOriginal, startCurrent].entries()) {
      const dataDir = path.join(scratch, label, index === 0 ? "original" : "current");
      const folder = path.join(dataDir, "companies", company.id);
      await mkdir(folder, { recursive: true });
      for (const [name, text, sha256] of [
        ["company.json", companyText, expectedHashes.company],
        ["vouchers.json", vouchersText, expectedHashes.vouchers],
      ]) {
        const file = path.join(folder, name);
        await writeFile(file, text, { mode: 0o600 });
        fixtureFiles.push({ file, sha256 });
      }
      const server = await start({ port: 0, dataDir });
      servers.add(server);
      pair.push(server);
    }
    const ports = pair.map(server => server.address().port);
    assert.notEqual(ports[0], ports[1], "Each server must have its own ephemeral port");
    observedPorts.push({ phase: label, original: ports[0], current: ports[1] });
    return pair;
  }

  async function closePair(pair) {
    await Promise.all(pair.map(server => new Promise((resolve, reject) => {
      server.close(error => {
        servers.delete(server);
        if (error) reject(error);
        else resolve();
      });
    })));
  }

  async function request(server) {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/api/companies/${company.id}/reports/trial-balance?from=2026-07-01&to=2026-09-30`;
    const began = performance.now();
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    assert.equal(response.status, 200);
    const report = await response.json();
    const elapsed = performance.now() - began;
    if (!reference) reference = report;
    assert.deepStrictEqual(report, reference, "Every decoded report field and row must match");
    assert.equal(report.rows.length, 1000);
    assert.equal(report.difference, 0);
    const text = JSON.stringify(report);
    const sha256 = digest(text);
    assert.equal(sha256, expectedHashes.response, "The response changed from the validated benchmark");
    observedHashes.add(sha256);
    responseBytes = Buffer.byteLength(text);
    return elapsed;
  }

  async function samplePair(pair, index) {
    const order = index % 2 ? [1, 0] : [0, 1];
    const times = [];
    for (const which of order) times[which] = await request(pair[which]);
    return {
      order: order.map(which => which === 0 ? "original" : "current"),
      originalMs: times[0],
      currentMs: times[1],
    };
  }

  try {
    const warmPair = await startPair("warm");
    output.firstRequestMs = {
      original: await request(warmPair[0]),
      current: await request(warmPair[1]),
    };
    const warmSamples = [];
    for (let index = 0; index < sampleCount; index += 1) warmSamples.push(await samplePair(warmPair, index));
    output.warm = summarize(warmSamples);
    await closePair(warmPair);

    const freshSamples = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const pair = await startPair(`fresh-${index + 1}`);
      freshSamples.push(await samplePair(pair, index));
      await closePair(pair);
    }
    output.freshInstance = summarize(freshSamples);

    for (const { file, sha256 } of fixtureFiles) assert.equal(digest(await readFile(file)), sha256, "A fixture file changed");
    assert.equal(observedHashes.size, 1);
    output.ephemeralPorts = observedPorts;
    output.dataset = {
      ledgers: 1000, vouchers: 10000, postings: 20000, type: "Journal",
      openingDrLedgers: 500, openingCrLedgers: 500, openingPaiseEach: 100000,
      voucherDebitPaise: { minimum: 10000, maximum: 23152 },
      dateDistribution: dates.map(date => ({ date, vouchers: 2500 })),
      periodFrom: "2026-07-01", periodTo: "2026-09-30",
      broughtForwardVouchers: 2500, inPeriodVouchers: 5000, afterPeriodVouchers: 2500,
      sourceBytes: {
        company: Buffer.byteLength(companyText), vouchers: Buffer.byteLength(vouchersText),
        total: Buffer.byteLength(companyText) + Buffer.byteLength(vouchersText),
      },
      responseBytes,
    };
    output.equality = {
      deepEqualEveryRowEveryResponse: true,
      uniqueResponseHashes: observedHashes.size,
      responseSHA256: expectedHashes.response,
      sourceSHA256: { company: expectedHashes.company, vouchers: expectedHashes.vouchers },
      fixtureFilesUnchanged: fixtureFiles.length,
    };
  } finally {
    const cleanupResults = await Promise.allSettled([
      ...[...servers].map(server => closePair([server])),
    ]);
    const removedBytes = await directoryBytes(scratch);
    await rm(scratch, { recursive: true, force: true });
    await assert.rejects(stat(scratch), { code: "ENOENT" });
    output.cleanup = { scratchRemoved: true, removedBytes, serversRemaining: servers.size };
    const failures = cleanupResults.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "A benchmark server could not close");
  }
  console.log(JSON.stringify(output, null, 2));
}

await main();
