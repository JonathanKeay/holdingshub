// Tests for src/lib/confirmTickerMetaResolution.ts — the confirm-stage
// Yahoo-lookup-skip optimisation identified in the 2026-09-14 confirm-stage
// delay investigation. The confirm stage previously re-ran the automatic
// Yahoo lookup for every confirmed ticker even when a valid manual currency
// was already supplied (which only happens after preview already reported
// automatic lookup found nothing for that exact ticker) — a network call
// whose result could never be used. This proves the skip decision in
// isolation, without touching a real Yahoo call: `fetchAuto` below is a
// spy standing in for route.ts's real fetchTickerMeta, so "was Yahoo
// called" is a plain assertion on the spy, not something inferred from
// timing.
//
// See also tests/import/manual-asset-metadata.spec.ts (resolveNewAssetMeta
// precedence itself, unchanged by this fix) and
// tests/integration/shopManualCurrencyConfirm.spec.ts (full real-pipeline
// SHOP manual-USD regression, still exercised end-to-end after this change).

import { describe, it, expect, vi } from 'vitest';
import { resolveConfirmTickerMeta } from '../../src/lib/confirmTickerMetaResolution';
import type { AutoTickerMeta } from '../../src/lib/manualAssetMetadata';

const autoOk = (ticker: string, currency = 'USD'): AutoTickerMeta => ({
  ticker,
  name: `${ticker} Inc.`,
  currency,
  price_multiplier: 1,
});
const autoFailed = (ticker: string): AutoTickerMeta => ({ ticker, name: null, currency: null, price_multiplier: 1 });

describe('resolveConfirmTickerMeta — skips the redundant automatic lookup when manual currency is already valid', () => {
  it('does NOT call fetchAuto when a valid manual currency is supplied (the core fix)', async () => {
    const fetchAuto = vi.fn(async (t: string) => autoFailed(t));

    const result = await resolveConfirmTickerMeta('SHOP', { currency: 'USD' }, fetchAuto);

    expect(fetchAuto).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'ok',
      source: 'manual',
      ticker: 'SHOP',
      name: null,
      currency: 'USD',
      price_multiplier: 1,
    });
  });

  it('SHOP-style flow: manual USD + optional name, still resolves correctly with zero automatic calls', async () => {
    const fetchAuto = vi.fn(async (t: string) => autoFailed(t));

    const result = await resolveConfirmTickerMeta('SHOP', { currency: 'usd', name: 'Shopify Inc.' }, fetchAuto);

    expect(fetchAuto).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'ok',
      source: 'manual',
      ticker: 'SHOP',
      name: 'Shopify Inc.',
      currency: 'USD',
      price_multiplier: 1,
    });
  });

  it('still calls fetchAuto when manual metadata is absent (existing behaviour preserved)', async () => {
    const fetchAuto = vi.fn(async (t: string) => autoOk(t, 'USD'));

    const result = await resolveConfirmTickerMeta('AAPL', undefined, fetchAuto);

    expect(fetchAuto).toHaveBeenCalledTimes(1);
    expect(fetchAuto).toHaveBeenCalledWith('AAPL');
    expect(result).toMatchObject({ status: 'ok', source: 'auto', currency: 'USD' });
  });

  it('still calls fetchAuto when manual metadata has no currency field at all', async () => {
    const fetchAuto = vi.fn(async (t: string) => autoOk(t, 'GBP'));

    const result = await resolveConfirmTickerMeta('VOD', { name: 'Vodafone' }, fetchAuto);

    expect(fetchAuto).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'ok', source: 'auto', currency: 'GBP' });
  });

  it('still calls fetchAuto when the supplied manual currency is invalid — invalid manual data cannot be trusted on its own', async () => {
    const fetchAuto = vi.fn(async (t: string) => autoOk(t, 'EUR'));

    const result = await resolveConfirmTickerMeta('ASML', { currency: 'NOTREAL' }, fetchAuto);

    expect(fetchAuto).toHaveBeenCalledTimes(1);
    // Automatic lookup succeeded, so it's used — precedence unchanged.
    expect(result).toMatchObject({ status: 'ok', source: 'auto', currency: 'EUR' });
  });
});

describe('resolveConfirmTickerMeta — automatic metadata still takes precedence whenever it is actually consulted', () => {
  it('prefers a successful automatic result over manual metadata when manual currency is invalid', async () => {
    const fetchAuto = vi.fn(async (t: string) => autoOk(t, 'USD'));

    const result = await resolveConfirmTickerMeta('AAPL', { currency: 'NOTACODE', name: 'Wrong Name' }, fetchAuto);

    expect(fetchAuto).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 'ok',
      source: 'auto',
      ticker: 'AAPL',
      name: 'AAPL Inc.',
      currency: 'USD',
      price_multiplier: 1,
    });
  });
});

describe('resolveConfirmTickerMeta — unresolved/invalid metadata still blocks safely', () => {
  it('reports "missing" when automatic lookup fails and no manual metadata was supplied', async () => {
    const fetchAuto = vi.fn(async (t: string) => autoFailed(t));

    const result = await resolveConfirmTickerMeta('ZZFAKE', undefined, fetchAuto);

    expect(fetchAuto).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 'missing',
      ticker: 'ZZFAKE',
      reason: 'Automatic lookup could not determine a currency, and no manual currency was provided.',
    });
  });

  it('reports "missing" when automatic lookup fails and the supplied manual currency is invalid — never fabricates a currency', async () => {
    const fetchAuto = vi.fn(async (t: string) => autoFailed(t));

    const result = await resolveConfirmTickerMeta('ZZFAKE', { currency: 'NOTREAL' }, fetchAuto);

    expect(fetchAuto).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 'missing',
      ticker: 'ZZFAKE',
      reason: "'NOTREAL' is not a recognised currency code.",
    });
  });

  it('reports "missing" when automatic lookup fails and manual currency is an empty string', async () => {
    const fetchAuto = vi.fn(async (t: string) => autoFailed(t));

    const result = await resolveConfirmTickerMeta('ZZFAKE', { currency: '' }, fetchAuto);

    expect(fetchAuto).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('missing');
  });
});
