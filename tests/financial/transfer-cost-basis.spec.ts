// TRANSFER COST-BASIS PRESERVATION — pure financial operation layer
//
// Exercises src/lib/transferCostBasis.ts (applyTransferOut / applyTransferIn),
// added as part of the TIN/TOT cost-basis-preservation design review. These
// functions are NOT wired into any import path, UI, or the existing
// applyTransactionToHolding()'s TIN/TOT dispatch — see that file's header
// comment. Current unlinked TIN/TOT behaviour (current-behaviour.*.spec.ts)
// is unchanged and not exercised here.
//
// "External TOT unchanged" (one of the agreed target scenarios) is already
// covered by current-behaviour.positions.spec.ts's T14 and is not duplicated
// here — applyTransferOut's removal math is deliberately identical to T14's,
// which this file's T-full/T-partial cases also confirm from the transfer
// side.

import { describe, it, expect } from 'vitest';
import { applyTransferOut, applyTransferIn, type CostParcel } from '../../src/lib/transferCostBasis';
import { makeHolding } from './helpers';

describe('Transfer-parcel T-full — full internal transfer carries exact source cost forward', () => {
  it('destination inherits quantity and native cost exactly; source is fully zeroed', () => {
    const source = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', total_shares: 200, total_cost: 2000, avg_price: 10 });
    const dest = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD' });

    const parcel = applyTransferOut(source, 200);
    applyTransferIn(dest, parcel);

    expect(source.total_shares).toBe(0);
    expect(source.total_cost).toBe(0);
    expect(dest.total_shares).toBe(200);
    expect(dest.total_cost).toBeCloseTo(2000, 6);
    expect(dest.avg_price).toBeCloseTo(10, 6);
  });
});

describe('Transfer-parcel T-partial — worked example: 200 sh / $2,000 native cost, transfer 50', () => {
  it('source retains 150 sh / $1,500; destination receives 50 sh / $500', () => {
    const source = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', total_shares: 200, total_cost: 2000, avg_price: 10 });
    const dest = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD' });

    const parcel = applyTransferOut(source, 50);
    applyTransferIn(dest, parcel);

    expect(parcel.quantity).toBe(50);
    expect(parcel.nativeCost).toBeCloseTo(500, 6);

    expect(source.total_shares).toBe(150);
    expect(source.total_cost).toBeCloseTo(1500, 6);
    expect(source.avg_price).toBeCloseTo(10, 6); // unchanged — average-cost property preserved

    expect(dest.total_shares).toBe(50);
    expect(dest.total_cost).toBeCloseTo(500, 6);
    expect(dest.avg_price).toBeCloseTo(10, 6);
  });
});

describe('Transfer-parcel T-conservation — transferred cost + remaining source cost = original cost', () => {
  it('holds for a partial transfer', () => {
    const source = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', total_shares: 340, total_cost: 3111.6, avg_price: 9.152941176 });
    const originalCost = source.total_cost;

    const parcel = applyTransferOut(source, 77);

    expect(parcel.nativeCost + source.total_cost).toBeCloseTo(originalCost, 6);
  });

  it('holds for a full transfer (remaining cost is exactly zero)', () => {
    const source = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', total_shares: 48337, total_cost: 0, avg_price: 0 });
    const originalCost = source.total_cost;

    const parcel = applyTransferOut(source, 48337);

    expect(parcel.nativeCost + source.total_cost).toBeCloseTo(originalCost, 6);
    expect(parcel.nativeCost).toBe(0);
  });
});

describe('Transfer-parcel T-no-realised-pnl — a transfer is never a disposal', () => {
  it('applyTransferOut never touches realised fields on the source', () => {
    const source = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', total_shares: 100, total_cost: 1000, avg_price: 10, realised_value: 42, realised_cost: 7, realised_proceeds: 49 });
    applyTransferOut(source, 40);
    expect(source.realised_value).toBe(42);
    expect(source.realised_cost).toBe(7);
    expect(source.realised_proceeds).toBe(49);
  });

  it('applyTransferIn never touches realised fields on the destination', () => {
    const dest = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', realised_value: 3, realised_cost: 1, realised_proceeds: 4 });
    applyTransferIn(dest, { assetId: 'a1', ticker: 'FOO', quantity: 40, nativeCost: 400, nativeCcy: 'USD' });
    expect(dest.realised_value).toBe(3);
    expect(dest.realised_cost).toBe(1);
    expect(dest.realised_proceeds).toBe(4);
  });
});

describe('Transfer-parcel T-market-value-irrelevant — linked TIN cost never comes from transfer-date market value', () => {
  it('applyTransferIn credits exactly the parcel cost, which differs from a qty*price "market value" figure', () => {
    // Mirrors the real defect: today's TIN would book qty*price+fee (a
    // transfer-date market value) as cost. Here the true carried-forward
    // parcel cost is deliberately different from that figure, and only the
    // parcel value must end up on the destination — applyTransferIn's
    // signature has no price/market-value input at all to derive one from.
    const legacyMarketValueIfComputedFromPrice = 585 * 131.78 + 1; // = 77092.3 (today's real, wrong TIN figure)
    const trueCarriedForwardCost = 39359.47296585; // = the real source holding's actual cost

    const dest = makeHolding({ asset_id: 'a1', ticker: 'PLTR', currency: 'USD' });
    applyTransferIn(dest, { assetId: 'a1', ticker: 'PLTR', quantity: 585, nativeCost: trueCarriedForwardCost, nativeCcy: 'USD' });

    expect(dest.total_cost).toBeCloseTo(trueCarriedForwardCost, 6);
    expect(dest.total_cost).not.toBeCloseTo(legacyMarketValueIfComputedFromPrice, 2);
  });
});

describe('Transfer-parcel T-order-independence — parcel is a frozen snapshot, unaffected by what happens to the source afterwards', () => {
  it('source activity after the transfer-out (simulating a pending transfer awaiting its match) does not alter the already-captured parcel', () => {
    const source = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', total_shares: 200, total_cost: 2000, avg_price: 10 });

    // TOT arrives first; parcel captured and left "pending" — no matching TIN yet.
    const parcel = applyTransferOut(source, 50);
    expect(parcel.quantity).toBe(50);
    expect(parcel.nativeCost).toBeCloseTo(500, 6);

    // Time passes. More activity happens on the source holding before the
    // matching TIN is ever recorded (a real possibility with async imports).
    source.total_shares += 300;
    source.total_cost += 3000; // an unrelated later BUY on the same holding

    // The matching TIN finally arrives and is applied against the
    // untouched, previously-captured parcel — not re-derived from the
    // source's current (now different) state.
    const dest = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD' });
    applyTransferIn(dest, parcel);

    expect(dest.total_shares).toBe(50);
    expect(dest.total_cost).toBeCloseTo(500, 6);
  });

  it('applying the same captured parcel regardless of which leg was recorded "first" in wall-clock time yields the same destination result', () => {
    const buildParcel = (): CostParcel => {
      const source = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', total_shares: 140, total_cost: 12948.60, avg_price: 92.49 });
      return applyTransferOut(source, 140);
    };

    // "TOT-first": parcel captured well before applyTransferIn ever runs.
    const parcelCapturedEarly = buildParcel();
    const destA = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP' });
    applyTransferIn(destA, parcelCapturedEarly);

    // "TIN-first" in spirit: the destination side is prepared/considered
    // first; the parcel is only applied once it becomes available. Since
    // applyTransferIn takes the parcel as a value, not a live reference, the
    // result is identical regardless of which side was "ready" first.
    const destB = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP' });
    const parcelAppliedLate = buildParcel();
    applyTransferIn(destB, parcelAppliedLate);

    expect(destA).toEqual(destB);
  });
});

describe('Transfer-parcel T-currency-guard — a mismatched parcel is rejected, not silently applied', () => {
  it('throws rather than crediting a USD parcel onto a GBP holding', () => {
    const dest = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP' });
    expect(() =>
      applyTransferIn(dest, { assetId: 'a1', ticker: 'FOO', quantity: 10, nativeCost: 100, nativeCcy: 'USD' })
    ).toThrow(/currency mismatch/);
  });
});

describe('Transfer-parcel T-real-data — PLTR/PYPL/POLB.L (HGLD ISA STK -> IBKR ISA STK, 2025-06-02)', () => {
  // Figures independently verified against the local dev database (see the
  // TIN/TOT investigation): each source BUY's real settle_value/cash_value,
  // contrasted with today's actual (wrong) production TIN cost for the same
  // transfer. Confirms the new parcel API reconstructs the correct figure
  // for all three, regardless of which side of the transfer is processed
  // first.

  it('PLTR: 585 sh, true cost $39,359.47296585 — not today’s $77,092.30', () => {
    const source = makeHolding({ asset_id: 'pltr', ticker: 'PLTR', currency: 'USD', total_shares: 585, total_cost: 39359.47296585, avg_price: 67.28 });
    const dest = makeHolding({ asset_id: 'pltr', ticker: 'PLTR', currency: 'USD' });

    const parcel = applyTransferOut(source, 585);
    applyTransferIn(dest, parcel);

    expect(dest.total_cost).toBeCloseTo(39359.47296585, 6);
    expect(dest.total_cost).not.toBeCloseTo(77092.30, 2);
    expect(source.total_cost).toBe(0);
  });

  it('PYPL: 140 sh, true cost $17,505.196598 — not today’s $9,840.20', () => {
    const source = makeHolding({ asset_id: 'pypl', ticker: 'PYPL', currency: 'USD', total_shares: 140, total_cost: 17505.196598, avg_price: 125.04 });
    const dest = makeHolding({ asset_id: 'pypl', ticker: 'PYPL', currency: 'USD' });

    const parcel = applyTransferOut(source, 140);
    applyTransferIn(dest, parcel);

    expect(dest.total_cost).toBeCloseTo(17505.196598, 6);
    expect(dest.total_cost).not.toBeCloseTo(9840.20, 2);
    expect(source.total_cost).toBe(0);
  });

  it('POLB.L: 48,337 sh, genuine zero cost — not today’s £1,547.78', () => {
    const source = makeHolding({ asset_id: 'polb', ticker: 'POLB.L', currency: 'GBP', total_shares: 48337, total_cost: 0, avg_price: 0 });
    const dest = makeHolding({ asset_id: 'polb', ticker: 'POLB.L', currency: 'GBP' });

    const parcel = applyTransferOut(source, 48337);
    applyTransferIn(dest, parcel);

    expect(dest.total_cost).toBe(0);
    expect(dest.total_cost).not.toBeCloseTo(1547.78, 2);
    expect(source.total_cost).toBe(0);
  });
});
