export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { getPortfoliosWithHoldingsAndCash, getAllHoldingsAndCashSummary } from '@/lib/queries';
import { fetchAndCachePrices } from '@/lib/prices';
import { fetchExchangeRatesToGBP } from '@/lib/fx';
import { getCurrencySymbol } from '@/lib/currency';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { TotalHoldingsTable } from '@/components/TotalHoldingsTable';
import { PerPortfolioTable } from '@/components/PerPortfolioTable';
import { unstable_cache } from 'next/cache';
import { redirect } from 'next/navigation';
import LivePricesRefresher from '@/components/LivePricesRefresher';
import MarketStatusDots from '@/components/MarketStatusDots';
import MarketStatusBadges from '@/components/MarketStatusBadges';
import PortfolioExpandCollapseControls from '@/components/PortfolioExpandCollapseControls';
import RefreshIndicator from '@/components/RefreshIndicator';

// Cache FX for 60s; cache prices for 30s (keyed by sorted tickers)
// Add tags so we can optionally invalidate via a webhook/job later.
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

export default async function Dashboard() {
  const supabase = await getSupabaseServerClient();

  // Guard: if no session, redirect to /login
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    redirect('/login');
  }

  // Kick off everything in parallel
  const settingsPromise = supabase
    .from('settings')
    .select('show_zero_holdings, visible_statuses, portfolio_prefs')
    .eq('id', 'global')
    .single();

  const portfoliosPromise = getPortfoliosWithHoldingsAndCash(supabase);
  const totalSummaryPromise = getAllHoldingsAndCashSummary(supabase);
  const pricesVersionPromise = supabase
    .from('prices')
    .select('updated_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Await DB pieces together
  const [
    { data: settings },
    portfoliosRaw,
    { holdings: totalHoldingsRaw, cash_balances: totalCashBalances },
    pricesVersionRow,
  ] = await Promise.all([settingsPromise, portfoliosPromise, totalSummaryPromise, pricesVersionPromise]);

  // Settings -> filters
  const showZeroHoldings: boolean = !!settings?.show_zero_holdings;
  const visibleStatusesSet = new Set(
    (settings?.visible_statuses ?? ['active']).map((s: string) => String(s).toLowerCase().trim())
  );

  const themePref: 'system' | 'light' | 'dark' =
    settings?.portfolio_prefs?.theme === 'light' || settings?.portfolio_prefs?.theme === 'dark' || settings?.portfolio_prefs?.theme === 'system'
      ? settings.portfolio_prefs.theme
      : 'system';
  const logoThemeParam = themePref === 'dark' ? 'dark' : themePref === 'light' ? 'light' : null;
  const logoProxyExtras = `${logoThemeParam ? `&theme=${encodeURIComponent(logoThemeParam)}` : ''}&format=png&fallback=404`;
  const keepHolding = (h: { status?: string | null; total_shares: number }) => {
    const status = (h.status ? String(h.status) : 'unknown').toLowerCase();
    const hasUnits = (h.total_shares ?? 0) !== 0;
    if (!showZeroHoldings && !hasUnits) return false;
    return visibleStatusesSet.has(status);
  };

  // Shape holdings (apply filters + presentational fields)
  const totalHoldings = totalHoldingsRaw
    .filter(keepHolding)
    .map((h) => ({
      ...h,
      currencySymbol: getCurrencySymbol(h.currency),
      logo_url: (() => {
        const url0 = h.logo_url || null;
        const url = url0 ? url0.replace(/^manual:/i, '') : null;
        if (!url) return null;
        const m0 = /^domain:(.+)$/i.exec(url);
        if (m0 && m0[1]) return `/api/logo-proxy?domain=${encodeURIComponent(m0[1])}${logoProxyExtras}`;
        // If this is a Clearbit URL, extract domain and use server-side Logo.dev proxy when token is present
        const m1 = /^https?:\/\/logo\.clearbit\.com\/(.+)$/i.exec(url);
        if (m1 && m1[1]) return `/api/logo-proxy?domain=${encodeURIComponent(m1[1])}${logoProxyExtras}`;
        const m2 = /^https?:\/\/img\.logo\.dev\/(.+)$/i.exec(url);
        if (m2 && m2[1]) return `/api/logo-proxy?domain=${encodeURIComponent(m2[1])}${logoProxyExtras}`;
        // Otherwise, proxy the original if it’s allowed
        return `/api/logo-proxy?url=${encodeURIComponent(url)}`;
      })(),
    }));

  const portfolios = portfoliosRaw.map(({ portfolio, holdings, cash_balances }) => ({
    portfolio,
    holdings: holdings
      .filter(keepHolding)
      .map((h) => ({
        ...h,
        currencySymbol: getCurrencySymbol(h.currency),
        logo_url: (() => {
          const url0 = h.logo_url || null;
          const url = url0 ? url0.replace(/^manual:/i, '') : null;
          if (!url) return null;
          const m0 = /^domain:(.+)$/i.exec(url);
          if (m0 && m0[1]) return `/api/logo-proxy?domain=${encodeURIComponent(m0[1])}${logoProxyExtras}`;
          const m1 = /^https?:\/\/logo\.clearbit\.com\/(.+)$/i.exec(url);
          if (m1 && m1[1]) return `/api/logo-proxy?domain=${encodeURIComponent(m1[1])}${logoProxyExtras}`;
          const m2 = /^https?:\/\/img\.logo\.dev\/(.+)$/i.exec(url);
          if (m2 && m2[1]) return `/api/logo-proxy?domain=${encodeURIComponent(m2[1])}${logoProxyExtras}`;
          return `/api/logo-proxy?url=${encodeURIComponent(url)}`;
        })(),
      })),
    cash_balances,
  }));

  // Build ticker list for prices (dedup)
  const tickerQuantities: Record<string, number> = {};
  for (const h of totalHoldings) {
    tickerQuantities[h.ticker] = h.total_shares;
  }
  for (const p of portfoliosRaw) {
    for (const h of p.holdings) {
      tickerQuantities[h.ticker] = Math.max(tickerQuantities[h.ticker] ?? 0, h.total_shares);
    }
  }
  const allTickersSorted = Object.keys(tickerQuantities).sort(); // stable cache key
  // Include latest prices version to break cache immediately when any price changes
  const latestVersion: string | null = (pricesVersionRow && 'data' in (pricesVersionRow as object) && (pricesVersionRow as { data?: { updated_at?: string | null } }).data?.updated_at) || null;
  const tickersKey = JSON.stringify({ tickers: allTickersSorted, v: latestVersion });

  // Prices & FX in parallel (cached)
  const [prices, fxRates] = await Promise.all([
    getPricesCached(tickersKey, tickerQuantities),
    getFxCached(),
  ]);

  // Helper to convert -> GBP (kept inline where needed)

  // Note: cash totals per currency are displayed via the tables; no separate header total here.

  return (
    <main className="p-6 max-w-6xl mx-auto">
  <h1 className="text-2xl font-bold mb-2">HoldingsHub(Dev)</h1>
      <div className="mb-2 space-y-1">
        <MarketStatusDots tickers={allTickersSorted} />
        <MarketStatusBadges tickers={allTickersSorted} />
        <RefreshIndicator intervalMs={15_000} />
      </div>

      {/* Live refresh: Supabase Realtime + visibility-aware polling (lightweight) */}
  <LivePricesRefresher tickers={allTickersSorted} refreshMinMs={10_000} pollMs={12_000} forcedRefreshMs={45_000} />

      {/* --- TOTAL HOLDINGS TABLE (All Portfolios) --- */}
      <div className="mb-10">
        <TotalHoldingsTable
          holdings={totalHoldings}
          prices={prices}
          fxRates={fxRates}
          cashBalances={totalCashBalances}
        />
      </div>

      {/* --- PER-PORTFOLIO TABLES --- */}
      <PortfolioExpandCollapseControls />
      {portfolios.map(({ portfolio, holdings, cash_balances }) => (
        <PerPortfolioTable
          key={portfolio.id}
          portfolio={portfolio}
          holdings={holdings}
          cashBalances={cash_balances}
          prices={prices}
          fxRates={fxRates}
        />
      ))}

      {(() => {
        const allTimestamps = Object.values(prices)
          .map((p) => new Date(p.updated_at || 0).getTime())
          .filter(Boolean);
        if (allTimestamps.length === 0) return null;

        const mostRecent = new Date(Math.max(...allTimestamps));
        const nextExpected = new Date(mostRecent.getTime() + 5 * 60 * 1000);

        return (
          <p className="mt-4 text-sm text-gray-500 text-left">
            Next Market Price update expected around{' '}
            {nextExpected.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
          </p>
        );
      })()}
    </main>
  );
}
