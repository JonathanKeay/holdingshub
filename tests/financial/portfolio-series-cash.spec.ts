// PORTFOLIO-SERIES CASH — applyCashTxn (src/lib/portfolio-series-cash.ts)
//
// applyCashTxn is a deliberate duplicate of calculateCashBalancesMulti
// (src/lib/queries.ts), used by the historical cash-series chart
// (src/app/api/portfolio-series/route.ts). Its own comment says "Match
// calculateCashBalancesMulti() behavior" — these tests exist so the two can
// never silently drift again, specifically for the BAL reconciliation fix
// (T17: signed cash_value, quantity not consulted).
//
// It was extracted out of route.ts into its own module purely so it could be
// imported here — Next.js route.ts files may only export HTTP-method
// handlers and route config keys, so exporting it directly from route.ts
// fails Next's build-time route-type validation.

import { describe, it, expect } from 'vitest';
import { applyCashTxn, newCashMap, type AssetMeta, type Txn } from '../../src/lib/portfolio-series-cash';

const cashGbp: AssetMeta = {
  id: 'cash-gbp',
  ticker: 'CASH.GBP',
  currency: 'GBP',
  status: 'active',
  resolved_ticker: 'CASH.GBP',
  price_multiplier: 1,
};

const wynn: AssetMeta = {
  id: 'wynn',
  ticker: 'WYNN',
  currency: 'USD',
  status: 'active',
  resolved_ticker: 'WYNN',
  price_multiplier: 1,
};

function balTxn(overrides: Partial<Txn>): Txn {
  return { id: 't1', asset_id: 'cash-gbp', type: 'BAL', cash_ccy: 'GBP', ...overrides };
}

describe('applyCashTxn — BAL: signed cash_value carries both sign and magnitude; quantity is not consulted', () => {
  it('a negative cash_value reduces cash by exactly that amount, with quantity null', () => {
    const cash = newCashMap();
    applyCashTxn(cash, cashGbp, balTxn({ quantity: null, cash_value: -20 }));
    expect(cash.GBP).toBeCloseTo(-20, 6);
  });

  it('a positive cash_value increases cash by exactly that amount', () => {
    const cash = newCashMap();
    applyCashTxn(cash, cashGbp, balTxn({ quantity: null, cash_value: 14.46 }));
    expect(cash.GBP).toBeCloseTo(14.46, 6);
  });

  it('quantity is fully ignored, even if a stray non-null value is present', () => {
    const cash = newCashMap();
    applyCashTxn(cash, cashGbp, balTxn({ quantity: 1, cash_value: -20 }));
    expect(cash.GBP).toBeCloseTo(-20, 6);
  });
});

describe('applyCashTxn — OTR: cash effect is unconditional (kept in lockstep with calculateCashBalancesMulti)', () => {
  it('an OTR row on a security (WYNN, not CASH.*) reduces cash by its signed cash_value — the withholding-tax case', () => {
    const cash = newCashMap();
    applyCashTxn(cash, wynn, { id: 't1', asset_id: 'wynn', type: 'OTR', cash_value: -0.7376932, cash_ccy: 'GBP' });
    expect(cash.GBP).toBeCloseTo(-0.7376932, 6);
  });

  it('an OTR row on a security (OTLY-style ADR fee) reduces cash by its signed cash_value', () => {
    const cash = newCashMap();
    applyCashTxn(cash, wynn, { id: 't1', asset_id: 'wynn', type: 'OTR', cash_value: -9.16894, cash_ccy: 'GBP' });
    expect(cash.GBP).toBeCloseTo(-9.16894, 6);
  });

  it('an OTR row on CASH.GBP continues to affect cash exactly as before the fix', () => {
    const cash = newCashMap();
    applyCashTxn(cash, cashGbp, { id: 't1', asset_id: 'cash-gbp', type: 'OTR', cash_value: 311.13, cash_ccy: 'GBP' });
    expect(cash.GBP).toBeCloseTo(311.13, 6);
  });

  it('a zero-value OTR row has no cash effect', () => {
    const cash = newCashMap();
    applyCashTxn(cash, wynn, { id: 't1', asset_id: 'wynn', type: 'OTR', cash_value: 0, cash_ccy: 'GBP' });
    expect(cash.GBP).toBe(0);
  });
});

describe('applyCashTxn — FXM: cash effect is unconditional, signed, and kept in lockstep with calculateCashBalancesMulti', () => {
  it('a positive FXM on CASH.GBP increases cash by exactly that amount', () => {
    const cash = newCashMap();
    applyCashTxn(cash, cashGbp, { id: 't1', asset_id: 'cash-gbp', type: 'FXM', cash_value: 10.25, cash_ccy: 'GBP' });
    expect(cash.GBP).toBeCloseTo(10.25, 6);
  });

  it('a negative FXM on CASH.GBP decreases cash by exactly that amount', () => {
    const cash = newCashMap();
    applyCashTxn(cash, cashGbp, { id: 't1', asset_id: 'cash-gbp', type: 'FXM', cash_value: -10.25, cash_ccy: 'GBP' });
    expect(cash.GBP).toBeCloseTo(-10.25, 6);
  });

  it('retains sign and precision for a small real value (-0.000322)', () => {
    const cash = newCashMap();
    applyCashTxn(cash, cashGbp, { id: 't1', asset_id: 'cash-gbp', type: 'FXM', cash_value: -0.000322, cash_ccy: 'GBP' });
    expect(cash.GBP).toBeCloseTo(-0.000322, 6);
  });

  it('a zero-value FXM row has no cash effect', () => {
    const cash = newCashMap();
    applyCashTxn(cash, cashGbp, { id: 't1', asset_id: 'cash-gbp', type: 'FXM', cash_value: 0, cash_ccy: 'GBP' });
    expect(cash.GBP).toBe(0);
  });

  it('gives an identical result to calculateCashBalancesMulti for the same FXM transactions (history/current-cash must never drift)', async () => {
    const { calculateCashBalancesMulti } = await import('../../src/lib/queries');
    const txns = [
      { id: 't1', portfolio_id: 'p1', asset_id: 'cash-gbp', type: 'FXM', date: '2026-07-17', cash_value: -5.343045, cash_ccy: 'GBP' },
      { id: 't2', portfolio_id: 'p1', asset_id: 'cash-gbp', type: 'FXM', date: '2026-02-27', cash_value: 25.648407, cash_ccy: 'GBP' },
    ];
    const assetMeta = { 'cash-gbp': { ticker: 'CASH.GBP', currency: 'GBP' as const, status: 'active', name: null, logo_url: null } };

    const viaCanonical = calculateCashBalancesMulti(txns as any, assetMeta as any);
    const canonicalGbp = viaCanonical.find((r) => r.currency === 'GBP')?.balance ?? 0;

    const cash = newCashMap();
    for (const t of txns) applyCashTxn(cash, cashGbp, t as any);

    // calculateCashBalancesMulti rounds to 2dp as a final step; applyCashTxn
    // does not (portfolio-series builds its own running series and rounds
    // for display separately) — compare at 2dp, the shared precision both
    // code paths are actually relied on for.
    expect(cash.GBP).toBeCloseTo(canonicalGbp, 2);
  });
});
