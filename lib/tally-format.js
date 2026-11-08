// Tally exchange parsing is local. Original bytes are archived independently of this tree.
export const recordTypes = new Set(["COMPANY", "GROUP", "LEDGER", "VOUCHERTYPE", "VOUCHER", "STOCKGROUP", "STOCKCATEGORY", "STOCKITEM", "UNIT", "GODOWN", "COSTCENTRE", "COSTCATEGORY", "CURRENCY", "BUDGET", "ATTENDANCETYPE", "EMPLOYEE", "PAYHEAD"]);
const keyNames = new Map();
export const keyName = (value) => {
  const text = String(value), known = keyNames.get(text);
  if (known !== undefined) return known;
  const result = text.toUpperCase().replace(/\.LIST$/, "").replace(/_/g, "");
  // Tags normally repeat. Bound both entry count and key length when a source
  // supplies arbitrary names, without retaining source field values globally.
  if (text.length <= 128) {
    if (keyNames.size >= 512) keyNames.delete(keyNames.keys().next().value);
    keyNames.set(text, result);
  }
  return result;
};

export function decodeBase64(value) {
  if (typeof value !== "string" || value.length % 4 || /[^A-Za-z0-9+/=]/.test(value)) throw new Error("Invalid source file bytes");
  const padding = value.indexOf("=");
  if (padding >= 0 && (padding < value.length - 2 || !/^={1,2}$/.test(value.slice(padding)))) throw new Error("Invalid source file bytes");
  return Buffer.from(value, "base64");
}

export function decodeTally(bytes) {
  let encoding = "utf-8";
  let offset = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = "utf-16le"; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = "utf-16be"; offset = 2; }
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  else if ([0x3c, 0x7b, 0x20, 0x09, 0x0a, 0x0d].includes(bytes[0]) && bytes[1] === 0) encoding = "utf-16le";
  else if (bytes[0] === 0 && [0x3c, 0x7b, 0x20, 0x09, 0x0a, 0x0d].includes(bytes[1])) encoding = "utf-16be";
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset)); }
  catch { throw new Error("The file is not a complete UTF-8 or UTF-16 Tally exchange document"); }
  const declaration = text.match(/^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']+)/i)?.[1];
  if (declaration && !/^(utf-?8|utf-?16(?:le|be)?)$/i.test(declaration)) throw new Error(`The XML encoding ${declaration} needs a Unicode export from Tally`);
  return { text: text.replace(/^\uFEFF/, ""), encoding };
}

function entities(value) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(value)) throw new Error("The XML contains an unrecognised entity");
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity) => {
    if (!entity.startsWith("#")) return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error("The XML contains an invalid character reference");
    return String.fromCodePoint(code);
  });
}

export function parseTallyXml(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("XML DTDs and entity declarations are not accepted");
  const root = { tag: "DOCUMENT", attrs: {}, text: "", children: [] };
  const stack = [root];
  let cursor = 0;
  let count = 0;
  while (cursor < text.length) {
    if (text[cursor] !== "<") {
      const next = text.indexOf("<", cursor);
      const end = next < 0 ? text.length : next;
      stack.at(-1).text += entities(text.slice(cursor, end));
      cursor = end;
      continue;
    }
    if (text.startsWith("<!--", cursor) || text.startsWith("<![CDATA[", cursor) || text.startsWith("<?", cursor)) {
      const comment = text.startsWith("<!--", cursor);
      const cdata = text.startsWith("<![CDATA[", cursor);
      const marker = comment ? "-->" : cdata ? "]]>" : "?>";
      const start = cursor + (comment ? 4 : cdata ? 9 : 2);
      const end = text.indexOf(marker, start);
      if (end < 0) throw new Error("The XML has an unfinished comment or declaration");
      if (cdata) stack.at(-1).text += text.slice(start, end);
      cursor = end + marker.length;
      continue;
    }
    let end = cursor + 1;
    let quote = "";
    for (; end < text.length; end++) {
      const char = text[end];
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end === text.length) throw new Error("The XML has an unfinished element");
    const body = text.slice(cursor + 1, end).trim();
    cursor = end + 1;
    if (body.startsWith("/")) {
      if (stack.length === 1 || stack.at(-1).tag !== body.slice(1).trim()) throw new Error("The XML closing elements do not match");
      stack.pop();
      continue;
    }
    const match = body.match(/^([A-Za-z_][\w.:-]*)([\s\S]*?)\/?$/);
    if (!match || body.startsWith("!")) throw new Error("The XML contains an invalid element");
    const node = { tag: match[1], attrs: {}, text: "", children: [] };
    let attributes = match[2].trim();
    while (attributes) {
      const attribute = attributes.match(/^([A-Za-z_][\w.:-]*)\s*=\s*(["'])([\s\S]*?)\2(?:\s+|$)/);
      if (!attribute || Object.hasOwn(node.attrs, attribute[1])) throw new Error("The XML contains an invalid or repeated attribute");
      node.attrs[attribute[1]] = entities(attribute[3]);
      attributes = attributes.slice(attribute[0].length);
    }
    stack.at(-1).children.push(node);
    if (++count > 1_000_000) throw new Error("The XML contains too many elements");
    if (!body.endsWith("/")) stack.push(node);
    if (stack.length > 128) throw new Error("The XML nesting is too deep");
  }
  if (stack.length !== 1 || root.children.length !== 1 || root.text.trim()) throw new Error("Choose a complete Tally XML document");
  return root;
}

function jsonNode(tag, value, depth = 0, budget = { count: 0 }) {
  if (++budget.count > 1_000_000) throw new Error("The JSON contains too many elements");
  if (depth > 128) throw new Error("The JSON nesting is too deep");
  const node = { tag, attrs: {}, text: "", children: [] };
  if (value === null || typeof value !== "object") { node.text = value === null ? "" : String(value); return node; }
  const metadata = value.metadata || value.METADATA;
  if (metadata && typeof metadata === "object") {
    for (const [key, entry] of Object.entries(metadata)) node.attrs[key.toUpperCase()] = String(entry ?? "");
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key.toLowerCase() === "metadata") continue;
    const items = Array.isArray(entry) ? entry : [entry];
    for (const item of items) node.children.push(jsonNode(key, item, depth + 1, budget));
  }
  return node;
}

export function parseTallyJson(text) {
  const input = JSON.parse(text);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Choose a native Tally JSON exchange document");
  return jsonNode("DOCUMENT", input);
}

export const children = (node, name) => { const key=keyName(name);return node.children.filter((child) => keyName(child.tag) === key); };
export const child = (node, name) => { const key=keyName(name);return node.children.find((child) => keyName(child.tag) === key); };
export const value = (node, name) => child(node, name)?.text.trim() || "";
export const attribute = (node, name) => { const target=keyName(name);return Object.entries(node.attrs).find(([key]) => keyName(key) === target)?.[1] || ""; };
const spreadsheetTags = new Set(["XLSXSOURCE", "XLSXROW", "XLSXCELL", "HEADER", "CELLREF", "CELLTYPE", "RAWVALUE", "VALUE", "FORMULA", "NUMBERFORMAT", "STYLE", "ERROR"]);
export function findNodes(node, name) {
  const result = [], target=keyName(name), includeSpreadsheet=spreadsheetTags.has(target);
  const visit = (current) => {
    const key=keyName(current.tag);
    if (key === target) result.push(current);
    // Spreadsheet cells are retained metadata, not nested native Tally fields.
    // Explicit cell/source queries still inspect their complete original tree.
    if (!includeSpreadsheet && key === "XLSXSOURCE" && Object.hasOwn(current.attrs,"SHEET")) return;
    for (const entry of current.children) visit(entry);
  };
  visit(node);
  return result;
}

export function tallyRecords(tree) {
  const records = [];
  const visit = (node, parent) => {
    const declared = attribute(node, "TYPE");
    const type = keyName(declared || node.tag);
    const messageObject = keyName(node.tag) === "TALLYMESSAGE" && declared;
    const messageChild = parent && keyName(parent.tag) === "TALLYMESSAGE" && !attribute(parent, "TYPE");
    if (recordTypes.has(type) || messageObject || messageChild) {
      records.push({ type, node });
      return;
    }
    for (const current of node.children) visit(current, node);
  };
  visit(tree, null);
  return records;
}
