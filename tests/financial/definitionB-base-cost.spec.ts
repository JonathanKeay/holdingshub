// DEFINITION B — parallel portfolio-base weighted-average cost ledger
//
// Implements what target-spec.pending.spec.ts previously recorded as
// it.todo under T5/T19/T23 (see git history for those blocks — removed from
// that file now that this is real, tested behaviour, to avoid a "pending"
// file making stale claims). applyTransactionToHolding gained a fully
// additive, opt-in Definition B block (see src/lib/queries.ts) — a Holding
// that never sets base_currency is completely unaffected; every existing
// current-behaviour.*.spec.ts test still passes unmodified.
//
// Definition B: portfolio-base realised P/L = actual portfolio-base sale
// proceeds - historical portfolio-base cost attributable to the units sold.
// Cost comes only from cash_value/cash_ccy (the real cash that moved),
// never from retranslating the native ledger at a sale-date FX rate.

import { describe, it, expect } from 'vitest';
import { applyTransferOut, applyTransferIn } from '../../src/lib/transferCostBasis';
import { applyTransactionToHolding } from '../../src/lib/queries';
import { makeTxn, makeHolding } from './helpers';

describe('Definition B — opt-in / backward compatibility', () => {
  it('a Holding that never sets base_currency is completely unaffected', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD' });
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 100, price: 50, fee: 2, settle_value: 5002, settle_ccy: 'USD', cash_value: 4001.6, cash_ccy: 'GBP' }));
    expect(holding.base_total_cost).toBeUndefined();
    expect(holding.base_realised_value).toBeUndefined();
    expect(holding.base_cost_reliable).toBeUndefined();
  });
});

describe('Definition B — single BUY', () => {
  it('base_total_cost comes from cash_value, independent of the native (asset-currency) figure', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP' });
    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'BUY', quantity: 100, price: 50, fee: 2, settle_value: 5002, settle_ccy: 'USD', cash_value: 4001.6, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8 })
    );
    expect(holding.total_cost).toBeCloseTo(5002, 6); // native — unchanged
    expect(holding.base_total_cost).toBeCloseTo(4001.6, 6);
    expect(holding.base_avg_cost).toBeCloseTo(40.016, 6);
    expect(holding.base_cost_reliable).toBe(true);
  });
});

describe('Definition B — multiple BUYs at different FX rates blend correctly (no naive single-rate translation)', () => {
  it('base_total_cost is the true sum of actual cash paid, not native cost * one FX rate', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP' });
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 100, price: 50, fee: 2, settle_value: 5002, settle_ccy: 'USD', cash_value: 4001.6, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8 }));
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 100, price: 55, fee: 2, settle_value: 5502, settle_ccy: 'USD', cash_value: 4676.7, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.85 }));

    expect(holding.total_shares).toBe(200);
    expect(holding.total_cost).toBeCloseTo(10504, 6); // native: 5002 + 5502

    const trueBase = 4001.6 + 4676.7; // 8678.30 — the real cash paid across both buys
    expect(holding.base_total_cost).toBeCloseTo(trueBase, 6);

    // A naive implementation deriving base cost from a single stored FX rate
    // applied to the native total would get this wrong — e.g. applying the
    // FIRST buy's rate (0.8) to the blended native total would give 8403.20,
    // not 8678.30. Guard against exactly that shortcut.
    expect(holding.base_total_cost).not.toBeCloseTo(10504 * 0.8, 2);
    expect(holding.base_total_cost).not.toBeCloseTo(10504 * 0.85, 2);
  });
});

describe('Definition B — T19: partial-sale cost conservation, independent of the native ledger', () => {
  it('(base cost removed) + (base cost remaining) = original base cost, using its own running total', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP' });
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 100, price: 50, fee: 2, settle_value: 5002, settle_ccy: 'USD', cash_value: 4001.6, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8 }));
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 100, price: 55, fee: 2, settle_value: 5502, settle_ccy: 'USD', cash_value: 4676.7, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.85 }));

    const originalBase = holding.base_total_cost!;
    const originalNative = holding.total_cost;

    // Sell 80 of the 200 shares (40%).
    applyTransactionToHolding(holding, makeTxn({
      type: 'SELL', quantity: 80, settle_value: 4600, settle_ccy: 'USD', cash_value: 3750, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.815,
    }));

    const removedBase = originalBase - holding.base_total_cost!;
    expect(removedBase + holding.base_total_cost!).toBeCloseTo(originalBase, 6);
    expect(removedBase).toBeCloseTo(originalBase * 0.4, 6);

    // The native ledger's own, separately-maintained invariant still holds too.
    const removedNative = originalNative - holding.total_cost;
    expect(removedNative + holding.total_cost).toBeCloseTo(originalNative, 6);
  });
});

describe('Definition B — full SELL', () => {
  it('base_total_cost and base_realised_value: proceeds minus true acquisition cost, not sale-date-retranslated native cost', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP', total_shares: 100, total_cost: 5002, avg_price: 50.02, base_total_cost: 4001.6, base_cost_reliable: true });
    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'SELL', quantity: 100, settle_value: 5497, settle_ccy: 'USD', cash_value: 4122.75, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.75 })
    );
    expect(holding.total_shares).toBe(0);
    expect(holding.base_total_cost).toBe(0);
    expect(holding.base_realised_value).toBeCloseTo(121.15, 6); // 4122.75 - 4001.60
  });
});

describe('Definition B — T5 worked example: native and base-currency realised P/L coexist, independently', () => {
  it('native realised_value (existing, unchanged) stays 371.25; base_realised_value (new) is the true 121.15', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP' });
    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'BUY', quantity: 100, price: 50, fee: 2, settle_value: 5002, settle_ccy: 'USD', cash_value: 4001.6, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8 })
    );
    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'SELL', quantity: 100, settle_value: 5497, settle_ccy: 'USD', cash_value: 4122.75, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.75 })
    );

    // Existing "Definition A as coded" behaviour — untouched (see
    // current-behaviour.fx-realised.spec.ts).
    expect(holding.realised_value).toBeCloseTo(371.25, 6);

    // New Definition B figure, computed independently.
    expect(holding.base_realised_value).toBeCloseTo(121.15, 6);

    // Native (asset-currency) ledger, also untouched.
    expect(holding.total_cost).toBe(0);
  });
});

describe('Definition B — T23: USD-base portfolio, own-currency ledger (GBP is reporting-layer only)', () => {
  it('base_currency = USD tracks the portfolio-base P/L in USD, with no GBP anywhere in the calculation', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'SAP.DE', currency: 'EUR', base_currency: 'USD' });
    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'BUY', quantity: 10, price: 100, fee: 0, settle_value: 1000, settle_ccy: 'EUR', cash_value: 1080, cash_ccy: 'USD', cash_fx_to_portfolio: 1.08 })
    );
    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'SELL', quantity: 10, settle_value: 1100, settle_ccy: 'EUR', cash_value: 1210, cash_ccy: 'USD', cash_fx_to_portfolio: 1.10 })
    );
    expect(holding.base_realised_value).toBeCloseTo(1210 - 1080, 6); // 130, in USD
    expect(holding.base_cost_reliable).toBe(true);
  });
});

describe('Definition B — same-currency asset: no FX logic needed, base ledger tracks native exactly', () => {
  it('a GBP asset in a GBP-base portfolio has base_total_cost === total_cost with no special-casing', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', base_currency: 'GBP' });
    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'BUY', quantity: 100, price: 10, fee: 5, settle_value: 1005, settle_ccy: 'GBP', cash_value: 1005, cash_ccy: 'GBP' })
    );
    expect(holding.base_total_cost).toBeCloseTo(holding.total_cost, 6);
    expect(holding.base_total_cost).toBeCloseTo(1005, 6);
  });
});

describe('Definition B — SPL: a split changes no cost, in either currency', () => {
  it('base_total_cost is unchanged by a stock split; base_avg_cost rescales like avg_price', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', base_currency: 'GBP', total_shares: 50, total_cost: 1000, avg_price: 20, base_total_cost: 1000, base_cost_reliable: true });
    applyTransactionToHolding(holding, makeTxn({ type: 'SPL', split_factor: 2 }));
    expect(holding.total_shares).toBe(100);
    expect(holding.base_total_cost).toBeCloseTo(1000, 6);
    expect(holding.base_avg_cost).toBeCloseTo(10, 6);
  });
});

describe('Definition B — TIN/TOT taint the base ledger until a linked-transfer carry-forward exists', () => {
  it('a TOT marks base_cost_reliable false; native ledger is unaffected', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP', total_shares: 100, total_cost: 5000, avg_price: 50, base_total_cost: 4000, base_cost_reliable: true });
    applyTransactionToHolding(holding, makeTxn({ type: 'TOT', quantity: 40 }));
    expect(holding.base_cost_reliable).toBe(false);
    expect(holding.base_avg_cost).toBeUndefined();
    expect(holding.total_shares).toBe(60); // native ledger: unaffected by this feature
    expect(holding.total_cost).toBeCloseTo(3000, 6);
  });

  it('a TIN marks base_cost_reliable false even though shares and native cost book normally', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', base_currency: 'GBP' });
    applyTransactionToHolding(holding, makeTxn({ type: 'TIN', quantity: 40, settle_value: 380, settle_ccy: 'GBP' }));
    expect(holding.base_cost_reliable).toBe(false);
    expect(holding.total_shares).toBe(40);
    expect(holding.total_cost).toBeCloseTo(380, 6); // native TIN behaviour — unchanged
  });
});

describe('Definition B — real data: SAP.DE (ETRO TRD STK) is correctly flagged unreliable', () => {
  it('the real BUY row (cash_fx_to_portfolio = 0, EUR asset relabelled as USD 1:1) taints the base ledger', () => {
    const holding = makeHolding({ asset_id: 'sap', ticker: 'SAP.DE', currency: 'EUR', base_currency: 'USD' });
    applyTransactionToHolding(
      holding,
      makeTxn({ type: 'BUY', quantity: 0.19605, price: 255.0369804, fee: 0, settle_value: 50.00000000742, settle_ccy: 'EUR', cash_value: 50, cash_ccy: 'USD', cash_fx_to_portfolio: 0 })
    );
    expect(holding.base_cost_reliable).toBe(false);
    expect(holding.base_avg_cost).toBeUndefined();
    // Native ledger is completely unaffected — the cash-leg safeguard
    // (commit 4767162) is an IMPORT-time control; it does not retroactively
    // touch this already-imported row, and Definition B does not either.
    expect(holding.total_cost).toBeCloseTo(50.00000000742, 6);
  });
});

describe('Definition B — real data: RKH and AMS (mislabelled asset currency, but a valid GBP cash leg) remain reliable', () => {
  it('RKH: BUY then partial SELL compute a real base_realised_value despite assets.currency being wrong', () => {
    // assets.currency is recorded as USD for this LSE-listed GBP holding (a
    // separate, unrelated data-quality issue — see the investigation
    // report). cash_ccy/cash_value are correctly GBP and match the
    // portfolio's base currency, so Definition B has everything it needs
    // regardless of the asset-currency mislabelling.
    const holding = makeHolding({ asset_id: 'rkh', ticker: 'RKH', currency: 'USD', base_currency: 'GBP' });
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 150, price: 1.22488, fee: 12.87, settle_value: 196.602, settle_ccy: 'USD', cash_value: 196.6, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 }));
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 1800, price: 0.199728, fee: 11.95, settle_value: 371.4604, settle_ccy: 'USD', cash_value: 371.46, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 }));
    expect(holding.base_cost_reliable).toBe(true);

    applyTransactionToHolding(holding, makeTxn({ type: 'SELL', quantity: 1950, settle_value: 193.7875, settle_ccy: 'USD', cash_value: 169.89, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 }));
    expect(holding.base_cost_reliable).toBe(true);
    expect(holding.base_realised_value).toBeCloseTo(169.89 - (196.6 + 371.46), 6);
  });
});

// ---------------------------------------------------------------------------
// base_realised_reliable — realised-P/L reliability must survive a full close
// ---------------------------------------------------------------------------
// Fixes the bug found during the Definition B activation-readiness audit:
// base_cost_reliable resets to true on full closure (correct for the OPEN
// cost snapshot — see its updated doc comment in src/lib/queries.ts), but
// that same reset used to be the ONLY signal available, silently un-flagging
// a cumulative base_realised_value that may already contain a permanent,
// unrecoverable gap from an earlier skipped disposal. base_realised_reliable
// is a separate, NEVER-resetting flag for exactly that cumulative figure.

describe('base_realised_reliable — unreliable TIN then a full SELL', () => {
  it('the close resets base_cost_reliable (open) but base_realised_reliable (cumulative) stays false', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP' });
    // Unresolved TIN: taints the open-cost dimension immediately.
    applyTransactionToHolding(holding, makeTxn({ type: 'TIN', quantity: 100, settle_value: 5000, settle_ccy: 'USD' }));
    expect(holding.base_cost_reliable).toBe(false);
    expect(holding.base_realised_reliable).toBe(true); // nothing realised yet — correctly still true

    // Full close while the cost basis is unreliable — its contribution is skipped.
    applyTransactionToHolding(holding, makeTxn({ type: 'SELL', quantity: 100, settle_value: 5500, settle_ccy: 'USD', cash_value: 4000, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8 }));

    expect(holding.total_shares).toBe(0);
    expect(holding.base_cost_reliable).toBe(true); // open dimension: correctly reset, nothing open left to distrust
    expect(holding.base_realised_reliable).toBe(false); // cumulative dimension: permanently tainted, NOT reset
    expect(holding.base_realised_value).toBe(0); // the skipped disposal contributed nothing — not fabricated
  });
});

describe('base_realised_reliable — unreliable TIN, full SELL, then a later genuinely-new reliable BUY/SELL', () => {
  it('the reopened position is individually correct, but the cumulative realised total stays flagged unreliable forever', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP' });
    applyTransactionToHolding(holding, makeTxn({ type: 'TIN', quantity: 100, settle_value: 5000, settle_ccy: 'USD' }));
    applyTransactionToHolding(holding, makeTxn({ type: 'SELL', quantity: 100, settle_value: 5500, settle_ccy: 'USD', cash_value: 4000, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8 }));
    expect(holding.base_realised_reliable).toBe(false);

    // A genuinely new, fully-reliable lot — no connection to the old TIN.
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 50, price: 20, fee: 0, settle_value: 1000, settle_ccy: 'USD', cash_value: 800, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8 }));
    expect(holding.base_cost_reliable).toBe(true); // open dimension: correctly trustworthy again
    expect(holding.base_total_cost).toBeCloseTo(800, 6); // clean — no contamination from the old TIN

    applyTransactionToHolding(holding, makeTxn({ type: 'SELL', quantity: 50, settle_value: 1200, settle_ccy: 'USD', cash_value: 1000, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.833 }));
    // This SELL's own contribution (1000 - 800 = 200) is computed and added —
    // individually correct — but the cumulative total still carries the
    // earlier unrecoverable gap, so it must stay flagged unreliable.
    expect(holding.base_realised_value).toBeCloseTo(200, 6);
    expect(holding.base_realised_reliable).toBe(false);
  });
});

describe('base_realised_reliable — mixed reliable/unreliable lots', () => {
  it('one unreliable BUY among reliable ones taints a later partial SELL\'s realised contribution permanently', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP' });
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 100, price: 10, fee: 0, settle_value: 1000, settle_ccy: 'USD', cash_value: 800, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8 }));
    expect(holding.base_cost_reliable).toBe(true);

    // Unreliable BUY: cash_ccy doesn't match the portfolio base currency.
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 100, price: 10, fee: 0, settle_value: 1000, settle_ccy: 'USD', cash_value: 800, cash_ccy: 'EUR' }));
    expect(holding.base_cost_reliable).toBe(false);

    applyTransactionToHolding(holding, makeTxn({ type: 'SELL', quantity: 50, settle_value: 600, settle_ccy: 'USD', cash_value: 480, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8 }));
    expect(holding.base_realised_reliable).toBe(false);
    expect(holding.total_shares).toBe(150); // not fully closed — base_cost_reliable has nothing to reset yet
    expect(holding.base_cost_reliable).toBe(false);
  });
});

describe('base_realised_reliable — resolved matched transfer never taints realised reliability', () => {
  it('a linked TIN (via applyTransferIn) followed by a SELL keeps base_realised_reliable true', () => {
    const source = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP', total_shares: 100, total_cost: 1000, base_total_cost: 800, base_cost_reliable: true });
    const transferOutParcel = applyTransferOut(source, 100);
    const dest = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP' });
    applyTransferIn(dest, transferOutParcel);
    expect(dest.base_cost_reliable).toBe(true);
    expect(dest.base_realised_reliable).toBeUndefined(); // never touched — a resolved transfer never realises anything

    applyTransactionToHolding(dest, makeTxn({ type: 'SELL', quantity: 100, settle_value: 1200, settle_ccy: 'USD', cash_value: 1000, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.833 }));
    expect(dest.base_realised_reliable).toBe(true);
    expect(dest.base_realised_value).toBeCloseTo(1000 - 800, 6);
  });
});

describe('base_realised_reliable — normal BUY/SELL lifecycle, never touched by a transfer', () => {
  it('stays true throughout multiple reliable buy/sell cycles', () => {
    const holding = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP' });
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 100, price: 10, fee: 0, settle_value: 1000, settle_ccy: 'USD', cash_value: 800, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.8 }));
    applyTransactionToHolding(holding, makeTxn({ type: 'SELL', quantity: 100, settle_value: 1200, settle_ccy: 'USD', cash_value: 1000, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.833 }));
    expect(holding.base_realised_reliable).toBe(true);

    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 50, price: 20, fee: 0, settle_value: 1000, settle_ccy: 'USD', cash_value: 780, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.78 }));
    applyTransactionToHolding(holding, makeTxn({ type: 'SELL', quantity: 50, settle_value: 1100, settle_ccy: 'USD', cash_value: 850, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.77 }));
    expect(holding.base_realised_reliable).toBe(true);
    expect(holding.base_realised_value).toBeCloseTo((1000 - 800) + (850 - 780), 6);
  });
});

describe('base_realised_reliable — zero-cost but verified holding (POLB.L shape)', () => {
  it('a genuine £0 BUY stays reliable and available, never confused with "unavailable"', () => {
    const holding = makeHolding({ asset_id: 'polb', ticker: 'POLB.L', currency: 'GBP', base_currency: 'GBP' });
    applyTransactionToHolding(holding, makeTxn({ type: 'BUY', quantity: 48337, price: 0, fee: 0, settle_value: 0, settle_ccy: 'GBP', cash_value: 0, cash_ccy: 'GBP', cash_fx_to_portfolio: 0 }));
    expect(holding.base_cost_reliable).toBe(true);
    expect(holding.base_total_cost).toBe(0);
    expect(holding.base_realised_reliable).toBe(true); // never touched — no disposal has happened
  });
});
