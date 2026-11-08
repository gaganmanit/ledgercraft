import { assertGstSnapshot } from "./gst.js";
import { assertExchangeSnapshot } from "./gst-exchange.js";

export function checkedSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Invalid voucher source linkage");
  const fields = ["system", "recordId", "guid", "masterId", "originalType", "originalNumber", "archive"];
  if (Object.keys(source).some(key => !fields.includes(key)) || Object.values(source).some(value => typeof value !== "string" || value.length > 256) || !source.system || !source.recordId) {
    throw new Error("Invalid or oversized source linkage");
  }
  return structuredClone(source);
}

export function copyVoucherMetadata(company, source, checked) {
  if (source.source !== undefined) checked.source = checkedSource(source.source);
  if (source.requestId !== undefined) {
    if (typeof source.requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(source.requestId)) throw new Error("Invalid voucher save identifier");
    checked.requestId = source.requestId;
  }
  if (source.gst !== undefined) checked.gst = assertGstSnapshot(company, { ...checked, gst: source.gst });
  if (source.gstItc !== undefined) {
    if (source.gst || source.gstRcm || checked.type!=="Journal" || source.gstItc?.version!==1 || source.gstItc.voucherId!==checked.id) throw new Error("Invalid purchase ITC journal linkage");
    checked.gstItc=structuredClone(source.gstItc);
  }
  if (source.gstRcm !== undefined) {
    if (!source.gstRcm || source.gstRcm.version !== 1 || Buffer.byteLength(JSON.stringify(source.gstRcm)) > 32000) throw new Error("Invalid RCM bookkeeping snapshot");
    checked.gstRcm = structuredClone(source.gstRcm);
  }
  if (source.stock !== undefined) {
    if (!checked.gst || source.stock?.version !== 1 || !Array.isArray(source.stock.lines) || source.stock.lines.length>500) throw new Error("Invalid stock allocations for the voucher");
    checked.stock = structuredClone(source.stock);
  }
  if (source.gstExchange !== undefined) {
    if (!checked.gst) throw new Error("Invoice exchange history requires its linked GST invoice snapshot");
    checked.gstExchange = assertExchangeSnapshot(checked.gst, source.gstExchange);
  }
  return checked;
}
