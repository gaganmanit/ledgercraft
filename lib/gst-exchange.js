import { createHash, verify, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { GST_STATES, normalizeGstin, quantityMicros } from "./gst.js";
import { isIsoDate, todayISO } from "./money.js";
import { invoiceIrpStatus } from "./gst-irp-policy.js";
import { IRP_SIGNING_REGISTRY } from "./gst-exchange-trust.js";

export const GST_EXCHANGE_SOURCES = Object.freeze({
  irp: "https://einv-apisandbox.nic.in/version1.03/generate-irn.html",
  ewaybill: "https://docs.ewaybillgst.gov.in/apidocs/version1.03/generate-eway-bill.html",
  ewaybillByIrn: "https://einv-apisandbox.nic.in/version1.03/ewaybill-generation-irn.html",
  signingKeys: "https://einvoice6.gst.gov.in/content/public-keys/",
});
const MAX_LINE_PAISE = 99999999999999;
const uqc = new Set(["BAG", "BAL", "BDL", "BKL", "BOU", "BOX", "BTL", "BUN", "CAN", "CBM", "CCM", "CMS", "CTN", "DOZ", "DRM", "GGK", "GMS", "GRS", "GYD", "KGS", "KLR", "KME", "LTR", "MLT", "MTR", "MTS", "NOS", "PAC", "PCS", "PRS", "QTL", "ROL", "SET", "SQF", "SQM", "SQY", "TBS", "TGM", "THD", "TON", "TUB", "UGS", "UNT", "YDS", "OTH"]);

function string(value, label, maximum, required = true, minimum = 1) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`Enter ${label}`);
  const result = String(value).trim();
  if (((required || result.length > 0) && result.length < minimum) || result.length > maximum || /["\\\x00-\x1f]/.test(result)) throw new Error(`Enter ${label} within ${minimum}–${maximum} characters`);
  return result;
}
function state(value, foreign = false) {
  const code = String(value ?? "").padStart(2, "0");
  if (!GST_STATES.some(item => item.code === code) || (!foreign && code === "96")) throw new Error("Choose a valid dispatch or delivery state");
  return code;
}
function pincode(value, foreign) {
  const text = String(value ?? "");
  if (!/^[1-9]\d{5}$/.test(text) || (foreign && text !== "999999")) throw new Error(foreign ? "Use PIN 999999 for the foreign recipient" : "Enter a six-digit PIN code");
  return Number(text);
}
function officialDate(iso) {
  if (!isIsoDate(iso)) throw new Error("Enter a valid document date");
  return iso.split("-").reverse().join("/");
}
function isoDate(value) {
  const text = String(value ?? "").trim();
  if (isIsoDate(text)) return text;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!match || !isIsoDate(`${match[3]}-${match[2]}-${match[1]}`)) throw new Error("The acknowledgement has an invalid document date");
  return `${match[3]}-${match[2]}-${match[1]}`;
}
function paise(value) {
  const text = String(value);
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error("The acknowledgement amount needs exact INR paise");
  const [whole, fraction = ""] = text.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The amount exceeds exact INR paise");
  return Number(amount);
}
function rupees(amount, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > maximum) throw new Error("An amount exceeds the exchange schema's supported limit");
  const value = amount / 100;
  if (paise(value) !== amount) throw new Error("This amount cannot be exported as an exact JSON rupee value");
  return value;
}
function quantityNumber(value, maximumDecimals) {
  const micros = quantityMicros(value);
  const divisor = 10n ** BigInt(6 - maximumDecimals);
  if (micros % divisor) throw new Error(`The exchange quantity supports up to ${maximumDecimals} decimal places`);
  const number = Number(value);
  if (quantityMicros(String(number)) !== micros || number > 9999999999.999) throw new Error("The quantity exceeds the exchange schema's supported limit");
  return number;
}
function halfUp(numerator, denominator) {
  return Number((numerator + denominator / 2n) / denominator);
}
function documentType(invoice) {
  return invoice.type === "Credit Note" ? "CRN" : invoice.type === "Debit Note" ? "DBN" : "INV";
}
export function invoiceFingerprint(invoice) {
  return createHash("sha256").update(JSON.stringify(invoice)).digest("hex");
}
function eligibleInvoice(invoice, irp = false) {
  if (!invoice || invoice.direction !== "sales") throw new Error("Choose a supplier-issued sales document");
  if (invoice.reverseCharge && !(invoice.rcm?.direction === "outward" && invoice.rcm.applicabilityConfirmed && invoice.supplyCategory === "domestic" && invoice.party.gstin && invoice.partyDuePaise === invoice.totals.taxablePaise)) throw new Error("Reverse-charge exchange requires a posted domestic RCM invoice with a registered recipient");
  if (irp && !/^[A-Z1-9][A-Z0-9/-]{0,15}$/.test(invoice.number)) throw new Error("IRP document numbers need an uppercase letter or a non-zero digit first");
}
function addressDefaults(party) {
  const [first = "", ...rest] = String(party.address || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  return { legalName: party.legalName || party.name, address1: first, address2: rest.join(", "), location: "", pincode: party.stateCode === "96" ? "999999" : party.pincode || "", stateCode: party.stateCode, gstin: party.gstin || "" };
}
export function exchangeDefaults(invoice) {
  return {
    seller: addressDefaults(invoice.registration), buyer: addressDefaults(invoice.party),
    dispatch: { enabled: false, ...addressDefaults(invoice.registration) },
    ship: { enabled: false, ...addressDefaults(invoice.party) },
    transport: { partAOnly: false, mode: "1", distanceKm: 0, vehicleNo: "", vehicleType: "R", transporterId: "", transporterName: "", documentNumber: "", documentDate: "" },
    export: { countryCode: invoice.destinationCountry || "", portCode: invoice.portCode || "", shippingBillNumber: invoice.shippingBillNumber || "", shippingBillDate: invoice.shippingBillDate || "" },
  };
}
function normalAddress(input, label, fixedState) {
  const code = fixedState || state(input.stateCode, true);
  return {
    legalName: string(input.legalName, `${label} legal name`, 100, true, 3),
    address1: string(input.address1, `${label} address`, 100),
    address2: string(input.address2, `${label} second address line`, 100, false, 3),
    location: string(input.location, `${label} location`, 50, true, 3),
    pincode: pincode(input.pincode, code === "96"), stateCode: code,
  };
}
export function normalizePreparation(invoice, input) {
  eligibleInvoice(invoice);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Enter exchange preparation details");
  const seller = normalAddress(input.seller || {}, "seller", invoice.registration.stateCode);
  const buyer = normalAddress(input.buyer || {}, "buyer", invoice.party.stateCode);
  const result = { seller, buyer, dispatch: { enabled: false }, ship: { enabled: false } };
  for (const key of ["dispatch", "ship"]) {
    if (input[key]?.enabled === true) {
      result[key] = { enabled: true, ...normalAddress(input[key], key) };
      if (key === "ship") result.ship.gstin = input.ship.gstin ? normalizeGstin(input.ship.gstin) : "";
    }
  }
  const transport = input.transport || {};
  const mode = string(transport.mode || "1", "transport mode", 1);
  if (!["1", "2", "3", "4"].includes(mode)) throw new Error("Choose road, rail, air or ship transport");
  const distanceKm = Number(transport.distanceKm ?? 0);
  if (!Number.isInteger(distanceKm) || distanceKm < 0 || distanceKm > 4000) throw new Error("Enter a transport distance from zero to 4,000 km");
  const vehicleType = transport.vehicleType || "R";
  if (!["R", "O"].includes(vehicleType)) throw new Error("Choose regular or over-dimensional vehicle type");
  const vehicleNo = string(transport.vehicleNo, "vehicle number", 15, false).toUpperCase();
  if (vehicleNo && !/^[A-Z0-9]{4,15}$/.test(vehicleNo)) throw new Error("Enter the vehicle number using letters and digits");
  const transporterId = string(transport.transporterId, "transporter GSTIN or TRANSIN", 15, false).toUpperCase();
  if (transporterId && !/^[A-Z0-9]{15}$/.test(transporterId)) throw new Error("Enter a fifteen-character transporter GSTIN or TRANSIN");
  const documentNumber = string(transport.documentNumber, "transport document number", 15, false);
  if (documentNumber && !/^[A-Za-z0-9/-]+$/.test(documentNumber)) throw new Error("Use letters, digits, slashes or hyphens for the transport document");
  const documentDate = transport.documentDate || "";
  if (documentDate && !isIsoDate(documentDate)) throw new Error("Enter the transport document date");
  result.transport = { partAOnly: transport.partAOnly === true, mode, distanceKm, vehicleNo, vehicleType, transporterId, transporterName: string(transport.transporterName, "transporter name", 100, false), documentNumber, documentDate };
  const exporting = input.export || {};
  result.export = {
    countryCode: string(exporting.countryCode, "destination country code", 2, false).toUpperCase(),
    portCode: string(exporting.portCode, "port code", 6, false).toUpperCase(),
    shippingBillNumber: string(exporting.shippingBillNumber, "shipping bill number", 7, false),
    shippingBillDate: exporting.shippingBillDate || "",
  };
  if (result.export.countryCode && !/^[A-Z]{2}$/.test(result.export.countryCode)) throw new Error("Use a two-letter country code");
  if (result.export.portCode && !/^[A-Z0-9]{6}$/.test(result.export.portCode)) throw new Error("Use the six-character port code");
  if (result.export.shippingBillDate && !isIsoDate(result.export.shippingBillDate)) throw new Error("Enter a valid shipping bill date");
  return result;
}
function supplyType(invoice) {
  if (invoice.supplyCategory === "export") return invoice.exportMode === "lut" ? "EXPWOP" : "EXPWP";
  if (invoice.supplyCategory === "sez") return invoice.exportMode === "lut" ? "SEZWOP" : "SEZWP";
  if (!invoice.party.gstin) throw new Error("Domestic B2C documents do not use the IRP e-invoice schema");
  return "B2B";
}
function irpItem(invoice, item, index) {
  const unit = item.unit.toUpperCase();
  if (!uqc.has(unit)) throw new Error(`Choose an official UQC for ${item.name} before preparing its exchange file`);
  const qty = quantityNumber(item.quantity, 3);
  const noPayment = item.supplyStatus === "zero-rated" && invoice.exportMode === "lut";
  const denominator = BigInt(10000 + (noPayment ? 0 : item.gstRateBps + item.cessRateBps));
  const inclusive = invoice.pricing === "inclusive";
  const gross = inclusive ? Math.max(item.taxablePaise, halfUp(BigInt(item.grossPaise) * 10000n, denominator)) : item.grossPaise;
  const discount = gross - item.taxablePaise;
  const unitPrice = inclusive ? halfUp(BigInt(item.unitPricePaise) * 100000n, denominator) / 1000 : rupees(item.unitPricePaise);
  if (unitPrice > 999999999999.999) throw new Error("A unit price exceeds the IRP schema limit");
  return {
    SlNo: String(index + 1), PrdDesc: string(item.name, "item description", 300), IsServc: item.kind === "service" ? "Y" : "N", HsnCd: item.hsnSac,
    Qty: qty, Unit: unit, UnitPrice: unitPrice, TotAmt: rupees(gross, MAX_LINE_PAISE), Discount: rupees(discount, MAX_LINE_PAISE), AssAmt: rupees(item.taxablePaise, MAX_LINE_PAISE),
    GstRt: item.gstRateBps / 100, IgstAmt: rupees(item.igstPaise, MAX_LINE_PAISE), CgstAmt: rupees(item.cgstPaise, MAX_LINE_PAISE), SgstAmt: rupees(item.sgstPaise + item.utgstPaise, MAX_LINE_PAISE),
    CesRt: item.cessRateBps / 100, CesAmt: rupees(item.cessPaise, MAX_LINE_PAISE), CesNonAdvlAmt: 0, StateCesRt: 0, StateCesAmt: 0, StateCesNonAdvlAmt: 0, OthChrg: 0, TotItemVal: rupees(item.totalPaise, MAX_LINE_PAISE),
  };
}
export function irpDocument(invoice, preparation) {
  eligibleInvoice(invoice, true);
  if (invoice.documentLabel === "Bill of Supply") throw new Error("A bill of supply is outside the IRP tax-document flow");
  const supTyp = supplyType(invoice);
  const prepared = normalizePreparation(invoice, preparation);
  const address = (party, details) => ({ Gstin: party.gstin || "URP", LglNm: details.legalName, Addr1: details.address1, ...(details.address2 ? { Addr2: details.address2 } : {}), Loc: details.location, Pin: details.pincode, Stcd: party.stateCode });
  const total = invoice.totals;
  const payload = {
    Version: "1.1", TranDtls: { TaxSch: "GST", SupTyp: supTyp, RegRev: invoice.reverseCharge ? "Y" : "N", IgstOnIntra: "N" },
    DocDtls: { Typ: documentType(invoice), No: invoice.number, Dt: officialDate(invoice.date) },
    SellerDtls: address(invoice.registration, prepared.seller),
    BuyerDtls: { ...address(invoice.party, prepared.buyer), Pos: invoice.placeOfSupply },
    ItemList: invoice.items.map((item, index) => irpItem(invoice, item, index)),
    ValDtls: { AssVal: rupees(total.taxablePaise), CgstVal: rupees(total.cgstPaise), SgstVal: rupees(total.sgstPaise + total.utgstPaise), IgstVal: rupees(total.igstPaise), CesVal: rupees(total.cessPaise), StCesVal: 0, Discount: 0, OthChrg: 0, RndOffAmt: 0, TotInvVal: rupees(total.totalPaise) },
  };
  if (prepared.dispatch.enabled) payload.DispDtls = { Nm: prepared.dispatch.legalName, Addr1: prepared.dispatch.address1, ...(prepared.dispatch.address2 ? { Addr2: prepared.dispatch.address2 } : {}), Loc: prepared.dispatch.location, Pin: prepared.dispatch.pincode, Stcd: prepared.dispatch.stateCode };
  if (prepared.ship.enabled) payload.ShipDtls = { ...address({ gstin: prepared.ship.gstin, stateCode: prepared.ship.stateCode }, prepared.ship) };
  if (invoice.originalNumber) payload.RefDtls = { PrecDocDtls: [{ InvNo: invoice.originalNumber, InvDt: officialDate(invoice.originalDate) }] };
  if (invoice.supplyCategory === "export") {
    if (!prepared.export.countryCode) throw new Error("Enter the export destination country code");
    payload.ExpDtls = { CntCode: prepared.export.countryCode, RefClm: "N", ...(prepared.export.portCode ? { Port: prepared.export.portCode } : {}), ...(prepared.export.shippingBillNumber ? { ShipBNo: prepared.export.shippingBillNumber } : {}), ...(prepared.export.shippingBillDate ? { ShipBDt: officialDate(prepared.export.shippingBillDate) } : {}) };
  }
  return payload;
}
export function irpBulk(invoice, preparation) {
  return [irpDocument(invoice, preparation)];
}
function movement(invoice, prepared, today) {
  const ageDays = (Date.parse(today) - Date.parse(invoice.date)) / 86400000;
  if (ageDays < 0 || ageDays > 180) throw new Error("The e-way bill document date must be today or within the preceding 180 days");
  const from = prepared.dispatch.enabled ? prepared.dispatch : prepared.seller;
  const to = prepared.ship.enabled ? prepared.ship : prepared.buyer;
  if (from.stateCode === "96") throw new Error("An e-way bill dispatch location must be in India");
  if (to.stateCode === "96") throw new Error("Capture the Indian exit-port delivery address for an export e-way bill");
  const transport = prepared.transport;
  if (transport.partAOnly) {
    if (!transport.transporterId || transport.documentNumber || transport.vehicleNo) throw new Error("Part A needs the transporter ID and blank vehicle/document fields");
  } else if (transport.mode === "1" && !transport.vehicleNo) throw new Error("Enter the road vehicle number or choose Part A with a transporter ID");
  else if (transport.mode !== "1" && (!transport.documentNumber || !transport.documentDate)) throw new Error("Rail, air and ship movements need a transport document and date");
  if (from.pincode === to.pincode && (transport.distanceKm < 1 || transport.distanceKm > 100)) throw new Error("For matching PIN codes enter a distance from 1 to 100 km");
  return { from, to, transport };
}
function irpTransport(invoice, prepared, today) {
  if (invoice.type !== "Sales" || invoice.stockEffect !== "quantity" || !invoice.items.some(item=>item.kind === "goods")) throw new Error("Choose a sales invoice with physical goods");
  const { transport: t } = movement(invoice, prepared, today);
  if (t.transporterId && !/^\d{2}[0-9A-Z]{13}$/.test(t.transporterId)) throw new Error("Enter a valid transporter GSTIN or TRANSIN");
  if (t.transporterName && t.transporterName.length < 3) throw new Error("Enter at least three characters for the transporter name");
  const fields = { Distance: t.distanceKm };
  if (t.transporterId) fields.TransId = t.transporterId;
  if (t.transporterName) fields.TransName = t.transporterName;
  if (!t.partAOnly) {
    fields.TransMode = t.mode;
    if (t.mode === "1") { fields.VehNo = t.vehicleNo; fields.VehType = t.vehicleType; }
    if (t.documentNumber && t.documentDate) { fields.TransDocNo = t.documentNumber; fields.TransDocDt = officialDate(t.documentDate); }
  }
  return fields;
}
export function movementFile(invoice, preparation, mode, display, today = todayISO()) {
  if (mode === "standalone") return ewaybillDocument(invoice, preparation, today);
  const prepared = normalizePreparation(invoice, preparation);
  const transport = irpTransport(invoice, prepared, today);
  if (mode === "combined") return [{ ...irpDocument(invoice, preparation), EwbDtls: transport }];
  if (mode !== "by-irn" || !/^[0-9a-f]{64}$/.test(display?.irn)) throw new Error("Import the matching IRP acknowledgement for this invoice");
  const request = { Irn: display.irn, ...transport };
  const address = p => ({ Addr1: p.address1, ...(p.address2 ? {Addr2:p.address2}:{}), Loc:p.location, Pin:p.pincode, Stcd:p.stateCode });
  const checkExistingAddress = (signed, proposed) => {
    if (!signed) return false;
    if (Object.entries(proposed).some(([field, value]) => String(signed[field] ?? "") !== String(value))) throw new Error("Use the dispatch and shipping addresses recorded with this IRN");
    return true;
  };
  if (prepared.dispatch.enabled) {
    const dispatch = { Nm: prepared.dispatch.legalName, ...address(prepared.dispatch) };
    if (!checkExistingAddress(display.dispatch, dispatch)) request.DispDtls = dispatch;
  }
  if (prepared.ship.enabled) {
    const ship = address(prepared.ship);
    if (!checkExistingAddress(display.ship, ship)) {
      if (invoice.supplyCategory !== "export") throw new Error("A new ship-to address on an existing IRN is supported here for exports only");
      request.ExpShipDtls = ship;
    }
  }
  return request;
}
export function ewaybillDocument(invoice, preparation, today = todayISO()) {
  if (invoice.reverseCharge) throw new Error("Standalone reverse-charge e-way bill export is unavailable for this document");
  eligibleInvoice(invoice);
  if (invoice.type !== "Sales" || invoice.stockEffect !== "quantity" || invoice.items.some(item => item.kind !== "goods")) throw new Error("This e-way bill preparation needs a sales invoice carrying only physical goods. Returns use a separate movement document");
  if (invoice.items.length > 250) throw new Error("The NIC e-way bill payload supports up to 250 items");
  const prepared = normalizePreparation(invoice, preparation);
  const { from, to, transport } = movement(invoice, prepared, today);
  const total = invoice.totals;
  return {
    supplyType: "O", subSupplyType: invoice.supplyCategory === "export" ? "3" : "1", subSupplyDesc: "", docType: invoice.documentLabel === "Bill of Supply" ? "BIL" : "INV", docNo: invoice.number, docDate: officialDate(invoice.date),
    fromGstin: invoice.registration.gstin, fromTrdName: prepared.seller.legalName, fromAddr1: from.address1, fromAddr2: from.address2, fromPlace: from.location, fromPincode: from.pincode, actFromStateCode: Number(from.stateCode), fromStateCode: Number(invoice.registration.stateCode),
    toGstin: invoice.party.gstin || "URP", toTrdName: prepared.buyer.legalName, toAddr1: to.address1, toAddr2: to.address2, toPlace: to.location, toPincode: to.pincode, actToStateCode: Number(to.stateCode), toStateCode: invoice.party.stateCode === "96" ? 99 : Number(invoice.party.stateCode),
    transactionType: prepared.dispatch.enabled ? (prepared.ship.enabled ? 4 : 3) : prepared.ship.enabled ? 2 : 1,
    totalValue: rupees(total.taxablePaise), cgstValue: rupees(total.cgstPaise), sgstValue: rupees(total.sgstPaise + total.utgstPaise), igstValue: rupees(total.igstPaise), cessValue: rupees(total.cessPaise), cessNonAdvolValue: 0, otherValue: 0, totInvValue: rupees(total.totalPaise),
    transporterId: transport.transporterId, transporterName: transport.transporterName, transDocNo: transport.partAOnly ? "" : transport.documentNumber,
    transMode: transport.partAOnly ? "" : transport.mode, transDistance: String(transport.distanceKm), transDocDate: transport.partAOnly || !transport.documentDate ? "" : officialDate(transport.documentDate), vehicleNo: transport.partAOnly ? "" : transport.vehicleNo, vehicleType: transport.vehicleType,
    itemList: invoice.items.map(item => {
      const unit = item.unit.toUpperCase();
      if (!uqc.has(unit) || unit.length !== 3) throw new Error(`Choose an official three-letter UQC for ${item.name}`);
      const charged = item.supplyStatus === "taxable" || (item.supplyStatus === "zero-rated" && invoice.exportMode !== "lut");
      return { productName: string(item.name, "goods name", 100), productDesc: string(item.name, "goods description", 100), hsnCode: Number(item.hsnSac), quantity: quantityNumber(item.quantity, 2), qtyUnit: unit, cgstRate: charged && !invoice.interState ? item.gstRateBps / 200 : 0, sgstRate: charged && !invoice.interState ? item.gstRateBps / 200 : 0, igstRate: charged && invoice.interState ? item.gstRateBps / 100 : 0, cessRate: charged ? item.cessRateBps / 100 : 0, cessNonadvol: 0, taxableAmount: rupees(item.taxablePaise) };
    }),
  };
}
function decodeJws(token) {
  if (typeof token !== "string" || token.length > 750000) throw new Error("Choose a supported signed invoice token");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error("The signed invoice is not a compact JWS token");
  let header;
  let payload;
  try { header = JSON.parse(Buffer.from(parts[0], "base64url")); payload = JSON.parse(Buffer.from(parts[1], "base64url")); }
  catch { throw new Error("The signed invoice token is not valid JSON"); }
  if (header.alg !== "RS256") throw new Error("The signed invoice must use the official RS256 signature algorithm");
  let document = payload.data ?? payload;
  if (typeof document === "string") {
    try { document = JSON.parse(document); } catch { throw new Error("The signed invoice payload is not valid JSON"); }
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("The signed invoice has no document payload");
  return { document, signingInput: Buffer.from(`${parts[0]}.${parts[1]}`), signature: Buffer.from(parts[2], "base64url"), header };
}
function assessSignature(decoded, invoice, now) {
  for (const registry of IRP_SIGNING_REGISTRY) {
    const matches = verify("RSA-SHA256", decoded.signingInput, registry.certificate.publicKey, decoded.signature);
    if (!matches) continue;
    const from = Date.parse(registry.validFrom);
    const to = Date.parse(registry.validTo);
    const dated = Date.parse(`${invoice.date}T12:00:00+05:30`);
    const certificateValidNow = now >= from && now <= to;
    const certificateValidAtDocumentDate = dated >= from && dated <= to;
    return { status: certificateValidNow && certificateValidAtDocumentDate ? "signature-verified" : "historical-signature-match", signatureMatches: true, certificateValidNow, certificateValidAtDocumentDate, keyId: registry.id, fingerprint256: registry.fingerprint256, source: registry.source };
  }
  return { status: "reported", signatureMatches: false, certificateValidNow: false, certificateValidAtDocumentDate: false, keyId: null, fingerprint256: null, source: null };
}
function unwrapResult(input) {
  let result = input;
  if (Array.isArray(result)) {
    if (result.length !== 1) throw new Error("Import one acknowledgement at a time");
    result = result[0];
  }
  if (!result || typeof result !== "object") throw new Error("Choose an acknowledgement JSON object");
  if (result.Data && typeof result.Data === "string") {
    try { result = JSON.parse(result.Data); }
    catch { throw new Error("Use the decrypted IRP result downloaded from your authorised tax system"); }
  } else if (result.Data && typeof result.Data === "object") result = result.Data;
  else if (result.data && typeof result.data === "object") result = result.data;
  return result;
}
function bindIrp(invoice, document) {
  if (document.SellerDtls?.Gstin !== invoice.registration.gstin || document.BuyerDtls?.Gstin !== (invoice.party.gstin || "URP") || document.DocDtls?.No?.toUpperCase() !== invoice.number || document.DocDtls?.Typ?.toUpperCase() !== documentType(invoice) || isoDate(document.DocDtls?.Dt) !== invoice.date) throw new Error("The signed invoice identifiers do not match this Ledgercraft invoice");
  if (String(document.BuyerDtls.Pos).padStart(2, "0") !== invoice.placeOfSupply || document.TranDtls?.SupTyp !== supplyType(invoice)) throw new Error("The signed invoice supply type or place of supply does not match");
  if ((document.TranDtls?.RegRev ?? "N") !== (invoice.reverseCharge ? "Y" : "N")) throw new Error("The signed invoice reverse-charge flag does not match");
  const values = { AssVal: invoice.totals.taxablePaise, CgstVal: invoice.totals.cgstPaise, SgstVal: invoice.totals.sgstPaise + invoice.totals.utgstPaise, IgstVal: invoice.totals.igstPaise, CesVal: invoice.totals.cessPaise, TotInvVal: invoice.totals.totalPaise };
  for (const [field, amount] of Object.entries(values)) if (paise(document.ValDtls?.[field] ?? 0) !== amount) throw new Error(`The signed invoice amount ${field} does not match`);
  if (!Array.isArray(document.ItemList) || document.ItemList.length !== invoice.items.length) throw new Error("The signed invoice line count does not match");
  for (let index = 0; index < invoice.items.length; index += 1) {
    const expected = invoice.items[index];
    const received = document.ItemList[index];
    if (received.HsnCd !== expected.hsnSac || received.IsServc !== (expected.kind === "service" ? "Y" : "N") || quantityMicros(String(received.Qty)) !== quantityMicros(expected.quantity) || paise(received.AssAmt) !== expected.taxablePaise || paise(received.TotItemVal) !== expected.totalPaise || received.GstRt !== expected.gstRateBps / 100) throw new Error("The signed invoice item identity or amount does not match");
    const itemAmounts = { CgstAmt: expected.cgstPaise, SgstAmt: expected.sgstPaise + expected.utgstPaise, IgstAmt: expected.igstPaise, CesAmt: expected.cessPaise };
    for (const [field, amount] of Object.entries(itemAmounts)) if (paise(received[field] ?? 0) !== amount) throw new Error("The signed invoice item tax does not match");
  }
}
function bindQr(invoice, document, irn, acknowledgementDate) {
  const greatest = Math.max(...invoice.items.map(item => item.taxablePaise));
  const mainCodes = new Set(invoice.items.filter(item => item.taxablePaise === greatest).map(item => item.hsnSac));
  if (document.SellerGstin !== invoice.registration.gstin || document.BuyerGstin !== (invoice.party.gstin || "URP") || document.DocNo?.toUpperCase() !== invoice.number || document.DocTyp?.toUpperCase() !== documentType(invoice) || isoDate(document.DocDt) !== invoice.date) throw new Error("The signed QR identifiers do not match this invoice");
  if (paise(document.TotInvVal) !== invoice.totals.totalPaise || document.ItemCnt !== invoice.items.length || !mainCodes.has(String(document.MainHsnCode)) || document.Irn?.toLowerCase() !== irn) throw new Error("The signed QR value, item count, main HSN or IRN does not match");
  if (document.IrnDt) {
    const generated = String(document.IrnDt).slice(0, 10);
    if (isoDate(generated) !== acknowledgementDate.slice(0, 10)) throw new Error("The signed QR IRN date does not match the acknowledgement date");
  }
  return {
    sellerGstin: document.SellerGstin, buyerGstin: document.BuyerGstin, documentNumber: document.DocNo,
    documentType: document.DocTyp, documentDate: isoDate(document.DocDt), totalPaise: paise(document.TotInvVal),
    itemCount: document.ItemCnt, mainHsnCode: String(document.MainHsnCode), irn, irnDate: document.IrnDt || null,
  };
}

function bindEwaybill(invoice, document) {
  if (invoice.reverseCharge) throw new Error("Standalone reverse-charge e-way bill matching is unavailable for this document");
  if (document.fromGstin !== invoice.registration.gstin || document.toGstin !== (invoice.party.gstin || "URP") || document.docNo?.toUpperCase() !== invoice.number || isoDate(document.docDate) !== invoice.date || document.docType !== (invoice.documentLabel === "Bill of Supply" ? "BIL" : "INV")) throw new Error("The e-way bill document identifiers do not match this invoice");
  const values = { totalValue: invoice.totals.taxablePaise, cgstValue: invoice.totals.cgstPaise, sgstValue: invoice.totals.sgstPaise + invoice.totals.utgstPaise, igstValue: invoice.totals.igstPaise, cessValue: invoice.totals.cessPaise, totInvValue: invoice.totals.totalPaise };
  for (const [field, amount] of Object.entries(values)) if (paise(document[field]) !== amount) throw new Error(`The e-way bill amount ${field} does not match`);
}
export function acknowledgementRecord(invoice, input, now = Date.now(), prior = []) {
  eligibleInvoice(invoice);
  if (!input || !["irp", "ewaybill"].includes(input.kind)) throw new Error("Choose IRP or e-way bill acknowledgement");
  if (JSON.stringify(input).length > 900000) throw new Error("The acknowledgement exceeds the supported file size");
  const result = unwrapResult(input.result);
  const raw = structuredClone(input.result);
  const record = { id: `ack-${randomUUID()}`, kind: input.kind, importedAt: new Date(now).toISOString(), invoiceFingerprint: invoiceFingerprint(invoice), raw, submittedRequest: input.submittedRequest ? structuredClone(input.submittedRequest) : null };
  if (input.kind === "irp") {
    if (result.Status !== "ACT") throw new Error("Import an active IRP acknowledgement with its signed invoice");
    const irn = string(result.Irn, "IRN", 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(irn)) throw new Error("The imported IRN must contain sixty-four hexadecimal characters");
    const decoded = decodeJws(result.SignedInvoice);
    bindIrp(invoice, decoded.document);
    if (decoded.document.Irn?.toLowerCase() !== irn) throw new Error("The signed invoice IRN does not match the acknowledgement");
    const ackNo = string(result.AckNo, "IRP acknowledgement number", 20);
    if (!/^\d{1,20}$/.test(ackNo) || (typeof result.AckNo === "number" && !Number.isSafeInteger(result.AckNo))) throw new Error("The IRP acknowledgement number is invalid");
    const ackDate = string(result.AckDt, "IRP acknowledgement date", 40);
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(ackDate)) throw new Error("The IRP acknowledgement date is invalid");
    if ((decoded.document.AckNo !== undefined && String(decoded.document.AckNo) !== ackNo) || (decoded.document.AckDt !== undefined && decoded.document.AckDt !== ackDate)) throw new Error("The signed acknowledgement fields do not match their outer result");
    record.reference = irn;
    record.acknowledgementNumber = ackNo;
    record.acknowledgementDate = ackDate;
    record.signature = assessSignature(decoded, invoice, now);
    if (!result.SignedQRCode) throw new Error("Import the complete IRP result containing SignedInvoice and SignedQRCode");
    const signedQr = decodeJws(result.SignedQRCode);
    const qrPayload = bindQr(invoice, signedQr.document, irn, ackDate);
    record.qr = { token: result.SignedQRCode, payload: qrPayload, signature: assessSignature(signedQr, invoice, now), binding: "qr-payload-identifiers-and-value" };
    record.trust = record.signature.status === "signature-verified" && record.qr.signature.status === "signature-verified" ? "signature-verified" : "reported";
    record.binding = "signed-invoice-payload";
  } else {
    if (result.status !== undefined && !["ACT", "1"].includes(String(result.status).trim().toUpperCase())) throw new Error("Choose an active or successful e-way bill result");
    const details = result.docNo || result.Irn ? result : input.submittedRequest;
    if (!details) throw new Error("The e-way bill result needs its full document details or the exact submitted request for invoice binding");
    const byIrn = typeof details.Irn === "string";
    if (byIrn) {
      if (!prior.some(r=>r.kind === "irp" && r.reference === details.Irn && r.invoiceFingerprint === invoiceFingerprint(invoice))) throw new Error("The submitted e-way bill IRN does not match an imported acknowledgement for this invoice");
      if (result.Irn && result.Irn !== details.Irn) throw new Error("The e-way bill response identifies another IRN");
    } else bindEwaybill(invoice, details);
    const number = string(result.ewbNo || result.ewayBillNo || result.EwbNo, "e-way bill number", 12);
    if (!/^\d{12}$/.test(number)) throw new Error("The imported e-way bill number must contain twelve digits");
    record.reference = number;
    record.acknowledgementNumber = number;
    record.acknowledgementDate = string(result.ewayBillDate || result.EwbDt, "e-way bill date", 40);
    record.validUpto = string(result.validUpto || result.EwbValidTill, "e-way bill validity", 40, false);
    record.trust = "reported";
    record.signature = { status: "reported", signatureMatches: false };
    record.binding = byIrn ? "reported-result-linked-to-imported-irn" : result.docNo ? "reported-document-details" : "submitted-request-with-reported-result";
  }
  record.rawSHA256 = createHash("sha256").update(JSON.stringify({ raw: record.raw, submittedRequest: record.submittedRequest })).digest("hex");
  return record;
}
export function assertExchangeSnapshot(invoice, value) {
  if (!value || value.version !== 1 || !Array.isArray(value.preparations) || !Array.isArray(value.acknowledgements) || value.preparations.length > 100 || value.acknowledgements.length > 100) throw new Error("Invalid invoice exchange history");
  const restored = { version: 1, preparations: [], acknowledgements: [] };
  for (const preparation of value.preparations) {
    if (preparation.invoiceFingerprint !== invoiceFingerprint(invoice) || !/^[a-z0-9-]{1,60}$/.test(preparation.id) || !isIsoDate(preparation.savedAt?.slice(0, 10))) throw new Error("Invalid preparation identity or invoice linkage");
    const fields = normalizePreparation(invoice, preparation.fields);
    if (!isDeepStrictEqual(fields, preparation.fields)) throw new Error("The saved preparation fields are invalid");
    restored.preparations.push(structuredClone(preparation));
  }
  const references = new Set();
  for (const record of value.acknowledgements) {
    if (!isIsoDate(record.importedAt?.slice(0, 10)) || record.invoiceFingerprint !== invoiceFingerprint(invoice)) throw new Error("Invalid acknowledgement identity or invoice linkage");
    const checked = acknowledgementRecord(invoice, { kind: record.kind, result: record.raw, submittedRequest: record.submittedRequest }, Date.now(), restored.acknowledgements);
    if (checked.reference !== record.reference || checked.rawSHA256 !== record.rawSHA256 || references.has(`${checked.kind}:${checked.reference}`)) throw new Error("Duplicate or altered acknowledgement record");
    references.add(`${checked.kind}:${checked.reference}`);
    restored.acknowledgements.push({ ...checked, id: record.id, importedAt: record.importedAt });
  }
  return restored;
}
export function exchangeDisplay(invoice, history) {
  const record = history.acknowledgements.filter(item => item.kind === "irp").at(-1);
  if (!record) return null;
  const signed = decodeJws(unwrapResult(record.raw).SignedInvoice).document;
  return {
    dispatch: signed.DispDtls || null, ship: signed.ShipDtls || null,
    irn: record.reference, acknowledgementNumber: record.acknowledgementNumber, acknowledgementDate: record.acknowledgementDate,
    signedQRCode: record.qr?.token || null, qrPayload: record.qr?.payload || null,
    invoiceSignature: record.signature, qrSignature: record.qr?.signature || { status: "missing", signatureMatches: false },
    trust: record.trust, invoiceFingerprint: invoiceFingerprint(invoice),
  };
}
export function exchangeView(invoice, value, company) {
  const history = value ? assertExchangeSnapshot(invoice, value) : { version: 1, preparations: [], acknowledgements: [] };
  const preparation = history.preparations.at(-1)?.fields || exchangeDefaults(invoice);
  const display = exchangeDisplay(invoice, history);
  const policy = company && invoiceIrpStatus(company,invoice,display);
  const movementMode = display ? "by-irn" : policy?.required ? "combined" : "standalone";
  const capabilities = {};
  for (const [kind, build] of [["irp", () => irpBulk(invoice,preparation)], ["ewaybill", () => movementFile(invoice,preparation,movementMode,display)]]) {
    try {
      if (kind === "ewaybill" && history.acknowledgements.some(r=>r.kind==="ewaybill" || r.kind==="irp" && unwrapResult(r.raw).EwbNo)) throw new Error("An e-way bill is already recorded for this invoice");
      if (policy?.overdue && (kind === "irp" || movementMode === "combined")) throw new Error("The recorded IRP reporting window has closed for this document");
      build(); capabilities[kind] = { ready: true, reason: "" };
    } catch (error) { capabilities[kind] = { ready: false, reason: error.message }; }
  }
  return { invoice, history, preparation, capabilities, movementMode, display, sources: GST_EXCHANGE_SOURCES,
    signingRegistry: IRP_SIGNING_REGISTRY.map(({ certificate, ...record }) => record), states: GST_STATES,
  };
}
