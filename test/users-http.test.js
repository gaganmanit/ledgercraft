import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { start } from "../server.js";

const TOKEN = "c".repeat(48);
const COOKIE_SHAPE = /^ledgercraft_user=[A-Za-z0-9._-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/;

async function withServer(run, options = { token: TOKEN }) {
  const home = await mkdtemp(path.join(os.tmpdir(), "ledgercraft-users-http-"));
  const server = await start({ home, ...options });
  const base = `http://127.0.0.1:${server.address().port}`;
  // Every call carries the start-link session cookie, as the Mac app's web view does.
  const call = async (route, { method = "GET", body, user, raw, noToken = false } = {}) => {
    const cookies = [options.token && !noToken ? `ledgercraft_session=${options.token}` : "", user ? `ledgercraft_user=${user}` : ""].filter(Boolean).join("; ");
    const response = await fetch(base + route, { method, redirect: "manual", headers: { "content-type": "application/json", ...(cookies ? { cookie: cookies } : {}) }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    const setCookie = response.headers.getSetCookie().find((value) => value.startsWith("ledgercraft_user="));
    return { status: response.status, body: json, setCookie, user: setCookie ? setCookie.split(";")[0].slice("ledgercraft_user=".length) : null };
  };
  try { await run({ call, home }); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(home, { recursive: true, force: true }); }
}

test("without users the start link alone opens the books and the edit log records user null", () => withServer(async ({ call }) => {
  assert.deepEqual((await call("/api/session")).body, { user: null, signInRequired: false });
  const created = await call("/api/companies", { method: "POST", body: { name: "Solo Traders", booksFrom: "2026-04-01" } });
  assert.equal(created.status, 201);
  assert.equal(created.setCookie, undefined, "no user cookie while no users exist");
  const audit = await call(`/api/companies/${created.body.company.id}/audit`);
  assert.equal(audit.body.entries[0].user, null);
  assert.equal((await call("/api/session", { method: "POST", body: { name: "x", passphrase: "whatever12345" } })).status, 400);
  assert.equal((await call("/api/users")).status, 200, "the start-link holder is the owner");
}));

test("with users every API call needs a signed-in user whose role allows it, and the edit log names the user", () => withServer(async ({ call, home }) => {
  // The start-link holder creates the first owner and is signed in as that owner.
  const first = await call("/api/users", { method: "POST", body: { name: "Meera Owner", role: "owner", passphrase: "owner passphrase" } });
  assert.equal(first.status, 201);
  assert.equal(first.body.signedIn, true);
  assert.match(first.setCookie, COOKIE_SHAPE);
  const owner = first.user;

  // Signed out: 401 with signIn, except health and session.
  const refused = await call("/api/companies");
  assert.equal(refused.status, 401);
  assert.deepEqual(refused.body, { error: "Sign in to use these books", signIn: true });
  assert.equal((await call("/api/health")).status, 200);
  assert.equal((await call("/api/session")).status, 401);
  assert.equal((await call("/ledgercraft.css")).status, 200, "static files still load so the sign-in screen can show");
  assert.equal((await call("/api/companies", { user: "u-1.x.1.0.bad" })).status, 401);

  assert.equal((await call("/api/users", { method: "POST", user: owner, body: { name: "Ravi Accounts", role: "accountant", passphrase: "short" } })).body.error, "A passphrase needs at least 10 characters");
  assert.equal((await call("/api/users", { method: "POST", user: owner, body: { name: "Ravi Accounts", role: "accountant", passphrase: "accountant passphrase" } })).status, 201);
  const viewerCreated = await call("/api/users", { method: "POST", user: owner, body: { name: "Vani Viewer", role: "viewer", passphrase: "viewer passphrase" } });
  assert.equal(viewerCreated.status, 201);
  assert.equal(viewerCreated.body.signedIn, undefined);
  assert.deepEqual(viewerCreated.body.users.map((user) => user.role), ["owner", "accountant", "viewer"]);
  assert.equal(JSON.stringify(viewerCreated.body).includes("passphraseHash"), false);

  assert.equal((await call("/api/session", { method: "POST", body: { name: "Ravi Accounts", passphrase: "wrong passphrase" } })).status, 401);
  const signIn = async (name, passphrase) => {
    const response = await call("/api/session", { method: "POST", body: { name, passphrase } });
    assert.equal(response.status, 200);
    assert.match(response.setCookie, COOKIE_SHAPE);
    return response;
  };
  const accountantSession = await signIn("Ravi Accounts", "accountant passphrase");
  assert.equal(accountantSession.body.user.role, "accountant");
  assert.ok(Date.parse(accountantSession.body.expiresAt) > Date.now() + 11 * 3600_000);
  const accountant = accountantSession.user;
  const viewer = (await signIn("vani viewer", "viewer passphrase")).user;
  const me = await call("/api/session", { user: viewer });
  assert.deepEqual(me.body.user, { id: me.body.user.id, name: "Vani Viewer", role: "viewer" });
  assert.match(me.setCookie, COOKIE_SHAPE, "every signed-in request renews the 12-hour cookie");

  // Company creation: owner only.
  const created = await call("/api/companies", { method: "POST", user: owner, body: { name: "Shared Mills", booksFrom: "2026-04-01" } });
  assert.equal(created.status, 201);
  const id = created.body.company.id;
  for (const [who, cookie] of [["accountant", accountant], ["viewer", viewer]]) {
    assert.equal((await call("/api/companies", { method: "POST", user: cookie, body: { name: "Other", booksFrom: "2026-04-01" } })).status, 403, who);
    assert.equal((await call("/api/import", { method: "POST", user: cookie, body: {} })).status, 403, who);
  }
  assert.equal((await call("/api/companies", { method: "POST", user: accountant, body: { name: "Other", booksFrom: "2026-04-01" } })).body.error, "Only the owner can create or import companies");

  // Reading: every role.
  for (const cookie of [owner, accountant, viewer]) assert.equal((await call(`/api/companies/${id}/reports/daybook`, { user: cookie })).status, 200);

  // Writing vouchers and masters: owner and accountant, not viewer.
  const ledger = await call(`/api/companies/${id}/ledgers`, { method: "POST", user: accountant, body: { name: "Sales", groupId: "g-sales", openingPaise: 0, openingDc: "Cr" } });
  assert.equal(ledger.status, 201);
  const salesId = ledger.body.ledger.id;
  const entry = (number) => ({ type: "Receipt", date: "2026-04-04", number, narration: "Counter", lines: [{ ledgerId: "l-cash", dc: "Dr", paise: 10000 }, { ledgerId: salesId, dc: "Cr", paise: 10000 }] });
  assert.equal((await call(`/api/companies/${id}/vouchers`, { method: "POST", user: owner, body: entry("RCT-1") })).status, 201);
  assert.equal((await call(`/api/companies/${id}/vouchers`, { method: "POST", user: accountant, body: entry("RCT-2") })).status, 201);
  const viewerWrite = await call(`/api/companies/${id}/vouchers`, { method: "POST", user: viewer, body: entry("RCT-3") });
  assert.equal(viewerWrite.status, 403);
  assert.equal(viewerWrite.body.error, "Your role can view these books but not change them");

  // Period locks and numbering: owner only.
  const lock = { books: { to: "2026-04-01", reason: "Opening day" } };
  assert.equal((await call(`/api/companies/${id}/locks`, { method: "PUT", user: accountant, body: lock })).body.error, "Only the owner can change period locks");
  assert.equal((await call(`/api/companies/${id}/locks`, { method: "PUT", user: viewer, body: lock })).status, 403);
  assert.equal((await call(`/api/companies/${id}/locks`, { method: "PUT", user: owner, body: lock })).status, 200);
  assert.equal((await call(`/api/companies/${id}/locks`, { user: accountant })).status, 200, "accountants may read the locks");
  const numbering = { numbering: { Receipt: { prefix: "R/", suffix: "", width: 3, restartEachFY: false } } };
  assert.equal((await call(`/api/companies/${id}/numbering`, { method: "PUT", user: accountant, body: numbering })).body.error, "Only the owner can change voucher numbering");
  assert.equal((await call(`/api/companies/${id}/numbering`, { method: "PUT", user: viewer, body: numbering })).status, 403);
  assert.equal((await call(`/api/companies/${id}/numbering`, { method: "PUT", user: owner, body: numbering })).status, 200);

  // Users: owner only.
  assert.equal((await call("/api/users", { user: accountant })).body.error, "Only the owner can manage users");
  assert.equal((await call("/api/users", { user: viewer })).status, 403);
  const listed = await call("/api/users", { user: owner });
  assert.equal(listed.status, 200);
  const [ownerUser, accountantUser, viewerUser] = listed.body.users;
  assert.equal((await call(`/api/users/${ownerUser.id}`, { method: "PUT", user: owner, body: { role: "accountant" } })).body.error, "Keep at least one owner: the last owner cannot be removed, disabled or given another role");
  assert.equal((await call(`/api/users/${ownerUser.id}`, { method: "DELETE", user: owner })).status, 400);
  assert.equal((await call("/api/users/u-nobody", { method: "PUT", user: owner, body: { name: "Nobody" } })).status, 404);

  // The edit log names who made each change; the audit filter finds a user's entries.
  const audit = await call(`/api/companies/${id}/audit`, { user: viewer });
  const byAction = audit.body.entries.map((row) => [`${row.action}:${row.entity}`, row.user?.name ?? null]);
  assert.deepEqual(byAction, [
    ["alter:numbering", "Meera Owner"], ["lock:lock", "Meera Owner"], ["create:voucher", "Ravi Accounts"],
    ["create:voucher", "Meera Owner"], ["create:ledger", "Ravi Accounts"], ["create:company", "Meera Owner"],
  ]);
  assert.deepEqual(audit.body.entries[2].user, { id: accountantUser.id, name: "Ravi Accounts" });
  assert.equal(audit.body.verified, true);
  const mine = await call(`/api/companies/${id}/audit?user=${accountantUser.id}`, { user: owner });
  assert.deepEqual(mine.body.entries.map((row) => row.entity), ["voucher", "ledger"]);

  // A role change applies at once; a passphrase reset ends that user's sessions.
  await call(`/api/users/${viewerUser.id}`, { method: "PUT", user: owner, body: { role: "accountant" } });
  assert.equal((await call(`/api/companies/${id}/vouchers`, { method: "POST", user: viewer, body: entry("RCT-3") })).status, 201);
  await call(`/api/users/${accountantUser.id}`, { method: "PUT", user: owner, body: { passphrase: "reset by the owner" } });
  assert.equal((await call("/api/companies", { user: accountant })).status, 401);

  // Signing out ends the session.
  const out = await call("/api/session", { method: "DELETE", user: viewer });
  assert.deepEqual(out.body, { signedOut: true });
  assert.match(out.setCookie, /^ledgercraft_user=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0$/);
  assert.equal((await call("/api/companies", { user: viewer })).status, 401);

  // The workstation settings never expose the users or their hashes.
  const settings = await call("/api/workstation", { user: owner });
  assert.equal(settings.body.users, undefined);
  assert.equal(JSON.parse(await readFile(path.join(home, "workstation.json"), "utf8")).users.length, 3);
}));

test("the start-link token is still required alongside the user cookie", () => withServer(async ({ call }) => {
  const first = await call("/api/users", { method: "POST", body: { name: "Owner", role: "owner", passphrase: "owner passphrase" } });
  assert.equal((await call("/api/companies", { user: first.user })).status, 200);
  const withoutToken = await call("/api/companies", { user: first.user, noToken: true });
  assert.equal(withoutToken.status, 401);
  assert.equal(withoutToken.body.error, "Open Ledgercraft from the start link shown when it started.");
}));

test("without a start-link token (development) the user gate still applies", () => withServer(async ({ call }) => {
  const first = await call("/api/users", { method: "POST", body: { name: "Owner", role: "owner", passphrase: "owner passphrase" } });
  assert.equal(first.status, 201);
  assert.equal((await call("/api/companies")).status, 401);
  assert.equal((await call("/api/companies", { user: first.user })).status, 200);
}, { token: null }));
