import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { SESSION_COOKIE, sessionCookieName, sessionGate, start, workstationToken } from "../server.js";
import { USER_COOKIE, userCookieName } from "../lib/users.js";

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
  assert.equal(sessionCookieName(port), `ledgercraft_session_${port}`);
  assert.match(cookie, new RegExp(`^ledgercraft_session_${port}=a{48}; Path=/; HttpOnly; SameSite=Strict; Max-Age=\\d+$`));
  assert.equal((await request("/", { headers: { cookie: `ledgercraft_session_${port}=${token}` } })).status, 200);
  assert.equal((await request("/api/companies", { headers: { cookie: `ledgercraft_session_${port}=${token}` } })).status, 200);
  assert.equal((await request("/api/companies", { headers: { cookie: `ledgercraft_session_${port}=` + "b".repeat(48) } })).status, 401);
  assert.equal((await request("/api/companies", { headers: { cookie: `ledgercraft_session_${port + 1}=${token}` } })).status, 401, "another port's cookie opens nothing");
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
  const res = { headers: {}, getHeader(name) { return this.headers[name]; }, setHeader(name, value) { this.headers[name] = value; }, writeHead(status) { sent.push(status); }, end(body) { sent.push(JSON.parse(body)); } };
  const request = (method, route, cookie) => ({ method, headers: cookie ? { cookie } : {}, route });
  const parts = (route) => route.split("/").filter(Boolean);
  const none = { hasUsers: () => false };
  const noUsers = { parts: parts("/api/companies"), users: none };
  assert.equal(sessionGate(request("POST", "/api/companies"), res, noUsers), false);
  assert.equal(noUsers.actor, null);
  const viewer = { id: "u-v", name: "Vani", role: "viewer" };
  const users = { hasUsers: () => true, session: (value) => (value === "good" ? { user: viewer, sessionId: "s", expiresAt: "" } : null), renew: () => ({ value: "renewed" }) };
  assert.equal(sessionGate(request("GET", "/api/health"), res, { parts: parts("/api/health"), users }), false);
  assert.equal(sessionGate(request("POST", "/api/session"), res, { parts: parts("/api/session"), users }), false);
  assert.equal(sessionGate(request("GET", "/ledgercraft.css"), res, { parts: parts("/ledgercraft.css"), users }), false);
  assert.equal(sessionGate(request("GET", "/api/companies"), res, { parts: parts("/api/companies"), users }), true);
  assert.deepEqual(sent.splice(0), [401, { error: "Sign in to use these books", signIn: true }]);
  assert.equal(sessionGate(request("PUT", "/api/companies/a/locks", "ledgercraft_user_4502=good"), res, { parts: parts("/api/companies/a/locks"), users, port: 4502 }), true);
  assert.deepEqual(sent.splice(0), [403, { error: "Your role can view these books but not change them" }]);
  assert.equal(sessionGate(request("GET", "/api/companies/a/audit", "ledgercraft_user_4503=good"), res, { parts: parts("/api/companies/a/audit"), users, port: 4502 }), true, "another port's user cookie signs in nothing");
  assert.deepEqual(sent.splice(0), [401, { error: "Sign in to use these books", signIn: true }]);
  const reading = { parts: parts("/api/companies/a/audit"), users, port: 4502 };
  assert.equal(sessionGate(request("GET", "/api/companies/a/audit", "ledgercraft_user_4502=good"), res, reading), false);
  assert.deepEqual(reading.actor, viewer);
  assert.match(res.headers["set-cookie"], /^ledgercraft_user_4502=renewed; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
});

// Browsers scope cookies by host, not port: a browser holding the cookies of two servers on
// 127.0.0.1 sends all of them to both. Each server must read only its own.
test("two servers on two ports keep a browser signed in to both", async () => {
  const servers = [];
  try {
    for (const token of ["d".repeat(48), "e".repeat(48)]) {
      const home = await mkdtemp(path.join(os.tmpdir(), "ledgercraft-two-ports-"));
      const server = await start({ home, token });
      servers.push({ server, home, token, port: server.address().port });
    }
    const [a, b] = servers;
    assert.notEqual(a.port, b.port);
    const jar = new Map();
    const call = async ({ port }, route, body) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
      const headers = { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) };
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { redirect: "manual", method: body ? "POST" : "GET", headers, body: body && JSON.stringify(body) });
      for (const set of response.headers.getSetCookie()) {
        const [pair] = set.split(";");
        const at = pair.indexOf("=");
        jar.set(pair.slice(0, at), pair.slice(at + 1));
      }
      await response.arrayBuffer();
      return response.status;
    };
    assert.equal(await call(a, `/?token=${a.token}`), 200);
    assert.equal(await call(b, `/?token=${b.token}`), 200);
    assert.deepEqual([...jar.keys()].sort(), [sessionCookieName(a.port), sessionCookieName(b.port)].sort());
    // The start-link holder sets up the first owner on each server and is signed in as that owner.
    assert.equal(await call(a, "/api/users", { name: "Owner A", role: "owner", passphrase: "owner passphrase a" }), 201);
    assert.equal(await call(b, "/api/users", { name: "Owner B", role: "owner", passphrase: "owner passphrase b" }), 201);
    assert.deepEqual([...jar.keys()].sort(), [sessionCookieName(a.port), sessionCookieName(b.port), userCookieName(a.port), userCookieName(b.port)].sort());
    for (let round = 0; round < 2; round += 1) {
      assert.equal(await call(a, "/api/companies"), 200, `first server, round ${round}`);
      assert.equal(await call(b, "/api/companies"), 200, `second server, round ${round}`);
      assert.equal(await call(a, "/"), 200);
      assert.equal(await call(b, "/"), 200);
    }
    assert.equal(jar.get(sessionCookieName(a.port)), a.token);
    assert.equal(jar.get(sessionCookieName(b.port)), b.token);
  } finally {
    for (const { server, home } of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("a browser still holding the unscoped cookies from before is accepted once and given the scoped ones", () => withServer({ token: "f".repeat(48) }, async ({ request, port }) => {
  const token = "f".repeat(48);
  assert.equal(SESSION_COOKIE, "ledgercraft_session");
  assert.equal(USER_COOKIE, "ledgercraft_user");
  assert.equal(userCookieName(port), `ledgercraft_user_${port}`);
  const old = await request("/api/companies", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert.equal(old.status, 200);
  assert.match(old.headers.get("set-cookie"), new RegExp(`^ledgercraft_session_${port}=f{48}; Path=/; HttpOnly; SameSite=Strict; Max-Age=\\d+$`));
  const scoped = await request("/api/companies", { headers: { cookie: `${SESSION_COOKIE}=${token}; ${sessionCookieName(port)}=${token}` } });
  assert.equal(scoped.status, 200);
  assert.equal(scoped.headers.get("set-cookie"), null, "nothing to migrate once the scoped cookie is there");
  assert.equal((await request("/api/companies", { headers: { cookie: `${SESSION_COOKIE}=` + "b".repeat(48) } })).status, 401, "another server's unscoped cookie opens nothing");
  assert.equal((await request("/api/companies", { headers: { cookie: `${SESSION_COOKIE}=${token}; ${sessionCookieName(port)}=` + "b".repeat(48) } })).status, 401, "the unscoped cookie is a fallback only when the scoped one is absent");
}));
