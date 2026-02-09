import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
import { getSupabaseServerClient } from '@/lib/supabase-server';

type ChangesMap = Record<string, number>; // ticker -> GBP change for selected range
type ChangesNativeMap = Record<string, number>; // ticker -> native currency change for selected range
type CurrencyByTicker = Record<string, string>; // ticker -> native currency code

function toISODate(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10);
}

function addDays(d: Date, days: number) {
  const nd = new Date(d);
  nd.setUTCDate(nd.getUTCDate() + days);
  return nd;
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
  const tz = searchParams.get('tz') || 'Europe/London';

  const supabase = await getSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Load settings and holdings (current)
  const { getAllHoldingsAndCashSummary } = await import('@/lib/queries');
  const summary = await getAllHoldingsAndCashSummary(supabase);
  const settingsRes = await supabase
    .from('settings')
    .select('show_zero_holdings, visible_statuses')
    .eq('id', 'global')
    .maybeSingle<{ show_zero_holdings: boolean | null; visible_statuses: string[] | null }>();
  const showZeroHoldings = !!settingsRes.data?.show_zero_holdings;
  const visibleStatusesSet = new Set((settingsRes.data?.visible_statuses ?? ['active']).map(s => String(s).toLowerCase().trim()));
  type HoldingRow = { status?: string | null; total_shares: number; ticker: string; currency?: string | null };
  const keepHolding = (h: HoldingRow) => {
    const status = (h.status ? String(h.status) : 'unknown').toLowerCase();
    const hasUnits = (h.total_shares ?? 0) !== 0;
    if (!showZeroHoldings && !hasUnits) return false;
    return visibleStatusesSet.has(status);
  };
  const holdings = (summary.holdings || []).filter(keepHolding) as HoldingRow[];
  const tickers = holdings.map(h => h.ticker).filter(Boolean);
  const currency_by_ticker: CurrencyByTicker = {};
  for (const h of holdings) {
    if (!h?.ticker) continue;
    currency_by_ticker[h.ticker] = (h.currency || 'GBP').toUpperCase();
  }

  // Compute today/from (date strings)
  function dateInTzISO(d: Date, timeZone: string) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(d);
    return parts; // en-CA yields YYYY-MM-DD
  }
  const today = dateInTzISO(new Date(), tz);
  let from = today;
  if (range === '1D') from = toISODate(addDays(new Date(today + 'T00:00:00Z'), -1));
  else if (range === '1W') from = toISODate(addDays(new Date(today + 'T00:00:00Z'), -7));
  else if (range === '1M') from = toISODate(addDays(new Date(today + 'T00:00:00Z'), -30));
  else if (range === 'YTD') {
    const now = new Date(today + 'T00:00:00Z');
    from = toISODate(new Date(Date.UTC(now.getUTCFullYear(), 0, 1)));
  } else if (range === '1Y') from = toISODate(addDays(new Date(today + 'T00:00:00Z'), -365));
  else if (range === 'ALL') {
    const { data: firstTxn } = await supabase
      .from('transactions')
      .select('date')
      .not('date', 'is', null)
      .order('date', { ascending: true })
      .limit(1)
      .maybeSingle();
    from = firstTxn?.date?.slice(0, 10) || toISODate(addDays(new Date(today + 'T00:00:00Z'), -365));
  }

  // If no holdings/tickers, return empty map
  if (tickers.length === 0) return NextResponse.json({ range, from, to: today, changes: {}, changes_native: {}, currency_by_ticker });

  // 1D: compute from current prices + previous_close only (fast path)
  if (range === '1D') {
    const [{ data: priceRows }, { data: fxRow }, { getAllHoldingsAndCashSummary: getSummary }] = await Promise.all([
      supabase
        .from('prices')
        .select('ticker,price,previous_close,price_multiplier')
        .in('ticker', tickers.length ? tickers : ['__none__']),
      supabase
        .from('fx_rates')
        .select('date,quotes')
        .eq('date', today)
        .maybeSingle<{ date: string; quotes: Record<string, number> | null }>(),
      import('@/lib/queries'),
    ]);
    const fxToday = parseFxQuotesToGBP(fxRow?.quotes || undefined);
    const todaySummary = await getSummary(supabase, { asOf: today });
    const holdingsByTicker: Record<string, { shares: number; ccy: string }> = {};
    for (const h of (todaySummary.holdings || []).filter(keepHolding) as HoldingRow[]) {
      holdingsByTicker[h.ticker] = { shares: h.total_shares, ccy: (h.currency || 'GBP').toUpperCase() };
    }
    const cpMap: Record<string, { price: number; prev: number }> = {};
    for (const r of (priceRows || []) as { ticker: string; price: number | null; previous_close: number | null; price_multiplier: number | null }[]) {
      const mult = Number(r.price_multiplier || 1) || 1;
      const price = Number(r.price || 0) * mult;
      const prev = Number(r.previous_close || 0) * mult;
      cpMap[r.ticker] = { price, prev };
    }
    const changes: ChangesMap = {};
    const changes_native: ChangesNativeMap = {};
    for (const t of tickers) {
      const h = holdingsByTicker[t];
      if (!h || !h.shares) continue;
      const rate = fxToday[h.ccy] ?? 1;
      const row = cpMap[t];
      if (!row || !(row.price > 0) || !(row.prev > 0)) {
        changes[t] = 0;
        changes_native[t] = 0;
        continue;
      }
      const deltaNative = (row.price - row.prev) * h.shares;
      changes_native[t] = deltaNative;
      changes[t] = deltaNative * rate;
    }
    return NextResponse.json({ range, from, to: today, changes, changes_native, currency_by_ticker });
  }

  // Longer ranges: use price at 'from' and 'today'
  type PriceHistRow = { ticker: string; date: string; price: number | null; price_multiplier: number | null };
  type CurrentPriceRow = { ticker: string; price: number | null; price_multiplier: number | null };

  const bufferDays = 180;
  const fromStart = toISODate(addDays(new Date(from + 'T00:00:00Z'), -bufferDays));
  const todayStart = toISODate(addDays(new Date(today + 'T00:00:00Z'), -bufferDays));

  const [{ data: phFromWin }, { data: phTodayWin }, { data: cp }, { data: fxFromWin }, { data: fxTodayWin }, { getAllHoldingsAndCashSummary: getSummary2 }] = await Promise.all([
    supabase
      .from('price_history')
      .select('ticker,date,price,price_multiplier')
      .in('ticker', tickers)
      .gte('date', fromStart)
      .lte('date', from)
      .order('date', { ascending: true }),
    supabase
      .from('price_history')
      .select('ticker,date,price,price_multiplier')
      .in('ticker', tickers)
      .gte('date', todayStart)
      .lte('date', today)
      .order('date', { ascending: true }),
    supabase
      .from('prices')
      .select('ticker,price,price_multiplier')
      .in('ticker', tickers),
    supabase
      .from('fx_rates')
      .select('date,quotes')
      .gte('date', fromStart)
      .lte('date', from)
      .order('date', { ascending: true }),
    supabase
      .from('fx_rates')
      .select('date,quotes')
      .gte('date', todayStart)
      .lte('date', today)
      .order('date', { ascending: true }),
    import('@/lib/queries'),
  ]);

  // Latest FX on/before each endpoint date (within buffer window)
  const fxFromMap = (() => {
    const rows = (fxFromWin || []) as { date: string; quotes: Record<string, number> | null }[];
    const last = rows.length ? rows[rows.length - 1] : null;
    return parseFxQuotesToGBP(last?.quotes || undefined);
  })();
  const fxToday = (() => {
    const rows = (fxTodayWin || []) as { date: string; quotes: Record<string, number> | null }[];
    const last = rows.length ? rows[rows.length - 1] : null;
    return parseFxQuotesToGBP(last?.quotes || undefined);
  })();

  const fromPrice: Record<string, number> = {};
  for (const r of (phFromWin || []) as PriceHistRow[]) {
    const mult = Number(r.price_multiplier || 1) || 1;
    const price = Number(r.price || 0) * mult;
    if (price > 0) fromPrice[r.ticker] = price; // overwrites → last in window wins
  }

  const todayPrice: Record<string, number> = {};
  for (const r of (phTodayWin || []) as PriceHistRow[]) {
    const mult = Number(r.price_multiplier || 1) || 1;
    const price = Number(r.price || 0) * mult;
    if (price > 0) todayPrice[r.ticker] = price; // last in window wins
  }
  for (const r of (cp || []) as CurrentPriceRow[]) {
    const mult = Number(r.price_multiplier || 1) || 1;
    const price = Number(r.price || 0) * mult;
    if (price > 0 && !todayPrice[r.ticker]) todayPrice[r.ticker] = price;
  }

  const todayHoldingsSummary = await getSummary2(supabase, { asOf: today });
  const todayHoldings = (todayHoldingsSummary.holdings || []).filter(keepHolding) as HoldingRow[];
  const changes: ChangesMap = {};
  const changes_native: ChangesNativeMap = {};
  for (const h of todayHoldings) {
    const t = h.ticker;
    const shares = h.total_shares || 0;
    if (!shares) continue;
    const ccy = (h.currency || 'GBP').toUpperCase();
    const pFrom = fromPrice[t] || 0;
    const pToday = todayPrice[t] || 0;
    const rFrom = fxFromMap[ccy] ?? 1;
    const rToday = fxToday[ccy] ?? 1;
    if (pFrom > 0 && pToday > 0) {
      changes_native[t] = shares * (pToday - pFrom);
      changes[t] = shares * (pToday * rToday - pFrom * rFrom);
    } else {
      changes_native[t] = 0;
      changes[t] = 0;
    }
  }

  return NextResponse.json({ range, from, to: today, changes, changes_native, currency_by_ticker });
}
