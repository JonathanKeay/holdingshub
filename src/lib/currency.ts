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

// Convert an amount from one currency to another using your fxRates map.
// Example: convertAmount(2.92, 'USD', 'GBP', fxRates)
export function convertAmount(
  amount: number,
  fromCcy?: string,
  toCcy: string = 'GBP',
  fxRates: Record<string, number> = {}
): number {
  const from = (fromCcy ?? 'GBP').toUpperCase();
  const to = (toCcy ?? 'GBP').toUpperCase();
  const rateFrom = fxRates[from] ?? 1;
  const rateTo = fxRates[to] ?? 1;
  if (!rateTo) return amount;
  return amount * (rateFrom / rateTo);
}

