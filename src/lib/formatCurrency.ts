// src/lib/formatCurrency.ts
export function formatCurrency(value: number, currency: string = 'GBP') {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol', // 👈 This is the key change
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}