import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase-server';

type SeriesPoint = { date: string; value_gbp: number };
type ChangesMap = Record<string, number>; // ticker -> change in GBP over range

function toISODate(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10);
}

function addDays(d: Date, days: number) {
  const nd = new Date(d);
  nd.setUTCDate(nd.getUTCDate() + days);
  return nd;
}

function daterange(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  for (let d = start; d <= end; d = addDays(d, 1)) {
    out.push(toISODate(d));
  }
  return out;
}

function parseFxQuotesToGBP(quotes: Record<string, number> | null | undefined): Record<string, number> {
  const rates: Record<string, number> = { GBP: 1 };
  if (!quotes) return rates;
  for (const [k, v] of Object.entries(quotes)) {
    const m = k.match(/^GBP([A-Z]{3})$/);
    if (m && typeof v === 'number' && v > 0) {
      rates[m[1]] = 1 / v; // quote is GBPXXX, convert to XXX->GBP
    }
  }
  return rates;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const range = (searchParams.get('range') || '1M').toUpperCase();
  // Optional timezone for defining "today" and intraday clipping
  const tz = searchParams.get('tz') || 'Europe/London';

  const supabase = await getSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // 1) Load current global holdings and cash (MVP uses current positions across the series)
  const { getAllHoldingsAndCashSummary } = await import('@/lib/queries');
  const summary = await getAllHoldingsAndCashSummary(supabase);
  const settingsRes = await supabase
    .from('settings')
    .select('show_zero_holdings, visible_statuses')
    .eq('id', 'global')
    .maybeSingle<{ show_zero_holdings: boolean | null; visible_statuses: string[] | null }>();
  const showZeroHoldings = !!settingsRes.data?.show_zero_holdings;
  const visibleStatusesSet = new Set((settingsRes.data?.visible_statuses ?? ['active']).map(s => String(s).toLowerCase().trim()));
  type HoldingRow = { status?: string | null; total_shares: number; ticker: string };
  const keepHolding = (h: HoldingRow) => {
    const status = (h.status ? String(h.status) : 'unknown').toLowerCase();
    const hasUnits = (h.total_shares ?? 0) !== 0;
    if (!showZeroHoldings && !hasUnits) return false;
    return visibleStatusesSet.has(status);
  };
  const holdings = (summary.holdings || []).filter(keepHolding);

  const tickers = holdings.map(h => h.ticker).filter(Boolean);

  // 2) Determine date range
  // Compute today's date in requested timezone
  function dateInTzISO(d: Date, timeZone: string) {
    // Use locale date formatting to derive YYYY-MM-DD reliably
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(d);
    // en-CA yields YYYY-MM-DD already
    return parts;
  }
  const today = dateInTzISO(new Date(), tz);
  let from = today;
  if (range === '1D') {
    from = toISODate(addDays(new Date(today + 'T00:00:00Z'), -1));
  } else if (range === '1W') {
    from = toISODate(addDays(new Date(today + 'T00:00:00Z'), -7));
  } else if (range === '1M') {
    from = toISODate(addDays(new Date(today + 'T00:00:00Z'), -30));
  } else if (range === 'YTD') {
    const now = new Date(today + 'T00:00:00Z');
    from = toISODate(new Date(Date.UTC(now.getUTCFullYear(), 0, 1)));
  } else if (range === '1Y') {
    from = toISODate(addDays(new Date(today + 'T00:00:00Z'), -365));
  } else if (range === 'ALL') {
    // earliest transaction date
    const { data: firstTxn } = await supabase
      .from('transactions')
      .select('date')
      .not('date', 'is', null)
      .order('date', { ascending: true })
      .limit(1)
      .maybeSingle();
    from = firstTxn?.date?.slice(0, 10) || toISODate(addDays(new Date(today + 'T00:00:00Z'), -365));
  }

  // Special case: 1D intraday series using Yahoo 5m chart
  if (range === '1D') {
    type IntradayPoint = { ts: number; price: number };
    // Resolve tickers and multipliers
    const { data: assets } = await supabase
      .from('assets')
      .select('ticker,resolved_ticker,price_multiplier')
      .in('ticker', tickers.length ? tickers : ['__none__']);
    const resMap: Record<string, { resolved: string; mult: number }> = {};
    for (const a of assets || []) {
      resMap[a.ticker] = { resolved: a.resolved_ticker || a.ticker, mult: Number(a.price_multiplier || 1) || 1 };
    }
    for (const t of tickers) if (!resMap[t]) resMap[t] = { resolved: t, mult: 1 };

    async function fetchYahoo5m(symbol: string): Promise<{ ts: number[]; close: (number | null)[] } | null> {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`;
        const r = await fetch(url);
        if (!r.ok) return null;
        const j = await r.json();
        const res = j?.chart?.result?.[0];
        const ts = (res?.timestamp as number[] | undefined) || [];
        const close = (res?.indicators?.quote?.[0]?.close as (number | null)[] | undefined) || [];
        if (!ts.length || !close.length) return null;
        return { ts, close };
      } catch {
        return null;
      }
    }

    // Fetch FX (today)
  const { data: fxRow } = await supabase.from('fx_rates').select('date,quotes').eq('date', today).maybeSingle<{ date: string; quotes: Record<string, number> | null }>();
  const fxToday = parseFxQuotesToGBP(fxRow?.quotes ?? undefined);

    // Determine current-day holdings and cash (as-of today)
    const { getAllHoldingsAndCashSummary: getSummary } = await import('@/lib/queries');
  const todaySummary = await getSummary(supabase, { asOf: today });
  const dayHoldings = (todaySummary.holdings || []).filter(h => tickers.includes(h.ticker)).filter(keepHolding);
    const dayCash = (todaySummary.cash_balances || []) as { currency: string; balance: number }[];

  // Fetch intraday series in small batches
  const BATCH = 12; // slightly larger batch for faster load
    const seriesByTicker: Record<string, IntradayPoint[]> = {};
    for (let i = 0; i < tickers.length; i += BATCH) {
      const batch = tickers.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(t => fetchYahoo5m(resMap[t].resolved)));
      for (let j = 0; j < batch.length; j++) {
        const t = batch[j];
        const r = results[j];
        if (!r) continue;
        const mult = resMap[t].mult || 1;
        const arr: IntradayPoint[] = [];
        for (let k = 0; k < r.ts.length; k++) {
          const v = r.close[k];
          if (v && v > 0) arr.push({ ts: r.ts[k], price: v * mult });
        }
        if (arr.length) seriesByTicker[t] = arr;
      }
  // Keep a tiny throttle to avoid hammering the provider; reduce from 500ms to 100ms
  if (i + BATCH < tickers.length) await new Promise(r => setTimeout(r, 100));
    }

    // Seed from recent daily closes in price_history (prefer the most recent non-zero close within last 5 days)
    const fiveDaysAgo = toISODate(addDays(new Date(today + 'T00:00:00Z'), -5));
    const { data: recentHist } = await supabase
      .from('price_history')
      .select('ticker,date,price,price_multiplier')
      .in('ticker', tickers.length ? tickers : ['__none__'])
      .gte('date', fiveDaysAgo)
      .lte('date', today)
      .order('date', { ascending: true });
    const seedPrice: Record<string, number> = {};
    for (const r of (recentHist || []) as { ticker: string; date: string; price: number | null; price_multiplier: number | null }[]) {
      const mult = Number(r.price_multiplier || 1) || 1;
      const close = Number(r.price || 0) * mult;
      if (close > 0) seedPrice[r.ticker] = close; // later rows overwrite earlier → most recent wins
    }

    // Build union timeline of timestamps
    const tsSet = new Set<number>();
    for (const list of Object.values(seriesByTicker)) for (const p of list) tsSet.add(p.ts);
    let timeline = Array.from(tsSet).sort((a, b) => a - b);
    // Helpers for tz-aware day and minute-of-day
    const isSameDayInTz = (ts: number) => dateInTzISO(new Date(ts * 1000), tz) === today;
    function minutesSinceMidnightInTz(ts: number, tzLocal: string): number {
      const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tzLocal }).formatToParts(new Date(ts * 1000));
      let h = 0, m = 0; for (const p of parts) { if (p.type === 'hour') h = parseInt(p.value, 10); else if (p.type === 'minute') m = parseInt(p.value, 10); }
      return h * 60 + m;
    }
    const WINDOW_START_MIN = 8 * 60;  // 08:00 UK
    const WINDOW_END_MIN = 22 * 60;   // 22:00 UK
    const inWindow = (ts: number) => {
      if (!isSameDayInTz(ts)) return false;
      const mm = minutesSinceMidnightInTz(ts, tz);
      return mm >= WINDOW_START_MIN && mm <= WINDOW_END_MIN;
    };
    // Keep only points within today's 08:00–22:00 window
    timeline = timeline.filter(inWindow);

    const STEP = 300; // 5 minutes
    const nowSec = Math.floor(Date.now() / 1000);

    // If empty, seed with 'now' if within window so we can back/forward fill grid
    const nowInWindow = inWindow(nowSec);
    if (timeline.length === 0 && nowInWindow) timeline = [nowSec];

    // Extend backward to 08:00 and forward to 'now' within the same tz day
    if (timeline.length > 0) {
      // Backward to window start
      let first = timeline[0];
      while (true) {
        const prev = first - STEP;
        if (!isSameDayInTz(prev)) break;
        const mm = minutesSinceMidnightInTz(prev, tz);
        if (mm < WINDOW_START_MIN) break;
        timeline.unshift(prev);
        first = prev;
      }
      // Forward to 'now' (but don't push beyond end-of-window; leave empty space for rest)
      let last = timeline[timeline.length - 1];
      while (true) {
        const next = last + STEP;
        if (next > nowSec) break;
        if (!isSameDayInTz(next)) break;
        const mm = minutesSinceMidnightInTz(next, tz);
        if (mm > WINDOW_END_MIN) break;
        timeline.push(next);
        last = next;
      }
    }
  if (timeline.length === 0) return NextResponse.json({ range, from: today, to: today, points: [] });

  // Forward-fill prices per ticker and aggregate to GBP
    const lastPrice: Record<string, number> = { ...seedPrice };
    const points: { date: string; value_gbp: number }[] = [];
    // Precompute constant cash GBP value (today's FX)
    const cashGBP = dayCash.reduce((s, c) => s + (c.balance || 0) * (fxToday[(c.currency || 'GBP').toUpperCase()] ?? 1), 0);
    const holdingsByTicker: Record<string, { shares: number; ccy: string }> = {};
    for (const h of dayHoldings) holdingsByTicker[h.ticker] = { shares: h.total_shares, ccy: (h.currency || 'GBP').toUpperCase() };

    // For fast lookup, map per-ticker by timestamp
    const byTs: Record<string, Map<number, number>> = {};
    for (const [t, list] of Object.entries(seriesByTicker)) {
      const m = new Map<number, number>();
      for (const p of list) m.set(p.ts, p.price);
      byTs[t] = m;
    }

    for (const ts of timeline) {
      let totalGBP = cashGBP;
      for (const t of tickers) {
        const m = byTs[t];
        const p = m?.get(ts);
        if (p && p > 0) lastPrice[t] = p;
        const lp = lastPrice[t];
        if (!lp) continue;
        const h = holdingsByTicker[t];
        if (!h || !h.shares) continue;
        const rate = fxToday[h.ccy] ?? 1;
        totalGBP += h.shares * lp * rate;
      }
      points.push({ date: new Date(ts * 1000).toISOString(), value_gbp: Math.round(totalGBP) });
    }

    // Compute per-ticker 1D change in GBP using previous_close from prices
    // and the latest known intraday price (or seed close) for 'current'.
    const { data: currentPriceRows } = await supabase
      .from('prices')
      .select('ticker,previous_close,price_multiplier')
      .in('ticker', tickers.length ? tickers : ['__none__']);
    const prevCloseMap: Record<string, { prev: number; mult: number }> = {};
    for (const r of (currentPriceRows || []) as { ticker: string; previous_close: number | null; price_multiplier: number | null }[]) {
      const mult = Number(r.price_multiplier || 1) || 1;
      const prev = Number(r.previous_close || 0) * mult;
      if (prev > 0) prevCloseMap[r.ticker] = { prev, mult };
    }
    const changes: ChangesMap = {};
    for (const t of tickers) {
      const h = holdingsByTicker[t];
      if (!h || !h.shares) continue;
      const rate = fxToday[h.ccy] ?? 1;
      const cur = lastPrice[t] || 0;
      const prev = prevCloseMap[t]?.prev || 0;
      if (cur > 0 && prev > 0) changes[t] = (cur - prev) * h.shares * rate;
      else changes[t] = 0;
    }

    return NextResponse.json({ range, from: today, to: today, points, tz, changes });
  }

  // 3) Load price history (daily) for tickers and FX rates over the range
  type PriceHistRow = { ticker: string; date: string; price: number | null; price_multiplier: number | null };
  type FxRow = { date: string; quotes: Record<string, number> | null };
  type CurrentPriceRow = { ticker: string; price: number | null; price_multiplier: number | null; previous_close: number | null };

  const [{ data: ph }, { data: fxRows }, { data: currentPrices }] = await Promise.all([
    supabase
      .from('price_history')
      .select('ticker,date,price,price_multiplier')
      .in('ticker', tickers.length ? tickers : ['__none__'])
      .gte('date', from)
      .lte('date', today)
      .order('date', { ascending: true }),
    supabase
      .from('fx_rates')
      .select('date,quotes')
      .gte('date', from)
      .lte('date', today)
      .order('date', { ascending: true }),
    supabase
      .from('prices')
      .select('ticker,price,price_multiplier,previous_close')
      .in('ticker', tickers.length ? tickers : ['__none__'])
  ]);

  // Maps
  const historyByTicker: Record<string, { date: string; price: number; mult: number }[]> = {};
  for (const row of (ph as PriceHistRow[] | null) || []) {
    const t = row.ticker;
    const date = row.date;
    const price = Number(row.price || 0);
    const mult = Number(row.price_multiplier || 1) || 1;
    (historyByTicker[t] ||= []).push({ date, price, mult });
  }
  // Append today from currentPrices if not already present
  const todayStr = today;
  const cpMap: Record<string, { price: number; mult: number; prev: number }> = {};
  for (const r of (currentPrices as CurrentPriceRow[] | null) || []) {
    const t = r.ticker;
    const price = Number(r.price || 0);
    const mult = Number(r.price_multiplier || 1) || 1;
    const prev = Number(r.previous_close || 0) || 0;
    cpMap[t] = { price, mult, prev };
  }
  for (const t of tickers) {
    const list = (historyByTicker[t] ||= []);
    if (!list.find(e => e.date === todayStr)) {
      const cp = cpMap[t];
      if (cp && cp.price > 0) list.push({ date: todayStr, price: cp.price, mult: cp.mult });
    }
  }

  const fxByDate: Record<string, Record<string, number>> = {};
  for (const r of (fxRows as FxRow[] | null) || []) {
    fxByDate[r.date] = parseFxQuotesToGBP(r.quotes || undefined);
  }
  // forward-fill FX across dates
  const allDates = daterange(from, today);
  let lastFx: Record<string, number> = { GBP: 1 };
  for (const d of allDates) {
    if (fxByDate[d]) lastFx = fxByDate[d];
    else fxByDate[d] = lastFx;
  }

  // 4) Build series (FULL FIDELITY: recompute positions and cash as-of each day)
  const series: SeriesPoint[] = [];
  // Prepare per-ticker daily price map with forward-fill
  const priceAtDate: Record<string, Record<string, number>> = {};
  for (const t of tickers) {
    const entries = (historyByTicker[t] || []).sort((a, b) => (a.date < b.date ? -1 : 1));
    const map: Record<string, number> = {};
    let last = 0;
    for (const d of allDates) {
      const found = entries.find(e => e.date === d);
      if (found && found.price > 0) last = found.price * (found.mult || 1);
      map[d] = last;
    }
    priceAtDate[t] = map;
  }

  const { getAllHoldingsAndCashSummary: getSummary } = await import('@/lib/queries');
  for (const d of allDates) {
    let totalGBP = 0;
    const fx = fxByDate[d] || { GBP: 1 };
  // Compute positions and cash as of date d
  const daySummary = await getSummary(supabase, { asOf: d });
  const dayHoldings = (daySummary.holdings || []).filter(keepHolding);
    const dayCash = (daySummary.cash_balances || []) as { currency: string; balance: number }[];
    for (const h of dayHoldings) {
      const p = priceAtDate[h.ticker]?.[d] || 0;
      if (!p) continue;
      const ccy = (h.currency || 'GBP').toUpperCase();
      const rate = fx[ccy] ?? 1;
      totalGBP += (h.total_shares || 0) * p * rate;
    }
    for (const cb of dayCash) {
      const ccy = (cb.currency || 'GBP').toUpperCase();
      const rate = fx[ccy] ?? 1;
      totalGBP += (cb.balance || 0) * rate;
    }
    series.push({ date: d, value_gbp: Math.round(totalGBP) });
  }

  // 5) Per-ticker changes for sorting: use shares as-of today
  const todayHoldingsSummary = await getSummary(supabase, { asOf: today });
  const todayHoldings = (todayHoldingsSummary.holdings || []).filter(keepHolding);
  const changes: ChangesMap = {};
  for (const h of todayHoldings) {
    const t = h.ticker;
    const shares = h.total_shares || 0;
    if (!shares) continue;
    const ccy = (h.currency || 'GBP').toUpperCase();
    const pToday = priceAtDate[t]?.[today] || 0;
    const pFrom = priceAtDate[t]?.[from] || 0;
    const rateToday = (fxByDate[today] || { GBP: 1 })[ccy] ?? 1;
    const rateFrom = (fxByDate[from] || { GBP: 1 })[ccy] ?? 1;
    if (pToday > 0 && pFrom > 0) changes[t] = shares * (pToday * rateToday - pFrom * rateFrom);
    else changes[t] = 0;
  }

  return NextResponse.json({ range, from, to: today, points: series, tz, changes });
}
