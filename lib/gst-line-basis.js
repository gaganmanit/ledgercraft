// Tally accounting invoices can supply a service amount without stating a quantity.
// Ledgercraft uses one internally to calculate that amount.
export function amountOnlyService(invoice, index) {
  return invoice.tallyOrigin?.version === 4 && invoice.items[index]?.kind === "service" &&
    invoice.tallyOrigin.source.items[index]?.quantityBasis === "amount-only";
}
