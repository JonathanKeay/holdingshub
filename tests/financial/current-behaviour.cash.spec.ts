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

  it('IMPORTANT — a same-day OTR withholding-tax row on the SAME security does NOT net against the DIV today (confirms a real, quantifiable gap, not just a hypothetical one)', () => {
    // Real data example (IBKR ISA, WYNN, 2024-05-31): DIV gross 4.904875, OTR tax -0.7376932.
    // Per the "NEW FINDING" describe block below, an OTR row on a non-cash
    // asset (WYNN is not CASH.*) has zero cash effect under the production
    // default requireCashAssetForCashRows=true. DIV/INT's branch has no such
    // gate, so it always contributes. The combination therefore currently
    // books ONLY the gross dividend (4.904875) — the withholding tax is
    // silently dropped, overstating modelled cash by the tax amount on every
    // one of the 42 real dividend-with-tax rows in the data (£76.04 total).
    // This is independent of, and does not require, any DIV/OTR pairing logic
    // — it is a direct, confirmed consequence of today's isCashAsset gate.
    const txns = [
      makeTxn({ type: 'DIV', asset_id: 'wynn', date: '2024-05-31', cash_value: 4.904875, cash_ccy: 'GBP' }),
      makeTxn({ type: 'OTR', asset_id: 'wynn', date: '2024-05-31', cash_value: -0.7376932, cash_ccy: 'GBP' }),
    ];
    const result = calculateCashBalancesMulti(txns, assets);
    // (rounded to 2dp by calculateCashBalancesMulti, as above)
    expect(cashFor(result, 'GBP')).toBeCloseTo(4.9, 2); // NOT 4.17 (the real net cash received, rounded)
  });

  it('INT behaves identically to DIV: gross positive cash inflow', () => {
    const txns = [makeTxn({ type: 'INT', asset_id: 'cash-gbp', date: '2024-01-10', cash_value: 2.14, cash_ccy: 'GBP' })];
    const result = calculateCashBalancesMulti(txns, assets);
    expect(cashFor(result, 'GBP')).toBeCloseTo(2.14, 6);
  });
});

describe('NEW FINDING (surfaced while writing these tests) — OTR/FEE/DEP/WIT rows attached to a non-cash-ticker asset currently have ZERO cash effect', () => {
  it('an OTR row on a real security (not CASH.*) is silently excluded from the cash total under the production default', () => {
    // This is exactly the shape of 50 of your 94 real OTR rows (42 US dividend
    // withholding-tax rows + 8 OTLY ADR-fee rows) — all attached to a security
    // ticker, none to a CASH.* ticker. calculateCashBalancesMulti's OTR branch
    // is gated by `!requireCashAsset || isCashAsset`; with the production
    // default requireCashAssetForCashRows=true and a non-cash asset, isCashAsset
    // is false, so the row is skipped entirely — its negative amount currently
    // has NO effect on the modelled cash balance at all, despite being real
    // money that left the account. This is not something this task was asked
    // to fix — flagging it as newly-confirmed evidence relevant to the Cash/FX
    // forensic investigation (Workstream B).
    const txns = [makeTxn({ type: 'OTR', asset_id: 'wynn', date: '2024-05-31', cash_value: -0.7376932, cash_ccy: 'GBP' })];
    const result = calculateCashBalancesMulti(txns, assets);
    expect(cashFor(result, 'GBP')).toBe(0); // confirmed current behaviour, not a target
  });

  it('the same shape applies to an OTLY-style ADR fee (OTR on a security)', () => {
    const txns = [makeTxn({ type: 'OTR', asset_id: 'otly', date: '2022-06-09', cash_value: -9.16894, cash_ccy: 'GBP' })];
    const result = calculateCashBalancesMulti(txns, assets);
    expect(cashFor(result, 'GBP')).toBe(0);
  });

  it('by contrast, an OTR row on the CASH.GBP asset (e.g. the HGLD "income sweep" pattern) does affect cash', () => {
    const txns = [makeTxn({ type: 'OTR', asset_id: 'cash-gbp', date: '2024-06-10', cash_value: 311.13, cash_ccy: 'GBP' })];
    const result = calculateCashBalancesMulti(txns, assets);
    expect(cashFor(result, 'GBP')).toBeCloseTo(311.13, 6);
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

describe('T17 — BAL: CURRENT mechanism (quantity as sign flag + abs(cash_value)) — not the target', () => {
  it('takes its sign from `quantity`, not from the sign of cash_value', () => {
    // Reconciliation example: modelled cash needs to move -£20 to match the
    // broker. Today's mechanism: quantity<0 flags a decrease, magnitude is
    // abs(cash_value) — cash_value's own sign is not used at all.
    const txns = [makeTxn({ type: 'BAL', asset_id: 'cash-gbp', quantity: -1, cash_value: 20, cash_ccy: 'GBP' })];
    expect(cashFor(calculateCashBalancesMulti(txns, assets), 'GBP')).toBeCloseTo(-20, 6);
  });

  it('a positive quantity flag increases cash regardless of how cash_value is signed (documents the quirk directly)', () => {
    const txns = [makeTxn({ type: 'BAL', asset_id: 'cash-gbp', quantity: 1, cash_value: -20, cash_ccy: 'GBP' })];
    // sign = +1 (quantity >= 0), magnitude = abs(-20) = 20 -> cash += +20,
    // even though cash_value itself was negative. This is exactly the
    // inversion the target spec (signed cash_value, no quantity flag) exists
    // to remove — see target-spec.pending.spec.ts.
    expect(cashFor(calculateCashBalancesMulti(txns, assets), 'GBP')).toBeCloseTo(20, 6);
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
