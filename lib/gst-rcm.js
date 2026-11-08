import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isCashBank } from "./engine.js";
import { fyStart, isIsoDate, todayISO } from "./money.js";

export const RCM_COMPONENTS = ["cgst", "sgst", "utgst", "igst", "cess"];
const ACTIONS = new Set(["supplier-payment", "supplier-refund", "cash-deposit", "cash-refund", "tax-payment", "tax-refund", "tax-recredit", "itc-claim", "itc-reversal", "expense", "expense-reversal"]);
const zero = () => Object.fromEntries(RCM_COMPONENTS.map((key) => [`${key}Paise`, 0]));
const components = (source = {}) => Object.fromEntries(RCM_COMPONENTS.map((key) => [`${key}Paise`, amount(source[`${key}Paise`] ?? 0)]));
const total = (source) => checked(RCM_COMPONENTS.reduce((sum, key) => sum + BigInt(source[`${key}Paise`] || 0), 0n));
const checked = (value) => { if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) throw new Error("The RCM amount exceeds exact paise"); return Number(value); };
const amount = (value) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error("Enter a non-negative RCM amount in paise"); return value; };
const round = (numerator, denominator) => Number((numerator + denominator / 2n) / denominator);
const add = (target, source, sign = 1) => { for (const key of RCM_COMPONENTS) target[`${key}Paise`] = checked(BigInt(target[`${key}Paise`]) + BigInt(source[`${key}Paise`] || 0) * BigInt(sign)); return target; };
const signOf = (invoice) => invoice.type === "Credit Note" ? -1 : 1;
const text = (value, label, maximum = 240) => { if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`Enter ${label} within ${maximum} characters`); return value.trim(); };
const date = (value, label) => { if (!isIsoDate(value)) throw new Error(`Enter ${label}`); return value; };
const minDate = (values) => values.filter(Boolean).sort()[0];
function plusDays(value, days) { const result = new Date(`${value}T00:00:00Z`); result.setUTCDate(result.getUTCDate() + days); return result.toISOString().slice(0, 10); }
function requestHash(input) {
  const order = (value) => Array.isArray(value) ? value.map(order) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, order(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(order(input))).digest("hex");
}

export function ensureRcmAccounts(company, registrationId) {
  const registration = company.gst?.registrations.find((entry) => entry.id === registrationId);
  if (!registration) throw new Error("Choose a saved GST registration");
  company.gst.rcm ||= { version: 1, accountsByRegistration: {} };
  const existing = company.gst.rcm.accountsByRegistration[registrationId];
  if (existing) return existing;
  const accounts = {};
  for (const component of RCM_COMPONENTS) {
    for (const [role, groupId, label] of [["pending", "g-current-assets", "RCM pending"], ["liability", "g-duties", "RCM payable"], ["cash", "g-current-assets", "GST cash control"]]) {
      const id = `l-rcm-${randomBytes(8).toString("hex")}`;
      const name = `${registration.invoicePrefix} ${label} ${component.toUpperCase()}`;
      if (company.ledgers.some((ledger) => ledger.name.toLowerCase() === name.toLowerCase())) throw new Error("An RCM posting ledger name already exists");
      company.ledgers.push({ id, name, groupId, opening: { dc: "Dr", paise: 0 } });
      accounts[`${role}-${component}`] = id;
    }
  }
  company.gst.rcm.accountsByRegistration[registrationId] = accounts;
  return accounts;
}

export function rcmAccountIds(company) {
  return new Set(Object.values(company.gst?.rcm?.accountsByRegistration || {}).flatMap((accounts) => Object.values(accounts)));
}

function nextSequence(vouchers) {
  return vouchers.reduce((maximum, voucher) => Math.max(maximum, voucher.gst?.rcm?.sequence || voucher.gstRcm?.sequence || 0), 0) + 1;
}

export function buildRcmSnapshot(company, invoice, input, vouchers = [], savedSequence) {
  if (!invoice.reverseCharge) return undefined;
  const source = input.rcm || {};
  if (source.applicabilityConfirmed !== true) throw new Error("Confirm the applicable RCM legal basis for this supply");
  const basisReference = text(source.basisReference, "the RCM section and notification reference");
  const inward = invoice.direction === "purchase";
  if (invoice.supplyCategory !== "domestic") throw new Error("Choose domestic supply treatment for this RCM invoice");
  if (invoice.pricing !== "exclusive") throw new Error("Enter RCM consideration as a tax-exclusive taxable value");
  if (inward && invoice.party.stateCode === "96" && !invoice.items.every((item) => item.kind === "service")) throw new Error("Imported goods require bill-of-entry accounting");
  if (!inward && !invoice.party.gstin) throw new Error("Enter the recipient GSTIN for an outward RCM invoice");
  const accounts = company.gst?.rcm?.accountsByRegistration?.[invoice.registrationId];
  if (!accounts) throw new Error("Set up the RCM workspace for this registration before posting");
  const note = ["Credit Note", "Debit Note"].includes(invoice.type);
  if (note && !invoice.originalInvoiceId) throw new Error("Link an RCM note to its original invoice in these books");
  const receiptDate = inward ? date(source.receiptDate, "the goods or services receipt date") : null;
  const supplierInvoiceDate = inward ? date(source.supplierInvoiceDate || invoice.date, "the supplier document date") : null;
  const bookEntryDate = inward ? date(source.bookEntryDate || invoice.date, "the books entry date") : null;
  if (inward && [receiptDate, supplierInvoiceDate, bookEntryDate].some((entry) => entry > invoice.date)) throw new Error("RCM receipt and source-document dates must be on or before this document date");
  const selfInvoiceRequired = inward && !invoice.party.gstin && !note;
  const selfInvoiceDate = selfInvoiceRequired ? date(source.selfInvoiceDate || invoice.date, "the self-invoice date") : null;
  if (selfInvoiceRequired && selfInvoiceDate !== invoice.date) throw new Error("The self-invoice date must match this document date");
  const associatedEnterprise = source.associatedEnterprise === true;
  if (associatedEnterprise && !(inward && invoice.party.stateCode === "96" && invoice.items.every((item) => item.kind === "service"))) throw new Error("The associated-enterprise timing option applies to imported services");
  const buckets = [];
  for (const kind of ["goods", "service"]) {
    const items = invoice.items.filter((item) => item.kind === kind);
    if (!items.length) continue;
    const bucket = { kind, taxablePaise: checked(items.reduce((sum, item) => sum + BigInt(item.taxablePaise), 0n)), components: zero(), baselineDate: null };
    for (const item of items) add(bucket.components, item);
    if (inward) {
      if (note) bucket.baselineDate = invoice.date;
      else if (kind === "goods") bucket.baselineDate = minDate([receiptDate, plusDays(supplierInvoiceDate, 31)]);
      else if (associatedEnterprise) bucket.baselineDate = bookEntryDate;
      else if (selfInvoiceRequired && invoice.date >= "2024-11-01") bucket.baselineDate = selfInvoiceDate;
      else bucket.baselineDate = plusDays(supplierInvoiceDate, 61);
    }
    buckets.push(bucket);
  }
  return {
    version: 1, sequence: savedSequence ?? nextSequence(vouchers), importOfServices: inward && invoice.party.stateCode === "96", direction: inward ? "inward" : "outward", applicabilityConfirmed: true, basisReference,
    receiptDate, supplierInvoiceDate, bookEntryDate, selfInvoiceRequired, selfInvoiceDate,
    selfInvoiceNumber: selfInvoiceRequired ? invoice.number : null, associatedEnterprise,
    liabilityDate: inward ? minDate(buckets.map((bucket) => bucket.baselineDate)) : null,
    lateSelfInvoice: Boolean(selfInvoiceRequired && invoice.date >= "2024-11-01" && selfInvoiceDate > plusDays(receiptDate, 30)),
    accounts: structuredClone(accounts), buckets,
  };
}

export function assertRcmInvoice(company, invoice) {
  if (!invoice.reverseCharge) {
    if (invoice.rcm !== undefined || invoice.partyDuePaise !== undefined) throw new Error("Forward-charge invoice contains RCM state");
    return;
  }
  if (!Number.isSafeInteger(invoice.rcm?.sequence) || invoice.rcm.sequence < 1) throw new Error("Invalid RCM journal sequence");
  const expected = buildRcmSnapshot(company, invoice, { rcm: invoice.rcm }, [], invoice.rcm.sequence);
  if (!isDeepStrictEqual(expected, invoice.rcm) || invoice.partyDuePaise !== invoice.totals.taxablePaise) throw new Error("The RCM invoice facts or party amount do not match the saved calculation");
}

export function rcmPostingLines(invoice) {
  const output = invoice.direction === "sales";
  const reverse = invoice.type === "Credit Note";
  const baseSide = output ? "Cr" : "Dr";
  const side = reverse ? (baseSide === "Dr" ? "Cr" : "Dr") : baseSide;
  const opposite = side === "Dr" ? "Cr" : "Dr";
  const lines = [];
  const push = (ledgerId, dc, paise) => { if (paise) lines.push({ ledgerId, dc, paise }); };
  push(output ? invoice.party.customerLedgerId : invoice.party.supplierLedgerId, opposite, invoice.totals.taxablePaise);
  push(invoice.registration.accounts[output ? "sales" : "purchase"], side, invoice.totals.taxablePaise);
  if (!output) for (const component of RCM_COMPONENTS) {
    push(invoice.rcm.accounts[`pending-${component}`], side, invoice.totals[`${component}Paise`]);
    push(invoice.rcm.accounts[`liability-${component}`], opposite, invoice.totals[`${component}Paise`]);
  }
  return lines;
}

function invoices(vouchers) { return vouchers.filter((voucher) => voucher.gst?.reverseCharge).map((voucher) => voucher.gst); }
function rootId(invoice) { return invoice.type === "Debit Note" || invoice.type === "Credit Note" ? invoice.originalInvoiceId : invoice.id; }
function positiveInvoices(vouchers) { return invoices(vouchers).filter((invoice) => invoice.direction === "purchase" && invoice.type !== "Credit Note"); }
function familyCredits(vouchers, originalId, to) { return invoices(vouchers).filter((invoice) => invoice.direction === "purchase" && invoice.type === "Credit Note" && invoice.originalInvoiceId === originalId && (!to || invoice.date <= to)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)); }
function records(vouchers, to) { return vouchers.filter((voucher) => voucher.gstRcm && (!to || voucher.gstRcm.date <= to)).map((voucher) => voucher.gstRcm); }

function creditAllocations(vouchers, originalId, to) {
  const positives = positiveInvoices(vouchers).filter((invoice) => rootId(invoice) === originalId).sort((a, b) => a.date.localeCompare(b.date) || a.rcm.sequence - b.rcm.sequence);
  const remaining = new Map(positives.flatMap((invoice) => invoice.rcm.buckets.map((bucket) => [`${invoice.id}:${bucket.kind}`, { base: bucket.taxablePaise, ...components(bucket.components) }])));
  const allocations = [];
  for (const note of familyCredits(vouchers, originalId, to)) {
    for (const bucket of note.rcm.buckets) {
      const available = positives.filter((invoice) => invoice.date <= note.date && remaining.has(`${invoice.id}:${bucket.kind}`));
      const outstanding = { base: bucket.taxablePaise, ...components(bucket.components) };
      for (const invoice of available) {
        const left = remaining.get(`${invoice.id}:${bucket.kind}`);
        const allocation = { invoiceId: invoice.id, creditNoteId: note.id, date: note.date, kind: bucket.kind, taxablePaise: Math.min(left.base, outstanding.base), components: zero() };
        left.base -= allocation.taxablePaise;
        outstanding.base -= allocation.taxablePaise;
        for (const component of RCM_COMPONENTS) {
          const key = `${component}Paise`;
          const applied = Math.min(left[key], outstanding[key]);
          allocation.components[key] = applied;
          left[key] -= applied;
          outstanding[key] -= applied;
        }
        if (allocation.taxablePaise || total(allocation.components)) allocations.push(allocation);
      }
      if (outstanding.base || total(outstanding)) throw new Error("RCM credit notes exceed the linked family's assessed supply kind, taxable value or tax components");
    }
  }
  return allocations;
}

function invoicePosition(company, vouchers, invoice, to, knownLiabilityRows) {
  const related = records(vouchers, to).filter((record) => record.invoiceId === invoice.id);
  const credits = creditAllocations(vouchers, rootId(invoice), to).filter((allocation) => allocation.invoiceId === invoice.id);
  const netTax = components(invoice.totals);
  let netBase = invoice.totals.taxablePaise;
  for (const credit of credits) { add(netTax, credit.components, -1); netBase -= credit.taxablePaise; }
  const paid = zero(), claimed = zero(), expensed = zero();
  let supplierPaid = 0;
  for (const record of related) {
    if (record.action === "supplier-payment") supplierPaid += record.amountPaise;
    if (record.action === "supplier-refund") supplierPaid -= record.amountPaise;
    if (["tax-payment", "tax-refund", "tax-recredit"].includes(record.action)) add(paid, record.components, record.action === "tax-payment" ? 1 : -1);
    if (["itc-claim", "itc-reversal"].includes(record.action)) add(claimed, record.components, record.action === "itc-claim" ? 1 : -1);
    if (["expense", "expense-reversal"].includes(record.action)) add(expensed, record.components, record.action === "expense" ? 1 : -1);
  }
  const recognizedTax = zero();
  for (const row of knownLiabilityRows || rcmLiabilityRows(company, vouchers, null, to)) if (row.invoiceId === invoice.id) add(recognizedTax, row);
  const due = zero(), overpaid = zero(), availableCredit = zero(), reversalRequired = zero(), expenseReversalRequired = zero(), pending = zero(), earlyTaxPaid = zero();
  for (const component of RCM_COMPONENTS) {
    const key = `${component}Paise`;
    due[key] = Math.max(0, netTax[key] - paid[key]);
    overpaid[key] = Math.max(0, paid[key] - netTax[key]);
    availableCredit[key] = Math.max(0, Math.min(netTax[key], paid[key], Math.max(0, recognizedTax[key])) - claimed[key] - expensed[key]);
    reversalRequired[key] = Math.max(0, claimed[key] - Math.min(paid[key], netTax[key], Math.max(0, recognizedTax[key])));
    expenseReversalRequired[key] = Math.max(0, expensed[key] - Math.max(0, netTax[key] - claimed[key]));
    pending[key] = netTax[key] - claimed[key] - expensed[key];
    earlyTaxPaid[key] = Math.max(0, paid[key] - Math.max(0, recognizedTax[key]));
  }
  return { invoice, netTax, netBase, supplierPaid, supplierDue: Math.max(0, netBase - supplierPaid), supplierOverpaid: Math.max(0, supplierPaid - netBase), paid, claimed, expensed, due, overpaid, availableCredit, reversalRequired, expenseReversalRequired, pending, recognizedTax, earlyTaxPaid };
}

function proportion(source, numerator, denominator) {
  if (!denominator) return zero();
  return Object.fromEntries(RCM_COMPONENTS.map((component) => [`${component}Paise`, round(BigInt(source[`${component}Paise`]) * BigInt(numerator), BigInt(denominator))]));
}

export function rcmLiabilityRows(company, vouchers, from, to) {
  const rows = [];
  const positives = positiveInvoices(vouchers);
  const creditsByFamily = new Map();
  for (const invoice of positives) if (!creditsByFamily.has(rootId(invoice))) creditsByFamily.set(rootId(invoice), creditAllocations(vouchers, rootId(invoice), to));
  for (const invoice of positives) {
    const payments = records(vouchers, to).filter((record) => record.invoiceId === invoice.id && record.action === "supplier-payment");
    // Payments are explicitly allocated pro rata across this document's taxable consideration.
    const state = invoice.rcm.buckets.map((bucket) => ({ ...structuredClone(bucket), unpaidBase: bucket.taxablePaise, unrecognizedBase: bucket.taxablePaise, unrecognizedTax: components(bucket.components) }));
    const events = [
      ...state.map((bucket, index) => ({ kind: "baseline", date: bucket.baselineDate, index })),
      ...payments.map((record) => ({ kind: "payment", date: minDate([record.date, record.bankDebitDate]), record })),
      ...(creditsByFamily.get(rootId(invoice)) || []).filter((credit) => credit.invoiceId === invoice.id).map((credit) => ({ kind: "credit", date: credit.date, credit })),
    ].filter((event) => !to || event.date <= to).sort((a, b) => a.date.localeCompare(b.date) || ({ credit: 0, payment: 1, baseline: 2 }[a.kind] - { credit: 0, payment: 1, baseline: 2 }[b.kind]));
    const append = (event, taxablePaise, tax) => {
      if ((!from || event.date >= from) && (taxablePaise || RCM_COMPONENTS.some((component) => tax[`${component}Paise`]))) rows.push({ invoiceId: invoice.id, registrationId: invoice.registrationId, date: event.date, reason: event.kind, taxablePaise, ...tax });
    };
    for (const event of events) {
      if (event.kind === "baseline") {
        const bucket = state[event.index];
        append(event, bucket.unrecognizedBase, bucket.unrecognizedTax);
        bucket.unrecognizedBase = 0;
        bucket.unrecognizedTax = zero();
      } else if (event.kind === "payment") {
        const available = state.reduce((sum, bucket) => sum + bucket.unpaidBase, 0);
        let remaining = Math.min(event.record.amountPaise, available);
        for (let index = 0; index < state.length; index++) {
          const bucket = state[index];
          const paidBase = index === state.length - 1 ? Math.min(remaining, bucket.unpaidBase) : Math.min(remaining, bucket.unpaidBase, round(BigInt(Math.min(event.record.amountPaise, available)) * BigInt(bucket.unpaidBase), BigInt(available || 1)));
          remaining -= paidBase;
          const acceleratedBase = Math.min(paidBase, bucket.unrecognizedBase);
          const tax = proportion(bucket.unrecognizedTax, acceleratedBase, bucket.unrecognizedBase);
          append(event, acceleratedBase, tax);
          bucket.unpaidBase -= paidBase;
          bucket.unrecognizedBase -= acceleratedBase;
          add(bucket.unrecognizedTax, tax, -1);
        }
      } else {
        let base = event.credit.taxablePaise;
        const tax = components(event.credit.components);
        const recognizedCredit = zero();
        let recognizedBase = 0;
        for (const bucket of state.filter((entry) => entry.kind === event.credit.kind)) {
          const baseReduction = Math.min(base, bucket.taxablePaise);
          const pendingReduction = Math.min(baseReduction, bucket.unrecognizedBase);
          recognizedBase += baseReduction - pendingReduction;
          bucket.taxablePaise -= baseReduction;
          bucket.unpaidBase = Math.max(0, bucket.unpaidBase - baseReduction);
          bucket.unrecognizedBase -= pendingReduction;
          base -= baseReduction;
          for (const component of RCM_COMPONENTS) {
            const key = `${component}Paise`;
            const reduction = Math.min(tax[key], bucket.components[key]);
            const pendingReductionTax = Math.min(reduction, bucket.unrecognizedTax[key]);
            recognizedCredit[key] += reduction - pendingReductionTax;
            bucket.components[key] -= reduction;
            bucket.unrecognizedTax[key] -= pendingReductionTax;
            tax[key] -= reduction;
          }
        }
        append(event, -recognizedBase, Object.fromEntries(Object.entries(recognizedCredit).map(([key, entry]) => [key, -entry])));
      }
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export function rcmReturnRows(company, vouchers, from, to) {
  const byId = new Map(invoices(vouchers).map((invoice) => [invoice.id, invoice]));
  return records(vouchers, to).filter((record) => (!from || record.date >= from) && ["itc-claim", "itc-reversal"].includes(record.action)).map((record) => ({ invoiceId: record.invoiceId, registrationId: record.registrationId, action: record.action, date: record.date, importOfServices: byId.get(record.invoiceId)?.rcm?.importOfServices === true, reversalReason: record.action === "itc-reversal" ? record.reversalReason || "unclassified" : undefined, ...record.components }));
}

function ledgerBalance(company, vouchers, ledgerId, to) {
  const ledger = company.ledgers.find((entry) => entry.id === ledgerId);
  let balance = BigInt(ledger.opening?.paise || 0) * (ledger.opening?.dc === "Cr" ? -1n : 1n);
  for (const voucher of vouchers) if (voucher.date <= to) for (const line of voucher.lines) if (line.ledgerId === ledgerId) balance += BigInt(line.paise) * (line.dc === "Dr" ? 1n : -1n);
  return checked(balance);
}

export function rcmState(company, vouchers, to = todayISO()) {
  const liabilityRows = rcmLiabilityRows(company, vouchers, null, to);
  const dueByInvoice = new Map();
  for (const row of liabilityRows) {
    if (!dueByInvoice.has(row.invoiceId)) dueByInvoice.set(row.invoiceId, zero());
    add(dueByInvoice.get(row.invoiceId), row);
  }
  const documents = positiveInvoices(vouchers).filter((invoice) => invoice.date <= to).map((invoice) => {
    const position = invoicePosition(company, vouchers, invoice, to, liabilityRows);
    const { invoice: source, ...numbers } = position;
    const statutoryDue = Object.fromEntries(RCM_COMPONENTS.map((component) => [`${component}Paise`, Math.max(0, (dueByInvoice.get(invoice.id)?.[`${component}Paise`] || 0) - position.paid[`${component}Paise`])]));
    return { id: source.id, number: source.number, date: source.date, registrationId: source.registrationId, partyId: source.partyId, partyName: source.party.name, liabilityDate: source.rcm.liabilityDate, selfInvoiceRequired: source.rcm.selfInvoiceRequired, lateSelfInvoice: source.rcm.lateSelfInvoice, statutoryDue, ...numbers };
  });
  const accounts = company.gst?.rcm?.accountsByRegistration || {};
  const cashIds = new Set(Object.values(accounts).flatMap((ids) => RCM_COMPONENTS.map((component) => ids[`cash-${component}`])));
  const balances = new Map(company.ledgers.filter((ledger) => cashIds.has(ledger.id)).map((ledger) => [ledger.id, BigInt(ledger.opening?.paise || 0) * (ledger.opening?.dc === "Cr" ? -1n : 1n)]));
  for (const voucher of vouchers) if (voucher.date <= to) for (const line of voucher.lines) if (balances.has(line.ledgerId)) balances.set(line.ledgerId, balances.get(line.ledgerId) + BigInt(line.paise) * (line.dc === "Dr" ? 1n : -1n));
  const cash = Object.fromEntries(Object.entries(accounts).map(([registrationId, ids]) => [registrationId, Object.fromEntries(RCM_COMPONENTS.map((component) => [`${component}Paise`, checked(balances.get(ids[`cash-${component}`]) || 0n)]))]));
  return { documents, records: records(vouchers, to), cash, liabilityRows };
}

function requireComponents(input, available, label) {
  const selected = components(input);
  if (!total(selected)) throw new Error(`Enter ${label}`);
  for (const component of RCM_COMPONENTS) {
    const key = `${component}Paise`;
    if (available && selected[key] > Math.max(0, available[key])) throw new Error(`${component.toUpperCase()} exceeds ${label}`);
  }
  return selected;
}

export function buildRcmAction(company, vouchers, action, input) {
  if (!ACTIONS.has(action)) throw new Error("Choose an RCM bookkeeping action");
  if (typeof input.requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) throw new Error("Use a valid RCM save identifier");
  const digest = requestHash({ action, ...input });
  const prior = vouchers.find((voucher) => voucher.gstRcm?.requestId === input.requestId);
  if (prior) {
    if (prior.gstRcm.requestHash !== digest) throw new Error("That RCM save identifier belongs to a different request");
    return { voucher: prior, record: prior.gstRcm, replayed: true };
  }
  const invoice = positiveInvoices(vouchers).find((entry) => entry.id === input.invoiceId);
  if (!invoice) throw new Error("Choose an inward RCM invoice or debit note");
  const actionDate = date(input.date, "the RCM bookkeeping date");
  if (actionDate < company.booksFrom) throw new Error("The RCM entry is before these books begin");
  const reference = text(input.reference, "the payment, discharge or eligibility review reference", 120);
  const accounts = company.gst?.rcm?.accountsByRegistration?.[invoice.registrationId];
  if (!accounts) throw new Error("Set up the RCM accounts for this registration");
  const position = invoicePosition(company, vouchers, invoice, actionDate);
  const id = `v-rcm-${randomBytes(8).toString("hex")}`;
  const documentDate = action === "supplier-payment" && input.bankDebitDate ? minDate([actionDate, date(input.bankDebitDate, "the bank debit date")]) : actionDate;
  const fy = fyStart(documentDate).slice(2, 4);
  const stem = `${invoice.registration.invoicePrefix}${action === "supplier-payment" ? "V" : "R"}${fy}`;
  let sequence = vouchers.filter((voucher) => voucher.gstRcm?.registrationId === invoice.registrationId && voucher.number.startsWith(`${stem}/`) && fyStart(voucher.gstRcm.documentDate || voucher.date) === fyStart(documentDate)).length + 1;
  let number = `${stem}/${String(sequence).padStart(6, "0")}`;
  while (vouchers.some((voucher) => voucher.number === number)) number = `${stem}/${String(++sequence).padStart(6, "0")}`;
  const record = { version: 1, sequence: nextSequence(vouchers), id, action, invoiceId: invoice.id, registrationId: invoice.registrationId, partyId: invoice.partyId, date: actionDate, documentDate, number, reference, requestId: input.requestId, requestHash: digest, components: zero(), amountPaise: 0, input: structuredClone(input) };
  const lines = [];
  const push = (ledgerId, dc, paise) => { if (paise) lines.push({ ledgerId, dc, paise }); };
  const debit = (ledgerId, paise) => push(ledgerId, "Dr", paise);
  const credit = (ledgerId, paise) => push(ledgerId, "Cr", paise);
  let type = "Journal";
  const bankActions = new Set(["supplier-payment", "supplier-refund", "cash-deposit", "cash-refund", "tax-refund"]);
  if (bankActions.has(action)) {
    const bank = company.ledgers.find((ledger) => ledger.id === input.bankLedgerId);
    if (!bank || !isCashBank(company.groups, bank.groupId)) throw new Error("Choose a cash or bank ledger");
    record.bankLedgerId = bank.id;
  }
  if (["supplier-payment", "supplier-refund"].includes(action)) {
    const maximum = action === "supplier-payment" ? position.supplierDue : position.supplierOverpaid;
    const value = amount(input.amountPaise);
    if (!value || value > maximum) throw new Error("The supplier settlement exceeds this document's remaining amount");
    record.amountPaise = value;
    record.components = proportion(position.netTax, value, position.netBase);
    record.bankDebitDate = input.bankDebitDate ? date(input.bankDebitDate, "the bank debit date") : actionDate;
    if (input.allocationMethod !== "pro-rata") throw new Error("Confirm proportionate allocation of this supplier payment across the document");
    record.allocationMethod = "pro-rata";
    if (action === "supplier-payment") { type = "Payment"; debit(invoice.party.supplierLedgerId, value); credit(record.bankLedgerId, value); }
    else { type = "Receipt"; debit(record.bankLedgerId, value); credit(invoice.party.supplierLedgerId, value); }
  } else {
    let available;
    if (action === "itc-claim") available = position.availableCredit;
    if (action === "itc-reversal") available = position.claimed;
    if (action === "expense") available = Object.fromEntries(RCM_COMPONENTS.map((component) => [`${component}Paise`, Math.max(0, position.pending[`${component}Paise`])]));
    if (action === "expense-reversal") available = position.expensed;
    if (["tax-refund", "tax-recredit"].includes(action)) available = position.overpaid;
    if (["cash-refund", "tax-payment"].includes(action)) available = Object.fromEntries(RCM_COMPONENTS.map((component) => [`${component}Paise`, Math.max(0, ledgerBalance(company, vouchers, accounts[`cash-${component}`], actionDate))]));
    record.components = requireComponents(input.components, available, action);
    record.amountPaise = total(record.components);
    if (action === "tax-payment") {
      if (input.evidenceType !== "cash-ledger-debit") throw new Error("Record the electronic cash ledger debit reference for an actual tax discharge");
      record.evidenceType = input.evidenceType;
      record.earlyDischargeComponents = zero();
      for (const component of RCM_COMPONENTS) {
        const key = `${component}Paise`;
        if (record.components[key] > position.due[key]) throw new Error("Tax discharge exceeds this document's assessed outstanding RCM liability");
        record.earlyDischargeComponents[key] = Math.max(0, record.components[key] - Math.max(0, position.recognizedTax[key] - position.paid[key]));
      }
      record.earlyDischarge = total(record.earlyDischargeComponents) > 0;
    }
    if (action === "itc-reversal") {
      const reasons = ["credit-note", "permanent-ineligibility", "temporary-reversal", "time-barred", "unclassified"];
      const reason = input.reversalReason || (total(position.reversalRequired) > 0 ? "credit-note" : "unclassified");
      if (!reasons.includes(reason)) throw new Error("Choose the RCM credit reversal reason");
      record.reversalReason = reason;
    }
    if (action === "itc-claim") {
      const review = input.review;
      if (!review || ["received", "businessUse", "notBlocked", "documentsHeld"].some((key) => review[key] !== true)) throw new Error("Complete the receipt, business-use, blocked-credit and document eligibility review");
      const basis = text(review.basis, "the ITC eligibility basis");
      const sourceDate = invoice.type === "Debit Note" ? invoice.date : invoice.rcm.selfInvoiceRequired ? invoice.rcm.selfInvoiceDate : invoice.rcm.supplierInvoiceDate;
      const cutoff = `${Number(fyStart(sourceDate).slice(0, 4)) + 1}-11-30`;
      const annual = review.annualReturnFiledDate ? date(review.annualReturnFiledDate, "the annual return filing date") : null;
      if (actionDate > minDate([cutoff, annual])) throw new Error("The ITC review date is after the recorded section16(4) limit");
      if (actionDate < invoice.rcm.receiptDate || actionDate < sourceDate) throw new Error("ITC requires receipt of the supply and its invoice document");
      record.review = { received: true, businessUse: true, notBlocked: true, documentsHeld: true, basis, annualReturnFiledDate: annual };
    }
    for (const component of RCM_COMPONENTS) {
      const value = record.components[`${component}Paise`];
      if (action === "cash-deposit") debit(accounts[`cash-${component}`], value);
      if (action === "cash-refund") credit(accounts[`cash-${component}`], value);
      if (action === "tax-payment") { debit(accounts[`liability-${component}`], value); credit(accounts[`cash-${component}`], value); }
      if (["tax-refund", "tax-recredit"].includes(action)) credit(accounts[`liability-${component}`], value);
      if (action === "tax-recredit") debit(accounts[`cash-${component}`], value);
      if (action === "itc-claim") { debit(invoice.registration.accounts[`input-${component}`], value); credit(accounts[`pending-${component}`], value); }
      if (action === "itc-reversal") { credit(invoice.registration.accounts[`input-${component}`], value); debit(accounts[`pending-${component}`], value); }
      if (action === "expense") credit(accounts[`pending-${component}`], value);
      if (action === "expense-reversal") debit(accounts[`pending-${component}`], value);
    }
    if (action === "cash-deposit") { type = "Payment"; credit(record.bankLedgerId, record.amountPaise); }
    if (["cash-refund", "tax-refund"].includes(action)) { type = "Receipt"; debit(record.bankLedgerId, record.amountPaise); }
    if (action === "expense") debit(invoice.registration.accounts.nonCreditTax, record.amountPaise);
    if (action === "expense-reversal") credit(invoice.registration.accounts.nonCreditTax, record.amountPaise);
  }
  const evidenceActions = ["supplier-payment", "supplier-refund", "cash-deposit", "cash-refund", "tax-payment", "tax-refund", "tax-recredit"];
  if (evidenceActions.includes(action)) {
    const evidenceTotalPaise = amount(input.evidenceTotalPaise ?? record.amountPaise);
    const sameReference = records(vouchers).filter((entry) => entry.action === action && entry.registrationId === record.registrationId && entry.reference === reference);
    if (sameReference.some((entry) => entry.date !== record.date || entry.evidenceTotalPaise !== evidenceTotalPaise)) throw new Error("This evidence reference already has a different date or total");
    if (sameReference.some((entry) => entry.invoiceId === record.invoiceId && entry.amountPaise === record.amountPaise && isDeepStrictEqual(entry.components, record.components))) throw new Error("That RCM settlement allocation is already recorded");
    if (sameReference.reduce((sum, entry) => sum + BigInt(entry.amountPaise), BigInt(record.amountPaise)) > BigInt(evidenceTotalPaise)) throw new Error("The allocations exceed this evidence reference's recorded amount");
    record.evidenceTotalPaise = evidenceTotalPaise;
  }
  return { voucher: { id, type, date: actionDate, number, narration: `RCM ${action} · ${invoice.number} · ${reference}`.slice(0, 280), lines, gstRcm: record }, record };
}

export function assertRcmBook(company, vouchers) {
  const master = company.gst?.rcm;
  if (master !== undefined) {
    if (master.version !== 1 || !master.accountsByRegistration || typeof master.accountsByRegistration !== "object" || Array.isArray(master.accountsByRegistration)) throw new Error("Invalid RCM account setup");
    const seen = new Set();
    for (const [registrationId, accounts] of Object.entries(master.accountsByRegistration)) {
      if (!company.gst.registrations.some((registration) => registration.id === registrationId)) throw new Error("RCM accounts reference a missing registration");
      for (const component of RCM_COMPONENTS) for (const role of ["pending", "liability", "cash"]) {
        const ledgerId = accounts[`${role}-${component}`];
        const expectedGroup = role === "liability" ? "g-duties" : "g-current-assets";
        if (seen.has(ledgerId) || !company.ledgers.some((ledger) => ledger.id === ledgerId && ledger.groupId === expectedGroup)) throw new Error("RCM posting ledger setup is invalid");
        seen.add(ledgerId);
      }
    }
  }
  for (const invoice of invoices(vouchers)) {
    assertRcmInvoice(company, invoice);
    if (["Credit Note", "Debit Note"].includes(invoice.type)) {
      const original = invoices(vouchers).find((entry) => entry.id === invoice.originalInvoiceId);
      if (!original || original.reverseCharge !== true || original.rcm.basisReference !== invoice.rcm.basisReference) throw new Error("An RCM note must retain its original reverse-charge basis");
    }
  }
  for (const invoice of positiveInvoices(vouchers)) creditAllocations(vouchers, rootId(invoice));
  const sequences = vouchers.map((voucher) => voucher.gst?.rcm?.sequence || voucher.gstRcm?.sequence).filter(Boolean);
  if (new Set(sequences).size !== sequences.length) throw new Error("Duplicate RCM journal sequence");
  const linked = vouchers.filter((entry) => entry.gstRcm);
  if (new Set(linked.map((entry) => `${entry.gstRcm.registrationId}:${fyStart(entry.gstRcm.documentDate || entry.date)}:${entry.number}`)).size !== linked.length) throw new Error("Duplicate RCM document number");
  if (new Set(linked.map((entry) => entry.gstRcm.requestId)).size !== linked.length) throw new Error("Duplicate RCM bookkeeping save identifier");
  for (const voucher of linked) {
    const record = voucher.gstRcm;
    if (record.version !== 1 || record.id !== voucher.id || record.date !== voucher.date || record.number !== voucher.number || !/^[A-Za-z0-9][A-Za-z0-9/-]{0,15}$/.test(record.number) || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || !ACTIONS.has(record.action) || !record.input || Buffer.byteLength(JSON.stringify(record.input)) > 16_000) throw new Error("Invalid RCM bookkeeping snapshot");
    const others = vouchers.filter((entry) => {
      if (entry.id === voucher.id) return false;
      const sequence = entry.gst?.rcm?.sequence || entry.gstRcm?.sequence;
      return !sequence || sequence < record.sequence;
    });
    const rebuilt = buildRcmAction(company, others, record.action, record.input);
    const expected = { ...rebuilt.record, id: record.id, number: record.number };
    if (record.action === "itc-reversal" && record.reversalReason === undefined && record.input.reversalReason === undefined) delete expected.reversalReason;
    if (record.action === "tax-payment" && record.earlyDischarge === undefined) { delete expected.earlyDischarge; delete expected.earlyDischargeComponents; }
    if (!isDeepStrictEqual(expected, record) || !isDeepStrictEqual(rebuilt.voucher.lines, voucher.lines) || rebuilt.voucher.type !== voucher.type || rebuilt.voucher.narration !== voucher.narration) throw new Error("The RCM bookkeeping snapshot does not match its linked posting or available balance");
  }
  const cashIds = new Set(Object.values(master?.accountsByRegistration || {}).flatMap((accounts) => RCM_COMPONENTS.map((component) => accounts[`cash-${component}`])));
  const cashBalances = new Map(company.ledgers.filter((ledger) => cashIds.has(ledger.id)).map((ledger) => [ledger.id, BigInt(ledger.opening?.paise || 0) * (ledger.opening?.dc === "Cr" ? -1n : 1n)]));
  const checkCash = () => { if ([...cashBalances.values()].some((balance) => balance < 0n)) throw new Error("The electronic cash-control ledger is overdrawn"); };
  const byDate = vouchers.filter((voucher) => voucher.lines.some((line) => cashIds.has(line.ledgerId))).sort((a, b) => a.date.localeCompare(b.date));
  checkCash();
  for (let index = 0; index < byDate.length; index++) {
    const voucher = byDate[index];
    for (const line of voucher.lines) if (cashBalances.has(line.ledgerId)) cashBalances.set(line.ledgerId, cashBalances.get(line.ledgerId) + BigInt(line.paise) * (line.dc === "Dr" ? 1n : -1n));
    if (byDate[index + 1]?.date !== voucher.date) checkCash();
  }
}
