// src/lib/currency.ts

const currencySymbols: Record<string, string> = {
  USD: '$',
  GBP: '£',
  EUR: '€',
  JPY: '¥',
  AUD: 'A$',
  CAD: 'C$',
  CHF: 'CHF',
};

export function getCurrencySymbol(code?: string): string {
  if (!code) return '';
  const upper = code.toUpperCase();
  const symbol = currencySymbols[upper];
  return symbol ?? '';
}
