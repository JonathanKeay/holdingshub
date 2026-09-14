// Tests for the CSV import new-asset metadata fallback
// (src/lib/manualAssetMetadata.ts). See the confirm-stage use in
// src/app/api/import-transactions/route.ts: automatic lookup (Yahoo) is
// always attempted first; manual currency/name entry is only ever consulted
// when that lookup doesn't return a currency, and is itself rejected (same
// as "no manual entry") if it isn't a real currency code — this never
// fabricates or guesses a currency.
//
// The SHOP case (src/app/import/page.tsx real-world regression this fix
// addresses): IBKR import, SHOP is genuinely new, automatic Yahoo lookup
// currently fails in this dev environment, and the user must still be able
// to confirm SHOP and supply USD for the import to proceed.

import { describe, it, expect } from 'vitest';
import {
  resolveNewAssetMeta,
  isValidCurrencyCode,
  filterTickersNeedingCreation,
  type AutoTickerMeta,
} from '../../src/lib/manualAssetMetadata';
import { findUnresolvedTickerRows } from '../../src/lib/unresolvedTickers';

const autoOk: AutoTickerMeta = { ticker: 'AAPL', name: 'Apple Inc.', currency: 'USD', price_multiplier: 1 };
const autoFailed = (ticker: string): AutoTickerMeta => ({ ticker, name: null, currency: null, price_multiplier: 1 });
const shopAutoFailed = autoFailed('SHOP');

describe('resolveNewAssetMeta — automatic lookup succeeds', () => {
  it('uses the automatic result and ignores any manual metadata (no fallback needed)', () => {
    const result = resolveNewAssetMeta(autoOk, { currency: 'GBP', name: 'Wrong Name' });
    expect(result).toEqual({
      status: 'ok',
      source: 'auto',
      ticker: 'AAPL',
      name: 'Apple Inc.',
      currency: 'USD',
      price_multiplier: 1,
    });
  });

  it('uses the automatic result when no manual metadata was supplied at all', () => {
    const result = resolveNewAssetMeta(autoOk);
    expect(result).toMatchObject({ status: 'ok', source: 'auto', currency: 'USD' });
  });
});

describe('resolveNewAssetMeta — automatic lookup returns no currency', () => {
  it('is "missing" when no manual metadata is provided (manual metadata is required)', () => {
    const result = resolveNewAssetMeta(shopAutoFailed);
    expect(result).toEqual({
      status: 'missing',
      ticker: 'SHOP',
      reason: 'Automatic lookup could not determine a currency, and no manual currency was provided.',
    });
  });

  it('is "missing" when manual metadata is supplied but with no currency', () => {
    const result = resolveNewAssetMeta(shopAutoFailed, { name: 'Shopify Inc.' });
    expect(result.status).toBe('missing');
  });

  it('the real SHOP case: user supplies USD and asset creation can proceed', () => {
    const result = resolveNewAssetMeta(shopAutoFailed, { currency: 'USD' });
    expect(result).toEqual({
      status: 'ok',
      source: 'manual',
      ticker: 'SHOP',
      name: null,
      currency: 'USD',
      price_multiplier: 1,
    });
  });

  it('accepts a manually supplied name alongside the manual currency', () => {
    const result = resolveNewAssetMeta(shopAutoFailed, { currency: 'usd', name: '  Shopify Inc.  ' });
    expect(result).toMatchObject({ status: 'ok', source: 'manual', currency: 'USD', name: 'Shopify Inc.' });
  });

  it('falls back to the automatic name when no manual name is given', () => {
    const auto: AutoTickerMeta = { ticker: 'SHOP', name: 'Shopify Inc.', currency: null, price_multiplier: 1 };
    const result = resolveNewAssetMeta(auto, { currency: 'USD' });
    expect(result).toMatchObject({ status: 'ok', name: 'Shopify Inc.' });
  });

  it('rejects an invalid/unrecognised currency code, same outcome as no manual metadata', () => {
    const result = resolveNewAssetMeta(shopAutoFailed, { currency: 'XYZ' });
    expect(result).toEqual({
      status: 'missing',
      ticker: 'SHOP',
      reason: "'XYZ' is not a recognised currency code.",
    });
  });

  it('rejects a 2-letter code (e.g. a country code typed by mistake)', () => {
    const result = resolveNewAssetMeta(shopAutoFailed, { currency: 'US' });
    expect(result.status).toBe('missing');
  });

  it('rejects a non-string currency value without throwing', () => {
    const result = resolveNewAssetMeta(shopAutoFailed, { currency: 123 as unknown as string });
    expect(result.status).toBe('missing');
  });
});

describe('isValidCurrencyCode', () => {
  it('accepts real ISO codes, case-insensitively and trimmed', () => {
    expect(isValidCurrencyCode('USD')).toBe(true);
    expect(isValidCurrencyCode('usd')).toBe(true);
    expect(isValidCurrencyCode(' GBP ')).toBe(true);
  });

  it('rejects made-up or malformed codes', () => {
    expect(isValidCurrencyCode('XYZ')).toBe(false);
    expect(isValidCurrencyCode('US')).toBe(false);
    expect(isValidCurrencyCode('')).toBe(false);
    expect(isValidCurrencyCode(null)).toBe(false);
    expect(isValidCurrencyCode(undefined)).toBe(false);
    expect(isValidCurrencyCode(42)).toBe(false);
  });
});

describe('filterTickersNeedingCreation — no duplicate asset creation', () => {
  it('excludes a ticker that already exists as an asset by confirm time (appeared between preview and confirm)', () => {
    const result = filterTickersNeedingCreation(['SHOP', 'NEWCO'], [{ ticker: 'SHOP' }, { ticker: 'AAPL' }]);
    expect(result).toEqual(['NEWCO']);
  });

  it('is case-insensitive when matching against existing assets', () => {
    const result = filterTickersNeedingCreation(['shop'], [{ ticker: 'SHOP' }]);
    expect(result).toEqual([]);
  });

  it('de-duplicates the confirmed-tickers list itself', () => {
    const result = filterTickersNeedingCreation(['SHOP', 'SHOP', 'NEWCO'], []);
    expect(result).toEqual(['SHOP', 'NEWCO']);
  });

  it('returns everything unchanged when nothing already exists', () => {
    const result = filterTickersNeedingCreation(['SHOP', 'NEWCO'], []);
    expect(result).toEqual(['SHOP', 'NEWCO']);
  });
});

describe('composition with the unresolved-ticker gate — protection unchanged', () => {
  it('a ticker resolved via manual fallback satisfies findUnresolvedTickerRows exactly like an auto-resolved one', () => {
    const resolved = resolveNewAssetMeta(shopAutoFailed, { currency: 'USD' });
    expect(resolved.status).toBe('ok');

    const knownAfterCreation = new Set(resolved.status === 'ok' ? [resolved.ticker] : []);
    const rows = findUnresolvedTickerRows(
      [{ rowNum: 2, ticker: 'SHOP', date: '2026-09-14', portfolioId: 'p1' }],
      (ticker) => knownAfterCreation.has(ticker),
      () => 'IBKR ISA STK'
    );
    expect(rows).toEqual([]);
  });

  it('a ticker still "missing" after manual fallback is correctly reported as unresolved (import stays blocked)', () => {
    const resolved = resolveNewAssetMeta(shopAutoFailed); // no manual metadata supplied
    expect(resolved.status).toBe('missing');

    const knownAfterCreation = new Set<string>(); // nothing was created
    const rows = findUnresolvedTickerRows(
      [{ rowNum: 2, ticker: 'SHOP', date: '2026-09-14', portfolioId: 'p1' }],
      (ticker) => knownAfterCreation.has(ticker),
      () => 'IBKR ISA STK'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ticker).toBe('SHOP');
  });
});
