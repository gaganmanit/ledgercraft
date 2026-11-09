import { todayISO } from "./money.js";
import { bankReport, billReport, parseBankCsv, mutateReconciliation, previewBankStatement, reconciliationSection } from "./reconciliation.js";
import { statementSource } from "./reconciliation-bank.js";
import { bankRulesView } from "./bank-rules.js";

const ACTIONS = new Set(["import-statement", "match-bank", "unmatch-bank", "bank-opening", "save-bill", "remove-bill", "allocate-bill", "unallocate-bill"]);
async function mutate(store, id, action, input) {
  let response;
  const book = await store.mutateCompanySection(id, "reconciliation", (current, snapshot) => {
    response = mutateReconciliation(current, snapshot, action, input);
    return response.section;
  });
  return { ...response, book };
}
export async function handleReconciliationRoute({ req, res, url, parts, store, readBody, send }) {
  if (parts[0] !== "api" || parts[1] !== "companies" || !parts[2] || parts[3] !== "reconciliation") return false;
  const id = decodeURIComponent(parts[2]);
  const action = parts[4] || "bank";
  if (req.method === "GET" && parts.length <= 5 && ["bank", "bills", "audit"].includes(action)) {
    const { company, vouchers } = await store.snapshot(id);
    const meta = reconciliationSection(company.reconciliation);
    if (action === "bank") send(res, 200, bankReport(meta, company, vouchers, url.searchParams.get("statementId") || ""));
    if (action === "bills") send(res, 200, billReport(meta, company, vouchers, url.searchParams.get("asOf") || todayISO(), url.searchParams.get("ledgerId") || ""));
    if (action === "audit") send(res, 200, { revision: meta.revision, rows: meta.audit });
    return true;
  }
  // Bank rules: GET the list, PUT the whole list back (the order is the priority).
  if (parts.length === 5 && action === "bank-rules" && ["GET", "PUT"].includes(req.method)) {
    if (req.method === "GET") {
      const { company } = await store.snapshot(id);
      const meta = reconciliationSection(company.reconciliation);
      send(res, 200, { revision: meta.revision, rules: bankRulesView(meta, company) });
      return true;
    }
    const response = await mutate(store, id, "save-bank-rules", await readBody(req));
    send(res, 200, { revision: response.section.revision, rules: bankRulesView(response.section, response.book.company), result: response.result, replayed: response.replayed });
    return true;
  }
  // POST .../reconciliation/bank/<statementId>/rows/<rowIndex or row id>/voucher
  if (req.method === "POST" && parts.length === 9 && action === "bank" && parts[6] === "rows" && parts[8] === "voucher") {
    const result = await store.passBankLineVoucher(id, decodeURIComponent(parts[5]), decodeURIComponent(parts[7]), await readBody(req));
    send(res, result.replayed ? 200 : 201, result);
    return true;
  }
  if (req.method === "POST" && parts.length === 5 && action === "csv-columns") {
    const source = statementSource(await readBody(req));
    const { headers, records } = parseBankCsv(source.csv);
    send(res, 200, { headers, sample: records.slice(0, 5), sourceFormat: source.sourceFormat || "csv" });
    return true;
  }
  if (req.method === "POST" && parts.length === 5 && action === "bank-preview") {
    const { company, vouchers } = await store.snapshot(id);
    const statement = previewBankStatement(company, vouchers, await readBody(req));
    const { sourceCsv, ...preview } = statement;
    send(res, 200, { statement: preview });
    return true;
  }
  if (req.method === "POST" && parts.length === 5 && ACTIONS.has(action)) {
    const response = await mutate(store, id, action, await readBody(req));
    send(res, 200, { revision: response.section.revision, result: response.result, replayed: response.replayed });
    return true;
  }
  send(res, 404, { error: "Unknown reconciliation action" });
  return true;
}
