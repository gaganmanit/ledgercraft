import { isCashBank } from "./engine.js";
import { isIsoDate, todayISO } from "./money.js";
import { rcmState } from "./gst-rcm.js";

export async function handleRcmRoute({ req, res, url, parts, store, readBody, send }) {
  if (parts[0] !== "api" || parts[1] !== "companies" || !parts[2] || parts[3] !== "gst" || parts[4] !== "rcm") return false;
  const id = decodeURIComponent(parts[2]);
  if (req.method === "GET" && parts.length === 5) {
    const { company, vouchers } = await store.snapshot(id);
    const to = url.searchParams.get("to") || todayISO();
    if (!isIsoDate(to)) throw new Error("Choose a valid RCM review date");
    send(res, 200, {
      company: { id: company.id, name: company.name, booksFrom: company.booksFrom },
      registrations: company.gst?.registrations || [],
      banks: company.ledgers.filter((ledger) => isCashBank(company.groups, ledger.groupId)).map(({ id, name }) => ({ id, name })),
      invoices: vouchers.filter((voucher) => voucher.gst?.reverseCharge).map((voucher) => voucher.gst),
      ...rcmState(company, vouchers, to), to,
    });
    return true;
  }
  if (req.method === "POST" && parts.length === 6) {
    send(res, 201, await store.gstRcmAction(id, parts[5], await readBody(req)));
    return true;
  }
  return false;
}
