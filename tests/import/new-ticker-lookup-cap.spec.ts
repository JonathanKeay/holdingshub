// Tests for the CSV import new-ticker lookup cap split (src/lib/newTickerLookupCap.ts).
// See the preview-stage use in src/app/api/import-transactions/route.ts: the
// symbols in `omitted` are surfaced to the user (as plain strings, no Yahoo
// lookup performed for them) so a 21st+ new ticker is never a silent surprise.

import { describe, it, expect } from 'vitest';
import { splitTickersForLookup } from '../../src/lib/newTickerLookupCap';

describe('splitTickersForLookup', () => {
  it('omits nothing when there are fewer candidates than the cap', () => {
    const result = splitTickersForLookup(['AAA', 'BBB'], 20);
    expect(result).toEqual({ toLookup: ['AAA', 'BBB'], omitted: [] });
  });

  it('omits nothing when candidates exactly fill the cap', () => {
    const candidates = Array.from({ length: 20 }, (_, i) => `T${i}`);
    const result = splitTickersForLookup(candidates, 20);
    expect(result.toLookup).toEqual(candidates);
    expect(result.omitted).toEqual([]);
  });

  it('splits correctly when candidates exceed the cap, preserving order', () => {
    const candidates = Array.from({ length: 23 }, (_, i) => `T${i}`);
    const result = splitTickersForLookup(candidates, 20);
    expect(result.toLookup).toEqual(candidates.slice(0, 20));
    expect(result.omitted).toEqual(['T20', 'T21', 'T22']);
    expect(result.toLookup).toHaveLength(20);
    expect(result.omitted).toHaveLength(3);
  });

  it('returns two empty arrays for empty input', () => {
    expect(splitTickersForLookup([], 20)).toEqual({ toLookup: [], omitted: [] });
  });

  it('omits everything when the cap is zero', () => {
    const result = splitTickersForLookup(['AAA', 'BBB'], 0);
    expect(result).toEqual({ toLookup: [], omitted: ['AAA', 'BBB'] });
  });
});
