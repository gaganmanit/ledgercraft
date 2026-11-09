import { formatINR } from "./money.js";
import { ledger, newId, text } from "./reconciliation-common.js";

// Bank statement rules: company.reconciliation.bankRules = [{ id, pattern, ledgerId, type?,
// narration?, createdAt }]. A rule only suggests the contra ledger for an unmatched
// statement row; nothing is posted until the user passes the voucher. The list is
// optional, so books saved before rules existed keep loading unchanged.

export const STATEMENT_VOUCHER_TYPES = ["Receipt", "Payment", "Contra", "Journal"];
const RULE_ID = /^br-[a-f0-9]{20}$/;
const MAX_RULES = 300;
const MAX_PATTERN = 200;
const REGEX_FORM = /^\/(.+)\/([imsu]*)$/s;
// Words that describe the payment rail rather than the counterparty. A learned rule
// leaves them out so the same party is recognised whether it paid by NEFT, IMPS or UPI.
const RAIL_WORDS = new Set(["NEFT", "RTGS", "IMPS", "UPI", "ACH", "ECS", "NACH", "CHQ", "CHEQUE", "CHEQ", "CLG", "CLEARING", "TRF", "TRANSFER", "TFR", "INB", "MB", "IB", "NET", "BANKING", "BY", "TO", "FROM", "FOR", "CR", "DR", "REF", "NO", "INWARD", "OUTWARD", "DEPOSIT", "WITHDRAWAL", "MOB", "UPIAR", "P2A", "P2M"]);
const NUMERIC_DATE = /\b\d{1,4}[-/. ]\d{1,2}[-/. ]\d{2,4}\b/g;
const NAMED_DATE = /\b\d{1,2}[-/. ]?(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)[A-Z]*\.?[-/. ,]?\d{2,4}\b/gi;

const normal = value => String(value ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
const compiled = new Map();
function patternMatcher(pattern) {
  if (compiled.has(pattern)) return compiled.get(pattern);
  let matcher;
  const regex = REGEX_FORM.exec(pattern);
  if (regex) {
    const flags = [...new Set(`${regex[2]}i`)].join("");
    const expression = new RegExp(regex[1], flags);
    matcher = narration => expression.test(narration);
  } else {
    const phrase = normal(pattern), words = phrase.split(" ").filter(Boolean);
    // Plain text matches when it appears in the narration, ignoring case and punctuation,
    // or when every one of its words appears in the narration in any order.
    matcher = narration => {
      const value = normal(narration);
      if (!value || !phrase) return false;
      if (` ${value} `.includes(` ${phrase} `)) return true;
      const present = new Set(value.split(" "));
      return words.every(word => present.has(word));
    };
  }
  compiled.set(pattern, matcher);
  if (compiled.size > 1000) compiled.delete(compiled.keys().next().value);
  return matcher;
}
function checkedPattern(value) {
  const pattern = text(value, "a rule pattern", MAX_PATTERN);
  const regex = REGEX_FORM.exec(pattern);
  if (regex) {
    try { new RegExp(regex[1], regex[2]); } catch { throw new Error(`The rule pattern ${pattern} is not a valid regular expression`); }
  } else if (!normal(pattern)) throw new Error("A plain-text rule pattern needs letters or digits");
  return pattern;
}

export function ruleMatches(rule, narration) {
  return patternMatcher(rule.pattern)(String(narration ?? ""));
}

// Shape check for saved rules. Ledgers are checked when a rule is saved, not here, so a
// later ledger deletion cannot make the whole reconciliation section unreadable; rules
// whose ledger has gone are simply not suggested.
export function assertBankRules(rules) {
  if (rules === undefined) return;
  if (!Array.isArray(rules) || rules.length > MAX_RULES) throw new Error("Invalid bank rule records");
  const ids = new Set();
  for (const rule of rules) {
    if (!rule || typeof rule !== "object" || !RULE_ID.test(rule.id) || ids.has(rule.id)) throw new Error("Invalid or duplicate bank rule identity");
    ids.add(rule.id);
    if (Object.keys(rule).some(key => !["id", "pattern", "ledgerId", "type", "narration", "createdAt", "learnedFrom"].includes(key))) throw new Error("Invalid bank rule");
    checkedPattern(rule.pattern);
    if (typeof rule.ledgerId !== "string" || !rule.ledgerId) throw new Error("Invalid bank rule ledger");
    if (rule.type !== undefined && !STATEMENT_VOUCHER_TYPES.includes(rule.type)) throw new Error("Invalid bank rule voucher type");
    if (rule.narration !== undefined && (typeof rule.narration !== "string" || rule.narration.length > 280)) throw new Error("Invalid bank rule narration");
    if (rule.learnedFrom !== undefined && (typeof rule.learnedFrom !== "string" || !/^sr-[a-f0-9]{20}$/.test(rule.learnedFrom))) throw new Error("Invalid bank rule source row");
    if (typeof rule.createdAt !== "string" || !Number.isFinite(Date.parse(rule.createdAt))) throw new Error("Invalid bank rule date");
  }
}

const dmy = iso => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
export function renderNarration(template, row) {
  return String(template).replace(/\{(narration|reference|date|amount)\}/g, (_, key) =>
    key === "narration" ? row.narration || "" : key === "reference" ? row.reference || "" : key === "date" ? dmy(row.date) : formatINR(Math.abs(row.amountPaise))).trim().slice(0, 280);
}
export const defaultStatementType = row => row.amountPaise > 0 ? "Receipt" : "Payment";

// First rule in list order whose pattern matches the row narration and whose ledger
// still exists. The list order is the priority the user set.
export function ruleSuggestion(rules, company, row) {
  for (const rule of rules || []) {
    if (!ruleMatches(rule, row.narration)) continue;
    const account = company.ledgers.find(item => item.id === rule.ledgerId);
    if (!account) continue;
    const type = rule.type && typeAllowed(rule.type, row) ? rule.type : defaultStatementType(row);
    return { ruleId: rule.id, pattern: rule.pattern, ledgerId: account.id, ledgerName: account.name, type,
      narration: rule.narration ? renderNarration(rule.narration, row) : null };
  }
  return null;
}
export function typeAllowed(type, row) {
  if (type === "Receipt") return row.amountPaise > 0;
  if (type === "Payment") return row.amountPaise < 0;
  return STATEMENT_VOUCHER_TYPES.includes(type);
}

// The stable words of a narration: dates and every token holding a digit (UTR, cheque,
// account and invoice numbers) are dropped, then the payment-rail words. Returns null
// when nothing distinctive is left, so no catch-all rule is ever learned.
export function learnedPattern(narration) {
  const words = String(narration ?? "").replace(NAMED_DATE, " ").replace(NUMERIC_DATE, " ").toUpperCase().split(/[^A-Z0-9]+/)
    .filter(word => word.length >= 2 && !/\d/.test(word) && !RAIL_WORDS.has(word));
  const unique = [...new Set(words)].slice(0, 8);
  return unique.length ? unique.join(" ") : null;
}

export function learnBankRule(meta, company, row, { ledgerId, type }) {
  ledger(company, ledgerId);
  const pattern = learnedPattern(row.narration);
  if (!pattern) return { rule: null, learned: false, reason: "The narration has no stable words to learn a rule from" };
  meta.bankRules ||= [];
  const same = meta.bankRules.find(rule => !REGEX_FORM.test(rule.pattern) && normal(rule.pattern) === pattern);
  const ruleType = type === defaultStatementType(row) ? undefined : type;
  if (same) {
    if (same.ledgerId === ledgerId && same.type === ruleType) return { rule: structuredClone(same), learned: false, reason: "An identical rule already exists" };
    const previous = structuredClone(same);
    same.ledgerId = ledgerId;
    if (ruleType) same.type = ruleType; else delete same.type;
    return { rule: structuredClone(same), previous, learned: true, updated: true };
  }
  if (meta.bankRules.length >= MAX_RULES) throw new Error(`Keep up to ${MAX_RULES} bank rules`);
  const rule = { id: newId("br"), pattern, ledgerId, ...(ruleType ? { type: ruleType } : {}), createdAt: new Date().toISOString(), learnedFrom: row.id };
  meta.bankRules.push(rule);
  return { rule: structuredClone(rule), learned: true };
}

// Replace the whole list (the order is the priority). Rules sent with an existing id keep
// their creation time and source row; rules without an id are new.
export function saveBankRules(meta, company, input) {
  if (!Array.isArray(input.rules) || input.rules.length > MAX_RULES) throw new Error(`Send the bank rules as a list of up to ${MAX_RULES}`);
  const current = new Map((meta.bankRules || []).map(rule => [rule.id, rule]));
  const seen = new Set();
  const now = new Date().toISOString();
  const rules = input.rules.map(item => {
    if (!item || typeof item !== "object") throw new Error("Each bank rule needs a pattern and a ledger");
    const prior = item.id === undefined || item.id === null || item.id === "" ? null : current.get(item.id);
    if (item.id && !prior) throw new Error("A bank rule changed while you were editing. Reload the rules");
    if (prior && seen.has(prior.id)) throw new Error("A bank rule appears twice");
    if (prior) seen.add(prior.id);
    const pattern = checkedPattern(item.pattern);
    const account = ledger(company, item.ledgerId);
    if (item.type !== undefined && item.type !== null && item.type !== "" && !STATEMENT_VOUCHER_TYPES.includes(item.type)) throw new Error("A bank rule voucher type is Receipt, Payment, Contra or Journal");
    const narration = item.narration === undefined || item.narration === null || item.narration === "" ? undefined : text(item.narration, "a rule narration", 280);
    return { id: prior?.id || newId("br"), pattern, ledgerId: account.id, ...(item.type ? { type: item.type } : {}), ...(narration ? { narration } : {}),
      createdAt: prior?.createdAt || now, ...(prior?.learnedFrom ? { learnedFrom: prior.learnedFrom } : {}) };
  });
  const previous = (meta.bankRules || []).length;
  meta.bankRules = rules;
  assertBankRules(meta.bankRules);
  // The reconciliation history keeps the counts; the list itself is in bankRules.
  return { count: rules.length, previousCount: previous };
}

export function bankRulesView(meta, company) {
  const names = new Map(company.ledgers.map(account => [account.id, account.name]));
  return (meta.bankRules || []).map(rule => ({ ...rule, ledgerName: names.get(rule.ledgerId) || null }));
}
