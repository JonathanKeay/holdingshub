// REALISED VALUE CURRENCY DOMAIN — proof and display-layer safety
//
// Part 1 proves, by tracing applyTransactionToHolding's actual SELL-branch
// arithmetic (never by inferring from h.currency or the field name), what
// currency realised_value ends up denominated in across every asset/base
// currency combination that occurs in this app.
//
// Part 2/3 exercises the pure resolution helpers in
// src/lib/definitionBDisplay.ts that TotalHoldingsTable.tsx uses to label
// and (once, correctly) convert a blended holding's realised_value.

import { describe, it, expect } from 'vitest';
import { applyTransactionToHolding } from '../../src/lib/queries';
import { resolveRealisedCcy, resolveRealisedDisplayCcy, baseRealisedContribution } from '../../src/lib/definitionBDisplay';
import { makeHolding, makeTxn } from './helpers';

// ---------------------------------------------------------------------------
// Part 1 — proving the domain from the calculation itself
// ---------------------------------------------------------------------------

describe('realised_value currency domain — proved from the SELL-branch calculation', () => {
  it('GBP security / GBP-base portfolio: realised_value is in GBP (asset ccy and base ccy coincide, no FX step)', () => {
    const h = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP' });
    applyTransactionToHolding(h, makeTxn({ type: 'BUY', quantity: 100, price: 10, fee: 0, settle_value: 1000, settle_ccy: 'GBP', cash_value: 1000, cash_ccy: 'GBP' }));
    applyTransactionToHolding(h, makeTxn({ type: 'SELL', quantity: 100, settle_value: 1200, settle_ccy: 'GBP', cash_value: 1200, cash_ccy: 'GBP' }));
    expect(h.realised_value).toBeCloseTo(200, 6); // 1200 - 1000, GBP throughout
  });

  it('USD security / GBP-base portfolio: realised_value is in GBP, provably NOT the native USD gain', () => {
    const h = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD' });
    applyTransactionToHolding(h, makeTxn({ type: 'BUY', quantity: 100, price: 50, fee: 0, settle_value: 5000, settle_ccy: 'USD', cash_value: 4000, cash_ccy: 'GBP' })); // implied FX 0.8
    applyTransactionToHolding(h, makeTxn({ type: 'SELL', quantity: 100, settle_value: 5500, settle_ccy: 'USD', cash_value: 4400, cash_ccy: 'GBP' })); // implied FX 0.8
    const nativeUsdGain = 5500 - 5000; // = 500, what it would be if realised_value were USD-denominated
    expect(h.realised_value).toBeCloseTo(400, 6); // 4400 - (5000 * 0.8) = 400, in GBP
    expect(h.realised_value).not.toBeCloseTo(nativeUsdGain, 6); // proves it is NOT the USD figure
  });

  it('EUR security / GBP-base portfolio: realised_value is in GBP, provably NOT the native EUR gain', () => {
    const h = makeHolding({ asset_id: 'a1', ticker: 'SAP.DE', currency: 'EUR' });
    applyTransactionToHolding(h, makeTxn({ type: 'BUY', quantity: 100, price: 10, fee: 0, settle_value: 1000, settle_ccy: 'EUR', cash_value: 850, cash_ccy: 'GBP' })); // implied FX 0.85
    applyTransactionToHolding(h, makeTxn({ type: 'SELL', quantity: 100, settle_value: 1100, settle_ccy: 'EUR', cash_value: 935, cash_ccy: 'GBP' })); // implied FX 0.85
    const nativeEurGain = 1100 - 1000; // = 100
    expect(h.realised_value).toBeCloseTo(85, 6); // 935 - (1000 * 0.85) = 85, in GBP
    expect(h.realised_value).not.toBeCloseTo(nativeEurGain, 6);
  });

  it('USD security / USD-base portfolio: realised_value is in USD (asset ccy and base ccy coincide, no FX step)', () => {
    const h = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD' });
    applyTransactionToHolding(h, makeTxn({ type: 'BUY', quantity: 100, price: 10, fee: 0, settle_value: 1000, settle_ccy: 'USD', cash_value: 1000, cash_ccy: 'USD' }));
    applyTransactionToHolding(h, makeTxn({ type: 'SELL', quantity: 100, settle_value: 1200, settle_ccy: 'USD', cash_value: 1200, cash_ccy: 'USD' }));
    expect(h.realised_value).toBeCloseTo(200, 6);
  });

  it('EUR security / USD-base portfolio (the real SAP.DE/ETRO shape): realised_value is in USD, provably NOT the native EUR gain', () => {
    const h = makeHolding({ asset_id: 'a1', ticker: 'SAP.DE', currency: 'EUR' });
    applyTransactionToHolding(h, makeTxn({ type: 'BUY', quantity: 100, price: 10, fee: 0, settle_value: 1000, settle_ccy: 'EUR', cash_value: 1080, cash_ccy: 'USD' })); // implied FX 1.08
    applyTransactionToHolding(h, makeTxn({ type: 'SELL', quantity: 100, settle_value: 1100, settle_ccy: 'EUR', cash_value: 1210, cash_ccy: 'USD' })); // implied FX 1.10
    const nativeEurGain = 1100 - 1000; // = 100
    expect(h.realised_value).toBeCloseTo(110, 6); // 1210 - (1000 * 1.10) = 110, in USD
    expect(h.realised_value).not.toBeCloseTo(nativeEurGain, 6);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — resolveRealisedCcy: what getAllHoldingsAndCashSummary attaches
// ---------------------------------------------------------------------------

describe('resolveRealisedCcy', () => {
  it('a single contributing base currency resolves to that currency', () => {
    expect(resolveRealisedCcy(['GBP'])).toBe('GBP');
    expect(resolveRealisedCcy(new Set(['USD']))).toBe('USD');
  });

  it('no contributing activity resolves to undefined (never a fabricated default)', () => {
    expect(resolveRealisedCcy([])).toBeUndefined();
  });

  it('genuinely different base currencies resolve to MIXED, never silently picking one', () => {
    expect(resolveRealisedCcy(['GBP', 'USD'])).toBe('MIXED');
  });

  it('the same currency contributed multiple times still resolves cleanly (not MIXED)', () => {
    expect(resolveRealisedCcy(['GBP', 'GBP', 'GBP'])).toBe('GBP');
  });
});

// ---------------------------------------------------------------------------
// Part 3 — resolveRealisedDisplayCcy: what TotalHoldingsTable actually uses
// ---------------------------------------------------------------------------

describe('resolveRealisedDisplayCcy', () => {
  it('uses realised_ccy when known — the proven domain, not the asset currency', () => {
    const h = makeHolding({ asset_id: 'a1', ticker: 'PLTR', currency: 'USD', realised_ccy: 'GBP' });
    expect(resolveRealisedDisplayCcy(h)).toBe('GBP');
  });

  it('falls back to the asset currency only when realised_ccy was never determined (no regression for untouched holdings)', () => {
    const h = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD' });
    expect(resolveRealisedDisplayCcy(h)).toBe('USD');
  });

  it('passes MIXED through unchanged — callers must handle it explicitly, never treat it as a real currency', () => {
    const h = makeHolding({ asset_id: 'a1', ticker: 'AMD', currency: 'USD', realised_ccy: 'MIXED' });
    expect(resolveRealisedDisplayCcy(h)).toBe('MIXED');
  });
});

// ---------------------------------------------------------------------------
// Part 4 — aggregate safety: no double conversion, correct mixed consolidation
// ---------------------------------------------------------------------------

// Mirrors TotalHoldingsTable's reduce exactly (see its totalRealisedAllGBP).
function aggregateRealisedToGBP(
  holdings: { realised_value?: number; realised_ccy?: string; currency?: string }[],
  fxRateForCurrency: (ccy?: string) => number
) {
  let total = 0;
  let incomplete = false;
  for (const h of holdings) {
    if (h.realised_ccy === 'MIXED') {
      if ((h.realised_value ?? 0) !== 0) incomplete = true;
      continue;
    }
    const fromCcy = resolveRealisedDisplayCcy(h as any);
    const rate = fxRateForCurrency(fromCcy);
    const contribution = baseRealisedContribution(h as any, (h.realised_value ?? 0) * rate);
    if (contribution.incomplete) { incomplete = true; continue; }
    total += contribution.value;
  }
  return { total, incomplete };
}

describe('a GBP-base realised value is not FX-converted a second time', () => {
  it('fix: using realised_ccy ("GBP") gives rate=1, leaving the value unchanged', () => {
    const h = { realised_value: 1000, realised_ccy: 'GBP', currency: 'USD' }; // the real-world shape: USD asset, GBP-base portfolio
    const fxRateForCurrency = (ccy?: string) => (ccy === 'GBP' ? 1 : 0.7388); // GBP-per-unit convention (see src/lib/fx.ts)
    const result = aggregateRealisedToGBP([h], fxRateForCurrency);
    expect(result.total).toBe(1000); // unchanged — correct, it was already GBP
  });

  it('documents the bug this replaces: using h.currency ("USD") instead would have wrongly re-converted an already-GBP figure', () => {
    const h = { realised_value: 1000, currency: 'USD' }; // simulating the OLD code path (no realised_ccy consulted)
    const fxRateForCurrency = (ccy?: string) => (ccy === 'GBP' ? 1 : 0.7388);
    const buggyResult = 1000 * fxRateForCurrency(h.currency); // what the pre-fix code computed
    expect(buggyResult).toBeCloseTo(738.8, 1); // wrong: a GBP amount scaled as if it were USD
    expect(buggyResult).not.toBe(1000);
  });
});

describe('mixed GBP-base and USD-base holdings in a consolidated GBP total', () => {
  it('a GBP-domain holding, a USD-domain holding, and a genuinely MIXED holding all aggregate correctly', () => {
    const fxRateForCurrency = (ccy?: string) => (ccy === 'GBP' ? 1 : ccy === 'USD' ? 0.7388 : 1);
    const holdings = [
      { realised_value: 1000, realised_ccy: 'GBP', currency: 'GBP' }, // a GBP-base portfolio's contribution
      { realised_value: 100, realised_ccy: 'USD', currency: 'EUR' },  // a USD-base portfolio's contribution (asset ccy irrelevant)
      { realised_value: 500, realised_ccy: 'MIXED', currency: 'USD' }, // spans differing-base-currency portfolios — excluded
    ];
    const result = aggregateRealisedToGBP(holdings, fxRateForCurrency);
    expect(result.total).toBeCloseTo(1000 + 100 * 0.7388, 4); // GBP contributes as-is; USD converted ONCE; MIXED excluded
    expect(result.incomplete).toBe(true); // because of the excluded MIXED holding
  });

  it('with no MIXED holdings present, the consolidated total is complete', () => {
    const fxRateForCurrency = (ccy?: string) => (ccy === 'GBP' ? 1 : 0.7388);
    const holdings = [
      { realised_value: 1000, realised_ccy: 'GBP', currency: 'GBP' },
      { realised_value: 200, realised_ccy: 'USD', currency: 'USD' },
    ];
    const result = aggregateRealisedToGBP(holdings, fxRateForCurrency);
    expect(result.total).toBeCloseTo(1000 + 200 * 0.7388, 4);
    expect(result.incomplete).toBe(false);
  });
});

describe('correct currency labels', () => {
  it('a USD-asset holding whose realised activity all came from a GBP-base portfolio is labelled GBP, not USD', () => {
    const h = makeHolding({ asset_id: 'a1', ticker: 'PLTR', currency: 'USD', realised_ccy: resolveRealisedCcy(['GBP']) });
    expect(resolveRealisedDisplayCcy(h)).toBe('GBP');
  });

  it('an EUR-asset holding whose realised activity all came from a USD-base portfolio is labelled USD, not EUR', () => {
    const h = makeHolding({ asset_id: 'a1', ticker: 'SAP.DE', currency: 'EUR', realised_ccy: resolveRealisedCcy(['USD']) });
    expect(resolveRealisedDisplayCcy(h)).toBe('USD');
  });
});
