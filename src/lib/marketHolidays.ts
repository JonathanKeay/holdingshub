// Static holiday calendar (trading holidays) - extend as needed.
// Dates in YYYY-MM-DD (local market date) for quick exclusion.
// NOTE: This is a minimal illustrative subset; keep updated annually.
export const MARKET_HOLIDAYS: Record<'UK' | 'US', string[]> = {
  UK: [
    '2025-01-01', // New Year's Day
    '2025-04-18', // Good Friday
    '2025-04-21', // Easter Monday
    '2025-05-05', // Early May Bank Holiday
    '2025-05-26', // Spring Bank Holiday
    '2025-08-25', // Summer Bank Holiday
    '2025-12-25', // Christmas Day
    '2025-12-26', // Boxing Day
  ],
  US: [
    '2025-01-01', // New Year's Day
    '2025-01-20', // MLK Jr Day
    '2025-02-17', // Presidents' Day
    '2025-04-18', // Good Friday (NASDAQ/NYSE closed)
    '2025-05-26', // Memorial Day
    '2025-06-19', // Juneteenth
    '2025-07-04', // Independence Day
    '2025-09-01', // Labor Day
    '2025-11-27', // Thanksgiving
    '2025-12-25', // Christmas Day
  ],
};

export function isMarketHoliday(market: 'UK' | 'US', isoDateLocal: string) {
  return MARKET_HOLIDAYS[market].includes(isoDateLocal);
}
