import { isIsoDate, todayISO } from './money.js';
import { itcStockReviews } from './gst-itc.js';
import { assertTallyGstStockLink } from './tally-gst.js';

// Perpetual cost replay. Quantities are millionths; money is integer paise.
// No selling rate, current purchase rate or zero default supplies a missing cost.
const SCALE = 1000000n;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const METHODS = ['fifo', 'moving-average'];
const TYPES = ['transfer', 'adjustment', 'physical', 'receipt', 'issue'];
const KINDS = ['purchase', 'sale', 'purchase-return', 'sales-return', 'adjustment'];
function fail(message) { throw new Error(message); }
function id(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240) fail(`Enter a valid ${label}`);
  return value;
}
function quantity(value, zero = false) {
  const raw = String(value ?? '');
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(raw)) fail('Enter a stock quantity with up to six decimal places');
  const [whole, fraction = ''] = raw.split('.');
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
  if (result > MAX || (!zero && !result)) fail('Enter a supported positive stock quantity');
  return result;
}
function formatted(value) {
  const absolute = value < 0n ? -value : value;
  if (absolute > MAX) fail('The stock quantity exceeds the supported micro-unit limit');
  const tail = String(absolute % SCALE).padStart(6, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${absolute / SCALE}${tail ? '.' + tail : ''}`;
}
function money(value, label = 'stock value') {
  if (!Number.isSafeInteger(value) || value < 0) fail(`Enter ${label} in nonnegative safe integer paise`);
  return BigInt(value);
}
function number(value) {
  if (value > MAX || value < -MAX) fail('The stock value exceeds the supported paise limit');
  return Number(value);
}
function fraction(value, part, whole) { return whole === part ? value : (value * part + whole / 2n) / whole; }
function date(value, booksFrom) {
  if (!isIsoDate(value) || value < booksFrom) fail('Enter a stock date on or after the books begin');
  return value;
}
function optionalCost(value) { return value === undefined || value === null ? null : money(value); }
function sequence(value) {
  if (value === undefined) return -1;
  if (!Number.isSafeInteger(value) || value < 0) fail('Invalid stock replay sequence');
  return value;
}
function sum(values) { return values.reduce((total, value) => total + value, 0n); }
const LINEAGE_SCALE = 10n ** 48n;
const LINEAGE_DENOMINATOR = 1n << 192n;
const exactLineage = new WeakMap();
const floorDivide = (n, d) => n / d - (n < 0n && n % d ? 1n : 0n);
const ceilDivide = (n, d) => -floorDivide(-n, d);
function boundedRatio(lo, hi, expression) { return { n: lo, d: LINEAGE_SCALE, lo, hi, expression }; }
function bounds(value) { return value.expression ? value : { lo: floorDivide(value.n * LINEAGE_SCALE, value.d), hi: ceilDivide(value.n * LINEAGE_SCALE, value.d) }; }
function ratio(n, d = 1n) {
  if (d <= 0n) fail('Invalid inventory lineage denominator');
  let a = n < 0n ? -n : n, b = d;
  while (b) [a, b] = [b, a % b];
  const value = { n: n / a, d: d / a };
  if (value.d <= LINEAGE_DENOMINATOR) return value;
  const { lo, hi } = bounds(value);
  return boundedRatio(lo, hi, { op: 'literal', value });
}
function addRatio(a, b) {
  if (a.negated === b || b.negated === a) return ratio(0n);
  if (!a.expression && !b.expression) return ratio(a.n * b.d + b.n * a.d, a.d * b.d);
  const x = bounds(a), y = bounds(b);
  return boundedRatio(x.lo + y.lo, x.hi + y.hi, { op: 'add', a, b });
}
function scaledRatio(a, n, d) {
  if (!n) return ratio(0n);
  if (n === d) return a;
  if (!a.expression) return ratio(a.n * n, a.d * d);
  const { lo, hi } = bounds(a);
  const result = boundedRatio(floorDivide((n < 0n ? hi : lo) * n, d), ceilDivide((n < 0n ? lo : hi) * n, d), { op: 'scale', a, n, d });
  if (n === -d) result.negated = a;
  return result;
}
function exactRatio(value) {
  // Exact fallback is needed only when the bounded interval straddles a paise
  // rounding boundary. Iterative evaluation avoids a long-history call stack.
  const stack = [[value, false]];
  const raw = (n, d) => {
    let a = n < 0n ? -n : n, b = d;
    while (b) [a, b] = [b, a % b];
    return { n: n / a, d: d / a };
  };
  while (stack.length) {
    const [node, ready] = stack.pop();
    if (exactLineage.has(node)) continue;
    const expression = node.expression;
    if (!expression) { exactLineage.set(node, node); continue; }
    if (expression.op === 'literal') { exactLineage.set(node, expression.value); continue; }
    const children = expression.op === 'add' ? [expression.a, expression.b] : [expression.a];
    if (!ready) { stack.push([node, true]); for (const child of children) if (!exactLineage.has(child)) stack.push([child, false]); continue; }
    const a = exactLineage.get(expression.a);
    if (expression.op === 'add') {
      const b = exactLineage.get(expression.b); exactLineage.set(node, raw(a.n * b.d + b.n * a.d, a.d * b.d));
    } else exactLineage.set(node, raw(a.n * expression.n, a.d * expression.d));
  }
  return exactLineage.get(value);
}
function ratioSign(value) {
  if (!value.expression) return value.n < 0n ? -1 : value.n > 0n ? 1 : 0;
  if (value.lo >= 0n) return value.hi > 0n ? 1 : 0;
  if (value.hi < 0n) return -1;
  const exact = exactRatio(value); return exact.n < 0n ? -1 : exact.n > 0n ? 1 : 0;
}
const zeroRatio = () => ({ n: 0n, d: 1n });
function addOrigins(target, source, sign = 1n) {
  for (const [key, value] of source) target.set(key, addRatio(target.get(key) || zeroRatio(), scaledRatio(value, sign, 1n)));
  return target;
}
function scaleOrigins(source, n, d) { return new Map([...source].map(([key, value]) => [key, scaledRatio(value, n, d)])); }
function ratioValue(value, share, denominator) {
  if (share.expression) {
    const { lo, hi } = bounds(share);
    const low = ratioValue(value, { n: value < 0n ? hi : lo, d: LINEAGE_SCALE }, denominator);
    const high = ratioValue(value, { n: value < 0n ? lo : hi, d: LINEAGE_SCALE }, denominator);
    if (low === high) return low;
    return ratioValue(value, exactRatio(share), denominator);
  }
  const n = value * share.n, d = share.d * denominator;
  return n < 0n ? -((-n + d / 2n) / d) : (n + d / 2n) / d;
}
function current(lots) { return sum(lots.map(lot => lot.q)); }
function known(lots) { return sum(lots.map(lot => lot.v ?? 0n)); }
function valued(lots) { return lots.every(lot => lot.v !== null && lot.q >= 0n); }
function basis(record) {
  if (record.costValuePaise === undefined || record.costValuePaise === null) return null;
  if (typeof record.costBasisReason !== 'string' || !record.costBasisReason.trim()) fail('An explicit return cost needs its cost basis reason');
  return money(record.costValuePaise, 'exception cost');
}

function prepare(company, vouchers, boundary, exclusive = false) {
  if (!isIsoDate(company.booksFrom)) fail('Invalid stock books opening date');
  const config = company.stock || {};
  if (config.version !== undefined && config.version !== 1) fail('Unsupported stock configuration version');
  if (config.integrateAccounts !== undefined && typeof config.integrateAccounts !== 'boolean') fail('Invalid inventory accounts integration option');
  if (config.revision !== undefined && (!Number.isSafeInteger(config.revision) || config.revision < 0)) fail('Invalid stock revision');
  if (config.operationReceipts !== undefined && !Array.isArray(config.operationReceipts)) fail('Invalid stock operation receipts');
  if (config.items !== undefined && (!config.items || typeof config.items !== 'object' || Array.isArray(config.items))) fail('Invalid stock item settings');
  if (config.godowns !== undefined && !Array.isArray(config.godowns)) fail('Invalid godown list');
  if (config.masters !== undefined && !Array.isArray(config.masters)) fail('Invalid stock master list');
  if (config.journals !== undefined && !Array.isArray(config.journals)) fail('Invalid stock journal list');
  const godowns = new Map([['main', { id: 'main', name: 'Main Location' }]]);
  for (const godown of config.godowns || []) {
    id(godown.id, 'godown id'); id(godown.name, 'godown name');
    if (godowns.has(godown.id) && godown.id !== 'main') fail('Duplicate stock godown id');
    godowns.set(godown.id, godown);
  }
  const seenGodowns = new Set();
  for (const godown of config.godowns || []) {
    if (seenGodowns.has(godown.id)) fail('Duplicate stock godown id');
    seenGodowns.add(godown.id);
  }
  const states = new Map();
  const enriched = new Map((company.gst?.items || []).filter(item => item.stockItemId).map(item => [item.id, item]));
  for (const master of enriched.values()) {
    const original = (config.masters || []).find(item => item.id === master.stockItemId);
    if (!original || master.id !== original.id || master.kind !== 'goods' || master.name.toLowerCase() !== original.name.toLowerCase() || master.unit.toLowerCase() !== original.unit.toLowerCase() || master.openingQuantity !== original.openingQuantity) fail('GST source stock enrichment changed the original item identity or opening');
  }
  const masterList = [...(company.gst?.items || []).filter(item => item.kind === 'goods' && !item.stockItemId), ...(config.masters || [])];
  for (const master of masterList) {
    id(master.id, 'stock item id'); id(master.name, 'stock item name'); id(master.unit, 'stock unit');
    if (states.has(master.id)) fail('Duplicate stock item id');
    const settings = config.items?.[master.id] || {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) fail('Invalid stock item settings');
    const method = settings.costingMethod || 'fifo';
    if (!METHODS.includes(method)) fail('Choose fifo or moving-average for stock valuation');
    states.set(master.id, { master, settings, method, lots: [], movements: [], issues: [], sources: new Map(), returns: new Map(), origins: new Map(), purchaseReturned: new Map(), pendingTax: new Map() });
  }
  for (const key of Object.keys(config.items || {})) if (!states.has(key)) fail('Stock settings reference a missing goods item');
  const location = value => {
    const result = value || 'main';
    if (!godowns.has(result)) fail('Stock movement references a missing godown');
    return result;
  };
  const item = key => { if (!states.has(key)) fail('Stock movement references a missing goods item'); return states.get(key); };
  function allocations(input, total) {
    const source = input || [{ godownId: 'main', quantity: formatted(total) }];
    if (!Array.isArray(source) || !source.length) fail('Enter stock godown allocations');
    const result = source.map(allocation => ({ godownId: location(allocation.godownId), q: quantity(allocation.quantity) }));
    if (new Set(result.map(row => row.godownId)).size !== result.length) fail('Combine duplicate godown allocations');
    if (sum(result.map(row => row.q)) !== total) fail('Godown allocations must equal the invoice line quantity');
    return result;
  }
  const events = [];
  const promotedStock = new Map();
  const sourceIds = new Set();
  for (const voucher of vouchers) {
    const invoice = voucher.gst;
    const metadata = voucher.stock;
    if (metadata && (!invoice || metadata.version !== 1 || !Array.isArray(metadata.lines))) fail('Invalid linked invoice stock metadata');
    if (!invoice) continue;
    if (invoice.tallyOrigin) {
      const journal = assertTallyGstStockLink(company, voucher);
      if (metadata) fail('Promoted source invoices retain their original godown allocations');
      if (journal) promotedStock.set(journal.id, invoice);
      continue;
    }
    const metadataLines = new Map();
    for (const line of metadata?.lines || []) {
      if (!Number.isSafeInteger(line.lineIndex) || line.lineIndex < 0 || line.lineIndex >= invoice.items.length || invoice.items[line.lineIndex].kind !== 'goods' || invoice.stockEffect !== 'quantity') fail('Stock allocation references an invalid invoice goods line');
      if (metadataLines.has(line.lineIndex)) fail('Duplicate invoice stock line allocation');
      basis(line);
      if (line.originalLineIndex !== undefined && (!Number.isSafeInteger(line.originalLineIndex) || line.originalLineIndex < 0)) fail('Invalid original stock line index');
      if (line.originalLineIndex !== undefined) {
        const original = vouchers.find(value => value.gst?.id === invoice.originalInvoiceId)?.gst;
        const originalLine = original?.items?.[line.originalLineIndex];
        if (!originalLine || originalLine.kind !== 'goods' || originalLine.itemId !== invoice.items[line.lineIndex].itemId || original.direction !== invoice.direction || original.stockEffect !== 'quantity') fail('Original stock line must match the linked goods item and direction');
      }
      metadataLines.set(line.lineIndex, line);
    }
    if (!invoice.items?.some(line => line.kind === 'goods')) continue;
    id(invoice.id, 'stock invoice identity');
    if (invoice.id !== voucher.id || invoice.date !== voucher.date) fail('Stock invoice identity or date does not match its voucher');
    if (sourceIds.has(invoice.id)) fail('Duplicate stock source identity');
    sourceIds.add(invoice.id);
    date(invoice.date, company.booksFrom);
    if (!['Sales', 'Purchase', 'Credit Note', 'Debit Note'].includes(invoice.type) || !['sales', 'purchase'].includes(invoice.direction)) fail('Invalid stock invoice type or direction');
    if (!['quantity', 'none'].includes(invoice.stockEffect)) fail('Invalid invoice stock effect');
    invoice.items.forEach((line, lineIndex) => {
      if (line.kind !== 'goods') return;
      item(line.itemId);
      const q = quantity(line.quantity);
      const meta = metadataLines.get(lineIndex) || {};
      const kind = invoice.direction === 'purchase' ? (invoice.type === 'Credit Note' ? 'purchase-return' : 'purchase') : (invoice.type === 'Credit Note' ? 'sales-return' : 'sale');
      let v = money(line.taxablePaise, 'invoice taxable value');
      let uncertainTax = false;
      if (invoice.direction === 'purchase') {
        const tax = money(line.taxPaise ?? 0, 'invoice tax');
        if (invoice.itcEligibility === 'ineligible') v += tax;
        else if (tax && invoice.itcEligibility !== 'eligible') { uncertainTax = true; }
      }
      events.push({ sourceId: invoice.id, sourceType: 'gst', number: invoice.number || voucher.number || '', date: invoice.date, lineIndex,
        itemId: line.itemId, q, v, kind, noQuantity: invoice.stockEffect === 'none', originalSourceId: invoice.originalInvoiceId,
        originalLineIndex: meta.originalLineIndex, exception: basis(meta), allocations: allocations(meta.allocations, q), uncertainTax, sequence: sequence(metadata?.sequence),
        pendingTaxPaise: uncertainTax ? line.taxPaise : 0 });
    });
  }
  for (const journal of config.journals || []) {
    id(journal.id, 'stock journal id'); id(journal.number, 'stock journal number');
    if (sourceIds.has(journal.id)) fail('Duplicate stock source identity');
    sourceIds.add(journal.id);
    date(journal.date, company.booksFrom);
    const promoted = promotedStock.get(journal.id);
    if (promoted) {
      promoted.items.forEach((line, lineIndex) => {
        const parts = journal.lines.filter((row, index) => promoted.tallyOrigin.stockLineMap[index] === lineIndex);
        const combined = new Map();
        for (const part of parts) combined.set(part.godownId || 'main', (combined.get(part.godownId || 'main') || 0n) + quantity(part.quantity));
        const q = quantity(promoted.tallyOrigin.source.items[lineIndex].actualQuantity);
        const purchase = promoted.direction === 'purchase';
        const uncertainTax = purchase && line.taxPaise > 0;
        const sourceReceiptAllocations = purchase ? [...combined].map(([godownId, q]) => ({ godownId, q,
          v: sum(parts.filter(part => (part.godownId || 'main') === godownId).map(part => money(part.valuePaise))) })) : null;
        events.push({ sourceId: promoted.id, sourceType: 'gst', sourceRef: journal.sourceRef, number: journal.number, date: journal.date, lineIndex,
          itemId: line.itemId, q, v: money(line.taxablePaise), kind: purchase ? 'purchase' : 'sale', noQuantity: false,
          originalSourceId: null, exception: null, allocations: allocations([...combined].map(([godownId, q]) => ({ godownId, quantity: formatted(q) })), q), sequence: sequence(journal.sequence),
          ...(purchase ? { uncertainTax, sourceReceiptAllocations } : {}), pendingTaxPaise: uncertainTax ? line.taxPaise : 0 });
      });
      continue;
    }
    if (!TYPES.includes(journal.type) || !Array.isArray(journal.lines) || !journal.lines.length) fail('Invalid stock journal type or lines');
    if (journal.financialKind !== undefined && !KINDS.includes(journal.financialKind)) fail('Invalid stock journal financial treatment');
    if (journal.originalSourceId !== undefined && journal.originalSourceId !== null) id(journal.originalSourceId, 'original stock source');
    journal.lines.forEach((line, lineIndex) => {
      item(line.itemId);
      const q = quantity(line.quantity, journal.type === 'physical');
      const exception = basis(line);
      if (line.originalLineIndex !== undefined && (!Number.isSafeInteger(line.originalLineIndex) || line.originalLineIndex < 0)) fail('Invalid original stock line index');
      const v = optionalCost(line.valuePaise);
      const financialKind = line.financialKind || journal.financialKind || 'adjustment';
      if (!KINDS.includes(financialKind)) fail('Invalid stock line financial treatment');
      const event = { sourceId: journal.id, sourceType: journal.type, sourceRef: journal.sourceRef || journal.source || null,
        number: journal.number, date: journal.date, lineIndex, itemId: line.itemId, q, v, exception,
        originalSourceId: line.originalSourceId || journal.originalSourceId, originalLineIndex: line.originalLineIndex,
        kind: financialKind, reason: line.reason || journal.reason || '', sequence: sequence(journal.sequence) };
      if (journal.type === 'transfer') {
        id(line.fromGodownId, 'source godown'); id(line.toGodownId, 'destination godown');
        event.from = location(line.fromGodownId); event.to = location(line.toGodownId);
        if (event.from === event.to) fail('A stock transfer needs two different godowns');
        if (financialKind !== 'adjustment') fail('A godown transfer cannot record a purchase or sale');
      } else {
        event.godownId = location(line.godownId || (line.direction === 'out' ? line.fromGodownId : line.toGodownId));
        event.direction = journal.type === 'receipt' ? 'in' : journal.type === 'issue' ? 'out' : line.direction;
        if (journal.type !== 'physical' && !['in', 'out'].includes(event.direction)) fail('Choose inward or outward stock adjustment');
        if ((['purchase', 'sales-return'].includes(financialKind) && event.direction !== 'in') || (['sale', 'purchase-return'].includes(financialKind) && event.direction !== 'out')) fail('Stock financial treatment and quantity direction differ');
      }
      events.push(event);
    });
  }
  events.push(...itcStockReviews(company, vouchers));
  events.forEach((event, order) => { event.order = order; });
  events.sort((a, b) => a.date.localeCompare(b.date) || a.sequence - b.sequence || a.order - b.order);
  return { config, states, godowns, location, allocations, events };
}

function replay(company, vouchers, boundary, exclusive = false) {
  const book = prepare(company, vouchers, boundary, exclusive);
  const { states, godowns } = book;
  for (const state of states.values()) state.trackedOrigins = new Set();
  for (const event of book.events) if (event.kind === 'itc-cost' && event.costDelta && event.date <= boundary && !(exclusive && event.date === boundary)) states.get(event.itemId).trackedOrigins.add(`${event.originSourceId}:${event.originLineIndex}`);
  const originalWeight = (state, sourceId, lineIndex, q) => state.trackedOrigins.has(`${sourceId}:${lineIndex ?? 0}`) ? new Map([[`${sourceId}:${lineIndex ?? 0}`, ratio(q)]]) : new Map();
  const issues = [];
  const purchaseFlows = [];
  const adjustmentFlows = [];
  function issue(state, event, code, message, godownId) {
    const row = { itemId: state.master.id, ...(godownId ? { godownId } : {}), code, message, sourceId: event.sourceId };
    state.issues.push(row); issues.push(row);
  }
  function rebalance(state, total = null) {
    if (state.method !== 'moving-average') return;
    const lots = state.lots.filter(lot => lot.q > 0n);
    if (!valued(state.lots) || total === null && !valued(lots)) { for (const lot of lots) lot.v = null; return; }
    let remaining = total ?? known(lots);
    let remainingQuantity = current(lots);
    if (remaining < 0n) { for (const lot of lots) lot.v = null; return; }
    for (const lot of lots) {
      const part = fraction(remaining, lot.q, remainingQuantity);
      lot.v = part; remaining -= part; remainingQuantity -= lot.q;
    }
  }
  function record(state, event, godownId, q, v, lineage, suffix = '') {
    const local = state.lots.filter(lot => lot.godownId === godownId);
    const row = { id: `${event.sourceId}:${event.lineIndex ?? 0}:${godownId}${suffix}`, sourceId: event.sourceId, sourceType: event.sourceType,
      sourceRef: event.sourceRef || null, number: event.number || '', date: event.date, lineIndex: event.lineIndex ?? 0, financialKind: event.kind || 'adjustment',
      itemId: state.master.id, godownId, godownName: godowns.get(godownId).name, quantity: formatted(q), valuePaise: event.uncertainTax || v === null ? null : number(v),
      runningQuantity: formatted(current(local)), runningValuePaise: valued(local) ? number(known(local)) : null,
      originalSourceId: event.originalSourceId || null,
      costReviewIds: event.costReviewIds || [], costReviewedOn: event.costReviewedOn || null,
      costPending: Boolean(event.uncertainTax),
      lineage: lineage.map(part => ({ sourceId: part.sourceId, lineIndex: part.lineIndex ?? 0, quantity: formatted(part.q), valuePaise: part.v === null ? null : number(part.v) })) };
    state.movements.push(row);
    return row;
  }
  function receive(state, event, godownId, q, v, lineage = null) {
    const fragments = lineage || [{ sourceId: event.sourceId, lineIndex: event.lineIndex, q, v }];
    const receiptOrigins = new Map();
    if (state.trackedOrigins.size) for (const fragment of fragments) addOrigins(receiptOrigins, fragment.origins || originalWeight(state, fragment.sourceId, fragment.lineIndex, fragment.q));
    if (event.sourceType !== 'transfer') addOrigins(state.origins, receiptOrigins);
    // A receipt can fill a recorded shortage but cannot retroactively price that sale.
    let remainder = q; let remainingValue = v;
    for (const debt of state.lots.filter(lot => lot.godownId === godownId && lot.q < 0n)) {
      if (!remainder) break;
      const used = remainder < -debt.q ? remainder : -debt.q;
      const part = remainingValue === null ? null : fraction(remainingValue, used, remainder);
      debt.q += used; remainder -= used;
      if (remainingValue !== null) remainingValue -= part;
    }
    state.lots = state.lots.filter(lot => lot.q !== 0n);
    if (remainder) {
      let remainingQ = q; let receiptQ = remainder; let receiptV = remainingValue;
      for (const fragment of fragments) {
        const share = fragment === fragments.at(-1) ? receiptQ : fraction(receiptQ, fragment.q, remainingQ);
        const part = receiptV === null ? null : fraction(receiptV, share, receiptQ);
        if (share) state.lots.push({ sourceId: fragment.sourceId, lineIndex: fragment.lineIndex, date: event.date, godownId, q: share, v: part,
          origins: state.trackedOrigins.size ? fragment.origins ? scaleOrigins(fragment.origins, share, fragment.q) : originalWeight(state, fragment.sourceId, fragment.lineIndex, share) : undefined });
        receiptQ -= share; remainingQ -= fragment.q;
        if (receiptV !== null) receiptV -= part;
      }
    }
    rebalance(state);
    record(state, event, godownId, q, v, fragments);
  }
  function consume(state, event, godownId, q, preferred = null, forced = null, requireBasis = false) {
    const available = state.lots.filter(lot => lot.godownId === godownId && lot.q > 0n);
    const selected = preferred ? available.filter(lot => lot.sourceId === preferred && (event.originalLineIndex === undefined || lot.lineIndex === event.originalLineIndex)) : available;
    const fallback = preferred ? available.filter(lot => !selected.includes(lot)) : [];
    let remainder = q;
    const fragments = [];
    const totalBefore = known(state.lots);
    const pricedBefore = valued(state.lots);
    const quantityBefore = current(state.lots);
    const removedOrigins = new Map();
    if (!requireBasis && forced === null && state.method === 'moving-average' && pricedBefore && current(state.lots) >= q) forced = fraction(totalBefore, q, current(state.lots));
    let preferredShortage = false;
    for (const lot of [...selected, ...fallback]) {
      if (!remainder) break;
      if (preferred && fallback.includes(lot)) preferredShortage = true;
      const used = remainder < lot.q ? remainder : lot.q;
      const cost = lot.v === null ? null : fraction(lot.v, used, lot.q);
      const origins = state.trackedOrigins.size ? scaleOrigins(lot.origins || originalWeight(state, lot.sourceId, lot.lineIndex, lot.q), used, lot.q) : new Map();
      addOrigins(removedOrigins, origins);
      if (lot.origins) addOrigins(lot.origins, origins, -1n);
      fragments.push({ sourceId: lot.sourceId, lineIndex: lot.lineIndex, q: used, v: cost, origins });
      lot.q -= used; if (lot.v !== null) lot.v -= cost; remainder -= used;
    }
    state.lots = state.lots.filter(lot => lot.q !== 0n);
    if (remainder) {
      state.lots.push({ sourceId: event.sourceId, lineIndex: event.lineIndex, date: event.date, godownId, q: -remainder, v: null });
      fragments.push({ sourceId: event.sourceId, lineIndex: event.lineIndex, q: remainder, v: null });
      issue(state, event, 'negative-stock', 'This dated movement exceeds the stock available in its godown; cost is incomplete.', godownId);
    }
    let cost = fragments.every(part => part.v !== null) ? sum(fragments.map(part => part.v)) : null;
    if (preferredShortage && forced === null && state.method === 'fifo') {
      cost = null;
      issue(state, event, 'original-basis-unavailable', 'The original purchase stock is no longer available here; record an explicit return cost and basis.', godownId);
    }
    if (forced !== null) {
      cost = forced;
      // Average-cost purchase returns remove the original purchase basis, not today's average.
      if (state.method === 'moving-average' && pricedBefore && !remainder) {
        if (forced > totalBefore) {
          issue(state, event, 'return-cost-exceeds-stock', 'The return cost exceeds remaining inventory value.', godownId);
          for (const lot of state.lots) lot.v = null;
          cost = null;
        } else rebalance(state, totalBefore - forced);
      } else if (state.method === 'fifo' && forced !== sum(fragments.map(part => part.v ?? 0n))) {
        // An explicit exception documents the cost difference; unresolved carrying
        // value cannot be silently charged to arbitrary remaining FIFO layers.
        issue(state, event, 'return-cost-difference', 'Explicit return cost differs from the available FIFO layers; carrying value needs reconciliation.', godownId);
        for (const lot of state.lots.filter(lot => lot.godownId === godownId)) lot.v = null;
      }
      let remainingCost = cost; let remainingQ = q;
      for (const part of fragments) {
        part.v = remainingCost === null ? null : fraction(remainingCost, part.q, remainingQ);
        if (remainingCost !== null) remainingCost -= part.v;
        remainingQ -= part.q;
      }
    }
    if (requireBasis && forced === null) {
      cost = null;
      for (const fragment of fragments) fragment.v = null;
    }
    if (state.trackedOrigins.size && event.sourceType !== 'transfer') {
      let remainingOrigins;
      if (state.method === 'moving-average' && quantityBefore > 0n && q <= quantityBefore && event.kind !== 'purchase-return') {
        const pooled = scaleOrigins(state.origins, q, quantityBefore);
        removedOrigins.clear(); addOrigins(removedOrigins, pooled);
        // Scale the surviving pool directly. Subtracting two independently
        // bounded copies would magnify interval error over long histories.
        remainingOrigins = scaleOrigins(state.origins, quantityBefore - q, quantityBefore);
      } else if (event.kind === 'purchase-return' && event.returnOrigins) {
        removedOrigins.clear(); addOrigins(removedOrigins, event.returnOrigins);
      }
      if (remainingOrigins) state.origins = remainingOrigins;
      else addOrigins(state.origins, removedOrigins, -1n);
    }
    record(state, event, godownId, -q, cost === null ? null : -cost, fragments);
    return { fragments, cost, origins: removedOrigins };
  }
  function sourceKey(sourceId, lineIndex) { return `${sourceId}:${lineIndex}`; }
  function originalParts(state, event, q, expected) {
    const matches = [...state.sources.values()].filter(source => source.sourceId === event.originalSourceId && source.kind === expected && (event.originalLineIndex === undefined || source.lineIndex === event.originalLineIndex));
    let left = q; const result = [];
    for (const source of matches) {
      const key = sourceKey(source.sourceId, source.lineIndex);
      const returned = state.returns.get(key) || 0n;
      const available = source.q - returned;
      const used = left < available ? left : available;
      if (used <= 0n) continue;
      const value = source.v === null ? null : fraction(source.v, returned + used, source.q) - fraction(source.v, returned, source.q);
      result.push({ sourceId: source.sourceId, lineIndex: source.lineIndex, q: used, v: value,
        origins: state.trackedOrigins.size ? scaleOrigins(source.origins || originalWeight(state, source.sourceId, source.lineIndex, source.q), used, source.q) : undefined });
      state.returns.set(key, returned + used); left -= used;
      if (!left) break;
    }
    if (left) {
      issue(state, event, 'unlinked-return-cost', 'The return has no matching original quantity and cost available; record its original source or explicit cost basis.');
      result.push({ sourceId: event.originalSourceId || event.sourceId, lineIndex: event.originalLineIndex, q: left, v: null });
    }
    return result;
  }
  function distribute(total, allocations) {
    let left = total; let remaining = sum(allocations.map(row => row.q));
    return allocations.map(row => {
      const part = left === null ? null : fraction(left, row.q, remaining);
      if (left !== null) left -= part;
      remaining -= row.q;
      return { ...row, v: part };
    });
  }
  function reviewCost(state, event) {
    const key = sourceKey(event.originSourceId, event.originLineIndex);
    const reducePending = (pendingKey, value) => {
      if (!value) return;
      const next = (state.pendingTax.get(pendingKey) || 0n) - BigInt(value);
      if (next < 0n) fail('ITC review exceeds the dated pending stock tax');
      state.pendingTax.set(pendingKey, next);
    };
    reducePending(key, event.pendingReduction);
    if (event.noteSourceId) reducePending(sourceKey(event.noteSourceId, event.noteLineIndex), event.notePendingReduction);
    const source = state.sources.get(key);
    const delta = BigInt(event.costDelta);
    const byGodown = new Map();
    let inventoryDelta = 0n;
    if (delta) {
      const netQuantity = source ? source.q - (state.purchaseReturned.get(key) || 0n) : 0n;
      const share = state.origins.get(key) || zeroRatio();
      if (!source || netQuantity <= 0n || ratioSign(share) < 0) {
        issue(state, event, 'itc-cost-lineage', 'Allocate this dated tax cost to its original non-returned stock before valuing the remaining goods.');
      } else {
        inventoryDelta = ratioValue(delta, share, netQuantity);
        if (state.method === 'moving-average') {
          if (!valued(state.lots) || known(state.lots) + inventoryDelta < 0n) {
            issue(state, event, 'itc-cost-lineage', 'The moving-average pool contains unresolved cost lineage for this tax adjustment.');
          } else {
            const before = new Map([...godowns.keys()].map(godownId => [godownId, known(state.lots.filter(lot => lot.godownId === godownId))]));
            rebalance(state, known(state.lots) + inventoryDelta);
            for (const godownId of godowns.keys()) {
              const change = known(state.lots.filter(lot => lot.godownId === godownId)) - before.get(godownId);
              if (change) byGodown.set(godownId, change);
            }
          }
        } else {
          let cumulative = zeroRatio(), allocated = 0n;
          for (const lot of state.lots) {
            const lotShare = lot.origins?.get(key);
            if (!lotShare || !ratioSign(lotShare)) continue;
            cumulative = addRatio(cumulative, lotShare);
            const target = ratioValue(delta, cumulative, netQuantity);
            const part = target - allocated; allocated = target;
            if (lot.v === null || lot.v + part < 0n) issue(state, event, 'itc-cost-lineage', 'This remaining FIFO layer has unresolved cost for the dated tax adjustment.', lot.godownId);
            else { lot.v += part; byGodown.set(lot.godownId, (byGodown.get(lot.godownId) || 0n) + part); }
          }
          if (allocated !== inventoryDelta) issue(state, event, 'itc-cost-lineage', 'The remaining FIFO layers do not reconcile to their original tax-cost lineage.');
        }
        // Keep the original unit basis for subsequent linked returns, while the
        // cost itself enters inventory/realised expense on this decision date.
        for (const previous of state.sources.values()) {
          const originalShare = previous.origins?.get(key);
          if (previous.v !== null && originalShare && ['purchase', 'sale'].includes(previous.kind)) previous.v += ratioValue(delta, originalShare, netQuantity);
        }
      }
    }
    for (const movement of state.movements.filter(row => row.sourceId === event.originSourceId && row.lineIndex === event.originLineIndex)) {
      movement.costReviewIds = [...new Set([...movement.costReviewIds, event.recordId])]; movement.costReviewedOn = event.date;
    }
    if (!byGodown.size) byGodown.set('main', 0n);
    for (const [godownId, value] of byGodown) {
      const movement = record(state, { ...event, costReviewIds: [event.recordId], costReviewedOn: event.date }, godownId, 0n, value,
        [{ sourceId: event.originSourceId, lineIndex: event.originLineIndex, q: 0n, v: value }]);
      movement.costBridge = { taxCostPaise: event.costDelta, inventoryCostPaise: number(inventoryDelta), realisedCostPaise: number(delta - inventoryDelta) };
    }
    if (event.purchaseFlowDelta) purchaseFlows.push({ date: event.date, value: BigInt(event.purchaseFlowDelta) });
  }
  if (boundary >= company.booksFrom) for (const state of states.values()) {
    const { master, settings } = state;
    const total = quantity(master.openingQuantity ?? '0', true);
    let value = optionalCost(settings.openingValuePaise);
    let openings;
    if (settings.openingAllocations !== undefined) {
      if (!Array.isArray(settings.openingAllocations) || (!settings.openingAllocations.length && total)) fail('Enter opening stock allocations');
      openings = settings.openingAllocations.map(row => ({ godownId: book.location(row.godownId), q: quantity(row.quantity), v: optionalCost(row.valuePaise) }));
      if (new Set(openings.map(row => row.godownId)).size !== openings.length) fail('Combine duplicate opening godown allocations');
      if (sum(openings.map(row => row.q)) !== total) fail('Opening godown quantities must equal the item opening quantity');
      if (openings.every(row => row.v !== null)) {
        const allocated = sum(openings.map(row => row.v));
        if (value !== null && value !== allocated) fail('Opening godown values must equal the item opening value');
        value = allocated;
      } else if (openings.some(row => row.v !== null)) fail('Value every opening allocation or supply only the total opening value');
      else if (value !== null) openings = distribute(value, openings);
    } else openings = total ? [{ godownId: 'main', q: total, v: value }] : [];
    if (!total && value) fail('Zero opening stock cannot have a nonzero value');
    if (total && value === null) issue(state, { sourceId: 'opening:' + master.id }, 'unpriced-opening', 'Enter the actual opening inventory value; no current item price has been substituted.');
    for (const opening of openings) {
      const event = { sourceId: 'opening:' + master.id, sourceType: 'opening', date: company.booksFrom, lineIndex: 0 };
      receive(state, event, opening.godownId, opening.q, opening.v);
    }
  }
  for (const event of book.events) {
    if (event.date > boundary || exclusive && event.date === boundary) continue;
    const state = states.get(event.itemId);
    if (event.kind === 'itc-cost') { reviewCost(state, event); continue; }
    if (event.uncertainTax) state.pendingTax.set(sourceKey(event.sourceId, event.lineIndex), BigInt(event.pendingTaxPaise));
    if (event.noQuantity) {
      if (event.kind.startsWith('purchase') && event.v !== 0n) {
        purchaseFlows.push({ date: event.date, value: event.v === null ? null : (event.kind === 'purchase-return' ? -event.v : event.v) });
        issue(state, event, 'financial-note-cost-allocation', 'This purchase value adjustment has no quantity allocation; its inventory cost allocation is incomplete.');
      }
      continue;
    }
    if (event.sourceType === 'transfer') {
      if (current(state.lots.filter(lot => lot.godownId === event.from)) < event.q) fail('A transfer exceeds the dated stock available in its source godown');
      const removed = consume(state, event, event.from, event.q);
      receive(state, event, event.to, event.q, removed.cost, removed.fragments);
      continue;
    }
    let direction = event.direction || (['purchase', 'sales-return'].includes(event.kind) ? 'in' : 'out');
    let q = event.q;
    if (event.sourceType === 'physical') {
      const existing = current(state.lots.filter(lot => lot.godownId === event.godownId));
      const delta = event.q - existing;
      if (!delta) continue;
      direction = delta > 0n ? 'in' : 'out'; q = delta < 0n ? -delta : delta;
    }
    const allocations = event.allocations || [{ godownId: event.godownId, q }];
    let v = event.v;
    const purchaseFlowValue = event.v;
    let returning = null;
    if (['sales-return', 'purchase-return'].includes(event.kind)) {
      if (event.exception === null || event.originalSourceId) {
        returning = originalParts(state, event, q, event.kind === 'sales-return' ? 'sale' : 'purchase');
      }
      v = event.exception !== null ? event.exception : returning.every(part => part.v !== null) ? sum(returning.map(part => part.v)) : null;
    }
    const moved = [];
    const movementOrigins = new Map();
    const returnOrigins = new Map();
    if (state.trackedOrigins.size && returning) for (const part of returning) {
      addOrigins(returnOrigins, part.origins || originalWeight(state, part.sourceId, part.lineIndex, part.q));
      if (event.kind === 'purchase-return') {
        const key = sourceKey(part.sourceId, part.lineIndex ?? 0);
        state.purchaseReturned.set(key, (state.purchaseReturned.get(key) || 0n) + part.q);
      }
    }
    for (const allocation of event.sourceReceiptAllocations || distribute(v, allocations)) {
      if (direction === 'in') {
        if (allocation.v === null && !returning && !event.uncertainTax) issue(state, event, 'unpriced-receipt', 'This inward stock has no explicit inventory cost.', allocation.godownId);
        const origins = state.trackedOrigins.size ? returning ? scaleOrigins(returnOrigins, allocation.q, q) : originalWeight(state, event.sourceId, event.lineIndex, allocation.q) : new Map();
        receive(state, event, allocation.godownId, allocation.q, allocation.v, event.kind === 'sales-return' && returning ? [{ sourceId: event.originalSourceId, lineIndex: event.originalLineIndex ?? 0, q: allocation.q, v: allocation.v, origins }] : null);
        addOrigins(movementOrigins, origins);
        moved.push({ sourceId: event.sourceId, lineIndex: event.lineIndex, q: allocation.q, v: allocation.v });
      } else {
        const force = event.kind === 'purchase-return' ? allocation.v : null;
        const removed = consume(state, { ...event, returnOrigins: returning && event.kind === 'purchase-return' ? scaleOrigins(returnOrigins, allocation.q, q) : null }, allocation.godownId, allocation.q, event.kind === 'purchase-return' && state.method === 'fifo' && event.exception === null ? event.originalSourceId : null, force, event.kind === 'purchase-return');
        addOrigins(movementOrigins, removed.origins);
        moved.push(...removed.fragments);
      }
    }
    const actualValue = moved.every(part => part.v !== null) ? sum(moved.map(part => part.v)) : null;
    state.sources.set(sourceKey(event.sourceId, event.lineIndex), { sourceId: event.sourceId, lineIndex: event.lineIndex, kind: event.kind, q, v: actualValue, origins: movementOrigins });
    if (event.kind === 'purchase' || event.kind === 'purchase-return') purchaseFlows.push({ date: event.date, value: purchaseFlowValue === null ? null : (event.kind === 'purchase-return' ? -purchaseFlowValue : purchaseFlowValue) });
    else if (event.kind === 'adjustment') adjustmentFlows.push({ date: event.date, value: actualValue === null ? null : (direction === 'out' ? -actualValue : actualValue) });
  }
  for (const state of states.values()) for (const [sourceId, tax] of state.pendingTax) if (tax > 0n) issue(state, { sourceId }, 'pending-tax-cost', 'Purchase tax recoverability is pending, so the final inventory cost is incomplete.');
  const items = [...states.values()].map(state => {
    const complete = valued(state.lots) && !state.issues.length;
    return { itemId: state.master.id, name: state.master.name, unit: state.master.unit, costingMethod: state.method,
      openingQuantity: state.master.openingQuantity || '0', quantity: formatted(current(state.lots)), valuePaise: complete ? number(known(state.lots)) : null,
      knownValuePaise: number(known(state.lots)), complete,
      godowns: [...godowns.values()].map(godown => {
        const lots = state.lots.filter(lot => lot.godownId === godown.id);
        const localComplete = valued(lots) && !state.issues.some(issue => !issue.godownId || issue.godownId === godown.id);
        return { godownId: godown.id, name: godown.name, quantity: formatted(current(lots)), valuePaise: localComplete ? number(known(lots)) : null, knownValuePaise: number(known(lots)), complete: localComplete };
      }),
      lots: state.lots.map(lot => ({ sourceId: lot.sourceId, lineIndex: lot.lineIndex ?? 0, date: lot.date, godownId: lot.godownId, quantity: formatted(lot.q), valuePaise: lot.v === null ? null : number(lot.v) })),
      movements: state.movements, issues: state.issues };
  });
  if (book.config.tally?.hasSourceGaps === true) {
    const sourceGaps = book.config.tally.sourceGaps || [];
    issues.push(...(sourceGaps.length ? sourceGaps : [{ code: 'source-stock-gaps', message: 'Some source inventory could not be projected into active stock.' }]).map(gap => ({ ...gap, sourceId: gap.reference || 'tally-source', itemId: gap.itemId || null })));
  }
  const complete = items.every(item => item.complete) && book.config.tally?.hasSourceGaps !== true;
  const totals = { complete, valuePaise: complete ? number(sum(items.map(item => BigInt(item.valuePaise)))) : null, knownValuePaise: number(sum(items.map(item => BigInt(item.knownValuePaise)))) };
  return { to: boundary, items, godowns: [...godowns.values()], totals, issues, _purchaseFlows: purchaseFlows, _adjustmentFlows: adjustmentFlows };
}

function publicState(state) { const { _purchaseFlows, _adjustmentFlows, ...result } = state; return result; }

export function stockState(company, vouchers, { to = todayISO() } = {}) {
  if (!isIsoDate(to)) fail('Enter the stock report date');
  return publicState(replay(company, vouchers, to));
}

export function stockOpening(company) {
  const openingCompany = { ...company, stock: { ...company.stock, journals: [] },
    ...(company.gst ? { gst: { ...company.gst, ...(company.gst.itc ? { itc: { ...company.gst.itc, records: [] } } : {}) } } : {}) };
  return publicState(replay(openingCompany, [], company.booksFrom, true));
}

export function stockPeriod(company, vouchers, { from = company.booksFrom, to = todayISO() } = {}) {
  if (!isIsoDate(from) || !isIsoDate(to) || from < company.booksFrom || from > to) fail('Enter a valid stock reporting period');
  const opening = replay(company, vouchers, from, true);
  const closing = replay(company, vouchers, to);
  const purchases = closing._purchaseFlows.filter(flow => flow.date >= from);
  const adjustments = closing._adjustmentFlows.filter(flow => flow.date >= from);
  const netPurchasesPaise = purchases.every(flow => flow.value !== null) ? number(sum(purchases.map(flow => flow.value))) : null;
  const netAdjustmentsPaise = adjustments.every(flow => flow.value !== null) ? number(sum(adjustments.map(flow => flow.value))) : null;
  const complete = opening.totals.complete && closing.totals.complete && netPurchasesPaise !== null && netAdjustmentsPaise !== null;
  const stockChangePaise = complete ? number(BigInt(opening.totals.valuePaise) - BigInt(closing.totals.valuePaise)) : null;
  return { from, to, opening: publicState(opening), closing: publicState(closing), financial: {
    complete, openingValuePaise: opening.totals.valuePaise, closingValuePaise: closing.totals.valuePaise,
    netPurchasesPaise, netAdjustmentsPaise, stockChangePaise,
    costOfGoodsSoldPaise: complete ? number(BigInt(stockChangePaise) + BigInt(netPurchasesPaise) + BigInt(netAdjustmentsPaise)) : null,
  } };
}

export function assertStockBook(company, vouchers) {
  // Full replay validates future-dated entries too. Gaps in valuation are explicit
  // report data, not corruption: old unpriced/negative-stock books remain readable.
  const to = [...vouchers.map(voucher => voucher.date), ...(company.stock?.journals || []).map(journal => journal.date), company.booksFrom].sort().at(-1);
  replay(company, vouchers, to);
  return true;
}
