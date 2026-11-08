// Public reference resources and official Tally fixtures are fetched by `npm run setup`
// and are not part of the source checkout. Tests that need them skip when they are absent,
// naming the file, so a clean clone still runs the rest of the suite.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const HSN_DIRECTORY = "lib/resources/hsn-sac.json";
export const GSTR1_TEMPLATE = "lib/resources/GSTR1_Excel_Workbook_Template_V2.2.xlsx";
export const TALLY_SALES_GST_ZIP = "test/fixtures/tally-xlsx/Tally-Sales-GST-Template.zip";
export const TALLY_LEDGERS_ZIP = "test/fixtures/tally-xlsx/Tally-Ledgers-Template.zip";
export const TALLY_STOCK_PRICE_ZIP = "test/fixtures/tally-xlsx/Tally-Stock-Price-Template.zip";
export const TALLY_VOUCHERS_DEFAULT_ZIP = "test/fixtures/tally-xlsx/Tally-Vouchers-Default-Template.zip";
export const TALLY_STOCK_STANDARD_ZIP = "test/fixtures/tally-xlsx/Tally-Stock-Standard-Template.zip";

export function missingResources(...files) {
  return files.filter((file) => !existsSync(path.join(root, file)));
}

/** Returns true when every file is present; otherwise marks the test skipped and returns false. */
export function needsResources(t, ...files) {
  const missing = missingResources(...files);
  if (!missing.length) return true;
  t.skip(`needs ${missing.join(", ")}; run npm run setup`);
  return false;
}
