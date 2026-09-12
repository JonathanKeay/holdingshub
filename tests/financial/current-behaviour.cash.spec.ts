// CURRENT-BEHAVIOUR CHARACTERISATION — cash side (calculateCashBalancesMulti)
//
// Expected values are hand-calculated independently of the app's output.
// Covers matrix scenarios: T8, T9, T10, T11, T12a/T12b (current), T13/T14
// (cash side), T15, T17 (current mechanism), T21.

import { describe, it, expect } from 'vitest';
import { applyTransactionToHolding, calculateCashBalancesMulti } from '../../src/lib/queries';
import { makeTxn, makeHolding, assetMetaFor, cashFor } from './helpers';

const assets = assetMetaFor({
  'cash-gbp': { ticker: 'CASH.GBP', currency: 'GBP' },
  'cash-usd': { ticker: 'CASH.USD', currency: 'USD' },
  wynn: { ticker: 'WYNN', currency: 'USD' },
  otly: { ticker: 'OTLY', currency: 'USD' },
});

describe('T8/T9 — DIV/INT: gross cash event, independent of any withholding-tax row (no pairing/merging)', () => {
  it('books DIV as a positive gross cash inflow, unaware of any related OTR row', () => {
    const txns = [
      makeTxn({ type: 'DIV', asset_id: 'wynn', date: '2024-05-31', cash_value: 4.904875, cash_ccy: 'GBP' }),
    ];
    const result = calculateCashBalancesMulti(txns, assets);
    // calculateCashBalancesMulti rounds its returned balance to 2dp (pence)
    // as a final step — 4.904875 rounds to 4.90.
    expect(cashFor(result, 'GBP')).toBeCloseTo(4.9, 2);
  });

  it('a same-day OTR withholding-tax row on the SAME security now nets against the DIV, producing real net cash received (OTR cash-effect fix)', () => {
    // Real data example (IBKR ISA, WYNN, 2024-05-31): DIV gross 4.904875, OTR tax -0.7376932.
    // OTR's cash branch is no longer gated by isCashAsset (see "OTR SPEC"
    // describe block below) — DIV and OTR each contribute their own signed
    // cash_value independently (still no explicit pairing/merging logic; it's
    // two separate rows each posting their own amount), so together they land
    // on the real net cash the broker actually credited: 4.904875 - 0.7376932
    // = 4.1671818 -> rounds to 4.17.
    const txns = [
      makeTxn({ type: 'DIV', asset_id: 'wynn', date: '2024-05-31', cash_value: 4.904875, cash_ccy: 'GBP' }),
      makeTxn({ type: 'OTR', asset_id: 'wynn', date: '2024-05-31', cash_value: -0.7376932, cash_ccy: 'GBP' }),
    ];
    const result = calculateCashBalancesMulti(txns, assets);
    expect(cashFor(result, 'GBP')).toBeCloseTo(4.17, 2); // net of withholding tax, NOT 4.90 (gross only)
  });

  it('INT behaves identically to DIV: gross positive cash inflow', () => {
    const txns = [makeTxn({ type: 'INT', asset_id: 'cash-gbp', date: '2024-01-10', cash_value: 2.14, cash_ccy: 'GBP' })];
    const result = calculateCashBalancesMulti(txns, assets);
    expect(cashFor(result, 'GBP')).toBeCloseTo(2.14, 6);
  });
});

describe('OTR SPEC (Cash/FX forensic investigation, Workstream B) — OTR cash effect is unconditional; FEE/DEP/WIT remain gated to CASH.* only', () => {
  it('an OTR row on a real security (not CASH.*) now reduces cash by its signed cash_value — the withholding-tax case', () => {
    // This is exactly the shape of 42 real dividend-withholding-tax OTR rows
    // (IBKR ISA/TRD) — attached to the security ticker whose dividend was
    // taxed, not to CASH.*. Target invariant: for OTR, a non-zero cash_value
    // is an explicit cash movement in cash_ccy regardless of asset_id — the
    // asset is context only. calculateCashBalancesMulti's OTR branch no
    // longer consults isCashAsset/requireCashAsset at all.
    const txns = [makeTxn({ type: 'OTR', asset_id: 'wynn', date: '2024-05-31', cash_value: -0.7376932, cash_ccy: 'GBP' })];
    const result = calculateCashBalancesMulti(txns, assets);
    expect(cashFor(result, 'GBP')).toBeCloseTo(-0.74, 2);
  });

  it('the same fix applies to an OTLY-style ADR fee (OTR on a security)', () => {
    const txns = [makeTxn({ type: 'OTR', asset_id: 'otly', date: '2022-06-09', cash_value: -9.16894, cash_ccy: 'GBP' })];
    const result = calculateCashBalancesMulti(txns, assets);
    expect(cashFor(result, 'GBP')).toBeCloseTo(-9.17, 2);
  });

  it('an OTR row on the CASH.GBP asset (e.g. the HGLD "income sweep" pattern) continues to affect cash exactly as before the fix', () => {
    const txns = [makeTxn({ type: 'OTR', asset_id: 'cash-gbp', date: '2024-06-10', cash_value: 311.13, cash_ccy: 'GBP' })];
    const result = calculateCashBalancesMulti(txns, assets);
    expect(cashFor(result, 'GBP')).toBeCloseTo(311.13, 6);
  });

  it('an OTR row on a CASH.USD asset (e.g. the ETRO pattern) continues to affect cash exactly as before the fix', () => {
    const txns = [makeTxn({ type: 'OTR', asset_id: 'cash-usd', date: '2024-06-10', cash_value: 50, cash_ccy: 'USD' })];
    const result = calculateCashBalancesMulti(txns, assets);
    expect(cashFor(result, 'USD')).toBeCloseTo(50, 6);
  });

  it('a zero-value OTR row has no cash effect, on either a security or a CASH.* asset', () => {
    const txns = [
      makeTxn({ type: 'OTR', asset_id: 'wynn', date: '2024-06-10', cash_value: 0, cash_ccy: 'GBP' }),
      makeTxn({ type: 'OTR', asset_id: 'cash-gbp', date: '2024-06-10', cash_value: 0, cash_ccy: 'GBP' }),
    ];
    const result = calculateCashBalancesMulti(txns, assets);
    expect(cashFor(result, 'GBP')).toBe(0);
  });

  it('by contrast, a DEP/WIT/FEE row on a non-cash security asset still has NO cash effect — this fix does not touch that gate', () => {
    const txns = [
      makeTxn({ type: 'DEP', asset_id: 'wynn', date: '2024-06-10', cash_value: 1000, cash_ccy: 'GBP' }),
      makeTxn({ type: 'WIT', asset_id: 'wynn', date: '2024-06-10', cash_value: 100, cash_ccy: 'GBP' }),
      makeTxn({ type: 'FEE', asset_id: 'wynn', date: '2024-06-10', cash_value: 5, cash_ccy: 'GBP' }),
    ];
    const result = calculateCashBalancesMulti(txns, assets);
    expect(cashFor(result, 'GBP')).toBe(0);
  });

  it('OTR still has zero effect on holdings/units/cost basis/realised P&L, on a security ticker with a non-zero cash_value', () => {
    const holding = makeHolding({ asset_id: 'wynn', ticker: 'WYNN', currency: 'USD' });
    applyTransactionToHolding(holding, makeTxn({ type: 'OTR', asset_id: 'wynn', quantity: 1, price: -3.38, cash_value: -2.55, cash_ccy: 'GBP', settle_value: -3.38, settle_ccy: 'USD' }));
    expect(holding.total_shares).toBe(0);
    expect(holding.total_cost).toBe(0);
    expect(holding.avg_price).toBe(0);
    expect(holding.realised_value).toBe(0);
    expect(holding.realised_cost).toBe(0);
    expect(holding.realised_proceeds).toBe(0);
  });
});

describe('T10/T11 — DEP/WIT: pure cash movement on a CASH.* asset', () => {
  it('DEP increases the correct currency bucket', () => {
    const txns = [makeTxn({ type: 'DEP', asset_id: 'cash-gbp', cash_value: 1000, cash_ccy: 'GBP' })];
    expect(cashFor(calculateCashBalancesMulti(txns, assets), 'GBP')).toBeCloseTo(1000, 6);
  });

  it('WIT decreases the correct currency bucket', () => {
    const txns = [makeTxn({ type: 'WIT', asset_id: 'cash-gbp', cash_value: 250, cash_ccy: 'GBP' })];
    expect(cashFor(calculateCashBalancesMulti(txns, assets), 'GBP')).toBeCloseTo(-250, 6);
  });

  it('a DEP/WIT row on a non-cash security asset has no cash effect (requireCashAssetForCashRows default)', () => {
    const txns = [makeTxn({ type: 'DEP', asset_id: 'wynn', cash_value: 1000, cash_ccy: 'GBP' })];
    expect(cashFor(calculateCashBalancesMulti(txns, assets), 'GBP')).toBe(0);
  });
});

describe('T12a — standalone FEE on a CASH.* asset: cash effect, no P&L', () => {
  it('reduces the correct currency bucket', () => {
    const txns = [makeTxn({ type: 'FEE', asset_id: 'cash-gbp', cash_value: 12, cash_ccy: 'GBP' })];
    expect(cashFor(calculateCashBalancesMulti(txns, assets), 'GBP')).toBeCloseTo(-12, 6);
  });
});

describe('T12b — standalone FEE attributed to a security: CURRENT behaviour only (not the target)', () => {
  it('reduces realised_value via applyTransactionToHolding...', () => {
    const holding = makeHolding({ asset_id: 'wynn', ticker: 'WYNN', currency: 'USD' });
    applyTransactionToHolding(holding, makeTxn({ type: 'FEE', asset_id: 'wynn', fee: 5 }));
    expect(holding.realised_value).toBeCloseTo(-5, 6);
    expect(holding.total_shares).toBe(0);
    expect(holding.total_cost).toBe(0);
  });

  it('...but currently has ZERO cash effect, because the asset is not a CASH.* ticker (documents the gap decision 1 will fix — target-spec test in target-spec.pending.spec.ts)', () => {
    const txns = [makeTxn({ type: 'FEE', asset_id: 'wynn', cash_value: 5, cash_ccy: 'USD' })];
    expect(cashFor(calculateCashBalancesMulti(txns, assets), 'USD')).toBe(0);
  });
});

describe('T13/T14 (cash side) — TIN/TOT of a CASH.* asset is a real cash movement', () => {
  it('TIN of CASH.GBP increases the GBP bucket', () => {
    const txns = [makeTxn({ type: 'TIN', asset_id: 'cash-gbp', cash_value: 15000, cash_ccy: 'GBP' })];
    expect(cashFor(calculateCashBalancesMulti(txns, assets), 'GBP')).toBeCloseTo(15000, 6);
  });

  it('TOT of CASH.GBP decreases the GBP bucket', () => {
    const txns = [makeTxn({ type: 'TOT', asset_id: 'cash-gbp', cash_value: 15000, cash_ccy: 'GBP' })];
    expect(cashFor(calculateCashBalancesMulti(txns, assets), 'GBP')).toBeCloseTo(-15000, 6);
  });

  it('a TIN of a real security (non-cash asset) has NO cash effect, even when cash_value is populated with a notional transfer value', () => {
    // Mirrors real data: a security TIN can carry a populated, non-zero
    // cash_value (a notional portfolio-currency valuation at transfer time),
    // but calculateCashBalancesMulti's TIN/TOT branch is gated on isCashAsset,
    // so it is correctly ignored for cash purposes today.
    const txns = [makeTxn({ type: 'TIN', asset_id: 'wynn', quantity: 585, cash_value: 56877.16, cash_ccy: 'GBP' })];
    expect(cashFor(calculateCashBalancesMulti(txns, assets), 'GBP')).toBe(0);
  });
});

describe('T15 — OTR: generic signed cash effect where currently supported, no semantic meaning asserted', () => {
  it('applies cash_value as-is (signed), on a CASH.* asset, with no sign-inference from type', () => {
    const txns = [makeTxn({ type: 'OTR', asset_id: 'cash-gbp', cash_value: -15, cash_ccy: 'GBP' })];
    expect(cashFor(calculateCashBalancesMulti(txns, assets), 'GBP')).toBeCloseTo(-15, 6);
  });
});

describe('T17 — BAL: signed cash_value carries both sign and magnitude; quantity is not consulted', () => {
  // Corrected per the BAL reconciliation design (Workstream C). Supersedes the
  // old quantity-as-sign-flag characterisation tests that lived here — see
  // git history for the previous (buggy) behaviour they documented.
  it('a negative cash_value reduces cash by exactly that amount, with quantity left null', () => {
    const txns = [makeTxn({ type: 'BAL', asset_id: 'cash-gbp', quantity: null, cash_value: -20, cash_ccy: 'GBP' })];
    expect(cashFor(calculateCashBalancesMulti(txns, assets), 'GBP')).toBeCloseTo(-20, 6);
  });

  it('a positive cash_value increases cash by exactly that amount', () => {
    const txns = [makeTxn({ type: 'BAL', asset_id: 'cash-gbp', quantity: null, cash_value: 14.46, cash_ccy: 'GBP' })];
    expect(cashFor(calculateCashBalancesMulti(txns, assets), 'GBP')).toBeCloseTo(14.46, 6);
  });

  it('quantity is fully ignored, even if a stray non-null value is present on the row', () => {
    // Guards against ever reintroducing the old quantity-derived sign flag.
    const txns = [makeTxn({ type: 'BAL', asset_id: 'cash-gbp', quantity: 1, cash_value: -20, cash_ccy: 'GBP' })];
    expect(cashFor(calculateCashBalancesMulti(txns, assets), 'GBP')).toBeCloseTo(-20, 6);
  });
});

describe('asOf inclusive/exclusive — explicit control for BAL reconciliation pre/post-trade modes', () => {
  it('defaults to inclusive when asOfInclusive is omitted (unchanged behaviour for existing callers)', () => {
    const txns = [makeTxn({ type: 'DEP', asset_id: 'cash-gbp', date: '2026-09-12', cash_value: 100, cash_ccy: 'GBP' })];
    const result = calculateCashBalancesMulti(txns, assets, { asOf: '2026-09-12' });
    expect(cashFor(result, 'GBP')).toBeCloseTo(100, 6);
  });

  it('asOfInclusive: true explicitly includes a transaction dated exactly asOf (post-trade)', () => {
    const txns = [makeTxn({ type: 'DEP', asset_id: 'cash-gbp', date: '2026-09-12', cash_value: 100, cash_ccy: 'GBP' })];
    const result = calculateCashBalancesMulti(txns, assets, { asOf: '2026-09-12', asOfInclusive: true } as any);
    expect(cashFor(result, 'GBP')).toBeCloseTo(100, 6);
  });

  it('asOfInclusive: false excludes a transaction dated exactly asOf (pre-trade)', () => {
    const txns = [makeTxn({ type: 'DEP', asset_id: 'cash-gbp', date: '2026-09-12', cash_value: 100, cash_ccy: 'GBP' })];
    const result = calculateCashBalancesMulti(txns, assets, { asOf: '2026-09-12', asOfInclusive: false } as any);
    expect(cashFor(result, 'GBP')).toBe(0);
  });

  it('asOfInclusive: false still includes a transaction dated strictly before asOf', () => {
    const txns = [makeTxn({ type: 'DEP', asset_id: 'cash-gbp', date: '2026-09-11', cash_value: 100, cash_ccy: 'GBP' })];
    const result = calculateCashBalancesMulti(txns, assets, { asOf: '2026-09-12', asOfInclusive: false } as any);
    expect(cashFor(result, 'GBP')).toBeCloseTo(100, 6);
  });
});

describe('T21 — mixed-currency cash within one portfolio: independent buckets, never netted', () => {
  it('keeps GBP and USD cash as separate totals', () => {
    const txns = [
      makeTxn({ type: 'DEP', asset_id: 'cash-usd', cash_value: 1000, cash_ccy: 'USD' }),
      makeTxn({ type: 'DEP', asset_id: 'cash-gbp', cash_value: 500, cash_ccy: 'GBP' }),
    ];
    const result = calculateCashBalancesMulti(txns, assets);
    expect(cashFor(result, 'GBP')).toBeCloseTo(500, 6);
    expect(cashFor(result, 'USD')).toBeCloseTo(1000, 6);
  });
});
