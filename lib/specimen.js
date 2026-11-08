import { emptyCashLedger, reservedGroups } from "./groups.js";
import { fyStart, todayISO } from "./money.js";

export function buildSpecimen(now = new Date()) {
  const booksFrom = fyStart(todayISO(now));
  const year = booksFrom.slice(0, 4);
  const groups = reservedGroups();
  const ledgers = [
    { ...emptyCashLedger(), opening: { dc: "Dr", paise: 18_000_000 } },
    {
      id: "l-bank",
      name: "State Bank current",
      groupId: "g-bank",
      opening: { dc: "Dr", paise: 7_000_000 },
    },
    {
      id: "l-capital",
      name: "Proprietor's capital",
      groupId: "g-capital",
      opening: { dc: "Cr", paise: 25_000_000 },
    },
    {
      id: "l-sales",
      name: "Sales — cloth",
      groupId: "g-sales",
      opening: { dc: "Cr", paise: 0 },
    },
    {
      id: "l-purchase",
      name: "Purchases — grey cloth",
      groupId: "g-purchase",
      opening: { dc: "Dr", paise: 0 },
    },
    {
      id: "l-rent",
      name: "Godown rent",
      groupId: "g-indirect-exp",
      opening: { dc: "Dr", paise: 0 },
    },
    {
      id: "l-mill",
      name: "Mill Stores",
      groupId: "g-creditors",
      opening: { dc: "Cr", paise: 0 },
    },
  ];
  const vouchers = [
    {
      id: "v-specimen-receipt",
      type: "Receipt",
      date: `${year}-04-06`,
      number: "RCT-1",
      narration: "Cash sales, counter",
      lines: [
        { ledgerId: "l-cash", dc: "Dr", paise: 2_500_000 },
        { ledgerId: "l-sales", dc: "Cr", paise: 2_500_000 },
      ],
    },
    {
      id: "v-specimen-payment",
      type: "Payment",
      date: `${year}-04-08`,
      number: "PMT-1",
      narration: "April godown rent",
      lines: [
        { ledgerId: "l-rent", dc: "Dr", paise: 800_000 },
        { ledgerId: "l-cash", dc: "Cr", paise: 800_000 },
      ],
    },
    {
      id: "v-specimen-purchase",
      type: "Purchase",
      date: `${year}-04-12`,
      number: "PUR-1",
      narration: "Grey cloth, Mill Stores bill 44",
      lines: [
        { ledgerId: "l-purchase", dc: "Dr", paise: 1_500_000 },
        { ledgerId: "l-mill", dc: "Cr", paise: 1_500_000 },
      ],
    },
  ];
  return {
    company: {
      id: "specimen",
      name: "North Mill Traders",
      booksFrom,
      groups,
      ledgers,
    },
    vouchers,
  };
}
