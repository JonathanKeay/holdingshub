// Tests for the foreign-currency cash-leg fallback fix (src/lib/cashLeg.ts).
//
// Context: BUY/SELL transactions for a foreign-currency security must never
// have their native settlement amount silently relabelled as if it were
// already a portfolio-base-currency cash amount. These tests pin the exact
// rule: same-currency is untouched; an explicit cash_value or FX rate is
// trusted; a cached local rate for the trade date is used if nothing else is
// available; and if none of those exist, the transaction is blocked rather
// than given a fabricated 1:1 conversion. This is the bug documented against
// real data as the SAP.DE / ETRO row in the Definition B investigation.

import { describe, it, expect } from 'vitest';
import { resolveCashLeg, deriveAssetToBaseRate } from '../../src/lib/cashLeg';

describe('resolveCashLeg — GBP asset in a GBP portfolio (same currency)', () => {
  it('preserves current behaviour exactly: cash_value = settleAbs, fx = 1, no FX path touched', () => {
    const outcome = resolveCashLeg({ assetCcy: 'GBP', baseCcy: 'GBP', settleAbs: 1005 });
    expect(outcome).toEqual({
      status: 'ok',
      cash_value: 1005,
      cash_ccy: 'GBP',
      cash_fx_to_portfolio: 1,
      source: 'same-currency',
    });
  });

  it('is case-insensitive and still same-currency for lower-case input', () => {
    const outcome = resolveCashLeg({ assetCcy: 'gbp', baseCcy: 'GBP', settleAbs: 500 });
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') expect(outcome.source).toBe('same-currency');
  });
});

describe('resolveCashLeg — USD asset in a GBP portfolio, explicit converted cash value supplied', () => {
  it('trusts the explicit cash_value as-is and derives cash_fx_to_portfolio from it', () => {
    // Real PLTR BUY shape: settle_value $13,799.5046, actual GBP paid £10,047.97128.
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 13799.5046,
      explicitCashValue: 10047.97128,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBeCloseTo(10047.97128, 6);
    expect(outcome.cash_ccy).toBe('GBP');
    expect(outcome.cash_fx_to_portfolio).toBeCloseTo(10047.97128 / 13799.5046, 6);
    expect(outcome.source).toBe('explicit-cash-value');
  });

  it('an explicit cash_value wins even when an FX rate or cached rate is also present', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 1000,
      explicitCashValue: 750,
      explicitFxRate: 0.6,
      cachedRateAssetToBase: 0.65,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(750);
    expect(outcome.source).toBe('explicit-cash-value');
  });
});

describe('resolveCashLeg — USD asset in a GBP portfolio, no explicit cash value but a reliable rate exists', () => {
  it('derives cash_value from an explicit FX rate (e.g. a broker-reported rate on the import row)', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 1000,
      explicitFxRate: 0.75,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBeCloseTo(750, 6);
    expect(outcome.cash_ccy).toBe('GBP');
    expect(outcome.cash_fx_to_portfolio).toBe(0.75);
    expect(outcome.source).toBe('explicit-fx-rate');
  });

  it('falls back to a cached local FX rate for the trade date when no explicit rate is given', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 1000,
      cachedRateAssetToBase: 0.8,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBeCloseTo(800, 6);
    expect(outcome.cash_fx_to_portfolio).toBe(0.8);
    expect(outcome.source).toBe('cached-fx-rate');
  });

  it('prefers an explicit FX rate over a cached one when both are present', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 1000,
      explicitFxRate: 0.75,
      cachedRateAssetToBase: 0.8,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_fx_to_portfolio).toBe(0.75);
    expect(outcome.source).toBe('explicit-fx-rate');
  });
});

describe('resolveCashLeg — foreign asset with no usable FX information at all', () => {
  it('must NOT become a fake 1:1 base-currency cash amount — the transaction is blocked instead', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 1000,
    });
    expect(outcome.status).toBe('blocked');
    // Explicitly assert the old buggy behaviour did NOT happen: no 'ok' outcome
    // exists here, so there is no cash_value of 1000 mislabelled as GBP.
    expect((outcome as any).cash_value).toBeUndefined();
    expect((outcome as any).cash_ccy).toBeUndefined();
    if (outcome.status === 'blocked') {
      expect(outcome.reason).toMatch(/no reliable/i);
    }
  });

  it('a zero or negative explicit cash_value/FX rate is treated as absent, not trusted', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 1000,
      explicitCashValue: 0,
      explicitFxRate: -0.5,
    });
    expect(outcome.status).toBe('blocked');
  });
});

describe('resolveCashLeg — USD-base ETRO portfolio buying a EUR security (the real SAP.DE shape)', () => {
  it('reproduces the exact real inputs behind the SAP.DE bug and confirms they now block instead of faking $50 = €50', () => {
    // Real row: qty 0.19605, settle_value €50.00000000742 (EUR), no explicit
    // cash_value or fxrate was ever supplied for it — this is exactly the
    // input shape that today's code turns into a fake "$50.00" cash_value.
    const outcome = resolveCashLeg({
      assetCcy: 'EUR',
      baseCcy: 'USD',
      settleAbs: 50.00000000742,
    });
    expect(outcome.status).toBe('blocked');
  });

  it('derives a correct USD cash_value via deriveAssetToBaseRate when a cached EUR/USD-via-GBP rate exists', () => {
    // fx_rates quotes are GBP-per-unit-foreign, e.g. GBPEUR 1.20, GBPUSD 1.28.
    const quotes = { GBPEUR: 1.2, GBPUSD: 1.28 };
    const rate = deriveAssetToBaseRate(quotes, 'EUR', 'USD');
    expect(rate).not.toBeNull();
    const outcome = resolveCashLeg({
      assetCcy: 'EUR',
      baseCcy: 'USD',
      settleAbs: 50,
      cachedRateAssetToBase: rate,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    // EUR -> GBP -> USD: (1/1.2) * 1.28 = 1.06667
    expect(outcome.cash_fx_to_portfolio).toBeCloseTo((1 / 1.2) * 1.28, 6);
    expect(outcome.cash_value).toBeCloseTo(50 * ((1 / 1.2) * 1.28), 6);
    expect(outcome.source).toBe('cached-fx-rate');
  });
});

describe('deriveAssetToBaseRate — pure FX-cache derivation (ported from the dead computeCashLeg helper)', () => {
  const quotes = { GBPUSD: 1.3, GBPEUR: 1.15 };

  it('returns 1 for same-currency', () => {
    expect(deriveAssetToBaseRate(quotes, 'GBP', 'GBP')).toBe(1);
  });

  it('derives asset -> GBP when base is GBP', () => {
    expect(deriveAssetToBaseRate(quotes, 'USD', 'GBP')).toBeCloseTo(1 / 1.3, 6);
  });

  it('derives GBP -> base when asset is GBP', () => {
    expect(deriveAssetToBaseRate(quotes, 'GBP', 'EUR')).toBeCloseTo(1.15, 6);
  });

  it('derives asset -> GBP -> base for two non-GBP currencies', () => {
    expect(deriveAssetToBaseRate(quotes, 'EUR', 'USD')).toBeCloseTo((1 / 1.15) * 1.3, 6);
  });

  it('returns null when quotes are missing for the required pair', () => {
    expect(deriveAssetToBaseRate({}, 'USD', 'GBP')).toBeNull();
    expect(deriveAssetToBaseRate(null, 'USD', 'GBP')).toBeNull();
  });
});
