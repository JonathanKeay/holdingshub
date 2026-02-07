import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
import { getSupabaseServerClient } from '@/lib/supabase-server';

type ChangesMap = Record<string, number>; // ticker -> GBP change for selected range

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
  if (tickers.length === 0) return NextResponse.json({ range, from, to: today, changes: {} });

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
    for (const t of tickers) {
      const h = holdingsByTicker[t];
      if (!h || !h.shares) continue;
      const rate = fxToday[h.ccy] ?? 1;
      const row = cpMap[t];
      if (!row || !(row.price > 0) || !(row.prev > 0)) { changes[t] = 0; continue; }
      changes[t] = (row.price - row.prev) * h.shares * rate;
    }
    return NextResponse.json({ range, from, to: today, changes });
  }

  // Longer ranges: use price at 'from' and 'today'
  type PriceHistRow = { ticker: string; date: string; price: number | null; price_multiplier: number | null };
  type CurrentPriceRow = { ticker: string; price: number | null; price_multiplier: number | null };

  const [{ data: phFrom }, { data: phToday }, { data: cp }, { data: fxFrom }, { data: fxTodayRow }, { getAllHoldingsAndCashSummary: getSummary2 }] = await Promise.all([
    supabase
      .from('price_history')
      .select('ticker,date,price,price_multiplier')
      .in('ticker', tickers)
      .eq('date', from),
    supabase
      .from('price_history')
      .select('ticker,date,price,price_multiplier')
      .in('ticker', tickers)
      .eq('date', today),
    supabase
      .from('prices')
      .select('ticker,price,price_multiplier')
      .in('ticker', tickers),
    supabase
      .from('fx_rates')
      .select('date,quotes')
      .eq('date', from)
      .maybeSingle<{ date: string; quotes: Record<string, number> | null }>(),
    supabase
      .from('fx_rates')
      .select('date,quotes')
      .eq('date', today)
      .maybeSingle<{ date: string; quotes: Record<string, number> | null }>(),
    import('@/lib/queries'),
  ]);

  const fxFromMap = parseFxQuotesToGBP(fxFrom?.quotes || undefined);
  const fxToday = parseFxQuotesToGBP(fxTodayRow?.quotes || undefined);

  // Build price maps
  const fromPrice: Record<string, number> = {};
  for (const r of (phFrom || []) as PriceHistRow[]) {
    const mult = Number(r.price_multiplier || 1) || 1;
    const price = Number(r.price || 0) * mult;
    if (price > 0) fromPrice[r.ticker] = price;
  }
  const todayPrice: Record<string, number> = {};
  for (const r of (phToday || []) as PriceHistRow[]) {
    const mult = Number(r.price_multiplier || 1) || 1;
    const price = Number(r.price || 0) * mult;
    if (price > 0) todayPrice[r.ticker] = price;
  }
  for (const r of (cp || []) as CurrentPriceRow[]) {
    const mult = Number(r.price_multiplier || 1) || 1;
    const price = Number(r.price || 0) * mult;
    if (price > 0 && !todayPrice[r.ticker]) todayPrice[r.ticker] = price;
  }

  const todayHoldingsSummary = await getSummary2(supabase, { asOf: today });
  const todayHoldings = (todayHoldingsSummary.holdings || []).filter(keepHolding) as HoldingRow[];
  const changes: ChangesMap = {};
  for (const h of todayHoldings) {
    const t = h.ticker;
    const shares = h.total_shares || 0;
    if (!shares) continue;
    const ccy = (h.currency || 'GBP').toUpperCase();
    const pFrom = fromPrice[t] || 0;
    const pToday = todayPrice[t] || 0;
    const rFrom = fxFromMap[ccy] ?? 1;
    const rToday = fxToday[ccy] ?? 1;
    if (pFrom > 0 && pToday > 0) changes[t] = shares * (pToday * rToday - pFrom * rFrom);
    else changes[t] = 0;
  }

  return NextResponse.json({ range, from, to: today, changes });
}
