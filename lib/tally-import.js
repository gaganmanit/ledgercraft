import { parseTallyXlsx } from "./tally-xlsx.js";
import { workbookReferences, workbookBasis, workbookOverlaps } from "./tally-workbook-references.js";
import { assertTallyGstOrigins } from "./tally-gst.js";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { assertVoucher, trialBalance } from "./engine.js";
import { reservedGroups, VOUCHER_TYPES } from "./groups.js";
import { tallyDate, tallyAmount } from "./tally-values.js";
import { activateTallyBillReferences, assertTallyBillOrigins } from "./tally-bills.js";
import { planTallyStockProjection, assertTallyStockOrigins } from "./tally-stock.js";
import { assertBookAmounts, validateTransfer } from "./transfer.js";
import { attribute, child, children, decodeBase64, decodeTally, findNodes, keyName, parseTallyJson, parseTallyXml, tallyRecords, value } from "./tally-format.js";

export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonicalName = (name) => String(name).replace(/^\u0004\s*/, "").trim().toLocaleLowerCase("en-IN");
const sourceName = (node) => attribute(node, "NAME") || value(node, "NAME") || findNodes(node, "NAME")[0]?.text.trim() || "";
const yes = (text) => /^(yes|true|1)$/i.test(text);
const noPosting = new Set(["sales order", "purchase order", "memorandum", "reversing journal", "delivery note", "receipt note", "stock journal", "physical stock", "rejections in", "rejections out", "rejection in", "rejection out"]);

export { tallyDate, tallyAmount } from "./tally-values.js";

function canonicalNode(node) {
  return { tag: keyName(node.tag), attrs: Object.fromEntries(Object.entries(node.attrs).sort()), text: node.text.trim(), children: node.children.map(canonicalNode) };
}

function provenance(record, type, number = "") {
  return { system: "tally", recordId: record.recordId, guid: value(record.node, "GUID") || attribute(record.node, "REMOTEID"), masterId: value(record.node, "MASTERID"), originalType: type, originalNumber: number, archive: "tally-source" };
}

function cleanDisplayName(input, label) {
  const name = String(input || "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) throw new Error(`${label} must contain 2 to 80 characters`);
  return name;
}

function metadata(node) {
  const collect = (name) => findNodes(node, name).map((entry) => entry.text.trim()).filter(Boolean);
  return {
    address: collect("ADDRESS"), mailingName: collect("MAILINGNAME"),
    gstin: value(node, "PARTYGSTIN") || value(node, "GSTREGISTRATIONNUMBER") || collect("GSTIN")[0] || "",
    gstRegistrationType: value(node, "GSTREGISTRATIONTYPE"), pan: value(node, "INCOMETAXNUMBER"),
    state: value(node, "LEDSTATENAME") || value(node, "STATENAME"), country: value(node, "COUNTRYNAME"),
    pincode: value(node, "PINCODE"), email: value(node, "EMAIL"), phone: value(node, "LEDGERPHONE") || value(node, "LEDGERMOBILE"),
  };
}

function sourceDocument(source,bytes) {
  let tree, encoding, workbook, issues = [];
  if (/\.(xlsx|zip)$/i.test(source.name)) {
    ({tree,encoding,workbook,issues} = parseTallyXlsx(bytes,{name:source.name}));
  } else {
    if (/\.(xls|xlsb|xlsm)$/i.test(source.name)) throw new Error("Save the Tally sheet as a standard .xlsx workbook in Excel or LibreOffice, then select that file");
    if (!/\.(xml|json|txt)$/i.test(source.name)) throw new Error("native-data-needs-tally-export");
    const decoded=decodeTally(bytes);
    encoding=decoded.encoding;
    tree=decoded.text.trimStart().startsWith("<") ? parseTallyXml(decoded.text) : parseTallyJson(decoded.text);
  }
  const sourceError=findNodes(tree,"LINEERROR").find(entry=>entry.text.trim());
  if (sourceError) throw new Error("Tally reported "+sourceError.text.trim());
  const records=tallyRecords(tree).map((record,index)=>({...record,file:source.name,
    ...(workbook ? {sourceFormat:"xlsx"} : {}), recordId:`r-${hash(`${source.sha256}:${index}`).slice(0,24)}`}));
  if (!records.length) throw new Error("No supported Tally master or voucher objects were found");
  return {file:source.name,tree,records,encoding,workbook,issues};
}

export function previewTally(files, options = {}) {
  const issues = [];
  const issue = (severity, code, message, reference = "") => issues.push({ severity, code, message, reference });
  const documents = [];
  const sourceFiles = [];
  let totalBytes = 0;
  if (!Array.isArray(files) || files.length < 1 || files.length > 24) throw new Error("Choose 1 to 24 Tally exchange files");
  const names = new Set();
  for (const file of files) {
    if (typeof file?.name !== "string" || file.name.length > 200 || /[\x00-\x1f]/.test(file.name) || !file.name.trim()) throw new Error("Invalid source filename");
    const name = file.name.replace(/\\/g, "/").split("/").at(-1);
    if (names.has(name.toLowerCase())) throw new Error(`Choose a single copy of ${name}`);
    names.add(name.toLowerCase());
    const bytes = decodeBase64(file.base64);
    totalBytes += bytes.length;
    if (totalBytes > 40 * 1024 * 1024) throw new Error("Choose up to 40 MB of source files for each import");
    const source = { name, bytes: bytes.length, sha256: hash(bytes), base64: file.base64 };
    sourceFiles.push(source);
    try {
      const document=sourceDocument(source,bytes);
      source.encoding=document.encoding;
      documents.push(document);
      issues.push(...document.issues);
    } catch (error) {
      const binary = error.message === "native-data-needs-tally-export";
      issue("blocking", binary ? error.message : "unreadable-exchange", binary ? `${name} needs a licensed Tally export. Open or restore it in Tally and export All Masters plus All Vouchers as XML or native JSON.` : `${name}: ${error.message}`, name);
    }
  }
  const inputRecords=documents.flatMap(document=>document.records);
  const referenceRecords=workbookReferences(inputRecords);
  const records=[...inputRecords,...referenceRecords];
  const companyNames = new Set(documents.flatMap((document) => findNodes(document.tree, "SVCURRENTCOMPANY").map((entry) => canonicalName(entry.text))).filter(Boolean));
  if (companyNames.size > 1) issue("blocking", "multiple-companies", "The selected files identify different Tally companies");
  for (const document of documents) {
    const recognized = new Set(document.records.map((record) => record.node));
    for (const message of findNodes(document.tree, "TALLYMESSAGE")) {
      if (attribute(message, "TYPE")) continue;
      for (const entry of message.children) {
        const type = keyName(attribute(entry, "TYPE") || entry.tag);
        if (!recognized.has(entry)) issue("review", "unmapped-source-object", `${document.file} contains ${type} source data preserved outside the accounting projection.`, document.file);
      }
    }
  }
  const archived = [];
  let uniqueRecords = [];
  const identities = new Map();
  for (const record of records) {
    const name = sourceName(record.node);
    const identity = record.type === "VOUCHER" ? value(record.node, "GUID") || attribute(record.node, "REMOTEID") || value(record.node, "MASTERID") : canonicalName(name);
    const key = identity && `${record.type}:${identity}`;
    const prior = key && identities.get(key);
    if (prior) {
      const content=hash(JSON.stringify(canonicalNode(record.node)));
      prior.content ??= hash(JSON.stringify(canonicalNode(prior.record.node)));
      archived.push({ ...record, disposition: "duplicate-source" });
      issue(prior.content === content ? "info" : "blocking", prior.content === content ? "duplicate-record" : "conflicting-record", `${record.type} ${name || identity} occurs more than once${prior.content === content ? " with identical data" : " with different data"}.`, record.recordId);
      continue;
    }
    if (key) identities.set(key, { record });
    uniqueRecords.push(record);
  }
  let overlaps=[];
  if (documents.some(document=>document.workbook)) {
    const overlapPlan=workbookOverlaps(uniqueRecords,options.overlapChoices);
    overlaps=overlapPlan.overlaps;
    for (const group of overlaps) issue(group.choice?"review":"blocking","workbook-overlap",
      group.choice ? `Reviewed overlapping source files for ${group.type} ${group.number} dated ${group.date}.` :
        `Choose which source to post for ${group.type} ${group.number} dated ${group.date}, or confirm these are separate vouchers.`,group.key);
    uniqueRecords=uniqueRecords.filter(record=>{
      if (!overlapPlan.omitted.has(record.recordId)) return true;
      const selected=overlapPlan.omitted.get(record.recordId);
      archived.push({...record,disposition:selected?"duplicate-source":"overlap-review",...(selected?{overlapPosting:selected}:{})});
      return false;
    });
  }
  const companyRecord = uniqueRecords.find((record) => record.type === "COMPANY");
  const companyNode = companyRecord?.node;
  const companies = uniqueRecords.filter((record) => record.type === "COMPANY");
  if (companies.length > 1) issue("blocking", "multiple-companies", "Choose exports from one Tally company for each import");
  const company = { id: `tally-preview-${hash(sourceFiles.map((file) => file.sha256).join(":")).slice(0, 12)}`, name: "", booksFrom: "", groups: reservedGroups(), ledgers: [] };
  try { company.name = cleanDisplayName(options.companyName || (companyNode && sourceName(companyNode)), "Company name"); }
  catch (error) { issue("blocking", "company-name", error.message); }
  try { company.booksFrom = tallyDate(options.booksFrom || (companyNode && (value(companyNode, "BOOKSFROM") || value(companyNode, "STARTINGFROM")))); }
  catch (error) { issue("blocking", "books-from", "Enter the original Tally books beginning date"); }
  const baseCurrency = companyNode && (value(companyNode, "BASECURRENCYNAME") || value(companyNode, "CURRENCYNAME") || value(companyNode, "BASECURRENCYSYMBOL"));
  if (baseCurrency && !/^(₹|Rs\.?|INR|Indian Rupees?)$/i.test(baseCurrency)) issue("blocking", "foreign-base-currency", `The source company base currency is ${baseCurrency}. Ledgercraft's accounting projection uses INR paise.`);
  company.source = { system: "tally", recordId: companyRecord?.recordId || company.id, guid: companyNode ? value(companyNode, "GUID") : "", masterId: "", originalType: "Company", originalNumber: "", archive: "tally-source" };
  const groupsByName = new Map(company.groups.map((group) => [canonicalName(group.name), group.id]));
  const pending = uniqueRecords.filter((record) => record.type === "GROUP");
  for (const record of pending.filter((entry) => groupsByName.has(canonicalName(sourceName(entry.node))))) archived.push({ ...record, disposition: "mapped-reserved-group" });
  let unresolved = pending.filter((entry) => !groupsByName.has(canonicalName(sourceName(entry.node))));
  for (let pass = 0; unresolved.length && pass < pending.length; pass++) {
    const next = [];
    for (const record of unresolved) {
      const source = sourceName(record.node);
      const parent = groupsByName.get(canonicalName(value(record.node, "PARENT")));
      if (!parent) { next.push(record); continue; }
      try {
        const name = cleanDisplayName(source, "Group name");
        const id = `g-tally-${hash(canonicalName(source)).slice(0, 16)}`;
        company.groups.push({ id, name, parentId: parent, nature: null, gross: false, cashBank: false, reserved: false, source: provenance(record, "Group") });
        groupsByName.set(canonicalName(source), id);
        archived.push({ ...record, disposition: "group" });
      } catch (error) { issue("blocking", "group-name", error.message, record.recordId); }
    }
    if (next.length === unresolved.length) break;
    unresolved = next;
  }
  for (const record of unresolved) issue("blocking", "unmapped-group", `Group ${sourceName(record.node)} has an unknown or cyclic parent ${value(record.node, "PARENT")}.`, record.recordId);
  let workbook = null;
  if (documents.some(document=>document.workbook)) {
    workbook=workbookBasis(uniqueRecords,referenceRecords,company.groups,options);
    company.tallyWorkbook={...workbook.stored,overlapChoices:Object.fromEntries(overlaps.filter(g=>g.choice).map(g=>[g.key,g.choice])),openingScope:workbook.openingScope};
    if (workbook.openingScope.transactionOnly) issue("review","workbook-opening-scope",workbook.openingScope.message);
    if (workbook.openingScope.billedOnlyLines) issue(workbook.stored.useBilledAsActual?"info":"review","workbook-quantity-basis",
      workbook.stored.useBilledAsActual ? "The reviewed import uses billed quantities where actual quantities were absent." : "The workbook contains billed quantities without actual quantities. Stock movements for these lines need a physical quantity review.");
  }
  const groupChoice=new Map(workbook?.rows.map(row=>[row.sourceName,row.groupId]) || []);
  const ledgerByName = new Map();
  for (const record of uniqueRecords.filter((entry) => entry.type === "LEDGER")) {
    try {
      const originalName = sourceName(record.node);
      const name = cleanDisplayName(originalName, "Ledger name");
      const parentName = value(record.node, "PARENT");
      const retainedProfit = canonicalName(originalName) === "profit & loss a/c" && canonicalName(parentName) === "primary";
      const groupId = record.sourceFormat === "xlsx-reference" ? groupChoice.get(originalName) : retainedProfit ? "g-capital" : groupsByName.get(canonicalName(parentName));
      if (retainedProfit) issue("review", "retained-profit-ledger", "The source Profit & Loss A/c opening is held under Capital Account as retained profit.", record.recordId);
      if (!groupId) throw new Error(record.sourceFormat==="xlsx-reference" ? `Choose an account group for the referenced ledger ${name}` : `Ledger ${name} needs its group ${parentName}`);
      const currency = value(record.node, "CURRENCYNAME");
      if (currency && !/^(₹|Rs\.?|INR|Indian Rupees?)$/i.test(currency)) throw new Error(`Ledger ${name} uses ${currency}; an INR base-currency export is required`);
      const opening = tallyAmount(value(record.node, "OPENINGBALANCE"), true);
      const ledger = { id: `l-tally-${hash(canonicalName(originalName)).slice(0, 16)}`, name, groupId, opening: { dc: opening < 0 ? "Dr" : "Cr", paise: Math.abs(opening) }, source: provenance(record, "Ledger"), tally: metadata(record.node) };
      if (!opening) ledger.opening.dc = "Dr";
      if (record.sourceFormat==="xlsx-reference" || value(record.node,"XLSXOPENINGUNKNOWN")==="Yes") ledger.tally.openingNotSupplied=true;
      ledgerByName.set(canonicalName(originalName), ledger);
      company.ledgers.push(ledger);
      archived.push({ ...record, disposition: "ledger" });
    } catch (error) { issue("blocking", "ledger-mapping", error.message, record.recordId); }
  }
  const types = new Map([...VOUCHER_TYPES, ...noPosting].map((type) => [canonicalName(type), type]));
  const typeRecords = new Map(uniqueRecords.filter((entry) => entry.type === "VOUCHERTYPE").map((record) => [canonicalName(sourceName(record.node)), record]));
  for (const name of typeRecords.keys()) {
    const path = [];
    const seen = new Set();
    let current = name;
    while (!types.has(current) && typeRecords.has(current) && !seen.has(current)) {
      seen.add(current);
      path.push(current);
      current = canonicalName(value(typeRecords.get(current).node, "PARENT"));
    }
    if (types.has(current)) for (const part of path) types.set(part, types.get(current));
  }
  const vouchers = [];
  const mapping = [];
  const usedNumbers = new Set();
  const reconciliation = { sourceVouchers: records.filter((record) => record.type === "VOUCHER").length, duplicateVouchers: archived.filter((record) => record.type === "VOUCHER" && record.disposition === "duplicate-source").length, postedVouchers: 0, excludedVouchers: 0, failedVouchers: 0, sourceDebitPaise: 0, sourceCreditPaise: 0, postedDebitPaise: 0, postedCreditPaise: 0 };
  const posting = (node, resolution, conflicts) => {
    const sourceLedger = value(node, "LEDGERNAME");
    const ledger = ledgerByName.get(canonicalName(sourceLedger));
    if (!ledger) throw new Error(`Voucher ledger ${sourceLedger || "(empty)"} is missing from All Masters`);
    const amount = tallyAmount(value(node, "AMOUNT"));
    const deemed = value(node, "ISDEEMEDPOSITIVE");
    if (deemed && !/^(yes|no|true|false|1|0)$/i.test(deemed)) throw new Error(`Unknown debit/credit flag on ${sourceLedger}`);
    const conflict = amount && deemed && yes(deemed) !== (amount < 0);
    if (conflict) conflicts.push({ ledger: sourceLedger, signedPaise: amount, flag: deemed });
    const debit = conflict && resolution === "debit-credit-flags" ? yes(deemed) : amount < 0;
    return { ledgerId: ledger.id, dc: debit ? "Dr" : "Cr", paise: Math.abs(amount) };
  };
  const balanced = (lines) => lines.reduce((sum, line) => sum + (line.dc === "Dr" ? line.paise : -line.paise), 0) === 0;
  for (const record of uniqueRecords.filter((entry) => entry.type === "VOUCHER")) {
    const node = record.node;
    const sourceType = value(node, "VOUCHERTYPENAME") || attribute(node, "VCHTYPE");
    const originalNumber = value(node, "VOUCHERNUMBER");
    const flags = ["ISCANCELLED", "ISOPTIONAL", "ISDELETED"].filter((flag) => yes(value(node, flag)));
    if (flags.length || noPosting.has(canonicalName(sourceType)) || noPosting.has(canonicalName(types.get(canonicalName(sourceType)) || ""))) {
      reconciliation.excludedVouchers++;
      archived.push({ ...record, disposition: "nonposting", reason: flags.join(", ") || sourceType });
      issue("info", "nonposting-voucher", `${sourceType} ${originalNumber || "(unnumbered)"} is retained with no ledger posting (${flags.join(", ") || "non-accounting voucher type"}).`, record.recordId);
      continue;
    }
    try {
      for (const flag of ["ISCANCELLED", "ISOPTIONAL", "ISDELETED", "ISPOSTDATED"]) {
        const text = value(node, flag);
        if (text && !/^(yes|no|true|false|1|0)$/i.test(text)) throw new Error(`Unknown ${flag} value ${text}`);
      }
      const action = attribute(node, "ACTION");
      if (action && !/^(create|alter)$/i.test(action)) throw new Error(`Voucher action ${action} needs review in Tally`);
      const type = types.get(canonicalName(sourceType));
      if (!type) throw new Error(`Voucher type ${sourceType || "(empty)"} has no supported accounting parent`);
      const all = children(node, "ALLLEDGERENTRIES");
      const direct = all.length ? all : children(node, "LEDGERENTRIES");
      const inventory = [...children(node, "ALLINVENTORYENTRIES"), ...children(node, "INVENTORYENTRIES")];
      const conflicts = [];
      const resolution = options.signChoices?.[record.recordId];
      const mapPosting = entry => posting(entry, resolution, conflicts);
      let lines = direct.map(mapPosting).filter((line) => line.paise);
      let accountingMode = all.length ? "all-ledger-entries" : "ledger-entries";
      if (!all.length && inventory.length && !balanced(lines)) {
        const allocations = inventory.flatMap((entry) => children(entry, "ACCOUNTINGALLOCATIONS"));
        lines = [...lines, ...allocations.map(mapPosting).filter((line) => line.paise)];
        accountingMode = "ledger-plus-inventory-accounting-allocations";
      }
      if (conflicts.length) {
        const resolved = ["signed-amounts", "debit-credit-flags"].includes(resolution);
        const detail = conflicts.map(c => c.ledger + " (" + c.signedPaise + " paise, flag " + c.flag + ")").join(", ");
        issues.push({ severity: resolved ? "review" : "blocking", code: "posting-sign-conflict", reference: record.recordId,
          message: `${sourceType} ${originalNumber}: amount sign and debit/credit flag disagree for ${detail}${resolved ? ". Reviewed using " + resolution + "." : "."}`,
          choice: resolved ? resolution : "", conflicts });
        if (!resolved) {
          reconciliation.failedVouchers++;
          archived.push({ ...record, disposition: "exception", reason: "Conflicting posting signs" });
          continue;
        }
      }
      if (!lines.length) throw new Error("No complete accounting ledger entries were exported");
      let number = originalNumber || `TLY-${record.recordId.slice(-12)}`;
      if (number.length > 24 || usedNumbers.has(`${type}:${number}`)) {
        number = `${number.slice(0, 7)}~${hash(record.recordId).slice(0, 16)}`;
        issue("review", "voucher-number-mapped", `${sourceType} ${originalNumber || "(unnumbered)"} uses ${number} in Ledgercraft. The original number stays in the source archive.`, record.recordId);
      }
      if (!originalNumber) issue("review", "voucher-number-generated", `An unnumbered ${sourceType} uses ${number}.`, record.recordId);
      if (usedNumbers.has(`${type}:${number}`)) throw new Error("The mapped voucher number conflicts with another voucher");
      const date = tallyDate(value(node, "DATE"));
      const effective = value(node, "EFFECTIVEDATE");
      if (effective && tallyDate(effective) !== date) throw new Error("Voucher date differs from its effective date; export the effective accounting date from Tally");
      const originalNarration = value(node, "NARRATION");
      if (originalNarration.length > 280) issue("review", "narration-retained", `${number} has a narration longer than the entry field. Its full text stays in the source archive.`, record.recordId);
      const voucher = assertVoucher(company, { type, number, date, narration: originalNarration, lines }, [], `v-tally-${record.recordId.slice(2)}`);
      voucher.source = provenance(record, sourceType, originalNumber);
      usedNumbers.add(`${type}:${number}`);
      vouchers.push(voucher);
      archived.push({ ...record, disposition: "voucher", voucherId: voucher.id, targetType: type, accountingMode, ...(conflicts.length ? { signChoice: resolution, reason: "Posting signs reviewed using " + resolution } : {}), originalPosting: { type: voucher.type, number: voucher.number, date: voucher.date, narration: voucher.narration, lines: voucher.lines } });
      mapping.push({ ...(conflicts.length ? { signChoice: resolution, lines: lines.map(l=>({ledger: company.ledgers.find(m=>m.id===l.ledgerId)?.name, dc:l.dc, paise:l.paise})) } : {}), recordId: record.recordId, sourceType, sourceNumber: originalNumber, type, number, date, debitPaise: lines.filter((line) => line.dc === "Dr").reduce((sum, line) => sum + line.paise, 0), accountingMode });
      reconciliation.postedVouchers++;
      const debit = lines.filter((line) => line.dc === "Dr").reduce((sum, line) => sum + line.paise, 0);
      const credit = lines.filter((line) => line.dc === "Cr").reduce((sum, line) => sum + line.paise, 0);
      reconciliation.sourceDebitPaise += debit;
      reconciliation.sourceCreditPaise += credit;
      reconciliation.postedDebitPaise += debit;
      reconciliation.postedCreditPaise += credit;
    } catch (error) {
      reconciliation.failedVouchers++;
      archived.push({ ...record, disposition: "exception", reason: error.message });
      issue("blocking", "voucher-mapping", `${sourceType} ${originalNumber || "(unnumbered)"}: ${error.message}`, record.recordId);
    }
  }
  for (const record of uniqueRecords.filter((entry) => ["COMPANY", "VOUCHERTYPE"].includes(entry.type))) archived.push({ ...record, disposition: "reference-master" });
  const extras = uniqueRecords.filter((record) => !["GROUP", "LEDGER", "VOUCHER", "COMPANY", "VOUCHERTYPE"].includes(record.type));
  for (const record of extras) archived.push({ ...record, disposition: "reference-master" });
  const inventoryCount = uniqueRecords.filter((record) => record.type === "VOUCHER" && ["ALLINVENTORYENTRIES", "INVENTORYENTRIES", "INVENTORYALLOCATIONS", "INVENTORYENTRIESIN", "INVENTORYENTRIESOUT"].some(tag => findNodes(record.node, tag).length)).length;
  const allocationCount = uniqueRecords.filter((record) => record.type === "VOUCHER" && ["BILLALLOCATIONS", "BANKALLOCATIONS", "CATEGORYALLOCATIONS", "COSTCENTREALLOCATIONS"].some((name) => findNodes(record.node, name).length)).length;
  const hasExtensions = (node) => node.tag.includes(":") || node.children.some(hasExtensions);
  const extensionCount = uniqueRecords.filter((record) => hasExtensions(record.node)).length;
  if (extensionCount) issue("review", "extension-fields-retained", `${extensionCount} records contain extension fields. Their complete source fields are available in Tally source.`);
  if (extras.length || inventoryCount) issue("review", "inventory-reference-data", `${extras.length} additional masters and ${inventoryCount} inventory-bearing vouchers are preserved as source records. Supported stock quantities, openings and transfers are projected separately; unsupported source policies remain explicit stock exceptions.`);
  if (allocationCount) issue("review", "allocations-reference-data", `${allocationCount} vouchers contain bill, bank or cost allocations. Their exact source structures are preserved. Supported bill references are included in the bill-wise projection.`);
  if (company.ledgers.some((ledger) => ledger.tally.gstin)) issue("review", "tax-reference-data", "GST/contact master details and tax ledger postings are retained. Source tax configurations stay in the archive.");
  let billReferences = null;
  if (!issues.some(entry => entry.severity === "blocking")) {
    try {
      const requestId = `tally-bills-${hash(sourceFiles.map(file => file.sha256).join(":")).slice(0, 24)}`;
      const activated = activateTallyBillReferences(company.reconciliation, { company, vouchers }, archived, { revision: company.reconciliation?.revision || 0, requestId });
      billReferences = activated.report.summary;
      if (!activated.replayed) company.reconciliation = activated.section;
      for (const row of activated.report.rows.filter(row => row.status === "exception")) issue("review", "bill-reference-retained", `${row.partyName || "Party"} · ${row.reference || row.method || "bill allocation"}: ${row.message}`, row.recordId);
    } catch (error) { issue("review", "bill-reference-retained", `Bill references remain in their original source fields for review. ${error.message}`); }
  }
  let stockProjection = null;
  if (!issues.some(entry => entry.severity === "blocking")) {
    try {
      const plan = planTallyStockProjection(company, vouchers, archived);
      stockProjection = plan.summary;
      if (plan.canActivate) company.stock = plan.stock;
      issues.push(...plan.issues);
    } catch (error) { issue("review", "tally-stock-source-exception", `Stock source remains available for review. ${error.message}`); }
  }
  if (!company.ledgers.length) issue("blocking", "missing-masters", "Export All Masters with ledger opening balances before importing vouchers");
  let trial = null;
  try {
    assertBookAmounts(company, vouchers);
    if (!issues.some((entry) => entry.severity === "blocking")) validateTransfer({ company, vouchers });
    if (company.booksFrom) {
      const latest = vouchers.reduce((to, voucher) => voucher.date > to ? voucher.date : to, company.booksFrom);
      trial = trialBalance(company, vouchers, company.booksFrom, latest);
      if (trial.difference) issue("review", "opening-difference", `Opening balances differ by ${Math.abs(trial.difference)} paise. Check the source export and original books beginning date.`);
    }
  } catch (error) { issue("blocking", "amount-range", error.message); }
  return {
    company, vouchers, sources: sourceFiles, records: archived, documents,
    ...(workbook ? { overlaps, accountGroupMappings: workbook.rows, accountGroups:company.groups.map(({id,name})=>({id,name})) } : {}),
    canCommit: !issues.some((entry) => entry.severity === "blocking"), issues, mapping,
    summary: {
      ...(workbook ? {openingScope:workbook.openingScope,gstReadiness:workbook.gstReadiness,referencedMasters:referenceRecords.length,workbooks:documents.flatMap(doc=>doc.workbook?[doc.workbook]:[])} : {}),
      sourceRecords: inputRecords.length, duplicateRecords: archived.filter((record) => record.disposition === "duplicate-source").length,
      companyName: company.name, booksFrom: company.booksFrom, files: sourceFiles.length,
      groups: company.groups.length, ledgers: company.ledgers.length, vouchers: vouchers.length,
      referenceMasters: extras.length, inventoryVouchers: inventoryCount, allocationVouchers: allocationCount,
      reconciliation, billReferences, stockProjection, trial: trial && { to: trial.to, debit: trial.debit, credit: trial.credit, difference: trial.difference },
    },
  };
}

export function assertTallySourceRecords(sources, records) {
  const inputRecords=sources.flatMap(source=>sourceDocument(source,decodeBase64(source.base64)).records);
  const identity = record => `${record.file}\u0000${record.recordId}`;
  const originals=new Map([...inputRecords,...workbookReferences(inputRecords)].map(record=>[identity(record),record]));
  if (records.length !== originals.size || new Set(records.map(identity)).size !== originals.size) throw new Error("The source record inventory does not match the original files");
  for (const record of records) {
    const original = originals.get(identity(record));
    if (!original || record.type !== original.type || original.sourceFormat !== record.sourceFormat ||
        (record.sourceFormat ? !isDeepStrictEqual(record.node,original.node) : hash(JSON.stringify(canonicalNode(record.node))) !== hash(JSON.stringify(canonicalNode(original.node))))) throw new Error("A preserved source record differs from the original bytes");
  }
}

export function replayTallySource(company, sources, archived) {
  const signChoices=Object.fromEntries(archived.filter(record=>record.signChoice).map(record=>[record.recordId,record.signChoice]));
  const basis=company.tallyWorkbook;
  const original=previewTally(sources,{companyName:company.name,booksFrom:company.stock?.tally?.booksFrom || company.booksFrom,
    signChoices,accountGroupMappings:basis?.accountGroupMappings,overlapChoices:basis?.overlapChoices,useBilledAsActual:basis?.useBilledAsActual});
  if (!original.canCommit) throw new Error("The original Tally book could not be rebuilt from its preserved source files");
  if (!isDeepStrictEqual(original.company.tallyWorkbook,basis)) throw new Error("The workbook opening and quantity basis differs from the retained source files");
  if (basis) {
    const byId=new Map(original.records.map(record=>[record.file+"|"+record.recordId,record]));
    if (byId.size!==archived.length) throw new Error("The workbook source record inventory does not match its original files");
    for (const record of archived) {
      const id=record.file+"|"+record.recordId;
      const rebuilt=byId.get(id);
      byId.delete(id);
      if (!rebuilt) throw new Error("The workbook source record inventory does not match its original files");
      if (isDeepStrictEqual(rebuilt,record)) continue;
      if (!isDeepStrictEqual(rebuilt.node,record.node)) throw new Error("A preserved source record differs from the original workbook cells");
      throw new Error("The workbook projection differs from its original rows, postings or source inventory");
    }
  }
  return original;
}

export function restoreTallyArchive(input) {
  if (input?.format !== "financer-tally-archive" || input.version !== 1) throw new Error("Choose a Ledgercraft full Tally archive version 1");
  let payload = input;
  if (input.sourcePayload) {
    if (input.sourcePayload.encoding !== "gzip+base64") throw new Error("Invalid full source archive encoding");
    const compressed = decodeBase64(input.sourcePayload.data);
    if (compressed.length > 64 * 1024 * 1024 || hash(compressed) !== input.sourcePayload.sha256) throw new Error("The full source archive hash does not match");
    payload = JSON.parse(gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 }).toString("utf8"));
  }
  if (!Array.isArray(payload.sources) || !Array.isArray(payload.records) || payload.records.length > 1_000_000) throw new Error("The full source archive needs its original files and records");
  const validated = validateTransfer({ company: input.company, vouchers: input.vouchers });
  if (payload.sourceBookHash !== undefined && payload.sourceBookHash !== null && !/^[a-f0-9]{64}$/.test(payload.sourceBookHash)) throw new Error("Invalid original book fingerprint");
  if (validated.company.source?.system !== "tally") throw new Error("This archive does not identify its Tally source");
  let total = 0;
  const sources = payload.sources.map((file) => {
    if (typeof file.name !== "string" || file.name.includes("/") || file.name.includes("\\") || file.name.length > 200 || /[\x00-\x1f]/.test(file.name)) throw new Error("Invalid archived source filename");
    const bytes = decodeBase64(file.base64);
    total += bytes.length;
    if (hash(bytes) !== file.sha256 || total > 40 * 1024 * 1024) throw new Error("An archived source hash or size does not match");
    return { ...file, bytes: bytes.length };
  });
  if (sources.length < 1 || sources.length > 24 || new Set(sources.map((file) => file.name.toLowerCase())).size !== sources.length) throw new Error("The archive has invalid or duplicate source files");
  const hasWorkbook=sources.some(source=>/\.(xlsx|zip)$/i.test(source.name));
  if (!hasWorkbook) assertTallySourceRecords(sources,payload.records);
  if (validated.company.stock?.tally || hasWorkbook || validated.company.tallyWorkbook || validated.company.gst?.tallyPromotion) {
    const original=replayTallySource(validated.company,sources,payload.records);
    if (validated.company.stock?.tally) assertTallyStockOrigins(validated.company, original.company.stock);
    assertTallyGstOrigins(validated.company,validated.vouchers,original.records);
  }
  assertTallyBillOrigins(validated.company,payload.records);
  return { ...validated, gstStatementFiles:input.gstStatementFiles, sourceBookHash: payload.sourceBookHash || null, sources, records: payload.records, documents: [], mapping: [], issues: [], canCommit: true, summary: { companyName: validated.company.name, booksFrom: validated.company.booksFrom, files: sources.length, groups: validated.company.groups.length, ledgers: validated.company.ledgers.length, vouchers: validated.vouchers.length, restoredArchive: true } };
}
