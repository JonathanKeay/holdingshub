// Simple market hours helpers (no holiday calendar).
// UK (LSE): 08:00–16:30 Europe/London
// US (NYSE/Nasdaq): 09:30–16:00 America/New_York
// Returns local open/close evaluation using Intl time zone conversion.

type Market = 'UK' | 'US';

function getHM(now: Date, timeZone: string): { h: number; m: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
    weekday: 'short'
  }).formatToParts(now);
  let h = 0, m = 0, wd = 0;
  for (const p of parts) {
    if (p.type === 'hour') h = parseInt(p.value, 10);
    else if (p.type === 'minute') m = parseInt(p.value, 10);
    else if (p.type === 'weekday') {
      // Map Mon..Sun -> 1..7 style (Date.getDay() is 0=Sun)
      // We'll just reuse JS convention by re-parsing once we have UTC day:
      wd = now.getUTCDay(); // acceptable for weekday gating
    }
  }
  return { h, m, dow: wd };
}

function inWindow(h: number, m: number, openH: number, openM: number, closeH: number, closeM: number) {
  const cur = h * 60 + m;
  const open = openH * 60 + openM;
  const close = closeH * 60 + closeM;
  return cur >= open && cur < close;
}

export function isUKMarketOpen(now = new Date()): boolean {
  const { h, m, dow } = getHM(now, 'Europe/London');
  if (dow === 0 || dow === 6) return false; // Sun / Sat
  return inWindow(h, m, 8, 0, 16, 30);
}

export function isUSMarketOpen(now = new Date()): boolean {
  const { h, m, dow } = getHM(now, 'America/New_York');
  if (dow === 0 || dow === 6) return false;
  return inWindow(h, m, 9, 30, 16, 0);
}

// Heuristic: tickers ending with .L => UK. Default => US.
export function marketForTicker(ticker: string): Market {
  return /\.L$/i.test(ticker) ? 'UK' : 'US';
}

export function isMarketOpenForTicker(ticker: string, now = new Date()): boolean {
  const m = marketForTicker(ticker);
  return m === 'UK' ? isUKMarketOpen(now) : isUSMarketOpen(now);
}