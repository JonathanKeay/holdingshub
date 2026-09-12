// Tests for MarketStatusBadges.tsx's computeSession() next-open calculations.
//
// Both "closed over a weekend" and "closed after extended hours" branches
// used to jump a fixed number of days to skip a weekend only, never checking
// whether the day landed on was itself a market holiday — so the countdown
// was wrong every time a weekend (or the extended-hours close) preceded a
// holiday. Fixed by routing both through the shared nextTradingDay() helper
// (src/lib/marketHolidays.ts), which MarketStatusDots.tsx already used
// correctly. computeSession is a plain function with no React/DOM
// dependency, so it's tested directly here.

import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { computeSession, type MarketDef } from '../../src/components/MarketStatusBadges';

const US: MarketDef = { code: 'US', label: 'US (NYSE/Nasdaq)', tz: 'America/New_York', open: { h: 9, m: 30 }, close: { h: 16, m: 0 } };
const UK: MarketDef = { code: 'UK', label: 'LSE', tz: 'Europe/London', open: { h: 8, m: 0 }, close: { h: 16, m: 30 } };

describe('computeSession — weekend before a Monday NYSE holiday', () => {
  it('Saturday before Presidents\' Day (Mon 2026-02-16) resolves next-open to Tuesday, not Monday', () => {
    const now = DateTime.fromISO('2026-02-14T10:00', { zone: US.tz }); // Saturday
    const session = computeSession(US, now);
    expect(session.phase).toBe('closed');
    expect(session.nextEvent?.atISO.slice(0, 10)).toBe('2026-02-17');
  });
});

describe('computeSession — LSE Christmas/Boxing-Day corridor', () => {
  it('after extended close on Christmas Eve-eve (Thu 2026-12-24), resolves next-open past the whole corridor to Tuesday 29th', () => {
    // 2026: Christmas Day = Fri 25th (holiday), Sat 26th/Sun 27th weekend,
    // Boxing Day substitute = Mon 28th (holiday) — first trading day is Tue 29th.
    const now = DateTime.fromISO('2026-12-24T20:00', { zone: UK.tz }); // Thursday, after the 17:30 post window
    const session = computeSession(UK, now);
    expect(session.phase).toBe('closed');
    expect(session.nextEvent?.atISO.slice(0, 10)).toBe('2026-12-29');
  });
});

describe('computeSession — ordinary weekday', () => {
  it('after extended close on an ordinary Tuesday, resolves next-open to the very next day unchanged', () => {
    const now = DateTime.fromISO('2026-03-10T21:00', { zone: US.tz }); // Tuesday, after the 20:00 post window
    const session = computeSession(US, now);
    expect(session.phase).toBe('closed');
    expect(session.nextEvent?.atISO.slice(0, 10)).toBe('2026-03-11');
  });
});
