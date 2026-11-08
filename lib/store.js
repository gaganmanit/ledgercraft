import { saveTallyGstMapping, activateTallyGstPromotion, assertTallyGstBook } from "./tally-gst.js";
import { buildAmendmentEvent, buildOutwardAmendment } from "./gst-outward-amendments.js";
import { ensureItcAccounts, buildItcAction, assertItcBook, itcAccountIds } from "./gst-itc.js";
import { commitBook, recoverBook } from "./book-transaction.js";
import { recordStatement, verifyItcStatement, saveFiledSource } from "./gst-statement-library.js";
import { tallyStockPostingHash } from "./tally-stock.js";
import { assertStockBook } from "./stock-engine.js";
import { invoiceStockMetadata, stockLocations } from "./stock-entry.js";
import { saveIrpPolicy } from "./gst-irp-policy.js";
import { saveTurnover } from "./gst-turnover.js";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isIsoDate } from "./money.js";
import { emptyCashLedger, nextNumbers, reservedGroups } from "./groups.js";
import { assertVoucher } from "./engine.js";
import { buildSpecimen } from "./specimen.js";
import { assertBookAmounts } from "./transfer.js";
import { assertRcmBook, buildRcmAction, ensureRcmAccounts, rcmAccountIds } from "./gst-rcm.js";
import { assertReconciliation, guardReconciledLedger, guardReconciledVoucher } from "./reconciliation.js";
import { acknowledgementRecord, exchangeView, invoiceFingerprint, normalizePreparation } from "./gst-exchange.js";
import { assertGstSnapshot, buildGstInvoice, gstAccountIds, gstRequestHash, gstState, gstVoucher, saveItem, saveParty, saveRegistration } from "./gst.js";

const ID_RE = /^[a-z0-9-]{1,48}$/;
const pendingWrites = new Map();

export function createStore(dataDir) {
  const root = path.join(dataDir, "companies");

  async function ensure() {
    await mkdir(root, { recursive: true });
  }

  function dir(id) {
    if (!ID_RE.test(id)) throw new Error("Unknown company");
    return path.join(root, id);
  }

  function serial(id, operation) {
    const key = path.resolve(root, id);
    const prior = pendingWrites.get(key) || Promise.resolve();
    const next = prior.catch(() => {}).then(operation);
    pendingWrites.set(key, next);
    next.finally(() => {
      if (pendingWrites.get(key) === next) pendingWrites.delete(key);
    }).catch(() => {});
    return next;
  }

  async function writeJson(file, value) {
    const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
      await rename(tmp, file);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async function readJson(file) {
    return JSON.parse(await readFile(file, "utf8"));
  }

  async function load(id) {
    const folder = dir(id);
    await recoverBook(folder);
    const company = await readJson(path.join(folder, "company.json"));
    const vouchers = await readJson(path.join(folder, "vouchers.json"));
    return { company, vouchers };
  }

  function bundle(company, vouchers) {
    return { company, vouchers, nextNumbers: nextNumbers(vouchers) };
  }

  async function list() {
    await ensure();
    const names = await readdir(root, { withFileTypes: true });
    const companies = [];
    for (const entry of names) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      try {
        const company = await readJson(path.join(root, entry.name, "company.json"));
        companies.push({
          id: company.id,
          name: company.name,
          booksFrom: company.booksFrom,
        });
      } catch {
        // A half-written folder is skipped until the next save.
      }
    }
    companies.sort((a, b) => a.name.localeCompare(b.name));
    return companies;
  }

  function cleanName(name) {
    const value = String(name ?? "").trim().replace(/\s+/g, " ");
    if (value.length < 2 || value.length > 80) throw new Error("Use a name between 2 and 80 characters");
    return value;
  }

  function assertCurrent(current, expected, fields) {
    if (expected === undefined) return;
    if (!expected || typeof expected !== "object" || !fields.every((field) => isDeepStrictEqual(current[field], expected[field]))) {
      throw new Error("This entry changed while you were editing. Reopen it to review the latest version");
    }
  }

  async function create({ name, booksFrom }) {
    await ensure();
    const companyName = cleanName(name);
    if (!isIsoDate(booksFrom)) throw new Error("Enter the date these books begin");
    const id = `${companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "book"}-${randomBytes(3).toString("hex")}`;
    const company = {
      id,
      name: companyName,
      booksFrom,
      groups: reservedGroups(),
      ledgers: [emptyCashLedger()],
    };
    const folder = dir(id);
    await mkdir(folder, { recursive: true });
    await writeJson(path.join(folder, "company.json"), company);
    await writeJson(path.join(folder, "vouchers.json"), []);
    return bundle(company, []);
  }

  async function get(id) {
    const { company, vouchers } = await load(id);
    return bundle(company, vouchers);
  }

  // Report readers may share a parsed, read-only book. Writers always load their own copy.
  let recent = null;
  async function revision(folder) {
    const files = await Promise.all(["company.json", "vouchers.json"].map(name =>
      stat(path.join(folder, name), { bigint: true })));
    return {
      key: files.map(f => [f.ino, f.size, f.mtimeNs, f.ctimeNs].join(":")).join("/"),
      bytes: files[0].size + files[1].size
    };
  }
  async function snapshot(id) {
    const folder = dir(id);
    await recoverBook(folder);
    const stamp = await revision(folder);
    if (recent?.id === id && recent.key === stamp.key) return recent.book;
    const book = await get(id);
    if ((await revision(folder)).key !== stamp.key) throw new Error("Company files changed while opening. Open the book again.");
    if (stamp.bytes <= 32n * 1024n * 1024n) recent = { id, key: stamp.key, book };
    return book;
  }

  async function addGroup(id, input) {
    const { company, vouchers } = await load(id);
    const name = cleanName(input.name);
    const parent = company.groups.find((group) => group.id === input.parentId);
    if (!parent) throw new Error("Choose the group this sits under");
    if (company.groups.some((group) => group.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("A group with that name already exists");
    }
    company.groups.push({
      id: `g-${randomBytes(4).toString("hex")}`,
      name,
      parentId: parent.id,
      nature: null,
      gross: false,
      cashBank: false,
      reserved: false,
    });
    await writeJson(path.join(dir(id), "company.json"), company);
    return bundle(company, vouchers);
  }

  async function addLedger(id, input) {
    const { company, vouchers } = await load(id);
    const name = cleanName(input.name);
    const group = company.groups.find((item) => item.id === input.groupId);
    if (!group) throw new Error("Choose a group");
    if (company.ledgers.some((ledger) => ledger.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("A ledger with that name already exists");
    }
    const paise = input.openingPaise ?? 0;
    if (!Number.isSafeInteger(paise) || paise < 0) throw new Error("Opening balance must be zero or more");
    if (input.openingDc !== "Dr" && input.openingDc !== "Cr") throw new Error("Opening balance is debit or credit");
    company.ledgers.push({
      id: `l-${randomBytes(4).toString("hex")}`,
      name,
      groupId: group.id,
      opening: { dc: input.openingDc, paise },
    });
    if (paise > 0) assertBookAmounts(company, vouchers);
    await writeJson(path.join(dir(id), "company.json"), company);
    return bundle(company, vouchers);
  }

  async function updateGroup(id, groupId, input) {
    const { company, vouchers } = await load(id);
    const group = company.groups.find((item) => item.id === groupId);
    if (!group) throw new Error("That group is not in this company");
    if (group.reserved) throw new Error("Reserved groups keep their original names");
    assertCurrent(group, input.expected, ["name"]);
    const name = cleanName(input.name);
    if (company.groups.some((item) => item.id !== groupId && item.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("A group with that name already exists");
    }
    group.name = name;
    await writeJson(path.join(dir(id), "company.json"), company);
    return bundle(company, vouchers);
  }

  async function removeGroup(id, groupId) {
    const { company, vouchers } = await load(id);
    const group = company.groups.find((item) => item.id === groupId);
    if (!group) throw new Error("That group is not in this company");
    if (group.reserved) throw new Error("Reserved groups belong to the chart of accounts");
    if (company.groups.some((item) => item.parentId === groupId) || company.ledgers.some((item) => item.groupId === groupId)) {
      throw new Error("Move this group's ledgers and child groups before removing it");
    }
    company.groups = company.groups.filter((item) => item.id !== groupId);
    await writeJson(path.join(dir(id), "company.json"), company);
    return bundle(company, vouchers);
  }

  async function updateLedger(id, ledgerId, input) {
    const { company, vouchers } = await load(id);
    const ledger = company.ledgers.find((item) => item.id === ledgerId);
    if (!ledger) throw new Error("That ledger is not in this company");
    const originalLedger = structuredClone(ledger);
    assertCurrent(ledger, input.expected, ["name", "groupId", "opening"]);
    const name = cleanName(input.name);
    if (company.ledgers.some((item) => item.id !== ledgerId && item.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("A ledger with that name already exists");
    }
    if (!company.groups.some((item) => item.id === input.groupId)) throw new Error("Choose a group");
    const paise = input.openingPaise ?? ledger.opening.paise;
    const dc = input.openingDc ?? ledger.opening.dc;
    if (!Number.isSafeInteger(paise) || paise < 0) throw new Error("Opening balance must be zero or more");
    if (dc !== "Dr" && dc !== "Cr") throw new Error("Opening balance is debit or credit");
    const used = vouchers.some((voucher) => voucher.lines.some((line) => line.ledgerId === ledgerId));
    if (used && (paise !== ledger.opening.paise || (paise > 0 && dc !== ledger.opening.dc))) {
      throw new Error("An opening balance can change only before a voucher uses this ledger");
    }
    const openingChanged = paise !== ledger.opening.paise || dc !== ledger.opening.dc;
    const groupChanged = ledger.groupId !== input.groupId;
    if ((groupChanged || openingChanged) && itcAccountIds(company).has(ledgerId)) throw new Error("Reviewed input-tax ledgers keep their original group and opening balance");
    if (groupChanged && (gstAccountIds(company).has(ledgerId) || rcmAccountIds(company).has(ledgerId) || itcAccountIds(company).has(ledgerId))) throw new Error("GST posting ledgers keep their account groups. Change the GST master instead");
    ledger.name = name;
    ledger.groupId = input.groupId;
    ledger.opening = { dc, paise };
    guardReconciledLedger(company, originalLedger, ledger);
    if (groupChanged) {
      for (const voucher of vouchers) {
        if (voucher.lines.some((line) => line.ledgerId === ledgerId)) {
          // A ledger move cannot create number clashes. Recheck the affected voucher rules only.
          assertVoucher(company, voucher, [], voucher.id);
        }
      }
    }
    if (openingChanged) assertBookAmounts(company, vouchers);
    await writeJson(path.join(dir(id), "company.json"), company);
    return bundle(company, vouchers);
  }

  async function removeLedger(id, ledgerId) {
    const { company, vouchers } = await load(id);
    if (!company.ledgers.some((item) => item.id === ledgerId)) throw new Error("That ledger is not in this company");
    if (gstAccountIds(company).has(ledgerId) || rcmAccountIds(company).has(ledgerId) || itcAccountIds(company).has(ledgerId)) throw new Error("This ledger belongs to a GST master and is required for invoice posting");
    if (vouchers.some((voucher) => voucher.lines.some((line) => line.ledgerId === ledgerId))) {
      throw new Error("This ledger has vouchers. Move those entries before removing it");
    }
    guardReconciledLedger(company, company.ledgers.find(ledger => ledger.id === ledgerId), null);
    company.ledgers = company.ledgers.filter((item) => item.id !== ledgerId);
    await writeJson(path.join(dir(id), "company.json"), company);
    return bundle(company, vouchers);
  }

  async function passVoucher(id, input, voucherId) {
    const { company, vouchers } = await load(id);
    const original = voucherId ? vouchers.find((voucher) => voucher.id === voucherId) : null;
    if (voucherId && !original) throw new Error("That voucher is not in this company");
    if (original?.gstItc || input.gstItc) throw new Error("This journal belongs to a purchase credit review. Use the ITC review workflow");
    if (original?.gstRcm || input.gstRcm) throw new Error("RCM settlement entries keep their tax and cash linkage. Use the RCM reversal workflow");
    if (original?.gst || input.gst) throw new Error("GST invoices are linked to tax and stock records. Correct them with a GST credit or debit note");
    if (original) assertCurrent(original, input.expected, ["type", "date", "number", "narration", "lines"]);
    const requestId = input.requestId;
    if (requestId !== undefined && (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId))) {
      throw new Error("Invalid voucher save identifier");
    }
    const prior = !voucherId && requestId ? vouchers.find((voucher) => voucher.requestId === requestId) : null;
    const saved = assertVoucher(company, input, vouchers, original?.id || prior?.id || `v-${randomBytes(5).toString("hex")}`);
    if (saved.lines.some(line=>itcAccountIds(company).has(line.ledgerId))) throw new Error("Use purchase ITC review to post to its control ledgers");
    if (prior) {
      const { requestId: priorRequestId, ...priorEntry } = prior;
      if (!isDeepStrictEqual(saved, priorEntry)) throw new Error("That save identifier already belongs to a different voucher");
      return { ...bundle(company, vouchers), voucher: prior, replayed: true };
    }
    if (original && company.stock?.journals?.some(j=>j.accountingVoucherId === original.id) && tallyStockPostingHash(saved) !== tallyStockPostingHash(original)) {
      throw new Error("This Tally voucher is linked to an active stock movement. Record a correction in the accounts and inventory.");
    }
    guardReconciledVoucher(company, original, saved);
    if (original?.requestId || requestId) saved.requestId = original?.requestId || requestId;
    if (original?.source) saved.source = structuredClone(original.source);
    const index = vouchers.findIndex((voucher) => voucher.id === saved.id);
    if (index === -1) vouchers.push(saved);
    else vouchers[index] = saved;
    if (!original || !isDeepStrictEqual(saved.lines, original.lines)) assertBookAmounts(company, vouchers);
    await writeJson(path.join(dir(id), "vouchers.json"), vouchers);
    return { ...bundle(company, vouchers), voucher: saved };
  }

  async function removeVoucher(id, voucherId) {
    const { company, vouchers } = await load(id);
    if (vouchers.find(voucher => voucher.id === voucherId)?.gstItc) throw new Error("This journal belongs to a purchase credit review and cannot be deleted");
    if (vouchers.find(voucher => voucher.id === voucherId)?.gstRcm) throw new Error("RCM settlement entries keep their tax and cash linkage. Use the RCM reversal workflow");
    if (vouchers.find(voucher => voucher.id === voucherId)?.gst) throw new Error("GST invoices keep their tax and stock linkage. Use a GST credit note to reverse the supply");
    if (company.stock?.journals?.some(j=>j.accountingVoucherId === voucherId)) throw new Error("This Tally voucher is linked to an active stock movement and cannot be deleted");
    guardReconciledVoucher(company, vouchers.find(voucher => voucher.id === voucherId), null);
    const next = vouchers.filter((voucher) => voucher.id !== voucherId);
    if (next.length === vouchers.length) throw new Error("That voucher is not in this company");
    await writeJson(path.join(dir(id), "vouchers.json"), next);
    return bundle(company, next);
  }

  async function gstRcmAction(id, action, input) {
    const { company, vouchers } = await load(id);
    if (action === "setup") {
      const accounts = ensureRcmAccounts(company, input.registrationId);
      assertRcmBook(company, vouchers);
      await writeJson(path.join(dir(id), "company.json"), company);
      return { accounts };
    }
    const result = buildRcmAction(company, vouchers, action, input);
    if (result.replayed) return result;
    const voucher = { ...assertVoucher(company, result.voucher, vouchers, result.voucher.id), gstRcm: result.record };
    vouchers.push(voucher);
    assertBookAmounts(company, vouchers);
    assertRcmBook(company, vouchers);
    await writeJson(path.join(dir(id), "vouchers.json"), vouchers);
    return { ...result, voucher };
  }

  async function getGstExchange(id, invoiceId) {
    const { company, vouchers } = await snapshot(id);
    const voucher = vouchers.find(value => value.id === invoiceId && value.gst);
    if (!voucher) throw new Error("Choose an existing GST invoice");
    return exchangeView(voucher.gst, voucher.gstExchange, company);
  }

  async function saveGstExchange(id, invoiceId, action, input) {
    const { company, vouchers } = await load(id);
    const voucher = vouchers.find(value => value.id === invoiceId && value.gst);
    if (!voucher) throw new Error("Choose an existing GST invoice");
    const history = voucher.gstExchange || { version: 1, preparations: [], acknowledgements: [] };
    if (action === "preparation") {
      const fields = normalizePreparation(voucher.gst, input);
      if (isDeepStrictEqual(history.preparations.at(-1)?.fields, fields)) return { ...exchangeView(voucher.gst, history, company), replayed: true };
      if (history.preparations.length >= 100) throw new Error("This invoice has reached its preparation-history limit");
      history.preparations.push({ id: `prep-${randomUUID()}`, savedAt: new Date().toISOString(), invoiceFingerprint: invoiceFingerprint(voucher.gst), fields });
    } else if (action === "acknowledgement") {
      const record = acknowledgementRecord(voucher.gst, input, Date.now(), history.acknowledgements);
      for (const other of vouchers) {
        const existing = other.gstExchange?.acknowledgements.find(value => value.kind === record.kind && value.reference === record.reference);
        if (!existing) continue;
        if (other.id === voucher.id && existing.rawSHA256 === record.rawSHA256) return { ...exchangeView(voucher.gst, history, company), acknowledgement: existing, replayed: true };
        throw new Error("This acknowledgement is already linked to a different record or response");
      }
      if (history.acknowledgements.length >= 100) throw new Error("This invoice has reached its acknowledgement-history limit");
      history.acknowledgements.push(record);
    } else throw new Error("Unknown invoice exchange action");
    voucher.gstExchange = history;
    await writeJson(path.join(dir(id), "vouchers.json"), vouchers);
    return exchangeView(voucher.gst, history, company);
  }

  async function mutateCompanySection(id, section, transform) {
    if (!["reconciliation","stock"].includes(section)) throw new Error("Unknown mutable company metadata section");
    const book = await load(id);
    const current = structuredClone(book.company[section] ?? null);
    const updated = await transform(current, structuredClone(book));
    if (!updated || typeof updated !== "object" || Array.isArray(updated) || Buffer.byteLength(JSON.stringify(updated)) > (section === "stock" ? 32 * 1024 * 1024 : 1000000)) throw new Error("Invalid or oversized company metadata section");
    book.company[section] = updated;
    if (section === "stock") assertStockBook(book.company, book.vouchers);
    else assertReconciliation(book.company, book.vouchers);
    await writeJson(path.join(dir(id), "company.json"), book.company);
    return bundle(book.company, book.vouchers);
  }

  async function reviewTallyGst(id, action, records, input) {
    const {company,vouchers} = await load(id);
    const apply = action==="mapping" ? saveTallyGstMapping : activateTallyGstPromotion;
    const change=apply(company,vouchers,records,input);
    if (!change.replayed) {
      assertTallyGstBook(change.company,change.vouchers);
      assertBookAmounts(change.company,change.vouchers);
      assertStockBook(change.company,change.vouchers);
      if (action==="mapping") await writeJson(path.join(dir(id),"company.json"),change.company);
      else await commitBook(dir(id),change.company,change.vouchers);
    }
    return {result:change.result,report:change.report,revision:change.report.revision,replayed:change.replayed===true};
  }

  async function gstItcAction(id,action,input) {
    const {company,vouchers}=await load(id);
    const invoice=vouchers.find(v=>v.gst?.id===input?.invoiceId)?.gst;
    if (!invoice || invoice.direction!=="purchase" || invoice.reverseCharge) throw new Error("Choose a forward-charge purchase document");
    ensureItcAccounts(company,invoice.registrationId);
    const result=buildItcAction(company,vouchers,action,input);
    if (result.replayed) return result;
    await verifyItcStatement(dir(id),company,vouchers,invoice.id,input.evidence?.statement);
    const record=result.record;
    company.gst.itc.records.push(record);
    if (result.voucher) {
      const checked={...assertVoucher(company,result.voucher,vouchers,result.voucher.id),gstItc:record};
      vouchers.push(checked);
      result.voucher=checked;
    }
    assertItcBook(company,vouchers);
    assertBookAmounts(company,vouchers);
    assertStockBook(company,vouchers);
    if (result.voucher) await commitBook(dir(id),company,vouchers);
    else await writeJson(path.join(dir(id),"company.json"),company);
    return result;
  }

  async function saveGstAmendment(id, input) {
    const { company, vouchers } = await load(id);
    const result = buildOutwardAmendment(company,vouchers,input);
    if (result.replayed) return result;
    const amendments = company.gst.outwardAmendments ??= {version:1, revision:0, records:[]};
    amendments.records.push(result.record);
    amendments.revision = result.revision;
    // Only this company-file append changes state. Publish linked evidence before the reference.
    await saveFiledSource(dir(id),company,result.record,input.sourceFileBase64);
    await writeJson(path.join(dir(id),"company.json"),company);
    return result;
  }

  async function saveGstAmendmentEvent(id, action, input) {
    const {company,vouchers} = await load(id);
    const result = buildAmendmentEvent(company,vouchers,action,input);
    if (result.replayed) return result;
    const amendments = company.gst.outwardAmendments;
    (amendments.events ??= []).push(result.event);
    amendments.revision = result.revision;
    await writeJson(path.join(dir(id),"company.json"),company);
    return result;
  }

  async function saveGstStatement(id,reg,month,input) {
    const {company,vouchers}=await load(id);
    const result=await recordStatement(dir(id),company,vouchers,reg,month,input);
    if (!result.replayed) await writeJson(path.join(dir(id),"company.json"),company);
    return result;
  }

  async function saveGstMaster(id, kind, input) {
    const { company, vouchers } = await load(id);
    const methods = { registration: saveRegistration, party: saveParty, item: saveItem, turnover: saveTurnover, irpPolicy: saveIrpPolicy };
    if (!methods[kind]) throw new Error("Unknown GST master");
    if (kind === "item" && input.id && company.stock?.journals?.some(j=>j.lines.some(l=>l.itemId===input.id))) {
      const previous = company.gst?.items?.find(i=>i.id===input.id);
      if (previous && (previous.kind !== input.kind || previous.unit !== input.unit)) throw new Error("A stock journal uses this item's unit and kind");
    }
    const saved = methods[kind](company, input, vouchers);
    if (kind === "item" && company.stock) assertStockBook(company,vouchers);
    if (kind === "registration") ensureRcmAccounts(company, saved.id);
    assertRcmBook(company, vouchers);
    await writeJson(path.join(dir(id), "company.json"), company);
    return { ...gstState(company, vouchers), [kind]: saved };
  }

  async function previewGstInvoice(id, input) {
    const { company, vouchers } = await load(id);
    const invoice = buildGstInvoice(company, vouchers, input, "preview");
    invoiceStockMetadata(company, invoice, input, vouchers);
    return { invoice };
  }

  async function passGstInvoice(id, input) {
    const { company, vouchers } = await load(id);
    if (input.requestId !== undefined && (typeof input.requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId))) throw new Error("Invalid invoice save identifier");
    const prior = input.requestId ? vouchers.find(voucher => voucher.gst?.requestId === input.requestId) : null;
    if (prior) {
      if (prior.gst.requestHash !== gstRequestHash(input)) throw new Error("That invoice save identifier belongs to a different request");
      return { invoice: prior.gst, voucher: prior, replayed: true };
    }
    const invoice = buildGstInvoice(company, vouchers, input);
    const source = gstVoucher(invoice);
    const voucher = { ...assertVoucher(company, source, vouchers, source.id), gst: invoice };
    const locations = invoiceStockMetadata(company,invoice,input,vouchers);
    if (locations) voucher.stock = locations;
    assertGstSnapshot(company, voucher);
    vouchers.push(voucher);
    if (locations || company.stock) assertStockBook(company,vouchers);
    assertBookAmounts(company, vouchers);
    assertRcmBook(company, vouchers);
    await writeJson(path.join(dir(id), "vouchers.json"), vouchers);
    return { invoice, voucher };
  }

  async function specimen() {
    await ensure();
    const { company, vouchers } = buildSpecimen();
    company.id = `specimen-${randomBytes(3).toString("hex")}`;
    const folder = dir(company.id);
    await mkdir(folder, { recursive: true });
    await writeJson(path.join(folder, "company.json"), company);
    await writeJson(path.join(folder, "vouchers.json"), vouchers);
    return bundle(company, vouchers);
  }

  async function removeCompany(id) {
    await rm(dir(id), { recursive: true, force: true });
  }

  return {
    snapshot: (id) => serial(id, () => snapshot(id)),
    gstState: (id, date) => serial(id, async () => { const { company, vouchers } = await snapshot(id); return { ...gstState(company, vouchers, date), godowns:stockLocations(company) }; }),
    reviewTallyGst:(id,action,records,input)=>serial(id,()=>reviewTallyGst(id,action,records,input)),
    saveGstAmendmentEvent:(id,action,input)=>serial(id,()=>saveGstAmendmentEvent(id,action,input)),
    saveGstAmendment:(id,input)=>serial(id,()=>saveGstAmendment(id,input)),
    gstItcAction:(id,action,input)=>serial(id,()=>gstItcAction(id,action,input)),
    gstRcmAction: (id, action, input) => serial(id, () => gstRcmAction(id, action, input)),
    saveGstStatement: (id,reg,month,input) => serial(id,()=>saveGstStatement(id,reg,month,input)),
    getGstExchange: (id, invoiceId) => serial(id, () => getGstExchange(id, invoiceId)),
    saveGstExchange: (id, invoiceId, action, input) => serial(id, () => saveGstExchange(id, invoiceId, action, input)),
    mutateCompanySection: (id, section, transform) => serial(id, () => mutateCompanySection(id, section, transform)),
    saveGstMaster: (id, kind, input) => serial(id, () => saveGstMaster(id, kind, input)),
    previewGstInvoice: (id, input) => serial(id, () => previewGstInvoice(id, input)),
    passGstInvoice: (id, input) => serial(id, () => passGstInvoice(id, input)),
    list, create, specimen,
    get: (id) => serial(id, () => get(id)),
    addGroup: (id, input) => serial(id, () => addGroup(id, input)),
    addLedger: (id, input) => serial(id, () => addLedger(id, input)),
    updateGroup: (id, groupId, input) => serial(id, () => updateGroup(id, groupId, input)),
    removeGroup: (id, groupId) => serial(id, () => removeGroup(id, groupId)),
    updateLedger: (id, ledgerId, input) => serial(id, () => updateLedger(id, ledgerId, input)),
    removeLedger: (id, ledgerId) => serial(id, () => removeLedger(id, ledgerId)),
    passVoucher: (id, input, voucherId) => serial(id, () => passVoucher(id, input, voucherId)),
    removeVoucher: (id, voucherId) => serial(id, () => removeVoucher(id, voucherId)),
    removeCompany: (id) => serial(id, () => removeCompany(id)),
  };
}
