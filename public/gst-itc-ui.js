import { formatINR, parseRupees, todayISO } from '/money.js';

const HEADS = ['cgst', 'sgst', 'utgst', 'igst', 'cess'];
const ACTIONS = { claim: 'Record eligible claim', permanent: 'Record permanent ineligibility', temporary: 'Hold or reverse temporarily', reclaim: 'Reclaim previously reversed credit', 'prior-claim': 'Record a documented earlier claim', 'credit-note': 'Apply linked supplier credit note' };
const BUCKETS = { unreviewed: 'Pending review', unclaimed: 'Marked eligible; unclaimed', claimable: 'Claim recorded', permanent: 'Permanent tax cost', 'temporary-hold': 'Held; never claimed', 'temporary-reversed': 'Previously claimed and reversed', 'temporary-gross': 'Gross ITC with temporary reversal' };
const PERMANENT = [['section17(5)', 'Section 17(5): blocked credit'], ['rule38', 'Rule 38'], ['rule42', 'Rule 42'], ['rule43', 'Rule 43'], ['section16(4)', 'Section 16(4): time limit'], ['pos-restriction', 'Place-of-supply restriction'], ['other-permanent', 'Other permanent ineligibility']];
const TEMPORARY = [['rule37', 'Rule 37: supplier-payment condition'], ['rule37A', 'Rule 37A: supplier return condition'], ['section16(2)(b)', 'Section 16(2)(b): receipt condition'], ['section16(2)(c)', 'Section 16(2)(c): tax-payment condition'], ['clerical-correction', 'Correction of an earlier inadvertent claim'], ['other-temporary', 'Other temporary reversal']];
const CHECKS = [['invoiceHeld', 'Invoice or debit note held'], ['received', 'Goods or services received'], ['businessUse', 'Business use and taxable-supply conditions met'], ['notBlocked', 'Section 17 blocked-credit review passed'], ['supplierReported', 'Supplier reporting condition supported'], ['supplierTaxPaid', 'Supplier tax-payment condition supported'], ['returnFurnished', 'Return-furnishing condition met'], ['paymentReview', 'Supplier-payment and 180-day conditions reviewed'], ['noTaxDepreciation', 'Tax component not claimed as depreciation']];
const total = (row = {}) => HEADS.reduce((sum, head) => sum + (row[head + 'Paise'] || 0), 0);
const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('-') : value || '—';

export async function viewPurchaseItc(route, token, ui) {
  if (route.name !== 'gst-itc') return false;
  const { root, api, still, page, esc } = ui;
  const to = new URLSearchParams(location.hash.split('?')[1] || '').get('to') || todayISO();
  const base = `/api/companies/${encodeURIComponent(route.id)}/gst/itc`;
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
  const summaries = categories.map(([label, buckets]) => `<div><dt>${esc(label)}</dt><dd>${money(documents.reduce((sum, document) => sum + buckets.reduce((subtotal, bucket) => subtotal + total(document.balances[bucket]), 0), 0))}</dd></div>`).join('');
  const rows = documents.map(document => `<tr${document.id === selected?.id ? ' class="itc-selected"' : ''}><td><a href="${book}/gst-itc/${encodeURIComponent(document.id)}?to=${encodeURIComponent(to)}">${esc(document.supplierInvoiceNumber || document.number)}</a><span class="itc-sub">${esc(document.partyName)} · ${esc(document.type)} · ${dateLabel(document.date)}</span></td><td class="figure">${money(document.totals.taxPaise)}</td><td class="figure">${money(total(document.balances.claimable))}</td><td>${document.type === 'Credit Note' ? document.creditSettled ? 'Credit applied' : 'Credit-note review due' : Object.entries(BUCKETS).filter(([bucket]) => total(document.balances[bucket])).map(([bucket, label]) => esc(label)).join(' · ') || 'Fully credited'}</td></tr>`).join('');
  const issues = report.issues.length ? `<section class="itc-attention"><h2>Review points</h2><ul>${report.issues.map(issue => `<li><a href="${book}/gst-itc/${encodeURIComponent(issue.invoiceId)}?to=${encodeURIComponent(to)}">${esc(documents.find(document => document.id === issue.invoiceId)?.supplierInvoiceNumber || issue.invoiceId)}</a>: ${esc(issue.message)}</li>`).join('')}</ul></section>` : '';
  const documentOptions = documents.map(document => `<option value="${esc(document.id)}"${document.id === selected?.id ? ' selected' : ''}>${esc(document.supplierInvoiceNumber || document.number)} · ${esc(document.partyName)}</option>`).join('');
  const history = selected ? renderHistory(report, selected, esc, money, book) : '';
  document.title = `Purchase ITC review · ${report.company.name}`;
  root.innerHTML = page({ company: report.company, title: 'Purchase ITC review', kicker: 'GST inputs', folio: 'Ic', status,
    body: `<div class="itc-workspace"><form class="itc-asof" id="itc-asof"><label>As on<input type="date" name="to" value="${esc(to)}" min="${esc(report.company.booksFrom)}" required></label><button type="submit">Show position</button></form>
      <dl class="itc-summary">${summaries}</dl>${issues}
      <div class="itc-scroll"><table><thead><tr><th>Supplier document</th><th class="figure">Tax ₹</th><th class="figure">Claim recorded ₹</th><th>Disposition</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No forward-charge purchase documents at this date.</td></tr>'}</tbody></table></div>
      ${selected ? `<section class="itc-entry"><div class="itc-section-head"><h2>Record a dated decision</h2><a href="${book}/gst-document/${encodeURIComponent(selected.id)}">Open source document</a></div>
        <form id="itc-review" class="itc-form"><label class="itc-wide">Supplier document<select name="invoiceId">${documentOptions}</select></label>
        <label>Decision<select name="action">${Object.entries(ACTIONS).filter(([action]) => selected.type === 'Credit Note' ? action === 'credit-note' : action !== 'credit-note').map(([action, label]) => `<option value="${action}">${esc(label)}</option>`).join('')}</select></label>
        <label>Decision date<input type="date" name="date" value="${esc(to)}" min="${esc(selected.date)}" required></label>
        <label>Review reference<input name="reference" maxlength="160" required></label><label>Evidence reference<input name="documentReference" maxlength="240" required></label>
        <label class="itc-wide">Review basis<textarea name="basis" maxlength="500" rows="2" required></textarea></label>
        <label data-itc-reason>Provision<select name="reasonCode"></select></label>
        <label data-itc-context>Return context<select name="reportingMode"></select></label>
        <div class="itc-wide" data-itc-action-note></div>
        <fieldset class="itc-wide"><legend>Exact line and tax-head allocation</legend><p class="quiet">Choose the source tax disposition and amount covered by this decision.</p><div class="itc-scroll" data-itc-allocations></div><p data-itc-total class="figure" aria-live="polite"></p></fieldset>
        <fieldset class="itc-wide"><legend>Source evidence</legend><label>Saved GSTR-2B document<select name="statementId"><option value="">Separate documented evidence</option></select></label><p class="quiet" data-itc-statement-status role="status">Loading saved document references…</p><p class="quiet">Confirm eligibility from the evidence below. A matching statement does not make the decision.</p></fieldset>
        <fieldset class="itc-wide" data-itc-eligibility><legend>Claim conditions</legend><div class="itc-checks">${CHECKS.map(([name, label]) => `<label class="itc-check"><input type="checkbox" name="${name}"><span>${esc(label)}</span></label>`).join('')}</div></fieldset>
        <fieldset class="itc-wide" data-itc-annual><legend>Section 16(4) timing</legend><p class="quiet">Ordinary first-claim cutoff for this document: ${dateLabel(selected.claimDeadline)}, or the relevant annual return if earlier.</p><label>Relevant annual return<select name="annualReturnStatus"><option value="">Choose reviewed status</option><option value="not-filed">Not filed</option><option value="filed">Filed</option></select></label><label data-itc-annual-date>Annual return filing date<input type="date" name="annualReturnFiledDate"></label></fieldset>
        <fieldset class="itc-wide" data-itc-temporary><legend>Recoverability</legend><label class="itc-check"><input type="checkbox" name="expectedRecoverable"><span>Evidence supports recovery once the stated temporary condition is fulfilled</span></label></fieldset>
        <fieldset class="itc-wide" data-itc-gross><legend>Gross reporting evidence</legend><label class="itc-check"><input type="checkbox" name="grossIncluded"><span>This exact tax is included in gross Table 4(A)(5) for this return period</span></label><label>Gross ITC evidence<input name="grossReference" maxlength="240"></label></fieldset>
        <fieldset class="itc-wide" data-itc-reclaim><legend>Reclaim conditions</legend><label class="itc-check"><input type="checkbox" name="conditionsNowMet"><span>The temporary condition is now fulfilled, supported by the recorded evidence</span></label></fieldset>
        <fieldset class="itc-wide" data-itc-prior><legend>Historical claim evidence</legend><label>Earlier claim date<input type="date" name="priorClaimDate" min="${esc(selected.date)}"></label><label>Filed return reference<input name="priorReturnReference" maxlength="240"></label><label class="itc-check"><input type="checkbox" name="priorClaimVerified"><span>The earlier claim was checked against its filed return; do not report it again</span></label></fieldset>
        <label class="itc-wide itc-check" data-itc-reversal-statement><input type="checkbox" name="reversalStatementReviewed"><span>The electronic reversal statement was reconciled for reclassification to permanent ineligibility</span></label>
        <label class="itc-wide itc-check" data-itc-correction><input type="checkbox" name="correctIneligibility"><span>This is a documented correction of the earlier permanent ineligibility assessment</span></label>
        <p class="itc-wide" data-itc-error role="alert"></p><div class="actions itc-wide"><button type="submit">Record decision</button></div></form></section>${history}` : ''}
      <details class="itc-sources"><summary>GST reporting sources</summary><ul>${report.sources.map(source => `<li><a href="${esc(source.url)}" target="_blank" rel="noreferrer">${esc(source.title)}</a></li>`).join('')}</ul></details></div>` });
  root.querySelector('#itc-asof').addEventListener('submit', event => {
    event.preventDefault(); const date = new FormData(event.currentTarget).get('to');
    location.hash = `${book}/gst-itc${selected ? '/' + encodeURIComponent(selected.id) : ''}?to=${encodeURIComponent(date)}`;
  });
  if (selected) bindReview({ ...ui, route, token, base, report, selected, book, money, flashKey });
  return true;
}

function renderHistory(report, selected, esc, money, book) {
  const records = report.records.filter(record => record.invoiceId === selected.id || record.transfers.some(transfer => transfer.invoiceId === selected.id));
  const ledgerName = id => report.ledgers.find(ledger => ledger.id === id)?.name || id;
  return `<section class="itc-history"><h2>Review history</h2>${records.map(record => `<details data-itc-record="${esc(record.id)}"><summary>${dateLabel(record.date)} · ${esc(ACTIONS[record.action])} · ${esc(record.reference)} · ₹${money(total(record.components))}</summary><p>${esc(record.evidence.basis)}</p><p>Evidence: ${esc(record.evidence.documentReference)}</p>${record.evidence.statement ? `<p>Statement ${esc(record.evidence.statement.period)} · ${esc(record.evidence.statement.matchStatus || '')} · ${esc(record.evidence.statement.rowKey)}</p>` : ''}<div class="itc-scroll"><table><caption>Accounting entry</caption><thead><tr><th>Ledger</th><th>Side</th><th class="figure">Amount ₹</th></tr></thead><tbody>${record.postingLines.map(line => `<tr><td>${esc(ledgerName(line.ledgerId))}</td><td>${esc(line.dc)}</td><td class="figure">${money(line.paise)}</td></tr>`).join('') || '<tr><td colspan="3">Evidence recorded; no additional accounting entry was needed.</td></tr>'}</tbody></table></div><div class="itc-scroll"><table><caption>Return working paper</caption><thead><tr><th>Table</th><th>Direction</th>${HEADS.map(head => `<th class="figure">${head.toUpperCase()} ₹</th>`).join('')}</tr></thead><tbody>${record.returnRows.map(row => `<tr><td>${esc(row.table)}</td><td>${row.sign < 0 ? 'Reduction' : 'Addition'}${row.table.startsWith('4D') ? ' · information' : ''}</td>${HEADS.map(head => `<td class="figure">${money(row[head + 'Paise'])}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="7">No new return claim or reversal recorded.</td></tr>'}</tbody></table></div>${record.voucherId ? `<p><a href="${book}/v/Journal/${encodeURIComponent(record.voucherId)}">Open accounting entry</a></p>` : ''}</details>`).join('') || '<p class="quiet">No dated ITC decisions recorded for this document.</p>'}</section>`;
}

function bindReview(ctx) {
  const { root, api, still, token, route, base, report, selected, book, esc, money, flashKey } = ctx;
  const form = root.querySelector('#itc-review');
  const error = form.querySelector('[data-itc-error]');
  const saveButton = form.querySelector('button[type=submit]');
  const amountRoot = form.querySelector('[data-itc-allocations]');
  let candidates = [], allocationRows = [];
  const visible = (selector, show) => { form.querySelector(selector).hidden = !show; };
  const sourceOptions = action => action === 'claim' || action === 'prior-claim' ? ['unreviewed', 'unclaimed', 'temporary-hold', ...(form.elements.correctIneligibility.checked ? ['permanent'] : [])] : action === 'temporary' ? ['claimable', 'unreviewed', 'unclaimed'] : action === 'reclaim' ? ['temporary-reversed', 'temporary-gross'] : ['claimable', 'unreviewed', 'unclaimed', 'temporary-hold', 'temporary-reversed', 'temporary-gross', ...(selected.initialEligibility === 'ineligible' ? ['permanent'] : [])];
  const chosenStatement = () => form.elements.statementId.value === '' ? null : candidates[Number(form.elements.statementId.value)] || null;
  const activeRows = () => [...amountRoot.querySelectorAll('[data-itc-row]')].filter(row => row.querySelector('[data-itc-choose]').checked);
  const updateTotal = () => {
    let amount = 0;
    try { for (const row of activeRows()) for (const head of HEADS) amount += parseRupees(row.querySelector(`[data-itc-head="${head}"]`).value || '0'); }
    catch { form.querySelector('[data-itc-total]').textContent = 'Enter amounts in rupees and paise.'; return; }
    form.querySelector('[data-itc-total]').textContent = `Decision amount ₹${formatINR(amount)}`;
    const unavailable = chosenStatement()?.availability === 'N' && ['claim', 'reclaim', 'prior-claim'].includes(form.elements.action.value);
    saveButton.disabled = !amount || unavailable || selected.type === 'Credit Note' && selected.creditSettled;
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
          label: `${option.document.supplierInvoiceNumber || option.document.number} · line ${option.line.lineIndex + 1} · ${BUCKETS[option.bucket]}`,
          amounts: Object.fromEntries(HEADS.map(head => [head + 'Paise', Math.min(option.line.balances[option.bucket][head + 'Paise'], noteLine.original[head + 'Paise'])])), checked: options.length === 1 });
      }
    } else for (const line of selected.lines) for (const bucket of sourceOptions(action)) {
      const amounts = { ...line.balances[bucket] };
      if (action === 'permanent' && bucket === 'permanent') for (const head of HEADS) amounts[head + 'Paise'] = Math.max(0, amounts[head + 'Paise'] - line.expenseReviewed[head + 'Paise']);
      if (total(amounts)) allocationRows.push({ lineIndex: line.lineIndex, bucket, label: `Line ${line.lineIndex + 1} · ${line.name || line.itemId} · ${BUCKETS[bucket]}`, amounts, checked: true });
    }
    amountRoot.innerHTML = allocationRows.length ? `<table><thead><tr><th>Include / source</th>${HEADS.map(head => `<th>${head.toUpperCase()} ₹</th>`).join('')}</tr></thead><tbody>${allocationRows.map((row, index) => `<tr data-itc-row="${index}"><td><label class="itc-check"><input type="checkbox" data-itc-choose${row.checked ? ' checked' : ''}><span>${esc(row.label)}</span></label></td>${HEADS.map(head => `<td><input data-itc-head="${head}" inputmode="decimal" aria-label="${esc(row.label)} ${head.toUpperCase()} rupees" value="${(row.amounts[head + 'Paise'] / 100).toFixed(2)}"></td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p>No tax remains in a disposition available for this decision.</p>';
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
  form.elements.invoiceId.addEventListener('change', event => { location.hash = `${book}/gst-itc/${encodeURIComponent(event.target.value)}?to=${encodeURIComponent(report.to)}`; });
  form.elements.action.addEventListener('change', mode);
  form.elements.reportingMode.addEventListener('change', context);
  form.elements.annualReturnStatus.addEventListener('change', context);
  form.elements.correctIneligibility.addEventListener('change', renderAllocations);
  amountRoot.addEventListener('input', updateTotal);
  amountRoot.addEventListener('change', updateTotal);
  form.addEventListener('input', () => { delete form.dataset.requestId; error.textContent = ''; });
  form.elements.statementId.addEventListener('change', () => {
    const statement = chosenStatement();
    form.querySelector('[data-itc-statement-status]').textContent = statement ? `${statement.matchStatus || 'Saved document'} · ${statement.period} · ITC ${statement.availability === 'N' ? 'not available' : statement.availability === 'Y' ? 'available in statement' : 'not specified'}${statement.reason ? ' · ' + statement.reason : ''}` : 'Use the separate evidence reference and statutory review recorded above.';
    updateTotal();
  });
  mode();
  api(`/api/companies/${encodeURIComponent(route.id)}/gst-returns/statement-evidence?invoice=${encodeURIComponent(selected.id)}`).then(result => {
    if (!still(token) || !form.isConnected) return;
    candidates = result.matches || [];
    form.elements.statementId.innerHTML = '<option value="">Separate documented evidence</option>' + candidates.map((match, index) => `<option value="${index}">${esc(match.period)} · ${esc(match.number || selected.supplierInvoiceNumber)} · ${esc(match.matchStatus)} · ${match.availability === 'N' ? 'ITC not available' : esc(match.fileName || match.rowKey)}</option>`).join('');
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
      form.dataset.requestId ||= crypto.randomUUID();
      const input = { invoiceId: selected.id, date: data.get('date'), reference: data.get('reference'), requestId: form.dataset.requestId, evidence,
        ...(action === 'credit-note' ? { creditSources: allocations } : { lineAllocations: allocations }),
        ...(['permanent', 'temporary'].includes(action) ? { reasonCode: data.get('reasonCode'), reportingMode: data.get('reportingMode') } : {}) };
      const result = await api(`${base}/${action}`, { method: 'POST', body: input });
      if (!still(token)) return;
      sessionStorage.setItem(flashKey, `${ACTIONS[action]} · ${result.record.reference}`);
      const nextHash = `${book}/gst-itc/${encodeURIComponent(selected.id)}?to=${encodeURIComponent(input.date > report.to ? input.date : report.to)}`;
      if (location.hash === nextHash) await viewPurchaseItc(route, token, ctx);
      else location.hash = nextHash;
    } catch (failure) {
      error.className = 'itc-wide alert'; error.textContent = failure.message;
      error.scrollIntoView({ block: 'nearest' }); form.dataset.busy = 'false'; updateTotal();
    }
  });
}
