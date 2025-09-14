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

// Cache FX for 60s; cache prices for 30s (keyed by sorted tickers)
const getFxCached = unstable_cache(fetchExchangeRatesToGBP, ['fx-v1'], { revalidate: 60 });
const getPricesCached = unstable_cache(
  async (tickersKey: string, tickerQuantities: Record<string, number>) => {
    const tickers = JSON.parse(tickersKey) as string[];
    return fetchAndCachePrices(tickers, tickerQuantities);
  },
  ['prices-v1'],
  { revalidate: 30 }
);

export default async function Dashboard() {
  const supabase = await getSupabaseServerClient();

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
      <h1 className="text-2xl font-bold mb-6">Portfolio Dashboard</h1>

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
      {portfolios.map(({ portfolio, holdings, cash_balances }) => {
        const baseCurrency = (portfolio.base_currency || 'GBP') as 'GBP' | 'USD' | 'EUR';

        // For ISA and non-ISA, just keep all holdings
        const filteredHoldings = holdings;

        // Sort alphabetically by ticker (case-insensitive)
        filteredHoldings.sort((a, b) => (a.ticker || '').localeCompare(b.ticker || '', undefined, { sensitivity: 'base' }));

        const filteredCashBalances = cash_balances ?? [];

        // Calculate all key totals in one pass (performance)
        let totalChangeInBase = 0;
        let totalMarketValueInBase = 0;
        let totalPrevValueInBase = 0;
        let totalCostInBase = 0;
        let totalProfitLossInBase = 0;

        for (const h of filteredHoldings) {
          const price = prices[h.ticker]?.price ?? 0;
          const prev = prices[h.ticker]?.previous_close ?? 0;
          const multiplier = prices[h.ticker]?.price_multiplier ?? 1;

          const rate = fxRates[h.currency?.toUpperCase() || 'GBP'] ?? 1;
          const baseRate = fxRates[baseCurrency] ?? 1;
          const fx = rate / baseRate;

          const marketValue = h.total_shares * price * multiplier;
          const prevValue = h.total_shares * prev * multiplier;
          const cost = h.total_cost;

          totalChangeInBase += (price - prev) * multiplier * h.total_shares * fx;
          totalMarketValueInBase += marketValue * fx;
          totalPrevValueInBase += prevValue * fx;
          totalCostInBase += cost * fx;
          totalProfitLossInBase += (marketValue - cost) * fx;
        }

        const totalChangePercent =
          totalPrevValueInBase > 0 ? (totalChangeInBase / totalPrevValueInBase) * 100 : 0;

        const cashTotalInBase = (filteredCashBalances ?? []).reduce((sum, cb) => {
          const rate = fxRates[cb.currency?.toUpperCase() || 'GBP'] ?? 1;
          const baseRate = fxRates[baseCurrency] ?? 1;
          return sum + cb.balance * (rate / baseRate);
        }, 0);

        const totalPortfolioValue = totalMarketValueInBase + cashTotalInBase;

        return (
          <div key={portfolio.id} className="mb-8">
            <h2 className={`${THEME_BLUE_TEXT} text-l font-bold mb-1`}>{portfolio.name}</h2>
            <table className="w-full text-sm border">
              <thead className="bg-themeblue text-white font-semibold border-b-2 border-themeblue-hover">
                <tr>
                  <th className="text-left p-1">Company</th>
                  <th className="text-right">Market Price</th>
                  <th className="text-right">Change</th>
                  <th className="text-right">Units</th>
                  <th className="text-right">Cost</th>
                  <th className="text-right">Value/Gain</th>
                  <th className="text-center">R. Value</th>
                </tr>
              </thead>
              <tbody>
                {filteredHoldings.map((h) => {
                  const price = prices[h.ticker]?.price ?? 0;
                  const previousClose = prices[h.ticker]?.previous_close ?? 0;
                  const multiplier = prices[h.ticker]?.price_multiplier ?? 1;
                  const marketValue = h.total_shares * price * multiplier;
                  const totalCost = h.total_cost;
                  const profitLoss = marketValue - totalCost;
                  const change = (price - previousClose) * multiplier;
                  const changePercent = previousClose > 0 ? (change / (previousClose * multiplier)) * 100 : 0;
                  const changeValue = change * h.total_shares;

                  return (
                    <tr key={h.asset_id} className="border-t text-s align-middle">
                      {/* Logo */}
                      <td className="p-1 align-middle">
                        <div className="flex items-center">
                          {h.logo_url && (
                            <LogoWithFallback
                              src={h.logo_url}
                              alt={`${h.ticker} logo`}
                              className="h-8 w-8 rounded bg-white border mr-1"
                              loading="lazy"
                              decoding="async"
                            />
                          )}
                          <div>
                            <div className={`${THEME_BLUE_TEXT} font-bold`}>{h.ticker}</div>
                            <div className="text-xs text-gray-500">{h.company_name || h.ticker}</div>
                          </div>
                        </div>
                      </td>
                      {/* Price & VAR */}
                      <td className="p-1 text-right align-top">
                        {/* Price (neutral) */}
                        <div className="font-semibold text-gray-900">
                          {formatCurrency(price * multiplier, h.currency)}
                        </div>
                        {/* Change value and percent */}
                        <div className="mt-1 whitespace-nowrap flex items-center justify-end gap-2">
                          <span className={`font-bold ${change < 0 ? 'text-red-600' : change > 0 ? 'text-green-600' : 'text-gray-400'}`}>
                            {formatCurrency(Math.abs(change), h.currency)}
                          </span>
                          {changePercent !== 0 && (
                            <span className={changePercent < 0 ? NEGATIVE_BADGE : POSITIVE_BADGE}>
                              {Math.abs(changePercent).toFixed(2)}%
                            </span>
                          )}
                        </div>
                      </td>
                      {/* Position Change Value (Cash) */}
                      <td
                        className={`p-1 text-right align-middle font-bold text-lg ${
                          changeValue > 0 ? POSITIVE_TEXT : changeValue < 0 ? NEGATIVE_TEXT : ''
                        }`}
                      >
                        {changeValue === 0
                          ? ''
                          : formatCurrency(
                              Math.round(Math.abs(changeValue)), // remove pence + strip sign
                              h.currency
                            ).replace(/\.00$/, '')}
                      </td>
                      {/* Units */}
                      <td className={`${THEME_BLUE_TEXT} p-1 text-right align-middle font-bold text-lg`}>
                        {h.total_shares.toFixed(1)}
                      </td>
                      {/* Unit Cost & Total Cost */}
                      <td className={`${THEME_BLUE_TEXT} p-1 text-right font-bold align-top`}>
                        <div>
                          {formatCurrency(h.avg_price, h.currency)}
                        </div>
                        <div className="text-s font-bold mt-1">
                          <span className="bg-Thoverlight-tint rounded px-1">
                            {formatCurrency(totalCost, h.currency)}
                          </span>
                        </div>
                      </td>
                      {/* Market Value */}
                      <td className="p-1 text-right align-top">
                        {/* Market Value */}
                        <span className={marketValue > totalCost ? POSITIVE_BADGE : NEGATIVE_BADGE}>
                          {formatCurrency(marketValue, h.currency)}
                        </span>
                        {/* Unrealised Value (Profit/Loss) */}
                        {profitLoss !== 0 && (
                          <div className={`mt-1 font-semibold pr-1 ${profitLoss > 0 ? POSITIVE_TEXT : NEGATIVE_TEXT}`}>
                            {formatCurrency(profitLoss, h.currency)}
                          </div>
                        )}
                      </td>
                      {/* Realised Value */}
                      <td className={`p-1 text-center font-bold align-top ${h.realised_value === 0 ? '' : h.realised_value > 0 ? POSITIVE_TEXT : NEGATIVE_TEXT}`}>
                        {h.realised_value === 0 ? '' : formatCurrency(h.realised_value, h.currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className={`${THEME_BLUE_DISABLED_BG} row-compact font-semibold border-t text-base`}>
                  <td className="p-1 text-right" colSpan={2}>
                    TOTAL ASSETS
                  </td>

                  <td className="p-1 text-right font-bold">
                    <span className={totalChangeInBase >= 0 ? 'text-[var(--color-tgreen)]' : 'text-[var(--color-tred)]'}>
                      {formatCurrency(Math.abs(totalChangeInBase), baseCurrency)}
                    </span>
                  </td>

                    <td className="p-1 text-left">
                      {totalChangePercent !== 0
                        ? (
                          <span className={`font-bold ${totalChangePercent > 0 ? 'text-[var(--color-tgreen)]' : 'text-[var(--color-tred)]'}`}>
                            {totalChangePercent > 0 ? '+' : ''}
                            {Math.abs(totalChangePercent).toFixed(2)}%
                          </span>
                        )
                        : <span className="text-gray-400">–</span>
                      }
                    </td>

                    <td className="p-1 text-right">
                      {formatCurrency(totalCostInBase, baseCurrency)}
                    </td>

                  <td className="p-1 text-right font-bold">
                    <span className={totalMarketValueInBase >= 0 ? 'text-[var(--color-tgreen)]' : 'text-[var(--color-tred)]'}>
                      {formatCurrency(Math.abs(totalMarketValueInBase), baseCurrency)}
                    </span>
                  </td>
                  <td className="p-1 text-left">
                    <span className={totalProfitLossInBase >= 0 ? 'text-[var(--color-tgreen)]' : 'text-[var(--color-tred)]'}>
                      {formatCurrency(Math.abs(totalProfitLossInBase), baseCurrency)}
                    </span>
                  </td>
                </tr>

                {cash_balances?.length > 0 && (
                  <tr className={`${THEME_BLUE_TEXT} row-compact font-semibold border-t text-base`}>
                    <td className="p-1 text-right" colSpan={2}>
                      {`AVAILABLE CASH`}
                    </td>
                    <td colSpan={3}></td>
                    <td className="p-1 text-right">{formatCurrency(cashTotalInBase, baseCurrency)}</td>
                    <td className="p-1 text-left text-xs">
                      {baseCurrency !== 'GBP' ? `(${formatCurrency(toGBP(cashTotalInBase, baseCurrency), 'GBP')})` : ''}
                    </td>
                  </tr>
                )}


                <tr className={`${THEME_BLUE_DISABLED_BG} font-bold border-t text-right text-base`}>
                  <td className="p-1 text-right" colSpan={2}>TOTAL PORTFOLIO VALUE</td>
                  <td colSpan={3}></td>
                  <td className="p-1 text-right">
                    {formatCurrency(totalPortfolioValue, baseCurrency)}
                  </td>
                  <td className="p-1 text-left text-xs">
                    {baseCurrency !== 'GBP' ? `(${formatCurrency(toGBP(totalPortfolioValue, baseCurrency), 'GBP')})` : ''}
                  </td>
                </tr>
              </tfoot>
            </table>

            <div className="text-right mt-1">
              <a href={`/transactions?portfolio=${portfolio.id}`} className="text-gray-400 text-sm hover:underline">
                Transactions
              </a>
            </div>
          </div>
        );
      })}

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
