import { buildOutwardAmendment, outwardAmendmentState } from './gst-outward-amendments.js';

export async function handleAmendmentRoute({ req, res, url, parts, store, readBody, send }) {
  if (parts[0] !== 'api' || parts[1] !== 'companies' || !parts[2] || parts[3] !== 'gst' || parts[4] !== 'amendments') return false;
  const companyId = decodeURIComponent(parts[2]);
  if (req.method === 'GET' && parts.length === 5) {
    const { company, vouchers } = await store.snapshot(companyId);
    const page = key => {
      const value = url.searchParams.get(key);
      if (value === null || value === '') return 0;
      if (!/^\d{1,12}$/.test(value)) throw new Error('Choose a valid correction page offset');
      return Number(value);
    };
    send(res, 200, outwardAmendmentState(company, vouchers, { registrationId: url.searchParams.get('registration'), month: url.searchParams.get('month'),
      mode: url.searchParams.get('mode'), invoice: url.searchParams.get('invoice') || undefined, q: url.searchParams.get('q') || '',
      offset: page('offset'), historyOffset: page('historyOffset') }));
    return true;
  }
  if (req.method === 'POST' && parts.length === 6 && parts[5] === 'preview') {
    const { company, vouchers } = await store.snapshot(companyId);
    send(res, 200, buildOutwardAmendment(company, vouchers, await readBody(req), { preview: true }));
    return true;
  }
  if (req.method === 'POST' && parts.length === 6 && parts[5] === 'save') {
    send(res, 201, await store.saveGstAmendment(companyId, await readBody(req)));
    return true;
  }
  return false;
}
