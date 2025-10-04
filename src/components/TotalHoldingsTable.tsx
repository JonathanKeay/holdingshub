'use client';

import { useState, useEffect, useRef } from 'react';
import { LogoWithFallback } from '@/components/LogoWithFallback';
import { TickerFallbackIcon } from '@/components/TickerFallbackIcon';
import { formatCurrency } from '@/lib/formatCurrency';
import type { Holding } from '@/lib/queries';
import { TUp, TDn } from '@/components/icons';
import {
  THEME_BLUE_TEXT,
  THEME_LBLUE_TEXT,
  POSITIVE_TEXT,
  NEGATIVE_TEXT,
  THEME_BLUE_DISABLED_BG,
} from '@/lib/uiColors';

type PriceMap = Record<
  string,
  {
    price: number;
    price_multiplier: number;
    previous_close?: number;
  }
>;

export function TotalHoldingsTable({
  holdings,
  prices,
  fxRates,
  cashBalances,
  showGBP, // assume this prop exists / is passed
}: {
  holdings: Holding[];
  prices: PriceMap;
  fxRates: Record<string, number>;
  cashBalances?: { currency: string; balance: number }[];
  showGBP?: boolean;
}) {
  // Persist sort state across soft reloads (router.refresh) using localStorage
  type SortCol = 'marketValue' | 'units' | 'totalCost' | 'unrealisedValue' | 'change' | null;
  const SORT_STORAGE_KEY = 'totalHoldingsSortV1';
  const [sortColumn, setSortColumn] = useState<SortCol>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [hydrated, setHydrated] = useState(false);
  const userInteractedRef = useRef(false);
  const [scrolled, setScrolled] = useState(false); // horizontal scroll state for shadow
  const [hasOverflow, setHasOverflow] = useState(false);
  const [showAllColumns, setShowAllColumns] = useState(false); // mobile expand toggle
  const scrollRef = useRef<HTMLDivElement|null>(null);

  // Measure overflow
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => {
      if (!el) return;
      setHasOverflow(el.scrollWidth > el.clientWidth + 2); // tolerance
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    window.addEventListener('resize', check);
    return () => { window.removeEventListener('resize', check); ro.disconnect(); };
  }, []);

  // Load persisted sort AFTER mount (hydration-safe) without clobbering user clicks that happened very early.
  useEffect(() => {
    const load = () => {
      if (userInteractedRef.current) return; // user already clicked; do not override
      try {
        const raw = localStorage.getItem(SORT_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed?.column) setSortColumn(parsed.column as SortCol);
        if (parsed?.direction === 'asc' || parsed?.direction === 'desc') setSortDirection(parsed.direction);
      } catch {/* ignore */}
    };
    load();
    setHydrated(true);
    // Also listen for external updates (per-portfolio buttons, other tabs)
    const external = () => {
      try {
        const raw = localStorage.getItem(SORT_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (
          (parsed?.column ?? null) !== sortColumn ||
          (parsed?.direction === 'asc' ? 'asc' : 'desc') !== sortDirection
        ) {
          setSortColumn(parsed?.column ?? null);
          setSortDirection(parsed?.direction === 'asc' ? 'asc' : 'desc');
        }
      } catch {/* ignore */}
    };
    window.addEventListener('portfolioSortChanged', external);
    window.addEventListener('storage', external);
    return () => {
      window.removeEventListener('portfolioSortChanged', external);
      window.removeEventListener('storage', external);
    };
  }, []);

  // Persist any change immediately (even first) so subsequent tabs stay in sync.
  useEffect(() => {
    try {
      localStorage.setItem(
        SORT_STORAGE_KEY,
        JSON.stringify({ column: sortColumn, direction: sortDirection })
      );
      // Broadcast (per-portfolio tables listen)
      window.dispatchEvent(new CustomEvent('portfolioSortChanged'));
      // debug logging removed
    } catch {/* ignore */}
  }, [sortColumn, sortDirection]);
  // initialise local toggle from optional prop so parent can set default
  const [showGBPState, setShowGBP] = useState<boolean>(Boolean(showGBP ?? false));

  function handleSort(column: typeof sortColumn) {
    if (!column) return;
    userInteractedRef.current = true;
    if (sortColumn !== column) {
      setSortColumn(column);
      setSortDirection('desc');
  // debug logging removed
    } else {
      // fallback legacy toggle if header span clicked (should rarely occur now)
      const next = sortDirection === 'asc' ? 'desc' : 'asc';
      setSortDirection(next);
  // debug logging removed
    }
  }

  function setExplicitSort(column: SortCol, direction: 'asc' | 'desc') {
    if (!column) return;
    userInteractedRef.current = true;
    setSortColumn(column);
    setSortDirection(direction);
  // debug logging removed
  }

  // Helper: explicit fx rate from asset currency -> GBP (fallbacks to 1)
  function fxRateForCurrency(ccy?: string) {
    const key = (ccy || 'GBP').toUpperCase();
    return fxRates[key] ?? 1;
  }

  function convertToGBP(amount: number, fromCcy?: string) {
    return amount * fxRateForCurrency(fromCcy);
  }

  function toDisplay(amount: number, fromCcy?: string) {
    return showGBPState ? convertToGBP(amount, fromCcy) : amount;
  }

  function maybeConvert(value: number, fromCurrency: string) {
    // convert only when showing GBP; assume value is in fromCurrency (asset base)
    const rate = fxRateForCurrency(fromCurrency);
    return showGBPState ? value * rate : value;
  }

  function calcMarketValue(h: Holding, prices: PriceMap) {
    const price = prices[h.ticker]?.price ?? 0;
    const multiplier = prices[h.ticker]?.price_multiplier ?? 1;
    // price * multiplier is per-unit in asset currency; multiply by shares
    return price * multiplier * h.total_shares;
  }

  function calcUnrealisedValue(h: Holding, prices: PriceMap) {
    // ensure avg_price is derived from total_cost / total_shares (asset currency)
    const marketValue = calcMarketValue(h, prices);
    const cost = h.total_cost; // expected to be in asset currency
    return marketValue - cost;
  }

  function displayUnits(shares: number) {
    const rounded = Math.round(shares);
    // Pure integer -> show as integer
    if (Math.abs(shares - rounded) < 1e-8) return String(rounded);
    // Round to one decimal
    const oneDec = Math.round(shares * 10) / 10;
    const oneDecInt = Math.round(oneDec);
    // If rounding collapsed to an int, just show int
    if (Math.abs(oneDec - oneDecInt) < 1e-8) return String(oneDecInt);
    return oneDec.toFixed(1);
  }

  const sortedHoldings = [...holdings].sort((a, b) => {
    if (!sortColumn) {
      return (a.ticker || '').localeCompare(b.ticker || '');
    }
    const dir = sortDirection === 'asc' ? 1 : -1;
    const getValue = (h: Holding) => {
      switch (sortColumn) {
        case 'units':
          return h.total_shares;
        case 'totalCost':
          return h.total_cost;
        case 'unrealisedValue':
          return calcUnrealisedValue(h, prices);
        case 'marketValue':
          return calcMarketValue(h, prices);
        case 'change':
          // Use guarded change (treat missing / zero previous_close as 0 change so it doesn't dominate sort)
          const price = prices[h.ticker]?.price ?? 0;
          const prev = prices[h.ticker]?.previous_close ?? 0;
          if (prev <= 0) return 0; // suppress artificial large change
          const multiplier = prices[h.ticker]?.price_multiplier ?? 1;
          return (price - prev) * multiplier * h.total_shares;
        default:
          return 0;
      }
    };
    const diff = getValue(a) - getValue(b);
    if (diff !== 0) return dir * diff;
    // Direction-sensitive secondary sort so toggling visibly changes order even when primary values tie
    return dir * (a.ticker || '').localeCompare(b.ticker || '');
  });


  const totalCostAllGBP = sortedHoldings.reduce((sum, h) => {
    // treat h.total_cost as asset-base currency; convert to GBP using asset currency
    const rate = fxRateForCurrency(h.currency);
    return sum + h.total_cost * rate;
  }, 0);

  const totalMarketValueAllGBP = sortedHoldings.reduce((sum, h) => {
    const price = prices[h.ticker]?.price ?? 0;
    const multiplier = prices[h.ticker]?.price_multiplier ?? 1;
    const rate = fxRateForCurrency(h.currency);
    return sum + h.total_shares * price * multiplier * rate;
  }, 0);

  const totalRealisedAllGBP = sortedHoldings.reduce((sum, h) => {
    const rate = fxRateForCurrency(h.currency);
    return sum + (h.realised_value ?? 0) * rate;
  }, 0);

  const totalUnrealisedAllGBP = sortedHoldings.reduce((sum, h) => {
    const rate = fxRateForCurrency(h.currency);
    const marketValue = calcMarketValue(h, prices) * rate;
    const cost = h.total_cost * rate;
    return sum + (marketValue - cost);
  }, 0);

  const totalChangeValueGBP = sortedHoldings.reduce((sum, h) => {
    const price = prices[h.ticker]?.price ?? 0;
    const prev = prices[h.ticker]?.previous_close ?? 0;
    const multiplier = prices[h.ticker]?.price_multiplier ?? 1;
    const rate = fxRateForCurrency(h.currency);
    if (prev <= 0) return sum; // ignore invalid previous close to avoid inflated totals
    const change = (price - prev) * multiplier;
    return sum + change * h.total_shares * rate;
  }, 0);

  const totalChangePercent =
    totalMarketValueAllGBP > 0
      ? (totalChangeValueGBP / totalMarketValueAllGBP) * 100
      : 0;

  const totalCashGBP =
    cashBalances?.reduce((sum, cb) => {
      const cashRate = fxRates[cb.currency?.toUpperCase() || 'GBP'] ?? 1;
      return sum + cb.balance * cashRate;
    }, 0) ?? 0;

  const grandTotalGBP = totalMarketValueAllGBP + totalCashGBP;

  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xl font-semibold text-themeblue">
          TOTAL HOLDINGS (All Portfolios)
        </h2>
        <button
          onClick={() => setShowGBP((prev) => !prev)}
          className={
            showGBPState
              ? "px-3 py-1 rounded text-sm bg-themeblue text-white hover:bg-themeblue-hover transition-colors"
              : "px-3 py-1 rounded text-sm border-2 border-themeblue text-themeblue font-semibold bg-white"
          }
        >
          Show values in {showGBPState ? 'native currency' : 'GBP'}
        </button>
      </div>

      <div className="flex items-center justify-between mb-1 sm:mb-2">
        <div className="sm:hidden text-xs text-gray-500">
          {showAllColumns ? 'All columns shown' : 'Compact view'}
        </div>
        <button
          type="button"
          onClick={() => setShowAllColumns(s => !s)}
          className="sm:hidden text-xs px-2 py-1 rounded border border-themeblue text-themeblue font-semibold bg-white active:scale-[.97]"
        >
          {showAllColumns ? 'Collapse columns' : 'Expand columns'}
        </button>
      </div>
      <div
        ref={scrollRef}
        className="overflow-x-auto rounded border bg-white/50 dark:bg-transparent relative"
        onScroll={(e) => setScrolled(e.currentTarget.scrollLeft > 0)}
      >
        {hasOverflow && scrolled && (
          <div className="pointer-events-none absolute left-0 top-0 h-full w-4 bg-gradient-to-r from-black/25 to-transparent transition-opacity" />
        )}
      <table className="w-full text-sm">
        <thead className="bg-themeblue text-white font-semibold border-b-2 border-themeblue-hover">
          <tr>
            <th scope="col" className="text-left p-1 sticky left-0 z-20 bg-themeblue">Company</th>
            <th scope="col" className={`text-center p-1 w-6 ${showAllColumns ? '' : 'hidden sm:table-cell'}`}><span>&nbsp;</span></th>
            <th scope="col" className="text-right p-1 whitespace-nowrap min-w-[110px]">Market Price</th>
            <th scope="col" className={`text-right p-1 ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>
              <div className="flex items-center justify-end gap-1">
                <span className="leading-none">Change</span>
                <div className="flex flex-col leading-none">
                  <button
                    type="button"
                    aria-label="Sort Change descending"
                    className={`text-[11px] ${sortColumn==='change' && sortDirection==='desc' ? 'text-white' : 'text-white/60 hover:text-white'}`}
                    onClick={() => setExplicitSort('change','desc')}
                  >▼</button>
                  <button
                    type="button"
                    aria-label="Sort Change ascending"
                    className={`text-[11px] ${sortColumn==='change' && sortDirection==='asc' ? 'text-white' : 'text-white/60 hover:text-white'}`}
                    onClick={() => setExplicitSort('change','asc')}
                  >▲</button>
                </div>
              </div>
            </th>
            <th scope="col" className={`text-right p-1 ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>
              <div className="flex items-center justify-end gap-1">
                <span className="leading-none">Units</span>
                <div className="flex flex-col leading-none">
                  <button aria-label="Sort Units descending" className={`text-[11px] ${sortColumn==='units' && sortDirection==='desc' ? 'text-white' : 'text-white/60 hover:text-white'}`} onClick={() => setExplicitSort('units','desc')}>▼</button>
                  <button aria-label="Sort Units ascending" className={`text-[11px] ${sortColumn==='units' && sortDirection==='asc' ? 'text-white' : 'text-white/60 hover:text-white'}`} onClick={() => setExplicitSort('units','asc')}>▲</button>
                </div>
              </div>
            </th>
            <th scope="col" className={`text-right p-1 ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>
              <div className="flex items-center justify-end gap-1">
                <span className="leading-none">Cost</span>
                <div className="flex flex-col leading-none">
                  <button aria-label="Sort Cost descending" className={`text-[11px] ${sortColumn==='totalCost' && sortDirection==='desc' ? 'text-white' : 'text-white/60 hover:text-white'}`} onClick={() => setExplicitSort('totalCost','desc')}>▼</button>
                  <button aria-label="Sort Cost ascending" className={`text-[11px] ${sortColumn==='totalCost' && sortDirection==='asc' ? 'text-white' : 'text-white/60 hover:text-white'}`} onClick={() => setExplicitSort('totalCost','asc')}>▲</button>
                </div>
              </div>
            </th>
            <th scope="col" className="text-right p-1">
              <div className="flex items-center justify-end gap-4">
                <div className="flex items-center gap-1">
                  <span className="leading-none">Market</span>
                    <div className="flex flex-col leading-none">
                      <button aria-label="Sort Market Value descending" className={`text-[11px] ${sortColumn==='marketValue' && sortDirection==='desc' ? 'text-white' : 'text-white/60 hover:text-white'}`} onClick={()=>setExplicitSort('marketValue','desc')}>▼</button>
                      <button aria-label="Sort Market Value ascending" className={`text-[11px] ${sortColumn==='marketValue' && sortDirection==='asc' ? 'text-white' : 'text-white/60 hover:text-white'}`} onClick={()=>setExplicitSort('marketValue','asc')}>▲</button>
                    </div>
                </div>
                <div className="flex items-center gap-1">
                  <span className="leading-none">+-</span>
                  <div className="flex flex-col leading-none">
                    <button aria-label="Sort Unrealised Value descending" className={`text-[11px] ${sortColumn==='unrealisedValue' && sortDirection==='desc' ? 'text-white' : 'text-white/60 hover:text-white'}`} onClick={()=>setExplicitSort('unrealisedValue','desc')}>▼</button>
                    <button aria-label="Sort Unrealised Value ascending" className={`text-[11px] ${sortColumn==='unrealisedValue' && sortDirection==='asc' ? 'text-white' : 'text-white/60 hover:text-white'}`} onClick={()=>setExplicitSort('unrealisedValue','asc')}>▲</button>
                  </div>
                </div>
              </div>
            </th>
            <th scope="col" className={`text-center p-1 ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>R. Value</th>
          </tr>
        </thead>
        <tbody>
          {sortedHoldings.map((h) => {
            const price = prices[h.ticker]?.price ?? 0;
            const previousClose = prices[h.ticker]?.previous_close ?? 0;
            const multiplier = prices[h.ticker]?.price_multiplier ?? 1;
            const hasPrev = previousClose > 0;
            const safePrev = hasPrev ? previousClose : price; // fallback suppresses inflated change
            const marketValue = h.total_shares * price * multiplier;
            const totalCost = h.total_cost;
            const profitLoss = marketValue - totalCost;
            const change = (price - safePrev) * multiplier;
            const changePercent = hasPrev ? (change / (previousClose * multiplier)) * 100 : 0;
            const changeValue = change * h.total_shares;
            return (
              <tr key={h.asset_id} className="border-t text-s align-top">
                {/* Company (sticky) */}
                <td className="p-1 align-top sticky left-0 z-10 bg-white" style={{ minWidth: 140 }}>
                  <div className="flex items-center">
                    {h.logo_url ? (
                      <img src={h.logo_url} alt={`${h.ticker} logo`} className="h-10 w-10 rounded bg-white border mr-2" />
                    ) : (
                      <TickerFallbackIcon ticker={h.ticker} />
                    )}
                    <div>
                      <div className={`${THEME_BLUE_TEXT} font-bold`}>{h.ticker}</div>
                      <div className={`${THEME_LBLUE_TEXT} text-xs`}>{h.company_name || h.ticker}</div>
                    </div>
                  </div>
                </td>
                {/* Arrow icon column (hidden on small) */}
                <td className={`align-middle text-right ${showAllColumns ? '' : 'hidden sm:table-cell'}`}>   
                  {hasPrev ? (
                    change > 0 ? (
                      <TUp className="text-tgreen w-6 h-6 mx-auto" />
                    ) : change < 0 ? (
                      <TDn className="text-tred w-6 h-6 mx-auto" />
                    ) : (
                      <span
                        className="w-6 h-6 inline-flex items-center justify-center text-gray-400 text-lg font-bold select-none"
                        title="No net change"
                        aria-label="No net change"
                      >•</span>
                    )
                  ) : (
                    <span
                      className="w-6 h-6 inline-flex items-center justify-center text-gray-400 text-lg font-bold cursor-help select-none"
                      title="No prior close available – daily change suppressed"
                      aria-label="No prior close"
                    >•</span>
                  )}
                </td>
                {/* Market Price & % change */}
                <td className="p-1 text-right align-top">
                  <div className="font-semibold">
                    {formatCurrency(maybeConvert(price * multiplier, h.currency), showGBPState ? 'GBP' : h.currency)}
                  </div>
                  <div className="mt-1 whitespace-nowrap">
                    {hasPrev ? (
                      <>
                        <span className={change < 0 ? 'text-tred font-bold' : change > 0 ? 'text-tgreen font-bold' : ''}>
                          {formatCurrency(Math.abs(maybeConvert(change, h.currency)), showGBPState ? 'GBP' : h.currency)}
                        </span>
                        {changePercent !== 0 && (
                          <span className={`px-2 py-0.5 rounded text-s font-semibold ${changePercent < 0 ? 'text-tred bg-tred-bg' : 'text-tgreen bg-tgreen-bg'}`}>
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
                {/* Day change value */}
                <td className={`p-1 text-right align-middle font-bold text-lg rounded ${hasPrev && changeValue !== 0 ? (changeValue > 0 ? 'text-tgreen' : 'text-tred') : ''}`}>
                  {hasPrev && changeValue !== 0 ? formatCurrency(Math.round(Math.abs(maybeConvert(changeValue, h.currency))), showGBPState ? 'GBP' : h.currency).replace(/\.00$/, '') : ''}
                </td>
                {/* Units */}
                <td className={`p-1 text-right align-middle font-bold text-lg ${showAllColumns ? '' : 'hidden sm:table-cell'}`}> 
                  {displayUnits(h.total_shares)}
                </td>
                {/* Cost */}
                <td className={`p-1 text-right align-top ${showAllColumns ? '' : 'hidden sm:table-cell'}`}> 
                  {(() => {
                    const unitCostNative = h.total_shares ? h.total_cost / h.total_shares : h.avg_price;
                    const unitCostDisplay = toDisplay(unitCostNative, h.currency);
                    const totalCostDisplay = toDisplay(h.total_cost, h.currency);
                    const displayCcy = showGBPState ? 'GBP' : (h.currency || 'GBP');
                    return (
                      <>
                        <div className="font-semibold">{formatCurrency(unitCostDisplay, displayCcy)}</div>
                        <div className="text-s font-bold mt-1">
                          <span className="bg-Thoverlight-tint rounded px-1">
                            {formatCurrency(Math.round(totalCostDisplay), displayCcy).replace(/\.00$/, '')}
                          </span>
                        </div>
                      </>
                    );
                  })()}
                </td>
                {/* Market value & unrealised */}
                <td className="p-1 text-right align-middle">
                  {marketValue !== 0 && (
                    <div>
                      <span className={`inline-block rounded px-1 font-bold ${marketValue > totalCost ? 'text-tgreen bg-tgreen-bg' : 'text-tred bg-tred-bg'}`}>
                        {formatCurrency(Math.round(Math.abs(maybeConvert(marketValue, h.currency))), showGBPState ? 'GBP' : h.currency).replace(/\.00$/, '')}
                      </span>
                    </div>
                  )}
                  {profitLoss !== 0 && (
                    <div className={`mt-1 font-semibold pr-1 ${profitLoss > 0 ? 'text-tgreen' : 'text-tred'}`}>
                      {formatCurrency(Math.round(Math.abs(maybeConvert(profitLoss, h.currency))), showGBPState ? 'GBP' : h.currency).replace(/\.00$/, '')}
                    </div>
                  )}
                </td>
                {/* Realised value */}
                <td className={`p-1 text-center font-semibold align-middle rounded ${showAllColumns ? '' : 'hidden sm:table-cell'} ${h.realised_value === 0 ? '' : h.realised_value > 0 ? 'text-tgreen' : 'text-tred'}`}>
                  {h.realised_value === 0 ? null : formatCurrency(Math.round(Math.abs(maybeConvert(h.realised_value, h.currency))), showGBPState ? 'GBP' : h.currency).replace(/\.00$/, '')}
                </td>
              </tr>
            );
          })}
        </tbody>

        <tfoot>
          {/* Totals row - full row background + coloured numbers inside */}
          <tr className={`${THEME_BLUE_DISABLED_BG} font-semibold border-t text-base`}>
            <td className="p-1 text-right" colSpan={3}>TOTALS</td>
            <td className={`p-1 text-right ${totalChangeValueGBP >= 0 ? POSITIVE_TEXT : NEGATIVE_TEXT}`}>
              £{Math.abs(Math.round(totalChangeValueGBP)).toLocaleString()}
            </td>
            <td className={`p-1 text-left ${totalChangeValueGBP >= 0 ? POSITIVE_TEXT : NEGATIVE_TEXT}`}>
              {totalChangeValueGBP === 0 ? '' : `${Math.abs(totalChangePercent).toFixed(1)}%`}
            </td>
            <td className="p-1 text-right">£{Math.round(totalCostAllGBP).toLocaleString()}</td>
            <td className={`p-1 text-right ${totalMarketValueAllGBP >= totalCostAllGBP ? POSITIVE_TEXT : NEGATIVE_TEXT}`}>
              £{Math.round(totalMarketValueAllGBP).toLocaleString()}
            </td>
            <td className={`p-1 text-left ${totalUnrealisedAllGBP >= 0 ? POSITIVE_TEXT : NEGATIVE_TEXT}`}>
              £{Math.round(totalUnrealisedAllGBP).toLocaleString()}
            </td>
          </tr>

          {/* Available cash row - themeblue text like per-portfolio */}
          {cashBalances && cashBalances.length > 0 ? (
            <tr className={`${THEME_BLUE_TEXT} row-compact font-semibold border-t text-base`}>
              <td className="p-1 text-right" colSpan={3}>AVAILABLE CASH</td>
              <td colSpan={3}></td>
              <td className="p-1 text-right">{formatCurrency(Math.round(totalCashGBP), 'GBP').replace(/\.00$/, '')}</td>
              <td colSpan={1}></td>
            </tr>
          ) : null}

          {/* Grand total row - blue background like per-portfolio footer */}
          <tr className={`${THEME_BLUE_DISABLED_BG} font-extrabold border-t text-base sticky bottom-0 z-10 bg-themeblue text-white`}>
            <td className="p-1 text-right" colSpan={3}>ALL PORTFOLIO TOTAL VALUE</td>
            <td colSpan={3}></td>
            <td className="p-1 text-right font-bold text-white">{formatCurrency(Math.round(grandTotalGBP), 'GBP').replace(/\.00$/, '')}</td>
            <td colSpan={1}></td>
          </tr>
        </tfoot>
  </table>
  </div>
    </section>
  );
}
