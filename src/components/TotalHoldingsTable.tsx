'use client';

import { useState } from 'react';
import { LogoWithFallback } from '@/components/LogoWithFallback';
import { TickerFallbackIcon } from '@/components/TickerFallbackIcon';
import { formatCurrency } from '@/lib/formatCurrency';
import type { Holding } from '@/lib/queries';
import { TUp, TDn } from '@/components/icons';
import {
  THEME_BLUE_DISABLED_ROW,
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
  const [sortColumn, setSortColumn] = useState<
    'marketValue' | 'units' | 'totalCost' | 'unrealisedValue' | 'change' | null
  >(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  // initialise local toggle from optional prop so parent can set default
  const [showGBPState, setShowGBP] = useState<boolean>(Boolean(showGBP ?? false));

  function handleSort(column: typeof sortColumn) {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
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
          const price = prices[h.ticker]?.price ?? 0;
          const prev = prices[h.ticker]?.previous_close ?? 0;
          const multiplier = prices[h.ticker]?.price_multiplier ?? 1;
          return (price - prev) * multiplier * h.total_shares;
        default:
          return 0;
      }
    };
    return dir * (getValue(a) - getValue(b));
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

      <table className="w-full text-sm border">
        <thead className="bg-themeblue text-white font-semibold border-b-2 border-themeblue-hover">
          <tr>
            <th className="text-left p-1">Company</th>
            <th className="text-center p-1 w-6"><span>&nbsp;</span></th>
            <th className="text-right p-1">Market Price</th>
            <th onClick={() => handleSort('change')} className="text-right p-1 cursor-pointer">
              <span className="inline-flex items-center">
                <span className="mr-1 text-xs font-bold">
                  {sortColumn === 'change'
                    ? sortDirection === 'asc'
                      ? '▲'
                      : '▼'
                    : '▲▼'}
                </span>
                Change
              </span>
            </th>
            <th onClick={() => handleSort('units')} className="text-right p-1 cursor-pointer">
              <span className="inline-flex items-center">
                <span className="mr-1 text-xs font-bold">
                  {sortColumn === 'units'
                    ? sortDirection === 'asc'
                      ? '▲'
                      : '▼'
                    : '▲▼'}
                </span>
                Units
              </span>
            </th>
            <th onClick={() => handleSort('totalCost')} className="text-right p-1 cursor-pointer">
              <span className="inline-flex items-center">
                <span className="mr-1 text-xs font-bold">
                  {sortColumn === 'totalCost'
                    ? sortDirection === 'asc'
                      ? '▲'
                      : '▼'
                    : '▲▼'}
                </span>
                Cost
              </span>
            </th>
            <th onClick={() => handleSort('unrealisedValue')} className="text-right p-1 cursor-pointer">
              <span className="inline-flex items-center">
                <span className="mr-1 text-xs font-bold">
                  {sortColumn === 'unrealisedValue'
                    ? sortDirection === 'asc'
                      ? '▲'
                      : '▼'
                    : '▲▼'}
                </span>
                Value
              </span>
            </th>
            <th className="text-center p-1">R. Value</th>
          </tr>
        </thead>
        <tbody>
          {sortedHoldings.map((h) => {
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
              <tr key={h.asset_id} className="border-t text-s align-top">
                <td className="p-1 align-top" style={{ minWidth: 50 }}>
                  <div className="flex items-center">
                    {h.logo_url ? (
                      <img
                        src={h.logo_url}
                        alt={`${h.ticker} logo`}
                        className="h-10 w-10 rounded bg-white border mr-2"
                      />
                    ) : (
                      <TickerFallbackIcon ticker={h.ticker} />
                    )}
                    <div>
                      <div className={`${THEME_BLUE_TEXT} font-bold`}>{h.ticker}</div>
                      <div className={`${THEME_LBLUE_TEXT} text-xs`}>{h.company_name || h.ticker}</div>
                    </div>
                  </div>
                </td>

                <td className="align-middle text-right">
                  {change > 0 ? (
                    <TUp className="text-tgreen w-6 h-6 mx-auto" />
                  ) : change < 0 ? (
                    <TDn className="text-tred w-6 h-6 mx-auto" />
                  ) : null}
                </td>

                {/* Market Price & Change */}
                <td className="p-1 text-right align-top">
                  <div className="font-semibold">
                    {formatCurrency(
                      maybeConvert(price * multiplier, h.currency),
                      showGBPState ? 'GBP' : h.currency
                    )}
                  </div>
                  <div className="mt-1 whitespace-nowrap">
                    <span
                      className={
                        change < 0 ? 'text-tred font-bold' : change > 0 ? 'text-tgreen font-bold' : ''
                      }
                    >
                      {formatCurrency(
                        Math.abs(maybeConvert(change, h.currency)),
                        showGBPState ? 'GBP' : h.currency
                      )}
                    </span>
                    {changePercent !== 0 ? (
                      <span
                        className={`px-2 py-0.5 rounded text-s font-semibold ${
                          changePercent < 0 ? 'text-tred bg-tred-bg' : 'text-tgreen bg-tgreen-bg'
                        }`}
                      >
                        {Math.abs(changePercent).toFixed(2)}%
                      </span>
                    ) : null}
                  </div>
                </td>

                {/* Cash Day Change */}
                <td
                  className={`p-1 text-right align-middle font-bold text-lg rounded ${
                    changeValue === 0
                      ? ''
                      : changeValue > 0
                      ? 'text-tgreen'
                      : 'text-tred'
                  }`}
                >
                  {changeValue === 0
                    ? null
                    : formatCurrency(
                        Math.round(Math.abs(maybeConvert(changeValue, h.currency))),
                        showGBPState ? 'GBP' : h.currency
                      ).replace(/\.00$/, '')}
                </td>

                <td className="p-1 text-right align-middle font-bold text-lg">
                  {h.total_shares.toFixed(0)}
                </td>

                <td className="p-1 text-right align-top">
                  <div>
                    {(() => {
                      const unitCostNative = h.total_shares ? h.total_cost / h.total_shares : h.avg_price; // asset currency
                      const unitCostDisplay = toDisplay(unitCostNative, h.currency);
                      const totalCostDisplay = toDisplay(h.total_cost, h.currency);
                      const displayCcy = showGBPState ? 'GBP' : (h.currency || 'GBP');
                      return (
                        <>
                          <div className="font-semibold">
                            {formatCurrency(unitCostDisplay, displayCcy)}
                          </div>
                          <div className="text-s font-bold mt-1">
                            <span className="bg-Thoverlight-tint rounded px-1">
                              {formatCurrency(Math.round(totalCostDisplay), displayCcy).replace(/\.00$/, '')}
                            </span>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </td>

                <td className="p-1 text-right align-middle">
                  {marketValue !== 0 ? (
                    <div>
                      <span
                        className={`inline-block rounded px-1 font-bold ${
                          marketValue > totalCost ? 'text-tgreen bg-tgreen-bg' : 'text-tred bg-tred-bg'
                        }`}
                      >
                        {formatCurrency(
                          Math.round(Math.abs(maybeConvert(marketValue, h.currency))),
                          showGBPState ? 'GBP' : h.currency
                        ).replace(/\.00$/, '')}
                      </span>
                    </div>
                  ) : null}

                  {profitLoss !== 0 ? (
                    <div
                      className={`mt-1 font-semibold pr-1 ${
                        profitLoss > 0 ? 'text-tgreen' : 'text-tred'
                      }`}
                    >
                      {formatCurrency(
                        Math.round(Math.abs(maybeConvert(profitLoss, h.currency))),
                        showGBPState ? 'GBP' : h.currency
                      ).replace(/\.00$/, '')}
                    </div>
                  ) : null}
                </td>

                <td
                  className={`p-1 text-center font-semibold align-middle rounded ${
                    h.realised_value === 0
                      ? ''
                      : h.realised_value > 0
                      ? 'text-tgreen'
                      : 'text-tred'
                  }`}
                >
                  {h.realised_value === 0
                    ? null
                    : formatCurrency(maybeConvert(h.realised_value, h.currency), showGBPState ? 'GBP' : h.currency)}
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
          <tr className={`${THEME_BLUE_DISABLED_BG} font-extrabold border-t text-base`}>
            <td className="p-1 text-right" colSpan={3}>ALL PORTFOLIO TOTAL VALUE</td>
            <td colSpan={3}></td>
            <td className={`p-1 text-right ${THEME_BLUE_TEXT}`}>{formatCurrency(Math.round(grandTotalGBP), 'GBP').replace(/\.00$/, '')}</td>
            <td colSpan={1}></td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
