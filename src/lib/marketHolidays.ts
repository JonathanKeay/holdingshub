// Rule-based market holiday calendar for LSE (UK) and NYSE (US).
//
// No hardcoded annual date arrays: every recurring holiday is computed
// algorithmically for any year (Easter via the Anonymous Gregorian /
// Meeus-Jones-Butcher algorithm, "nth/last weekday of month" for the rest),
// with weekend-observed/substitute-day rules applied per market. A small,
// explicit MARKET_OVERRIDES list exists for exceptional one-off closures a
// rule can never predict (e.g. an ad hoc closure, or a historically
// relocated bank holiday) — it ships empty; add an entry only when a real
// one is confirmed.
//
// isMarketHoliday(market, isoDateLocal) keeps its original signature and
// behaviour contract exactly, so nothing that already calls it needs to
// change. getMarketHolidaysForYear(market, year) is new, purely additive.
//
// Deliberately out of scope: early-close (half day) sessions.

import { DateTime } from 'luxon';

export type Market = 'UK' | 'US';

export type MarketOverride = {
  date: string; // YYYY-MM-DD, the actual calendar date affected
  market: Market;
  action: 'closed' | 'open'; // 'closed': add an exceptional extra closure.
  // 'open': cancel a rule-generated holiday that didn't actually happen that
  // way that year (e.g. a relocated bank holiday) — pair with a 'closed'
  // entry on the date it moved to.
  reason: string;
};

// Empty by default — do not backfill historical examples just to demonstrate
// the mechanism. Add an entry only for a confirmed, exceptional, one-off event.
export const MARKET_OVERRIDES: MarketOverride[] = [];

function utcDate(year: number, month: number, day: number): DateTime {
  return DateTime.fromObject({ year, month, day }, { zone: 'utc' });
}

function isoDate(d: DateTime): string {
  return d.toISODate()!;
}

// ---------------------------- Easter Sunday -----------------------------
// Anonymous Gregorian algorithm (aka Meeus/Jones/Butcher). Pure integer
// arithmetic, valid for the Gregorian calendar.
function easterSunday(year: number): DateTime {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(year, month, day);
}

// ------------------------ nth/last weekday of month ------------------------
// isoWeekday: 1 = Monday .. 7 = Sunday (Luxon's convention).
function nthWeekdayOfMonth(year: number, month: number, isoWeekday: number, n: number): DateTime {
  const first = utcDate(year, month, 1);
  const offsetToFirstMatch = (isoWeekday - first.weekday + 7) % 7;
  return first.plus({ days: offsetToFirstMatch + (n - 1) * 7 });
}

function lastWeekdayOfMonth(year: number, month: number, isoWeekday: number): DateTime {
  const last = utcDate(year, month, 1).endOf('month').startOf('day');
  const offsetBack = (last.weekday - isoWeekday + 7) % 7;
  return last.minus({ days: offsetBack });
}

// ------------------------- standard weekend shift -------------------------
// Saturday -> preceding Friday, Sunday -> following Monday. Used by NYSE's
// fixed-date holidays (other than New Year's Day, which is a documented
// exception — see below).
function observedStandard(d: DateTime): DateTime {
  if (d.weekday === 6) return d.minus({ days: 1 }); // Saturday
  if (d.weekday === 7) return d.plus({ days: 1 }); // Sunday
  return d;
}

// --------------------------------- NYSE ---------------------------------
function nyseHolidaysForYear(year: number): string[] {
  const dates: string[] = [];

  // New Year's Day: NYSE-specific exception. Sunday -> observed Monday, same
  // as every other fixed-date holiday. Saturday -> NOT observed at all that
  // year (no substitute Friday closure) — documented NYSE practice, distinct
  // from Independence Day/Juneteenth/Christmas below.
  const jan1 = utcDate(year, 1, 1);
  if (jan1.weekday === 7) dates.push(isoDate(jan1.plus({ days: 1 })));
  else if (jan1.weekday !== 6) dates.push(isoDate(jan1));

  dates.push(isoDate(nthWeekdayOfMonth(year, 1, 1, 3))); // MLK Jr Day: 3rd Monday Jan
  dates.push(isoDate(nthWeekdayOfMonth(year, 2, 1, 3))); // Washington's Birthday: 3rd Monday Feb
  dates.push(isoDate(easterSunday(year).minus({ days: 2 }))); // Good Friday
  dates.push(isoDate(lastWeekdayOfMonth(year, 5, 1))); // Memorial Day: last Monday May
  dates.push(isoDate(observedStandard(utcDate(year, 6, 19)))); // Juneteenth
  dates.push(isoDate(observedStandard(utcDate(year, 7, 4)))); // Independence Day
  dates.push(isoDate(nthWeekdayOfMonth(year, 9, 1, 1))); // Labor Day: 1st Monday Sept
  dates.push(isoDate(nthWeekdayOfMonth(year, 11, 4, 4))); // Thanksgiving: 4th Thursday Nov
  dates.push(isoDate(observedStandard(utcDate(year, 12, 25)))); // Christmas Day

  return dates;
}

// ---------------------------------- LSE ----------------------------------
function lseHolidaysForYear(year: number): string[] {
  const dates: string[] = [];

  // New Year's Day: Saturday -> substitute Monday (Sunday is also a weekend
  // day, so skip it too). Sunday -> substitute Monday. Weekday -> as-is.
  const jan1 = utcDate(year, 1, 1);
  if (jan1.weekday === 6) dates.push(isoDate(jan1.plus({ days: 2 })));
  else if (jan1.weekday === 7) dates.push(isoDate(jan1.plus({ days: 1 })));
  else dates.push(isoDate(jan1));

  const easter = easterSunday(year);
  dates.push(isoDate(easter.minus({ days: 2 }))); // Good Friday
  dates.push(isoDate(easter.plus({ days: 1 }))); // Easter Monday

  dates.push(isoDate(nthWeekdayOfMonth(year, 5, 1, 1))); // Early May Bank Holiday: 1st Monday May
  dates.push(isoDate(lastWeekdayOfMonth(year, 5, 1))); // Spring Bank Holiday: last Monday May
  dates.push(isoDate(lastWeekdayOfMonth(year, 8, 1))); // Summer Bank Holiday: last Monday Aug

  // Christmas Day / Boxing Day: a linked pair, not two independent rules.
  const christmas = utcDate(year, 12, 25);
  const boxing = utcDate(year, 12, 26);
  switch (christmas.weekday) {
    case 5: // Friday: Christmas stays put; Boxing Day (Saturday) -> Monday
      dates.push(isoDate(christmas));
      dates.push(isoDate(boxing.plus({ days: 2 })));
      break;
    case 6: // Saturday: Christmas -> Monday; Boxing Day (Sunday) -> Tuesday
      dates.push(isoDate(christmas.plus({ days: 2 })));
      dates.push(isoDate(boxing.plus({ days: 2 })));
      break;
    case 7: // Sunday: Christmas -> Tuesday; Boxing Day (Monday) stays put
      dates.push(isoDate(christmas.plus({ days: 2 })));
      dates.push(isoDate(boxing));
      break;
    default: // Monday-Thursday: both fall on their actual dates
      dates.push(isoDate(christmas));
      dates.push(isoDate(boxing));
  }

  return dates;
}

function rawHolidaysForYear(market: Market, year: number): string[] {
  return market === 'US' ? nyseHolidaysForYear(year) : lseHolidaysForYear(year);
}

// ------------------------------- overrides -------------------------------
export function applyOverrides(dates: string[], market: Market, overrides: MarketOverride[]): string[] {
  const set = new Set(dates);
  for (const o of overrides) {
    if (o.market !== market) continue;
    if (o.action === 'closed') set.add(o.date);
    else if (o.action === 'open') set.delete(o.date);
  }
  return Array.from(set).sort();
}

// --------------------------------- public API ---------------------------------
export function getMarketHolidaysForYear(market: Market, year: number): string[] {
  return applyOverrides(rawHolidaysForYear(market, year), market, MARKET_OVERRIDES);
}

export function isMarketHoliday(market: Market, isoDateLocal: string): boolean {
  const year = Number((isoDateLocal || '').slice(0, 4));
  if (!Number.isFinite(year)) return false;
  return getMarketHolidaysForYear(market, year).includes(isoDateLocal);
}
