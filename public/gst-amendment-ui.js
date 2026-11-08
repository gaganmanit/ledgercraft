import { formatINR, fyLabel, parseRupees, todayISO } from '/money.js';
import { mountAmendmentDispositions } from '/gst-amendment-disposition.js';

const HEADS = ['igstPaise', 'cgstPaise', 'sgstPaise', 'utgstPaise', 'cessPaise'];
const RATE_FIELDS = ['taxablePaise', ...HEADS];
const LABELS = { taxablePaise: 'Taxable value', igstPaise: 'IGST', cgstPaise: 'CGST', sgstPaise: 'SGST', utgstPaise: 'UTGST', cessPaise: 'Cess', invoiceValuePaise: 'Invoice value' };
const SECTIONS = { b2b: 'Registered recipient (B2B)', b2cl: 'Large interstate consumer invoice (B2CL)', exp: 'Export invoice', cdnr: 'Registered credit or debit note', cdnur: 'Unregistered credit or debit note' };
const STATUS = { prepared: ['warn', 'Prepared'], withdrawn: ['', 'Withdrawn'], filed: ['ok', 'External filing recorded'] };
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FY_MONTHS = ['04', '05', '06', '07', '08', '09', '10', '11', '12', '01', '02', '03'];
const GST_FIRST_FY = 2017;
const draftSourceFiles = new Map();
let printScope = null, printBound = false;
const printOpened = [];
const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('-') : value || '—';
const validMonth = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value || '');
const fyOfMonth = value => { const [year, month] = value.split('-').map(Number); return month >= 4 ? year : year - 1; };
const monthLabel = value => validMonth(value) ? `${MONTH_NAMES[Number(value.slice(5, 7)) - 1]} ${value.slice(0, 4)}` : value || '—';
const rupees = value => Number.isSafeInteger(value) ? (value / 100).toFixed(2) : '';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const hasEntry = row => Object.values(row).some(value => { const text = String(value ?? '').trim(); return text !== '' && !/^0*(\.0*)?$/.test(text); });
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

/* A month is chosen as a financial year plus a month, because WKWebView renders type="month" as a plain text box.
   The hidden input carries the YYYY-MM value under the original field name, so form data and drafts are unchanged. */
function monthPicker(name, label, value, firstFy, esc) {
  const current = validMonth(value) ? value : '';
  const chosenFy = current ? fyOfMonth(current) : null;
  const lastFy = Math.max(fyOfMonth(todayISO().slice(0, 7)), chosenFy ?? 0);
  const startFy = Math.min(firstFy, chosenFy ?? firstFy);
  const years = [];
  for (let year = lastFy; year >= startFy; year -= 1) years.push(`<option value="${year}"${year === chosenFy ? ' selected' : ''}>FY ${esc(fyLabel(`${year}-04-01`))}</option>`);
  const chosenMonth = current.slice(5, 7);
  const months = FY_MONTHS.map(month => `<option value="${month}"${month === chosenMonth ? ' selected' : ''}>${MONTH_NAMES[Number(month) - 1]}</option>`).join('');
  const id = `amendment-${name}-label`;
  return `<div class="amendment-month" role="group" aria-labelledby="${id}" data-month-picker="${esc(name)}"><span id="${id}">${esc(label)}</span><div><select data-month-fy aria-label="${esc(label)}, financial year" required><option value="">Financial year</option>${years.join('')}</select><select data-month-mm aria-label="${esc(label)}, month" required><option value="">Month</option>${months}</select></div><input type="hidden" name="${esc(name)}" value="${esc(current)}"></div>`;
}
function refreshMonthPicker(picker) {
  const hidden = picker.querySelector('input[type=hidden]'), fySelect = picker.querySelector('[data-month-fy]'), monthSelect = picker.querySelector('[data-month-mm]');
  if (!validMonth(hidden.value)) { fySelect.value = ''; monthSelect.value = ''; return; }
  const fy = String(fyOfMonth(hidden.value));
  if (![...fySelect.options].some(option => option.value === fy)) {
    const added = new Option(`FY ${fyLabel(`${fy}-04-01`)}`, fy);
    const later = [...fySelect.options].find(option => option.value && Number(option.value) < Number(fy));
    fySelect.insertBefore(added, later || null);
  }
  fySelect.value = fy; monthSelect.value = hidden.value.slice(5, 7);
}
function bindMonthPickers(scope) {
  for (const picker of scope.querySelectorAll('[data-month-picker]')) {
    const hidden = picker.querySelector('input[type=hidden]'), fySelect = picker.querySelector('[data-month-fy]'), monthSelect = picker.querySelector('[data-month-mm]');
    const update = () => {
      const month = monthSelect.value, fy = Number(fySelect.value);
      const next = fySelect.value && month ? `${Number(month) >= 4 ? fy : fy + 1}-${month}` : '';
      if (next === hidden.value) return;
      hidden.value = next;
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
    };
    fySelect.addEventListener('change', update);
    monthSelect.addEventListener('change', update);
  }
}
function setMonth(form, name, value) {
  form.elements[name].value = value;
  const picker = form.querySelector(`[data-month-picker="${name}"]`);
  if (picker) refreshMonthPicker(picker);
}

/* Closed details do not print, so the saved history and posted tax lines open for printing and close again afterwards. */
function preparePrint(scope) {
  printScope = scope;
  if (printBound) return;
  printBound = true;
  window.addEventListener('beforeprint', () => {
    if (!printScope?.isConnected) return;
    for (const details of printScope.querySelectorAll('[data-amendment-record]:not([open]), details[data-print-open]:not([open])')) { details.open = true; printOpened.push(details); }
  });
  window.addEventListener('afterprint', () => { for (const details of printOpened.splice(0)) details.open = false; });
}

function comparison(book, reported, esc) {
  const fields = ['invoiceValuePaise', 'taxablePaise', ...HEADS];
  const money = value => Number.isSafeInteger(value) ? esc(formatINR(value)) : '—';
  return `<div class="table-scroll"><table class="amendment-comparison"><thead><tr><th>Particular</th><th class="figure">Posted books (₹)</th><th class="figure">Previously filed (₹)</th><th class="figure">Correction difference (₹)</th></tr></thead><tbody>${fields.map(field => {
    const actual = total(book, field), prior = total(reported, field), delta = actual === null || prior === null ? null : (actual - prior) * (book?.noteType === 'C' ? -1 : 1);
    return `<tr><th scope="row">${esc(LABELS[field])}</th><td class="figure">${money(actual)}</td><td class="figure">${money(prior)}</td><td class="figure">${delta > 0 ? '+' : ''}${money(delta)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function snapshotRates(snapshot, esc) {
  return `<div class="table-scroll"><table class="amendment-lines"><thead><tr><th class="amendment-num">GST rate (%)</th>${RATE_FIELDS.map(field => `<th class="figure">${esc(LABELS[field])} (₹)</th>`).join('')}</tr></thead><tbody>${(snapshot?.rates || []).map(row => `<tr><td class="amendment-num">${rupees(row.gstRateBps)}</td>${RATE_FIELDS.map(field => `<td class="figure">${esc(formatINR(row[field] || 0))}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${RATE_FIELDS.length + 1}" class="quiet">No rate lines were recorded.</td></tr>`}</tbody></table></div>`;
}
function shippingComparison(reported, revised, esc) {
  if (revised?.section !== 'exp') return '';
  const fields = [['portCode', 'Port code'], ['shippingBillNumber', 'Shipping bill number'], ['shippingBillDate', 'Shipping bill date']];
  const cell = (snapshot, field) => field === 'shippingBillDate' ? esc(dateLabel(snapshot[field])) : snapshot[field] ? `<span class="code">${esc(snapshot[field])}</span>` : '—';
  return `<h3>Shipping details for the correction return</h3><div class="table-scroll"><table><thead><tr><th>Particular</th><th>Previously reported</th><th>Correction return</th></tr></thead><tbody>${fields.map(([field, label]) => `<tr><th scope="row">${label}</th><td>${cell(reported, field)}</td><td>${cell(revised, field)}</td></tr>`).join('')}</tbody></table></div>`;
}
function dispositionMarkup(record, esc) {
  if (!record.disposition) return '';
  return `<dl class="kv"><dt>Status recorded on</dt><dd>${esc(dateLabel(record.disposition.date))}</dd><dt>Status reference</dt><dd class="code">${esc(record.disposition.reference)}</dd><dt>Status evidence</dt><dd>${esc(record.disposition.basis)}</dd>${record.filing ? `<dt>External GSTR-1 return</dt><dd>${esc(monthLabel(record.filing.period))}</dd><dt>Filed on</dt><dd>${esc(dateLabel(record.filing.filedDate))}</dd><dt>Filing reference</dt><dd class="code">${esc(record.filing.reference)}</dd>` : ''}</dl>`;
}
function documentOptions(documents, selected, esc) {
  const outsidePage = selected && !documents.some(row => row.invoiceId === selected.invoiceId);
  const entries = outsidePage ? [selected, ...documents] : documents;
  return entries.map(row => `<option value="${esc(row.invoiceId)}"${row.invoiceId === selected?.invoiceId ? ' selected' : ''}>${outsidePage && row.invoiceId === selected.invoiceId ? 'Selected: ' : ''}${esc(`${row.type} ${row.number}, ${dateLabel(row.date)}, ${row.partyName}`)}</option>`).join('') || '<option value="">No matching outward documents</option>';
}

export async function viewGstAmendments(route, token, ui) {
  if (route.name !== 'gst-amendments') return false;
  const { root, api, esc, still, page, readPeriod } = ui;
  const book = `#/c/${encodeURIComponent(route.id)}`, base = `/api/companies/${encodeURIComponent(route.id)}/gst/amendments`;
  const { company, registrations } = await api(`/api/companies/${encodeURIComponent(route.id)}/gst/registrations`);
  if (!still(token)) return true;
  document.title = `Return corrections · ${company.name}`;
  if (!registrations.length) {
    root.innerHTML = page({ company, title: 'Return corrections', body: `<p class="empty">Add the business GST registration in GST setup, then come back here to review outward return corrections.</p><p class="actions"><a class="button" href="${book}/gst">Open GST setup</a></p>` });
    return true;
  }
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const booksTo = readPeriod ? readPeriod(company).to : todayISO();
  const registrationId = params.get('registration') || registrations[0].id, month = validMonth(params.get('month')) ? params.get('month') : booksTo.slice(0, 7);
  const firstFy = Math.max(GST_FIRST_FY, fyOfMonth((company.booksFrom || todayISO()).slice(0, 7)));
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
  const period = `<form id="amendment-period" class="toolbar amendment-period"><label>Registration<select name="registration">${registrations.map(row => option(row.id, `${row.name} (${row.gstin})`, registration.id)).join('')}</select></label>${monthPicker('month', 'Correction return period', month, firstFy, esc)}<button type="submit">Show corrections</button></form>`;
  const choose = `<form id="amendment-document-form" class="toolbar amendment-choose"><label class="grow">Find a posted outward document<input name="q" type="search" autocomplete="off" placeholder="Number, recipient or evidence reference" value="${esc(query.get('q') || '')}"></label><label class="grow">Posted document<select name="invoiceId" aria-describedby="amendment-document-count">${documentOptions(documents, selected, esc)}</select></label><button type="button" class="ghost" data-open-amendment-document>Open document</button><div class="amendment-pages" data-amendment-document-pages></div><p id="amendment-document-count" class="form-note amendment-transient" role="status"></p><p class="form-message alert" data-amendment-browser-error role="alert"></p></form>`;
  const actual = selected?.actual;
  const prior = actual ? normalized(actual) : null;
  const noDocuments = query.get('q')
    ? '<p class="empty">No posted outward document matches this search. Clear the search box above to see every document.</p>'
    : `<p class="empty">No posted outward documents are available for this registration. Post a sales invoice, then choose it here.</p><p class="actions"><a class="button" href="${book}/gst-invoice">New invoice</a></p>`;
  const review = selected && !saved && selected.supported ? `<section class="subsection amendment-review-section"><h2>Previous filing and corrected books</h2><p>Record what was filed, then compare it with the posted document. Saving creates an outward return correction record. The posted invoice stays as it is.</p>
    <form id="amendment-review" class="form-grid amendment-form">
      <fieldset><legend>Earlier GSTR-1 filing</legend><div class="form-grid">
        ${monthPicker('originalPeriod', 'Original reported period', actual.date.slice(0, 7), firstFy, esc)}${field('originalFilingReference', 'Original filing reference', '', 'required maxlength="240" spellcheck="false"')}
        ${field('originalFiledDate', 'Original GSTR-1 filing date', '', 'type="date" required')}<label class="check"><input type="checkbox" name="confirmedFiled" required><span>The original GSTR-1 was filed, supported by the reference above.</span></label><div id="amendment-source-file" class="wide amendment-source-file"></div><div class="wide" data-amendment-source-state></div>
      </div></fieldset>
      <fieldset><legend>Previously reported document</legend><div class="form-grid">
        <label>Original return table<select name="originalSection">${Object.entries(SECTIONS).map(([key, label]) => option(key, label, actual.section)).join('')}</select></label>${field('originalNumber', 'Reported document number', prior.number, 'class="code" required maxlength="24" spellcheck="false"')}
        ${field('originalDate', 'Reported document date', prior.date, 'type="date" required')}${field('originalRecipientGstin', 'Reported recipient GSTIN', prior.recipientGstin, 'class="code" maxlength="15" autocapitalize="characters" spellcheck="false"')}
        ${field('originalRecipientName', 'Reported recipient name', prior.recipientName, 'maxlength="120"')}${field('originalPlaceOfSupply', 'Reported place-of-supply code', prior.placeOfSupply, 'class="code" required inputmode="numeric" pattern="[0-9]{2}" maxlength="2"')}
        <div class="wide amendment-inline" data-amendment-missing-name hidden><button class="ghost" type="button" data-use-book-name>Use book recipient name</button><span class="form-note">This adds the recipient name from the posted document and notes it in the reason.</span></div>
        ${field('originalInvoiceType', 'Reported invoice type', prior.invoiceType, 'maxlength="100"')}<label>Reported export type<select name="originalExportType"><option value="">Not an export</option>${option('WPAY', 'With payment of tax', prior.exportType)}${option('WOPAY', 'Without payment of tax', prior.exportType)}</select></label>
        <label>Unregistered note supply<select name="originalUrType"><option value="">Not applicable</option>${['B2CL', 'EXPWP', 'EXPWOP'].map(value => option(value, value, prior.urType)).join('')}</select></label><label>Note type<select name="originalNoteType"><option value="">Invoice</option>${option('C', 'Credit note', prior.noteType)}${option('D', 'Debit note', prior.noteType)}</select></label>
        ${field('originalInvoiceValue', 'Previously reported total invoice value (₹)', rupees(prior.invoiceValuePaise), 'inputmode="decimal" required')}
        <label class="check"><input type="checkbox" name="originalReverseCharge"${prior.reverseCharge ? ' checked' : ''}><span>Reported as reverse charge</span></label>
      </div>${actual.section === 'exp' ? `<h3>Previously reported shipping particulars</h3><div class="form-grid">${field('originalPortCode', 'Reported port code', prior.portCode, 'class="code" maxlength="20" spellcheck="false"')}${field('originalShippingBillNumber', 'Reported shipping bill number', prior.shippingBillNumber, 'class="code" maxlength="30" spellcheck="false"')}${field('originalShippingBillDate', 'Reported shipping bill date', prior.shippingBillDate, 'type="date"')}</div>` : ''}<h3>Original rate and tax lines</h3><div class="table-scroll" data-amendment-rates></div><div class="actions"><button type="button" class="ghost" data-add-amendment-rate>Add reported rate line</button><button type="button" class="ghost" data-copy-book-rates>Copy book tax lines</button></div></fieldset>
      ${actual.section === 'exp' ? `<fieldset><legend>Later available shipping bill</legend><label class="check"><input type="checkbox" name="shippingUpdateKnown"><span>Include a later available shipping bill supported by customs evidence.</span></label><div class="form-grid" data-amendment-shipping-update hidden>${field('updatedPortCode', 'Port code', actual.portCode || '', 'class="code" maxlength="6" spellcheck="false"')}${field('updatedShippingBillNumber', 'Shipping bill number', actual.shippingBillNumber || '', 'class="code" maxlength="7" spellcheck="false"')}${field('updatedShippingBillDate', 'Shipping bill date', actual.shippingBillDate || '', 'type="date"')}${field('shippingDocumentReference', 'Customs evidence reference', '', 'maxlength="240"')}</div></fieldset>` : ''}
      <div class="wide details-list amendment-hsn-details"><details><summary>Previous per-document HSN allocation</summary><label class="check"><input type="checkbox" name="hsnKnown"><span>I have the previous filing's HSN allocation for this document.</span></label><p class="form-note">Leave this unticked when only an aggregate Table 12 is available. The return workbook will show the missing allocation.</p><div data-amendment-hsn-editor hidden><div class="table-scroll" data-amendment-hsn></div><div class="actions"><button type="button" class="ghost" data-add-amendment-hsn>Add prior HSN line</button><button type="button" class="ghost" data-copy-book-hsn>Copy book HSN lines</button></div></div></details></div>
      <fieldset><legend>Correction period and evidence</legend><div class="form-grid">
        ${field('date', 'Correction record date', todayISO(), 'type="date" required')}${field('filingDate', 'Planned GSTR-1 filing date', '', 'type="date" required')}
        <label>Relevant annual return<select name="annualReturnStatus" required><option value="">Choose reviewed status</option><option value="not-filed">Not filed</option><option value="filed">Filed</option></select></label><label data-amendment-annual-date hidden>Annual return filing date<input type="date" name="annualReturnFiledDate"></label>
        <label class="wide">Reason and evidence basis<textarea name="basis" required maxlength="1000"></textarea></label>${field('documentReference', 'Evidence document reference', '', 'required maxlength="500"')}
        <label class="wide check"><input type="checkbox" name="accurateBooksConfirmed" required><span>The posted document and its tax lines are correct.</span></label>
        <label class="wide check"><input type="checkbox" name="reportedSnapshotConfirmed" required><span>The previous-filing particulars and rate lines match the filed GSTR-1 evidence.</span></label>
      </div></fieldset>
      <div class="wide" data-amendment-comparison></div><p class="wide form-note amendment-transient" data-amendment-draft role="status"></p>
      <div class="wide actions"><button type="submit" data-amendment-preview>Preview correction</button><button type="button" data-amendment-save disabled>Save correction record</button></div><p class="wide form-message alert" data-amendment-error role="alert"></p><div class="wide amendment-preview" data-amendment-preview-result aria-live="polite"></div>
    </form></section>` : saved ? `<p class="notice">A correction for this document is saved in the ${esc(monthLabel(saved.amendmentPeriod))} return. Its record is in the history below and cannot be edited.</p>` : selected ? `<p class="notice">${esc(selected.reason || 'This posted document is not supported for the selected outward correction workflow.')} Choose another posted document above to record a correction.</p>` : noDocuments;
  const identity = selected ? `<div class="amendment-identity"><strong>${esc(selected.type)} <span class="code">${esc(selected.number)}</span></strong><span>${esc(dateLabel(selected.date))}</span><span>${esc(selected.partyName)}</span><a href="${book}/gst-document/${encodeURIComponent(selected.invoiceId)}">Open posted document</a></div><div class="details-list"><details data-print-open><summary>Posted book tax lines</summary>${snapshotRates(actual, esc)}</details></div>` : '';
  const sources = report.sources?.length ? `<div class="details-list amendment-sources"><details><summary>Reporting sources</summary><ul>${report.sources.map(source => `<li><a href="${esc(source.url || source)}" target="_blank" rel="noreferrer">${esc(source.title || source.url || source)}</a></li>`).join('')}</ul></details></div>` : '';
  root.innerHTML = page({ company, title: 'Return corrections', lede: 'Record an earlier GSTR-1 filing against the corrected posted document, preview the difference, and keep the correction for the return month you choose.', body: `<div class="amendment-workspace"><div class="sheet-tools amendment-back"><a href="${book}/gst-returns?${new URLSearchParams({ registration: registration.id, month })}">Back to GST returns</a><button type="button" class="ghost" data-print-sheet>Print history</button></div>${period}${flash ? `<p class="status" role="status">${esc(flash)}</p>` : ''}${choose}${identity}${review}<section class="subsection amendment-history" data-amendment-history><h2>Saved correction history</h2>${historyMarkup(records, selected, month, book, query, esc, `/api/companies/${encodeURIComponent(route.id)}`, Boolean(query.get('q')))}</section>${sources}</div>` });
  preparePrint(root.querySelector('.amendment-workspace'));
  const periodForm = root.querySelector('#amendment-period');
  bindMonthPickers(periodForm);
  periodForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!validMonth(periodForm.elements.month.value)) { periodForm.reportValidity(); return; }
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
  if (!visible.length) return `<p class="empty">${allMatches ? 'No saved correction matches this search. Clear the search box above to see the history for this period.' : 'No correction records for this period or document yet. Preview and save a correction above to start one.'}</p>`;
  return `<div class="details-list">${visible.slice().reverse().map(record => {
    const [tone, word] = STATUS[record.effectiveStatus || record.status] || ['', record.status];
    const table = record.section ? ` in table <span class="code">${esc(record.section.toUpperCase())}</span>` : '';
    return `<details data-amendment-record="${esc(record.id)}"><summary><span class="amendment-record-title"><strong>Correction to <span class="code">${esc(record.revised.number)}</span>${table}</strong><small>Correction return ${esc(monthLabel(record.amendmentPeriod))}. Original return ${esc(monthLabel(record.originalPeriod))}. Recorded on ${esc(dateLabel(record.date))}.</small></span><span class="pill${tone ? ' ' + tone : ''}">${esc(word)}</span></summary>${dispositionMarkup(record, esc)}<h3>Books against previous filing</h3>${comparison(record.revised, record.originalReported, esc)}${shippingComparison(record.originalReported, record.revised, esc)}<h3>Previously reported rate lines</h3>${snapshotRates(record.originalReported, esc)}<h3>Saved corrected book rate lines</h3>${snapshotRates(record.revised, esc)}<dl class="kv"><dt>Original filing reference</dt><dd class="code">${esc(record.originalFiling.reference)}</dd><dt>Original filing date</dt><dd>${esc(dateLabel(record.originalFiling.filedDate))}</dd>${record.originalFiling.source ? `<dt>Original file</dt><dd class="amendment-source-reference"><a download href="${filesBase}/gst-filed-source/${encodeURIComponent(record.originalFiling.source.sha256)}">${esc(record.originalFiling.source.fileName)}</a><small class="code">SHA-256 ${esc(record.originalFiling.source.sha256)}</small></dd>` : ''}<dt>Evidence</dt><dd>${esc(record.evidence.documentReference)}</dd><dt>Reason</dt><dd>${esc(record.evidence.basis)}</dd>${record.shippingUpdate ? `<dt>Customs evidence</dt><dd>${esc(record.shippingUpdate.documentReference)}</dd>` : ''}<dt>Filing cutoff</dt><dd>${esc(dateLabel(record.cutoff?.latestFilingDate))}</dd></dl><p class="actions amendment-record-links"><a href="${book}/gst-document/${encodeURIComponent(record.invoiceId)}">Open posted document</a><a href="${book}/gst-returns?${new URLSearchParams({ registration: query.get('registration'), month: record.amendmentPeriod })}">Open the ${esc(monthLabel(record.amendmentPeriod))} return</a></p><div data-amendment-disposition="${esc(record.id)}"></div></details>`;
  }).join('')}</div>`;
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
    const buttons = `${page.offset ? `<button type="button" class="ghost" data-${type}-offset="${Math.max(0, page.offset - page.limit)}">Previous ${label}</button>` : ''}${page.offset + page.limit < page.total ? `<button type="button" class="ghost" data-${type}-offset="${page.offset + page.limit}">Next ${label}</button>` : ''}`;
    return buttons ? `<div class="actions amendment-pager">${buttons}</div>` : '';
  }
  function displayDocumentPage(state) {
    chooser.elements.invoiceId.innerHTML = documentOptions(state.documents || [], selected, esc);
    const page = state.documentPage || { offset: 0, limit: 50, total: state.documents?.length || 0 };
    pages.innerHTML = pagination(page, 'document');
    const shown = state.documents?.length || 0;
    count.textContent = page.total ? `Documents ${page.offset + 1} to ${page.offset + shown} of ${page.total}.${selected && !state.documents.some(row => row.invoiceId === selected.invoiceId) ? ' The current document stays selected although it is outside this page.' : ''}` : 'No matching outward documents. The current editor stays open.';
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
    historyBox.innerHTML = `<h2>Saved correction history</h2>${page.total ? `<p class="form-note amendment-transient" role="status" data-amendment-history-count>History ${page.offset + 1} to ${Math.min(page.offset + page.limit, page.total)} of ${page.total}.</p>` : ''}${historyMarkup(state.records || [], selected, month, book, query, esc, filesBase, Boolean(query.get('q')))}${pagination(page, 'history')}`;
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
    } catch (exception) {
      if (current === generation && still(token)) { error.textContent = exception.message; error.scrollIntoView({ block: 'nearest' }); }
    }
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
  const showError = message => { error.textContent = message; if (message) error.scrollIntoView({ block: 'nearest' }); };
  bindMonthPickers(form);
  function rawRates(rows) { return rows.length ? rows.map(row => Object.fromEntries(['gstRateBps', ...RATE_FIELDS].map(field => [field, rupees(row[field] || 0)]))) : [{ gstRateBps: '', ...Object.fromEntries(RATE_FIELDS.map(field => [field, '0.00'])) }]; }
  function rawHsn(rows) { return rows.map(row => ({ hsnSac: row.hsnSac || '', uqc: row.uqc || '', quantity: row.quantity || '0', ...Object.fromEntries(['gstRateBps', 'taxablePaise', 'totalPaise', ...HEADS].map(field => [field, rupees(row[field] || 0)])), description: row.description || '' })); }
  function renderRates() {
    rateRoot.innerHTML = `<table class="amendment-rates"><thead><tr><th class="amendment-num">GST rate (%)</th>${RATE_FIELDS.map(field => `<th class="figure">${esc(LABELS[field])} (₹)</th>`).join('')}<th><span class="sr">Remove line</span></th></tr></thead><tbody>${rateRows.map((row, index) => `<tr data-amendment-rate="${index}">${['gstRateBps', ...RATE_FIELDS].map(field => `<td${field === 'gstRateBps' ? '' : ' class="figure"'}><input data-rate-field="${field}" inputmode="decimal" aria-label="Previously reported ${esc(field === 'gstRateBps' ? 'GST rate' : LABELS[field])}, line ${index + 1}" value="${esc(row[field])}" required></td>`).join('')}<td><button type="button" class="danger" data-remove-rate="${index}" aria-label="Remove reported rate line ${index + 1}"${rateRows.length === 1 ? ' disabled' : ''}>Remove</button></td></tr>`).join('')}</tbody></table>`;
  }
  function renderHsn() {
    const fields = ['hsnSac', 'uqc', 'quantity', 'gstRateBps', 'taxablePaise', 'totalPaise', ...HEADS, 'description'];
    const money = new Set(['taxablePaise', 'totalPaise', ...HEADS]), numeric = new Set(['quantity', 'gstRateBps']);
    const labels = { hsnSac: 'HSN/SAC', uqc: 'UQC', quantity: 'Quantity', gstRateBps: 'GST rate (%)', totalPaise: 'Total value (₹)', description: 'Description', ...Object.fromEntries(Object.entries(LABELS).map(([key, label]) => [key, label + ' (₹)'])) };
    const headClass = field => money.has(field) ? ' class="figure"' : numeric.has(field) ? ' class="amendment-num"' : '';
    hsnRoot.innerHTML = `<table class="amendment-hsn"><thead><tr>${fields.map(field => `<th${headClass(field)}>${esc(labels[field])}</th>`).join('')}<th><span class="sr">Remove line</span></th></tr></thead><tbody>${hsnRows.map((row, index) => `<tr data-amendment-hsn-row="${index}">${fields.map(field => `<td${money.has(field) ? ' class="figure"' : ''}><input data-hsn-field="${field}" value="${esc(row[field])}" aria-label="Prior HSN ${esc(labels[field])}, line ${index + 1}"${['hsnSac', 'uqc'].includes(field) ? ' class="code" spellcheck="false"' : ''}${['hsnSac', 'uqc', 'description'].includes(field) ? ' maxlength="120"' : ' inputmode="decimal"'}${field === 'description' ? '' : ' required'}></td>`).join('')}<td><button type="button" class="danger" data-remove-hsn="${index}" aria-label="Remove previous HSN line ${index + 1}">Remove</button></td></tr>`).join('') || `<tr><td colspan="${fields.length + 1}" class="quiet">No previous HSN lines yet. Add a prior HSN line or copy the book HSN lines below.</td></tr>`}</tbody></table>`;
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
    if (!validMonth(values.originalPeriod.value)) throw new Error('Choose the financial year and month of the original reported period.');
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
    target.innerHTML = `<div class="amendment-source-state"><span class="pill ${matches ? 'ok' : 'warn'}">${matches ? 'Imported details' : 'Modified after import'}</span><span>${esc(imported.source.fileName)}</span><span class="code">SHA-256 ${esc(imported.source.sha256)}</span></div><p class="form-note">${matches ? imported.file ? 'The original file will travel with the saved correction and company backup.' : 'Reselect the original file to keep its bytes with this saved correction.' : 'These entries differ from the imported document. Check them against your evidence before saving.'}</p><button type="button" class="ghost" data-use-manual-evidence>Use manual evidence instead</button>`;
    target.querySelector('[data-use-manual-evidence]').addEventListener('click', () => {
      if (!form.elements.documentReference.value.trim()) form.elements.documentReference.value = `${imported.source.fileName}, SHA-256 ${imported.source.sha256}`;
      imported = null; draftSourceFiles.delete(draftKey); changed();
    });
  }
  function remember() {
    const fields = Object.fromEntries([...form.querySelectorAll('[name]')].map(input => [input.name, input.type === 'checkbox' ? input.checked : input.value]));
    try { localStorage.setItem(draftKey, JSON.stringify({ fields, rateRows, hsnRows, imported: imported ? { period: imported.period, original: imported.original, source: imported.source } : null, requestId })); status.textContent = 'Draft kept on this Mac for this document and correction period.'; }
    catch { status.textContent = 'Keep this page open while finishing this correction.'; }
  }
  function updateComparison() {
    const target = form.querySelector('[data-amendment-comparison]');
    try { target.innerHTML = `<h3>Books against previous filing</h3>${comparison(actual, readOriginal(), esc)}`; }
    catch (exception) { target.innerHTML = `<p class="form-note">${esc(exception.message)}</p>`; }
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
  for (const picker of form.querySelectorAll('[data-month-picker]')) refreshMonthPicker(picker);
  renderRates(); renderHsn(); syncVisibility(); showSource(); updateComparison();
  rateRoot.addEventListener('input', event => {
    const input = event.target.closest('[data-rate-field]');
    if (!input) return;
    rateRows[Number(input.closest('[data-amendment-rate]').dataset.amendmentRate)][input.dataset.rateField] = input.value;
    changed();
  });
  rateRoot.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-rate]'); if (!button) return;
    const index = Number(button.dataset.removeRate);
    if (hasEntry(rateRows[index]) && !confirm(`Remove reported rate line ${index + 1} and the amounts entered on it?`)) return;
    rateRows.splice(index, 1); renderRates(); changed();
  });
  hsnRoot.addEventListener('input', event => {
    const input = event.target.closest('[data-hsn-field]'); if (!input) return;
    hsnRows[Number(input.closest('[data-amendment-hsn-row]').dataset.amendmentHsnRow)][input.dataset.hsnField] = input.value;
    changed();
  });
  hsnRoot.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-hsn]'); if (!button) return;
    const index = Number(button.dataset.removeHsn);
    if (hasEntry(hsnRows[index]) && !confirm(`Remove previous HSN line ${index + 1}${hsnRows[index].hsnSac.trim() ? ` (${hsnRows[index].hsnSac.trim()})` : ''}?`)) return;
    hsnRows.splice(index, 1); renderHsn(); changed();
  });
  form.addEventListener('input', event => { if (event.target.name) changed(); });
  form.addEventListener('change', event => { if (event.target.name) changed(); });
  form.querySelector('[data-add-amendment-rate]').addEventListener('click', () => { rateRows.push(rawRates([])[0]); renderRates(); changed(); });
  form.querySelector('[data-copy-book-rates]').addEventListener('click', () => { rateRows = rawRates(actual.rates); renderRates(); changed(); });
  const addHsn = () => { hsnRows.push({ hsnSac: '', uqc: '', quantity: '0', ...Object.fromEntries(['gstRateBps', 'taxablePaise', 'totalPaise', ...HEADS].map(field => [field, '0.00'])), description: '' }); renderHsn(); changed(); };
  form.querySelector('[data-add-amendment-hsn]').addEventListener('click', addHsn);
  form.querySelector('[data-copy-book-hsn]').addEventListener('click', () => {
    if (!actual.hsnRows?.length) { showError('No per-document book HSN allocation is available to copy. Enter the prior evidence line by line.'); return; }
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
    error.textContent = ''; preview = null; previewBox.innerHTML = '<p class="form-note amendment-transient">Checking the reported details and correction period…</p>';
    try {
      const payload = readPayload(); busyControls(true);
      const result = await api(base + '/preview', { method: 'POST', body: payload });
      if (!still(token) || current !== sequence) return;
      preview = result;
      previewBox.innerHTML = `<h3>Correction preview for table <span class="code">${esc(result.record.section.toUpperCase())}</span></h3><dl class="kv"><dt>Original return</dt><dd>${esc(monthLabel(result.record.originalPeriod))}</dd><dt>Correction return</dt><dd>${esc(monthLabel(result.record.amendmentPeriod))}</dd><dt>Planned filing</dt><dd>${esc(dateLabel(payload.filingDate))}</dd><dt>Latest filing date</dt><dd>${esc(dateLabel(result.record.cutoff?.latestFilingDate))}</dd></dl>${comparison(result.record.revised, result.record.originalReported, esc)}${shippingComparison(result.record.originalReported, result.record.revised, esc)}<p class="form-note">The latest filing date comes from the recorded timing review. Save the correction record to keep it.</p>`;
    } catch (exception) { if (still(token)) { previewBox.replaceChildren(); showError(exception.message); } }
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
    } catch (exception) { if (still(token)) { busyControls(false); showError(exception.message); } }
  });
  try {
    const { mountFiledReturnPicker } = await import('/gst-filed-source-ui.js');
    if (!still(token)) return;
    mountFiledReturnPicker(form.querySelector('#amendment-source-file'), { gstin: registration.gstin, section: actual.section, onSelect: value => {
      if (!still(token) || busy) return;
      assignOriginal(value.original); setMonth(form, 'originalPeriod', value.period);
      imported = { period: value.period, original: normalized(value.original), source: { fileName: value.filename, sha256: value.digest, ...(value.documentKey ? { documentKey: value.documentKey } : {}), section: value.section || value.original.section, sourcePeriod: value.period, bytes: value.bytes }, file: value.file };
      draftSourceFiles.set(draftKey, value.file);
      if (!form.elements.documentReference.value.trim()) form.elements.documentReference.value = value.filename;
      changed();
    } });
  } catch { if (still(token)) form.querySelector('#amendment-source-file').innerHTML = '<p class="form-note">Enter the previous-filing details from your evidence below.</p>'; }
}
