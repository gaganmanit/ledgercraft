import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const dictionaries = ["Bahasa Indonesia", "Bahasa Melayu", "Bengali", "Gujarati", "Hindi",
  "Hinglish", "Kannada", "Malayalam", "Marathi", "Punjabi", "Tamil", "Telugu"];

export async function openWorkstation(home, defaultDataDir, seedFolder) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "workstation.json");
  async function save(settings) {
    const tmp = path.join(home, ".workstation-" + randomUUID());
    try {
      await writeFile(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
      await rename(tmp, file);
    } finally {
      await rm(tmp, { force: true });
    }
  }
  let state;
  try {
    state = JSON.parse(await readFile(file, "utf8"));
    if (!path.isAbsolute(state.dataDirectory)) throw new Error("Workstation data directory must be an absolute path");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = { dataDirectory: path.resolve(defaultDataDir), defaultCompany: null, lastCompany: null,
      country: "India/SAARC", uiLanguageId: 1033, dictionaries, loadLastCompany: true };
    if (seedFolder) {
      const companies = path.join(state.dataDirectory, "companies");
      await mkdir(companies, { recursive: true, mode: 0o700 });
      const name = path.basename(seedFolder);
      const target = path.join(companies, name);
      try { await access(target); }
      catch (err) {
        if (err.code !== "ENOENT") throw err;
        const staging = path.join(companies, "." + randomUUID());
        try {
          await cp(seedFolder, staging, { recursive: true });
          await rename(staging, target);
        } finally { await rm(staging, { recursive: true, force: true }); }
      }
      state.defaultCompany = state.lastCompany = name;
    }
    await save(state);
  }
  let pending = Promise.resolve();
  // workstation.users holds the people who may sign in on a shared Mac (lib/users.js).
  // It never leaves the server through get(): passphrase hashes stay in this file.
  const publicView = () => { const { users, ...rest } = state; return rest; };
  function queue(work) {
    const next = pending.then(work);
    pending = next.catch(() => {});
    return next;
  }
  return {
    get: publicView,
    update(changes) {
      return queue(async () => {
        const { users, ...allowed } = changes || {};
        const updated = { ...state, ...allowed };
        await save(updated);
        state = updated;
        return publicView();
      });
    },
    /** A copy of the saved user list ([] on a workstation saved before users existed). */
    users: () => structuredClone(Array.isArray(state.users) ? state.users : []),
    /**
     * Change the user list in one serialised step: `change` receives a copy of the list
     * and returns {users, result}; the list is saved only when `change` does not throw.
     */
    updateUsers(change) {
      return queue(async () => {
        const { users, result } = await change(structuredClone(Array.isArray(state.users) ? state.users : []));
        const updated = { ...state, users };
        await save(updated);
        state = updated;
        return result;
      });
    }
  };
}
