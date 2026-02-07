import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

type HoldingRow = { status?: string | null; total_shares: number; ticker: string };

function keepHoldingFactory(showZeroHoldings: boolean, visibleStatuses: string[] | null) {
  const visible = new Set((visibleStatuses ?? ['active']).map((s) => String(s).toLowerCase().trim()));
  return (h: HoldingRow) => {
    const status = (h.status ? String(h.status) : 'unknown').toLowerCase();
    const hasUnits = (h.total_shares ?? 0) !== 0;
    if (!showZeroHoldings && !hasUnits) return false;
    return visible.has(status);
  };
}

export async function GET() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Determine which tickers we care about (current visible holdings)
  const settingsRes = await supabase
    .from('settings')
    .select('show_zero_holdings, visible_statuses')
    .eq('id', 'global')
    .maybeSingle<{ show_zero_holdings: boolean | null; visible_statuses: string[] | null }>();
  const showZeroHoldings = !!settingsRes.data?.show_zero_holdings;
  const keepHolding = keepHoldingFactory(showZeroHoldings, settingsRes.data?.visible_statuses ?? ['active']);

  const { getAllHoldingsAndCashSummary } = await import('@/lib/queries');
  const todayISO = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const todaySummary = await getAllHoldingsAndCashSummary(supabase, { asOf: todayISO });
  const holdings = (todaySummary.holdings || []).filter(keepHolding) as HoldingRow[];
  const tickers = holdings.map((h) => h.ticker).filter(Boolean);

  if (tickers.length === 0) {
    return NextResponse.json({
      ok: true,
      now: new Date().toISOString(),
      tracked_tickers: 0,
      recent_updates_60s: 0,
      recent_updates_5m: 0,
      latest_update_at: null,
      most_stale: [],
    });
  }

  // Read latest price timestamps for those tickers
  const { data: priceRows, error } = await supabase
    .from('prices')
    .select('ticker,updated_at')
    .in('ticker', tickers);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const now = Date.now();
  let latestUpdate = 0;
  let recent60 = 0;
  let recent5m = 0;
  const ages: { ticker: string; age_ms: number; updated_at: string }[] = [];

  for (const r of priceRows || []) {
    const ts = new Date(r.updated_at as string).getTime();
    if (Number.isFinite(ts)) {
      ages.push({ ticker: r.ticker as string, age_ms: Math.max(0, now - ts), updated_at: r.updated_at as string });
      if (ts > latestUpdate) latestUpdate = ts;
      if (now - ts <= 60_000) recent60++;
      if (now - ts <= 300_000) recent5m++;
    }
  }

  ages.sort((a, b) => b.age_ms - a.age_ms);
  const mostStale = ages.slice(0, 10).map((a) => ({ ticker: a.ticker, updated_at: a.updated_at, age_ms: a.age_ms }));

  return NextResponse.json({
    ok: true,
    now: new Date(now).toISOString(),
    tracked_tickers: tickers.length,
    recent_updates_60s: recent60,
    recent_updates_5m: recent5m,
    latest_update_at: latestUpdate ? new Date(latestUpdate).toISOString() : null,
    most_stale: mostStale,
  });
}
