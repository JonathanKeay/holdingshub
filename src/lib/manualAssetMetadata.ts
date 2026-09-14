// src/lib/manualAssetMetadata.ts
//
// Pure decision logic for the CSV import new-asset metadata fallback: when
// automatic ticker-metadata lookup (Yahoo, via fetchTickerMeta in
// src/app/api/import-transactions/route.ts) fails to return a currency for a
// genuinely new ticker, the user can supply currency (and optionally a name)
// manually instead of the import being permanently blocked by a flaky
// third-party API. Automatic lookup stays the default, convenient path —
// manual entry is only ever consulted as a fallback, and only ever supplies
// currency/name, never a different ticker (ticker confirmation, not ticker
// remapping/aliasing — alias resolution is separate, later work; see the
// CAKE.US investigation this fix deliberately does not touch).

export type AutoTickerMeta = {
  ticker: string;
  name: string | null;
  currency: string | null;
  price_multiplier: number;
};

export type ManualTickerMetadata = {
  currency?: unknown;
  name?: unknown;
};

export type ResolvedNewAssetMeta =
  | {
      status: 'ok';
      source: 'auto' | 'manual';
      ticker: string;
      name: string | null;
      currency: string;
      price_multiplier: number;
    }
  | {
      status: 'missing';
      ticker: string;
      reason: string;
    };

// A standard, static ISO 4217 currency-code allowlist. Deliberately NOT
// derived from any market/portfolio data (fx_rates, assets, etc.) — this is
// pure input validation ("is this a real currency code"), not a judgement
// about which currencies this portfolio happens to use today.
export const ISO_CURRENCY_CODES: ReadonlySet<string> = new Set([
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD',
  'CAD', 'CDF', 'CHF', 'CLP', 'CNY', 'COP', 'CRC', 'CUP', 'CVE', 'CZK',
  'DJF', 'DKK', 'DOP', 'DZD',
  'EGP', 'ERN', 'ETB', 'EUR',
  'FJD', 'FKP',
  'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD',
  'HKD', 'HNL', 'HRK', 'HTG', 'HUF',
  'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK',
  'JMD', 'JOD', 'JPY',
  'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT',
  'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD',
  'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN',
  'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD',
  'OMR',
  'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG',
  'QAR',
  'RON', 'RSD', 'RUB', 'RWF',
  'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SYP', 'SZL',
  'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS',
  'UAH', 'UGX', 'USD', 'UYU', 'UZS',
  'VES', 'VND', 'VUV',
  'WST',
  'XAF', 'XCD', 'XOF', 'XPF',
  'YER',
  'ZAR', 'ZMW', 'ZWL',
]);

export function isValidCurrencyCode(code: unknown): code is string {
  return typeof code === 'string' && ISO_CURRENCY_CODES.has(code.trim().toUpperCase());
}

/**
 * Decide the final metadata for a genuinely-new asset from this import.
 * Automatic lookup (`auto`) is always preferred when it has a currency.
 * Manual entry is consulted only as a fallback, and is rejected (status
 * 'missing', same as no manual entry at all) if its currency isn't a real
 * currency code — this never fabricates or guesses a currency.
 */
export function resolveNewAssetMeta(
  auto: AutoTickerMeta,
  manual?: ManualTickerMetadata | null
): ResolvedNewAssetMeta {
  if (auto.currency) {
    return {
      status: 'ok',
      source: 'auto',
      ticker: auto.ticker,
      name: auto.name,
      currency: auto.currency,
      price_multiplier: auto.price_multiplier,
    };
  }

  const manualCurrency = manual?.currency;
  if (!isValidCurrencyCode(manualCurrency)) {
    return {
      status: 'missing',
      ticker: auto.ticker,
      reason:
        manualCurrency == null || manualCurrency === ''
          ? 'Automatic lookup could not determine a currency, and no manual currency was provided.'
          : `'${String(manualCurrency)}' is not a recognised currency code.`,
    };
  }

  const manualNameRaw = manual?.name;
  const manualName = typeof manualNameRaw === 'string' ? manualNameRaw.trim() : '';

  return {
    status: 'ok',
    source: 'manual',
    ticker: auto.ticker,
    name: manualName || auto.name || null,
    currency: manualCurrency.trim().toUpperCase(),
    price_multiplier: auto.price_multiplier,
  };
}

/**
 * From a list of normalized, confirmed "new" tickers, return only the ones
 * that don't already exist as an asset. Guards against creating a duplicate
 * asset row when the same ticker was created by another import (or another
 * confirm request for the same import) between preview and this confirm —
 * `existingAssets` should be a fresh read taken at the start of THIS
 * request, not anything cached from an earlier preview call. Also
 * de-duplicates the input list itself, in case the same ticker appears in
 * it more than once.
 */
export function filterTickersNeedingCreation(
  confirmedTickers: string[],
  existingAssets: { ticker: string | null }[]
): string[] {
  const existing = new Set(
    existingAssets.map((a) => (a.ticker ?? '').toString().toUpperCase()).filter(Boolean)
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of confirmedTickers) {
    const upper = (t ?? '').toString().toUpperCase();
    if (!upper || existing.has(upper) || seen.has(upper)) continue;
    seen.add(upper);
    out.push(t);
  }
  return out;
}
