// DEFINITION B DISPLAY/AGGREGATION SAFETY
//
// Exercises src/lib/definitionBDisplay.ts — the shared rule PerPortfolioTable
// and TotalHoldingsTable both use to fold a holding's cost/realised figure
// into a base-currency aggregate. Environment is plain Node (no DOM/React
// rendering), matching this repo's existing pattern of testing a plain
// exported function pulled out of a component file (see
// tests/components/marketStatusBadges.spec.ts).

import { describe, it, expect } from 'vitest';
import { baseCostContribution, baseRealisedContribution } from '../../src/lib/definitionBDisplay';
import { makeHolding } from './helpers';

// Small local aggregator mirroring exactly what both components' reduce
// loops do, for testing the AGGREGATE-level behaviour (not just one call).
function aggregate(contributions: { value: number; incomplete: boolean }[]) {
  let total = 0;
  let incomplete = false;
  for (const c of contributions) {
    if (c.incomplete) incomplete = true;
    else total += c.value;
  }
  return { total, incomplete };
}

describe('dormant (base_currency unset) — behaves exactly as today, unchanged', () => {
  it('baseCostContribution returns the legacy value verbatim, never marked incomplete', () => {
    const h = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', total_cost: 1000 });
    const legacyValue = 1000 * 0.8; // whatever the existing native×spot-FX calc produced
    const c = baseCostContribution(h, legacyValue);
    expect(c).toEqual({ value: legacyValue, incomplete: false });
  });

  it('baseRealisedContribution returns the legacy value verbatim, never marked incomplete', () => {
    const h = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', realised_value: 500 });
    const legacyValue = 500 * 0.8;
    const c = baseRealisedContribution(h, legacyValue);
    expect(c).toEqual({ value: legacyValue, incomplete: false });
  });
});

describe('reliable positions aggregate normally', () => {
  it('multiple reliable holdings sum their base figures directly, complete', () => {
    const holdings = [
      makeHolding({ asset_id: 'a1', ticker: 'A', currency: 'USD', base_currency: 'GBP', base_cost_reliable: true, base_total_cost: 100 }),
      makeHolding({ asset_id: 'a2', ticker: 'B', currency: 'GBP', base_currency: 'GBP', base_cost_reliable: true, base_total_cost: 250 }),
      makeHolding({ asset_id: 'a3', ticker: 'C', currency: 'EUR', base_currency: 'GBP', base_cost_reliable: true, base_total_cost: 50 }),
    ];
    const result = aggregate(holdings.map((h) => baseCostContribution(h, -999999))); // legacy fallback deliberately absurd — must never be used
    expect(result.total).toBeCloseTo(400, 6);
    expect(result.incomplete).toBe(false);
  });
});

describe('an unreliable position cannot contribute £0 as though verified', () => {
  it('an unreliable holding contributes nothing and is distinguished from a genuinely-zero verified holding', () => {
    const unreliable = makeHolding({ asset_id: 'a1', ticker: 'BAD', currency: 'USD', base_currency: 'GBP', base_cost_reliable: false, base_total_cost: 999 });
    const genuineZero = makeHolding({ asset_id: 'a2', ticker: 'ZERO', currency: 'GBP', base_currency: 'GBP', base_cost_reliable: true, base_total_cost: 0 });

    const badContribution = baseCostContribution(unreliable, -1);
    const zeroContribution = baseCostContribution(genuineZero, -1);

    expect(badContribution).toEqual({ value: 0, incomplete: true }); // value is 0 but MUST be read as "excluded", never as a real figure
    expect(zeroContribution).toEqual({ value: 0, incomplete: false }); // a real, verified zero — counted normally

    // Aggregating both: the genuine zero contributes to the total (as 0,
    // correctly); the unreliable one is excluded and flags the aggregate.
    const result = aggregate([badContribution, zeroContribution]);
    expect(result.total).toBe(0);
    expect(result.incomplete).toBe(true);
  });
});

describe('portfolio/global totals cannot claim to be complete when one constituent is unavailable', () => {
  it('two reliable holdings plus one unreliable holding still flags the whole aggregate incomplete', () => {
    const holdings = [
      makeHolding({ asset_id: 'a1', ticker: 'A', currency: 'USD', base_currency: 'GBP', base_cost_reliable: true, base_total_cost: 1000 }),
      makeHolding({ asset_id: 'a2', ticker: 'B', currency: 'GBP', base_currency: 'GBP', base_cost_reliable: true, base_total_cost: 2000 }),
      makeHolding({ asset_id: 'a3', ticker: 'SAP.DE', currency: 'EUR', base_currency: 'USD', base_cost_reliable: false }),
    ];
    const result = aggregate(holdings.map((h) => baseCostContribution(h, 0)));
    expect(result.total).toBeCloseTo(3000, 6); // only the two reliable holdings
    expect(result.incomplete).toBe(true); // but the aggregate must never claim to be complete
  });
});

describe('no current-spot FX conversion is applied to base_total_cost', () => {
  it('the returned value is exactly base_total_cost, never multiplied by the supplied legacy/fx-derived figure', () => {
    const h = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP', base_cost_reliable: true, base_total_cost: 31306.52 });
    // A wildly different legacy value (as if native×today's-spot-FX had been
    // used) must be completely ignored once base_currency is reliable.
    const legacyIfWronglyConverted = 999999.99;
    const c = baseCostContribution(h, legacyIfWronglyConverted);
    expect(c.value).toBe(31306.52);
    expect(c.value).not.toBe(legacyIfWronglyConverted);
  });
});

describe('no second FX conversion is applied to base_realised_value', () => {
  it('the returned value is exactly base_realised_value, never re-multiplied by a spot rate', () => {
    const h = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'USD', base_currency: 'GBP', base_realised_reliable: true, base_realised_value: 121.15 });
    const legacyIfWronglyConverted = 121.15 * 1.35345; // what a second FX pass would wrongly produce
    const c = baseRealisedContribution(h, legacyIfWronglyConverted);
    expect(c.value).toBe(121.15);
    expect(c.value).not.toBeCloseTo(legacyIfWronglyConverted, 2);
  });
});

describe('GBP, USD, and mixed-currency portfolio cases', () => {
  it('a GBP-base portfolio holding a GBP asset needs no FX at all — base cost equals native cost', () => {
    const h = makeHolding({ asset_id: 'a1', ticker: 'FOO', currency: 'GBP', base_currency: 'GBP', base_cost_reliable: true, base_total_cost: 1005 });
    expect(baseCostContribution(h, 1005).value).toBe(1005);
  });

  it('a USD-base portfolio holding a EUR asset: base cost is already in USD, no further conversion', () => {
    const h = makeHolding({ asset_id: 'a1', ticker: 'SAP.DE', currency: 'EUR', base_currency: 'USD', base_cost_reliable: true, base_total_cost: 1080 });
    expect(baseCostContribution(h, -1).value).toBe(1080);
  });

  it('a mixed-currency batch (GBP, USD, EUR assets, one GBP base) aggregates each holding\'s own base figure correctly', () => {
    const holdings = [
      makeHolding({ asset_id: 'a1', ticker: 'GBP-ASSET', currency: 'GBP', base_currency: 'GBP', base_cost_reliable: true, base_total_cost: 100 }),
      makeHolding({ asset_id: 'a2', ticker: 'USD-ASSET', currency: 'USD', base_currency: 'GBP', base_cost_reliable: true, base_total_cost: 200 }),
      makeHolding({ asset_id: 'a3', ticker: 'EUR-ASSET', currency: 'EUR', base_currency: 'GBP', base_cost_reliable: true, base_total_cost: 300 }),
    ];
    const result = aggregate(holdings.map((h) => baseCostContribution(h, 0)));
    expect(result.total).toBeCloseTo(600, 6);
    expect(result.incomplete).toBe(false);
  });
});
