import path from "node:path";
import { isIsoDate, todayISO } from "./money.js";
import { imsStatementView } from "./gst-statement-library.js";
import { rule37Watch } from "./gst-ims.js";
import { toleranceView } from "./gst-reconcile.js";

// GSTR-2B month-end routes: IMS rows and actions, the rule 37 watch and the matching tolerance.
export async function handleImsRoute({ req, res, url, parts, store, dataDir, readBody, send }) {
  if (parts[0] !== "api" || parts[1] !== "companies" || !parts[2] || parts[3] !== "gst-returns") return false;
  const id = decodeURIComponent(parts[2]);
  if (parts[4] === "ims") {
    if (req.method === "GET" && parts.length === 5) {
      const { company, vouchers } = await store.snapshot(id);
      send(res, 200, await imsStatementView(path.join(dataDir, "companies", company.id), company, vouchers, url.searchParams.get("registration"), url.searchParams.get("statement") || ""));
      return true;
    }
    if (req.method === "POST" && parts.length === 6 && parts[5] === "actions") {
      send(res, 201, await store.saveImsAction(id, await readBody(req), "action"));
      return true;
    }
    if (req.method === "GET" && parts.length === 6 && parts[5] === "rule37") {
      const { company, vouchers } = await store.snapshot(id);
      const registrationId = url.searchParams.get("registration") || "";
      if (registrationId && !company.gst?.registrations?.some(r => r.id === registrationId)) throw new Error("Choose a saved GST registration");
      const asOf = url.searchParams.get("asOf") || todayISO();
      if (!isIsoDate(asOf)) throw new Error("Choose the rule 37 review date");
      send(res, 200, rule37Watch(company, vouchers, asOf, { registrationId }));
      return true;
    }
    send(res, 404, { error: "Unknown IMS action" });
    return true;
  }
  if (parts[4] === "reconcile-2b" && parts[5] === "settings" && parts.length === 6) {
    if (req.method === "GET") {
      const { company } = await store.snapshot(id);
      send(res, 200, toleranceView(company));
      return true;
    }
    if (req.method === "POST") {
      send(res, 200, await store.saveImsAction(id, await readBody(req), "tolerance"));
      return true;
    }
  }
  return false;
}
