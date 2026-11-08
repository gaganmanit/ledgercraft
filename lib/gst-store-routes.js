import { invoiceIrpStatus } from "./gst-irp-policy.js";
export async function handleGstRoute({ req, res, url, parts, store, readBody, send }) {
  if (parts[0] !== "api" || parts[1] !== "companies" || !parts[2] || parts[3] !== "gst") return false;
  const id = decodeURIComponent(parts[2]);
  const action = parts[4];
  if (req.method === "GET" && action === "registrations" && parts.length === 5) {
    const { company } = await store.snapshot(id);
    const registrations = (company.gst?.registrations || []).map(({id,name,legalName,gstin,stateCode}) => ({id,name,legalName,gstin,stateCode}));
    send(res,200,{company:{id:company.id,name:company.name,booksFrom:company.booksFrom},registrations});
    return true;
  }
  if (req.method === "GET" && parts.length === 4) {
    send(res, 200, await store.gstState(id, url.searchParams.get("date") || undefined));
    return true;
  }
  if (req.method === "PUT" && action === "irp-policy" && parts.length === 5) {
    send(res, 200, await store.saveGstMaster(id, "irpPolicy", await readBody(req)));
    return true;
  }
  if (req.method === "PUT" && action === "turnover" && parts.length === 5) {
    send(res, 200, await store.saveGstMaster(id, "turnover", await readBody(req)));
    return true;
  }
  if (req.method === "PUT" && action === "settings" && parts.length === 5) {
    send(res, 200, await store.saveGstMaster(id, "registration", await readBody(req)));
    return true;
  }
  if (req.method === "POST" && ["parties", "items"].includes(action) && parts.length === 5) {
    send(res, 201, await store.saveGstMaster(id, action === "parties" ? "party" : "item", await readBody(req)));
    return true;
  }
  if (req.method === "POST" && action === "preview" && parts.length === 5) {
    send(res, 200, await store.previewGstInvoice(id, await readBody(req)));
    return true;
  }
  if (req.method === "POST" && action === "invoices" && parts.length === 5) {
    send(res, 201, await store.passGstInvoice(id, await readBody(req)));
    return true;
  }
  if (req.method === "GET" && action === "invoices" && parts.length === 6) {
    const { company, vouchers } = await store.snapshot(id);
    const voucher = vouchers.find(v => v.gst?.id === decodeURIComponent(parts[5]));
    if (!voucher) throw new Error("That GST invoice is not in this company");
    const bound = voucher.gstExchange ? (await store.getGstExchange(id, voucher.id)).display : null;
    const acknowledgement = bound ? { irn: bound.irn, acknowledgementNumber: bound.acknowledgementNumber,
      acknowledgementDate: bound.acknowledgementDate, trust: bound.trust } : null;
    send(res, 200, { invoice: voucher.gst, acknowledgement, irpStatus: invoiceIrpStatus(company, voucher.gst, acknowledgement) });
    return true;
  }
  send(res, 404, { error: "Unknown GST action" });
  return true;
}
