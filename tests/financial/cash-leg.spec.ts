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
  resolveUngatedCashValue,
  CASH_LEG_TRANSACTION_TYPES,
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

  it('FXM is NEVER gated, regardless of ticker — its cash_value is already the final signed base-currency amount', () => {
    // This is the critical case: FXM's own asset is CASH.GBP (isCashAssetTicker
    // = true), which for BUY/SELL/TIN/TOT would matter — but FXM must bypass
    // the gate unconditionally. If FXM were routed through resolveRowCashLeg
    // instead, its CASH.GBP-in-a-GBP-portfolio same-currency case would hit
    // resolveCashLeg's same-currency branch, which returns Math.abs(settleAbs)
    // — silently discarding the sign of every realised FX loss.
    expect(shouldApplyCashLegGate('FXM', true)).toBe(false);
    expect(shouldApplyCashLegGate('FXM', false)).toBe(false);
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

// ---------------------------------------------------------------------------
// resolveUngatedCashValue — the row-construction path used for rows that
// shouldApplyCashLegGate excludes (FXM, and an ordinary-security TIN/TOT).
// This is the exact function src/app/api/import-transactions/route.ts calls
// in its `else` branch, extracted so it's directly testable. These are
// REGRESSION tests: they exist because a sign-loss defect was found in the
// GATED path (resolveCashLeg's same-currency branch, and its
// isPositiveFinite(explicitCashValue) guard) — this proves the UNGATED path
// FXM actually uses does not share that defect.
// ---------------------------------------------------------------------------

describe('resolveUngatedCashValue — FXM row construction: sign and precision must survive unchanged', () => {
  it('a negative explicit cash_value is returned exactly as-is, sign intact (the -5.343045 case from the FXM design report)', () => {
    expect(resolveUngatedCashValue(-5.343045, 1, -5.343045, 0)).toBe(-5.343045);
  });

  it('does NOT flip the sign the way the same-currency cash-leg-gate branch would', () => {
    // If this row were wrongly routed through resolveCashLeg with
    // assetCcy === baseCcy (exactly FXM's CASH.GBP-in-a-GBP-portfolio case),
    // the result would be Math.abs(5.343045) = 5.343045 (wrong sign).
    const wrongGatedResult = resolveCashLeg({ assetCcy: 'GBP', baseCcy: 'GBP', settleAbs: 5.343045 });
    expect(wrongGatedResult.status).toBe('ok');
    if (wrongGatedResult.status === 'ok') expect(wrongGatedResult.cash_value).toBe(5.343045); // positive: the bug this path avoids

    const actualUngatedResult = resolveUngatedCashValue(-5.343045, 1, -5.343045, 0);
    expect(actualUngatedResult).toBe(-5.343045); // negative: correct
  });

  it('a positive explicit cash_value is returned exactly as-is', () => {
    expect(resolveUngatedCashValue(10.25, 1, 10.25, 0)).toBe(10.25);
  });

  it('a small high-precision negative value retains full precision (-0.000322, real ISA 2026-04-01 daily aggregate)', () => {
    expect(resolveUngatedCashValue(-0.000322, 1, -0.000322, 0)).toBe(-0.000322);
  });

  it('falls back to quantity*price+fee only when no explicit cash_value is supplied at all', () => {
    expect(resolveUngatedCashValue(null, 2, 3, 1)).toBe(7); // 2*3+1, unchanged legacy TIN/TOT fallback
  });

  it('an explicit zero is trusted as zero, not treated as "missing"', () => {
    expect(resolveUngatedCashValue(0, 100, 100, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// allowSignedExplicitCash — the foreign-currency negative-explicit-cash-value
// fix. Context: a real 2026 IBKR TRD WYNN withholding-tax OTR row had source
// cash_value = -1.3890004 GBP, but the imported DB transaction stored
// +1.3890004 GBP — because resolveCashLeg's explicit-cash-value branch used
// isPositiveFinite (n > 0), so a negative explicit value fell through to the
// FX-rate branch, which always produces Math.abs(settleAbs) * rate, a
// positive magnitude. DIV/INT/DEP/WIT/FEE/OTR are genuine cash-impact types
// whose cash_value IS the actual signed movement (a charge is negative, a
// refund/credit is positive) — the asset's own settlement currency must
// never determine that sign. BUY/SELL and CASH.* TIN/TOT must NOT get this
// treatment: their cash_value is always a magnitude (direction comes from
// type/quantity alone), so allowSignedExplicitCash must stay unset/false for
// them — see the "unchanged" describe blocks below, which prove exactly that.
// ---------------------------------------------------------------------------

describe('resolveCashLeg — allowSignedExplicitCash: negative/zero explicit cash values on a foreign-currency cash-impact row', () => {
  it('OTR: explicit -1.2470624 GBP on a USD asset is preserved exactly, not flipped positive (the real OTLY ADR-fee row)', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 1.2470624,
      explicitCashValue: -1.2470624,
      allowSignedExplicitCash: true,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(-1.2470624);
    expect(outcome.cash_ccy).toBe('GBP');
    expect(outcome.source).toBe('explicit-cash-value');
  });

  it('OTR: explicit +1.2470624 GBP on a USD asset is preserved exactly (the reversal leg of the same real event)', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 1.2470624,
      explicitCashValue: 1.2470624,
      allowSignedExplicitCash: true,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(1.2470624);
    expect(outcome.source).toBe('explicit-cash-value');
  });

  it('the real WYNN 2026 withholding-tax row: -1.3890004 GBP must survive, not become +1.3890004', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 1.3890004,
      explicitCashValue: -1.3890004,
      allowSignedExplicitCash: true,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(-1.3890004);
  });

  it('WIT: explicit negative value preserves its sign', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 42,
      explicitCashValue: -33.5,
      allowSignedExplicitCash: true,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(-33.5);
  });

  it('FEE: explicit negative value preserves its sign', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'EUR',
      baseCcy: 'GBP',
      settleAbs: 4.2,
      explicitCashValue: -3.99,
      allowSignedExplicitCash: true,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(-3.99);
  });

  it('DIV: an explicit signed value is preserved appropriately (a positive dividend, foreign-currency asset)', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 12.5,
      explicitCashValue: 9.87,
      allowSignedExplicitCash: true,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(9.87);
  });

  it('INT: an explicit signed value is preserved appropriately (a negative interest adjustment, foreign-currency asset)', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 0.5,
      explicitCashValue: -0.12,
      allowSignedExplicitCash: true,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(-0.12);
  });

  it('a cross-currency asset does not cause the explicit cash_value to be converted or re-signed at all — it is returned byte-for-byte', () => {
    // If this were wrongly falling through to the FX-rate/cached-rate branch,
    // a rate would multiply settleAbs and the result would differ from the
    // supplied value. It must not.
    const outcome = resolveCashLeg({
      assetCcy: 'JPY',
      baseCcy: 'GBP',
      settleAbs: 500,
      explicitCashValue: -2.718281828,
      explicitFxRate: 0.0055, // present but must be ignored: explicit cash wins
      cachedRateAssetToBase: 0.006,
      allowSignedExplicitCash: true,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(-2.718281828);
    expect(outcome.source).toBe('explicit-cash-value');
  });

  it('explicit cash_value = 0 is trusted as exactly 0, not treated as absent / not falling through to FX fallback', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 10,
      explicitCashValue: 0,
      explicitFxRate: 0.8, // must be ignored — an explicit 0 is still "supplied"
      allowSignedExplicitCash: true,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(0);
    expect(outcome.source).toBe('explicit-cash-value');
  });

  it('existing positive explicit cash values remain unchanged by this fix', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 13799.5046,
      explicitCashValue: 10047.97128,
      allowSignedExplicitCash: true,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBeCloseTo(10047.97128, 6);
  });
});

describe('resolveRowCashLeg — allowSignedExplicitCash threaded through the same row-level entry point route.ts actually calls', () => {
  it('the real WYNN OTR row shape: -1.3890004 preserved when the 7th argument (allowSignedExplicitCash) is true', () => {
    const outcome = resolveRowCashLeg('USD', 'GBP', 1.3890004, -1.3890004, null, undefined, true);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(-1.3890004);
  });

  it('omitting the 7th argument defaults to false — old strictly-positive-only behaviour, unchanged (a negative value blocks, exactly as before this fix existed)', () => {
    const outcome = resolveRowCashLeg('USD', 'GBP', 1.3890004, -1.3890004, null, undefined);
    expect(outcome.status).toBe('blocked');
  });
});

describe('BUY/SELL: unchanged by this fix — never treated as a signed-explicit-cash-value transaction', () => {
  it('a negative explicit cash_value on what would be a BUY/SELL call shape (allowSignedExplicitCash NOT set) still blocks, exactly as before', () => {
    // BUY/SELL call sites in route.ts never pass allowSignedExplicitCash=true
    // (CASH_LEG_TRANSACTION_TYPES excludes BUY/SELL) — this reproduces that
    // exact call shape and pins that a stray negative cash_value still can't
    // sneak through as a signed value for a trade.
    const outcome = resolveRowCashLeg('USD', 'GBP', 13799.5046, -10047.97128, null, undefined);
    expect(outcome.status).toBe('blocked');
  });

  it('a real positive BUY explicit cash_value (PLTR shape) is completely unaffected by this fix', () => {
    const outcome = resolveRowCashLeg('USD', 'GBP', 13799.5046, 10047.97128, null, undefined);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBeCloseTo(10047.97128, 6);
    expect(outcome.source).toBe('explicit-cash-value');
  });
});

describe('CASH.GBP TIN/TOT: unchanged by this fix — magnitude + type-direction semantics preserved', () => {
  it('a CASH.* TIN/TOT call shape (allowSignedExplicitCash NOT set) still requires a strictly positive explicit value', () => {
    // Mirrors route.ts: CASH.*-ticker TIN/TOT is gated (shouldApplyCashLegGate)
    // but is NOT in CASH_LEG_TRANSACTION_TYPES, so it never gets
    // allowSignedExplicitCash=true — confirmed here directly.
    expect(shouldApplyCashLegGate('TIN', true)).toBe(true);
    expect(CASH_LEG_TRANSACTION_TYPES.has('TIN')).toBe(false);
    const outcome = resolveRowCashLeg('GBP', 'GBP', 5000, -5000, null, undefined);
    // Same-currency branch (GBP/GBP, exactly the CASH.GBP-in-a-GBP-portfolio
    // shape) is untouched by this fix regardless — always Math.abs(settleAbs).
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(5000);
    expect(outcome.source).toBe('same-currency');
  });
});

describe('FXM: unchanged by this fix — resolveUngatedCashValue path, never resolveCashLeg', () => {
  it('a negative FXM cash_value still survives sign-intact via resolveUngatedCashValue, untouched by allowSignedExplicitCash', () => {
    expect(resolveUngatedCashValue(-1.2470624, 1, -1.2470624, 0)).toBe(-1.2470624);
  });

  it('FXM never reaches resolveCashLeg/resolveRowCashLeg at all (shouldApplyCashLegGate returns false for FXM, confirmed in the existing suite above)', () => {
    expect(shouldApplyCashLegGate('FXM', true)).toBe(false);
    expect(shouldApplyCashLegGate('FXM', false)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// SECOND PHASE (2026-09-23): the same-currency shortcut also overrode a
// signed explicit cash_value, exactly like the cross-currency bug the first
// phase fixed — just gated on currency EQUALITY instead of inequality. Real
// DEV evidence: 2022-05-03 CASH.GBP OTR, source cash_value -0.02, stored as
// +0.02 during the controlled IBKR rebuild's 2022 import. Root cause:
// resolveCashLeg's same-currency branch ran BEFORE the allowSignedExplicitCash
// branch and returned Math.abs(settleAbs) unconditionally. Fix: a new branch
// 0 checks allowSignedExplicitCash + a finite explicit value FIRST, before
// the same-currency shortcut — so a signed explicit cash-impact value is now
// authoritative regardless of the currency relationship, while BUY/SELL and
// CASH.* TIN/TOT (which never set allowSignedExplicitCash) still hit the
// same-currency shortcut first, completely unchanged.
// -----------------------------------------------------------------------------
describe('Same-currency explicit-cash-value fix (2026-09-23, second phase)', () => {
  it('1. the real discovered row: same-currency CASH.GBP OTR, explicit cash_value=-0.02, remains exactly -0.02', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'GBP',
      baseCcy: 'GBP',
      settleAbs: 0.02,
      explicitCashValue: -0.02,
      allowSignedExplicitCash: true,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(-0.02);
    expect(outcome.source).toBe('explicit-cash-value');
  });

  it('2. same-currency CASH.GBP OTR positive explicit value remains positive (the paired 2022-05-03 +0.02 row)', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'GBP',
      baseCcy: 'GBP',
      settleAbs: 0.02,
      explicitCashValue: 0.02,
      allowSignedExplicitCash: true,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(0.02);
    expect(outcome.source).toBe('explicit-cash-value');
  });

  it('3. same-currency explicit cash_value=0 remains exactly zero, not treated as absent', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'GBP',
      baseCcy: 'GBP',
      settleAbs: 10,
      explicitCashValue: 0,
      allowSignedExplicitCash: true,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(0);
    expect(outcome.source).toBe('explicit-cash-value');
  });

  it('4. same-currency negative FEE remains negative', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'GBP',
      baseCcy: 'GBP',
      settleAbs: 3,
      explicitCashValue: -3,
      allowSignedExplicitCash: true,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(-3);
  });

  it('5. same-currency negative WIT remains negative', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'GBP',
      baseCcy: 'GBP',
      settleAbs: 250,
      explicitCashValue: -250,
      allowSignedExplicitCash: true,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(-250);
  });

  it('6. same-currency DIV/INT signed explicit values are preserved (positive DIV, negative-adjustment INT)', () => {
    const div = resolveCashLeg({
      assetCcy: 'GBP', baseCcy: 'GBP', settleAbs: 12.5, explicitCashValue: 12.5, allowSignedExplicitCash: true,
    });
    expect(div.status).toBe('ok');
    if (div.status === 'ok') expect(div.cash_value).toBe(12.5);

    const int = resolveCashLeg({
      assetCcy: 'GBP', baseCcy: 'GBP', settleAbs: 0.5, explicitCashValue: -0.5, allowSignedExplicitCash: true,
    });
    expect(int.status).toBe('ok');
    if (int.status === 'ok') expect(int.cash_value).toBe(-0.5);
  });

  it('7. the already-fixed cross-currency OTLY-style negative OTR remains negative (no regression from reordering)', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 9.16894,
      explicitCashValue: -9.16894,
      allowSignedExplicitCash: true,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(-9.16894);
    expect(outcome.source).toBe('explicit-cash-value');
  });

  it('8. same-currency BUY/SELL behaviour is unchanged: a same-currency BUY call shape still hits the same-currency shortcut, ignoring any explicit cash_value', () => {
    // BUY/SELL never set allowSignedExplicitCash, so branch 0 is a no-op and
    // the same-currency shortcut runs first, exactly as before this fix —
    // even if an explicit cash_value happens to be present on the row.
    const outcome = resolveCashLeg({
      assetCcy: 'GBP',
      baseCcy: 'GBP',
      settleAbs: 100,
      explicitCashValue: 999, // must be ignored: same-currency shortcut wins for BUY/SELL
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(100);
    expect(outcome.source).toBe('same-currency');
  });

  it('9. same-currency CASH.GBP TIN/TOT behaviour is unchanged: magnitude only, negative explicit value still forced positive', () => {
    // Mirrors the existing suite's TIN/TOT test above — re-asserted here
    // specifically to prove branch 0's insertion didn't change this.
    const outcome = resolveRowCashLeg('GBP', 'GBP', 5000, -5000, null, undefined);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(5000);
    expect(outcome.source).toBe('same-currency');
  });

  it('10. FXM remains unchanged: still never reaches resolveCashLeg at all', () => {
    expect(shouldApplyCashLegGate('FXM', true)).toBe(false);
    expect(resolveUngatedCashValue(-8.083393, 1, -8.083393, 0)).toBe(-8.083393);
  });

  it('11. existing eToro (SAP.DE/CAKE) cross-currency protections remain unchanged', () => {
    // SAP.DE-style: cross-currency, no explicit cash value, no FX rate, no
    // cached rate -> still blocks exactly as before (nothing about branch 0
    // changes this, since explicitCashValue is absent here).
    const blocked = resolveCashLeg({
      assetCcy: 'EUR',
      baseCcy: 'GBP',
      settleAbs: 500,
      allowSignedExplicitCash: true,
    });
    expect(blocked.status).toBe('blocked');
  });

  it('12. fallback behaviour with NO explicit cash_value is unchanged (cross-currency, falls through to cached FX rate)', () => {
    const outcome = resolveCashLeg({
      assetCcy: 'USD',
      baseCcy: 'GBP',
      settleAbs: 100,
      allowSignedExplicitCash: true,
      cachedRateAssetToBase: 0.79,
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBeCloseTo(79, 6);
    expect(outcome.source).toBe('cached-fx-rate');
  });

  it('route-level reproduction: the actual discovered row (CASH.GBP, OTR, cash_value=-0.02, GBP-base portfolio) via resolveRowCashLeg + the real CASH_LEG_TRANSACTION_TYPES-derived flag, exactly as route.ts computes it', () => {
    // Mirrors route.ts precisely: allowSignedExplicitCash is derived from
    // CASH_LEG_TRANSACTION_TYPES.has(type), not hardcoded true/false.
    const type = 'OTR';
    const allowSignedExplicitCash = CASH_LEG_TRANSACTION_TYPES.has(type);
    expect(allowSignedExplicitCash).toBe(true);

    const outcome = resolveRowCashLeg('GBP', 'GBP', 0.02, -0.02, null, undefined, allowSignedExplicitCash);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.cash_value).toBe(-0.02);
    expect(outcome.cash_ccy).toBe('GBP');
  });
});
