import { todayISO } from "./money.js";
import { bankReport, billReport, parseBankCsv, mutateReconciliation, previewBankStatement, reconciliationSection } from "./reconciliation.js";

const ACTIONS = new Set(["import-statement", "match-bank", "unmatch-bank", "bank-opening", "save-bill", "remove-bill", "allocate-bill", "unallocate-bill"]);
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
  if (req.method === "POST" && parts.length === 5 && action === "csv-columns") {
    const { headers, records } = parseBankCsv((await readBody(req)).csv);
    send(res, 200, { headers, sample: records.slice(0, 5) });
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
    const input = await readBody(req);
    let response;
    await store.mutateCompanySection(id, "reconciliation", (current, book) => {
      response = mutateReconciliation(current, book, action, input);
      return response.section;
    });
    send(res, 200, { revision: response.section.revision, result: response.result, replayed: response.replayed });
    return true;
  }
  send(res, 404, { error: "Unknown reconciliation action" });
  return true;
}
