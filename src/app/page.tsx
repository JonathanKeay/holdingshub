export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { getPortfoliosWithHoldingsAndCash, getAllHoldingsAndCashSummary } from '@/lib/queries';
import { fetchAndCachePrices } from '@/lib/prices';
import { fetchExchangeRatesToGBP } from '@/lib/fx';
import { getCurrencySymbol } from '@/lib/currency';
import { formatCurrency } from '@/lib/formatCurrency';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { LogoWithFallback } from '@/components/LogoWithFallback';
import { TotalHoldingsTable } from '@/components/TotalHoldingsTable';
import { PerPortfolioTable } from '@/components/PerPortfolioTable';
import {
  POSITIVE_BADGE,
  NEGATIVE_BADGE,
  POSITIVE_TEXT,
  NEGATIVE_TEXT,
  THEME_BLUE_TEXT,
  THEME_BLUE_BADGE,
  THEME_BLUE_DISABLED,
  THEME_BLUE_DISABLED_BG,
} from '@/lib/uiColors';
import { unstable_cache } from 'next/cache';
import { redirect } from 'next/navigation';
import LivePricesRefresher from '@/components/LivePricesRefresher';
import MarketStatusDots from '@/components/MarketStatusDots';
import PortfolioExpandCollapseControls from '@/components/PortfolioExpandCollapseControls';

// Cache FX for 60s; cache prices for 30s (keyed by sorted tickers)
// Add tags so we can optionally invalidate via a webhook/job later.
const getFxCached = unstable_cache(fetchExchangeRatesToGBP, ['fx-v1'], { revalidate: 60, tags: ['fx'] });
const getPricesCached = unstable_cache(
  async (tickersKey: string, tickerQuantities: Record<string, number>) => {
    const tickers = JSON.parse(tickersKey) as string[];
    return fetchAndCachePrices(tickers, tickerQuantities);
  },
  ['prices-v1'],
  { revalidate: 30, tags: ['prices'] }
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
    .select('show_zero_holdings, visible_statuses')
    .eq('id', 'global')
    .single();

  const portfoliosPromise = getPortfoliosWithHoldingsAndCash(supabase);
  const totalSummaryPromise = getAllHoldingsAndCashSummary(supabase);

  // Await DB pieces together
  const [
    { data: settings },
    portfoliosRaw,
    { holdings: totalHoldingsRaw, cash_balances: totalCashBalances },
  ] = await Promise.all([settingsPromise, portfoliosPromise, totalSummaryPromise]);

  // Settings -> filters
  const showZeroHoldings: boolean = !!settings?.show_zero_holdings;
  const visibleStatusesSet = new Set(
    (settings?.visible_statuses ?? ['active']).map((s: string) => String(s).toLowerCase().trim())
  );
  const keepHolding = (h: any) => {
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
      logo_url: h.logo_url || null,
    }));

  const portfolios = portfoliosRaw.map(({ portfolio, holdings, cash_balances }) => ({
    portfolio,
    holdings: holdings
      .filter(keepHolding)
      .map((h) => ({
        ...h,
        currencySymbol: getCurrencySymbol(h.currency),
        logo_url: h.logo_url || null,
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
  const tickersKey = JSON.stringify(allTickersSorted);

  // Prices & FX in parallel (cached)
  const [prices, fxRates] = await Promise.all([
    getPricesCached(tickersKey, tickerQuantities),
    getFxCached(),
  ]);

  // Helper to convert -> GBP
  const toGBP = (amount: number, ccy?: string) =>
    amount * (fxRates[(ccy || 'GBP').toUpperCase()] ?? 1);

  // Global cash: sum per-currency in GBP
  const totalCashGBP =
    totalCashBalances?.reduce((sum, cb) => sum + toGBP(cb.balance, cb.currency), 0) ?? 0;

  return (
    <main className="p-6 max-w-6xl mx-auto">
  <h1 className="text-2xl font-bold mb-2">Portfolio Dashboard</h1>
      <div className="mb-2">
        <MarketStatusDots tickers={allTickersSorted} />
      </div>

      {/* Live refresh: Supabase Realtime + visibility-aware polling (lightweight) */}
      <LivePricesRefresher tickers={allTickersSorted} refreshMinMs={15_000} pollMs={60_000} />

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
