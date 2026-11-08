import { formatINR, parseRupees } from '/money.js';

const HEADS = ['cgst', 'sgst', 'utgst', 'igst', 'cess'];
const ACTIONS = { claim: 'Record eligible claim', permanent: 'Record permanent ineligibility', temporary: 'Hold or reverse temporarily', reclaim: 'Reclaim previously reversed credit', 'prior-claim': 'Record a documented earlier claim', 'credit-note': 'Apply linked supplier credit note' };
const BUCKETS = { unreviewed: 'Pending review', unclaimed: 'Marked eligible, not claimed', claimable: 'Claim recorded', permanent: 'Permanent tax cost', 'temporary-hold': 'Held, never claimed', 'temporary-reversed': 'Previously claimed and reversed', 'temporary-gross': 'Gross ITC with temporary reversal' };
const BUCKET_TONE = { unreviewed: 'warn', unclaimed: 'warn', claimable: 'ok', permanent: '', 'temporary-hold': 'warn', 'temporary-reversed': 'warn', 'temporary-gross': 'warn' };
const PERMANENT = [['section17(5)', 'Section 17(5): blocked credit'], ['rule38', 'Rule 38'], ['rule42', 'Rule 42'], ['rule43', 'Rule 43'], ['section16(4)', 'Section 16(4): time limit'], ['pos-restriction', 'Place-of-supply restriction'], ['other-permanent', 'Other permanent ineligibility']];
const TEMPORARY = [['rule37', 'Rule 37: supplier-payment condition'], ['rule37A', 'Rule 37A: supplier return condition'], ['section16(2)(b)', 'Section 16(2)(b): receipt condition'], ['section16(2)(c)', 'Section 16(2)(c): tax-payment condition'], ['clerical-correction', 'Correction of an earlier inadvertent claim'], ['other-temporary', 'Other temporary reversal']];
const CHECKS = [['invoiceHeld', 'Invoice or debit note held'], ['received', 'Selected goods or services received'], ['businessUse', 'Business use and taxable-supply conditions met'], ['notBlocked', 'Section 17 blocked-credit review passed'], ['supplierReported', 'Supplier reporting condition supported'], ['supplierTaxPaid', 'Supplier tax-payment condition supported'], ['returnFurnished', 'Return-furnishing condition met'], ['paymentReview', 'Supplier-payment and 180-day conditions reviewed'], ['noTaxDepreciation', 'Tax component not claimed as depreciation']];
const total = (row = {}) => HEADS.reduce((sum, head) => sum + (row[head + 'Paise'] || 0), 0);
const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('-') : value || '—';
const DISCARD = 'Discard the decision you have started for this document?';

export async function viewPurchaseItc(route, token, ui) {
  if (route.name !== 'gst-itc') return false;
  const { root, api, still, page, esc, readPeriod } = ui;
  const companyPath = `/api/companies/${encodeURIComponent(route.id)}`;
  let to = new URLSearchParams(location.hash.split('?')[1] || '').get('to') || '';
  if (!to) {
    const meta = await api(`${companyPath}/meta`);
    if (!still(token)) return true;
    to = readPeriod(meta.company).to;
  }
  const base = `${companyPath}/gst/itc`;
  const report = await api(`${base}?to=${encodeURIComponent(to)}`);
  if (!still(token)) return true;
  const book = `#/c/${encodeURIComponent(route.id)}`;
  const money = value => esc(formatINR(value || 0));
  const documents = report.documents;
  const selected = documents.find(document => document.id === route.detail) || documents[0];
  const flashKey = `financer-itc-review:${route.id}`;
  const status = sessionStorage.getItem(flashKey) || '';
  sessionStorage.removeItem(flashKey);
  const categories = [
    ['Awaiting claim or review', ['unreviewed', 'unclaimed']], ['Claim recorded', ['claimable']],
    ['Temporary credit', ['temporary-hold', 'temporary-reversed', 'temporary-gross']], ['Permanent tax cost', ['permanent']],
  ];
  const summaries = categories.map(([label, buckets]) => `<div><dt>${esc(label)}</dt><dd>₹${money(documents.reduce((sum, document) => sum + buckets.reduce((subtotal, bucket) => subtotal + total(document.balances[bucket]), 0), 0))}</dd></div>`).join('');
  const pill = (tone, label) => `<span class="pill${tone ? ' ' + tone : ''}">${esc(label)}</span>`;
  const disposition = document => {
    if (document.type === 'Credit Note') return document.creditSettled ? pill('ok', 'Credit applied') : pill('warn', 'Credit-note review due');
    const states = Object.entries(BUCKETS).filter(([bucket]) => total(document.balances[bucket])).map(([bucket, label]) => pill(BUCKET_TONE[bucket], label));
    return states.length ? `<span class="itc-states">${states.join(' ')}</span>` : pill('ok', 'Fully credited');
  };
  const documentHref = id => `${book}/gst-itc/${encodeURIComponent(id)}?to=${encodeURIComponent(to)}`;
  const rows = documents.map(document => `<tr${document.id === selected?.id ? ' aria-selected="true"' : ''}><th scope="row"><a class="code" href="${documentHref(document.id)}">${esc(document.supplierInvoiceNumber || document.number)}</a><div class="quiet">${esc(document.partyName)}</div><div class="quiet">${esc(document.type)} dated ${esc(dateLabel(document.date))}</div></th><td class="figure">${money(document.totals.taxPaise)}</td><td class="figure">${money(total(document.balances.claimable))}</td><td>${disposition(document)}</td></tr>`).join('');
  const issues = report.issues.length ? `<div class="attention-rule"><h2>Review points</h2><ul>${report.issues.map(issue => `<li><a class="code" href="${documentHref(issue.invoiceId)}">${esc(documents.find(document => document.id === issue.invoiceId)?.supplierInvoiceNumber || issue.invoiceId)}</a>: ${esc(issue.message)}</li>`).join('')}</ul></div>` : '';
  const documentOptions = documents.map(document => `<option value="${esc(document.id)}"${document.id === selected?.id ? ' selected' : ''}>${esc(document.supplierInvoiceNumber || document.number)} (${esc(document.partyName)})</option>`).join('');
  const history = selected ? renderHistory(report, selected, esc, money, book) : '';
  const check = (name, label, extra = '') => `<label class="check${extra ? ' ' + extra : ''}"><input type="checkbox" name="${name}"><span>${esc(label)}</span></label>`;
  document.title = `Purchase ITC review · ${report.company.name}`;
  root.innerHTML = page({ company: report.company, title: 'Purchase ITC review', status,
    body: `<div class="itc-workspace"><form class="toolbar" id="itc-asof"><label>Position as of <input type="date" name="to" value="${esc(to)}" min="${esc(report.company.booksFrom)}" required></label><button type="submit" class="ghost">Show position</button></form>
      <p class="only-print">Position as of ${esc(dateLabel(to))}.</p>
      <dl class="summary-strip">${summaries}</dl>${issues}
      <div class="table-scroll"><table><thead><tr><th>Supplier document</th><th class="figure">Tax ₹</th><th class="figure">Claim recorded ₹</th><th>Disposition</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="quiet">No forward-charge purchase documents up to ${esc(dateLabel(to))}. <a href="${book}/gst-invoice">Post a purchase invoice</a> to review its credit here.</td></tr>`}</tbody></table></div>
      ${selected ? `<div class="subsection itc-entry"><div class="section-title"><h2>Record a dated decision</h2><a href="${book}/gst-document/${encodeURIComponent(selected.id)}">Open source document</a></div>
        <form id="itc-review" class="form-grid"><label class="wide">Supplier document <select name="invoiceId">${documentOptions}</select></label>
        <label>Decision <select name="action">${Object.entries(ACTIONS).filter(([action]) => selected.type === 'Credit Note' ? action === 'credit-note' : action !== 'credit-note').map(([action, label]) => `<option value="${action}">${esc(label)}</option>`).join('')}</select></label>
        <label>Decision date <input type="date" name="date" value="${esc(to)}" min="${esc(selected.date)}" required></label>
        <label>Review reference <input name="reference" maxlength="160" required></label><label>Evidence reference <input name="documentReference" maxlength="240" required></label>
        <label class="wide">Review basis <textarea name="basis" maxlength="500" rows="2" required></textarea></label>
        <label data-itc-reason>Provision <select name="reasonCode"></select></label>
        <label data-itc-context>Return context <select name="reportingMode"></select></label>
        <p class="wide form-note" data-itc-action-note></p>
        <fieldset><legend>Exact line and tax-head allocation</legend><p class="form-note">Choose the source tax disposition and the amount this decision covers.</p><div class="table-scroll itc-allocations" data-itc-allocations></div><p data-itc-total class="itc-total" aria-live="polite"></p></fieldset>
        <fieldset><legend>Source evidence</legend><label>Saved GSTR-2B document <select name="statementId"><option value="">Separate documented evidence</option></select></label><p class="form-note" data-itc-statement-status role="status">Loading saved document references…</p><p class="form-note">Confirm eligibility from the evidence below. A matching statement does not make the decision.</p></fieldset>
        <fieldset data-itc-eligibility><legend>Claim conditions</legend><div class="check-group itc-checks">${CHECKS.map(([name, label]) => check(name, label)).join('')}</div></fieldset>
        <fieldset data-itc-annual><legend>Section 16(4) timing</legend><p class="form-note">Ordinary first-claim cutoff for this document is ${esc(dateLabel(selected.claimDeadline))}, or the relevant annual return if that is earlier.</p><div class="form-grid"><label>Relevant annual return <select name="annualReturnStatus"><option value="">Choose reviewed status</option><option value="not-filed">Not filed</option><option value="filed">Filed</option></select></label><label data-itc-annual-date>Annual return filing date <input type="date" name="annualReturnFiledDate"></label></div></fieldset>
        <fieldset data-itc-temporary><legend>Recoverability</legend>${check('expectedRecoverable', 'Evidence supports recovery once the stated temporary condition is fulfilled')}</fieldset>
        <fieldset data-itc-gross><legend>Gross reporting evidence</legend>${check('grossIncluded', 'This exact tax is included in gross Table 4(A)(5) for this return period')}<label>Gross ITC evidence <input name="grossReference" maxlength="240"></label></fieldset>
        <fieldset data-itc-reclaim><legend>Reclaim conditions</legend>${check('conditionsNowMet', 'The temporary condition is now fulfilled, supported by the recorded evidence')}</fieldset>
        <fieldset data-itc-prior><legend>Historical claim evidence</legend><div class="form-grid"><label>Earlier claim date <input type="date" name="priorClaimDate" min="${esc(selected.date)}"></label><label>Filed return reference <input name="priorReturnReference" maxlength="240"></label></div>${check('priorClaimVerified', 'The earlier claim was checked against its filed return and is not reported again')}</fieldset>
        <label class="wide check" data-itc-reversal-statement><input type="checkbox" name="reversalStatementReviewed"><span>The electronic reversal statement was reconciled for reclassification to permanent ineligibility</span></label>
        <label class="wide check" data-itc-correction><input type="checkbox" name="correctIneligibility"><span>This is a documented correction of the earlier permanent ineligibility assessment</span></label>
        <div class="actions wide"><button type="submit">Record decision</button></div></form><p class="form-message alert" data-itc-error role="alert"></p></div>${history}` : ''}
      <div class="subsection itc-sources details-list"><details><summary>GST reporting sources</summary><ul>${report.sources.map(source => `<li><a href="${esc(source.url)}" target="_blank" rel="noreferrer">${esc(source.title)}</a></li>`).join('')}</ul></details></div></div>` });
  const workspace = root.querySelector('.itc-workspace');
  const dirty = () => root.querySelector('#itc-review')?.dataset.dirty === 'true';
  workspace.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (link && dirty() && !confirm(DISCARD)) event.preventDefault();
  });
  root.querySelector('#itc-asof').addEventListener('submit', event => {
    event.preventDefault();
    if (dirty() && !confirm(DISCARD)) return;
    const date = new FormData(event.currentTarget).get('to');
    location.hash = `${book}/gst-itc${selected ? '/' + encodeURIComponent(selected.id) : ''}?to=${encodeURIComponent(date)}`;
  });
  if (selected) bindReview({ ...ui, route, token, base, report, selected, book, money, flashKey });
  return true;
}

function renderHistory(report, selected, esc, money, book) {
  const records = report.records.filter(record => record.invoiceId === selected.id || record.transfers.some(transfer => transfer.invoiceId === selected.id));
  const ledgerName = id => report.ledgers.find(ledger => ledger.id === id)?.name || id;
  const statement = value => value ? `<p>Statement for ${esc(value.period)}.${value.matchStatus ? ` Match status ${esc(value.matchStatus)}.` : ''} Row <span class="code">${esc(value.rowKey)}</span>.</p>` : '';
  const serviceReceipts = list => list?.length ? `<dl class="kv" data-itc-service-receipts>${list.map(receipt => `<dt>Service received ${esc(dateLabel(receipt.date))}</dt><dd>Line ${receipt.lineIndex + 1}, ${esc(ledgerName(receipt.sourceLedgerId))}. Reference <span class="code">${esc(receipt.reference)}</span>.</dd>`).join('')}</dl>` : '';
  return `<div class="subsection itc-history"><h2>Review history</h2>${records.length ? `<div class="details-list">${records.map(record => `<details data-itc-record="${esc(record.id)}"><summary><span class="date-cell">${esc(dateLabel(record.date))}</span><span>${esc(ACTIONS[record.action])}</span><small class="code">${esc(record.reference)}</small><span class="itc-amount">₹${money(total(record.components))}</span></summary><p>${esc(record.evidence.basis)}</p><p>Evidence <span class="code">${esc(record.evidence.documentReference)}</span></p>${serviceReceipts(record.evidence.serviceReceipts)}${statement(record.evidence.statement)}<div class="table-scroll"><table><caption>Accounting entry</caption><thead><tr><th>Ledger</th><th>Side</th><th class="figure">Amount ₹</th></tr></thead><tbody>${record.postingLines.map(line => `<tr><td>${esc(ledgerName(line.ledgerId))}</td><td>${esc(line.dc)}</td><td class="figure">${money(line.paise)}</td></tr>`).join('') || '<tr><td colspan="3" class="quiet">Evidence recorded. No additional accounting entry was needed.</td></tr>'}</tbody></table></div><div class="table-scroll"><table><caption>Return working paper</caption><thead><tr><th>Table</th><th>Direction</th>${HEADS.map(head => `<th class="figure">${head.toUpperCase()} ₹</th>`).join('')}</tr></thead><tbody>${record.returnRows.map(row => `<tr><td>${esc(row.table)}</td><td>${row.sign < 0 ? 'Reduction' : 'Addition'}${row.table.startsWith('4D') ? ' (information only)' : ''}</td>${HEADS.map(head => `<td class="figure">${money(row[head + 'Paise'])}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="7" class="quiet">No new return claim or reversal was recorded.</td></tr>'}</tbody></table></div>${record.voucherId ? `<p><a href="${book}/v/Journal/${encodeURIComponent(record.voucherId)}">Open accounting entry</a></p>` : ''}</details>`).join('')}</div>` : '<p class="empty">No dated ITC decisions are recorded for this document. Record one with the form above.</p>'}</div>`;
}

function bindReview(ctx) {
  const { root, api, still, token, route, base, report, selected, book, esc, money, flashKey } = ctx;
  const form = root.querySelector('#itc-review');
  const error = root.querySelector('[data-itc-error]');
  const saveButton = form.querySelector('button[type=submit]');
  const amountRoot = form.querySelector('[data-itc-allocations]');
  let candidates = [], allocationRows = [];
  const visible = (selector, show) => { form.querySelector(selector).hidden = !show; };
  const sourceOptions = action => action === 'claim' || action === 'prior-claim' ? ['unreviewed', 'unclaimed', 'temporary-hold', ...(form.elements.correctIneligibility.checked ? ['permanent'] : [])] : action === 'temporary' ? ['claimable', 'unreviewed', 'unclaimed'] : action === 'reclaim' ? ['temporary-reversed', 'temporary-gross'] : ['claimable', 'unreviewed', 'unclaimed', 'temporary-hold', 'temporary-reversed', 'temporary-gross', ...(selected.initialEligibility === 'ineligible' ? ['permanent'] : [])];
  const chosenStatement = () => form.elements.statementId.value === '' ? null : candidates[Number(form.elements.statementId.value)] || null;
  const activeRows = () => [...amountRoot.querySelectorAll('[data-itc-row]')].filter(row => row.querySelector('[data-itc-choose]').checked);
  const needsServiceReceipt = () => ['claim', 'reclaim', 'prior-claim'].includes(form.elements.action.value) || form.elements.reportingMode.value === 'gross-and-reversal';
  const updateTotal = () => {
    let amount = 0;
    try { for (const row of activeRows()) for (const head of HEADS) amount += parseRupees(row.querySelector(`[data-itc-head="${head}"]`).value || '0'); }
    catch { form.querySelector('[data-itc-total]').textContent = 'Enter amounts in rupees and paise.'; return; }
    form.querySelector('[data-itc-total]').textContent = `Decision amount ₹${formatINR(amount)}`;
    const unavailable = chosenStatement()?.availability === 'N' && ['claim', 'reclaim', 'prior-claim'].includes(form.elements.action.value);
    const claimDate = form.elements.action.value === 'prior-claim' ? form.elements.priorClaimDate.value : form.elements.date.value;
    const pendingReceipt = needsServiceReceipt() && activeRows().some(row => {
      const receipt = allocationRows[Number(row.dataset.itcRow)].serviceReceipt;
      if (!receipt) return false;
      if (receipt.status === 'confirmed') return !claimDate || receipt.date > claimDate;
      const fields = amountRoot.querySelector(`[data-itc-service-receipt="${receipt.lineIndex}"]`);
      return !fields?.querySelector('[data-itc-service-received]')?.checked || !fields.querySelector('[data-itc-service-date]')?.value || fields.querySelector('[data-itc-service-date]').value > claimDate || !fields.querySelector('[data-itc-service-reference]')?.value.trim();
    });
    saveButton.disabled = !amount || unavailable || pendingReceipt || selected.type === 'Credit Note' && selected.creditSettled;
  };
  function renderAllocations() {
    const action = form.elements.action.value;
    allocationRows = [];
    if (action === 'credit-note') {
      const familyId = selected.originalInvoiceId;
      for (const noteLine of selected.lines) {
        const matching = report.documents.filter(document => document.type !== 'Credit Note' && (document.id === familyId || document.originalInvoiceId === familyId));
        const options = matching.flatMap(document => document.lines.filter(line => line.itemId === noteLine.itemId && (noteLine.originalLineIndex == null || line.originalLineIndex === noteLine.originalLineIndex) && line.gstRateBps === noteLine.gstRateBps && line.cessRateBps === noteLine.cessRateBps).flatMap(line => Object.keys(BUCKETS).filter(bucket => total(line.balances[bucket])).map(bucket => ({ document, line, bucket }))));
        for (const option of options) allocationRows.push({ invoiceId: option.document.id, lineIndex: option.line.lineIndex, noteLineIndex: noteLine.lineIndex, bucket: option.bucket,
          label: `${option.document.supplierInvoiceNumber || option.document.number}, line ${option.line.lineIndex + 1}, ${BUCKETS[option.bucket]}`,
          amounts: Object.fromEntries(HEADS.map(head => [head + 'Paise', Math.min(option.line.balances[option.bucket][head + 'Paise'], noteLine.original[head + 'Paise'])])), checked: options.length === 1 });
      }
    } else for (const line of selected.lines) for (const bucket of sourceOptions(action)) {
      const amounts = { ...line.balances[bucket] };
      if (action === 'permanent' && bucket === 'permanent') for (const head of HEADS) amounts[head + 'Paise'] = Math.max(0, amounts[head + 'Paise'] - line.expenseReviewed[head + 'Paise']);
      if (total(amounts)) allocationRows.push({ lineIndex: line.lineIndex, bucket, label: `Line ${line.lineIndex + 1}, ${line.name || line.itemId}, ${BUCKETS[bucket]}`, amounts, checked: !(needsServiceReceipt() && line.serviceReceipt?.status === 'pending'), serviceReceipt: line.serviceReceipt });
    }
    const renderedReceipts = new Set();
    const receiptFields = row => {
      const receipt = row.serviceReceipt;
      if (!receipt || !needsServiceReceipt()) return '';
      if (receipt.status === 'confirmed') return `<p class="form-note" data-itc-service-established>Service received ${esc(dateLabel(receipt.date))} for ${esc(receipt.ledgerName)}. Reference <span class="code">${esc(receipt.reference)}</span>.</p>`;
      if (renderedReceipts.has(receipt.lineIndex)) return '<p class="form-note">Receipt evidence is shared with this service line above.</p>';
      renderedReceipts.add(receipt.lineIndex);
      return `<div data-itc-service-receipt="${receipt.lineIndex}"><p class="form-note"><span class="pill warn">Receipt pending</span> ${esc(receipt.ledgerName)}. Include this service after receipt or completion.</p><label class="check"><input type="checkbox" data-itc-service-received><span>This selected service was received or completed</span></label><label>Service receipt date <input type="date" data-itc-service-date></label><label>Receipt evidence reference <input data-itc-service-reference maxlength="500"></label></div>`;
    };
    amountRoot.innerHTML = allocationRows.length ? `<table><thead><tr><th>Source to include</th>${HEADS.map(head => `<th class="figure">${head.toUpperCase()} ₹</th>`).join('')}</tr></thead><tbody>${allocationRows.map((row, index) => `<tr data-itc-row="${index}"><td><label class="check"><input type="checkbox" data-itc-choose${row.checked ? ' checked' : ''}><span>${esc(row.label)}</span></label>${receiptFields(row)}</td>${HEADS.map(head => `<td class="figure"><input data-itc-head="${head}" inputmode="decimal" aria-label="${esc(row.label)} ${head.toUpperCase()} rupees" value="${(row.amounts[head + 'Paise'] / 100).toFixed(2)}"></td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p class="quiet">No tax remains in a disposition this decision can use. Choose another decision.</p>';
    updateTotal();
  }
  function mode() {
    const action = form.elements.action.value;
    const eligibility = ['claim', 'reclaim', 'prior-claim'].includes(action);
    const classified = ['permanent', 'temporary'].includes(action);
    visible('[data-itc-reason]', classified); visible('[data-itc-context]', classified);
    form.elements.reasonCode.innerHTML = (action === 'temporary' ? TEMPORARY : PERMANENT).map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
    form.elements.reportingMode.innerHTML = action === 'temporary' ? '<option value="hold-only">Hold never-claimed tax; reverse actual claims</option><option value="gross-and-reversal">Gross 4(A)(5) plus temporary reversal</option>' : '<option value="cost-only">Record cost; reverse any actual claim</option><option value="gross-and-reversal">Gross 4(A)(5) plus permanent reversal</option>';
    visible('[data-itc-eligibility]', eligibility); visible('[data-itc-temporary]', action === 'temporary');
    visible('[data-itc-reclaim]', action === 'reclaim'); visible('[data-itc-prior]', action === 'prior-claim');
    visible('[data-itc-reversal-statement]', action === 'permanent');
    visible('[data-itc-correction]', ['claim', 'prior-claim'].includes(action) && total(selected.balances.permanent) > 0);
    form.querySelector('[data-itc-action-note]').textContent = action === 'credit-note' ? 'Apply this note to the exact original tax amounts. Previously reversed or never-claimed tax is not reversed again.' : action === 'prior-claim' ? 'Record a verified earlier claim and its accounting classification without adding another return claim.' : action === 'permanent' ? 'Tax moves to non-creditable cost. Never-claimed tax needs its actual gross reporting context before a return reversal is recorded.' : action === 'temporary' ? 'A previous claim reverses in 4(B)(2). Never-claimed tax can be held without recording a return claim, or paired with explicitly evidenced gross reporting.' : action === 'reclaim' ? 'Reclaim comes only from a recorded temporary reversal, with 4(A)(5) and informational 4(D)(1) shown together.' : 'Record the exact tax approved for claim after checking the evidence and statutory conditions.';
    context(); renderAllocations();
  }
  function context() {
    const action = form.elements.action.value;
    const gross = ['permanent', 'temporary'].includes(action) && form.elements.reportingMode.value === 'gross-and-reversal';
    visible('[data-itc-gross]', gross); visible('[data-itc-annual]', ['claim', 'reclaim', 'prior-claim'].includes(action) || gross);
    visible('[data-itc-annual-date]', form.elements.annualReturnStatus.value === 'filed');
  }
  const markDirty = event => { if (event.target !== form.elements.invoiceId) form.dataset.dirty = 'true'; };
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);
  form.elements.invoiceId.addEventListener('change', event => {
    if (form.dataset.dirty === 'true' && !confirm(DISCARD)) { event.target.value = selected.id; return; }
    delete form.dataset.dirty;
    location.hash = `${book}/gst-itc/${encodeURIComponent(event.target.value)}?to=${encodeURIComponent(report.to)}`;
  });
  form.elements.action.addEventListener('change', mode);
  form.elements.reportingMode.addEventListener('change', () => { context(); renderAllocations(); });
  form.elements.annualReturnStatus.addEventListener('change', context);
  form.elements.correctIneligibility.addEventListener('change', renderAllocations);
  amountRoot.addEventListener('input', updateTotal);
  amountRoot.addEventListener('change', updateTotal);
  form.addEventListener('input', () => { delete form.dataset.requestId; error.textContent = ''; updateTotal(); });
  form.elements.statementId.addEventListener('change', () => {
    const statement = chosenStatement();
    form.querySelector('[data-itc-statement-status]').textContent = statement ? `${statement.matchStatus || 'Saved document'} in the statement for ${statement.period}. ITC ${statement.availability === 'N' ? 'not available' : statement.availability === 'Y' ? 'available in the statement' : 'not specified'}.${statement.reason ? ' ' + statement.reason : ''}` : 'Use the separate evidence reference and statutory review recorded above.';
    updateTotal();
  });
  mode();
  api(`/api/companies/${encodeURIComponent(route.id)}/gst-returns/statement-evidence?invoice=${encodeURIComponent(selected.id)}`).then(result => {
    if (!still(token) || !form.isConnected) return;
    candidates = result.matches || [];
    form.elements.statementId.innerHTML = '<option value="">Separate documented evidence</option>' + candidates.map((match, index) => `<option value="${index}">${esc(match.period)}, ${esc(match.number || selected.supplierInvoiceNumber)}, ${esc(match.matchStatus)}, ${match.availability === 'N' ? 'ITC not available' : esc(match.fileName || match.rowKey)}</option>`).join('');
    form.querySelector('[data-itc-statement-status]').textContent = candidates.length ? 'Choose the saved supplier document used for this review.' : 'No saved statement document matches this invoice. Record separate evidence to review it.';
  }).catch(failure => { if (still(token) && form.isConnected) form.querySelector('[data-itc-statement-status]').textContent = `Saved statement references could not be loaded: ${failure.message}`; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (form.dataset.busy === 'true') return;
    form.dataset.busy = 'true'; saveButton.disabled = true; error.textContent = '';
    try {
      const data = new FormData(form), action = data.get('action');
      const evidence = { basis: data.get('basis'), documentReference: data.get('documentReference') };
      for (const [key] of CHECKS) evidence[key] = form.elements[key].checked;
      for (const key of ['expectedRecoverable', 'grossIncluded', 'conditionsNowMet', 'priorClaimVerified', 'reversalStatementReviewed', 'correctIneligibility']) evidence[key] = form.elements[key].checked;
      for (const key of ['annualReturnStatus', 'annualReturnFiledDate', 'grossReference', 'priorClaimDate', 'priorReturnReference']) if (data.get(key)) evidence[key] = data.get(key);
      const statement = chosenStatement();
      if (statement) evidence.statement = Object.fromEntries(['id', 'sha256', 'rowKey', 'period', 'availability', 'matchStatus', 'reason'].filter(key => statement[key] !== undefined).map(key => [key, statement[key]]));
      const allocations = activeRows().map(row => {
        const index = Number(row.dataset.itcRow), source = allocationRows[index];
        const amounts = Object.fromEntries(HEADS.map(head => [head + 'Paise', parseRupees(row.querySelector(`[data-itc-head="${head}"]`).value || '0')]));
        return action === 'credit-note' ? { invoiceId: source.invoiceId, lineIndex: source.lineIndex, noteLineIndex: source.noteLineIndex, bucket: source.bucket, ...amounts } : { lineIndex: source.lineIndex, fromBucket: source.bucket, ...amounts };
      });
      if (needsServiceReceipt()) {
        const receipts = activeRows().flatMap(row => {
          const receipt = allocationRows[Number(row.dataset.itcRow)].serviceReceipt;
          const fields = receipt && amountRoot.querySelector(`[data-itc-service-receipt="${receipt.lineIndex}"]`);
          return receipt?.status === 'pending' ? [{ lineIndex: receipt.lineIndex, sourceLineId: receipt.sourceLineId, sourceLedgerId: receipt.sourceLedgerId, received: fields.querySelector('[data-itc-service-received]').checked,
            date: fields.querySelector('[data-itc-service-date]').value, reference: fields.querySelector('[data-itc-service-reference]').value }] : [];
        });
        if (receipts.length) evidence.serviceReceipts = receipts.filter((row, index) => receipts.findIndex(other => other.lineIndex === row.lineIndex) === index);
      }
      form.dataset.requestId ||= crypto.randomUUID();
      const input = { invoiceId: selected.id, date: data.get('date'), reference: data.get('reference'), requestId: form.dataset.requestId, evidence,
        ...(action === 'credit-note' ? { creditSources: allocations } : { lineAllocations: allocations }),
        ...(['permanent', 'temporary'].includes(action) ? { reasonCode: data.get('reasonCode'), reportingMode: data.get('reportingMode') } : {}) };
      const result = await api(`${base}/${action}`, { method: 'POST', body: input });
      if (!still(token)) return;
      sessionStorage.setItem(flashKey, `Decision recorded: ${ACTIONS[action]}. Reference ${result.record.reference}.`);
      const nextHash = `${book}/gst-itc/${encodeURIComponent(selected.id)}?to=${encodeURIComponent(input.date > report.to ? input.date : report.to)}`;
      if (location.hash === nextHash) await viewPurchaseItc(route, token, ctx);
      else location.hash = nextHash;
    } catch (failure) {
      error.textContent = failure.message;
      error.scrollIntoView({ block: 'nearest' }); form.dataset.busy = 'false'; updateTotal();
    }
  });
}
