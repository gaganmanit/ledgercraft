import { movementFile, irpBulk } from "./gst-exchange.js";

export async function handleGstExchangeRoute({ req, res, parts, store, readBody, send }) {
  if (parts[0] !== "api" || parts[1] !== "companies" || !parts[2] || parts[3] !== "gst-exchange" || !parts[4]) return false;
  const companyId = decodeURIComponent(parts[2]);
  const invoiceId = decodeURIComponent(parts[4]);
  if (req.method === "GET" && parts.length === 5) {
    send(res, 200, await store.getGstExchange(companyId, invoiceId));
    return true;
  }
  if (req.method === "PUT" && parts.length === 5) {
    send(res, 200, await store.saveGstExchange(companyId, invoiceId, "preparation", await readBody(req)));
    return true;
  }
  if (req.method === "POST" && parts[5] === "acknowledgements" && parts.length === 6) {
    send(res, 201, await store.saveGstExchange(companyId, invoiceId, "acknowledgement", await readBody(req)));
    return true;
  }
  if (req.method === "GET" && ["irp", "ewaybill"].includes(parts[5]) && parts.length === 6) {
    const state = await store.getGstExchange(companyId, invoiceId);
    if (!state.capabilities[parts[5]].ready) throw new Error(state.capabilities[parts[5]].reason);
    const value = parts[5] === "irp" ? irpBulk(state.invoice, state.preparation) : movementFile(state.invoice, state.preparation, state.movementMode, state.display);
    const filename = `${state.invoice.number.replace(/[^A-Za-z0-9_-]/g, "-")}-${parts[5]}.json`;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" });
    res.end(JSON.stringify(value, null, 2));
    return true;
  }
  send(res, 404, { error: "Unknown invoice exchange action" });
  return true;
}
