#!/usr/bin/env node
// Static checks for the browser interface against docs/DESIGN.md. No dependencies; exit 1 on findings.
// Usage: node tools/check-ui.mjs [--quiet]
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const names = (await readdir(publicDir)).filter((name) => /\.(js|css|html)$/.test(name));
const files = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(path.join(publicDir, name), "utf8")])));
const findings = [];
const note = (file, line, rule, detail) => findings.push({ file, line, rule, detail });
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// 1. Classes used in markup but defined nowhere, and classes defined but never used.
const defined = new Map();
for (const [name, text] of Object.entries(files)) {
  if (!name.endsWith(".css")) continue;
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/url\([^)]*\)/g, "url()");
  for (const match of withoutComments.matchAll(/\.([a-zA-Z_][\w-]*)/g)) {
    // skip decimals such as .5rem and pseudo-element remnants
    if (/^\d/.test(match[1])) continue;
    if (!defined.has(match[1])) defined.set(match[1], new Set());
    defined.get(match[1]).add(name);
  }
}
const used = new Map();
for (const [name, text] of Object.entries(files)) {
  if (name.endsWith(".css")) continue;
  for (const match of text.matchAll(/class(?:Name)?\s*=\s*["'`]([^"'`$]*)["'`]/g)) {
    for (const cls of match[1].split(/\s+/).filter(Boolean)) {
      if (!used.has(cls)) used.set(cls, new Set());
      used.get(cls).add(`${name}:${lineOf(text, match.index)}`);
    }
  }
  for (const match of text.matchAll(/classList\.(?:add|toggle|remove)\(\s*["']([\w-]+)["']/g)) {
    if (!used.has(match[1])) used.set(match[1], new Set());
    used.get(match[1]).add(`${name}:${lineOf(text, match.index)}`);
  }
}
// Classes that scripts or stylesheets reach through selectors are hooks, not styling, and are allowed to have no rules.
const hooks = new Set();
for (const [name, text] of Object.entries(files)) {
  for (const match of text.matchAll(/(?:querySelector(?:All)?|closest|matches)\(\s*["'`]([^"'`]+)["'`]/g)) {
    for (const cls of match[1].matchAll(/\.([a-zA-Z_][\w-]*)/g)) hooks.add(cls[1]);
  }
}
for (const [cls, where] of used) {
  if (hooks.has(cls)) continue;
  if (!defined.has(cls)) findings.push({ file: [...where][0].split(":")[0], line: Number([...where][0].split(":")[1]), rule: "undefined-class", detail: `class "${cls}" is used but no stylesheet defines it`, advisory: true });
}
const dynamicClassHints = /classList|className\s*=|class="\$\{/;
for (const [cls, where] of defined) {
  if (used.has(cls)) continue;
  if (["skip", "sr", "only-print", "print-company", "ok", "warn", "bad", "info", "met", "group", "total", "selected-row", "wide", "grow", "check-group", "tax-heads", "doc-endorsement", "attention", "attention-rule", "hint", "notice", "field-note", "form-note", "subsection-intro", "code", "button", "secondary", "danger", "link", "ghost", "figure", "quiet", "empty", "alert", "status", "pill", "kv", "summary-strip", "details-list", "doc", "doc-head", "doc-parties", "doc-totals", "doc-total", "doc-signature", "toolbar", "form-grid", "table-scroll", "check", "subsection", "form-message", "date-cell", "voucher-ref", "idx", "open"].includes(cls)) continue;
  const anyDynamic = Object.entries(files).some(([n, t]) => !n.endsWith(".css") && dynamicClassHints.test(t) && t.includes(cls));
  if (!anyDynamic) note([...where][0], 0, "unused-class", `class ".${cls}" is defined but never used in markup`);
}

// 2. Design-contract smells in markup and styles.
const smells = [
  [/text-transform\s*:\s*uppercase/g, "uppercase-label", "tracked-out capitals are not part of the design"],
  [/font-size\s*:\s*(?:0?\.(?:[0-6]\d*|7[0-4]\d*)rem|(?:[0-9]|1[01])px|[0-6]pt)\b/g, "tiny-text", "text smaller than 12px"],
  [/font-family\s*:\s*var\(--serif\)/g, "serif-override", "the serif alias is retired; headings inherit the system face"],
  [/class="[^"]*\bsecondary\b[^"]*"/g, "secondary-class", "use class=\"ghost\" for secondary buttons"],
  [/\sstyle="/g, "inline-style", "inline styles are blocked by the content security policy"],
  [/[↗→]<\/(a|button|summary)>/g, "arrow-suffix", "arrows appended to link or button text"],
  [/[A-Za-z0-9)\]]\s·\s[A-Za-z0-9₹(]/g, "middle-dot", "facts joined with a middle dot; use separate elements or a sentence"],
];
for (const [name, text] of Object.entries(files)) {
  for (const [pattern, rule, detail] of smells) {
    if (name.endsWith(".css") && ["secondary-class", "inline-style", "arrow-suffix", "middle-dot"].includes(rule)) continue;
    if (!name.endsWith(".css") && ["uppercase-label", "tiny-text", "serif-override"].includes(rule)) continue;
    for (const match of text.matchAll(pattern)) note(name, lineOf(text, match.index), rule, `${detail}: ${JSON.stringify(match[0].trim().slice(0, 60))}`);
  }
}

// 3. Money cells: table headers with ₹ or amount words should be .figure.
for (const [name, text] of Object.entries(files)) {
  if (!name.endsWith(".js")) continue;
  for (const match of text.matchAll(/<th(?![^>]*class="[^"]*\bfigure\b)[^>]*>([^<]*(?:₹|Amount|Taxable|Debit|Credit|Balance|Value|Tax)[^<]*)<\/th>/g)) {
    if (/scope="row"|colspan=/.test(match[0])) continue;
    note(name, lineOf(text, match.index), "money-header", `column header ${JSON.stringify(match[1].trim().slice(0, 40))} is not a .figure cell`);
  }
}

const quiet = process.argv.includes("--quiet");
const blocking = findings.filter((f) => !f.advisory);
const byRule = new Map();
for (const f of findings) byRule.set(f.rule, (byRule.get(f.rule) || 0) + 1);
if (!quiet) for (const f of findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) console.log(`${f.file}:${f.line} ${f.rule} ${f.detail}`);
console.log(findings.length ? `${findings.length} findings, ${blocking.length} blocking (${[...byRule].map(([r, n]) => `${r} ${n}`).join(", ")}). Undefined classes are advisory: they are hooks or leftovers to tidy.` : "No interface findings.");
process.exit(blocking.length ? 1 : 0);
