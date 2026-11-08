import { attribute, findNodes, value } from "./tally-format.js";
import { tallyXlsxRows } from "./tally-xlsx.js";

const first = (node, names) => names.map((name) => value(node, name)).find(Boolean) || "";
const values = (node, names) => [...new Set(names.flatMap((name) => findNodes(node, name).map((entry) => entry.text.trim())).filter(Boolean))];
const summaryFields = (node, names) => Object.fromEntries(names.map((name) => [name, value(node, name)]).filter(([, entry]) => entry));
const lists = (node, tags, fields) => [...new Set(tags.flatMap((tag) => findNodes(node, tag)))].map((entry) => summaryFields(entry, fields));

export function tallyRecordSummary(record) {
  const node = record.node;
  const name = attribute(node, "NAME") || value(node, "NAME") || value(node, "VOUCHERNUMBER") || value(node, "GUID") || record.recordId;
  return {
    recordId: record.recordId, type: record.type, name,
    date: value(node, "DATE"), parent: value(node, "PARENT"),
    sourceType: value(node, "VOUCHERTYPENAME") || attribute(node, "VCHTYPE"), voucherType: record.targetType || "",
    status: record.disposition, reason: record.reason || "", voucherId: record.voucherId || "",
    hsn: values(node, ["HSNCODE", "GSTHSNCODE"]).join(", "),
    gstin: first(node, ["PARTYGSTIN", "GSTREGISTRATIONNUMBER"]) || values(node, ["GSTIN"])[0] || "",
    file: record.file,
  };
}

export function tallyRecordView(record) {
  const node = record.node;
  const spreadsheet = tallyXlsxRows(node);
  return {
    ...tallyRecordSummary(record),
    ...(spreadsheet.length ? { spreadsheet } : {}),
    fields: summaryFields(node, ["NAME", "PARENT", "VOUCHERTYPENAME", "VOUCHERNUMBER", "DATE", "EFFECTIVEDATE", "NARRATION", "PARTYLEDGERNAME", "PARTYGSTIN", "GSTREGISTRATIONNUMBER", "GSTIN", "COMPANYGSTIN", "PLACEOFSUPPLY", "GSTREGISTRATIONTYPE", "PARTYMAILINGNAME", "PARTYSTATENAME", "COUNTRYNAME", "LEDSTATENAME", "STATENAME", "PINCODE", "EMAIL", "LEDGERPHONE", "LEDGERMOBILE", "INCOMETAXNUMBER", "OPENINGBALANCE", "OPENINGVALUE", "OPENINGRATE", "BASEUNITS", "ADDITIONALUNITS", "CONVERSION", "ISSIMPLEUNIT", "DECIMALPLACES", "CATEGORY", "GUID", "MASTERID", "ALTERID", "REFERENCE", "REFERENCEDATE", "ISCANCELLED", "ISOPTIONAL", "ISPOSTDATED"]),
    address: values(node, ["ADDRESS", "BASICBUYERADDRESS", "BASICSHIPDELIVERYNOTES"]),
    hsn: values(node, ["HSNCODE", "GSTHSNCODE"]),
    inventory: lists(node, ["ALLINVENTORYENTRIES", "INVENTORYENTRIES", "INVENTORYALLOCATIONS"], ["STOCKITEMNAME", "ACTUALQTY", "BILLEDQTY", "RATE", "AMOUNT", "ISDEEMEDPOSITIVE"]),
    batches: lists(node, ["BATCHALLOCATIONS"], ["GODOWNNAME", "DESTINATIONGODOWNNAME", "BATCHNAME", "ORDERNO", "TRACKINGNUMBER", "ACTUALQTY", "BILLEDQTY", "RATE", "AMOUNT"]),
    accounting: lists(node, ["ALLLEDGERENTRIES", "LEDGERENTRIES", "ACCOUNTINGALLOCATIONS"], ["LEDGERNAME", "ISDEEMEDPOSITIVE", "AMOUNT", "GSTCLASS", "GSTNATURE", "NARRATION"]),
    bills: lists(node, ["BILLALLOCATIONS"], ["NAME", "BILLTYPE", "BILLDATE", "AMOUNT", "OPENINGBALANCE", "BILLCREDITPERIOD", "DUEDATE", "ISADVANCE"]),
    banks: lists(node, ["BANKALLOCATIONS"], ["NAME", "BANKNAME", "TRANSACTIONTYPE", "PAYMENTFAVOURING", "INSTRUMENTNUMBER", "INSTRUMENTDATE", "BANKPARTYNAME", "AMOUNT", "UNIQUEREFERENCENUMBER", "BANKACCOUNTNUMBER", "IFSCODE"]),
    costs: lists(node, ["CATEGORYALLOCATIONS", "COSTCENTREALLOCATIONS"], ["CATEGORY", "NAME", "AMOUNT", "ISDEEMEDPOSITIVE"]),
    taxes: lists(node, ["GSTDETAILS", "GSTREGDETAILS", "CMPGSTDETAILS", "LEDGERGSTREGDETAILS", "GSTCLASSIFICATIONDETAILS", "HSNDETAILS", "STATEWISEDETAILS", "RATEDETAILS"], ["APPLICABLEFROM", "HSNCODE", "HSN", "TAXABILITY", "GSTREGISTRATIONNUMBER", "GSTIN", "PLACEOFSUPPLY", "GSTRATEDUTYHEAD", "GSTRATE", "GSTRATEINFERAPPLICABILITY", "RATE"]),
    ...(spreadsheet.length ? { transport: summaryFields(node, ["EWAYBILLNUMBER", "EWAYBILLDATE", "IRNACKNO", "IRNACKDATE", "IRN", "TRANSPORTERNAME", "TRANSPORTERID", "TRANSPORTMODE", "VEHICLENUMBER", "TRANSPORTDOCNO", "TRANSPORTDOCDATE", "PORTCODE", "SHIPPINGBILLNO", "SHIPPINGBILLDATE"]) } : {}),
    original: node,
  };
}
