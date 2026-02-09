export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { redirect } from 'next/navigation';
import { getSupabaseServerClient } from '@/lib/supabase-server';

import MobilePortfolioView from './MobilePortfolioView';
import { getAllHoldingsAndCashSummary, type Holding } from '@/lib/queries';
import { fetchAndCachePrices } from '@/lib/prices';
import { unstable_cache } from 'next/cache';
import { fetchExchangeRatesToGBP } from '@/lib/fx';
import MarketStatusBadges from '@/components/MarketStatusBadges';
import LivePricesRefresher from '@/components/LivePricesRefresher';
import RefreshIndicator from '@/components/RefreshIndicator';

const getFxCached = unstable_cache(fetchExchangeRatesToGBP, ['fx-v1'], { revalidate: 60, tags: ['fx'] });
const getPricesCached = unstable_cache(
  async (tickersKey: string, tickerQuantities: Record<string, number>) => {
    const parsed = JSON.parse(tickersKey);
    const tickers: string[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tickers) ? parsed.tickers : [];
    return fetchAndCachePrices(tickers, tickerQuantities);
  },
  ['prices-v1'],
  { revalidate: 10, tags: ['prices'] }
);

export default async function MobilePage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    redirect('/login');
  }

  // Load settings for the same filters as the desktop page
  const settingsPromise = supabase
    .from('settings')
    .select('show_zero_holdings, visible_statuses')
    .eq('id', 'global')
    .single();
  const totalSummaryPromise = getAllHoldingsAndCashSummary(supabase);
  const [settingsRes, summary] = await Promise.all([settingsPromise, totalSummaryPromise]);

  const settings = settingsRes.data;
  const showZeroHoldings: boolean = !!settings?.show_zero_holdings;
  const visibleStatusesSet = new Set(
    (settings?.visible_statuses ?? ['active']).map((s: string) => String(s).toLowerCase().trim())
  );
  const keepHolding = (h: Holding) => {
    const status = (h.status ? String(h.status) : 'unknown').toLowerCase();
    const hasUnits = (h.total_shares ?? 0) !== 0;
    if (!showZeroHoldings && !hasUnits) return false;
    return visibleStatusesSet.has(status);
  };

  const holdings = summary.holdings.filter(keepHolding).map((h) => ({
    ...h,
    logo_url: (() => {
      const url = h.logo_url || null;
      if (!url) return null;
      const m0 = /^domain:(.+)$/i.exec(url);
      if (m0 && m0[1]) return `/api/logo-proxy?domain=${encodeURIComponent(m0[1])}`;
      const m1 = /^https?:\/\/logo\.clearbit\.com\/(.+)$/i.exec(url);
      if (m1 && m1[1]) return `/api/logo-proxy?domain=${encodeURIComponent(m1[1])}`;
      const m2 = /^https?:\/\/img\.logo\.dev\/(.+)$/i.exec(url);
      if (m2 && m2[1]) return `/api/logo-proxy?domain=${encodeURIComponent(m2[1])}`;
      return `/api/logo-proxy?url=${encodeURIComponent(url)}`;
    })(),
  }));

  // Build ticker list for prices
  const tickerQuantities: Record<string, number> = {};
  for (const h of holdings) {
    tickerQuantities[h.ticker] = h.total_shares;
  }
  const allTickersSorted = Object.keys(tickerQuantities).sort();
  // Include a global prices version so router.refresh can always break cache promptly
  const versionRow = await supabase
    .from('prices')
    .select('updated_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const latestVersion: string | null = versionRow?.data?.updated_at || null;
  const tickersKey = JSON.stringify({ tickers: allTickersSorted, v: latestVersion });

  const [prices, fxRates] = await Promise.all([
    getPricesCached(tickersKey, tickerQuantities),
    getFxCached(),
  ]);
  // Prefetch initial series for 1D to align header with chart immediately on first paint
  let initialSeries: { date: string; value_gbp: number }[] | null = null;
  try {
    // Default SSR prefetch to UK timezone; client will refetch with the user's real timezone
    const res = await fetch('/api/portfolio-series?range=1D&tz=Europe/London', { cache: 'no-store' });
    if (res.ok) {
      const json = await res.json();
      initialSeries = Array.isArray(json?.points) ? json.points : null;
    }
  } catch {}

  // Compute cash GBP for header total to match desktop's "ALL PORTFOLIO TOTAL VALUE"
  const cashGBP = (summary.cash_balances || []).reduce((sum, cb) => {
    const rate = fxRates[(cb.currency || 'GBP').toUpperCase()] ?? 1;
    return sum + cb.balance * rate;
  }, 0);

  return (
    <main className="p-4 w-full max-w-[100vw] overflow-x-hidden">
      <h1 className="text-xl font-semibold mb-2">All Portfolios</h1>
      <div className="mb-3 space-y-1">
        <MarketStatusBadges tickers={allTickersSorted} />
        {/* Mobile live refresh + status indicator */}
        <LivePricesRefresher tickers={allTickersSorted} refreshMinMs={10_000} pollMs={12_000} forcedRefreshMs={45_000} />
        <RefreshIndicator intervalMs={12_000} />
      </div>
      <MobilePortfolioView holdings={holdings} prices={prices} fxRates={fxRates} cashGBP={cashGBP} initialSeries={initialSeries || undefined} />
    </main>
  );
}
