const dateLabel = value => /^\d{4}-\d{2}-\d{2}/.test(value || "") ? value.slice(0, 10).split("-").reverse().join("-") : value;

export function tallyInvoiceReferences(invoice, companyId, esc) {
  const origin = invoice.tallyOrigin;
  if (!origin) return "";
  const refs = origin.sourceReferences || {};
  const rows = [
    ["Invoice reference number", refs.irn, true],
    ["Acknowledgement number", refs.acknowledgementNumber, true],
    ["Acknowledgement date", refs.acknowledgementDate && dateLabel(refs.acknowledgementDate), false],
    ["E-way bill number", refs.ewayBillNumber, true],
    ["E-way bill date", refs.ewayBillDate && dateLabel(refs.ewayBillDate), false]
  ].filter(([, value]) => value);
  const link = "#/c/" + encodeURIComponent(companyId) + "/tally-source/" + encodeURIComponent(origin.recordId);
  const count = rows.length === 1 ? "1 reported reference" : `${rows.length} reported references`;
  return `<div class="details-list tally-invoice-source"><details><summary>Tally source${rows.length ? ` <small>${count}</small>` : ""}</summary>
    ${rows.length ? `<dl class="kv">${rows.map(([label, value, code]) => `<dt>${esc(label)}</dt><dd${code ? ' class="code"' : ""}>${esc(value)}</dd>`).join("")}</dl>` : ""}
    <p><a href="${esc(link)}">Open the original Tally voucher</a></p>
  </details></div>`;
}
