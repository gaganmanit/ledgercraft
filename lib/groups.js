export const VOUCHER_TYPES = [
  "Payment",
  "Receipt",
  "Contra",
  "Journal",
  "Sales",
  "Purchase",
  "Debit Note",
  "Credit Note",
];

const NUMBER_PREFIX = {
  Payment: "PMT",
  Receipt: "RCT",
  Contra: "CTR",
  Journal: "JRN",
  Sales: "SAL",
  Purchase: "PUR",
  "Debit Note": "DBN",
  "Credit Note": "CRN",
};

const RESERVED = [
  ["g-capital", "Capital Account", null, "Liability", false, false],
  ["g-reserves", "Reserves & Surplus", "g-capital", "Liability", false, false],
  ["g-current-assets", "Current Assets", null, "Asset", false, false],
  ["g-bank", "Bank Accounts", "g-current-assets", "Asset", false, true],
  ["g-cash", "Cash-in-Hand", "g-current-assets", "Asset", false, true],
  ["g-deposits", "Deposits (Asset)", "g-current-assets", "Asset", false, false],
  ["g-advances", "Loans & Advances (Asset)", "g-current-assets", "Asset", false, false],
  ["g-stock", "Stock-in-Hand", "g-current-assets", "Asset", false, false],
  ["g-debtors", "Sundry Debtors", "g-current-assets", "Asset", false, false],
  ["g-current-liab", "Current Liabilities", null, "Liability", false, false],
  ["g-duties", "Duties & Taxes", "g-current-liab", "Liability", false, false],
  ["g-provisions", "Provisions", "g-current-liab", "Liability", false, false],
  ["g-creditors", "Sundry Creditors", "g-current-liab", "Liability", false, false],
  ["g-fixed", "Fixed Assets", null, "Asset", false, false],
  ["g-invest", "Investments", null, "Asset", false, false],
  ["g-loans", "Loans (Liability)", null, "Liability", false, false],
  ["g-od", "Bank OD A/c", "g-loans", "Liability", false, true],
  ["g-secured", "Secured Loans", "g-loans", "Liability", false, false],
  ["g-unsecured", "Unsecured Loans", "g-loans", "Liability", false, false],
  ["g-branch", "Branch / Divisions", null, "Liability", false, false],
  ["g-suspense", "Suspense A/c", null, "Liability", false, false],
  ["g-misc", "Misc. Expenses (ASSET)", null, "Asset", false, false],
  ["g-sales", "Sales Accounts", null, "Income", true, false],
  ["g-purchase", "Purchase Accounts", null, "Expense", true, false],
  ["g-direct-exp", "Direct Expenses", null, "Expense", true, false],
  ["g-direct-inc", "Direct Incomes", null, "Income", true, false],
  ["g-indirect-exp", "Indirect Expenses", null, "Expense", false, false],
  ["g-indirect-inc", "Indirect Incomes", null, "Income", false, false],
];

export function reservedGroups() {
  return RESERVED.map(([id, name, parentId, nature, gross, cashBank]) => ({
    id,
    name,
    parentId,
    nature,
    gross,
    cashBank,
    reserved: true,
  }));
}

export function emptyCashLedger() {
  return {
    id: "l-cash",
    name: "Cash",
    groupId: "g-cash",
    opening: { dc: "Dr", paise: 0 },
  };
}

export function nextNumber(vouchers, type) {
  const prefix = NUMBER_PREFIX[type];
  let highest = 0;
  for (const voucher of vouchers) {
    if (voucher.type !== type) continue;
    const match = String(voucher.number).match(/(\d+)$/);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${highest + 1}`;
}

export function nextNumbers(vouchers) {
  return Object.fromEntries(VOUCHER_TYPES.map((type) => [type, nextNumber(vouchers, type)]));
}
