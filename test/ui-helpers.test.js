import test from "node:test";
import assert from "node:assert/strict";
import { balancesFromTrial, exactLedger, filterLedgers, normalise } from "../public/ledger-picker.js";
import { csvFileName, dueSentence, gstCalendar, monthName, pagingNote, plainAmount, toCsv } from "../public/table-export.js";
import { isHelpKey, isMacPlatform, isTypingTarget, shortcutList, voucherKeyLabel, voucherKeyShortcut, voucherTypeForKey } from "../public/shortcuts.js";

const ledgers = [
  { id: "l-sbi", name: "SBI Current Account", path: "Current Assets › Bank Accounts" },
  { id: "l-cash", name: "Cash", path: "Current Assets › Cash-in-Hand" },
  { id: "l-sales", name: "Sales", path: "Sales Accounts" },
  { id: "l-patil", name: "Patil Precision Systems", path: "Current Assets › Sundry Debtors" },
  { id: "l-petty", name: "Petty cash", path: "Current Assets › Cash-in-Hand" },
  { id: "l-hdfc", name: "HDFC Bank", path: "Current Assets › Bank Accounts" },
];
const names = list => list.map(ledger => ledger.name);

test("ledger filter matches name or group path anywhere, ignoring case, and ranks name prefixes first", () => {
  assert.deepEqual(names(filterLedgers(ledgers, "cash")), ["Cash", "Petty cash"]);
  assert.deepEqual(names(filterLedgers(ledgers, "CASH-IN")), ["Cash", "Petty cash"], "group path matches come after any name match");
  assert.deepEqual(names(filterLedgers(ledgers, "bank")), ["HDFC Bank", "SBI Current Account"], "a word in the name ranks above a path-only match");
  const s = names(filterLedgers(ledgers, "s"));
  assert.deepEqual(s.slice(0, 2), ["Sales", "SBI Current Account"], "names that start with the text come first, then alphabetically");
  assert.ok(s.indexOf("Patil Precision Systems") < s.indexOf("Cash"), "a word prefix ranks above a match inside a word");
  assert.deepEqual(names(filterLedgers(ledgers, "debtors patil")), ["Patil Precision Systems"], "several words may match across name and path");
  assert.deepEqual(filterLedgers(ledgers, "zzz"), []);
  assert.equal(filterLedgers(ledgers, "").length, ledgers.length);
  assert.deepEqual(names(filterLedgers(ledgers, "")).slice(0, 2), ["Cash", "HDFC Bank"], "an empty search lists every ledger by name");
});

test("exact ledger match ignores case and spacing; balances come from the trial balance closing column", () => {
  assert.equal(exactLedger(ledgers, "  petty   CASH ")?.id, "l-petty");
  assert.equal(exactLedger(ledgers, "Pett"), null);
  assert.equal(exactLedger(ledgers, ""), null);
  assert.equal(normalise("  A  b "), "a b");
  const balances = balancesFromTrial({ rows: [{ ledgerId: "l-cash", closing: { paise: 1800000, dc: "Dr" } }, { ledgerId: "l-sales", closing: { paise: 500, dc: "Cr" } }] });
  assert.deepEqual(balances.get("l-cash"), { paise: 1800000, dc: "Dr" });
  assert.deepEqual(balances.get("l-sales"), { paise: 500, dc: "Cr" });
  assert.equal(balances.has("l-sbi"), false);
  assert.equal(balancesFromTrial(null).size, 0);
});

test("CSV splits money cells into a plain amount and a Dr/Cr column, keeps totals and opens in Excel", () => {
  const csv = toCsv({
    columns: [{ label: "Ledger" }, { label: "Opening", figure: true }, { label: "Debit", figure: true }, { label: "" }],
    rows: [
      [{ text: "Current Assets" }, { text: "" }, { text: "" }, { text: "" }],
      [{ text: "Cash, office" }, { text: "1,80,000.00", figure: true, dc: "Dr" }, { text: "25,000.50", figure: true }, { text: "" }],
      [{ text: "Sales \"retail\"" }, { text: "—", figure: true }, { text: "-1,200.00", figure: true }, { text: "" }],
      [{ text: "=HYPERLINK(\"x\")" }, { text: "12.00", figure: true, dc: "Cr" }, { text: "" }, { text: "" }],
      [{ text: "Totals" }, { text: "1,80,012.00", figure: true, dc: "Dr" }, { text: "23,800.50", figure: true }, { text: "" }],
    ],
  });
  assert.ok(csv.startsWith("\uFEFF"), "UTF-8 byte-order mark so that Excel reads ₹");
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines.at(-1), "", "ends with a line break");
  assert.deepEqual(lines.slice(0, -1), [
    "Ledger,Opening,Opening Dr/Cr,Debit",
    "Current Assets,,,",
    "\"Cash, office\",180000.00,Dr,25000.50",
    "\"Sales \"\"retail\"\"\",,,-1200.00",
    "\"'=HYPERLINK(\"\"x\"\")\",12.00,Cr,",
    "Totals,180012.00,Dr,23800.50",
  ]);
  assert.equal(plainAmount("₹ 1,23,456.78"), "123456.78");
  assert.equal(plainAmount("—"), "");
  assert.equal(plainAmount("1,000.00 = 1,000.00"), "1,000.00 = 1,000.00", "text that is not one amount stays as written");
});

test("CSV file names are lower-case and hyphenated with the period in day-first dates", () => {
  assert.equal(csvFileName({ company: "North Mill Traders", title: "Profit & loss", from: "2026-04-01", to: "2026-11-09" }), "north-mill-traders-profit-loss-01-04-2026-09-11-2026.csv");
  assert.equal(csvFileName({ company: "Saraswati Traders (Pune)", title: "Trial balance", from: "", to: "" }), "saraswati-traders-pune-trial-balance.csv");
  assert.equal(csvFileName({}), "ledgercraft.csv");
});

test("paging note counts in Indian digit grouping and disappears when every row is shown", () => {
  assert.equal(pagingNote(200, 1240), "Showing 200 of 1,240 rows");
  assert.equal(pagingNote(200, 124000), "Showing 200 of 1,24,000 rows");
  assert.equal(pagingNote(200, 200), "");
  assert.equal(pagingNote(12, 12), "");
});

test("voucher type keys use Option or Alt with the physical key, never with Command, Control or Shift", () => {
  const press = (code, extra = {}) => voucherTypeForKey({ code, altKey: true, metaKey: false, ctrlKey: false, shiftKey: false, ...extra });
  assert.deepEqual(["KeyC", "KeyP", "KeyR", "KeyJ", "KeyS", "KeyU", "KeyD", "KeyN"].map(code => press(code)),
    ["Contra", "Payment", "Receipt", "Journal", "Sales", "Purchase", "Debit Note", "Credit Note"]);
  assert.equal(press("KeyP", { key: "π" }), "Payment", "a Mac Option character does not matter");
  assert.equal(press("KeyX"), null);
  assert.equal(press("KeyP", { altKey: false }), null);
  assert.equal(press("KeyP", { metaKey: true }), null);
  assert.equal(press("KeyP", { ctrlKey: true }), null);
  assert.equal(press("KeyP", { shiftKey: true }), null);
  assert.equal(voucherKeyLabel("Debit Note", true), "⌥D");
  assert.equal(voucherKeyLabel("Purchase", false), "Alt+U");
  assert.equal(voucherKeyShortcut("Credit Note"), "Alt+N");
  assert.equal(voucherKeyLabel("Stock journal", true), "");
});

test("the help key and typing guard keep single keys away from fields", () => {
  assert.equal(isHelpKey({ key: "?", shiftKey: true }), true);
  assert.equal(isHelpKey({ key: "?", metaKey: true }), false);
  assert.equal(isHelpKey({ key: "/" }), false);
  for (const tagName of ["INPUT", "textarea", "SELECT"]) assert.equal(isTypingTarget({ tagName }), true, tagName);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isMacPlatform("MacIntel"), true);
  assert.equal(isMacPlatform("macOS"), true);
  assert.equal(isMacPlatform("Win32"), false);
  const mac = shortcutList(true);
  assert.deepEqual(mac[0][1], [["Find a ledger, voucher or page", "⌘K"], ["Show this list", "?"]]);
  assert.deepEqual(mac[1][1].map(([, key]) => key), ["⌘⏎", "⌥⏎", "⏎"]);
  assert.equal(mac[2][1].length, 8);
  assert.deepEqual(shortcutList(false)[1][1].map(([, key]) => key), ["Ctrl+Enter", "Alt+Enter", "Enter"]);
});

test("GST calendar uses the latest completed month with documents: GSTR-1 on the 11th, GSTR-3B on the 20th", () => {
  const calendar = gstCalendar(["2026-05-09", "2026-10-09", "2026-10-31", "2026-11-02"], "2026-11-09");
  assert.equal(calendar.month, "2026-10", "November is not complete on 9 November");
  assert.deepEqual(calendar.returns, [
    { form: "GSTR-1", due: "2026-11-11", days: 2 },
    { form: "GSTR-3B", due: "2026-11-20", days: 11 },
  ]);
  assert.equal(monthName(calendar.month), "October 2026");
  assert.equal(dueSentence(2, "2026-11-11"), "is due in 2 days (11-11-2026)");
  assert.equal(dueSentence(1, "2026-11-11"), "is due tomorrow (11-11-2026)");
  assert.equal(dueSentence(0, "2026-11-11"), "is due today (11-11-2026)");
  assert.equal(dueSentence(-3, "2026-11-11"), "was due on 11-11-2026");
  const december = gstCalendar(["2026-12-15"], "2027-01-25");
  assert.deepEqual(december.returns.map(item => [item.due, item.days]), [["2027-01-11", -14], ["2027-01-20", -5]], "December rolls into January of the next year");
  assert.equal(gstCalendar(["2026-11-02"], "2026-11-09"), null, "no completed month yet");
  assert.equal(gstCalendar([], "2026-11-09"), null);
  assert.equal(gstCalendar(["", null, "bad"], "2026-11-09"), null);
});
