// CURRENT-BEHAVIOUR CHARACTERISATION — realised P/L with FX (T5, native-currency side)
//
// This documents what applyTransactionToHolding actually computes TODAY for a
// GBP-base portfolio holding a USD asset: cost basis is retranslated using the
// SELL row's OWN implied FX rate (cash_value / settle_value), not the rate
// that applied when the shares were bought. This is what the code calls
// "realised_value" today — it is explicitly NOT the agreed target
// specification (Definition B). The Definition-B figure is a target-spec test
// in target-spec.pending.spec.ts, currently pending because the parallel
// portfolio-base cost ledger these tests would need does not exist yet.

import { describe, it, expect } from 'vitest';
import { applyTransactionToHolding, impliedFxFromSellRow } from '../../src/lib/queries';
import { makeTxn, makeHolding } from './helpers';

describe('impliedFxFromSellRow (pure unit)', () => {
  it('returns cash_value/settle_value when both are present', () => {
    const fx = impliedFxFromSellRow(makeTxn({ cash_value: 4122.75, settle_value: 5497 }));
    expect(fx).toBeCloseTo(0.75, 6);
  });

  it('returns 1 when cash_ccy equals settle_ccy (no conversion needed)', () => {
    const fx = impliedFxFromSellRow(makeTxn({ cash_ccy: 'GBP', settle_ccy: 'GBP' }));
    expect(fx).toBe(1);
  });
});

describe('T5 (native currency side, preserved regardless of the A/B decision)', () => {
  it('tracks cost basis and share count in the asset currency (USD) with no FX applied at all', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD' });
    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'BUY', quantity: 100, price: 50, fee: 2, settle_value: 5002, settle_ccy: 'USD', cash_value: 4001.6, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8 })
    );
    expect(holding.total_shares).toBe(100);
    expect(holding.total_cost).toBeCloseTo(5002, 6); // native (USD) cost basis — untouched by any FX

    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'SELL', quantity: 100, settle_value: 5497, settle_ccy: 'USD', cash_value: 4122.75, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.75 })
    );
    expect(holding.total_shares).toBe(0);
    expect(holding.total_cost).toBe(0);
  });
});

describe('T5 (CURRENT proceeds-currency realised_value — "Definition A as coded", not the agreed target)', () => {
  it('retranslates the removed cost using the SELL row\'s own implied FX, not the acquisition-date rate', () => {
    // BUY: paid £4,001.60 for the position (implied FX 0.80). This actual GBP
    // cash cost is NOT what today's code uses for realised_value.
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', total_shares: 100, total_cost: 5002, avg_price: 50.02 });

    // SELL: proceeds £4,122.75 (implied FX 0.75).
    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'SELL', quantity: 100, settle_value: 5497, settle_ccy: 'USD', cash_value: 4122.75, cash_ccy: 'GBP' })
    );

    // Today's mechanism: cost removed (5002, all of it) retranslated at THIS
    // sell row's implied FX (0.75), not at 0.80: 5002 * 0.75 = 3751.50.
    // realised_value = proceeds - retranslated cost = 4122.75 - 3751.50 = 371.25.
    expect(holding.realised_value).toBeCloseTo(371.25, 6);

    // This is NOT the agreed target (£121.15, the actual GBP cash-in-minus-
    // cash-out difference: 4122.75 - 4001.60). The £250.10 gap between them
    // (4001.60 - 3751.50) is exactly the FX movement between the buy and sell
    // dates, which today's formula folds silently into the "gain" instead of
    // reporting it as a currency effect. See target-spec.pending.spec.ts.
    expect(holding.realised_value).not.toBeCloseTo(121.15, 1);
  });
});
