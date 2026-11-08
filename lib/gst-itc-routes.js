import { todayISO, isIsoDate } from './money.js';
import { itcState } from './gst-itc.js';

export async function handleItcRoute({ req, res, url, parts, store, readBody, send }) {
  if (parts[0] !== 'api' || parts[1] !== 'companies' || !parts[2] || parts[3] !== 'gst' || parts[4] !== 'itc') return false;
  const id = decodeURIComponent(parts[2]);
  if (req.method === 'GET' && parts.length === 5) {
    const { company, vouchers } = await store.snapshot(id);
    const to = url.searchParams.get('to') || todayISO();
    if (!isIsoDate(to)) throw new Error('Choose the purchase ITC review date');
    send(res, 200, { company: { id: company.id, name: company.name, booksFrom: company.booksFrom },
      registrations: company.gst?.registrations || [],
      ledgers: company.ledgers.map(({ id, name }) => ({ id, name })),
      ...itcState(company, vouchers, to) });
    return true;
  }
  if (req.method === 'POST' && parts.length === 6) {
    send(res, 201, await store.gstItcAction(id, parts[5], await readBody(req)));
    return true;
  }
  return false;
}
