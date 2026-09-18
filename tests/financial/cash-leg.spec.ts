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
import {
  resolveCashLeg,
  deriveAssetToBaseRate,
  resolveRowCashLeg,
  shouldApplyCashLegGate,
} from '../../src/lib/cashLeg';

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

// ---------------------------------------------------------------------------
// Extension of the cash-leg fix to non-BUY/SELL transaction types (DIV, INT,
// DEP, WIT, FEE, OTR, and CASH.*-ticker TIN/TOT). Context: a real CAKE/USD
// dividend imported with CSV fxrate=0 was harmless by coincidence (same
// currency), but the SAME import also produced a SAP.DE/EUR dividend and two
// GBP deposits with cash_fx_to_portfolio=0 that were mislabelled as USD
// 1:1 — a genuine understatement of portfolio cash. See the DIV/DEP cash-leg
// investigation. These tests pin resolveRowCashLeg/shouldApplyCashLegGate,
// the shared helpers route.ts now uses for every cash-moving type.
// ---------------------------------------------------------------------------

describe('shouldApplyCashLegGate — which transaction types go through the FX-safe gate', () => {
  it('BUY and SELL always do', () => {
    expect(shouldApplyCashLegGate('BUY', false)).toBe(true);
    expect(shouldApplyCashLegGate('SELL', false)).toBe(true);
  });

  it('DIV, INT, DEP, WIT, FEE, OTR always do, regardless of ticker', () => {
    for (const type of ['DIV', 'INT', 'DEP', 'WIT', 'FEE', 'OTR']) {
      expect(shouldApplyCashLegGate(type, false)).toBe(true);
      expect(shouldApplyCashLegGate(type, true)).toBe(true);
    }
  });

  it('TIN/TOT only go through the gate when booked against a CASH.* ticker', () => {
    expect(shouldApplyCashLegGate('TIN', true)).toBe(true);
    expect(shouldApplyCashLegGate('TOT', true)).toBe(true);
    // An ordinary security TIN/TOT is an in-kind transfer: cash_value is
    // never read downstream, so it must NOT be gated on FX availability —
    // that would silently drop a legitimate transfer.
    expect(shouldApplyCashLegGate('TIN', false)).toBe(false);
    expect(shouldApplyCashLegGate('TOT', false)).toBe(false);
  });

  it('SPL is never gated (handled entirely separately, before this logic runs)', () => {
    expect(shouldApplyCashLegGate('SPL', false)).toBe(false);
    expect(shouldApplyCashLegGate('SPL', true)).toBe(false);
  });
});

describe('resolveRowCashLeg — USD/USD dividend, CSV fxrate 0 (the real CAKE row)', () => {
  it('resolves cleanly to same-currency, fx = 1 — never trusts the CSV\'s 0', () => {
    const outcome = resolveRowCashLeg('USD', 'USD', 1.28, null, 0, undefined);
    expect(outcome).toEqual({
      status: 'ok',
      cash_value: 1.28,
      cash_ccy: 'USD',
      cash_fx_to_portfolio: 1,
      source: 'same-currency',
    });
  });
});

describe('resolveRowCashLeg — EUR/USD dividend with a valid explicit FX rate', () => {
  it('converts settleAbs using the explicit rate', () => {
    const outcome = resolveRowCashLeg('EUR', 'USD', 0.42, null, 1.1774, undefined);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_fx_to_portfolio).toBe(1.1774);
    expect(outcome.cash_value).toBeCloseTo(0.42 * 1.1774, 6);
    expect(outcome.cash_ccy).toBe('USD');
    expect(outcome.source).toBe('explicit-fx-rate');
  });
});

describe('resolveRowCashLeg — EUR/USD dividend, CSV fxrate 0, but a cached rate exists for the trade date', () => {
  it('derives a correct USD cash_value from the fx_rates cache instead of trusting the 0 (the real SAP.DE 2026-05-08 row)', () => {
    // Real cached fx_rates quotes row for 2026-05-08 (GBP-per-unit-foreign):
    // GBPEUR 1.156648, GBPUSD 1.361628 -> EUR->USD = (1/1.156648)*1.361628.
    const quotesForDate = { GBPEUR: 1.156648, GBPUSD: 1.361628 };
    const expectedRate = (1 / 1.156648) * 1.361628;

    const outcome = resolveRowCashLeg('EUR', 'USD', 0.42, null, 0, quotesForDate);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_fx_to_portfolio).toBeCloseTo(expectedRate, 6);
    expect(outcome.cash_value).toBeCloseTo(0.42 * expectedRate, 6);
    expect(outcome.cash_ccy).toBe('USD');
    expect(outcome.source).toBe('cached-fx-rate');
    // Sanity: this is the FIX — old behaviour silently stored cash_value =
    // 0.42 (== settleAbs) with cash_ccy 'USD' and fx 0, i.e. treated €0.42
    // as $0.42. The corrected value must differ from that.
    expect(outcome.cash_value).not.toBeCloseTo(0.42, 2);
  });
});

describe('resolveRowCashLeg — EUR/USD dividend, CSV fxrate 0 and no cached rate available (the real 2025-05-16 SAP.DE row)', () => {
  it('is blocked, not silently imported as if EUR were USD', () => {
    // HoldingsHub's fx_rates cache only goes back to 2025-07-21 (verified
    // against the local dev database) — this trade date has no cached row.
    const outcome = resolveRowCashLeg('EUR', 'USD', 0.38, null, 0, undefined);
    expect(outcome.status).toBe('blocked');
    expect((outcome as any).cash_value).toBeUndefined();
    expect((outcome as any).cash_ccy).toBeUndefined();
  });
});

describe('resolveRowCashLeg — GBP/USD deposit, CSV fxrate 0, no cached rate available (the real 2024-11-23 ETRO DEP row)', () => {
  it('is blocked rather than recording £5,024.91 as if it were $5,024.91', () => {
    const outcome = resolveRowCashLeg('GBP', 'USD', 5024.91, null, 0, undefined);
    expect(outcome.status).toBe('blocked');
    if (outcome.status === 'blocked') {
      expect(outcome.reason).toMatch(/no reliable/i);
    }
  });

  it('would have correctly converted it had a cached rate existed (documenting the fix, not just the block)', () => {
    // Illustrative: GBP/USD ~1.2528 on 2024-11-22 (external reference rate;
    // not itself stored by HoldingsHub, whose fx_rates cache does not reach
    // back this far — see the blocked-outcome test above).
    const quotesForDate = { GBPUSD: 1.2528 };
    const outcome = resolveRowCashLeg('GBP', 'USD', 5024.91, null, 0, quotesForDate);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_fx_to_portfolio).toBeCloseTo(1.2528, 6);
    expect(outcome.cash_value).toBeCloseTo(5024.91 * 1.2528, 2);
  });
});

describe('resolveRowCashLeg — BUY/SELL behaviour is unchanged by this fix', () => {
  it('matches resolveCashLeg exactly for the same-currency case', () => {
    const viaShared = resolveRowCashLeg('GBP', 'GBP', 1005, null, null, undefined);
    const viaDirect = resolveCashLeg({ assetCcy: 'GBP', baseCcy: 'GBP', settleAbs: 1005 });
    expect(viaShared).toEqual(viaDirect);
  });

  it('matches resolveCashLeg exactly for the blocked real SAP.DE BUY shape', () => {
    const viaShared = resolveRowCashLeg('EUR', 'USD', 50.00000000742, null, null, undefined);
    const viaDirect = resolveCashLeg({ assetCcy: 'EUR', baseCcy: 'USD', settleAbs: 50.00000000742 });
    expect(viaShared.status).toBe('blocked');
    expect(viaShared).toEqual(viaDirect);
  });

  it('matches resolveCashLeg exactly when an explicit cash_value is supplied', () => {
    const viaShared = resolveRowCashLeg('USD', 'GBP', 13799.5046, 10047.97128, null, undefined);
    const viaDirect = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 13799.5046,
      explicitCashValue: 10047.97128,
    });
    expect(viaShared).toEqual(viaDirect);
  });
});
