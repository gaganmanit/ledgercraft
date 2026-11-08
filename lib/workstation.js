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
  return {
    get: () => ({ ...state }),
    update(changes) {
      const next = pending.then(async () => {
        const updated = { ...state, ...changes };
        await save(updated);
        state = updated;
        return { ...state };
      });
      pending = next.catch(() => {});
      return next;
    }
  };
}
