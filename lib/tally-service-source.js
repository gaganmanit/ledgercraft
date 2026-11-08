import { children, findNodes, keyName, value } from './tally-format.js';
import { tallyAmount } from './tally-values.js';
import { sourceTaxFacts } from './tally-gst-facts.js';

export const TALLY_SERVICE_SOURCES = ['https://help.tallysolutions.com/gst-sales-tally/'];
const key = text => String(text || '').replace(/^\u0004\s*/, '').trim().toLocaleLowerCase('en-IN');
const yes = text => /^(yes|true|1)$/i.test(text);

// Disposable indexes for one promotion plan. Rebuild after the books change;
// standalone extraction still takes fresh indexes from the current company.
export function tallyServiceSourceLookups(company) {
  return { groups: new Map(company.groups.map(group => [group.id, group])), ledgers: new Map(company.ledgers.map(ledger => [key(ledger.name), ledger])) };
}

// These are financial source rows, never inventory movements. In particular,
// the synthetic unit is an amount basis, not a quantity supplied by Tally.
export function sourceTallyServiceLines(company, voucher, record, factIndex, options = {}) {
  const direction = options.direction || (voucher.type === 'Purchase' ? 'purchase' : 'sales');
  if (!['sales', 'purchase'].includes(direction)) throw new Error('Choose a supported service source direction');
  const date = options.date || voucher.date, inward = direction === 'purchase';
  const all = children(record.node, 'ALLLEDGERENTRIES'), entries = all.length ? all : children(record.node, 'LEDGERENTRIES');
  const { groups, ledgers } = options.lookups || tallyServiceSourceLookups(company);
  const allowed = new Set(inward ? ['g-purchase', 'g-direct-exp', 'g-indirect-exp'] : ['g-sales', 'g-direct-inc', 'g-indirect-inc']);
  const eligible = (ledger, accepted = allowed) => {
    let group = ledger?.groupId; const seen = new Set();
    while (group && !seen.has(group)) { if (accepted.has(group)) return true; seen.add(group); group = groups.get(group)?.parentId; }
    return false;
  };
  const inventory = [...children(record.node, 'ALLINVENTORYENTRIES'), ...children(record.node, 'INVENTORYENTRIES')];
  const goodsAmounts = new Map(), goodsEntryIndexes = new Set();
  for (const allocation of inventory.flatMap(entry => findNodes(entry, 'ACCOUNTINGALLOCATIONS'))) {
    const name = key(value(allocation, 'LEDGERNAME'));
    goodsAmounts.set(name, (goodsAmounts.get(name) || 0n) + BigInt(tallyAmount(value(allocation, 'AMOUNT'))));
  }
  const rows = [], issues = []; let postingIndex = 0;
  const allocations = inventory.flatMap(entry => children(entry, 'ACCOUNTINGALLOCATIONS')).filter(entry => tallyAmount(value(entry, 'AMOUNT'), true));
  const directCount = entries.filter(entry => tallyAmount(value(entry, 'AMOUNT'), true)).length;
  const nestedGoods = !all.length && record.accountingMode === 'ledger-plus-inventory-accounting-allocations' && voucher.lines.length === directCount + allocations.length && allocations.every((entry, offset) => {
    const amount = tallyAmount(value(entry, 'AMOUNT')), posting = voucher.lines[directCount + offset];
    return posting.ledgerId === ledgers.get(key(value(entry, 'LEDGERNAME')))?.id && posting.paise === Math.abs(amount) && posting.dc === (amount < 0 ? 'Dr' : 'Cr');
  });
  for (const [name, allocated] of nestedGoods ? [] : goodsAmounts) {
    const matching = entries.map((entry, index) => ({ entry, index, amount: tallyAmount(value(entry, 'AMOUNT'), true) })).filter(row => key(value(row.entry, 'LEDGERNAME')) === name && row.amount);
    if (matching.reduce((sum, row) => sum + BigInt(row.amount), 0n) === allocated) matching.forEach(row => goodsEntryIndexes.add(row.index));
    else {
      const exact = matching.filter(row => BigInt(row.amount) === allocated);
      if (exact.length === 1) goodsEntryIndexes.add(exact[0].index);
      else { matching.forEach(row => goodsEntryIndexes.add(row.index)); issues.push({ message: 'Goods accounting allocations and service ledger rows cannot be separated unambiguously' }); }
    }
  }
  for (const [entryIndex, entry] of entries.entries()) {
    const amount = tallyAmount(value(entry, 'AMOUNT'), true), index = amount ? postingIndex++ : null;
    const sourceName = value(entry, 'LEDGERNAME'), ledger = ledgers.get(key(sourceName));
    if (!amount || !eligible(ledger) || goodsEntryIndexes.has(entryIndex)) continue;
    // Tax, rounding and settlement rows cannot become a service by choosing an
    // income/expense group. Other charges remain unconfirmed candidates.
    if (/\b(cgst|sgst|utgst|igst|cess|round(?:ing)?[ -]?off)\b|(?:central|state|integrated|union).*tax/i.test(sourceName) || yes(value(entry, 'ISPARTYLEDGER'))) continue;
    const flag = value(entry, 'ISDEEMEDPOSITIVE');
    const posting = voucher.lines[index];
    const sourceLineId = `ledger-entry:${entryIndex}`;
    const mismatch = (amount < 0) !== inward || flag && (!/^(yes|no|true|false|1|0)$/i.test(flag) || yes(flag) !== inward) || !posting || posting.ledgerId !== ledger.id || posting.dc !== (inward ? 'Dr' : 'Cr') || posting.paise !== Math.abs(amount);
    if (mismatch) { issues.push({ sourceLineId, message: 'The service source amount, direction or original posting does not agree' }); continue; }
    rows.push({ sourceLineId, sourceName, kind: 'service', sourceKind: 'ledger', sourceLedgerId: ledger.id, sourceLedgerName: sourceName, sourceLedgerEntryIndex: entryIndex, sourcePostingIndexes: [index],
      quantity: '1', unit: 'OTH', quantityBasis: 'amount-only', actualQuantity: null, actualBasis: 'not-applicable', stockEffect: 'none', unitPricePaise: Math.abs(amount), valuePaise: Math.abs(amount), sourceAmountPaise: amount, sourceDirectionFlag: flag,
      amountEvidence: { recordId: record.recordId, fieldPath: `VOUCHER/${keyName(entry.tag)}[${entryIndex}]/AMOUNT[0]`, sourceValue: value(entry, 'AMOUNT') },
      ledgerEvidence: { recordId: record.recordId, fieldPath: `VOUCHER/${keyName(entry.tag)}[${entryIndex}]/LEDGERNAME[0]`, sourceValue: sourceName } });
  }
  const facts = sourceTaxFacts(factIndex, record, date, rows, options.registrationState || '', options.correctedSeller === true, { direction, supplierState: options.supplierState || '', ...(options.documentDate ? { documentDate: options.documentDate } : {}) });
  const reviewed = new Set(options.reviewedSourceLineIds || []), items = [], candidates = [];
  for (const [index, row] of rows.entries()) {
    const fact = facts.items[index];
    const classified = fact.supplyType.status === 'supplied' && fact.supplyType.value === 'service' || fact.supplyType.status === 'absent' && fact.hsnSac.status === 'supplied' && /^99\d{4}$/.test(fact.hsnSac.value);
    const goods = fact.supplyType.status === 'supplied' && fact.supplyType.value === 'goods';
    const evidence = [...fact.supplyType.evidence, ...fact.hsnSac.evidence];
    if (goods) { if (reviewed.has(row.sourceLineId)) throw new Error('A goods-classified ledger cannot be silently reclassified as a service'); continue; }
    const confirmed = classified || reviewed.has(row.sourceLineId);
    const descriptor = { ...row, serviceClassification: classified ? 'source' : confirmed ? 'reviewed' : 'unconfirmed', classificationRequired: !classified,
      classificationStatus: fact.supplyType.status === 'conflict' || fact.hsnSac.status === 'conflict' ? 'conflict' : classified ? 'supplied' : 'absent', classificationEvidence: evidence,
      issues: [...fact.supplyType.issues, ...fact.hsnSac.issues] };
    (confirmed ? items : candidates).push(descriptor);
  }
  // Older item invoices can carry their complete goods financial leg directly
  // without inventory ACCOUNTINGALLOCATIONS. Match only an exact native goods
  // amount to an unclassified sales/purchase posting; never infer a remainder
  // to be a service or consume a row already supported as a service.
  if (inventory.length && !goodsAmounts.size) {
    const goodsTotal = inventory.reduce((sum, entry) => sum + BigInt(tallyAmount(value(entry, 'AMOUNT'))), 0n);
    const base = candidates.filter(row => row.classificationStatus === 'absent' && eligible(ledgers.get(key(row.sourceName)), new Set([inward ? 'g-purchase' : 'g-sales'])));
    const exact = base.filter(row => BigInt(row.sourceAmountPaise) === goodsTotal);
    let excluded = [];
    if (goodsTotal && exact.length === 1) excluded = exact;
    else if (goodsTotal && !exact.length) {
      const grouped = new Map();
      for (const row of base) { const group = grouped.get(row.sourceLedgerId) || []; group.push(row); grouped.set(row.sourceLedgerId, group); }
      const matching = [...grouped.values()].filter(group => !items.some(row => row.sourceLedgerId === group[0].sourceLedgerId) && group.reduce((sum, row) => sum + BigInt(row.sourceAmountPaise), 0n) === goodsTotal);
      if (matching.length === 1) excluded = matching[0];
    }
    for (const row of excluded) candidates.splice(candidates.indexOf(row), 1);
  }
  for (const id of reviewed) if (!items.some(row => row.sourceLineId === id)) throw new Error('The reviewed service source row is missing or unsupported');
  return { items, candidates, issues };
}
