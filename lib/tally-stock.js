import { workbookSourceFingerprint } from "./tally-workbook-references.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { quantityMicros, formatQuantity } from "./gst.js";
import { attribute, children, findNodes, keyName, value } from "./tally-format.js";
import { tallyAmount, tallyDate } from "./tally-values.js";

export const TALLY_STOCK_SOURCES = [
  "https://help.tallysolutions.com/sample-xml/",
  "https://help.tallysolutions.com/developer-reference/tally-definition-language/appendix/",
  "https://help.tallysolutions.com/inventory-and-manufacturing-faq/",
  "https://help.tallysolutions.com/costing-methods/",
];
const digest = input => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const key = input => String(input || "").trim().toLocaleLowerCase("en-IN");
const sourceName = node => attribute(node, "NAME") || value(node, "NAME") || findNodes(node, "NAME")[0]?.text.trim() || "";
const yes = input => /^(yes|true|1)$/i.test(input);
const absent = input => !input || /^(not applicable|primary|\u0004 not applicable)$/i.test(input.trim());
const idFor = (prefix, name) => `${prefix}-tally-${digest(key(name)).slice(0, 20)}`;
const safeSum = amounts => {
  const total = amounts.reduce((sum, amount) => sum + BigInt(amount), 0n);
  if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Stock value exceeds exact paise");
  return Number(total);
};
const canonicalNode = node => ({ tag: keyName(node.tag), attrs: Object.fromEntries(Object.entries(node.attrs).sort()), text: node.text.trim(), children: node.children.map(canonicalNode) });
const sourceHash = records => workbookSourceFingerprint(records) || digest(records.map(record => ({ id: record.recordId, type: record.type, node: canonicalNode(record.node) })).sort((a, b) => a.id.localeCompare(b.id)));

export function tallyStockPostingHash(voucher) {
  const amounts = new Map();
  for (const line of voucher.lines) {
    const name = `${line.ledgerId}:${line.dc}`;
    amounts.set(name, (amounts.get(name) || 0n) + BigInt(line.paise));
  }
  return digest({ type: voucher.type, date: voucher.date, lines: [...amounts].map(([name, paise]) => [name, String(paise)]).sort(([a], [b]) => a.localeCompare(b)) });
}

function quantity(input, unit, precision, allowZero = true) {
  const raw = String(input || "").trim().replace(/,/g, "");
  const match = /^(\d+(?:\.\d+)?)(?:\s+(.+))?$/.exec(raw || "0");
  if (!match || (match[2] && key(match[2]) !== key(unit))) throw new Error(`Quantity ${raw || "(empty)"} is not in the simple base unit ${unit}`);
  if ((match[1].split(".")[1] || "").replace(/0+$/, "").length > precision) throw new Error(`Quantity exceeds ${unit}'s ${precision} decimal places`);
  return quantityMicros(match[1], allowZero);
}
function positiveValue(input, emptyIsUnknown = false) {
  if (!String(input || "").trim() && emptyIsUnknown) return null;
  const amount = tallyAmount(input, true);
  if (amount < 0) throw new Error("Negative opening stock values require source review");
  return amount;
}
function flagDirection(node, required) {
  const flag = value(node, "ISDEEMEDPOSITIVE");
  if (!/^(yes|no|true|false|1|0)$/i.test(flag)) throw new Error("Inventory direction needs an explicit Tally debit flag");
  const direction = yes(flag) ? "in" : "out";
  if (required && direction !== required) throw new Error("Inventory direction contradicts the source voucher type");
  return direction;
}
function assertPrimaryBatch(node) {
  const batch = value(node, "BATCHNAME");
  if (batch && key(batch) !== "primary batch") throw new Error(`Named batch ${batch} is retained in source; batch valuation is not projected`);
  for (const field of ["ORDERNO", "TRACKINGNUMBER"]) {
    const text = value(node, field);
    if (text && !absent(text)) throw new Error(`${field} ${text} requires the order/receipt-note workflow`);
  }
}

function sourceProjection(company, vouchers, records) {
  const issues = [], rows = [];
  const review = (record, message, code = "tally-stock-source-exception") => {
    const issue = { severity: "review", code, reference: record.recordId, message };
    issues.push(issue);
    rows.push({ recordId: record.recordId, kind: record.type, name: sourceName(record.node) || value(record.node, "VOUCHERNUMBER"), status: "exception", message });
  };
  const source = records.filter(record => record.disposition !== "duplicate-source");
  const units = new Map();
  for (const record of source.filter(record => record.type === "UNIT")) {
    const name = sourceName(record.node), simple = value(record.node, "ISSIMPLEUNIT"), precision = value(record.node, "DECIMALPLACES");
    if (yes(simple) && /^[0-6]$/.test(precision)) units.set(key(name), { name, precision: Number(precision) });
    else if (source.some(row => row.type === "STOCKITEM" && [value(row.node, "BASEUNITS"), value(row.node, "ADDITIONALUNITS")].some(unit => key(unit) === key(name)))) review(record, `Unit ${name}: compound units and missing/unsupported precision are retained in source`);
  }
  const godowns = [{ id: "main", name: "Main Location" }], locations = new Map([["main location", "main"]]);
  const godownDetails = [];
  for (const record of source.filter(record => record.type === "GODOWN")) {
    const name = sourceName(record.node);
    if (!name || name.length > 120) { review(record, "Godown name is missing or too long"); continue; }
    const id = key(name) === "main location" ? "main" : idFor("sg", name);
    if (!locations.has(key(name))) godowns.push({ id, name });
    locations.set(key(name), id);
    godownDetails.push({ id, recordId: record.recordId, parent: value(record.node, "PARENT") });
    if (!absent(value(record.node, "PARENT"))) review(record, `${name}: the source godown hierarchy is retained. Native balances use individual locations without parent rollups`, "tally-stock-godown-hierarchy");
  }
  const location = (node, fallback = "Main Location") => {
    const name = value(node, "GODOWNNAME") || fallback;
    const id = locations.get(key(name));
    if (!id) throw new Error(`Godown ${name} is missing from the source masters`);
    const destination = value(node, "DESTINATIONGODOWNNAME");
    if (destination && key(destination) !== key(name)) throw new Error("Distinct destination godowns require an explicit stock transfer voucher");
    return id;
  };
  const masters = [], items = {}, byName = new Map(), itemDetails = [];
  for (const record of source.filter(record => record.type === "STOCKITEM")) {
    try {
      const name = sourceName(record.node), baseUnit = value(record.node, "BASEUNITS"), unit = units.get(key(baseUnit));
      if (!name || name.length > 120) throw new Error("Stock item name is missing or too long");
      if (!unit) throw new Error(`Stock item ${name} needs its simple unit ${baseUnit || "(empty)"} and declared precision`);
      if (!absent(value(record.node, "ADDITIONALUNITS"))) throw new Error("Alternate or compound stock units require conversion review");
      for (const field of ["ISBATCHWISEON", "ISPERISHABLEON", "TREATALLPURCHASESASCONSUMED", "IGNOREPHYSICALDIFFERENCE"]) if (yes(value(record.node, field))) throw new Error(`${field} inventory policy is not supported`);
      const method = value(record.node, "COSTINGMETHOD");
      if (method && !/^fifo perpetual$/i.test(method)) throw new Error(`Source costing method ${method} differs from Ledgercraft perpetual FIFO and is not activated`);
      const id = idFor("si", name), opening = quantity(value(record.node, "OPENINGBALANCE"), unit.name, unit.precision);
      const openingValue = positiveValue(value(record.node, "OPENINGVALUE"), true);
      if (!opening && openingValue) throw new Error("Opening value has no opening quantity");
      const batches = children(record.node, "BATCHALLOCATIONS");
      const allocations = batches.length ? batches.map(batch => {
        assertPrimaryBatch(batch);
        return { godownId: location(batch), quantity: formatQuantity(quantity(value(batch, "OPENINGBALANCE") || value(batch, "ACTUALQTY"), unit.name, unit.precision)), valuePaise: positiveValue(value(batch, "OPENINGVALUE") || value(batch, "AMOUNT"), true) };
      }) : opening ? [{ godownId: location(record.node), quantity: formatQuantity(opening), valuePaise: openingValue }] : [];
      if (new Set(allocations.map(row => row.godownId)).size !== allocations.length) throw new Error("Multiple opening allocations in the same godown require batch review");
      if (allocations.reduce((sum, row) => sum + quantityMicros(row.quantity, true), 0n) !== opening) throw new Error("Opening godown quantities do not equal the stock item opening");
      if (openingValue !== null && (allocations.some(row => row.valuePaise === null) || safeSum(allocations.map(row => row.valuePaise)) !== openingValue)) throw new Error("Opening godown values do not equal the stock item opening value");
      masters.push({ id, name, unit: unit.name, openingQuantity: formatQuantity(opening) });
      items[id] = { costingMethod: "fifo", openingValuePaise: openingValue, openingAllocations: allocations };
      byName.set(key(name), { id, name, unit: unit.name, precision: unit.precision });
      itemDetails.push({ id, recordId: record.recordId, precision: unit.precision, sourceCostingMethod: method, parent: value(record.node, "PARENT") });
      rows.push({ recordId: record.recordId, kind: "STOCKITEM", name, status: "ready", quantity: formatQuantity(opening), unit: unit.name, valuePaise: openingValue, message: method ? `Source ${method}; Ledgercraft ${items[id].costingMethod} policy` : "Source costing unspecified; Ledgercraft FIFO policy applies" });
      if (record.sourceFormat==="xlsx-reference" || value(record.node,"XLSXOPENINGUNKNOWN")==="Yes") {
        issues.push({severity:"review",code:"tally-stock-workbook-opening",reference:record.recordId,message:`${name}: the workbook supplies no opening balance. Quantities show movement from the selected starting date and closing valuation needs opening evidence.`});
      }
      if (!method) issues.push({ severity: "review", code: "tally-stock-valuation-policy", reference: record.recordId, message: `${name}: source costing method is unspecified. Ledgercraft uses perpetual FIFO; this does not establish Tally valuation equivalence.` });
      if (opening && openingValue === null) issues.push({ severity: "review", code: "tally-stock-opening-cost-unknown", reference: record.recordId, message: `${name}: opening cost was not exported; value remains incomplete.` });
    } catch (error) { review(record, `${sourceName(record.node) || "Stock item"}: ${error.message}`); }
  }
  const journalSources = [], journals = [];
  const inventoryParts = (entry, required, quantityOnly = false, billedAsActual = false) => {
    const item = byName.get(key(value(entry, "STOCKITEMNAME")));
    if (!item) throw new Error(`Stock item ${value(entry, "STOCKITEMNAME") || "(empty)"} has no supported master`);
    if (["ADDITIONALCOSTDETAILS", "COSTTRACKALLOCATIONS"].some(tag => findNodes(entry, tag).length)) throw new Error("Allocated additional inventory costs need source valuation review");
    flagDirection(entry, required);
    const actual = value(entry, "ACTUALQTY") || (billedAsActual ? value(entry, "BILLEDQTY") : "");
    if (!actual) throw new Error("Actual stock quantity was not exported");
    const total = quantity(actual, item.unit, item.precision, false);
    const billed = quantity(value(entry, "BILLEDQTY") || actual, item.unit, item.precision);
    const signedAmount = quantityOnly && !value(entry, "AMOUNT") ? null : tallyAmount(value(entry, "AMOUNT"));
    if (signedAmount && (signedAmount < 0) !== (required === "in")) throw new Error("Inventory amount sign contradicts the inventory direction");
    const amount = signedAmount === null ? null : Math.abs(signedAmount);
    const batches = children(entry, "BATCHALLOCATIONS");
    const parts = batches.length ? batches.map(batch => {
      assertPrimaryBatch(batch);
      const batchAmount = quantityOnly && !value(batch, "AMOUNT") ? null : tallyAmount(value(batch, "AMOUNT"));
      if (batchAmount && (batchAmount < 0) !== (required === "in")) throw new Error("Inventory godown amount sign contradicts the inventory direction");
      return { itemId: item.id, quantity: formatQuantity(quantity(value(batch, "ACTUALQTY"), item.unit, item.precision, false)), billedQuantity: formatQuantity(quantity(value(batch, "BILLEDQTY") || value(batch, "ACTUALQTY"), item.unit, item.precision)), godownId: location(batch), valuePaise: batchAmount === null ? null : Math.abs(batchAmount) };
    }) : [{ itemId: item.id, quantity: formatQuantity(total), billedQuantity: formatQuantity(billed), godownId: location(entry), valuePaise: amount }];
    const amountsMatch = amount === null ? parts.every(row => row.valuePaise === null) : parts.every(row => row.valuePaise !== null) && safeSum(parts.map(row => row.valuePaise)) === amount;
    if (parts.reduce((sum, row) => sum + quantityMicros(row.quantity), 0n) !== total || parts.reduce((sum, row) => sum + quantityMicros(row.billedQuantity, true), 0n) !== billed || !amountsMatch) throw new Error("Inventory godown breakups do not equal the source quantity and amount");
    return parts;
  };
  for (const record of source.filter(record => record.type === "VOUCHER")) {
    const node = record.node, sourceType = value(node, "VOUCHERTYPENAME") || attribute(node, "VCHTYPE"), type = key(record.targetType || sourceType);
    const direct = [...children(node, "ALLINVENTORYENTRIES"), ...children(node, "INVENTORYENTRIES")];
    const ledgerInventory = direct.length ? [] : findNodes(node, "INVENTORYALLOCATIONS");
    const incoming = children(node, "INVENTORYENTRIESIN"), outgoing = children(node, "INVENTORYENTRIESOUT");
    if (![...direct, ...ledgerInventory, ...incoming, ...outgoing].length) continue;
    if (["ISCANCELLED", "ISOPTIONAL", "ISDELETED"].some(field => yes(value(node, field)))) continue;
    try {
      for (const field of ["ISCANCELLED", "ISOPTIONAL", "ISDELETED", "ISPOSTDATED"]) {
        const flag = value(node, field);
        if (flag && !/^(yes|no|true|false|1|0)$/i.test(flag)) throw new Error(`Unknown inventory voucher flag ${field}`);
      }
      const action = attribute(node, "ACTION");
      if (action && !/^(create|alter)$/i.test(action)) throw new Error(`Inventory voucher action ${action} needs source review`);
      const date = tallyDate(value(node, "DATE"));
      if (date < company.booksFrom) throw new Error("Inventory movement predates the books beginning date");
      if (value(node, "EFFECTIVEDATE") && tallyDate(value(node, "EFFECTIVEDATE")) !== date) throw new Error("Inventory date differs from its effective date");
      const id = `sj-tally-${record.recordId.slice(2)}`, number = value(node, "VOUCHERNUMBER") || id;
      let journal;
      if (type === "stock journal") {
        if (!incoming.length || !outgoing.length || direct.length || ledgerInventory.length) throw new Error("Stock journal needs explicit source and destination inventory collections");
        if (findNodes(node, "ADDITIONALCOSTDETAILS").length || findNodes(node, "COSTTRACKALLOCATIONS").length) throw new Error("Manufacturing/additional stock cost is not a quantity transfer");
        const ins = incoming.flatMap(entry => inventoryParts(entry, "in", true)), outs = outgoing.flatMap(entry => inventoryParts(entry, "out", true));
        const lines = [];
        for (const itemId of new Set([...ins, ...outs].map(row => row.itemId))) {
          const inRows = ins.filter(row => row.itemId === itemId).map(row => ({ ...row, remaining: quantityMicros(row.quantity) }));
          const outRows = outs.filter(row => row.itemId === itemId).map(row => ({ ...row, remaining: quantityMicros(row.quantity) }));
          const valueKnown = [...inRows, ...outRows].every(row => row.valuePaise !== null);
          const valueUnknown = [...inRows, ...outRows].every(row => row.valuePaise === null);
          if (inRows.reduce((sum, row) => sum + row.remaining, 0n) !== outRows.reduce((sum, row) => sum + row.remaining, 0n) || (!valueUnknown && (!valueKnown || safeSum(inRows.map(row => row.valuePaise)) !== safeSum(outRows.map(row => row.valuePaise))))) throw new Error("Stock journal changes item quantity or value; manufacturing/valuation requires review");
          for (const out of outRows) for (const into of inRows) {
            const moved = out.remaining < into.remaining ? out.remaining : into.remaining;
            if (!moved) continue;
            if (out.godownId === into.godownId) throw new Error("Source and destination godown must differ for an inventory transfer");
            lines.push({ itemId, quantity: formatQuantity(moved), fromGodownId: out.godownId, toGodownId: into.godownId });
            out.remaining -= moved; into.remaining -= moved;
          }
        }
        journal = { id, date, number, type: "transfer", lines, sourceRef: record.recordId };
      } else {
        if (!["sales", "purchase"].includes(type) || record.disposition !== "voucher") throw new Error(`${sourceType} stock movement is retained for its specific inventory workflow`);
        const voucher = vouchers.find(voucher => voucher.id === record.voucherId);
        if (!voucher || !record.originalPosting || tallyStockPostingHash(voucher) !== tallyStockPostingHash(record.originalPosting)) {
          issues.push({ severity: "blocking", code: "tally-stock-accounting-changed", reference: record.recordId, message: "Accounting voucher changed or was removed after import; review it before activating stock" });
          throw new Error("Accounting voucher changed or was removed after import; review it before activating stock");
        }
        const inward = type === "purchase", parts = [...direct, ...ledgerInventory].flatMap(entry => inventoryParts(entry, inward ? "in" : "out", false, record.sourceFormat==="xlsx" && company.tallyWorkbook?.useBilledAsActual===true));
        const targetGroup = inward ? "g-purchase" : "g-sales";
        const inGroup = ledgerId => {
          let groupId = company.ledgers.find(ledger => ledger.id === ledgerId)?.groupId;
          const seen = new Set();
          while (groupId && !seen.has(groupId)) { if (groupId === targetGroup) return true; seen.add(groupId); groupId = company.groups.find(group => group.id === groupId)?.parentId; }
          return false;
        };
        const postedValue = voucher.lines.filter(line => inGroup(line.ledgerId)).reduce((sum, line) => sum + BigInt(line.paise) * (line.dc === (inward ? "Dr" : "Cr") ? 1n : -1n), 0n);
        if (postedValue !== BigInt(safeSum(parts.map(row => row.valuePaise)))) throw new Error("Inventory item amounts do not reconcile to the source sales/purchase ledger postings");
        journal = { id, date, number, type: inward ? "receipt" : "issue", financialKind: inward ? "purchase" : "sale", sourceRef: record.recordId,
          accountingVoucherId: voucher.id, accountingHash: tallyStockPostingHash(voucher),
          lines: parts.map(({ valuePaise, ...part }) => ({ ...part, ...(inward ? { valuePaise } : { revenuePaise: valuePaise }) })) };
        if (inward) issues.push({ severity: "review", code: "tally-stock-purchase-cost", reference: record.recordId, message: `${sourceType} ${number}: imported inventory cost uses the exported item amounts. Separately posted freight and noncreditable taxes require cost review.` });
      }
      journals.push(journal);
      journalSources.push({ id, recordId: record.recordId, voucherId: journal.accountingVoucherId || "" });
      rows.push({ recordId: record.recordId, kind: "VOUCHER", name: `${sourceType} ${number}`, status: "ready", date, message: `${journal.lines.length} ${journal.type} stock lines` });
    } catch (error) { review(record, `${sourceType} ${value(node, "VOUCHERNUMBER")}: ${error.message}`); }
  }
  const projection = { version: 1, masters, godowns, items, journals };
  const inventoryTags = ["ALLINVENTORYENTRIES", "INVENTORYENTRIES", "INVENTORYALLOCATIONS", "INVENTORYENTRIESIN", "INVENTORYENTRIESOUT"];
  const hasInventoryObjects = source.some(record => ["STOCKITEM", "STOCKGROUP", "STOCKCATEGORY", "UNIT", "GODOWN"].includes(record.type) || (record.type === "VOUCHER" && (inventoryTags.some(tag => findNodes(record.node, tag).length) || ["stock journal", "physical stock", "delivery note", "receipt note"].includes(key(value(record.node, "VOUCHERTYPENAME") || attribute(record.node, "VCHTYPE"))))));
  return { projection, rows, issues, details: { itemDetails, godownDetails, journalSources }, sourceItems: source.filter(record => record.type === "STOCKITEM").length, hasInventoryObjects };
}

export function planTallyStockProjection(company, vouchers, records) {
  const built = sourceProjection(company, vouchers, records), fingerprint = sourceHash(records);
  const stock = structuredClone(company.stock || { version: 1, masters: [], godowns: [{ id: "main", name: "Main Location" }], items: {}, journals: [] });
  stock.masters ||= []; stock.godowns ||= [{ id: "main", name: "Main Location" }]; stock.items ||= {}; stock.journals ||= [];
  const already = stock.tally?.sourceHash === fingerprint;
  const issues = [...built.issues], rows = built.rows.map(row => ({ ...row, status: already && row.status === "ready" ? "active" : row.status }));
  if (stock.tally && !already) issues.push({ severity: "blocking", code: "tally-stock-source-conflict", message: "The active stock projection belongs to another Tally source snapshot" });
  if (!already) {
    for (const godown of built.projection.godowns) {
      const existing = stock.godowns.find(row => row.id === godown.id || key(row.name) === key(godown.name));
      if (existing && (existing.id !== godown.id || key(existing.name) !== key(godown.name))) issues.push({ severity: "blocking", code: "tally-stock-godown-collision", message: `Godown ${godown.name} collides with an existing stock location` });
      else if (!existing) stock.godowns.push(godown);
    }
    for (const master of built.projection.masters) {
      if ([...stock.masters, ...(company.gst?.items || [])].some(row => row.id === master.id || key(row.name) === key(master.name))) issues.push({ severity: "blocking", code: "tally-stock-item-collision", message: `Stock item ${master.name} already exists. Existing stock masters were preserved` });
      else { stock.masters.push(master); stock.items[master.id] = built.projection.items[master.id]; }
    }
    for (const journal of built.projection.journals) {
      if (stock.journals.some(row => row.id === journal.id || row.sourceRef === journal.sourceRef)) issues.push({ severity: "blocking", code: "tally-stock-journal-collision", message: `Stock journal ${journal.number} already exists` });
      else stock.journals.push(journal);
    }
    const sourceGaps = built.issues.filter(issue => ["tally-stock-source-exception", "tally-stock-godown-hierarchy", "tally-stock-valuation-policy", "tally-stock-workbook-opening"].includes(issue.code)).map(({ code, reference, message }) => ({ code, reference, message }));
    stock.tally = { version: 1, booksFrom: company.booksFrom, sourceHash: fingerprint, baselineHash: digest(built.projection), itemIds: built.projection.masters.map(row => row.id), journalIds: built.projection.journals.map(row => row.id), emptySourceReview: !built.hasInventoryObjects, hasSourceGaps: sourceGaps.length > 0, sourceGaps, ...built.details };
  }
  const canActivate = !already && !issues.some(issue => issue.severity === "blocking") && (built.projection.masters.length > 0 || built.projection.journals.length > 0 || stock.tally.hasSourceGaps || stock.tally.emptySourceReview);
  const reviewHash = digest({ sourceHash: fingerprint, stock: company.stock || null, vouchers: vouchers.map(voucher => [voucher.id, tallyStockPostingHash(voucher)]).sort(([a], [b]) => a.localeCompare(b)) });
  const summary = { sourceItems: built.sourceItems, items: built.projection.masters.length, godowns: built.projection.godowns.length, journals: built.projection.journals.length,
    receiptLines: built.projection.journals.filter(row => row.type === "receipt").reduce((sum, row) => sum + row.lines.length, 0), issueLines: built.projection.journals.filter(row => row.type === "issue").reduce((sum, row) => sum + row.lines.length, 0),
    transferLines: built.projection.journals.filter(row => row.type === "transfer").reduce((sum, row) => sum + row.lines.length, 0), exceptions: rows.filter(row => row.status === "exception").length, sourceGaps: stock.tally?.sourceGaps?.length || 0, emptySource: !built.hasInventoryObjects, alreadyActive: already };
  return { stock: already ? structuredClone(company.stock) : stock, summary, rows, issues, sourceHash: fingerprint, reviewHash, canActivate };
}

export function activateTallyStockProjection(current, book, records, input) {
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId || "")) throw new Error("Stock activation needs a valid save identifier");
  const plan = planTallyStockProjection({ ...book.company, stock: current }, book.vouchers, records);
  if (plan.summary.alreadyActive) return { section: current, result: plan.summary, replayed: true };
  if (input.reviewHash !== plan.reviewHash) throw new Error("The books changed after this stock review. Review the current source projection again");
  if (!plan.canActivate) throw new Error(plan.issues.find(issue => issue.severity === "blocking")?.message || "No supported source stock is ready to activate");
  plan.stock.tally.activation = { requestId: input.requestId, reviewHash: input.reviewHash };
  plan.stock.revision = (current?.revision || 0) + 1;
  return { section: plan.stock, result: plan.summary, replayed: false };
}

// Older full archives preserve these generated sentences verbatim alongside their source IDs.
function historicalStockGaps(gaps) {
  return gaps?.map(gap => {
    const message = gap.message
      .replace(/Ledgercraft uses perpetual FIFO; this does not establish Tally valuation equivalence\.$/, "Financer uses perpetual FIFO; this does not establish Tally valuation equivalence.")
      .replace(/differs from Ledgercraft perpetual FIFO and is not activated$/, "differs from Financer perpetual FIFO and is not activated");
    return { ...gap, message };
  });
}

// The expected stock is rebuilt from verified original files using the recorded sign choices.
// Operator costing settings and unrelated native godowns/journals may evolve independently.
export function assertTallyStockOrigins(company, expectedStock) {
  const metadata = company.stock?.tally;
  if (!metadata) return;
  const expected = expectedStock?.tally;
  if (!expected || metadata.sourceHash !== expected.sourceHash || metadata.baselineHash !== expected.baselineHash) throw new Error("Tally stock source baseline differs from the preserved original files");
  if (!isDeepStrictEqual(metadata.sourceGaps, expected.sourceGaps) && !isDeepStrictEqual(metadata.sourceGaps, historicalStockGaps(expected.sourceGaps))) throw new Error("Tally stock source gaps differ from their preserved baseline");
  for (const field of ["version", "booksFrom", "itemIds", "journalIds", "emptySourceReview", "hasSourceGaps", "itemDetails", "godownDetails", "journalSources"]) if (!isDeepStrictEqual(metadata[field], expected[field])) throw new Error("Tally stock source identities differ from their preserved baseline");
  for (const master of company.stock.masters || []) if (metadata.itemIds.includes(master.id)) {
    const original = expectedStock.masters.find(row => row.id === master.id);
    if (!original || !isDeepStrictEqual(master, original)) throw new Error("An imported stock master differs from its original source quantities or identity");
  }
  for (const journal of company.stock.journals || []) if (metadata.journalIds.includes(journal.id) || journal.sourceRef?.startsWith("r-")) {
    const original = expectedStock.journals.find(row => row.id === journal.id);
    if (!original || !isDeepStrictEqual(journal, original)) throw new Error("An imported stock movement differs from its original Tally source");
  }
}

function rupees(paise, negative = false) {
  if (!Number.isSafeInteger(paise) || paise < 0) throw new Error("Stock export needs exact nonnegative paise");
  const amount = BigInt(paise);
  return `${negative && amount ? "-" : ""}${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`;
}
function stockExportContext(company) {
  const stock = company.stock || {};
  const masters = stock.masters || [];
  const byId = new Map(masters.map(master => [master.id, master]));
  const godowns = new Map([["main", "Main Location"], ...(stock.godowns || []).map(godown => [godown.id, godown.name])]);
  return { stock, masters, byId, godowns };
}
export function tallyStockMastersXml(company, xml) {
  const { stock, masters, godowns } = stockExportContext(company);
  if (!masters.length) return "";
  if (stock.tally?.godownDetails?.some(row => !absent(row.parent))) throw new Error("Tally stock XML export requires flat godowns; the source hierarchy remains in the full archive");
  const unitMap = new Map();
  for (const master of masters) {
    const precision = stock.tally?.itemDetails?.find(row => row.id === master.id)?.precision;
    if (!Number.isInteger(precision)) throw new Error(`Stock item ${master.name} lacks its source unit precision for Tally export`);
    if (unitMap.has(master.unit) && unitMap.get(master.unit) !== precision) throw new Error("Stock unit precision conflicts in Tally export");
    unitMap.set(master.unit, precision);
  }
  const units = [...unitMap].map(([name, precision]) => `<UNIT NAME="${xml(name)}" ACTION="Create"><NAME>${xml(name)}</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>${precision}</DECIMALPLACES></UNIT>`).join("");
  const locations = [...godowns].filter(([id]) => id !== "main").map(([, name]) => `<GODOWN NAME="${xml(name)}" ACTION="Create"><NAME>${xml(name)}</NAME><PARENT>Primary</PARENT></GODOWN>`).join("");
  const entries = masters.map(master => {
    const settings = stock.items?.[master.id] || {};
    if (settings.costingMethod && settings.costingMethod !== "fifo") throw new Error(`Stock item ${master.name}: Ledgercraft moving-average is not Tally's annual/monthly Average Cost; use the full archive to preserve this policy`);
    const opening = quantityMicros(master.openingQuantity || "0", true);
    const allocations = settings.openingAllocations || (opening ? [{ godownId: "main", quantity: formatQuantity(opening), valuePaise: settings.openingValuePaise ?? null }] : []);
    const batches = allocations.map(row => {
      const godown = godowns.get(row.godownId);
      if (!godown) throw new Error("Stock export references a missing godown");
      return `<BATCHALLOCATIONS.LIST><GODOWNNAME>${xml(godown)}</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><OPENINGBALANCE>${xml(row.quantity)} ${xml(master.unit)}</OPENINGBALANCE>${row.valuePaise != null ? `<OPENINGVALUE>${rupees(row.valuePaise)}</OPENINGVALUE>` : ""}</BATCHALLOCATIONS.LIST>`;
    }).join("");
    return `<STOCKITEM NAME="${xml(master.name)}" ACTION="Create"><NAME>${xml(master.name)}</NAME><PARENT>Primary</PARENT><BASEUNITS>${xml(master.unit)}</BASEUNITS><COSTINGMETHOD>FIFO Perpetual</COSTINGMETHOD><OPENINGBALANCE>${xml(master.openingQuantity || "0")} ${xml(master.unit)}</OPENINGBALANCE>${settings.openingValuePaise != null ? `<OPENINGVALUE>${rupees(settings.openingValuePaise)}</OPENINGVALUE>` : ""}${batches}</STOCKITEM>`;
  }).join("");
  return units + locations + entries;
}
function inventoryXml(context, line, direction, tag, xml, transfer = false) {
  const master = context.byId.get(line.itemId);
  if (!master) throw new Error("This Tally export contains a stock movement without a source-native stock item master");
  const godown = context.godowns.get(transfer ? direction === "in" ? line.toGodownId : line.fromGodownId : line.godownId || "main");
  if (!godown) throw new Error("Stock export references a missing godown");
  const amount = direction === "in" ? line.valuePaise : line.revenuePaise;
  if (!transfer && amount == null) throw new Error("Inventory XML export needs its source item amount; the missing amount was not replaced with zero");
  const amountXml = amount == null ? "" : `<AMOUNT>${rupees(amount, direction === "in")}</AMOUNT>`;
  const billed = transfer ? line.quantity : line.billedQuantity ?? line.quantity;
  return `<${tag}.LIST><STOCKITEMNAME>${xml(master.name)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>${direction === "in" ? "Yes" : "No"}</ISDEEMEDPOSITIVE><ACTUALQTY>${xml(line.quantity)} ${xml(master.unit)}</ACTUALQTY><BILLEDQTY>${xml(billed)} ${xml(master.unit)}</BILLEDQTY>${amountXml}<BATCHALLOCATIONS.LIST><GODOWNNAME>${xml(godown)}</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><ACTUALQTY>${xml(line.quantity)} ${xml(master.unit)}</ACTUALQTY><BILLEDQTY>${xml(billed)} ${xml(master.unit)}</BILLEDQTY>${amountXml}</BATCHALLOCATIONS.LIST></${tag}.LIST>`;
}
// Item-invoice allocations replace the purchase subtotal posting; they never accompany
// a second all-ledger subtotal. Group physical godown splits by the reviewed source line.
function promotedPurchaseInventoryXml(context, voucher, journal, xml) {
  const invoice = voucher.gst, origin = invoice.tallyOrigin;
  if (origin.stockMode !== "source" || journal.type !== "receipt" || journal.id !== origin.stockJournalId || journal.lines.length !== origin.stockLineMap.length) throw new Error("Purchase XML needs its unchanged source receipt; use the full source archive");
  const purchaseLedger = voucher.lines.find(line => line.ledgerId === origin.accounts.purchase)?.ledgerId;
  const ledgerName = context.company.ledgers.find(ledger => ledger.id === purchaseLedger)?.name;
  if (!ledgerName) throw new Error("Purchase XML is missing its reviewed purchase account");
  const percent = bps => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}`;
  return invoice.items.map((item, index) => {
    const master = context.byId.get(item.itemId), source = origin.source.items[index];
    const parts = journal.lines.filter((line, lineIndex) => origin.stockLineMap[lineIndex] === index);
    if (!master || !source || master.name !== source.sourceName || !source.actualQuantity || !parts.length || item.kind !== "goods" || item.supplyStatus !== "taxable" || item.cessRateBps || source.unitPricePaise !== item.unitPricePaise || (source.discountBps || 0) !== item.discountBps) throw new Error("Purchase XML cannot represent the reviewed source item or price; use the full source archive");
    if (!invoice.interState && item.gstRateBps % 2) throw new Error("Purchase XML cannot represent this split GST percentage exactly; use the full source archive");
    const heads = invoice.interState ? [["Integrated Tax", item.gstRateBps]] : [["Central Tax", item.gstRateBps / 2], [invoice.utgst ? "UT Tax" : "State Tax", item.gstRateBps / 2]];
    const tax = `<GSTHSNNAME>${xml(item.hsnSac)}</GSTHSNNAME><GSTOVRDNTYPEOFSUPPLY>Goods</GSTOVRDNTYPEOFSUPPLY><GSTOVRDNTAXABILITY>Taxable</GSTOVRDNTAXABILITY>` + heads.map(([head, bps]) => `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>${head}</GSTRATEDUTYHEAD><GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE><GSTRATE>${percent(bps)}</GSTRATE></RATEDETAILS.LIST>`).join("");
    const batches = parts.map(part => {
      const godown = context.godowns.get(part.godownId || "main");
      if (!godown || part.valuePaise == null) throw new Error("Purchase XML needs exact source godown costs; use the full source archive");
      return `<BATCHALLOCATIONS.LIST><GODOWNNAME>${xml(godown)}</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><ACTUALQTY>${xml(part.quantity)} ${xml(master.unit)}</ACTUALQTY><BILLEDQTY>${xml(part.billedQuantity ?? part.quantity)} ${xml(master.unit)}</BILLEDQTY><AMOUNT>${rupees(part.valuePaise, true)}</AMOUNT></BATCHALLOCATIONS.LIST>`;
    }).join("");
    const allocation = `<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${xml(ledgerName)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>${rupees(item.taxablePaise, true)}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>`;
    return `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${xml(master.name)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><RATE>${rupees(item.unitPricePaise)}/${xml(master.unit)}</RATE>${item.discountBps ? `<DISCOUNT>${percent(item.discountBps)}</DISCOUNT>` : ""}<ACTUALQTY>${xml(source.actualQuantity)} ${xml(master.unit)}</ACTUALQTY><BILLEDQTY>${xml(item.quantity)} ${xml(master.unit)}</BILLEDQTY><AMOUNT>${rupees(item.taxablePaise, true)}</AMOUNT>${tax}${batches}${allocation}</ALLINVENTORYENTRIES.LIST>`;
  }).join("");
}
export function tallyStockVoucherXml(company, voucher, xml) {
  const context = { ...stockExportContext(company), company };
  const journals = (context.stock.journals || []).filter(row => row.accountingVoucherId === voucher.id);
  if (!journals.length) return "";
  return journals.map(journal => {
    if (journal.accountingHash !== tallyStockPostingHash(voucher)) throw new Error("The linked accounting voucher changed after its stock projection");
    if (!["receipt", "issue"].includes(journal.type)) throw new Error("Unsupported stock linkage in accounting XML export");
    if (voucher.gst?.tallyOrigin && voucher.gst.direction === "purchase") return promotedPurchaseInventoryXml(context, voucher, journal, xml);
    return journal.lines.map(line => inventoryXml(context, line, journal.type === "receipt" ? "in" : "out", "ALLINVENTORYENTRIES", xml)).join("");
  }).join("");
}
export function tallyStockJournalsXml(company, from, to, xml) {
  const context = stockExportContext(company);
  return (context.stock.journals || []).filter(row => !row.accountingVoucherId && row.date >= from && row.date <= to).map(journal => {
    if (journal.type !== "transfer") throw new Error(`Tally XML export does not support native ${journal.type} journal ${journal.number}`);
    const entries = journal.lines.map(line => inventoryXml(context, line, "out", "INVENTORYENTRIESOUT", xml, true) + inventoryXml(context, line, "in", "INVENTORYENTRIESIN", xml, true)).join("");
    return `<VOUCHER VCHTYPE="Stock Journal" ACTION="Create"><GUID>financer-${xml(journal.id)}</GUID><DATE>${journal.date.replaceAll("-", "")}</DATE><VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(journal.number)}</VOUCHERNUMBER>${entries}</VOUCHER>`;
  }).join("");
}
