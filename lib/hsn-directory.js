import { readFile } from "node:fs/promises";

let dataset;
async function directory() {
  if (!dataset) dataset = readFile(new URL("./resources/hsn-sac.json", import.meta.url), "utf8")
    .then(text => {
      const { rows, ...meta } = JSON.parse(text);
      const items = rows.map(([code, description, service]) => ({ code, description, kind: service ? "service" : "goods" }));
      const byCode = new Map(items.map(item => [item.kind + ":" + item.code, item]));
      return { ...meta, items, byCode, descriptions:items.map(item=>item.description.toLocaleLowerCase("en-IN")) };
    }).catch(error => { dataset = undefined; throw error; });
  return dataset;
}

export async function searchHSN(query, { kind = "", selectable = false, offset = 0, limit = 30 } = {}) {
  if (kind && !["goods","service"].includes(kind)) throw new Error("Choose goods or services for the code search");
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Choose a valid directory page");
  const { items, descriptions, source, asOf } = await directory();
  const text = String(query || "").trim().toLocaleLowerCase("en-IN").slice(0,100);
  const exact = [], other = [];
  if (text.length >= 2) {
    const numeric = /^\d+$/.test(text), words = text.split(/\s+/);
    for (let index=0; index<items.length; index++) {
      const item = items[index];
      if ((kind && item.kind !== kind) || (selectable && item.code.length < 4)) continue;
      if (numeric) {
        if (item.code === text) exact.push(item);
        else if (item.code.startsWith(text)) other.push(item);
      } else if (words.every(w=>descriptions[index].includes(w))) other.push(item);
    }
  }
  const matches = exact.concat(other);
  return {items:matches.slice(offset,offset+limit),total:matches.length,offset,limit,source,asOf};
}
export async function directoryEntries() {
  return (await directory()).byCode;
}
