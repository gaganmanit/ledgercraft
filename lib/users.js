// Users and roles for a Mac shared by several people.
//
// workstation.json keeps `users`: [{id, name, role, passphraseHash, createdAt,
// disabledAt?, sessionEpoch?}]. While the list is empty Ledgercraft behaves as a
// single-user app: whoever holds the start-link token is the owner. Once one user exists,
// every /api/ request (except /api/health and /api/session) also needs a signed-in user,
// carried in the HttpOnly cookie USER_COOKIE.
//
// Passphrases are hashed with scrypt (node:crypto, N=16384, r=8, p=1, 16-byte per-user
// salt, 32-byte key) and compared with timingSafeEqual. The session cookie is
// "<userId>.<sessionId>.<expiresAtMs>.<epoch>.<hmac>", where the HMAC-SHA256 key is the
// workstation token. It lasts 12 hours and slides: every signed-in API request renews it.
// A session ends when the user signs out (its id is revoked in memory), when the user is
// disabled or removed, or when the passphrase is reset (sessionEpoch moves on). The role
// is read from the saved user on every request, so a role change applies at once.
import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const USER_COOKIE = "ledgercraft_user";
export const SESSION_SECONDS = 12 * 60 * 60;
export const ROLES = ["owner", "accountant", "viewer"];
export const PASSPHRASE_MIN = 10;
const PASSPHRASE_MAX = 512;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, saltBytes: 16 };
const MAX_FAILURES = 5;
const THROTTLE_MS = 30_000;

export const USER_MESSAGES = {
  signIn: "Sign in to use these books",
  badSignIn: "That name and passphrase do not match",
  throttled: "Too many sign-in attempts. Wait half a minute and try again",
  noUsers: "No users are set up on this Mac. The start link opens the books",
  viewer: "Your role can view these books but not change them",
  ownerUsers: "Only the owner can manage users",
  ownerLocks: "Only the owner can change period locks",
  ownerNumbering: "Only the owner can change voucher numbering",
  ownerCompanies: "Only the owner can create or import companies",
  lastOwner: "Keep at least one owner: the last owner cannot be removed, disabled or given another role",
  firstOwner: "The first user must be an owner",
  shortPassphrase: `A passphrase needs at least ${PASSPHRASE_MIN} characters`,
  longPassphrase: `A passphrase can have at most ${PASSPHRASE_MAX} characters`,
  role: "Choose a role: owner, accountant or viewer",
  name: "Use a name between 2 and 40 characters",
  duplicate: "A user with that name already exists",
  missing: "That user does not exist",
  changed: "This user changed while you were editing. Reopen the list to review the latest version",
};

/** An error that carries the HTTP status the route should answer with. */
export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const scryptAsync = (passphrase, salt, { N, r, p, keylen }) => new Promise((resolve, reject) => {
  scrypt(passphrase, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
});

function checkedPassphrase(value) {
  if (typeof value !== "string" || [...value].length < PASSPHRASE_MIN) throw new UserError(USER_MESSAGES.shortPassphrase);
  if ([...value].length > PASSPHRASE_MAX) throw new UserError(USER_MESSAGES.longPassphrase);
  return value;
}

/** "scrypt$N$r$p$<salt base64url>$<key base64url>" for a passphrase, with a fresh salt. */
export async function hashPassphrase(passphrase, salt = randomBytes(SCRYPT.saltBytes)) {
  const key = await scryptAsync(String(passphrase).normalize("NFC"), salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** True when the passphrase matches a stored hash. Compared in constant time. */
export async function verifyPassphrase(passphrase, stored) {
  const parts = typeof stored === "string" ? stored.split("$") : [];
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isSafeInteger) || N < 2 || N > 1 << 20 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (!salt.length || !expected.length || expected.length > 128) return false;
  const actual = await scryptAsync(String(passphrase ?? "").normalize("NFC"), salt, { N, r, p, keylen: expected.length });
  return timingSafeEqual(actual, expected);
}

export function publicUser(user) {
  return { id: user.id, name: user.name, role: user.role, createdAt: user.createdAt, ...(user.disabledAt ? { disabledAt: user.disabledAt } : {}) };
}

function cleanName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 40) throw new UserError(USER_MESSAGES.name);
  return name;
}

function checkedRole(value) {
  if (!ROLES.includes(value)) throw new UserError(USER_MESSAGES.role);
  return value;
}

const activeOwners = (users) => users.filter((user) => user.role === "owner" && !user.disabledAt).length;

/** Set-Cookie value for the user session; maxAge 0 clears it. */
export function userCookie(value, maxAge = SESSION_SECONDS) {
  return `${USER_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

/**
 * Why a signed-in role may not make this request, or null when it may.
 * `parts` is the request path split on "/" without empty pieces (as the server routes it).
 *   viewer:     GET/HEAD only.
 *   accountant: everything except changing period locks or numbering, managing users,
 *               and creating or importing companies.
 *   owner:      everything.
 */
export function roleRefusal(role, method, parts) {
  const write = method !== "GET" && method !== "HEAD";
  if (parts[0] !== "api") return null;
  if (parts[1] === "users") return role === "owner" ? null : USER_MESSAGES.ownerUsers;
  if (role === "owner") return null;
  if (!write) return ROLES.includes(role) ? null : USER_MESSAGES.signIn;
  if (role === "viewer") return USER_MESSAGES.viewer;
  if (role !== "accountant") return USER_MESSAGES.signIn;
  if (parts[1] === "companies" && parts.length === 4 && parts[3] === "locks") return USER_MESSAGES.ownerLocks;
  if (parts[1] === "companies" && parts.length === 4 && parts[3] === "numbering") return USER_MESSAGES.ownerNumbering;
  if (method === "POST" && parts.length === 2 && ["companies", "specimen", "import"].includes(parts[1])) return USER_MESSAGES.ownerCompanies;
  if (method === "POST" && parts.length === 3 && parts[1] === "tally" && parts[2] === "commit") return USER_MESSAGES.ownerCompanies;
  return null;
}

/**
 * The users of one workstation. `station` is the object from openWorkstation; `key` is
 * the workstation token (a random per-process key when the server runs without one);
 * `now` returns milliseconds and exists for tests.
 */
export function createUserDirectory(station, { key, now = () => Date.now() } = {}) {
  const secret = key ? Buffer.from(String(key)) : randomBytes(32);
  const revoked = new Map();
  const failures = new Map();
  let decoy;

  const sign = (payload) => createHmac("sha256", secret).update(`ledgercraft-user-session-v1\n${payload}`).digest("base64url");
  const all = () => station.users();
  const hasUsers = () => all().length > 0;

  function issue(user, sessionId = randomBytes(16).toString("hex")) {
    const expiresAt = now() + SESSION_SECONDS * 1000;
    const payload = `${user.id}.${sessionId}.${expiresAt}.${user.sessionEpoch ?? 0}`;
    const value = `${payload}.${sign(payload)}`;
    return { value, cookie: userCookie(value), expiresAt: new Date(expiresAt).toISOString(), sessionId };
  }

  /** The signed-in session for a cookie value, or null. */
  function session(value) {
    if (typeof value !== "string" || !value || value.length > 400) return null;
    const parts = value.split(".");
    if (parts.length !== 5) return null;
    const [userId, sessionId, expires, epoch, mac] = parts;
    const expected = Buffer.from(sign(parts.slice(0, 4).join(".")));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const expiresAt = Number(expires);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now() || revoked.has(sessionId)) return null;
    const user = all().find((item) => item.id === userId);
    if (!user || user.disabledAt || String(user.sessionEpoch ?? 0) !== epoch) return null;
    return { user: { id: user.id, name: user.name, role: user.role }, sessionId, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** A renewed cookie for a live session: the 12 hours start again from now. */
  function renew(current) {
    const user = all().find((item) => item.id === current.user.id);
    return issue(user, current.sessionId);
  }

  function signOut(value) {
    const current = session(value);
    const stamp = now();
    for (const [id, until] of revoked) if (until <= stamp) revoked.delete(id);
    if (current) revoked.set(current.sessionId, Date.parse(current.expiresAt));
    return Boolean(current);
  }

  async function signIn(input) {
    if (!hasUsers()) throw new UserError(USER_MESSAGES.noUsers, 400);
    const name = String(input?.name ?? "").trim().replace(/\s+/g, " ");
    const passphrase = typeof input?.passphrase === "string" ? input.passphrase : "";
    const slot = name.toLowerCase();
    const record = failures.get(slot);
    if (record && record.until > now()) throw new UserError(USER_MESSAGES.throttled, 429);
    const user = all().find((item) => item.name.toLowerCase() === slot && !item.disabledAt);
    // An unknown name still costs one scrypt run, so timing does not reveal who exists.
    decoy ??= await hashPassphrase(randomBytes(16).toString("hex"));
    const matched = passphrase.length <= PASSPHRASE_MAX && await verifyPassphrase(passphrase, user?.passphraseHash ?? decoy) && Boolean(user);
    if (!matched) {
      const count = (record?.count ?? 0) + 1;
      failures.set(slot, count >= MAX_FAILURES ? { count: 0, until: now() + THROTTLE_MS } : { count, until: 0 });
      if (failures.size > 1000) failures.delete(failures.keys().next().value);
      throw new UserError(USER_MESSAGES.badSignIn, 401);
    }
    failures.delete(slot);
    return { user: { id: user.id, name: user.name, role: user.role }, ...issue(user) };
  }

  function find(users, id) {
    const user = users.find((item) => item.id === id);
    if (!user) throw new UserError(USER_MESSAGES.missing, 404);
    return user;
  }

  async function create(input) {
    const name = cleanName(input?.name);
    const role = checkedRole(input?.role);
    const passphraseHash = await hashPassphrase(checkedPassphrase(input?.passphrase));
    return station.updateUsers((users) => {
      if (!users.length && role !== "owner") throw new UserError(USER_MESSAGES.firstOwner);
      if (users.some((item) => item.name.toLowerCase() === name.toLowerCase())) throw new UserError(USER_MESSAGES.duplicate);
      const user = { id: `u-${randomBytes(4).toString("hex")}`, name, role, passphraseHash, createdAt: new Date(now()).toISOString(), sessionEpoch: 0 };
      const first = users.length === 0;
      users.push(user);
      return { users, result: { user: publicUser(user), first, session: first ? issue(user) : null } };
    });
  }

  async function update(id, input = {}) {
    const passphraseHash = input.passphrase !== undefined ? await hashPassphrase(checkedPassphrase(input.passphrase)) : null;
    const name = input.name !== undefined ? cleanName(input.name) : null;
    const role = input.role !== undefined ? checkedRole(input.role) : null;
    if (input.disabled !== undefined && typeof input.disabled !== "boolean") throw new UserError("Disabled is yes or no");
    return station.updateUsers((users) => {
      const user = find(users, id);
      if (input.expected !== undefined) {
        const expected = input.expected || {};
        if (expected.name !== user.name || expected.role !== user.role || (expected.disabledAt ?? null) !== (user.disabledAt ?? null)) throw new UserError(USER_MESSAGES.changed, 409);
      }
      if (name && users.some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) throw new UserError(USER_MESSAGES.duplicate);
      if (name) user.name = name;
      if (role) user.role = role;
      if (input.disabled === true && !user.disabledAt) { user.disabledAt = new Date(now()).toISOString(); user.sessionEpoch = (user.sessionEpoch ?? 0) + 1; }
      if (input.disabled === false) delete user.disabledAt;
      if (passphraseHash) { user.passphraseHash = passphraseHash; user.sessionEpoch = (user.sessionEpoch ?? 0) + 1; }
      if (!activeOwners(users)) throw new UserError(USER_MESSAGES.lastOwner);
      return { users, result: { user: publicUser(user), passphraseChanged: Boolean(passphraseHash), session: passphraseHash && !user.disabledAt ? issue(user) : null } };
    });
  }

  async function remove(id) {
    return station.updateUsers((users) => {
      const user = find(users, id);
      const rest = users.filter((item) => item.id !== id);
      if (!activeOwners(rest)) throw new UserError(USER_MESSAGES.lastOwner);
      return { users: rest, result: { removed: publicUser(user) } };
    });
  }

  return {
    hasUsers,
    list: () => all().map(publicUser),
    session, renew, signIn, signOut, create, update, remove,
  };
}
