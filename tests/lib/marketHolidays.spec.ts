// Tests for the rule-based LSE/NYSE market holiday calendar
// (src/lib/marketHolidays.ts). No hardcoded annual arrays exist in the
// implementation any more — every date here is independently verified by
// hand (day-of-week arithmetic) and cross-checked against NYSE's own
// published 2026/2027 holiday announcement where available.

import { describe, it, expect } from 'vitest';
import { isMarketHoliday, getMarketHolidaysForYear, applyOverrides, type MarketOverride } from '../../src/lib/marketHolidays';

describe('NYSE New Year\'s Day — the documented Saturday/Sunday exception', () => {
  it('Sunday: 2023-01-01 is a Sunday, observed the following Monday 2023-01-02', () => {
    expect(isMarketHoliday('US', '2023-01-01')).toBe(false); // the actual Sunday is not itself listed
    expect(isMarketHoliday('US', '2023-01-02')).toBe(true); // observed Monday
  });

  it('Saturday: 2028-01-01 is a Saturday and is NOT observed at all (no substitute Friday)', () => {
    expect(isMarketHoliday('US', '2028-01-01')).toBe(false);
    expect(isMarketHoliday('US', '2027-12-31')).toBe(false); // no substitute the preceding Friday
    expect(isMarketHoliday('US', '2028-01-03')).toBe(false); // no substitute the following Monday either
  });
});

describe('NYSE Independence Day — standard weekend observance', () => {
  it('Saturday: 2026-07-04 is a Saturday, observed the preceding Friday 2026-07-03', () => {
    expect(isMarketHoliday('US', '2026-07-04')).toBe(false);
    expect(isMarketHoliday('US', '2026-07-03')).toBe(true);
  });

  it('Sunday: 2027-07-04 is a Sunday, observed the following Monday 2027-07-05', () => {
    expect(isMarketHoliday('US', '2027-07-04')).toBe(false);
    expect(isMarketHoliday('US', '2027-07-05')).toBe(true);
  });
});

describe('LSE New Year\'s Day — weekend substitution', () => {
  it('Sunday: 2023-01-01 substitute is Monday 2023-01-02', () => {
    expect(isMarketHoliday('UK', '2023-01-01')).toBe(false);
    expect(isMarketHoliday('UK', '2023-01-02')).toBe(true);
  });

  it('Saturday: 2028-01-01 substitute is Monday 2028-01-03 (Sunday is skipped too)', () => {
    expect(isMarketHoliday('UK', '2028-01-01')).toBe(false);
    expect(isMarketHoliday('UK', '2028-01-02')).toBe(false); // the Sunday itself
    expect(isMarketHoliday('UK', '2028-01-03')).toBe(true); // Monday substitute
  });
});

describe('LSE Christmas Day / Boxing Day — all four linked arrangements', () => {
  it('Mon-Thu (no shift): 2023-12-25 is a Monday, both fall on their actual dates', () => {
    expect(isMarketHoliday('UK', '2023-12-25')).toBe(true); // Christmas, Monday
    expect(isMarketHoliday('UK', '2023-12-26')).toBe(true); // Boxing Day, Tuesday
  });

  it('Friday: 2026-12-25 is a Friday — Christmas stays put, Boxing Day (Sat) moves to Monday 28th', () => {
    expect(isMarketHoliday('UK', '2026-12-25')).toBe(true); // Christmas, actual Friday
    expect(isMarketHoliday('UK', '2026-12-26')).toBe(false); // the actual Saturday is not itself a holiday
    expect(isMarketHoliday('UK', '2026-12-28')).toBe(true); // Boxing Day substitute, Monday
  });

  it('Saturday: 2027-12-25 is a Saturday — Christmas moves to Monday 27th, Boxing Day (Sun) moves to Tuesday 28th', () => {
    expect(isMarketHoliday('UK', '2027-12-25')).toBe(false);
    expect(isMarketHoliday('UK', '2027-12-26')).toBe(false);
    expect(isMarketHoliday('UK', '2027-12-27')).toBe(true); // Christmas substitute, Monday
    expect(isMarketHoliday('UK', '2027-12-28')).toBe(true); // Boxing Day substitute, Tuesday
  });

  it('Sunday: 2022-12-25 is a Sunday — Christmas moves to Tuesday 27th, Boxing Day (Mon) stays put', () => {
    expect(isMarketHoliday('UK', '2022-12-25')).toBe(false);
    expect(isMarketHoliday('UK', '2022-12-26')).toBe(true); // Boxing Day, actual Monday
    expect(isMarketHoliday('UK', '2022-12-27')).toBe(true); // Christmas substitute, Tuesday
  });
});

describe('Good Friday and Easter Monday', () => {
  it('NYSE Good Friday 2026 is 2026-04-03 (Easter Sunday 2026-04-05)', () => {
    expect(isMarketHoliday('US', '2026-04-03')).toBe(true);
  });

  it('NYSE Good Friday 2027 is 2027-03-26 (Easter Sunday 2027-03-28)', () => {
    expect(isMarketHoliday('US', '2027-03-26')).toBe(true);
  });

  it('LSE Good Friday and Easter Monday 2026 are 2026-04-03 and 2026-04-06', () => {
    expect(isMarketHoliday('UK', '2026-04-03')).toBe(true);
    expect(isMarketHoliday('UK', '2026-04-06')).toBe(true);
  });

  it('LSE Good Friday and Easter Monday 2027 are 2027-03-26 and 2027-03-29', () => {
    expect(isMarketHoliday('UK', '2027-03-26')).toBe(true);
    expect(isMarketHoliday('UK', '2027-03-29')).toBe(true);
  });
});

describe('nth/last-Monday holidays, 2026 — cross-checked against NYSE\'s own published calendar', () => {
  it('NYSE: MLK Day (3rd Mon Jan) = 2026-01-19, Presidents Day (3rd Mon Feb) = 2026-02-16', () => {
    expect(isMarketHoliday('US', '2026-01-19')).toBe(true);
    expect(isMarketHoliday('US', '2026-02-16')).toBe(true);
  });

  it('NYSE: Memorial Day (last Mon May) = 2026-05-25, Labor Day (1st Mon Sept) = 2026-09-07', () => {
    expect(isMarketHoliday('US', '2026-05-25')).toBe(true);
    expect(isMarketHoliday('US', '2026-09-07')).toBe(true);
  });

  it('LSE: Early May BH (1st Mon May) = 2026-05-04, Spring BH (last Mon May) = 2026-05-25', () => {
    expect(isMarketHoliday('UK', '2026-05-04')).toBe(true);
    expect(isMarketHoliday('UK', '2026-05-25')).toBe(true);
  });

  it('LSE: Summer Bank Holiday (last Mon Aug) = 2026-08-31', () => {
    expect(isMarketHoliday('UK', '2026-08-31')).toBe(true);
  });
});

describe('ordinary trading weekdays', () => {
  it('an unremarkable Tuesday is not a holiday on either market', () => {
    expect(isMarketHoliday('US', '2026-03-10')).toBe(false);
    expect(isMarketHoliday('UK', '2026-03-10')).toBe(false);
  });
});

describe('complete 2026 generated counts', () => {
  it('NYSE 2026 has exactly 10 holidays', () => {
    const dates = getMarketHolidaysForYear('US', 2026);
    expect(dates).toHaveLength(10);
    expect(dates).toEqual(
      ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
       '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']
    );
  });

  it('LSE 2026 has exactly 8 holidays', () => {
    const dates = getMarketHolidaysForYear('UK', 2026);
    expect(dates).toHaveLength(8);
    expect(dates).toEqual(
      ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04',
       '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28']
    );
  });
});

describe('the override mechanism, exercised without touching the production MARKET_OVERRIDES array', () => {
  it('a "closed" override adds an exceptional date not produced by the rules', () => {
    const base = getMarketHolidaysForYear('US', 2026);
    expect(base.includes('2026-09-11')).toBe(false);
    const fakeOverrides: MarketOverride[] = [
      { date: '2026-09-11', market: 'US', action: 'closed', reason: 'test-only exceptional closure' },
    ];
    const withOverride = applyOverrides(base, 'US', fakeOverrides);
    expect(withOverride.includes('2026-09-11')).toBe(true);
  });

  it('an "open" override cancels a rule-generated holiday for that year', () => {
    const base = getMarketHolidaysForYear('UK', 2026);
    expect(base.includes('2026-05-04')).toBe(true); // Early May BH, generated by the rule
    const fakeOverrides: MarketOverride[] = [
      { date: '2026-05-04', market: 'UK', action: 'open', reason: 'test-only relocation' },
    ];
    const withOverride = applyOverrides(base, 'UK', fakeOverrides);
    expect(withOverride.includes('2026-05-04')).toBe(false);
  });

  it('an override for a different market is ignored', () => {
    const base = getMarketHolidaysForYear('US', 2026);
    const fakeOverrides: MarketOverride[] = [
      { date: '2026-09-11', market: 'UK', action: 'closed', reason: 'wrong market, should not apply' },
    ];
    const result = applyOverrides(base, 'US', fakeOverrides);
    expect(result.includes('2026-09-11')).toBe(false);
  });

  it('the production MARKET_OVERRIDES array is untouched by these tests (still empty)', async () => {
    const { MARKET_OVERRIDES } = await import('../../src/lib/marketHolidays');
    expect(MARKET_OVERRIDES).toEqual([]);
  });
});
