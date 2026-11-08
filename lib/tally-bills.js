import { workbookSourceFingerprint } from "./tally-workbook-references.js";
import { isDeepStrictEqual } from "node:util";
import { openingSigned } from "./engine.js";
import { reservedGroups } from "./groups.js";
import { attribute, child, children, keyName, value } from "./tally-format.js";
import { tallyAmount, tallyDate } from "./tally-values.js";
import { allocateBill, billReport, saveBill } from "./reconciliation-bills.js";
import { assertReconciliation } from "./reconciliation.js";
import { digest, newId, partySide, section, sum } from "./reconciliation-common.js";

export const TALLY_BILL_SOURCES = [
  "https://help.tallysolutions.com/sample-xml/",
  "https://help.tallysolutions.com/developer-reference/tally-definition-language/appendix/",
  "https://help.tallysolutions.com/docs/te9rel66/Creating_Masters/Accounts_Info/Creating_a_Party_Ledger.htm",
  "https://help.tallysolutions.com/receivables-payables-tracking-methods/",
];
const nameKey = input => String(input || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-IN");
const recordName = record => attribute(record.node, "NAME") || value(record.node, "NAME");
const isNo = input => /^(no|false|0)$/i.test(input);
const isYes = input => /^(yes|true|1)$/i.test(input);
const referenceKey = row => `${row.ledgerId}:${nameKey(row.reference)}`;
function canonicalNode(node) {
  return { tag: keyName(node.tag), attrs: node.attrs, text: node.text.trim(), children: node.children.map(canonicalNode) };
}
function financial(voucher) {
  if (!voucher) return null;
  return { type: voucher.type, number: voucher.number, date: voucher.date, lines: voucher.lines };
}
function creditDue(node, billDate, master) {
  const explicit = value(node, "DUEDATE");
  const termNode = child(node, "BILLCREDITPERIOD");
  const term = termNode?.text.trim() || value(master, "BILLCREDITPERIOD");
  let calculated = billDate;
  if (term) {
    if (/^(\d{8}|\d{4}-\d{2}-\d{2}|\d{1,2}-[A-Za-z]{3}-\d{4})$/.test(term)) calculated = tallyDate(term);
    else {
      const match = /^(\d+)(?:\s*Days?)?$/i.exec(term);
      if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error(`Unsupported bill credit period ${term}`);
      const base = new Date(`${billDate}T00:00:00Z`);
      base.setUTCDate(base.getUTCDate() + Number(match[1]));
      if (!Number.isFinite(base.getTime())) throw new Error("The bill credit period exceeds the supported dates");
      calculated = tallyDate(base.toISOString().slice(0, 10));
    }
  } else if (termNode && Object.keys(termNode.attrs).length && !explicit) {
    throw new Error("The bill credit period contains only internal attributes. Export its readable due date or credit days");
  }
  const due = explicit ? tallyDate(explicit) : calculated;
  if (explicit && term && due !== calculated) throw new Error("The explicit due date and credit period disagree");
  if (due < billDate) throw new Error("The bill due date precedes its bill date");
  return due;
}
function sourceRole(ledgerRecord, groupRecords) {
  const parents = new Map(groupRecords.map(record => [nameKey(recordName(record)), value(record.node, "PARENT")]));
  const standard = new Map(reservedGroups().map(group => [nameKey(group.name), group]));
  let current = value(ledgerRecord.node, "PARENT");
  const seen = new Set();
  while (current && !seen.has(nameKey(current))) {
    const key = nameKey(current); seen.add(key);
    if (key === "sundry debtors") return "receivable";
    if (key === "sundry creditors") return "payable";
    const known = standard.get(key);
    if (known) return null;
    current = parents.get(key);
  }
  return null;
}
function rowFor(record, ledgerRecord, account, node, path, side, sourceDate, opening) {
  const rawType = value(node, "BILLTYPE");
  const method = nameKey(rawType).replace(/\./g, "");
  const kind = opening && !rawType ? "new" : ["new ref", "newref"].includes(method) ? "new" : ["agst ref", "against ref", "agstref"].includes(method) ? "against" : method === "on account" ? "on-account" : method === "advance" ? "advance" : "unknown";
  const sourceKey = `${record.recordId}:${path}`;
  return {
    id: `br-${digest(sourceKey).slice(0, 20)}`, sourceKey, recordId: record.recordId, nodePath: path,
    ledgerId: account?.id || "", partyName: account?.name || recordName(ledgerRecord), side,
    reference: value(node, "NAME"), method: rawType || (opening ? "Opening reference" : ""), kind,
    opening, date: sourceDate, dueDate: "", paise: 0, normalPaise: 0,
    sourcePostingKey: opening ? `opening:${account?.id || ""}` : `${record.voucherId}:${account?.id || ""}`,
    voucherId: opening ? null : record.voucherId, status: "pending", code: "", message: "",
  };
}
const fail = (row, code, message) => Object.assign(row, { status: "exception", code, message });
function originalRows(company, vouchers, sourceRecords) {
  const records = sourceRecords.filter(record => record.disposition !== "duplicate-source");
  const masters = records.filter(record => record.type === "LEDGER");
  const groups = records.filter(record => record.type === "GROUP");
  const byName = new Map(masters.map(record => [nameKey(recordName(record)), record]));
  const accountBySource = new Map(company.ledgers.filter(account => account.source?.system === "tally").map(account => [account.source.recordId, account]));
  const rows = [], roleCache = new Map();
  const process = (record, ledgerRecord, entries, opening) => {
    const account = ledgerRecord && accountBySource.get(ledgerRecord.recordId);
    let side, sourceDate, groupError = "";
    try {
      if (!ledgerRecord || !account) throw new Error("The bill's source ledger is missing from the imported accounting books");
      if (!roleCache.has(ledgerRecord.recordId)) roleCache.set(ledgerRecord.recordId, sourceRole(ledgerRecord, groups));
      side = roleCache.get(ledgerRecord.recordId);
      if (!side) throw new Error("Bill-wise activation supports ledgers under Sundry Debtors or Sundry Creditors");
      if (partySide(company, account) !== side) throw new Error("The party account group changed after import");
      const enabled = value(ledgerRecord.node, "ISBILLWISEON");
      if (enabled && (!isYes(enabled) || isNo(enabled))) throw new Error("The source party does not enable bill-wise tracking");
      if (opening) sourceDate = company.booksFrom;
      else {
        const voucher = vouchers.find(voucher => voucher.id === record.voucherId && voucher.source?.recordId === record.recordId);
        if (!voucher || (record.originalPosting && !isDeepStrictEqual(financial(voucher), financial(record.originalPosting)))) throw new Error("The source voucher was removed or its accounting postings changed after import");
        sourceDate = tallyDate(value(record.node, "DATE"));
        if (voucher.date !== sourceDate) throw new Error("The accounting voucher and source bill dates disagree");
        const rawPosting = sum(entries.map(entry => tallyAmount(value(entry.node, "AMOUNT"))));
        const currentPosting = sum(voucher.lines.filter(line => line.ledgerId === account.id).map(line => line.dc === "Dr" ? -line.paise : line.paise));
        if (rawPosting !== currentPosting || new Set(entries.map(entry => Math.sign(tallyAmount(value(entry.node, "AMOUNT")))).filter(Boolean)).size > 1) throw new Error("The source party direction does not agree with the approved accounting posting, or contains mixed directions");
      }
    } catch (error) { groupError = error.message; }
    const group = [];
    let annotatedPosting = 0;
    for (const entry of entries) {
      const bills = children(entry.node, "BILLALLOCATIONS").map((node, index) => ({ node, index })).filter(({ node }) => value(node, "NAME") || value(node, "AMOUNT") || value(node, "OPENINGBALANCE") || value(node, "BILLTYPE"));
      if (!bills.length) continue;
      try { if (!opening) annotatedPosting = sum([annotatedPosting, tallyAmount(value(entry.node, "AMOUNT"))]); }
      catch (error) { groupError ||= error.message; }
      for (const { index, node } of bills) {
        const row = rowFor(record, ledgerRecord || record, account, node, `${entry.path}/BILLALLOCATIONS[${index}]`, side, sourceDate || company.booksFrom, opening);
        group.push(row); rows.push(row);
        if (groupError) { fail(row, "party-source-needs-review", groupError); continue; }
        try {
          if (!opening && isNo(value(entry.node, "ISPARTYLEDGER"))) throw new Error("The source entry marks this ledger as non-party");
          const raw = opening ? value(node, "OPENINGBALANCE") || value(node, "AMOUNT") : value(node, "AMOUNT");
          row.tallyPaise = tallyAmount(raw);
          row.normalPaise = row.tallyPaise * (side === "receivable" ? -1 : 1);
          row.paise = Math.abs(row.normalPaise);
          if (opening) {
            row.date = tallyDate(value(node, "BILLDATE"));
            if (row.date > company.booksFrom) throw new Error("An opening bill date falls after these books begin");
            if (isYes(value(node, "ISADVANCE"))) row.kind = "advance";
          }
          if (!row.paise) { row.status = "on-account"; row.message = "Zero-value source allocation retained"; continue; }
          if (["new", "against"].includes(row.kind) && (!row.reference.trim() || row.reference.trim().length > 80)) throw new Error("A named reference must contain 1 to 80 characters for active bill-wise tracking");
          if (row.kind === "new" && row.normalPaise > 0) row.dueDate = creditDue(node, row.date, ledgerRecord.node);
          else if (row.kind === "against" && row.normalPaise < 0 && !opening) { /* Settlement capacity is validated against the named reference below. */ }
          else if (row.kind === "on-account") { row.status = "on-account"; row.message = "Retained in the party's on-account balance"; }
          else if (row.kind === "advance" || (row.kind === "new" && row.normalPaise < 0) || (row.kind === "against" && row.normalPaise > 0)) throw new Error("Named advances and invoice-against-advance breakups remain source details. Their net credits stay available in the party ledger");
          else throw new Error(`Unsupported bill allocation method ${row.method || "(empty)"}`);
        } catch (error) { fail(row, "bill-source-needs-review", error.message); }
      }
    }
    if (!group.length || groupError) return;
    try {
      if (group.some(row => !Number.isSafeInteger(row.tallyPaise))) throw new Error("An incomplete bill breakup cannot be activated");
      const breakup = sum(group.map(row => row.tallyPaise));
      if (opening) {
        const originalOpening = tallyAmount(value(ledgerRecord.node, "OPENINGBALANCE"), true);
        if (-openingSigned(account) !== originalOpening) throw new Error("The ledger opening balance changed after import");
        const capacity = openingSigned(account) * (side === "receivable" ? 1 : -1);
        const billTotal = sum(group.map(row => row.normalPaise));
        if (capacity <= 0 || group.some(row => row.normalPaise < 0) || billTotal > capacity) throw new Error("Mixed-direction or over-net opening bill breakups remain source details for review");
      } else if (breakup !== annotatedPosting) throw new Error("The bill breakup total does not equal its source party posting");
    } catch (error) { for (const row of group) fail(row, "bill-breakup-needs-review", error.message); }
  };
  for (const record of masters.filter(record => record.disposition === "ledger")) process(record, record, [{ node: record.node, path: "LEDGER" }], true);
  for (const record of records.filter(record => record.type === "VOUCHER" && record.disposition === "voucher")) {
    const all = children(record.node, "ALLLEDGERENTRIES");
    const direct = all.length ? all : children(record.node, "LEDGERENTRIES");
    const entries = direct.map((node, index) => ({ node, path: `${all.length ? "ALLLEDGERENTRIES" : "LEDGERENTRIES"}[${index}]` }));
    if (record.accountingMode === "ledger-plus-inventory-accounting-allocations") {
      const inventory = [...children(record.node, "ALLINVENTORYENTRIES"), ...children(record.node, "INVENTORYENTRIES")];
      for (const [inventoryIndex, node] of inventory.entries()) for (const [index, entry] of children(node, "ACCOUNTINGALLOCATIONS").entries()) entries.push({ node: entry, path: `INVENTORY[${inventoryIndex}]/ACCOUNTINGALLOCATIONS[${index}]` });
    }
    const ledgers = new Map();
    for (const entry of entries) {
      const key = nameKey(value(entry.node, "LEDGERNAME"));
      if (!ledgers.has(key)) ledgers.set(key, []);
      ledgers.get(key).push(entry);
    }
    for (const [name, ledgerEntries] of ledgers) if (ledgerEntries.some(entry => children(entry.node, "BILLALLOCATIONS").some(node => value(node, "NAME") || value(node, "AMOUNT") || value(node, "BILLTYPE")))) process(record, byName.get(name), ledgerEntries, false);
  }
  return rows;
}
function origin(row, sourceHash) {
  return { system: "tally-bills", sourceKey: row.sourceKey, recordId: row.recordId, nodePath: row.nodePath,
    sourceHash, reference: row.reference, date: row.date, dueDate: row.dueDate, paise: row.paise, method: row.method };
}
function originalSourceHash(records) {
  const workbook=workbookSourceFingerprint(records);
  if (workbook) return workbook;
  const originals = new Map(records.map(record => [record.recordId, { id: record.recordId, type: record.type, node: canonicalNode(record.node) }]));
  return digest([...originals.values()].sort((a, b) => a.id.localeCompare(b.id)));
}
function locateBill(record, path) {
  let node = record.node, parent = null;
  for (const part of path.split("/")) {
    if (part === "LEDGER" && record.type === "LEDGER") continue;
    const match = /^([A-Z]+)\[(\d+)\]$/.exec(part);
    if (!match) throw new Error("Invalid bill source path");
    parent = node;
    const list = match[1] === "INVENTORY" ? [...children(node, "ALLINVENTORYENTRIES"), ...children(node, "INVENTORYENTRIES")] : children(node, match[1]);
    node = list[Number(match[2])];
    if (!node) throw new Error("The bill source path is not in its original record");
  }
  return { node, parent };
}
export function assertTallyBillOrigins(company, records) {
  const metadata = company.reconciliation;
  if (!metadata?.sourceActivations?.length) return;
  const sourceHash = originalSourceHash(records);
  const byId = new Map(records.map(record => [record.recordId, record]));
  const masters = new Map(records.filter(record => record.type === "LEDGER" && record.disposition !== "duplicate-source").map(record => [nameKey(recordName(record)), record]));
  for (const event of metadata.sourceActivations) {
    if (event.sourceHash !== sourceHash) throw new Error("Bill activation belongs to a different Tally source snapshot");
    for (const target of event.targets) {
      const separator = target.sourceKey.indexOf(":");
      const record = byId.get(target.sourceKey.slice(0, separator));
      if (!record) throw new Error("A bill activation references a missing original record");
      locateBill(record, target.sourceKey.slice(separator + 1));
    }
  }
  for (const target of [...metadata.bills, ...metadata.allocations].filter(row => row.origin?.system === "tally-bills")) {
    const original = target.origin, record = byId.get(original.recordId);
    if (!record || original.sourceHash !== sourceHash) throw new Error("The original bill source record is missing or different");
    const { node, parent } = locateBill(record, original.nodePath);
    const opening = record.type === "LEDGER";
    const master = opening ? record : masters.get(nameKey(value(parent, "LEDGERNAME")));
    const account = company.ledgers.find(account => account.source?.recordId === master?.recordId);
    const sourceDate = opening ? tallyDate(value(node, "BILLDATE")) : tallyDate(value(record.node, "DATE"));
    const sourceAmount = Math.abs(tallyAmount(opening ? value(node, "OPENINGBALANCE") || value(node, "AMOUNT") : value(node, "AMOUNT")));
    const sourceMethod = value(node, "BILLTYPE") || (opening ? "Opening reference" : "");
    const against = ["agst ref", "against ref", "agstref"].includes(nameKey(sourceMethod).replace(/\./g, ""));
    const sourceDueDate = against ? "" : creditDue(node, sourceDate, master?.node || record.node);
    if (original.dueDate !== sourceDueDate) throw new Error("A bill's preserved due-date rule differs from its original source");
    if (!account || account.id !== target.ledgerId || original.reference !== value(node, "NAME") || original.date !== sourceDate || original.paise !== sourceAmount || original.method !== sourceMethod) throw new Error("A bill's preserved source facts differ from the original Tally fields");
  }
}

export function planTallyBillReferences(company, vouchers, records) {
  const meta = section(company.reconciliation);
  const sourceHash = originalSourceHash(records);
  const reviewHash = digest({ sourceHash, revision: meta.revision, ledgers: company.ledgers.map(({ id, name, groupId, opening }) => ({ id, name, groupId, opening })).sort((a, b) => a.id.localeCompare(b.id)),
    groups: company.groups.map(({ id, parentId }) => ({ id, parentId })).sort((a, b) => a.id.localeCompare(b.id)), vouchers: vouchers.map(voucher => ({ id: voucher.id, ...financial(voucher) })).sort((a, b) => a.id.localeCompare(b.id)) });
  const rows = originalRows(company, vouchers, records);
  const handled = new Map((meta.sourceActivations || []).flatMap(event => event.system === "tally-bills" ? event.targets.map(target => [target.sourceKey, target]) : []));
  const targets = [], sourceCache = new Map();
  const billIndex = new Map();
  const indexBill = bill => {
    const key = referenceKey(bill);
    if (!billIndex.has(key)) billIndex.set(key, []);
    billIndex.get(key).push(bill);
  };
  for (const bill of billReport(meta, company, vouchers, "9999-12-31", "", sourceCache).rows) indexBill(bill);
  const newReferences = rows.filter(row => row.kind === "new" && row.normalPaise > 0);
  const duplicateNames = new Map();
  for (const row of newReferences) { const key = referenceKey(row); duplicateNames.set(key, (duplicateNames.get(key) || 0) + 1); }
  for (const row of rows) {
    const prior = handled.get(row.sourceKey);
    if (!prior) continue;
    const target = prior.kind === "bill" ? meta.bills.find(item => item.id === prior.targetId) : meta.allocations.find(item => item.id === prior.targetId);
    const edited = target && prior.kind === "bill" && (target.reference !== row.reference || target.dueDate !== row.dueDate || target.date !== row.date || target.amountPaise !== row.paise);
    row.status = target ? edited ? "edited" : "active" : "removed";
    row.targetId = prior.targetId;
    row.message = target ? edited ? "The active bill reference was edited after source activation" : "Activated reference retained in these books" : "This activated reference or allocation was subsequently removed";
  }
  for (const row of newReferences.filter(row => row.status === "pending")) {
    if (duplicateNames.get(referenceKey(row)) !== 1) { fail(row, "ambiguous-new-reference", "More than one source New Ref uses this name for the same party"); continue; }
    try {
      const existing = billIndex.get(referenceKey(row)) || [];
      let bill;
      if (existing.length) {
        if (existing.length !== 1 || existing[0].sourceKey !== row.sourcePostingKey || existing[0].amountPaise !== row.paise) throw new Error("An existing reference with this name belongs to a different source posting or amount");
        bill = existing[0];
        row.status = "reused"; row.message = "Existing matching bill reference retained";
      } else {
        const id = `tb-${digest(row.sourceKey).slice(0, 20)}`;
        if (meta.bills.some(item => item.id === id)) throw new Error("The deterministic bill identity is already in use");
        const result = saveBill(meta, company, vouchers, { ledgerId: row.ledgerId, sourceKey: row.sourcePostingKey, reference: row.reference,
          dueDate: row.dueDate, amountPaise: row.paise, ...(row.opening ? { openingBillDate: row.date } : {}) }, sourceCache);
        bill = meta.bills.find(bill => bill.id === result.id);
        bill.id = id; bill.origin = origin(row, sourceHash);
        indexBill(bill);
        row.status = "ready"; row.message = "Ready to activate bill reference";
      }
      row.targetId = bill.id;
      targets.push({ sourceKey: row.sourceKey, kind: "bill", targetId: bill.id });
    } catch (error) { fail(row, "bill-activation-needs-review", error.message); }
  }
  for (const row of rows.filter(row => row.kind === "against" && row.normalPaise < 0 && row.status === "pending").sort((a, b) => a.date.localeCompare(b.date) || a.sourceKey.localeCompare(b.sourceKey))) {
    if ((duplicateNames.get(referenceKey(row)) || 0) > 1) { fail(row, "ambiguous-against-reference", "The source bill name identifies more than one New Ref for this party"); continue; }
    try {
      const bills = billIndex.get(referenceKey(row)) || [];
      if (bills.length !== 1) throw new Error("The named bill reference is missing or ambiguous. Retain the settlement on account until its bill is available");
      const id = `ta-${digest(row.sourceKey).slice(0, 20)}`;
      if (meta.allocations.some(item => item.id === id)) throw new Error("The deterministic allocation identity is already in use");
      const result = allocateBill(meta, company, vouchers, { ledgerId: row.ledgerId, billId: bills[0].id, creditKey: row.sourcePostingKey, date: row.date, paise: row.paise }, sourceCache);
      const allocation = meta.allocations.find(item => item.id === result.id);
      allocation.id = id; allocation.origin = origin(row, sourceHash);
      row.status = "ready"; row.targetId = allocation.id; row.message = "Ready to activate against-reference allocation";
      targets.push({ sourceKey: row.sourceKey, kind: "allocation", targetId: allocation.id });
    } catch (error) { fail(row, "against-reference-needs-review", error.message); }
  }
  const agreement = billReport(meta, company, vouchers, "9999-12-31", "", sourceCache);
  const summary = { sourceRows: rows.length, billsReady: rows.filter(row => row.kind === "new" && row.status === "ready").length,
    allocationsReady: rows.filter(row => row.kind === "against" && row.status === "ready").length,
    activeBills: rows.filter(row => row.kind === "new" && ["active", "edited", "reused"].includes(row.status)).length,
    activeAllocations: rows.filter(row => row.kind === "against" && row.status === "active").length,
    openingBillsReady: rows.filter(row => row.opening && row.status === "ready").length,
    existingRows: rows.filter(row => ["active", "edited", "reused"].includes(row.status)).length, removedRows: rows.filter(row => row.status === "removed").length,
    onAccountRows: rows.filter(row => row.status === "on-account").length, exceptions: rows.filter(row => row.status === "exception").length,
    ledgerDifferencePaise: sum(agreement.totals.map(party => Math.abs(party.differencePaise))) };
  return { meta, rows, summary, sourceHash, reviewHash, targets, revision: company.reconciliation?.revision || 0, canActivate: targets.length > 0 };
}

export function activateTallyBillReferences(current, book, records, input) {
  const meta = section(current);
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId || "")) throw new Error("Bill activation needs a valid save identifier");
  const company = { ...book.company, reconciliation: meta };
  const plan = planTallyBillReferences(company, book.vouchers, records);
  const requestHash = digest({ action: "tally-bills-activate", sourceHash: plan.sourceHash });
  const prior = meta.audit.find(entry => entry.requestId === input.requestId);
  if (prior) {
    if (prior.action !== "tally-bills-activate" || prior.requestHash !== requestHash) throw new Error("This save identifier belongs to another reconciliation change");
    return { section: meta, result: prior.result, replayed: true, report: plan };
  }
  if (input.revision !== meta.revision || (input.reviewHash && input.reviewHash !== plan.reviewHash)) throw new Error("The imported books changed after this bill review. Review the current references before activating them");
  if (!plan.canActivate) return { section: meta, result: { activatedBills: 0, activatedAllocations: 0 }, replayed: true, report: plan };
  const result = { id: newId("ti"), sourceHash: plan.sourceHash, activatedBills: plan.summary.billsReady, activatedAllocations: plan.summary.allocationsReady, reusedRows: plan.rows.filter(row => row.status === "reused").length };
  plan.meta.sourceActivations ||= [];
  plan.meta.sourceActivations.push({ id: result.id, system: "tally-bills", version: 1, sourceHash: plan.sourceHash, at: new Date().toISOString(), targets: plan.targets, summary: plan.summary });
  plan.meta.revision++;
  plan.meta.audit.push({ id: newId("ra"), requestId: input.requestId, requestHash, action: "tally-bills-activate", at: new Date().toISOString(), result });
  assertReconciliation({ ...book.company, reconciliation: plan.meta }, book.vouchers);
  return { section: plan.meta, result, replayed: false, report: plan };
}
