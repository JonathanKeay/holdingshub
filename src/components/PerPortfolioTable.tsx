"use client";

import { useState, useEffect, useMemo, useRef } from 'react';
import { formatCurrency } from '@/lib/formatCurrency';
import { LogoWithFallback } from '@/components/LogoWithFallback';
import {
  POSITIVE_BADGE,
  NEGATIVE_BADGE,
  POSITIVE_TEXT,
  NEGATIVE_TEXT,
  THEME_BLUE_TEXT,
  THEME_BLUE_DISABLED_BG,
} from '@/lib/uiColors';
import type { Holding } from '@/lib/queries';

type PriceMap = Record<string, { price: number; previous_close: number; price_multiplier: number } | undefined>;

interface Props {
  portfolio: { id: string; name: string; base_currency?: string | null };
  holdings: Holding[];
  cashBalances: { currency: string; balance: number }[] | undefined | null;
  prices: PriceMap;
  fxRates: Record<string, number>;
}

const SORT_STORAGE_KEY = 'totalHoldingsSortV1';

type SortCol = 'marketValue' | 'units' | 'totalCost' | 'unrealisedValue' | 'change' | null;

export function PerPortfolioTable({ portfolio, holdings, cashBalances, prices, fxRates }: Props) {
  const [sortColumn, setSortColumn] = useState<SortCol>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [scrolled, setScrolled] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [showAllColumns, setShowAllColumns] = useState(false);
  const [expanded, setExpanded] = useState(false); // collapsed by default, persisted per portfolio
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => {
      if (!el) return;
      setHasOverflow(el.scrollWidth > el.clientWidth + 2);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    window.addEventListener('resize', check);
    return () => {
      window.removeEventListener('resize', check);
      ro.disconnect();
    };
  }, []);

  // Sync sort from storage (shared with TotalHoldingsTable)
  useEffect(() => {
    const load = () => {
      try {
        const raw = localStorage.getItem(SORT_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        setSortColumn(parsed?.column ?? null);
        setSortDirection(parsed?.direction === 'asc' ? 'asc' : 'desc');
      } catch {/* ignore */}
    };
    load();
    const sync = () => load();
    window.addEventListener('portfolioSortChanged', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('portfolioSortChanged', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  // Persist expand/collapse per portfolio
  useEffect(() => {
    const key = `portfolio-expanded:${portfolio.id}`;
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) setExpanded(raw === '1');
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolio.id]);

  useEffect(() => {
    const key = `portfolio-expanded:${portfolio.id}`;
    try { localStorage.setItem(key, expanded ? '1' : '0'); } catch {}
  }, [expanded, portfolio.id]);

  // Respond to global expand/collapse controls
  useEffect(() => {
    const onExpand = () => setExpanded(true);
    const onCollapse = () => setExpanded(false);
    window.addEventListener('portfolio:expandAll', onExpand);
    window.addEventListener('portfolio:collapseAll', onCollapse);
    return () => {
      window.removeEventListener('portfolio:expandAll', onExpand);
      window.removeEventListener('portfolio:collapseAll', onCollapse);
    };
  }, []);

  const baseCurrency = (portfolio.base_currency || 'GBP').toUpperCase() as 'GBP' | 'USD' | 'EUR';

  const sortedHoldings = useMemo(() => {
    const arr = [...holdings];
    if (!sortColumn) {
      arr.sort((a, b) => (a.ticker || '').localeCompare(b.ticker || '', undefined, { sensitivity: 'base' }));
      return arr;
    }
    const dir = sortDirection === 'asc' ? 1 : -1;
    const getValue = (h: Holding) => {
      const p = prices[h.ticker];
      switch (sortColumn) {
        case 'units':
          return h.total_shares;
        case 'totalCost':
          return h.total_cost;
        case 'unrealisedValue': {
          const price = p?.price ?? 0;
          const mult = p?.price_multiplier ?? 1;
          const mv = price * mult * h.total_shares;
          return mv - h.total_cost;
        }
        case 'marketValue': {
          const price = p?.price ?? 0;
          const mult = p?.price_multiplier ?? 1;
          return price * mult * h.total_shares;
        }
        case 'change': {
          const price = p?.price ?? 0;
          const prev = p?.previous_close ?? 0;
          const mult = p?.price_multiplier ?? 1;
          return (price - prev) * mult * h.total_shares;
        }
        default:
          return 0;
      }
    };
    arr.sort((a, b) => {
      const primary = getValue(a) - getValue(b);
      if (primary !== 0) return dir * primary;
      return dir * (a.ticker || '').localeCompare(b.ticker || '');
    });
    return arr;
  }, [holdings, prices, sortColumn, sortDirection]);

  const displayUnits = (shares: number) => {
    const rounded = Math.round(shares);
    if (Math.abs(shares - rounded) < 1e-8) return String(rounded);
    const oneDec = Math.round(shares * 10) / 10;
    const oneDecInt = Math.round(oneDec);
    if (Math.abs(oneDec - oneDecInt) < 1e-8) return String(oneDecInt);
    return oneDec.toFixed(1);
  };

  // Aggregate totals (in base currency)
  let totalChangeInBase = 0;
  let totalMarketValueInBase = 0;
  let totalPrevValueInBase = 0;
  let totalCostInBase = 0;
  let totalProfitLossInBase = 0;
  for (const h of sortedHoldings) {
    const price = prices[h.ticker]?.price ?? 0;
    const prev = prices[h.ticker]?.previous_close ?? 0;
    const mult = prices[h.ticker]?.price_multiplier ?? 1;
    const rate = fxRates[h.currency?.toUpperCase() || 'GBP'] ?? 1;
    const baseRate = fxRates[baseCurrency] ?? 1;
    const fx = rate / baseRate;
    const mv = h.total_shares * price * mult;
    const prevVal = h.total_shares * prev * mult;
    const cost = h.total_cost;
    totalChangeInBase += (price - prev) * mult * h.total_shares * fx;
    totalMarketValueInBase += mv * fx;
    totalPrevValueInBase += prevVal * fx;
    totalCostInBase += cost * fx;
    totalProfitLossInBase += (mv - cost) * fx;
  }
  const totalChangePercent = totalPrevValueInBase > 0 ? (totalChangeInBase / totalPrevValueInBase) * 100 : 0;
  const cashTotalInBase = (cashBalances ?? []).reduce((sum, cb) => {
    const rate = fxRates[cb.currency?.toUpperCase() || 'GBP'] ?? 1;
    const baseRate = fxRates[baseCurrency] ?? 1;
    return sum + cb.balance * (rate / baseRate);
  }, 0);
  const totalPortfolioValue = totalMarketValueInBase + cashTotalInBase;

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-1 sm:mb-2">
  <h2 className={`${THEME_BLUE_TEXT} text-l font-bold flex items-center gap-2`}>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={`portfolio-table-${portfolio.id}`}
            onClick={() => setExpanded((e) => !e)}
            className="inline-flex items-center justify-center w-5 h-5 rounded border border-themeblue text-themeblue bg-white active:scale-[.97]"
            title={expanded ? 'Collapse to totals' : 'Expand to show assets'}
          >
            <span
              className={`transition-transform duration-150 inline-block ${expanded ? 'rotate-90' : ''}`}
              aria-hidden="true"
            >
              ▶
            </span>
          </button>
          <span>{portfolio.name}</span>
        </h2>
        <div className="flex items-center gap-3">
          {!expanded && (
            <span className="text-xs text-gray-500">{holdings.length} asset{holdings.length === 1 ? '' : 's'}</span>
          )}
          <a
            href={`/transactions?portfolio=${portfolio.id}`}
            className="text-xs text-themeblue hover:underline"
            aria-label={`View transactions for ${portfolio.name}`}
          >
            Transactions
          </a>
        </div>
      </div>

      <div className="flex items-center justify-between mb-1 sm:mb-2">
        <div className="sm:hidden text-xs text-gray-500">{showAllColumns ? 'All columns shown' : 'Compact view'}</div>
        {expanded && (
          <button
            type="button"
            onClick={() => setShowAllColumns(s => !s)}
            className="sm:hidden text-xs px-2 py-1 rounded border border-themeblue text-themeblue font-semibold bg-white active:scale-[.97]"
          >
            {showAllColumns ? 'Collapse columns' : 'Expand columns'}
          </button>
        )}
      </div>

      <div
        ref={scrollRef}
        className="overflow-x-auto rounded border bg-white/50 dark:bg-transparent relative"
        onScroll={(e)=> setScrolled(e.currentTarget.scrollLeft>0)}
      >
        {expanded && hasOverflow && scrolled && <div className="pointer-events-none absolute left-0 top-0 h-full w-4 bg-gradient-to-r from-black/25 to-transparent" />}
  <table id={`portfolio-table-${portfolio.id}`} className="w-full text-sm">
          {expanded && (
          <thead className="bg-themeblue text-white font-semibold border-b-2 border-themeblue-hover">
            <tr>
              <th scope="col" className="text-left p-1 sticky left-0 z-20 bg-themeblue">Company</th>
              <th scope="col" className="text-right">Market Price</th>
              <th scope="col" className="text-right">Change</th>
              <th scope="col" className={`text-right ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>Units</th>
              <th scope="col" className={`text-right ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>Cost</th>
              <th scope="col" className="text-right">
                <div className="inline-flex items-center gap-2 justify-end">
                  <span
                    className={`font-bold px-1 rounded min-w-[3.2rem] text-white select-none ${
                      sortColumn === 'marketValue' ? 'underline' : ''
                    }`}
                    title="Market (sorting controlled from Total Holdings table)"
                  >
                    Market
                  </span>
                  <span
                    className={`font-bold px-1 rounded min-w-[2.4rem] text-white select-none ${
                      sortColumn === 'unrealisedValue' ? 'underline' : ''
                    }`}
                    title="Unrealised (sorting controlled from Total Holdings table)"
                  >
                    +-
                  </span>
                </div>
              </th>
              <th scope="col" className={`text-center ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>R. Value</th>
            </tr>
          </thead>
          )}

          {expanded && (
          <tbody>
            {sortedHoldings.map((h) => {
              const p = prices[h.ticker];
              const price = p?.price ?? 0;
              const previousClose = p?.previous_close ?? 0;
              const multiplier = p?.price_multiplier ?? 1;
              const hasPrev = previousClose > 0;
              const safePrev = hasPrev ? previousClose : price;
              const marketValue = h.total_shares * price * multiplier;
              const totalCost = h.total_cost;
              const profitLoss = marketValue - totalCost;
              const change = (price - safePrev) * multiplier;
              const changePercent = hasPrev ? (change / (previousClose * multiplier)) * 100 : 0;
              const changeValue = change * h.total_shares;
              return (
                <tr key={h.asset_id} className="border-t text-s align-middle">
                  <td className="p-1 align-middle sticky left-0 z-10 bg-white">
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
                  <td className="p-1 text-right align-top">
                    <div className="font-semibold text-gray-900" title={hasPrev ? undefined : 'No prior close – change suppressed'}>
                      {formatCurrency(price * multiplier, h.currency)}
                    </div>
                    <div className="mt-1 whitespace-nowrap flex items-center justify-end gap-2">
                      {hasPrev ? (
                        <>
                          <span className={`font-bold ${change < 0 ? 'text-red-600' : change > 0 ? 'text-green-600' : 'text-gray-400'}`}>
                            {formatCurrency(Math.abs(change), h.currency)}
                          </span>
                          {changePercent !== 0 && (
                            <span className={changePercent < 0 ? NEGATIVE_BADGE : POSITIVE_BADGE}>
                              {Math.abs(changePercent).toFixed(2)}%
                            </span>
                          )}
                        </>
                      ) : (
                        <span
                          className="text-xs text-gray-400 cursor-help"
                          title="No prior close available – daily change suppressed"
                        >
                          n/a
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={`p-1 text-right align-middle font-bold text-lg ${hasPrev && changeValue !== 0 ? (changeValue > 0 ? POSITIVE_TEXT : NEGATIVE_TEXT) : 'text-gray-300'}`} title={hasPrev ? (changeValue === 0 ? 'No net change' : undefined) : 'No prior close – change suppressed'}>
                    {hasPrev && changeValue !== 0
                      ? formatCurrency(
                          Math.round(Math.abs(changeValue)),
                          h.currency
                        ).replace(/\.00$/, '')
                      : ''}
                  </td>
                  <td className={`${THEME_BLUE_TEXT} p-1 text-right align-middle font-bold text-lg ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>
                    {displayUnits(h.total_shares)}
                  </td>
                  <td className={`${THEME_BLUE_TEXT} p-1 text-right font-bold align-top ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>
                    <div>{formatCurrency(h.avg_price, h.currency)}</div>
                    <div className="text-s font-bold mt-1">
                      <span className="bg-Thoverlight-tint rounded px-1">{formatCurrency(totalCost, h.currency)}</span>
                    </div>
                  </td>
                  <td className="p-1 text-right align-top">
                    <span className={marketValue > totalCost ? POSITIVE_BADGE : NEGATIVE_BADGE}>
                      {formatCurrency(marketValue, h.currency)}
                    </span>
                    {profitLoss !== 0 && (
                      <div className={`mt-1 font-semibold pr-1 ${profitLoss > 0 ? POSITIVE_TEXT : NEGATIVE_TEXT}`}>
                        {formatCurrency(profitLoss, h.currency)}
                      </div>
                    )}
                  </td>
                  <td className={`p-1 text-center font-bold align-top ${showAllColumns ? '' : 'hidden sm:table-cell'} ${h.realised_value === 0 ? '' : h.realised_value > 0 ? POSITIVE_TEXT : NEGATIVE_TEXT}`}>
                    {h.realised_value === 0 ? '' : formatCurrency(h.realised_value, h.currency)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          )}

          <tfoot>
            <tr className={`${THEME_BLUE_DISABLED_BG} row-compact font-semibold border-t text-base`}>
              <td className="p-1 text-right" colSpan={2}>TOTAL ASSETS</td>
              <td className="p-1 text-right font-bold">
                <span className={totalChangeInBase >= 0 ? 'text-[var(--color-tgreen)]' : 'text-[var(--color-tred)]'}>
                  {formatCurrency(Math.abs(totalChangeInBase), baseCurrency)}
                </span>
              </td>
              <td className="p-1 text-left">
                {totalChangePercent !== 0 ? (
                  <span className={`font-bold ${totalChangePercent > 0 ? 'text-[var(--color-tgreen)]' : 'text-[var(--color-tred)]'}`}>
                    {totalChangePercent > 0 ? '+' : ''}
                    {Math.abs(totalChangePercent).toFixed(2)}%
                  </span>
                ) : (
                  <span className="text-gray-400">–</span>
                )}
              </td>
              <td className="p-1 text-right">{formatCurrency(totalCostInBase, baseCurrency)}</td>
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
            {cashBalances && cashBalances.length > 0 && (
              <tr className={`${THEME_BLUE_TEXT} row-compact font-semibold border-t text-base`}>
                <td className="p-1 text-right" colSpan={2}>AVAILABLE CASH</td>
                <td colSpan={3}></td>
                <td className="p-1 text-right">{formatCurrency(cashTotalInBase, baseCurrency)}</td>
                <td className="p-1 text-left text-xs">
                  {baseCurrency !== 'GBP' ? `(${formatCurrency(cashTotalInBase * (fxRates[baseCurrency] ? (fxRates['GBP'] ?? 1)/(fxRates[baseCurrency] || 1) : 1), 'GBP')})` : ''}
                </td>
              </tr>
            )}
            <tr className={`${THEME_BLUE_DISABLED_BG} font-bold border-t text-right text-base`}>
              <td className="p-1 text-right" colSpan={2}>TOTAL PORTFOLIO VALUE</td>
              <td colSpan={3}></td>
              <td className="p-1 text-right">{formatCurrency(totalPortfolioValue, baseCurrency)}</td>
              <td className="p-1 text-left text-xs">
                {baseCurrency !== 'GBP' ? `(${formatCurrency(totalPortfolioValue * (fxRates[baseCurrency] ? (fxRates['GBP'] ?? 1)/(fxRates[baseCurrency] || 1) : 1), 'GBP')})` : ''}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      
    </div>
  );
}
