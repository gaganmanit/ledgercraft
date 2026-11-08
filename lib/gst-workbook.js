import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isIsoDate } from "./money.js";

const execute = promisify(execFile);
const resources = fileURLToPath(new URL("./resources/", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(resources, "gstr1-template.json"), "utf8"));
const csvColumns = JSON.parse(await readFile(path.join(resources, "gstr1-columns.json"), "utf8"));
const dateStyle = "24";
const decimalHeaders = new Set([
  "Invoice Value", "Taxable Value", "Cess Amount", "Note Value", "Total Value", "Integrated Tax Amount",
  "Central Tax Amount", "State/UT Tax Amount", "Nil Rated Supplies", "Exempted(other than nil rated/non GST supply)",
  "Non-GST Supplies", "Rate", "Applicable % of Tax Rate", "Total Quantity", "Total Number", "Cancelled",
]);
let pending = Promise.resolve();
let verifiedTemplate;

function xml(value) {
  const text = String(value ?? "");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error("A workbook cell contains an unsupported control character");
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function normalizedHeader(value) {
  return value.replace(/\s+/g, "").toLowerCase();
}
function columnNumber(value) {
  let number = 0;
  for (const character of value) number = number * 26 + character.charCodeAt(0) - 64;
  return number;
}
function numeric(value) {
  const text = String(value);
  if (!/^-?\d+(\.\d{1,6})?$/.test(text)) throw new Error("A numeric workbook field needs an exact decimal value");
  const significant = text.replace(/[-.]/g, "").replace(/^0+/, "").replace(/0+$/, "").length;
  if (significant > 15 || !Number.isFinite(Number(text))) throw new Error("This workbook value exceeds Excel's fifteen significant digits");
  return text;
}
function money(value) {
  const text = String(value ?? "0");
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) throw new Error("A return amount needs exact INR paise");
  const sign = text.startsWith("-") ? -1n : 1n;
  const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
  return sign * (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")));
}
function moneyText(amount) {
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
function excelDate(value) {
  const text = String(value);
  let iso = text;
  const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(text);
  if (match) iso = `${match[3].length === 2 ? "20" : ""}${match[3]}-${months[match[2].toLowerCase()] || "00"}-${match[1].padStart(2, "0")}`;
  if (!isIsoDate(iso)) throw new Error(`Invalid workbook date ${text}`);
  return String((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);
}
function cell(reference, value, style = "0", header = "") {
  if (value === "" || value === null || value === undefined) return `<c r="${reference}" s="${style}"/>`;
  if (/\bdate$/i.test(header)) return `<c r="${reference}" s="${dateStyle}"><v>${excelDate(value)}</v></c>`;
  if (decimalHeaders.has(header)) return `<c r="${reference}" s="${style}"><v>${numeric(value)}</v></c>`;
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}
function formulaCell(reference, formula, cached, style) {
  return `<c r="${reference}" s="${style}"><f>${xml(formula)}</f><v>${numeric(cached)}</v></c>`;
}
function dataRows(sheet, sourceRows) {
  const sourceHeaders = csvColumns[sheet.name];
  if (!sourceHeaders && sourceRows.length) throw new Error(`The return section ${sheet.name} is not supported by this workbook`);
  const indexes = new Map((sourceHeaders || []).map((header, index) => [normalizedHeader(header), index]));
  const mapping = sheet.headers.map(header => ({ ...header, index: indexes.get(normalizedHeader(header.label)) }));
  if (sourceRows.length && mapping.some(header => header.index === undefined)) throw new Error(`The official headers for ${sheet.name} do not match this return section`);
  if (sourceRows.length > 1048572) throw new Error("A return section exceeds Excel's row limit");
  const attributes = Object.entries(sheet.dataRowAttributes).map(([key, value]) => ` ${key}="${xml(value)}"`).join("");
  return sourceRows.map((row, index) => {
    if (!Array.isArray(row) || row.length !== sourceHeaders.length) throw new Error(`A ${sheet.name} row has an unexpected column count`);
    const number = index + 5;
    return `<row r="${number}" spans="1:${sheet.headers.length}"${attributes}>${mapping.map(header => cell(`${header.column}${number}`, row[header.index], sheet.dataStyles[header.column] || "18", header.label)).join("")}</row>`;
  }).join("");
}
function summary(sheet, rows) {
  const headers = csvColumns[sheet.name] || [];
  const indexes = new Map(headers.map((header, index) => [normalizedHeader(header), index]));
  const excelColumns = new Map(sheet.headers.map(header => [normalizedHeader(header.label), header.column]));
  const end = rows.length + 4;
  const range = header => {
    const column = excelColumns.get(normalizedHeader(header));
    if (!column) throw new Error(`Missing official column ${header} in ${sheet.name}`);
    return `${column}5:${column}${end}`;
  };
  const values = header => rows.map(row => row[indexes.get(normalizedHeader(header))]);
  const cells = [];
  const add = (column, label, formula, cached, amount = false) => cells.push({ column, label, formula: rows.length ? formula : "0", cached: rows.length ? cached : amount ? "0.00" : "0", style: sheet.summaryStyles[column] || (amount ? "61" : "59") });
  const sum = (column, label, header) => {
    const total = values(header).reduce((total, value) => total + money(value), 0n);
    add(column, label, rows.length ? `SUM(${range(header)})` : "0", moneyText(total), true);
  };
  const keyHeaders = header => Array.isArray(header) ? header : [header];
  const keysFor = header => rows.map(row => {
    const parts = keyHeaders(header).map(name => row[indexes.get(normalizedHeader(name))]);
    if (parts.some(value => value === "" || value === null || value === undefined)) return null;
    const literal = parts.map((value, index) => /\bdate$/i.test(keyHeaders(header)[index]) ? excelDate(value) : String(value).toUpperCase());
    return JSON.stringify(literal);
  });
  // Composite original identities distinguish invoices reused across years. Prefix
  // and escape MATCH lookup text so leading zeros and wildcard characters stay literal.
  const firstOccurrences = header => {
    const sources = keyHeaders(header).map(range);
    const identifier = sources.length === 1 ? `"id:"&${sources[0]}` : `"id:"&${sources.map(source => `LEN(${source})&":"&${source}`).join('&"|"&')}`;
    const literal = `SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(${identifier},"~","~~"),"*","~*"),"?","~?")`;
    return `--(MATCH(${literal},${identifier},0)=ROW(${sources[0]})-ROW(${sources[0].split(":")[0]})+1)`;
  };
  const count = (column, label, header) => {
    const distinct = new Set(keysFor(header).filter(key => key !== null));
    const present = keyHeaders(header).map(name => `(${range(name)}<>"")`).join("*");
    add(column, label, rows.length ? `SUMPRODUCT(${present}*${firstOccurrences(header)})` : "0", String(distinct.size));
  };
  const distinctValue = (column, label, documentHeader, valueHeader) => {
    const keys = keysFor(documentHeader);
    const amounts = values(valueHeader);
    const unique = new Map();
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key === null && Array.isArray(documentHeader)) throw new Error("An amended return document needs its complete original identity");
      const value = money(amounts[index]);
      if (unique.has(key) && unique.get(key) !== value) throw new Error("Repeated return document rows have different document values");
      unique.set(key, value);
    }
    const total = [...unique.values()].reduce((sum, value) => sum + value, 0n);
    add(column, label, rows.length ? `SUMPRODUCT(${range(valueHeader)}*${firstOccurrences(documentHeader)})` : "0", moneyText(total), true);
  };
  if (sheet.name === "b2b,sez,de") {
    count("A", "No. of Recipients", "GSTIN/UIN of Recipient"); count("C", "No. of Invoices", "Invoice Number");
    distinctValue("E", "Total Invoice Value", "Invoice Number", "Invoice Value"); sum("L", "Total Taxable Value", "Taxable Value"); sum("M", "Total Cess", "Cess Amount");
  } else if (sheet.name === "b2ba") {
    const identity = ["GSTIN/UIN of Recipient", "Original Invoice Number", "Original Invoice date"];
    count("A", "No. of Recipients", "GSTIN/UIN of Recipient"); count("C", "No. of Invoices", identity);
    distinctValue("G", "Total Invoice Value", identity, "Invoice Value"); sum("N", "Total Taxable Value", "Taxable Value"); sum("O", "Total Cess", "Cess Amount");
  } else if (sheet.name === "b2cl") {
    count("A", "No. of Invoices", "Invoice Number"); distinctValue("C", "Total Invoice Value", "Invoice Number", "Invoice Value");
    sum("G", "Total Taxable Value", "Taxable Value"); sum("H", "Total Cess", "Cess Amount");
  } else if (sheet.name === "b2cla") {
    const identity = ["Original Invoice Number", "Original Invoice date", "Original Place Of Supply"];
    count("A", "No. of Invoices", identity); distinctValue("F", "Total Invoice Value", identity, "Invoice Value");
    sum("I", "Total Taxable Value", "Taxable Value"); sum("J", "Total Cess", "Cess Amount");
  } else if (sheet.name === "b2cs") {
    sum("E", "Total Taxable Value", "Taxable Value"); sum("F", "Total Cess", "Cess Amount");
  } else if (sheet.name === "cdnr") {
    count("A", "No. of Recipients", "GSTIN/UIN of Recipient"); count("C", "No. of Notes", "Note Number");
    distinctValue("I", "Total Note Value", "Note Number", "Note Value"); sum("L", "Total Taxable Value", "Taxable Value"); sum("M", "Total Cess", "Cess Amount");
  } else if (sheet.name === "cdnra") {
    const identity = ["GSTIN/UIN of Recipient", "Original Note Number", "Original Note Date"];
    count("A", "No. of Recipients", "GSTIN/UIN of Recipient"); count("C", "No. of Notes", identity);
    distinctValue("K", "Total Note Value", identity, "Note Value"); sum("N", "Total Taxable Value", "Taxable Value"); sum("O", "Total Cess", "Cess Amount");
  } else if (sheet.name === "cdnur") {
    count("B", "No. of Notes", "Note Number"); distinctValue("F", "Total Note Value", "Note Number", "Note Value");
    sum("I", "Total Taxable Value", "Taxable Value"); sum("J", "Total Cess", "Cess Amount");
  } else if (sheet.name === "cdnura") {
    const identity = ["UR Type", "Original Note Number", "Original Note Date"];
    count("B", "No. of Notes", identity); distinctValue("H", "Total Note Value", identity, "Note Value");
    sum("K", "Total Taxable Value", "Taxable Value"); sum("L", "Total Cess", "Cess Amount");
  } else if (sheet.name === "exp") {
    count("B", "No. of Invoices", "Invoice Number"); distinctValue("D", "Total Invoice Value", "Invoice Number", "Invoice Value"); count("F", "No. of Shipping Bills", "Shipping Bill Number");
    sum("I", "Total Taxable Value", "Taxable Value"); sum("J", "Total Cess", "Cess Amount");
  } else if (sheet.name === "expa") {
    const identity = ["Export Type", "Original Invoice Number", "Original Invoice date"];
    count("B", "No. of Invoices", identity); distinctValue("F", "Total Invoice Value", identity, "Invoice Value"); count("H", "No. of Shipping Bills", "Shipping Bill Number");
    sum("K", "Total Taxable Value", "Taxable Value"); sum("L", "Total Cess", "Cess Amount");
  } else if (sheet.name === "exemp") {
    sum("B", "Total Nil Rated Supplies", "Nil Rated Supplies"); sum("C", "Total Exempted Supplies", "Exempted(other than nil rated/non GST supply)"); sum("D", "Total Non-GST Supplies", "Non-GST Supplies");
  } else if (sheet.name.startsWith("hsn(")) {
    count("A", "No. of HSN", "HSN"); sum("E", "Total Value", "Total Value"); sum("G", "Total Taxable Value", "Taxable Value");
    sum("H", "Total Integrated Tax", "Integrated Tax Amount"); sum("I", "Total Central Tax", "Central Tax Amount"); sum("J", "Total State/UT Tax", "State/UT Tax Amount"); sum("K", "Total Cess", "Cess Amount");
  } else if (sheet.name === "docs") {
    sum("D", "Total Number", "Total Number"); sum("E", "Total Cancelled", "Cancelled");
  }
  return cells;
}
function rowsUnderFive(source) {
  return [...source.matchAll(/<row\b[^>]*\br="([1-4])"[^>]*>[\s\S]*?<\/row>/g)].map(match => match[0]);
}
function updateSheet(source, sheet, sourceRows) {
  const headerRows = rowsUnderFive(source);
  const summaries = summary(sheet, sourceRows);
  const row2 = headerRows.findIndex(row => /\br="2"/.test(row));
  const row3 = headerRows.findIndex(row => /\br="3"/.test(row));
  if (summaries.length) {
    const ordered = summaries.sort((a, b) => columnNumber(a.column) - columnNumber(b.column));
    headerRows[row2] = `<row r="2">${ordered.map(value => cell(`${value.column}2`, value.label, "80")).join("")}</row>`;
    headerRows[row3] = `<row r="3">${ordered.map(value => formulaCell(`${value.column}3`, value.formula, value.cached, value.style)).join("")}</row>`;
  } else if (row3 >= 0) {
    headerRows[row3] = `<row r="3">${Object.entries(sheet.summaryStyles).map(([column, style]) => formulaCell(`${column}3`, "0", "0", style)).join("")}</row>`;
  }
  const data = dataRows(sheet, sourceRows);
  const lastColumn = sheet.headers.at(-1)?.column || "A";
  const lastRow = Math.max(4, sourceRows.length + 4);
  return source.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${headerRows.join("")}${data}</sheetData>`)
    .replace(/<dimension\b[^>]*\/>/, `<dimension ref="A1:${lastColumn}${lastRow}"/>`)
    .replace(/<autoFilter\b([^>]*?)ref="[^"]*"([^>]*?)\/>/, `<autoFilter$1ref="A4:${lastColumn}${lastRow}"$2/>`);
}
async function filesUnder(folder) {
  const result = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(file));
    else result.push(file);
  }
  return result;
}
async function removeExternalLinks(folder) {
  const files = await filesUnder(folder);
  for (const file of files.filter(file => file.endsWith(".rels"))) {
    const source = await readFile(file, "utf8");
    const removed = [];
    const cleaned = source.replace(/<Relationship\b[^>]*\/>/g, relationship => {
      if (/TargetMode="External"|Type="[^"]*\/(?:externalLink|calcChain|connections)"/.test(relationship)) {
        const id = /\bId="([^"]+)"/.exec(relationship)?.[1];
        if (id) removed.push(id);
        return "";
      }
      return relationship;
    });
    await writeFile(file, cleaned);
    if (removed.length && path.basename(path.dirname(file)) === "_rels") {
      const target = path.join(path.dirname(path.dirname(file)), path.basename(file).replace(/\.rels$/, ""));
      if (files.includes(target)) {
        let content = await readFile(target, "utf8");
        for (const id of removed) content = content.replace(new RegExp(`<hyperlink\\b[^>]*r:id="${id}"[^>]*/>`, "g"), "");
        await writeFile(target, content);
      }
    }
  }
  const workbookPath = path.join(folder, "xl/workbook.xml");
  let workbook = await readFile(workbookPath, "utf8");
  workbook = workbook.replace(/<externalReferences>[\s\S]*?<\/externalReferences>/g, "")
    .replace(/<definedName\b[^>]*>[\s\S]*?<\/definedName>/g, element => element.replace(/\[\d+\](?=master!)/g, ""))
    .replace(/<calcPr\b[^>]*\/>/, '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>');
  await writeFile(workbookPath, workbook);
  const contentPath = path.join(folder, "[Content_Types].xml");
  const content = await readFile(contentPath, "utf8");
  await writeFile(contentPath, content.replace(/<Override\b[^>]*PartName="\/xl\/(?:externalLinks\/[^\"]*|calcChain\.xml|connections\.xml)"[^>]*\/>/g, ""));
  await rm(path.join(folder, "xl/externalLinks"), { recursive: true, force: true });
  await rm(path.join(folder, "xl/calcChain.xml"), { force: true });
  await rm(path.join(folder, "xl/connections.xml"), { force: true });
}
async function buildWorkbook(report) {
  if (!report || !/^\d{4}-(0[1-9]|1[0-2])$/.test(report.month) || typeof report.registration?.gstin !== "string" || !report.sheets || typeof report.sheets !== "object") throw new Error("Choose a GST registration and return month");
  const template = path.join(resources, manifest.source.filename);
  verifiedTemplate ||= readFile(template).then(data => {
    if (createHash("sha256").update(data).digest("hex") !== manifest.source.sha256) throw new Error("The official GSTR-1 template fingerprint changed");
  });
  await verifiedTemplate;
  for (const [name, rows] of Object.entries(report.sheets)) if (!Array.isArray(rows) || (rows.length && !manifest.sheets.some(sheet => sheet.name === name))) throw new Error("The report has an unsupported worksheet");
  const scratch = await mkdtemp(path.join(tmpdir(), "financer-gstr1-workbook-"));
  const folder = path.join(scratch, "workbook");
  const output = path.join(scratch, "return.xlsx");
  try {
    await mkdir(folder);
    await execute("/usr/bin/unzip", ["-q", template, "-d", folder], { timeout: 60000 });
    for (const sheet of manifest.sheets) {
      if (["Help Instruction", "master"].includes(sheet.name)) continue;
      const file = path.join(folder, sheet.path);
      await writeFile(file, updateSheet(await readFile(file, "utf8"), sheet, report.sheets[sheet.name] || []));
    }
    await removeExternalLinks(folder);
    const corePath = path.join(folder, "docProps/core.xml");
    const core = await readFile(corePath, "utf8");
    const title = `<dc:title>${xml(`GSTR-1 ${report.registration.gstin} ${report.month}`)}</dc:title>`;
    await writeFile(corePath, /<dc:title(?:\s[^>]*)?>[\s\S]*?<\/dc:title>/.test(core) ? core.replace(/<dc:title(?:\s[^>]*)?>[\s\S]*?<\/dc:title>/, title) : core.replace("</cp:coreProperties>", `${title}</cp:coreProperties>`));
    await execute("/usr/bin/zip", ["-q", "-r", output, "."], { cwd: folder, timeout: 60000 });
    return await readFile(output);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function gstrWorkbook(report) {
  const captured = structuredClone(report);
  const next = pending.catch(() => {}).then(() => buildWorkbook(captured));
  pending = next.then(() => {}, () => {});
  return next;
}
