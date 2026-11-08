import { openingSigned } from "./engine.js";
import { amount, balanceAt, bookEntries, date, digest, ledger, newId, partySide, sum, text, uniqueIds } from "./reconciliation-common.js";

function sourcesFor(company, vouchers, ledgerId, sourceCache) {
  const cached = sourceCache?.get(ledgerId);
  if (cached?.company === company && cached?.vouchers === vouchers) return cached.result;
  const account = ledger(company, ledgerId);
  const side = partySide(company, account), factor = side === "receivable" ? 1 : -1;
  const entries = bookEntries(company, vouchers, ledgerId).map(entry => ({ ...entry, amountPaise: entry.amountPaise * factor, sourceKind: "voucher" }));
  const opening = openingSigned(account) * factor;
  if (opening) entries.unshift({ key: `opening:${ledgerId}`, sourceKind: "opening", voucherId: null, ledgerId,
    date: company.booksFrom, number: "Opening balance", reference: "Opening balance", type: "Opening", narration: "",
    amountPaise: opening, fingerprint: digest([ledgerId, company.booksFrom, opening]), gstId: null });
  const result = { account, side, factor, entries };
  sourceCache?.set(ledgerId, { company, vouchers, result });
  return result;
}
function allBills(meta, company, vouchers, ledgerId, sourceCache) {
  const { entries, side } = sourcesFor(company, vouchers, ledgerId, sourceCache);
  const explicit = meta.bills.filter(bill => bill.ledgerId === ledgerId);
  const covered = new Set(explicit.map(bill => bill.sourceKey));
  const generated = entries.filter(entry => entry.amountPaise > 0 && entry.gstId && !covered.has(entry.key)).map(entry => ({
    id: `gb-${digest([entry.key]).slice(0, 20)}`, ledgerId, side, sourceKey: entry.key, voucherId: entry.voucherId,
    reference: entry.reference, date: entry.date, dueDate: entry.date, amountPaise: entry.amountPaise,
    fingerprint: entry.fingerprint, derived: true,
  }));
  return [...explicit, ...generated];
}
export function saveBill(meta, company, vouchers, input, sourceCache) {
  const { entries, side } = sourcesFor(company, vouchers, input.ledgerId, sourceCache);
  const source = entries.find(entry => entry.key === input.sourceKey);
  if (!source || source.amountPaise <= 0) throw new Error("Choose a debit reference for a debtor or a credit reference for a creditor");
  const derived = allBills(meta, company, vouchers, input.ledgerId, sourceCache).find(bill => bill.id === input.id);
  const existing = meta.bills.find(bill => bill.id === input.id);
  if (input.id && !derived) throw new Error("That bill reference is not available");
  if (existing && existing.sourceKey !== source.key) throw new Error("A bill keeps its source. Remove its allocations and reference before choosing another source");
  const paise = amount(input.amountPaise, "bill amount");
  if (!paise) throw new Error("Enter a bill amount greater than zero");
  if (source.gstId && paise !== source.amountPaise) throw new Error("A GST invoice reference uses its full posted party amount");
  const openingBillDate = source.sourceKind === "opening" ? input.openingBillDate || existing?.openingBillDate : undefined;
  if (openingBillDate && (date(openingBillDate, "opening bill date") > company.booksFrom)) throw new Error("An opening bill date must be on or before these books begin");
  const billDate = openingBillDate || source.date;
  const dueDate = date(input.dueDate, "bill due date");
  if (dueDate < billDate) throw new Error("The bill due date cannot precede its source date");
  const bill = { id: existing?.id || derived?.id || newId("bl"), ledgerId: input.ledgerId, side,
    sourceKey: source.key, voucherId: source.voucherId, reference: text(input.reference, "bill reference", 80),
    date: billDate, dueDate, amountPaise: paise, fingerprint: source.fingerprint, derived: false,
    ...(openingBillDate ? { openingBillDate } : {}), ...(existing?.origin ? { origin: structuredClone(existing.origin) } : {}) };
  const peers = allBills(meta, company, vouchers, input.ledgerId, sourceCache).filter(row => row.id !== bill.id && !(row.derived && row.sourceKey === source.key));
  if (peers.some(row => row.reference.toUpperCase() === bill.reference.toUpperCase())) throw new Error("Use a unique bill reference for this party ledger");
  const consumed = sum(peers.filter(row => row.sourceKey === source.key).map(row => row.amountPaise));
  if (sum([consumed, paise]) > source.amountPaise) throw new Error("Bill references exceed the source posting amount");
  const allocated = sum(meta.allocations.filter(row => row.billId === bill.id).map(row => row.paise));
  if (allocated > paise) throw new Error("Remove excess allocations before reducing this bill amount");
  const previous = existing ? structuredClone(existing) : null;
  if (existing) Object.assign(existing, bill);
  else meta.bills.push(bill);
  return { id: bill.id, previous, saved: structuredClone(bill) };
}
export function removeBill(meta, input) {
  const index = meta.bills.findIndex(bill => bill.id === input.billId);
  if (index < 0) throw new Error("Choose a saved bill reference");
  if (meta.allocations.some(row => row.billId === input.billId)) throw new Error("Remove this bill's allocations before removing its reference");
  const removed = meta.bills.splice(index, 1)[0];
  return { id: input.billId, removed };
}
export function allocateBill(meta, company, vouchers, input, sourceCache) {
  const { entries } = sourcesFor(company, vouchers, input.ledgerId, sourceCache);
  const bill = allBills(meta, company, vouchers, input.ledgerId, sourceCache).find(row => row.id === input.billId);
  const credit = entries.find(entry => entry.key === input.creditKey && entry.amountPaise < 0);
  if (!bill || !credit) throw new Error("Choose a bill and a receipt, payment, credit adjustment or advance for the same party ledger");
  const when = date(input.date, "allocation date"), paise = amount(input.paise, "allocation amount");
  if (!paise || when < bill.date || when < credit.date) throw new Error("Allocate a positive amount on or after both source dates");
  const billUsed = sum(meta.allocations.filter(row => row.billId === bill.id).map(row => row.paise));
  const creditUsed = sum(meta.allocations.filter(row => row.ledgerId === input.ledgerId && row.creditKey === credit.key).map(row => row.paise));
  if (sum([billUsed, paise]) > bill.amountPaise || sum([creditUsed, paise]) > -credit.amountPaise) throw new Error("This allocation exceeds the bill balance or the available settlement");
  const allocation = { id: newId("ba"), ledgerId: input.ledgerId, billId: bill.id, billVoucherId: bill.voucherId,
    creditKey: credit.key, creditVoucherId: credit.voucherId, date: when, paise,
    billFingerprint: bill.fingerprint, creditFingerprint: credit.fingerprint, createdAt: new Date().toISOString() };
  meta.allocations.push(allocation);
  return { id: allocation.id, allocated: structuredClone(allocation) };
}
const elapsedDays = (from, to) => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
export function billReport(meta, company, vouchers, asOf, ledgerId = "", sourceCache = new Map()) {
  date(asOf, "ageing date");
  if (asOf < company.booksFrom) throw new Error("Choose an ageing date on or after these books begin");
  const parties = company.ledgers.flatMap(account => {
    try { return [{ id: account.id, name: account.name, side: partySide(company, account) }]; }
    catch { return []; }
  });
  const selected = ledgerId ? parties.filter(party => party.id === ledgerId) : parties;
  if (ledgerId && !selected.length) throw new Error("Choose a sundry debtor or creditor ledger");
  const rows = [], settlements = [], unreferenced = [], totals = [], allocations = [];
  for (const party of selected) {
    const { entries, factor } = sourcesFor(company, vouchers, party.id, sourceCache);
    const sources = entries.filter(entry => entry.date <= asOf);
    const bills = allBills(meta, company, vouchers, party.id, sourceCache).filter(bill => bill.date <= asOf);
    const currentAllocations = meta.allocations.filter(row => row.ledgerId === party.id && row.date <= asOf);
    const sourceMap = new Map(sources.map(entry => [entry.key, entry]));
    for (const bill of bills) {
      const applied = currentAllocations.filter(row => row.billId === bill.id);
      const paidPaise = sum(applied.map(row => row.paise));
      const openPaise = sum([bill.amountPaise, -paidPaise]);
      const daysOverdue = Math.max(0, elapsedDays(bill.dueDate, asOf));
      const bucket = !openPaise ? "settled" : !daysOverdue ? "current" : daysOverdue <= 30 ? "1–30" : daysOverdue <= 60 ? "31–60" : daysOverdue <= 90 ? "61–90" : "90+";
      rows.push({ ...bill, partyName: party.name, openPaise, paidPaise, daysOverdue, bucket,
        source: sourceMap.get(bill.sourceKey), allocations: applied.map(row => ({ ...row, settlement: sourceMap.get(row.creditKey) })) });
    }
    for (const source of sources) {
      if (source.amountPaise < 0) {
        const used = sum(currentAllocations.filter(row => row.creditKey === source.key).map(row => row.paise));
        settlements.push({ ...source, side: party.side, partyName: party.name, allocatedPaise: used, remainingPaise: sum([-source.amountPaise, -used]) });
      } else {
        const used = sum(bills.filter(bill => bill.sourceKey === source.key).map(bill => bill.amountPaise));
        if (used < source.amountPaise) unreferenced.push({ ...source, side: party.side, partyName: party.name, remainingPaise: sum([source.amountPaise, -used]) });
      }
    }
    const outstandingPaise = sum(rows.filter(row => row.ledgerId === party.id).map(row => row.openPaise));
    const onAccountPaise = sum(unreferenced.filter(row => row.ledgerId === party.id).map(row => row.remainingPaise));
    const advancePaise = sum(settlements.filter(row => row.ledgerId === party.id).map(row => row.remainingPaise));
    const ledgerPaise = balanceAt(company, vouchers, party.id, asOf) * factor;
    const accountedPaise = sum([outstandingPaise, onAccountPaise, -advancePaise]);
    totals.push({ ...party, outstandingPaise, onAccountPaise, advancePaise, ledgerPaise, accountedPaise, differencePaise: sum([ledgerPaise, -accountedPaise]) });
    allocations.push(...currentAllocations.map(row => ({ ...row, partyName: party.name,
      bill: bills.find(bill => bill.id === row.billId), settlement: sourceMap.get(row.creditKey) })));
  }
  rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.reference.localeCompare(b.reference));
  return { company: { id: company.id, name: company.name, booksFrom: company.booksFrom }, revision: meta.revision, asOf, parties,
    ledgerId, rows, settlements, unreferenced, allocations, totals,
    ageing: ["receivable", "payable"].map(side => ({ side, buckets: Object.fromEntries(["current", "1–30", "31–60", "61–90", "90+"].map(bucket => [bucket, sum(rows.filter(row => row.side === side && row.bucket === bucket).map(row => row.openPaise))])) })) };
}
export function assertBillMetadata(meta, company, vouchers) {
  uniqueIds(meta.bills, "bill"); uniqueIds(meta.allocations, "bill allocation");
  // The financial book is immutable during this validation. Reuse each party's source scan.
  const sourceCache = new Map();
  const checkedBills = { ...meta, bills: [], allocations: [] };
  for (const bill of meta.bills) {
    const { entries, side } = sourcesFor(company, vouchers, bill.ledgerId, sourceCache);
    const source = entries.find(entry => entry.key === bill.sourceKey);
    if (!source || source.amountPaise <= 0 || bill.date !== (source.sourceKind === "opening" && bill.openingBillDate ? bill.openingBillDate : source.date) || bill.fingerprint !== source.fingerprint || bill.voucherId !== source.voucherId || bill.side !== side || bill.derived !== false) throw new Error("A bill reference no longer agrees with its source posting");
    const created = saveBill(checkedBills, company, vouchers, { ...bill, id: undefined }, sourceCache);
    checkedBills.bills.find(row => row.id === created.id).id = bill.id;
  }
  const checked = { ...meta, allocations: [] };
  for (const row of meta.allocations) {
    const result = allocateBill(checked, company, vouchers, row, sourceCache);
    const created = checked.allocations.find(item => item.id === result.id);
    if (["billVoucherId", "creditVoucherId", "billFingerprint", "creditFingerprint"].some(key => created[key] !== row[key])) throw new Error("A bill allocation no longer agrees with its sources");
  }
  const report = billReport(meta, company, vouchers, "9999-12-31", "", sourceCache);
  if (report.totals.some(row => row.differencePaise !== 0)) throw new Error("Bill-wise balances do not agree with the party ledger");
}
