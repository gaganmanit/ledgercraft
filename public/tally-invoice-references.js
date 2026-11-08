export function tallyInvoiceReferences(invoice, companyId, esc) {
  const origin = invoice.tallyOrigin;
  if (!origin) return "";
  const refs = origin.sourceReferences || {};
  const rows = [
    ["Invoice reference number", refs.irn],
    ["Acknowledgement number", refs.acknowledgementNumber],
    ["Acknowledgement date", refs.acknowledgementDate],
    ["E-way bill number", refs.ewayBillNumber],
    ["E-way bill date", refs.ewayBillDate]
  ].filter(([,value]) => value);
  const link = "#/c/" + encodeURIComponent(companyId) + "/tally-source/" + encodeURIComponent(origin.recordId);
  return `<details class="tally-invoice-source"><summary>Tally source${rows.length ? " · reported references" : ""}</summary>
    ${rows.length ? `<dl>${rows.map(([label,value])=>`<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join("")}</dl>` : ""}
    <a class="ink-link" href="${esc(link)}">Open original voucher details ↗</a>
  </details>`;
}
