import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { sessionGate, start, workstationToken } from "../server.js";

// Node's fetch rewrites Host and Sec-Fetch-* headers, so browser-shaped requests go through http.request.
function rawStatus(port, headers, route = "/api/companies") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method: "GET", headers: { host: `127.0.0.1:${port}`, ...headers }, setHost: false }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(options, run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "ledgercraft-security-"));
  const server = await start({ home, ...options });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const request = (route, init = {}) => fetch(base + route, { redirect: "manual", ...init });
  try { await run({ base, port, request, home }); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(home, { recursive: true, force: true }); }
}

test("the loopback server refuses foreign hosts and cross-site fetches but allows navigations", () => withServer({}, async ({ request, port }) => {
  assert.equal((await request("/api/companies")).status, 200);
  assert.equal(await rawStatus(port, { host: `evil.example:${port}` }), 403);
  assert.equal(await rawStatus(port, { host: `localhost:${port}` }), 200);
  assert.equal((await request("/api/companies", { headers: { origin: "http://attacker.test" } })).status, 403);
  assert.equal(await rawStatus(port, { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" }), 403);
  assert.equal(await rawStatus(port, { "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" }), 403);
  assert.equal(await rawStatus(port, { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }), 200);
  assert.equal(await rawStatus(port, { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }, "/"), 200);
  assert.equal(await rawStatus(port, { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" }, "/"), 200);
}));

test("static files come only from public/ with validators and safe types", () => withServer({}, async ({ request }) => {
  const css = await request("/ledgercraft.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /^text\/css/);
  assert.ok(css.headers.get("etag"));
  const again = await request("/ledgercraft.css", { headers: { "if-none-match": css.headers.get("etag") } });
  assert.equal(again.status, 304);
  const font = await request("/fonts/IBMPlexSans-Regular.woff2");
  assert.equal(font.status, 200);
  assert.match(font.headers.get("cache-control"), /immutable/);
  assert.equal((await request("/money.js")).status, 200);
  for (const route of ["/../package.json", "/fonts/../../server.js", "/.gitignore", "/%2e%2e/package.json", "/lib/store.js", "/fonts"]) {
    assert.equal((await request(route)).status, 404, route);
  }
  const page = await request("/");
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.doesNotMatch(page.headers.get("content-security-policy"), /unsafe-inline/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
}));

test("errors keep their meaning: unknown company is 404, bad input is 400, malformed JSON is 400", () => withServer({}, async ({ request }) => {
  const missing = await request("/api/companies/no-such-company/meta");
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /not on this machine/);
  const invalid = await request("/api/companies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: 5 }) });
  assert.equal(invalid.status, 400);
  const malformed = await request("/api/companies", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /valid JSON/);
  const health = await (await request("/api/health")).json();
  assert.equal(health.name, "Ledgercraft");
  assert.match(health.version, /^\d+\.\d+\.\d+/);
  assert.equal(typeof health.resources.hsnDirectory, "boolean");
}));

test("a session token gates the API and is granted once through the start link", () => withServer({ token: "a".repeat(48) }, async ({ request, port }) => {
  const token = "a".repeat(48);
  const locked = await request("/");
  assert.equal(locked.status, 403);
  assert.match(await locked.text(), /start link/);
  assert.equal((await request("/api/companies")).status, 401);
  assert.equal((await request("/api/health")).status, 200);
  assert.equal((await request("/ledgercraft.css")).status, 200);
  assert.equal((await request("/?token=wrong")).status, 403);
  const granted = await request(`/?token=${token}`);
  assert.equal(granted.status, 200);
  assert.match(granted.headers.get("content-type"), /text\/html/);
  assert.match(await granted.text(), /<div id="root">/);
  const cookie = granted.headers.get("set-cookie");
  assert.match(cookie, /^ledgercraft_session=a{48}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  assert.equal((await request("/", { headers: { cookie: `ledgercraft_session=${token}` } })).status, 200);
  assert.equal((await request("/api/companies", { headers: { cookie: `ledgercraft_session=${token}` } })).status, 200);
  assert.equal((await request("/api/companies", { headers: { cookie: "ledgercraft_session=" + "b".repeat(48) } })).status, 401);
  assert.equal((await request("/api/companies", { headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal(port > 0, true);
}));

test("the workstation token is created once and reused", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ledgercraft-token-"));
  try {
    const first = await workstationToken(home);
    assert.match(first, /^[a-f0-9]{48}$/);
    assert.equal(await workstationToken(home), first);
    assert.equal(await workstationToken(home, "given"), "given");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("sessionGate passes everything while no users exist and answers 401 or 403 once they do", () => {
  const sent = [];
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead(status) { sent.push(status); }, end(body) { sent.push(JSON.parse(body)); } };
  const request = (method, route, cookie) => ({ method, headers: cookie ? { cookie } : {}, route });
  const parts = (route) => route.split("/").filter(Boolean);
  const none = { hasUsers: () => false };
  const noUsers = { parts: parts("/api/companies"), users: none };
  assert.equal(sessionGate(request("POST", "/api/companies"), res, noUsers), false);
  assert.equal(noUsers.actor, null);
  const viewer = { id: "u-v", name: "Vani", role: "viewer" };
  const users = { hasUsers: () => true, session: (value) => (value === "good" ? { user: viewer, sessionId: "s", expiresAt: "" } : null), renew: () => ({ cookie: "ledgercraft_user=renewed" }) };
  assert.equal(sessionGate(request("GET", "/api/health"), res, { parts: parts("/api/health"), users }), false);
  assert.equal(sessionGate(request("POST", "/api/session"), res, { parts: parts("/api/session"), users }), false);
  assert.equal(sessionGate(request("GET", "/ledgercraft.css"), res, { parts: parts("/ledgercraft.css"), users }), false);
  assert.equal(sessionGate(request("GET", "/api/companies"), res, { parts: parts("/api/companies"), users }), true);
  assert.deepEqual(sent.splice(0), [401, { error: "Sign in to use these books", signIn: true }]);
  assert.equal(sessionGate(request("PUT", "/api/companies/a/locks", "ledgercraft_user=good"), res, { parts: parts("/api/companies/a/locks"), users }), true);
  assert.deepEqual(sent.splice(0), [403, { error: "Your role can view these books but not change them" }]);
  const reading = { parts: parts("/api/companies/a/audit"), users };
  assert.equal(sessionGate(request("GET", "/api/companies/a/audit", "ledgercraft_user=good"), res, reading), false);
  assert.deepEqual(reading.actor, viewer);
  assert.equal(res.headers["set-cookie"], "ledgercraft_user=renewed");
});
