import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase-server';

async function fetchYahooSnapshot(symbol: string) {
  try {
    const url1 = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
    const res1 = await fetch(url1);
    const j1 = await res1.json();
    const r1 = j1?.chart?.result?.[0];
    const meta = r1?.meta || {};
    const closes = r1?.indicators?.quote?.[0]?.close || [];
    const prevClose = typeof meta?.chartPreviousClose === 'number' ? meta.chartPreviousClose : (closes?.[0] ?? 0);

    const url2 = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`;
    const res2 = await fetch(url2);
    const j2 = await res2.json();
    const r2 = j2?.chart?.result?.[0];
    const rmp = typeof r1?.meta?.regularMarketPrice === 'number' ? r1.meta.regularMarketPrice : null;
    const ts = r2?.timestamp as number[] | undefined;
    const close = r2?.indicators?.quote?.[0]?.close as (number | null)[] | undefined;
    const lastIntra = ts && close && ts.length === close.length ? (close.findLast(v => typeof v === 'number' && v > 0) as number | null) : null;
    return { regularMarketPrice: rmp, previousClose: prevClose || 0, lastIntraday: lastIntra };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const tickersParam = searchParams.get('tickers') || searchParams.get('ticker');
  if (!tickersParam) return NextResponse.json({ error: 'Provide ?tickers=AMD,MSFT' }, { status: 400 });
  const tickers = tickersParam.split(',').map(s => s.trim()).filter(Boolean);

  const supabase = await getSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  type AssetRow = { ticker: string; resolved_ticker: string | null; currency: string | null; price_multiplier: number | null; status: string | null };
  const { data: assets } = await supabase
    .from('assets')
    .select('ticker,resolved_ticker,currency,price_multiplier,status')
    .in('ticker', tickers);

  type PriceRow = { ticker: string; price: number | null; previous_close: number | null; price_multiplier: number | null; updated_at: string };
  const { data: prices } = await supabase
    .from('prices')
    .select('ticker,price,previous_close,price_multiplier,updated_at')
    .in('ticker', tickers)
    .order('updated_at', { ascending: true });

  type HistRow = { ticker: string; date: string; price: number | null; price_multiplier: number | null };
  const { data: history } = await supabase
    .from('price_history')
    .select('ticker,date,price,price_multiplier')
    .in('ticker', tickers)
    .order('date', { ascending: false })
    .limit(5);

  const live: Record<string, { regularMarketPrice: number | null; previousClose: number; lastIntraday: number | null } | { error: string }> = {};
  for (const a of (assets as AssetRow[] | null) || []) {
    const symbol = a.resolved_ticker || a.ticker;
    live[a.ticker] = await fetchYahooSnapshot(symbol);
  }

  const byTicker = <T extends { ticker: string }>(arr: T[] | null | undefined) => {
    const m: Record<string, T[]> = {};
    for (const r of arr || []) {
      (m[r.ticker] ||= []).push(r);
    }
    return m;
  };

  // Keep newest price per ticker
  const latestPriceByTicker: Record<string, PriceRow> = {};
  for (const r of (prices as PriceRow[] | null) || []) {
    const prev = latestPriceByTicker[r.ticker];
    if (!prev || new Date(r.updated_at).getTime() >= new Date(prev.updated_at).getTime()) latestPriceByTicker[r.ticker] = r;
  }

  return NextResponse.json({
    assets: assets as AssetRow[] | null,
    prices: latestPriceByTicker,
    history: byTicker(history as HistRow[] | null | undefined),
    live,
  });
}
