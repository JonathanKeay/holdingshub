// CURRENT-BEHAVIOUR CHARACTERISATION
//
// These tests document and protect position/holding behaviour that is already
// correct today in src/lib/queries.ts. They are derived independently from
// first-principles accounting (see the A1 specification matrix), not from
// observing the app's output — the expected numbers were hand-calculated
// before these tests were written.
//
// Covers matrix scenarios: T1, T2, T3, T4, T13, T14, T16, T20, T22.

import { describe, it, expect } from 'vitest';
import { applyTransactionToHolding } from '../../src/lib/queries';
import { makeTxn, makeHolding } from './helpers';

describe('T1 — single BUY (GBP portfolio, GBP asset)', () => {
  it('adds shares and books cost = qty*price + fee', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP' });
    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'BUY', quantity: 100, price: 10.0, fee: 5.0 })
    );
    expect(holding.total_shares).toBe(100);
    expect(holding.total_cost).toBeCloseTo(1005.0, 6);
    expect(holding.avg_price).toBeCloseTo(10.05, 6);
  });
});

describe('T2 — multiple BUYs / average cost', () => {
  it('blends two lots by weighted average cost, not FIFO', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP' });
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 100, price: 10.0, fee: 5.0 }));
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 50, price: 12.0, fee: 3.0 }));

    expect(holding.total_shares).toBe(150);
    expect(holding.total_cost).toBeCloseTo(1608.0, 6); // 1005 + 603
    expect(holding.avg_price).toBeCloseTo(10.72, 6); // 1608 / 150
  });
});

describe('T3 — full SELL closes the position and books realised P/L', () => {
  it('removes all cost and realises proceeds minus average cost', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', total_shares: 150, total_cost: 1608, avg_price: 10.72 });

    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'SELL', quantity: 150, cash_value: 1944, cash_ccy: 'GBP', settle_value: 1944, settle_ccy: 'GBP' })
    );

    expect(holding.total_shares).toBe(0);
    expect(holding.total_cost).toBe(0); // normalised to zero on full exit
    expect(holding.avg_price).toBe(0);
    expect(holding.realised_value).toBeCloseTo(336.0, 6); // 1944 - 1608
    expect(holding.realised_proceeds).toBeCloseTo(1944.0, 6);
    expect(holding.realised_cost).toBeCloseTo(1608.0, 6);
  });
});

describe('T4 — partial SELL preserves average cost on the remainder', () => {
  it('removes a proportional slice of cost and leaves avg_price unchanged', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', total_shares: 150, total_cost: 1608, avg_price: 10.72 });

    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'SELL', quantity: 60, cash_value: 776, cash_ccy: 'GBP', settle_value: 776, settle_ccy: 'GBP' })
    );

    expect(holding.total_shares).toBe(90);
    expect(holding.total_cost).toBeCloseTo(964.8, 6); // 1608 * (90/150)
    expect(holding.avg_price).toBeCloseTo(10.72, 6); // unchanged — defining property of average cost
    expect(holding.realised_value).toBeCloseTo(132.8, 6); // 776 - (1608 * 60/150 = 643.2)
  });
});

describe('T16 — SPL stock split rescales shares and preserves total cost', () => {
  it('forward split (2-for-1) doubles shares, halves avg cost', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', total_shares: 50, total_cost: 1000, avg_price: 20 });
    applyTransactionToHolding(holding, makeTxn({ type: 'SPL', split_factor: 2 }));
    expect(holding.total_shares).toBe(100);
    expect(holding.total_cost).toBeCloseTo(1000, 6); // unchanged — a split creates no value
    expect(holding.avg_price).toBeCloseTo(10, 6);
  });

  it('reverse split (1-for-5, factor 0.2) reduces shares, raises avg cost', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', total_shares: 100, total_cost: 1000, avg_price: 10 });
    applyTransactionToHolding(holding, makeTxn({ type: 'SPL', split_factor: 0.2 }));
    expect(holding.total_shares).toBe(20);
    expect(holding.total_cost).toBeCloseTo(1000, 6);
    expect(holding.avg_price).toBeCloseTo(50, 6);
  });
});

describe('T13 — TIN (security transfer in): adds shares + supplied cost, no cash effect here', () => {
  it('books the supplied settle_value as cost basis in the asset currency', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP' });
    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'TIN', quantity: 40, settle_value: 380, settle_ccy: 'GBP' })
    );
    expect(holding.total_shares).toBe(40);
    expect(holding.total_cost).toBeCloseTo(380, 6);
    expect(holding.avg_price).toBeCloseTo(9.5, 6);
    // applyTransactionToHolding has no notion of cash at all — cash effect (or
    // lack of it) for TIN is decided entirely in calculateCashBalancesMulti,
    // exercised separately in current-behaviour.cash.spec.ts (T13/T14 cash side).
  });
});

describe('T14 — TOT (security transfer out): proportional cost removal, no realised P/L', () => {
  it('removes shares and cost proportionally, books zero realised gain/loss', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', total_shares: 100, total_cost: 1000, avg_price: 10 });
    applyTransactionToHolding(holding, makeTxn({ type: 'TOT', quantity: 40 }));

    expect(holding.total_shares).toBe(60);
    expect(holding.total_cost).toBeCloseTo(600, 6); // 1000 * 60/100
    expect(holding.avg_price).toBeCloseTo(10, 6); // unchanged
    expect(holding.realised_value).toBe(0); // TOT never books a gain/loss — confirmed: transfer only, never a disposal
  });
});

describe('T20 — USD-base portfolio + USD asset: no FX path exercised at all', () => {
  it('behaves identically to the GBP/GBP case when cash_ccy already equals the asset currency', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'ETRO_STK', currency: 'USD' });
    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'BUY', quantity: 20, price: 100, fee: 5, cash_value: 2005, cash_ccy: 'USD', settle_value: 2005, settle_ccy: 'USD' })
    );
    expect(holding.total_shares).toBe(20);
    expect(holding.total_cost).toBeCloseTo(2005, 6);
    expect(holding.avg_price).toBeCloseTo(100.25, 6);
    // GBP conversion of this figure belongs only to the consolidated reporting
    // layer (a spot-rate translation of the total) — never fed back into
    // total_cost. Nothing here should ever require an FX rate.
  });
});

describe('T22 — fully closed position normalises to exactly zero', () => {
  it('forces total_cost and avg_price to zero rather than leaving floating-point residue', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', total_shares: 100, total_cost: 1000, avg_price: 10 });
    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'SELL', quantity: 100, cash_value: 1300, cash_ccy: 'GBP', settle_value: 1300, settle_ccy: 'GBP' })
    );
    expect(holding.total_shares).toBe(0);
    expect(holding.total_cost).toBe(0);
    expect(holding.avg_price).toBe(0);
  });
});
