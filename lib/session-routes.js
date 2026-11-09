// Sign-in and user management for a shared Mac (see lib/users.js).
//   GET    /api/session            -> 200 {user:{id,name,role}, signInRequired:true, expiresAt}
//                                     200 {user:null, signInRequired:false} while no users exist
//                                     401 {error:"Sign in to use these books", signIn:true}
//   POST   /api/session            {name, passphrase} -> 200 {user, expiresAt} + Set-Cookie ledgercraft_user_<port>
//   DELETE /api/session            -> 200 {signedOut:true} + cookie cleared
//   GET    /api/users              -> 200 {users:[{id,name,role,createdAt,disabledAt?}]}
//   POST   /api/users              {name, role, passphrase} -> 201 {user, users, signedIn?}
//   PUT    /api/users/<id>         {name?, role?, passphrase?, disabled?, expected?} -> 200 {user, users}
//   DELETE /api/users/<id>         -> 200 {removed, users}
// /api/users is for the owner only; while no users exist the start-link holder is the owner.
// `port` is the local port the request arrived on (req.socket.localPort); the user cookie
// is named after it, see userCookieName in lib/users.js.
import { appendCookie, USER_COOKIE, USER_MESSAGES, userCookie, userCookieName } from "./users.js";

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try { return decodeURIComponent(rest.join("=")); } catch { return null; }
    }
  }
  return null;
}

/**
 * The user cookie value of a request to the server on `port`, or null. Compatibility for
 * this release only: a browser that signed in before cookies were scoped by port still
 * carries the unscoped USER_COOKIE, so it is accepted when the scoped cookie is absent.
 * Any answer that renews the session then sets the scoped cookie (sessionGate does this
 * on every signed-in API request), so the old name is needed once. Drop the fallback in
 * the release after.
 */
function userCookieValue(req, port) {
  return cookieValue(req, userCookieName(port)) ?? cookieValue(req, USER_COOKIE);
}

/** The signed-in session of a request to the server on `port`, or null. */
export function requestSession(req, users, port) {
  return users.session(userCookieValue(req, port));
}

async function answer(res, send, work) {
  try { return await work(); }
  catch (error) {
    if (error?.status) { send(res, error.status, { error: error.message }); return true; }
    throw error;
  }
}

export async function handleSessionRoute({ req, res, parts, users, readBody, send, actor = null, port }) {
  if (parts[0] !== "api" || !users) return false;

  if (parts[1] === "session" && parts.length === 2) {
    return answer(res, send, async () => {
      if (req.method === "GET") {
        if (!users.hasUsers()) { send(res, 200, { user: null, signInRequired: false }); return true; }
        const current = requestSession(req, users, port);
        if (!current) { send(res, 401, { error: USER_MESSAGES.signIn, signIn: true }); return true; }
        const renewed = users.renew(current);
        appendCookie(res, userCookie(port, renewed.value));
        send(res, 200, { user: current.user, signInRequired: true, expiresAt: renewed.expiresAt });
        return true;
      }
      if (req.method === "POST") {
        const signed = await users.signIn(await readBody(req));
        appendCookie(res, userCookie(port, signed.value));
        send(res, 200, { user: signed.user, expiresAt: signed.expiresAt });
        return true;
      }
      if (req.method === "DELETE") {
        users.signOut(cookieValue(req, userCookieName(port)));
        // Also end a session still carried under the unscoped name (see userCookieValue), so
        // that it cannot sign this browser back in.
        users.signOut(cookieValue(req, USER_COOKIE));
        appendCookie(res, userCookie(port, "", 0));
        send(res, 200, { signedOut: true });
        return true;
      }
      return false;
    });
  }

  if (parts[1] === "users" && parts.length <= 3) {
    return answer(res, send, async () => {
      // The session gate already limits this to owners; check again so the rule holds
      // even if the route is reached another way.
      if (users.hasUsers() && actor?.role !== "owner") { send(res, 403, { error: USER_MESSAGES.ownerUsers }); return true; }
      const id = parts[2] ? decodeURIComponent(parts[2]) : null;
      if (!id && req.method === "GET") { send(res, 200, { users: users.list() }); return true; }
      if (!id && req.method === "POST") {
        const { user, first, session } = await users.create(await readBody(req));
        // The first owner is created by the start-link holder, who is the owner already:
        // sign this browser in so the books stay open.
        if (first && session) appendCookie(res, userCookie(port, session.value));
        send(res, 201, { user, users: users.list(), ...(first ? { signedIn: true } : {}) });
        return true;
      }
      if (id && req.method === "PUT") {
        const { user, session } = await users.update(id, await readBody(req));
        // Changing your own passphrase ends your other sessions but keeps this one.
        if (session && actor?.id === id) appendCookie(res, userCookie(port, session.value));
        send(res, 200, { user, users: users.list() });
        return true;
      }
      if (id && req.method === "DELETE") {
        const { removed } = await users.remove(id);
        if (actor?.id === id) appendCookie(res, userCookie(port, "", 0));
        send(res, 200, { removed, users: users.list() });
        return true;
      }
      return false;
    });
  }
  return false;
}
