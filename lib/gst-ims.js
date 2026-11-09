// GSTR-2B month-end support: Invoice Management System (IMS) actions on statement rows,
// the ITC eligibility helper other modules read, and the rule 37 unpaid-supplier watch.
import { randomBytes } from "node:crypto";
import { fyStart, isIsoDate, todayISO } from "./money.js";
import { gstRequestHash, supplierDocDate } from "./gst.js";
import { itcState, ITC_COMPONENTS } from "./gst-itc.js";
import { billReport } from "./reconciliation-bills.js";
import { balanceAt, bookEntries, partySide } from "./reconciliation-common.js";

/*
 * IMS went live on the GST portal on 14-10-2024 for documents from October 2024
 * (GSTN advisories of 03-09-2024 and 14-10-2024; GSTN IMS FAQs of 17-10-2024;
 * section 38 CGST Act as substituted by the Finance (No. 2) Act, 2024 and rule 60 as
 * amended by Notification 20/2024-Central Tax). A recipient may accept, reject or keep a
 * document pending; a document left without action is deemed accepted when GSTR-2B is
 * generated. Rejected documents do not reach the ITC-available part of GSTR-2B and
 * pending documents are deferred to a later statement, so neither is available credit.
 */
export const IMS_ACTIONS = ["accept", "reject", "pending", "no-action"];
export const IMS_SOURCES = [
  { title: "GSTN advisories on the Invoice Management System (IMS), 03-09-2024 and 14-10-2024" },
  { title: "GSTN IMS FAQ: credit already reversed or never availed, 17-10-2024", url: "https://tutorial.gst.gov.in/downloads/news/additional_faqs_ims_17_10_2024.pdf" },
];
const LABEL = { accept: "accepted", reject: "rejected", pending: "kept pending", "no-action": "left without action" };
// Portal IMS status codes as carried on downloaded rows (A, R, P, N), or the words.
const PORTAL_CODES = { A: "accept", R: "reject", P: "pending", N: "no-action", ACCEPT: "accept", ACCEPTED: "accept", REJECT: "reject", REJECTED: "reject", PENDING: "pending", "NO-ACTION": "no-action", "NO ACTION": "no-action" };
const REQUEST_ID = /^[A-Za-z0-9-]{16,80}$/;
const SHA = /^[a-f0-9]{64}$/;

export function portalImsAction(code) {
  const text = String(code ?? "").trim().toUpperCase();
  return text ? PORTAL_CODES[text] ?? null : null;
}

/**
 * Pure helper for ITC consumers (lib/gst-itc.js may call it): false when the row's IMS
 * action, recorded here or carried from the portal, is reject or pending.
 */
export function imsEligible(row) {
  const recorded = row?.ims?.action;
  const action = recorded !== undefined && recorded !== null ? recorded : portalImsAction(row?.imsStatus);
  return action !== "reject" && action !== "pending";
}

export function imsDocumentKey(row) {
  return [row.gstin, row.type, String(row.number || "").trim().toUpperCase(), fyStart(row.date)].join("|");
}

function imsLedger(company) {
  const ims = company.gst?.ims;
  if (ims === undefined) return { version: 1, actions: [] };
  if (!ims || typeof ims !== "object" || ims.version !== 1 || !Array.isArray(ims.actions)) throw new Error("Invalid IMS action history");
  return ims;
}
export function imsActions(company) { return imsLedger(company).actions; }

const historyView = record => ({ id: record.id, action: record.action, at: record.at, reason: record.reason, recordedAt: record.recordedAt, statementId: record.statementId, requestId: record.requestId, previous: record.previous });
export function imsHistory(company, rowKey) {
  return imsLedger(company).actions.filter(row => row.rowKey === rowKey).sort((a, b) => a.sequence - b.sequence).map(historyView);
}

function latestBy(actions, field) {
  const result = new Map();
  for (const row of actions) if (!result.has(row[field]) || result.get(row[field]).sequence < row.sequence) result.set(row[field], row);
  return result;
}
const HEADS = ["taxable", "igst", "cgst", "sgst", "cess"];
const bucket = () => ({ count: 0, ...Object.fromEntries(HEADS.map(head => [head + "Paise", 0])) });

/**
 * Adds `ims: {action, at, reason, source}` and `itcAvailable` to every reconciliation row and
 * `imsCounts`, `itcAvailable` and `itcExcludedByIms` to the report. A row's own statement row key
 * wins; otherwise the latest action recorded on the same supplier document is inherited.
 */
export function attachIms(report, company, registrationId) {
  const actions = imsLedger(company).actions.filter(row => row.registrationId === registrationId);
  const byRow = latestBy(actions, "rowKey"), byDocument = latestBy(actions, "documentKey");
  const counts = Object.fromEntries([...IMS_ACTIONS, "none"].map(action => [action, 0]));
  const available = bucket(), excluded = bucket();
  for (const row of report.results) {
    if (row.portalValue === undefined) {
      row.ims = { action: null, at: null, reason: "", source: "none" };
      row.itcAvailable = false;
      continue;
    }
    const recorded = (row.statementRowKey && byRow.get(row.statementRowKey)) || byDocument.get(imsDocumentKey(row));
    if (recorded) {
      row.ims = { action: recorded.action, at: recorded.at, reason: recorded.reason, source: "recorded", recordId: recorded.id,
        ...(recorded.rowKey !== row.statementRowKey ? { inherited: true, statementId: recorded.statementId } : {}) };
    } else {
      const portal = portalImsAction(row.imsStatus);
      row.ims = { action: portal, at: null, reason: "", source: portal ? "portal" : "none" };
    }
    counts[row.ims.action || "none"]++;
    const statementAvailable = row.statementITC === "Y";
    row.itcAvailable = statementAvailable && imsEligible(row);
    if (!statementAvailable) continue;
    const target = row.itcAvailable ? available : excluded, sign = row.type === "Credit Note" ? -1 : 1;
    target.count++;
    for (const head of HEADS) target[head + "Paise"] += sign * (row.values?.[head]?.portal || 0);
  }
  report.imsCounts = counts;
  report.itcAvailable = available;
  report.itcExcludedByIms = excluded;
  return report;
}

function checkedRequestId(value) {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) throw new Error("Invalid IMS action save identifier");
  return value;
}
function imsRequestHash(input) {
  const { registration, statementId, rowKey, action, reason, at } = input;
  return gstRequestHash({ registration, statementId, rowKey, action, reason: typeof reason === "string" ? reason.trim() : reason, at });
}

/** Returns the saved result for a repeated request id, or null. */
export function replayedImsAction(company, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Enter an IMS action");
  const requestId = checkedRequestId(input.requestId);
  const prior = imsLedger(company).actions.find(row => row.requestId === requestId);
  if (!prior) return null;
  if (prior.requestHash !== imsRequestHash(input)) throw new Error("This save identifier already belongs to a different IMS action");
  return { replayed: true, result: { record: prior, ims: currentView(prior), history: imsHistory(company, prior.rowKey), replayed: true } };
}
const currentView = record => ({ action: record.action, at: record.at, reason: record.reason, source: "recorded", recordId: record.id });
const monthEnd = month => month + "-" + String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate()).padStart(2, "0");
const dmy = iso => iso.split("-").reverse().join("-");

/**
 * Builds one appended IMS action for a saved statement row. `context` is the saved statement
 * and its reconciled row (with statementRowKey). The caller asserts the GST period locks on
 * `lockDates`, applies `update` to its own company copy, writes and logs `entry`.
 */
export function buildImsAction(company, { statement, row }, input, now = new Date()) {
  const replay = replayedImsAction(company, input);
  if (replay) return replay;
  if (input.registration !== statement.registrationId) throw new Error("The statement belongs to a different GST registration");
  if (!row || row.portalValue === undefined || !SHA.test(row.statementRowKey || "")) throw new Error("Choose a document row from this statement");
  if (!IMS_ACTIONS.includes(input.action)) throw new Error("Choose accept, reject, pending or no-action for the IMS action");
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== "string") throw new Error("Enter the IMS reason as text");
  const reason = String(input.reason ?? "").trim().replace(/\s+/g, " ");
  if (reason.length > 240) throw new Error("Keep the IMS reason within 240 characters");
  // The books keep why a document was rejected or deferred, though the portal does not ask.
  if (["reject", "pending"].includes(input.action) && reason.length < 3) throw new Error("Give a reason for rejecting or keeping the document pending");
  const at = input.at === undefined || input.at === null || input.at === "" ? todayISO(now) : input.at;
  if (!isIsoDate(at)) throw new Error("Enter the date of the IMS action");
  if (at < row.date) throw new Error("The IMS action cannot precede the supplier document date");
  if (company.booksFrom && at < company.booksFrom) throw new Error("The IMS action cannot precede these books");
  const ledger = imsLedger(company);
  const current = latestBy(ledger.actions.filter(item => item.registrationId === statement.registrationId), "rowKey").get(row.statementRowKey);
  if (input.expected !== undefined) {
    const expected = input.expected?.recordId ?? null;
    if (expected !== (current?.id ?? null)) throw new Error("This document's IMS action changed while you were editing. Reopen it to review the latest action");
  }
  const record = { version: 1, id: `ims-${randomBytes(10).toString("hex")}`, sequence: Math.max(0, ...ledger.actions.map(item => item.sequence)) + 1,
    registrationId: statement.registrationId, statementId: statement.id, period: statement.month, rowKey: row.statementRowKey, documentKey: imsDocumentKey(row),
    document: { section: row.section, gstin: row.gstin, type: row.type, number: row.number, date: row.date },
    action: input.action, reason, at, recordedAt: now.toISOString(), previous: current ? { id: current.id, action: current.action } : null,
    requestId: input.requestId, requestHash: imsRequestHash(input) };
  return {
    replayed: false, record,
    // A filed return's period stays closed: both the action date and the statement month.
    lockDates: [at, monthEnd(statement.month)],
    update(target) { target.gst.ims = { version: 1, actions: [...imsActions(target), structuredClone(record)] }; },
    entry: { action: "create", entity: "gst-document", id: record.id, number: row.number,
      summary: `IMS: supplier document ${row.number} dated ${dmy(row.date)} from ${row.gstin} ${LABEL[record.action]} on ${dmy(at)} in the ${statement.month} GSTR-2B.${reason ? ` Reason: ${reason}` : ""}`,
      after: { action: record.action, at, reason, statementId: statement.id, rowKey: record.rowKey, previous: record.previous }, requestId: record.requestId },
    result: { record, ims: currentView(record), history: [...imsHistory(company, record.rowKey), historyView(record)], replayed: false },
  };
}

/** Shape and reference check for company.gst.ims; run with the statement library check. */
export function assertImsBook(company) {
  const { actions } = imsLedger(company);
  const ids = new Set(), requests = new Set(), sequences = new Set();
  for (const row of actions) {
    if (!row || typeof row !== "object" || row.version !== 1 || typeof row.id !== "string" || !/^ims-[a-f0-9]{20}$/.test(row.id) || ids.has(row.id) || requests.has(row.requestId) || sequences.has(row.sequence) ||
      !Number.isSafeInteger(row.sequence) || row.sequence < 1 || !REQUEST_ID.test(row.requestId || "") || !SHA.test(row.requestHash || "")) throw new Error("Duplicate or invalid IMS action identity");
    ids.add(row.id); requests.add(row.requestId); sequences.add(row.sequence);
    const statement = (company.gstStatements || []).find(item => item.id === row.statementId);
    if (!statement || statement.registrationId !== row.registrationId || statement.month !== row.period || !SHA.test(row.rowKey || "")) throw new Error("An IMS action is missing its saved statement row");
    if (!IMS_ACTIONS.includes(row.action) || typeof row.reason !== "string" || row.reason.length > 240 || (["reject", "pending"].includes(row.action) && row.reason.length < 3) ||
      !isIsoDate(row.at) || typeof row.recordedAt !== "string" || !Number.isFinite(Date.parse(row.recordedAt)) || typeof row.documentKey !== "string") throw new Error("Invalid IMS action details");
  }
  return true;
}

/*
 * Rule 37 watch. Second proviso to section 16(2) CGST Act and rule 37(1) CGST Rules as
 * substituted by Notification 19/2022-Central Tax (28-09-2022, from 01-10-2022): when a
 * recipient has not paid the supplier the value of a supply with tax within 180 days from
 * the invoice date, the ITC proportionate to the unpaid amount is added to output tax in
 * GSTR-3B for the tax period immediately following the period in which the 180 days end,
 * with interest under section 50. Section 50(3) charges interest only on credit wrongly
 * availed and utilised, at 18% a year (Notification 13/2017-Central Tax as amended by
 * Notification 9/2022-Central Tax). Reverse-charge supplies are outside the proviso.
 * Rule 37(2) restores the credit when the supplier is paid.
 */
export const RULE37_DAYS = 180;
export const RULE37_NOTICE_DAYS = 30;
export const RULE37_INTEREST_BPS = 1800;
export const RULE37_SOURCES = [
  { title: "CGST Act section 16(2), second proviso, and rule 37 CGST Rules as substituted by Notification 19/2022-Central Tax" },
  { title: "CGST Act section 50(3): interest at 18% a year (Notification 13/2017-Central Tax as amended by Notification 9/2022-Central Tax)" },
];
const DAY = 86400000;
const daysBetween = (from, to) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / DAY);
const addDays = (iso, days) => new Date(Date.parse(iso + "T00:00:00Z") + days * DAY).toISOString().slice(0, 10);
function followingMonth(iso) {
  const [y, m] = iso.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}
const zero = () => Object.fromEntries(ITC_COMPONENTS.map(key => [key + "Paise", 0]));
const componentTotal = value => ITC_COMPONENTS.reduce((sum, key) => sum + (value[key + "Paise"] || 0), 0);

// Claimed credit: the reviewed "claimable" balance; books that never used the ITC review
// desk took credit on purchases marked eligible when they were posted.
function claimedCredit(company, vouchers, asOf) {
  const reviewed = Boolean(company.gst?.itc?.records?.length);
  const state = itcState(company, vouchers, asOf);
  const claims = new Map();
  for (const record of state.records) {
    if (!["claim", "prior-claim", "reclaim"].includes(record.action)) continue;
    const date = record.action === "prior-claim" ? record.evidence?.priorClaimDate || record.date : record.date;
    if (!claims.has(record.invoiceId) || claims.get(record.invoiceId) > date) claims.set(record.invoiceId, date);
  }
  const result = new Map();
  for (const document of state.documents) {
    const credit = { ...document.balances.claimable };
    if (!reviewed && document.initialEligibility === "eligible") for (const key of ITC_COMPONENTS) credit[key + "Paise"] += document.balances.unclaimed[key + "Paise"];
    result.set(document.invoiceId, { credit, availedOn: claims.get(document.invoiceId) || (reviewed ? null : document.date) });
  }
  return result;
}

// Open amount per supplier document. A party that uses bill-wise references uses their open
// amounts; otherwise the party ledger balance settles the oldest credits first.
function supplierOpenAmounts(company, vouchers, ledgerId, asOf) {
  const account = company.ledgers.find(row => row.id === ledgerId);
  if (!account) throw new Error("The supplier ledger is missing");
  if (partySide(company, account) !== "payable") throw new Error("The supplier ledger is not under sundry creditors");
  const entries = bookEntries(company, vouchers, ledgerId).filter(entry => entry.date <= asOf);
  const posted = new Map(entries.map(entry => [entry.voucherId, -entry.amountPaise]));
  const meta = company.reconciliation;
  const billwise = Boolean(meta && ((meta.bills || []).some(row => row.ledgerId === ledgerId) || (meta.allocations || []).some(row => row.ledgerId === ledgerId)));
  const open = new Map();
  if (billwise) {
    const report = billReport({ ...meta, bills: meta.bills || [], allocations: meta.allocations || [] }, company, vouchers, asOf, ledgerId);
    for (const row of report.rows) if (row.voucherId) open.set(row.voucherId, (open.get(row.voucherId) || 0) + row.openPaise);
    for (const row of report.unreferenced) if (row.voucherId) open.set(row.voucherId, (open.get(row.voucherId) || 0) + row.remainingPaise);
  } else {
    let remaining = Math.max(0, -balanceAt(company, vouchers, ledgerId, asOf));
    const credits = entries.map((entry, index) => ({ ...entry, index })).filter(entry => entry.amountPaise < 0)
      .sort((a, b) => b.date.localeCompare(a.date) || b.index - a.index);
    for (const entry of credits) {
      const amount = Math.min(-entry.amountPaise, remaining);
      remaining -= amount;
      open.set(entry.voucherId, amount);
    }
  }
  return { basis: billwise ? "bill-wise" : "ledger", posted, open };
}

const share = (value, part, whole) => Number((BigInt(value) * BigInt(part) * 2n + BigInt(whole)) / (2n * BigInt(whole)));

/**
 * Purchase documents with ITC claimed whose supplier is unpaid more than 180 days after the
 * supplier invoice date (`rows`), and those within 30 days of it (`approaching`), as at `asOf`.
 */
export function rule37Watch(company, vouchers, asOf, { registrationId = "" } = {}) {
  if (!isIsoDate(asOf)) throw new Error("Choose the rule 37 review date");
  const totals = { ...zero(), totalPaise: 0 };
  const report = { asOf, days: RULE37_DAYS, rows: [], approaching: [], totals, issues: [], sources: RULE37_SOURCES };
  if (!company.booksFrom || asOf < company.booksFrom) return report;
  const candidates = vouchers.filter(voucher => {
    const invoice = voucher.gst;
    return invoice && invoice.id === voucher.id && invoice.direction === "purchase" && !invoice.reverseCharge && ["Purchase", "Debit Note"].includes(invoice.type) &&
      (!registrationId || invoice.registrationId === registrationId) && invoice.date <= asOf && daysBetween(supplierDocDate(invoice), asOf) > RULE37_DAYS - RULE37_NOTICE_DAYS;
  });
  if (!candidates.length) return report;
  const claimed = claimedCredit(company, vouchers, asOf);
  const parties = new Map();
  for (const voucher of candidates) {
    const invoice = voucher.gst, ledgerId = invoice.party?.supplierLedgerId;
    const claim = claimed.get(invoice.id);
    if (!claim || !componentTotal(claim.credit)) continue;
    if (!parties.has(ledgerId)) {
      try { parties.set(ledgerId, supplierOpenAmounts(company, vouchers, ledgerId, asOf)); }
      catch (error) { parties.set(ledgerId, { error: error.message }); }
    }
    const party = parties.get(ledgerId);
    if (party.error) { report.issues.push({ invoiceId: invoice.id, message: `${invoice.number}: ${party.error}. Check the supplier ledger before reviewing rule 37.` }); continue; }
    const postedPaise = party.posted.get(voucher.id) || 0;
    if (postedPaise <= 0) { report.issues.push({ invoiceId: invoice.id, message: `${invoice.number} does not credit its supplier ledger, so its payment status is unknown.` }); continue; }
    const unpaidPaise = Math.min(postedPaise, party.open.get(voucher.id) || 0);
    if (unpaidPaise <= 0) continue;
    const supplierInvoiceDate = supplierDocDate(invoice), daysOutstanding = daysBetween(supplierInvoiceDate, asOf), deadline = addDays(supplierInvoiceDate, RULE37_DAYS);
    const itcToReverse = Object.fromEntries(ITC_COMPONENTS.map(key => [key + "Paise", share(claim.credit[key + "Paise"], unpaidPaise, postedPaise)]));
    const principalPaise = componentTotal(itcToReverse);
    const fromDate = claim.availedOn || invoice.date, interestDays = Math.max(0, daysBetween(fromDate, asOf));
    const row = { invoiceId: invoice.id, number: invoice.number, type: invoice.type, registrationId: invoice.registrationId, partyId: invoice.partyId, partyName: invoice.party?.name || "",
      partyLedgerId: ledgerId, supplierInvoiceNumber: invoice.supplierInvoiceNumber || "", supplierInvoiceDate, bookDate: invoice.date, daysOutstanding, deadline,
      reversalPeriod: followingMonth(deadline), basis: party.basis, postedPaise, unpaidPaise, itcClaimed: claim.credit, itcToReverse, itcToReversePaise: principalPaise,
      interest: { section: "50(3)", rateBps: RULE37_INTEREST_BPS, principalPaise, fromDate, toDate: asOf, days: interestDays,
        indicativePaise: Number((BigInt(principalPaise) * BigInt(RULE37_INTEREST_BPS) * BigInt(interestDays) * 2n + 3650000n) / 7300000n),
        note: "Interest runs from the date the credit was availed to the date it is reversed, and only on credit actually utilised." } };
    if (daysOutstanding > RULE37_DAYS) {
      report.rows.push(row);
      for (const key of ITC_COMPONENTS) totals[key + "Paise"] += itcToReverse[key + "Paise"];
      totals.totalPaise += principalPaise;
    } else report.approaching.push(row);
  }
  const order = (a, b) => a.supplierInvoiceDate.localeCompare(b.supplierInvoiceDate) || a.number.localeCompare(b.number);
  report.rows.sort(order); report.approaching.sort(order);
  return report;
}
