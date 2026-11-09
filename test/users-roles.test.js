import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openWorkstation } from "../lib/workstation.js";
import { createUserDirectory, hashPassphrase, roleRefusal, SESSION_SECONDS, USER_MESSAGES, userCookie, verifyPassphrase } from "../lib/users.js";

async function withDirectory(run, options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "ledgercraft-users-"));
  try {
    const station = await openWorkstation(home, path.join(home, "data"));
    let clock = Date.parse("2026-11-09T09:00:00Z");
    const users = createUserDirectory(station, { key: "k".repeat(48), now: () => clock, ...options });
    await run({ users, station, home, tick: (ms) => { clock += ms; } });
  } finally { await rm(home, { recursive: true, force: true }); }
}

const split = (route) => route.split("/").filter(Boolean);

test("passphrases are scrypt hashes with a per-user salt and verify only the same passphrase", async () => {
  const first = await hashPassphrase("correct horse battery");
  const second = await hashPassphrase("correct horse battery");
  assert.match(first, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second, "each hash has its own salt");
  assert.equal(await verifyPassphrase("correct horse battery", first), true);
  assert.equal(await verifyPassphrase("correct horse batterY", first), false);
  assert.equal(await verifyPassphrase("", first), false);
  assert.equal(await verifyPassphrase("correct horse battery", "plain text"), false);
  assert.equal(await verifyPassphrase("correct horse battery", first.replace("$16384$", "$12345$")), false);
});

test("role matrix: viewers read only, accountants cannot touch locks, numbering, users or company creation", () => {
  const cases = [
    ["GET", "/api/companies/a-1/reports/daybook", [null, null, null]],
    ["POST", "/api/companies/a-1/vouchers", [null, null, USER_MESSAGES.viewer]],
    ["PUT", "/api/companies/a-1/locks", [null, USER_MESSAGES.ownerLocks, USER_MESSAGES.viewer]],
    ["GET", "/api/companies/a-1/locks", [null, null, null]],
    ["PUT", "/api/companies/a-1/numbering", [null, USER_MESSAGES.ownerNumbering, USER_MESSAGES.viewer]],
    ["GET", "/api/users", [null, USER_MESSAGES.ownerUsers, USER_MESSAGES.ownerUsers]],
    ["POST", "/api/users", [null, USER_MESSAGES.ownerUsers, USER_MESSAGES.ownerUsers]],
    ["POST", "/api/companies", [null, USER_MESSAGES.ownerCompanies, USER_MESSAGES.viewer]],
    ["POST", "/api/specimen", [null, USER_MESSAGES.ownerCompanies, USER_MESSAGES.viewer]],
    ["POST", "/api/import", [null, USER_MESSAGES.ownerCompanies, USER_MESSAGES.viewer]],
    ["POST", "/api/tally/commit", [null, USER_MESSAGES.ownerCompanies, USER_MESSAGES.viewer]],
    ["DELETE", "/api/companies/a-1/vouchers/v-1", [null, null, USER_MESSAGES.viewer]],
  ];
  for (const [method, route, expected] of cases) {
    assert.deepEqual(["owner", "accountant", "viewer"].map((role) => roleRefusal(role, method, split(route))), expected, `${method} ${route}`);
  }
  assert.equal(roleRefusal("intruder", "GET", split("/api/companies")), USER_MESSAGES.signIn);
});

test("the first user must be an owner; names are unique and passphrases have at least 10 characters", () => withDirectory(async ({ users, station, home }) => {
  assert.equal(users.hasUsers(), false);
  await assert.rejects(users.create({ name: "Asha", role: "accountant", passphrase: "long enough pass" }), { message: USER_MESSAGES.firstOwner });
  await assert.rejects(users.create({ name: "Asha", role: "owner", passphrase: "short" }), { message: USER_MESSAGES.shortPassphrase });
  await assert.rejects(users.create({ name: "Asha", role: "boss", passphrase: "long enough pass" }), { message: USER_MESSAGES.role });
  const { user, first, session } = await users.create({ name: "Asha", role: "owner", passphrase: "long enough pass" });
  assert.equal(first, true);
  assert.ok(users.session(session.value));
  assert.deepEqual(Object.keys(user).sort(), ["createdAt", "id", "name", "role"]);
  await assert.rejects(users.create({ name: "asha", role: "viewer", passphrase: "another passphrase" }), { message: USER_MESSAGES.duplicate });
  const saved = JSON.parse(await readFile(path.join(home, "workstation.json"), "utf8"));
  assert.equal(saved.users.length, 1);
  assert.match(saved.users[0].passphraseHash, /^scrypt\$16384\$/);
  assert.equal(station.get().users, undefined, "the public workstation view never carries users");
}));

test("the last owner cannot be removed, demoted or disabled; an owner resets another user's passphrase", () => withDirectory(async ({ users }) => {
  const { user: owner } = await users.create({ name: "Owner One", role: "owner", passphrase: "owner passphrase" });
  const { user: clerk } = await users.create({ name: "Clerk", role: "accountant", passphrase: "clerk passphrase" });
  await assert.rejects(users.remove(owner.id), { message: USER_MESSAGES.lastOwner });
  await assert.rejects(users.update(owner.id, { role: "viewer" }), { message: USER_MESSAGES.lastOwner });
  await assert.rejects(users.update(owner.id, { disabled: true }), { message: USER_MESSAGES.lastOwner });
  await assert.rejects(users.update(clerk.id, { passphrase: "too short" }), { message: USER_MESSAGES.shortPassphrase });
  await assert.rejects(users.update("u-missing", { name: "Nobody" }), { status: 404, message: USER_MESSAGES.missing });
  await assert.rejects(users.update(clerk.id, { name: "Renamed", expected: { name: "Old", role: "accountant" } }), { status: 409 });

  const before = await users.signIn({ name: "Clerk", passphrase: "clerk passphrase" });
  assert.ok(users.session(before.value));
  await users.update(clerk.id, { passphrase: "a brand new passphrase" });
  assert.equal(users.session(before.value), null, "a reset ends the old sessions");
  await assert.rejects(users.signIn({ name: "Clerk", passphrase: "clerk passphrase" }), { status: 401 });
  assert.equal((await users.signIn({ name: "clerk", passphrase: "a brand new passphrase" })).user.role, "accountant");

  // With a second owner, the first may step down; disabled users cannot sign in.
  await users.update(clerk.id, { role: "owner" });
  assert.equal((await users.update(owner.id, { role: "viewer" })).user.role, "viewer");
  await users.update(owner.id, { disabled: true });
  await assert.rejects(users.signIn({ name: "Owner One", passphrase: "owner passphrase" }), { status: 401 });
  assert.equal((await users.remove(owner.id)).removed.id, owner.id);
  assert.deepEqual(users.list().map((item) => item.name), ["Clerk"]);
}));

test("sessions last 12 hours from the last request, end on sign-out and are tied to the signing key", () => withDirectory(async ({ users, station, tick }) => {
  await users.create({ name: "Owner", role: "owner", passphrase: "owner passphrase" });
  const signed = await users.signIn({ name: "Owner", passphrase: "owner passphrase" });
  assert.equal(userCookie(4502, signed.value), `ledgercraft_user_4502=${signed.value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`);
  assert.equal(SESSION_SECONDS, 43200);
  tick(11 * 3600_000);
  const live = users.session(signed.value);
  assert.equal(live.user.name, "Owner");
  const renewed = users.renew(live);
  tick(2 * 3600_000);
  assert.equal(users.session(signed.value), null, "the original cookie expired 12 hours after sign-in");
  assert.ok(users.session(renewed.value), "the renewed cookie slides on");
  tick(10 * 3600_000 - 1);
  assert.ok(users.session(renewed.value));
  tick(1);
  assert.equal(users.session(renewed.value), null, "12 hours without a request ends the session");

  const again = await users.signIn({ name: "Owner", passphrase: "owner passphrase" });
  const forged = again.value.replace(/\.[^.]+$/, ".AAAA");
  assert.equal(users.session(forged), null);
  const tampered = again.value.replace(/\.(\d+)\./, (match, expires) => `.${Number(expires) + 1}.`);
  assert.equal(users.session(tampered), null);
  const otherKey = createUserDirectory(station, { key: "z".repeat(48), now: () => Date.now() });
  assert.equal(otherKey.session(again.value), null);
  assert.equal(users.signOut(again.value), true);
  assert.equal(users.session(again.value), null);
}));

test("five wrong passphrases pause sign-in for that name", () => withDirectory(async ({ users, tick }) => {
  await users.create({ name: "Owner", role: "owner", passphrase: "owner passphrase" });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(users.signIn({ name: "Owner", passphrase: "wrong passphrase" }), { status: 401, message: USER_MESSAGES.badSignIn });
  }
  await assert.rejects(users.signIn({ name: "Owner", passphrase: "owner passphrase" }), { status: 429, message: USER_MESSAGES.throttled });
  tick(30_001);
  assert.equal((await users.signIn({ name: "Owner", passphrase: "owner passphrase" })).user.name, "Owner");
  await assert.rejects(users.signIn({ name: "Nobody", passphrase: "owner passphrase" }), { status: 401, message: USER_MESSAGES.badSignIn });
}));
