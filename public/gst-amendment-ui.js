import { formatINR, parseRupees, todayISO } from '/money.js';
import { mountAmendmentDispositions } from '/gst-amendment-disposition.js';

const HEADS = ['igstPaise', 'cgstPaise', 'sgstPaise', 'utgstPaise', 'cessPaise'];
const RATE_FIELDS = ['taxablePaise', ...HEADS];
const LABELS = { taxablePaise: 'Taxable value', igstPaise: 'IGST', cgstPaise: 'CGST', sgstPaise: 'SGST', utgstPaise: 'UTGST', cessPaise: 'Cess', invoiceValuePaise: 'Invoice value' };
const SECTIONS = { b2b: 'Registered recipient · B2B', b2cl: 'Large interstate consumer invoice · B2CL', exp: 'Export invoice', cdnr: 'Registered credit / debit note', cdnur: 'Unregistered credit / debit note' };
const draftSourceFiles = new Map();
const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('-') : value || '—';
const rupees = value => Number.isSafeInteger(value) ? (value / 100).toFixed(2) : '';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function amount(input, label) {
  let result;
  try { result = parseRupees(input); }
  catch { throw new Error(`Enter ${label} in rupees with no more than two decimal places.`); }
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Enter ${label} in exact nonnegative rupees and paise.`);
  return result;
}
function total(snapshot, field) {
  if (field === 'invoiceValuePaise') return snapshot?.invoiceValuePaise ?? null;
  if (!Array.isArray(snapshot?.rates)) return null;
  const sum = snapshot.rates.reduce((result, row) => result + BigInt(row[field] || 0), 0n);
  return sum > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(sum);
}
function normalized(snapshot) {
  const result = { section: snapshot.section || '', number: snapshot.number || '', date: snapshot.date || '', recipientGstin: snapshot.recipientGstin || '', recipientName: snapshot.recipientName || '', placeOfSupply: snapshot.placeOfSupply || '', reverseCharge: Boolean(snapshot.reverseCharge), invoiceType: snapshot.invoiceType || '', exportType: snapshot.exportType || null, urType: snapshot.urType || null, noteType: snapshot.noteType || null, invoiceValuePaise: snapshot.invoiceValuePaise || 0,
    rates: (snapshot.rates || []).map(row => Object.fromEntries(['gstRateBps', ...RATE_FIELDS].map(field => [field, row[field] || 0]))),
    portCode: snapshot.portCode || '', shippingBillNumber: snapshot.shippingBillNumber || '', shippingBillDate: snapshot.shippingBillDate || '' };
  if (Array.isArray(snapshot.hsnRows)) result.hsnRows = snapshot.hsnRows.map(row => ({ hsnSac: row.hsnSac || '', uqc: row.uqc || '', quantity: row.quantity || '0', gstRateBps: row.gstRateBps || 0, ...Object.fromEntries(['taxablePaise', 'totalPaise', ...HEADS].map(field => [field, row[field] || 0])), ...(row.description ? { description: row.description } : {}) }));
  return result;
}
function comparison(book, reported, esc) {
  const fields = ['invoiceValuePaise', 'taxablePaise', ...HEADS];
  const money = value => Number.isSafeInteger(value) ? esc(formatINR(value)) : '—';
  return `<div class="amendment-scroll"><table class="amendment-comparison"><thead><tr><th>Particular</th><th class="figure">Posted books ₹</th><th class="figure">Previously filed ₹</th><th class="figure">Correction difference ₹</th></tr></thead><tbody>${fields.map(field => {
    const actual = total(book, field), prior = total(reported, field), delta = actual === null || prior === null ? null : (actual - prior) * (book?.noteType === 'C' ? -1 : 1);
    return `<tr><th scope="row">${esc(LABELS[field])}</th><td class="figure">${money(actual)}</td><td class="figure">${money(prior)}</td><td class="figure">${delta > 0 ? '+' : ''}${money(delta)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function snapshotRates(snapshot, esc) {
  return `<div class="amendment-scroll"><table><thead><tr><th>GST rate %</th>${RATE_FIELDS.map(field => `<th class="figure">${esc(LABELS[field])} ₹</th>`).join('')}</tr></thead><tbody>${(snapshot?.rates || []).map(row => `<tr><td>${rupees(row.gstRateBps)}</td>${RATE_FIELDS.map(field => `<td class="figure">${esc(formatINR(row[field] || 0))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function shippingComparison(reported, revised, esc) {
  if (revised?.section !== 'exp') return '';
  const fields = [['portCode', 'Port code'], ['shippingBillNumber', 'Shipping bill number'], ['shippingBillDate', 'Shipping bill date']];
  return `<h3>Shipping details for the correction return</h3><div class="amendment-scroll"><table><thead><tr><th>Particular</th><th>Previously reported</th><th>Correction return</th></tr></thead><tbody>${fields.map(([field, label]) => `<tr><th scope="row">${label}</th><td>${esc(field === 'shippingBillDate' ? dateLabel(reported[field]) : reported[field] || '—')}</td><td>${esc(field === 'shippingBillDate' ? dateLabel(revised[field]) : revised[field] || '—')}</td></tr>`).join('')}</tbody></table></div>`;
}
function dispositionMarkup(record, esc) {
  if (!record.disposition) return '';
  return `<dl><dt>Status record</dt><dd>${dateLabel(record.disposition.date)} · ${esc(record.disposition.reference)}</dd><dt>Status evidence</dt><dd>${esc(record.disposition.basis)}</dd>${record.filing ? `<dt>External GSTR-1 filing</dt><dd>${esc(record.filing.period)} · ${dateLabel(record.filing.filedDate)} · ${esc(record.filing.reference)}</dd>` : ''}</dl>`;
}
function documentOptions(documents, selected, esc) {
  const outsidePage = selected && !documents.some(row => row.invoiceId === selected.invoiceId);
  const entries = outsidePage ? [selected, ...documents] : documents;
  return entries.map(row => `<option value="${esc(row.invoiceId)}"${row.invoiceId === selected?.invoiceId ? ' selected' : ''}>${outsidePage && row.invoiceId === selected.invoiceId ? 'Selected · ' : ''}${esc(`${row.type} ${row.number} · ${dateLabel(row.date)} · ${row.partyName}`)}</option>`).join('') || '<option value="">No matching outward documents</option>';
}

export async function viewGstAmendments(route, token, ui) {
  if (route.name !== 'gst-amendments') return false;
  const { root, api, esc, still, page } = ui;
  const book = `#/c/${encodeURIComponent(route.id)}`, base = `/api/companies/${encodeURIComponent(route.id)}/gst/amendments`;
  const { company, registrations } = await api(`/api/companies/${encodeURIComponent(route.id)}/gst/registrations`);
  if (!still(token)) return true;
  if (!registrations.length) {
    root.innerHTML = page({ company, title: 'Return corrections', kicker: 'GST returns', body: `<p>Add the business registration to review outward return corrections.</p><a href="${book}/gst">Open GST setup</a>` });
    return true;
  }
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const registrationId = params.get('registration') || registrations[0].id, month = params.get('month') || todayISO().slice(0, 7);
  const registration = registrations.find(row => row.id === registrationId) || registrations[0];
  const query = new URLSearchParams({ registration: registration.id, month });
  for (const field of ['q', 'offset', 'historyOffset']) if (params.get(field)) query.set(field, params.get(field));
  const deskQuery = new URLSearchParams(query); deskQuery.set('mode', 'desk');
  if (route.detail) deskQuery.set('invoice', route.detail);
  const report = await api(`${base}?${deskQuery}`);
  if (!still(token)) return true;
  const documents = report.documents || [], records = report.records || [];
  const activeRecord = record => (record.effectiveStatus || record.status) !== 'withdrawn';
  const selected = report.selected || documents.find(row => row.invoiceId === route.detail) || documents.find(row => row.supported && !records.some(record => record.invoiceId === row.invoiceId && activeRecord(record))) || documents[0];
  const saved = selected && records.find(record => record.invoiceId === selected.invoiceId && activeRecord(record));
  const href = (invoiceId = selected?.invoiceId || '') => `${book}/gst-amendments${invoiceId ? '/' + encodeURIComponent(invoiceId) : ''}?${query}`;
  const field = (name, label, value = '', attributes = '') => `<label>${esc(label)}<input name="${name}" value="${esc(value)}" ${attributes}></label>`;
  const option = (value, label, current) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
  const flashKey = `financer-amendment-flash:${route.id}`;
  const flash = sessionStorage.getItem(flashKey) || '';
  sessionStorage.removeItem(flashKey);
  document.title = `Return corrections · ${company.name}`;
  const period = `<form id="amendment-period" class="amendment-period"><label>Registration<select name="registration">${registrations.map(row => option(row.id, row.gstin + ' · ' + row.name, registration.id)).join('')}</select></label>${field('month', 'Correction return period', month, 'type="month" required')}<button>Show period</button></form>`;
  const choose = `<form id="amendment-document-form" class="amendment-choose"><label>Find a posted outward document<input name="q" type="search" autocomplete="off" placeholder="Number, recipient or evidence reference" value="${esc(query.get('q') || '')}"></label><label>Posted document<select name="invoiceId" aria-describedby="amendment-document-count">${documentOptions(documents, selected, esc)}</select></label><button type="button" class="secondary" data-open-amendment-document>Open document</button><div class="amendment-wide" data-amendment-document-pages></div><p id="amendment-document-count" class="amendment-status amendment-wide" role="status"></p><p class="amendment-wide" data-amendment-browser-error role="alert"></p></form>`;
  const actual = selected?.actual;
  const prior = actual ? normalized(actual) : null;
  const review = selected && !saved && selected.supported ? `<section><h2>Previous filing and corrected books</h2><p class="amendment-intro">Record what was filed, then compare it with the posted document. This creates an outward return correction record; the posted invoice stays intact.</p>
    <form id="amendment-review" class="amendment-form">
      <fieldset class="amendment-wide"><legend>Earlier GSTR-1 filing</legend><div class="amendment-grid">
        ${field('originalPeriod', 'Original reported period', actual.date.slice(0, 7), 'type="month" required')}${field('originalFilingReference', 'Original filing reference', '', 'required maxlength="240"')}
        ${field('originalFiledDate', 'Original GSTR-1 filing date', '', 'type="date" required')}<label class="amendment-check"><input type="checkbox" name="confirmedFiled" required><span>The original GSTR-1 was filed, supported by the reference above.</span></label><div id="amendment-source-file" class="amendment-wide"></div><div class="amendment-wide" data-amendment-source-state></div>
      </div></fieldset>
      <fieldset class="amendment-wide"><legend>Previously reported document</legend><div class="amendment-grid">
        <label>Original return table<select name="originalSection">${Object.entries(SECTIONS).map(([key, label]) => option(key, label, actual.section)).join('')}</select></label>${field('originalNumber', 'Reported document number', prior.number, 'required maxlength="24"')}
        ${field('originalDate', 'Reported document date', prior.date, 'type="date" required')}${field('originalRecipientGstin', 'Reported recipient GSTIN', prior.recipientGstin, 'maxlength="15" autocapitalize="characters" spellcheck="false"')}
        ${field('originalRecipientName', 'Reported recipient name', prior.recipientName, 'maxlength="120"')}${field('originalPlaceOfSupply', 'Reported place-of-supply code', prior.placeOfSupply, 'required inputmode="numeric" pattern="[0-9]{2}" maxlength="2"')}
        <div class="amendment-wide" data-amendment-missing-name hidden><button class="ghost" type="button" data-use-book-name>Use book recipient name</button><span class="amendment-help">This explicitly adds the name from the posted document.</span></div>
        ${field('originalInvoiceType', 'Reported invoice type', prior.invoiceType, 'maxlength="100"')}<label>Reported export type<select name="originalExportType"><option value="">Not an export</option>${option('WPAY', 'With payment of tax', prior.exportType)}${option('WOPAY', 'Without payment of tax', prior.exportType)}</select></label>
        <label>Unregistered note supply<select name="originalUrType"><option value="">Not applicable</option>${['B2CL', 'EXPWP', 'EXPWOP'].map(value => option(value, value, prior.urType)).join('')}</select></label><label>Note type<select name="originalNoteType"><option value="">Invoice</option>${option('C', 'Credit note', prior.noteType)}${option('D', 'Debit note', prior.noteType)}</select></label>
        ${field('originalInvoiceValue', 'Previously reported total invoice value ₹', rupees(prior.invoiceValuePaise), 'inputmode="decimal" required')}
        <label class="amendment-check"><input type="checkbox" name="originalReverseCharge"${prior.reverseCharge ? ' checked' : ''}><span>Reported as reverse charge</span></label>
      </div>${actual.section === 'exp' ? `<h3>Previously reported shipping particulars</h3><div class="amendment-grid">${field('originalPortCode', 'Reported port code', prior.portCode, 'maxlength="20"')}${field('originalShippingBillNumber', 'Reported shipping bill number', prior.shippingBillNumber, 'maxlength="30"')}${field('originalShippingBillDate', 'Reported shipping bill date', prior.shippingBillDate, 'type="date"')}</div>` : ''}<h3>Original rate and tax lines</h3><div class="amendment-scroll" data-amendment-rates></div><div class="amendment-actions"><button type="button" class="ghost" data-add-amendment-rate>Add reported rate line</button><button type="button" class="ghost" data-copy-book-rates>Use book tax lines as a starting point</button></div></fieldset>
      ${actual.section === 'exp' ? `<fieldset class="amendment-wide"><legend>Later available shipping bill</legend><label class="amendment-check"><input type="checkbox" name="shippingUpdateKnown"><span>Include a later available shipping bill supported by customs evidence.</span></label><div class="amendment-grid" data-amendment-shipping-update hidden>${field('updatedPortCode', 'Port code', actual.portCode || '', 'maxlength="6"')}${field('updatedShippingBillNumber', 'Shipping bill number', actual.shippingBillNumber || '', 'maxlength="7"')}${field('updatedShippingBillDate', 'Shipping bill date', actual.shippingBillDate || '', 'type="date"')}${field('shippingDocumentReference', 'Customs evidence reference', '', 'maxlength="240"')}</div></fieldset>` : ''}
      <details class="amendment-wide"><summary>Previous per-document HSN allocation</summary><label class="amendment-check"><input type="checkbox" name="hsnKnown"><span>I have the previous filing's HSN allocation for this document.</span></label><p class="amendment-help">Leave this unselected when only an aggregate Table 12 is available. The return workbook will identify the missing allocation.</p><div data-amendment-hsn-editor hidden><div class="amendment-scroll" data-amendment-hsn></div><div class="amendment-actions"><button type="button" class="ghost" data-add-amendment-hsn>Add prior HSN line</button><button type="button" class="ghost" data-copy-book-hsn>Copy book HSN lines to review</button></div></div></details>
      <fieldset class="amendment-wide"><legend>Correction period and evidence</legend><div class="amendment-grid">
        ${field('date', 'Correction record date', todayISO(), 'type="date" required')}${field('filingDate', 'Planned GSTR-1 filing date', '', 'type="date" required')}
        <label>Relevant annual return<select name="annualReturnStatus" required><option value="">Choose reviewed status</option><option value="not-filed">Not filed</option><option value="filed">Filed</option></select></label><label data-amendment-annual-date hidden>Annual return filing date<input type="date" name="annualReturnFiledDate"></label>
        <label class="amendment-wide">Reason and evidence basis<textarea name="basis" required maxlength="1000"></textarea></label>${field('documentReference', 'Evidence document reference', '', 'required maxlength="500"')}
        <label class="amendment-wide amendment-check"><input type="checkbox" name="accurateBooksConfirmed" required><span>The posted document and its tax lines are correct.</span></label>
        <label class="amendment-wide amendment-check"><input type="checkbox" name="reportedSnapshotConfirmed" required><span>The previous-filing particulars and rate lines match the filed GSTR-1 evidence.</span></label>
      </div></fieldset>
      <div class="amendment-wide" data-amendment-comparison></div><p class="amendment-wide" data-amendment-error role="alert"></p><p class="amendment-wide amendment-status" data-amendment-draft role="status"></p>
      <div class="amendment-wide amendment-actions"><button type="submit" data-amendment-preview>Preview correction</button><button type="button" data-amendment-save disabled>Save correction record</button></div><div class="amendment-wide amendment-preview" data-amendment-preview-result aria-live="polite"></div>
    </form></section>` : saved ? `<p class="amendment-status">The correction saved for ${esc(saved.amendmentPeriod)} is available in the immutable history below.</p>` : selected ? `<p class="alert">${esc(selected.reason || 'This posted document is not supported for the selected outward correction workflow.')}</p>` : '<p>No posted outward documents are available for this registration.</p>';
  root.innerHTML = page({ company, title: 'Return corrections', kicker: 'GST returns', folio: 'Ra', body: `<div class="amendment-workspace"><p><a href="${book}/gst-returns?${new URLSearchParams({ registration: registration.id, month })}">Back to GST returns</a></p>${period}${flash ? `<p class="status" role="status">${esc(flash)}</p>` : ''}${choose}${selected ? `<div class="amendment-identity"><strong>${esc(selected.type)} ${esc(selected.number)}</strong><span>${dateLabel(selected.date)}</span><span>${esc(selected.partyName)}</span><a href="${book}/gst-document/${encodeURIComponent(selected.invoiceId)}">Open posted document</a></div><details><summary>Posted book tax lines</summary>${snapshotRates(actual, esc)}</details>` : ''}${review}<section class="amendment-history" data-amendment-history><h2>Saved correction history</h2>${historyMarkup(records, selected, month, book, query, esc, `/api/companies/${encodeURIComponent(route.id)}`, Boolean(query.get('q')))}</section>${report.sources?.length ? `<details><summary>Reporting sources</summary><ul>${report.sources.map(source => `<li><a href="${esc(source.url || source)}" target="_blank" rel="noreferrer">${esc(source.title || source.url || source)}</a></li>`).join('')}</ul></details>` : ''}</div>` });
  root.querySelector('#amendment-period').addEventListener('submit', event => {
    event.preventDefault();
    const next = new URLSearchParams(new FormData(event.currentTarget));
    const retained = next.get('registration') === registration.id && selected ? '/' + encodeURIComponent(selected.invoiceId) : '';
    location.hash = `${book}/gst-amendments${retained}?${next}`;
  });
  const chooser = root.querySelector('#amendment-document-form');
  chooser.addEventListener('submit', event => event.preventDefault());
  chooser.elements.invoiceId.addEventListener('change', () => { location.hash = href(chooser.elements.invoiceId.value); });
  chooser.querySelector('[data-open-amendment-document]').addEventListener('click', () => { if (chooser.elements.invoiceId.value) location.hash = href(chooser.elements.invoiceId.value); });
  bindDeskBrowser({ ...ui, route, token, base, report, selected, query, month, book, href });
  if (root.querySelector('#amendment-review')) await bindReview({ ...ui, route, token, base, report, company, registration, selected, month, query, book, flashKey, href });
  return true;
}

function historyMarkup(records, selected, month, book, query, esc, filesBase, allMatches = false) {
  const visible = allMatches ? records : records.filter(record => record.amendmentPeriod === month || record.invoiceId === selected?.invoiceId);
  if (!visible.length) return '<p class="quiet">No correction records for this period or document.</p>';
  return visible.slice().reverse().map(record => `<details data-amendment-record="${esc(record.id)}"><summary>${esc(record.section?.toUpperCase() || 'Correction')} · ${esc(record.revised.number)} · ${esc(record.amendmentPeriod)} · ${esc(({ prepared: 'Prepared', withdrawn: 'Withdrawn', filed: 'External filing recorded' })[record.effectiveStatus || record.status] || record.status)}<small>Original period ${esc(record.originalPeriod)} · Recorded ${dateLabel(record.date)}</small></summary>${dispositionMarkup(record, esc)}${comparison(record.revised, record.originalReported, esc)}${shippingComparison(record.originalReported, record.revised, esc)}<h3>Previously reported rate lines</h3>${snapshotRates(record.originalReported, esc)}<h3>Saved corrected book rate lines</h3>${snapshotRates(record.revised, esc)}<dl><dt>Original filing</dt><dd>${esc(record.originalFiling.reference)} · ${dateLabel(record.originalFiling.filedDate)}</dd>${record.originalFiling.source ? `<dt>Original file</dt><dd class="amendment-source-reference"><a download href="${filesBase}/gst-filed-source/${encodeURIComponent(record.originalFiling.source.sha256)}">${esc(record.originalFiling.source.fileName)}</a><small>SHA-256 ${esc(record.originalFiling.source.sha256)}</small></dd>` : ''}<dt>Evidence</dt><dd>${esc(record.evidence.documentReference)}</dd><dt>Reason</dt><dd>${esc(record.evidence.basis)}</dd>${record.shippingUpdate ? `<dt>Customs evidence</dt><dd>${esc(record.shippingUpdate.documentReference)}</dd>` : ''}<dt>Filing cutoff</dt><dd>${dateLabel(record.cutoff?.latestFilingDate)}</dd></dl><p><a href="${book}/gst-document/${encodeURIComponent(record.invoiceId)}">Open posted document</a> · <a href="${book}/gst-returns?${new URLSearchParams({ registration: query.get('registration'), month: record.amendmentPeriod })}">Open correction-period return</a></p><div data-amendment-disposition="${esc(record.id)}"></div></details>`).join('');
}

function bindDeskBrowser(context) {
  const { root, api, esc, still, token, route, base, report, selected, query, month, book, href } = context;
  const chooser = root.querySelector('#amendment-document-form'), historyBox = root.querySelector('[data-amendment-history]');
  const pages = chooser.querySelector('[data-amendment-document-pages]'), count = chooser.querySelector('#amendment-document-count'), error = chooser.querySelector('[data-amendment-browser-error]');
  const filesBase = `/api/companies/${encodeURIComponent(route.id)}`;
  let generation = 0, timer;
  const historyDrafts = new Map();
  const openHistory = new Map();
  function pagination(page, type) {
    if (!page) return '';
    const label = type === 'document' ? 'documents' : 'history';
    return `<div class="amendment-actions">${page.offset ? `<button type="button" class="ghost" data-${type}-offset="${Math.max(0, page.offset - page.limit)}">Previous ${label}</button>` : ''}${page.offset + page.limit < page.total ? `<button type="button" class="ghost" data-${type}-offset="${page.offset + page.limit}">Next ${label}</button>` : ''}</div>`;
  }
  function displayDocumentPage(state) {
    chooser.elements.invoiceId.innerHTML = documentOptions(state.documents || [], selected, esc);
    const page = state.documentPage || { offset: 0, limit: 50, total: state.documents?.length || 0 };
    pages.innerHTML = pagination(page, 'document');
    const shown = state.documents?.length || 0;
    count.textContent = page.total ? `Documents ${page.offset + 1}–${page.offset + shown} of ${page.total}${selected && !state.documents.some(row => row.invoiceId === selected.invoiceId) ? ' · Current document retained outside this result page' : ''}` : 'No matching outward documents. The current editor is retained.';
  }
  function rememberHistoryDrafts() {
    for (const mount of historyBox.querySelectorAll('[data-amendment-disposition]')) {
      const form = mount.querySelector('form');
      if (form) historyDrafts.set(mount.dataset.amendmentDisposition, Object.fromEntries([...form.querySelectorAll('[name]')].map(input => [input.name, input.type === 'checkbox' ? input.checked : input.value])));
      openHistory.set(mount.dataset.amendmentDisposition, { record: mount.closest('[data-amendment-record]').open, disposition: mount.querySelector('details')?.open || false });
    }
  }
  function displayHistory(state) {
    rememberHistoryDrafts();
    const page = state.historyPage || { offset: 0, limit: 20, total: state.records?.length || 0 };
    historyBox.innerHTML = `<h2>Saved correction history</h2><p class="amendment-status" role="status" data-amendment-history-count>${page.total ? `History ${page.offset + 1}–${Math.min(page.offset + page.limit, page.total)} of ${page.total}` : 'No saved history matches this search or period.'}</p>${historyMarkup(state.records || [], selected, month, book, query, esc, filesBase, Boolean(query.get('q')))}${pagination(page, 'history')}`;
    mountAmendmentDispositions(historyBox, { records: state.records || [], revision: state.revision, endpoint: base, api, refresh: () => viewGstAmendments(route, token, context), still: () => still(token) });
    for (const mount of historyBox.querySelectorAll('[data-amendment-disposition]')) {
      const form = mount.querySelector('form'), draft = historyDrafts.get(mount.dataset.amendmentDisposition);
      const open = openHistory.get(mount.dataset.amendmentDisposition);
      if (open) { mount.closest('[data-amendment-record]').open = open.record; if (mount.querySelector('details')) mount.querySelector('details').open = open.disposition; }
      if (!form || !draft) continue;
      if (draft.action && form.elements.action) { form.elements.action.value = draft.action; form.elements.action.dispatchEvent(new Event('change', { bubbles: true })); }
      for (const [name, value] of Object.entries(draft)) if (form.elements[name]) {
        if (form.elements[name].type === 'checkbox') form.elements[name].checked = value === true;
        else form.elements[name].value = value;
      }
    }
  }
  displayDocumentPage(report);
  displayHistory(report);
  async function load({ q = chooser.elements.q.value, offset = Number(query.get('offset') || 0), historyOffset = Number(query.get('historyOffset') || 0) } = {}) {
    const current = ++generation;
    error.textContent = ''; chooser.setAttribute('aria-busy', 'true');
    const request = new URLSearchParams({ mode: 'desk', registration: query.get('registration'), month, q, offset, historyOffset });
    if (selected) request.set('invoice', selected.invoiceId);
    try {
      const state = await api(`${base}?${request}`);
      if (current !== generation || !still(token) || !chooser.isConnected) return;
      report.revision = state.revision;
      if (q) query.set('q', q); else query.delete('q');
      if (state.documentPage?.offset) query.set('offset', state.documentPage.offset); else query.delete('offset');
      if (state.historyPage?.offset) query.set('historyOffset', state.historyPage.offset); else query.delete('historyOffset');
      const focused = document.activeElement, documentPagerFocused = pages.contains(focused), historyPagerFocused = focused?.matches?.('[data-history-offset]') && historyBox.contains(focused);
      displayDocumentPage(state); displayHistory(state);
      if (documentPagerFocused) pages.querySelector('button')?.focus({ preventScroll: true });
      if (historyPagerFocused) historyBox.querySelector('[data-history-offset]')?.focus({ preventScroll: true });
      history.replaceState(history.state, '', href(selected?.invoiceId || ''));
    } catch (exception) { if (current === generation && still(token)) error.textContent = exception.message; }
    finally { if (current === generation && still(token)) chooser.setAttribute('aria-busy', 'false'); }
  }
  chooser.elements.q.addEventListener('input', () => {
    clearTimeout(timer); generation++;
    timer = setTimeout(() => { if (still(token) && chooser.isConnected) load({ q: chooser.elements.q.value, offset: 0, historyOffset: 0 }); }, 180);
  });
  pages.addEventListener('click', event => {
    const button = event.target.closest('[data-document-offset]');
    if (button) { clearTimeout(timer); load({ offset: Number(button.dataset.documentOffset) }); }
  });
  historyBox.addEventListener('click', event => {
    const button = event.target.closest('[data-history-offset]');
    if (button) { clearTimeout(timer); load({ historyOffset: Number(button.dataset.historyOffset) }); }
  });
}

async function bindReview(context) {
  const { root, api, esc, still, token, base, report, route, registration, selected, month, book, href, flashKey } = context;
  const form = root.querySelector('#amendment-review'), actual = normalized(selected.actual);
  const draftKey = `financer-outward-correction:${route.id}:${registration.id}:${selected.invoiceId}:${month}`;
  let preview = null, imported = null, requestId = crypto.randomUUID(), sequence = 0, busy = false;
  let rateRows = rawRates(actual.rates), hsnRows = rawHsn(actual.hsnRows || []);
  const error = form.querySelector('[data-amendment-error]'), previewBox = form.querySelector('[data-amendment-preview-result]');
  const saveButton = form.querySelector('[data-amendment-save]'), status = form.querySelector('[data-amendment-draft]');
  const rateRoot = form.querySelector('[data-amendment-rates]'), hsnRoot = form.querySelector('[data-amendment-hsn]');
  function rawRates(rows) { return rows.length ? rows.map(row => Object.fromEntries(['gstRateBps', ...RATE_FIELDS].map(field => [field, rupees(row[field] || 0)]))) : [{ gstRateBps: '', ...Object.fromEntries(RATE_FIELDS.map(field => [field, '0.00'])) }]; }
  function rawHsn(rows) { return rows.map(row => ({ hsnSac: row.hsnSac || '', uqc: row.uqc || '', quantity: row.quantity || '0', ...Object.fromEntries(['gstRateBps', 'taxablePaise', 'totalPaise', ...HEADS].map(field => [field, rupees(row[field] || 0)])), description: row.description || '' })); }
  function renderRates() {
    rateRoot.innerHTML = `<table class="amendment-rates"><thead><tr><th>GST rate %</th>${RATE_FIELDS.map(field => `<th>${esc(LABELS[field])} ₹</th>`).join('')}<th></th></tr></thead><tbody>${rateRows.map((row, index) => `<tr data-amendment-rate="${index}">${['gstRateBps', ...RATE_FIELDS].map(field => `<td><input data-rate-field="${field}" inputmode="decimal" aria-label="Previously reported ${esc(field === 'gstRateBps' ? 'GST rate' : LABELS[field])}, line ${index + 1}" value="${esc(row[field])}" required></td>`).join('')}<td><button type="button" class="ghost" data-remove-rate="${index}" aria-label="Remove reported rate line ${index + 1}"${rateRows.length === 1 ? ' disabled' : ''}>×</button></td></tr>`).join('')}</tbody></table>`;
  }
  function renderHsn() {
    const fields = ['hsnSac', 'uqc', 'quantity', 'gstRateBps', 'taxablePaise', 'totalPaise', ...HEADS, 'description'];
    const labels = { hsnSac: 'HSN / SAC', uqc: 'UQC', quantity: 'Quantity', gstRateBps: 'GST rate %', totalPaise: 'Total value ₹', description: 'Description', ...Object.fromEntries(Object.entries(LABELS).map(([key, label]) => [key, label + ' ₹'])) };
    hsnRoot.innerHTML = `<table class="amendment-hsn"><thead><tr>${fields.map(field => `<th>${esc(labels[field])}</th>`).join('')}<th></th></tr></thead><tbody>${hsnRows.map((row, index) => `<tr data-amendment-hsn-row="${index}">${fields.map(field => `<td><input data-hsn-field="${field}" value="${esc(row[field])}" aria-label="Prior HSN ${esc(labels[field])}, line ${index + 1}"${['hsnSac', 'uqc', 'description'].includes(field) ? ' maxlength="120"' : ' inputmode="decimal"'}${field === 'description' ? '' : ' required'}></td>`).join('')}<td><button type="button" class="ghost" data-remove-hsn="${index}" aria-label="Remove previous HSN line ${index + 1}">×</button></td></tr>`).join('')}</tbody></table>`;
  }
  function readOriginal() {
    const values = form.elements;
    const rates = rateRows.map((row, index) => {
      const result = Object.fromEntries(['gstRateBps', ...RATE_FIELDS].map(field => [field, amount(row[field], `${field === 'gstRateBps' ? 'GST rate' : LABELS[field]} on reported line ${index + 1}`)]));
      if (result.gstRateBps > 10000) throw new Error('The reported GST rate must be between 0% and 100%.');
      return result;
    });
    const result = { section: values.originalSection.value, number: values.originalNumber.value.trim(), date: values.originalDate.value, recipientGstin: values.originalRecipientGstin.value.trim().toUpperCase(), recipientName: values.originalRecipientName.value.trim(), placeOfSupply: values.originalPlaceOfSupply.value.trim(), reverseCharge: values.originalReverseCharge.checked,
      invoiceType: values.originalInvoiceType.value.trim(), exportType: values.originalExportType.value || null, urType: values.originalUrType.value || null, noteType: values.originalNoteType.value || null, invoiceValuePaise: amount(values.originalInvoiceValue.value, 'the previously reported invoice value'), rates,
      portCode: values.originalPortCode?.value.trim() || '', shippingBillNumber: values.originalShippingBillNumber?.value.trim() || '', shippingBillDate: values.originalShippingBillDate?.value || '' };
    if (values.hsnKnown.checked) {
      if (!hsnRows.length) throw new Error('Add the previous per-document HSN lines or clear the HSN allocation confirmation.');
      result.hsnRows = hsnRows.map((row, index) => ({ hsnSac: row.hsnSac.trim(), uqc: row.uqc.trim(), quantity: row.quantity.trim(), ...Object.fromEntries(['gstRateBps', 'taxablePaise', 'totalPaise', ...HEADS].map(field => [field, amount(row[field], `${field} on previous HSN line ${index + 1}`)])), ...(row.description.trim() ? { description: row.description.trim() } : {}) }));
    }
    return result;
  }
  const matchesImported = original => {
    if (!imported || form.elements.originalPeriod.value !== imported.period) return false;
    const compared = normalized(original);
    if (!Object.hasOwn(imported.original, 'hsnRows')) delete compared.hsnRows;
    return equal(compared, imported.original);
  };
  function readPayload() {
    const values = form.elements, originalReported = readOriginal();
    return { invoiceId: selected.invoiceId, revision: report.revision, requestId, date: values.date.value, amendmentPeriod: month, originalPeriod: values.originalPeriod.value, originalReported,
      originalFiling: { form: 'GSTR-1', confirmedFiled: values.confirmedFiled.checked, reference: values.originalFilingReference.value.trim(), filedDate: values.originalFiledDate.value, ...(matchesImported(originalReported) ? { source: imported.source } : {}) },
      evidence: { basis: values.basis.value.trim(), documentReference: values.documentReference.value.trim(), accurateBooksConfirmed: values.accurateBooksConfirmed.checked, reportedSnapshotConfirmed: values.reportedSnapshotConfirmed.checked },
      annualReturnStatus: values.annualReturnStatus.value, ...(values.annualReturnStatus.value === 'filed' ? { annualReturnFiledDate: values.annualReturnFiledDate.value } : {}), filingDate: values.filingDate.value,
      ...(values.shippingUpdateKnown?.checked ? { shippingUpdate: { portCode: values.updatedPortCode.value.trim(), shippingBillNumber: values.updatedShippingBillNumber.value.trim(), shippingBillDate: values.updatedShippingBillDate.value, documentReference: values.shippingDocumentReference.value.trim() } } : {}) };
  }
  function syncVisibility() {
    form.querySelector('[data-amendment-annual-date]').hidden = form.elements.annualReturnStatus.value !== 'filed';
    form.elements.annualReturnFiledDate.required = form.elements.annualReturnStatus.value === 'filed';
    form.querySelector('[data-amendment-hsn-editor]').hidden = !form.elements.hsnKnown.checked;
    for (const input of hsnRoot.querySelectorAll('input')) input.disabled = !form.elements.hsnKnown.checked;
    form.querySelector('[data-amendment-missing-name]').hidden = !imported || Boolean(form.elements.originalRecipientName.value.trim()) || !actual.recipientName;
    form.elements.originalRecipientGstin.required = ['b2b', 'cdnr'].includes(form.elements.originalSection.value);
    // These identities are fixed by the supported amendment section.
    for (const name of ['originalSection', 'originalReverseCharge', 'originalExportType', 'originalUrType', 'originalNoteType']) form.elements[name].disabled = true;
    form.elements.originalInvoiceType.readOnly = true;
    form.elements.originalRecipientGstin.readOnly = ['b2b', 'cdnr'].includes(actual.section);
    form.elements.originalPlaceOfSupply.readOnly = ['b2cl', 'cdnr', 'cdnur'].includes(actual.section);
    const shipping = form.querySelector('[data-amendment-shipping-update]');
    if (shipping) {
      shipping.hidden = !form.elements.shippingUpdateKnown.checked;
      for (const input of shipping.querySelectorAll('input')) { input.required = form.elements.shippingUpdateKnown.checked; input.disabled = !form.elements.shippingUpdateKnown.checked; }
    }
  }
  function showSource() {
    const target = form.querySelector('[data-amendment-source-state]');
    if (!imported) { target.innerHTML = ''; return; }
    let matches = false;
    try { matches = matchesImported(readOriginal()); } catch { /* An invalid partial edit is not an exact source match. */ }
    target.innerHTML = `<div class="amendment-source-state"><strong>${matches ? 'Imported details' : 'Modified after import'}</strong><span>${esc(imported.source.fileName)}</span><code>SHA-256 ${esc(imported.source.sha256)}</code></div><p class="amendment-help">${matches ? imported.file ? 'The original file will travel with the saved correction and company backup.' : 'Reselect the original file to preserve its bytes with this saved correction.' : 'These entries differ from the imported document. Review them against your evidence before saving.'}</p><button type="button" class="ghost" data-use-manual-evidence>Use manual evidence instead</button>`;
    target.querySelector('[data-use-manual-evidence]').addEventListener('click', () => {
      if (!form.elements.documentReference.value.trim()) form.elements.documentReference.value = imported.source.fileName + ' · SHA-256 ' + imported.source.sha256;
      imported = null; draftSourceFiles.delete(draftKey); changed();
    });
  }
  function remember() {
    const fields = Object.fromEntries([...form.querySelectorAll('[name]')].map(input => [input.name, input.type === 'checkbox' ? input.checked : input.value]));
    try { localStorage.setItem(draftKey, JSON.stringify({ fields, rateRows, hsnRows, imported: imported ? { period: imported.period, original: imported.original, source: imported.source } : null, requestId })); status.textContent = 'Draft kept on this Mac for this document and correction period.'; }
    catch { status.textContent = 'Keep this page open while finishing this correction.'; }
  }
  function updateComparison() {
    try { form.querySelector('[data-amendment-comparison]').innerHTML = comparison(actual, readOriginal(), esc); }
    catch (exception) { form.querySelector('[data-amendment-comparison]').innerHTML = `<p class="amendment-help">${esc(exception.message)}</p>`; }
  }
  function changed() {
    sequence++; preview = null; saveButton.disabled = true; previewBox.replaceChildren(); error.textContent = ''; requestId = crypto.randomUUID();
    syncVisibility(); showSource(); updateComparison(); remember();
  }
  function assignOriginal(snapshot) {
    const value = normalized(snapshot), fields = { originalSection: value.section, originalNumber: value.number, originalDate: value.date, originalRecipientGstin: value.recipientGstin, originalRecipientName: value.recipientName, originalPlaceOfSupply: value.placeOfSupply, originalInvoiceType: value.invoiceType, originalExportType: value.exportType || '', originalUrType: value.urType || '', originalNoteType: value.noteType || '', originalInvoiceValue: rupees(value.invoiceValuePaise), originalPortCode: value.portCode, originalShippingBillNumber: value.shippingBillNumber, originalShippingBillDate: value.shippingBillDate };
    for (const [name, entry] of Object.entries(fields)) if (form.elements[name]) form.elements[name].value = entry;
    form.elements.originalReverseCharge.checked = value.reverseCharge;
    form.elements.hsnKnown.checked = Boolean(value.hsnRows);
    rateRows = rawRates(value.rates); hsnRows = rawHsn(value.hsnRows || []); renderRates(); renderHsn();
  }
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey) || 'null');
    if (draft) {
      for (const [name, value] of Object.entries(draft.fields || {})) if (form.elements[name]) {
        if (form.elements[name].type === 'checkbox') form.elements[name].checked = value === true;
        else form.elements[name].value = value;
      }
      rateRows = draft.rateRows || rateRows; hsnRows = draft.hsnRows || hsnRows; requestId = draft.requestId || requestId;
      imported = draft.imported ? { ...draft.imported, file: draftSourceFiles.get(draftKey) || null } : null;
      status.textContent = 'Restored the draft for this document and correction period.';
    }
  } catch { /* A malformed local draft does not replace the posted source. */ }
  renderRates(); renderHsn(); syncVisibility(); showSource(); updateComparison();
  rateRoot.addEventListener('input', event => {
    const input = event.target.closest('[data-rate-field]');
    if (!input) return;
    rateRows[Number(input.closest('[data-amendment-rate]').dataset.amendmentRate)][input.dataset.rateField] = input.value;
    changed();
  });
  rateRoot.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-rate]'); if (!button) return;
    rateRows.splice(Number(button.dataset.removeRate), 1); renderRates(); changed();
  });
  hsnRoot.addEventListener('input', event => {
    const input = event.target.closest('[data-hsn-field]'); if (!input) return;
    hsnRows[Number(input.closest('[data-amendment-hsn-row]').dataset.amendmentHsnRow)][input.dataset.hsnField] = input.value;
    changed();
  });
  hsnRoot.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-hsn]'); if (!button) return;
    hsnRows.splice(Number(button.dataset.removeHsn), 1); renderHsn(); changed();
  });
  form.addEventListener('input', event => { if (event.target.name) changed(); });
  form.addEventListener('change', event => { if (event.target.name) changed(); });
  form.querySelector('[data-add-amendment-rate]').addEventListener('click', () => { rateRows.push(rawRates([])[0]); renderRates(); changed(); });
  form.querySelector('[data-copy-book-rates]').addEventListener('click', () => { rateRows = rawRates(actual.rates); renderRates(); changed(); });
  const addHsn = () => { hsnRows.push({ hsnSac: '', uqc: '', quantity: '0', ...Object.fromEntries(['gstRateBps', 'taxablePaise', 'totalPaise', ...HEADS].map(field => [field, '0.00'])), description: '' }); renderHsn(); changed(); };
  form.querySelector('[data-add-amendment-hsn]').addEventListener('click', addHsn);
  form.querySelector('[data-copy-book-hsn]').addEventListener('click', () => {
    if (!actual.hsnRows?.length) { error.textContent = 'No per-document book HSN allocation is available to copy. Enter the prior evidence explicitly.'; return; }
    hsnRows = rawHsn(actual.hsnRows); renderHsn(); changed();
  });
  form.querySelector('[data-use-book-name]').addEventListener('click', () => {
    form.elements.originalRecipientName.value = actual.recipientName;
    form.elements.basis.value = (form.elements.basis.value.trim() + '\nRecipient name copied from the posted document.').trim();
    changed();
  });
  const periodForm = root.querySelector('#amendment-period');
  periodForm.addEventListener('submit', () => { remember(); });
  let lockedControls = [];
  function busyControls(value, lockForm = false) {
    busy = value;
    if (value && lockForm) {
      lockedControls = [...root.querySelectorAll('#amendment-review input, #amendment-review select, #amendment-review textarea, #amendment-review button, #amendment-period input, #amendment-period select, #amendment-period button, #amendment-document-form input, #amendment-document-form select')].filter(control => !control.disabled);
      for (const control of lockedControls) control.disabled = true;
    } else if (!value) {
      for (const control of lockedControls) control.disabled = false;
      lockedControls = [];
      syncVisibility();
    }
    form.querySelector('[data-amendment-preview]').disabled = value;
    saveButton.disabled = value || !preview;
    form.setAttribute('aria-busy', String(value));
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !form.reportValidity()) return;
    const current = ++sequence;
    error.textContent = ''; preview = null; previewBox.textContent = 'Checking the reported details and correction period…';
    try {
      const payload = readPayload(); busyControls(true);
      const result = await api(base + '/preview', { method: 'POST', body: payload });
      if (!still(token) || current !== sequence) return;
      preview = result;
      previewBox.innerHTML = `<h2>Correction preview · ${esc(result.record.section.toUpperCase())}</h2><p>Original return ${esc(result.record.originalPeriod)} · Correction return ${esc(result.record.amendmentPeriod)} · Planned filing ${dateLabel(payload.filingDate)}</p>${comparison(result.record.revised, result.record.originalReported, esc)}${shippingComparison(result.record.originalReported, result.record.revised, esc)}<p class="amendment-help">Latest filing date from the recorded timing review: ${dateLabel(result.record.cutoff?.latestFilingDate)}.</p>`;
    } catch (exception) { if (still(token)) { previewBox.replaceChildren(); error.textContent = exception.message; error.scrollIntoView({ block: 'nearest' }); } }
    finally { if (still(token)) busyControls(false); }
  });
  saveButton.addEventListener('click', async () => {
    if (busy || !preview || !form.reportValidity()) return;
    try {
      const payload = { ...readPayload(), previewHash: preview.previewHash };
      busyControls(true, true); error.textContent = '';
      if (payload.originalFiling.source) {
        if (!imported.file) throw new Error('Reselect the original return file before saving its linked source.');
        const { encodeFiledReturnFile } = await import('/gst-filed-source-ui.js');
        payload.sourceFileBase64 = await encodeFiledReturnFile(imported.file);
      }
      await api(base + '/save', { method: 'POST', body: payload });
      localStorage.removeItem(draftKey); draftSourceFiles.delete(draftKey);
      sessionStorage.setItem(flashKey, 'Correction record saved. The posted document is unchanged.');
      if (!still(token)) return;
      const destination = href(selected.invoiceId);
      if (location.hash !== destination) location.hash = destination;
      else await viewGstAmendments({ ...route, detail: selected.invoiceId }, token, context);
    } catch (exception) { if (still(token)) { error.textContent = exception.message; busyControls(false); } }
  });
  try {
    const { mountFiledReturnPicker } = await import('/gst-filed-source-ui.js');
    if (!still(token)) return;
    mountFiledReturnPicker(form.querySelector('#amendment-source-file'), { gstin: registration.gstin, section: actual.section, onSelect: value => {
      if (!still(token) || busy) return;
      assignOriginal(value.original); form.elements.originalPeriod.value = value.period;
      imported = { period: value.period, original: normalized(value.original), source: { fileName: value.filename, sha256: value.digest, ...(value.documentKey ? { documentKey: value.documentKey } : {}), section: value.section || value.original.section, sourcePeriod: value.period, bytes: value.bytes }, file: value.file };
      draftSourceFiles.set(draftKey, value.file);
      if (!form.elements.documentReference.value.trim()) form.elements.documentReference.value = value.filename;
      changed();
    } });
  } catch (exception) { if (still(token)) form.querySelector('#amendment-source-file').textContent = 'Enter the previous-filing details from your evidence below.'; }
}
