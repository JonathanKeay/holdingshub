'use client';

import { useEffect, useMemo, useState } from 'react';
import { LogoWithFallback } from '@/components/LogoWithFallback';
import { formatCurrency } from '@/lib/formatCurrency';
import type { Holding } from '@/lib/queries';

// ---- Theme hook-up ----
type Theme = {
  toolbarWrap: string;      // container around controls
  button: string;           // normal button
  buttonHover: string;      // hover state
  ghostButton: string;      // subtle/outline button
  ghostButtonHover: string;
  subtleNote: string;       // small helper text
  hiddenRow: string;        // style applied to a hidden portfolio block
  chipPositive: string;     // small positive chip (if you want)
  chipNegative: string;     // small negative chip (if you want)
};

// sensible defaults if you don’t pass one
const defaultTheme: Theme = {
  toolbarWrap: 'flex items-center gap-2 mb-3',
  button: 'px-3 py-1 border rounded text-sm',
  buttonHover: 'hover:bg-gray-100',
  ghostButton: 'px-2 py-1 border rounded text-xs',
  ghostButtonHover: 'hover:bg-gray-100',
  subtleNote: 'text-xs text-gray-500 ml-2',
  hiddenRow: 'opacity-60',
  chipPositive: 'text-green-600 bg-green-100',
  chipNegative: 'text-red-600 bg-red-100',
};

type FxRates = Record<string, number>;
type PriceMap = Record<
  string,
  { price: number; price_multiplier: number; previous_close?: number; updated_at?: string }
>;

type Portfolio = {
  id: string;
  name: string;
  base_currency?: 'GBP' | 'USD' | 'EUR' | null;
};

type CashBalance = { currency: string; balance: number };

type PortfolioBlock = {
  portfolio: Portfolio;
  holdings: Holding[];
  cash_balances?: CashBalance[] | null;
};

const ORDER_KEY = 'portfolio-order-v1';
const HIDDEN_KEY = 'portfolio-hidden-v1';

export default function PortfolioList({
  portfolios,
  prices,
  fxRates,
  theme = defaultTheme,
}: {
  portfolios: PortfolioBlock[];
  prices: PriceMap;
  fxRates: FxRates;
  theme?: Theme;
}) {
  const [editMode, setEditMode] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  // Initialise order and hidden sets from localStorage
  const initialOrder = useMemo<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
      if (Array.isArray(saved) && saved.every((s) => typeof s === 'string')) return saved;
    } catch {}
    return portfolios.map((p) => p.portfolio.id);
  }, [portfolios]);

  const [order, setOrder] = useState<string[]>(initialOrder);
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
      if (Array.isArray(saved)) return new Set(saved as string[]);
    } catch {}
    return new Set<string>();
  });

  // Persist
  useEffect(() => {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  }, [order]);

  useEffect(() => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(Array.from(hidden)));
  }, [hidden]);

  // Keep order in sync with any new/removed portfolios
  useEffect(() => {
    const ids = portfolios.map((p) => p.portfolio.id);
    setOrder((prev) => {
      const seen = new Set(prev);
      const appended = ids.filter((id) => !seen.has(id));
      const filtered = prev.filter((id) => ids.includes(id));
      return [...filtered, ...appended];
    });
  }, [portfolios]);

  const orderedBlocks = order
    .map((id) => portfolios.find((p) => p.portfolio.id === id))
    .filter(Boolean) as PortfolioBlock[];

  function move(id: string, dir: -1 | 1) {
    setOrder((curr) => {
      const idx = curr.indexOf(id);
      if (idx < 0) return curr;
      const j = idx + dir;
      if (j < 0 || j >= curr.length) return curr;
      const next = curr.slice();
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }

  function toggleHidden(id: string) {
    setHidden((curr) => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function resetOrder() {
    const fresh = portfolios.map((p) => p.portfolio.id);
    setOrder(fresh);
  }

  return (
    <div>
      {/* Toolbar — inherits theme */}
      <div className={theme.toolbarWrap}>
        <button
          onClick={() => setEditMode((v) => !v)}
          className={`${theme.button} ${theme.buttonHover}`}
        >
          {editMode ? 'Done editing' : 'Edit layout'}
        </button>
        <button
          onClick={() => setShowHidden((v) => !v)}
          className={`${theme.button} ${theme.buttonHover}`}
        >
          {showHidden ? 'Hide hidden' : 'Show hidden'}
        </button>
        <button
          onClick={resetOrder}
          className={`${theme.button} ${theme.buttonHover}`}
          title="Restore natural order"
        >
          Reset order
        </button>
        <span className={theme.subtleNote}>
          Order & hidden state are saved on this device.
        </span>
      </div>

      {/* Portfolios (exact table markup from your page, themed by your classes) */}
      {orderedBlocks.map(({ portfolio, holdings, cash_balances }) => {
        const id = portfolio.id;
        const isHidden = hidden.has(id);
        if (isHidden && !showHidden) return null;

        const baseCurrency = (portfolio.base_currency || 'GBP') as 'GBP' | 'USD' | 'EUR';
        const isISA = /\bISA\b/i.test(portfolio.name);

        // === Totals (same as your page.tsx) ===
        const totalCostInBase = holdings.reduce((sum, h) => {
          const rate = fxRates[h.currency?.toUpperCase() || 'GBP'] ?? 1;
          const baseRate = fxRates[baseCurrency] ?? 1;
          return sum + h.total_cost * (rate / baseRate);
        }, 0);

        const totalMarketValueInBase = holdings.reduce((sum, h) => {
          const price = prices[h.ticker]?.price ?? 0;
          const multiplier = prices[h.ticker]?.price_multiplier ?? 1;
          const rate = fxRates[h.currency?.toUpperCase() || 'GBP'] ?? 1;
          const baseRate = fxRates[baseCurrency] ?? 1;
          return sum + h.total_shares * price * multiplier * (rate / baseRate);
        }, 0);

        const totalProfitLossInBase = totalMarketValueInBase - totalCostInBase;

        const cashTotalInBase =
          cash_balances?.reduce((sum, cb) => {
            const cashRate = fxRates[cb.currency?.toUpperCase() || 'GBP'] ?? 1;
            const baseRate = fxRates[baseCurrency] ?? 1;
            return sum + cb.balance * (cashRate / baseRate);
          }, 0) ?? 0;

        const totalPortfolioValue = totalMarketValueInBase + cashTotalInBase;

        return (
          <div key={id} className={`mb-8 ${isHidden ? theme.hiddenRow : ''}`}>
            {/* Row header with controls (kept minimal, themed buttons) */}
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-l font-semibold">{portfolio.name}</h2>

              {editMode && (
                <div className="flex items-center gap-2">
                  <button
                    className={`${theme.ghostButton} ${theme.ghostButtonHover}`}
                    onClick={() => move(id, -1)}
                    aria-label="Move up"
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    className={`${theme.ghostButton} ${theme.ghostButtonHover}`}
                    onClick={() => move(id, 1)}
                    aria-label="Move down"
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button
                    className={`${theme.ghostButton} ${theme.ghostButtonHover}`}
                    onClick={() => toggleHidden(id)}
                  >
                    {isHidden ? 'Unhide' : 'Hide'}
                  </button>
                </div>
              )}
            </div>

            {/* ==== BEGIN: your original per-portfolio table ==== */}
            <table className="w-full text-sm border">
              <thead className="bg-gray-100">
                <tr>
                  <th className="text-left p-1">logo</th>
                  <th className="text-left p-1">Ticker<br />Co. Name</th>
                  <th className="text-right p-1">Market Price<br />VAR</th>
                  <th className="text-right p-1">units</th>
                  <th className="text-right p-1">Unit cost<br />Total Cost</th>
                  <th className="text-right p-1">Market Value</th>
                  <th className="text-right p-1">R. Value</th>
                  <th className="text-right p-1">UR. Value</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => {
                  const price = prices[h.ticker]?.price ?? 0;
                  const previousClose = prices[h.ticker]?.previous_close ?? 0;
                  const multiplier = prices[h.ticker]?.price_multiplier ?? 1;
                  const marketValue = h.total_shares * price * multiplier;
                  const totalCost = h.total_cost;
                  const profitLoss = marketValue - totalCost;
                  const change = (price - previousClose) * multiplier;
                  const changePercent =
                    previousClose > 0 ? (change / (previousClose * multiplier)) * 100 : 0;

                  return (
                    <tr key={h.asset_id} className="border-t text-s align-top">
                      <td className="p-1 align-top">
                        {h.logo_url && (
                          <LogoWithFallback
                            src={h.logo_url}
                            alt={`${h.ticker} logo`}
                            className="h-8 w-8 rounded bg-white border"
                          />
                        )}
                      </td>
                      <td className="p-1 align-top">
                        <div className="font-bold">{h.ticker}</div>
                        <div className="text-xs text-gray-500">
                          {h.company_name || h.ticker}
                        </div>
                      </td>
                      <td className="p-1 text-right align-top">
                        <div className="font-semibold">
                          {formatCurrency(price * multiplier, h.currency)}
                        </div>
                        <div>
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-xs mt-1
                              ${
                                change < 0
                                  ? 'bg-red-600 text-white'
                                  : change > 0
                                  ? 'bg-green-600 text-white'
                                  : 'bg-gray-200 text-gray-700'
                              }`}
                          >
                            {change > 0 ? '+' : ''}
                            {change.toFixed(2)}{' '}
                            {changePercent !== 0 && (
                              <>
                                ({changePercent > 0 ? '+' : ''}
                                {changePercent.toFixed(2)}%)
                              </>
                            )}
                          </span>
                        </div>
                      </td>
                      <td className="p-1 text-right align-top">
                        {h.total_shares.toFixed(1)}
                      </td>
                      <td className="p-1 text-right align-top">
                        <div>{formatCurrency(h.avg_price, h.currency)}</div>
                        <div className="text-xs text-gray-500">
                          {formatCurrency(totalCost, h.currency)}
                        </div>
                      </td>
                      <td className="p-1 text-right align-top">
                        <span
                          className={`inline-block rounded px-1 font-bold ${
                            marketValue > totalCost
                              ? 'text-green-600 bg-green-100'
                              : 'text-red-600 bg-red-100'
                          }`}
                        >
                          {formatCurrency(marketValue, h.currency)}
                        </span>
                      </td>
                      <td
                        className={`p-1 text-right align-top ${
                          h.realised_value === 0
                            ? ''
                            : h.realised_value! > 0
                            ? 'text-green-600'
                            : 'text-red-600'
                        }`}
                      >
                        {h.realised_value === 0
                          ? ''
                          : formatCurrency(h.realised_value!, h.currency)}
                      </td>
                      <td
                        className={`p-1 text-right align-top font-semibold ${
                          profitLoss >= 0 ? 'text-green-600' : 'text-red-600'
                        }`}
                      >
                        {profitLoss === 0
                          ? ''
                          : formatCurrency(profitLoss, h.currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="font-semibold border-t bg-gray-50 text-s">
                  <td className="p-1 text-left">TOTALS (in {baseCurrency})</td>
                  <td colSpan={2}></td>
                  <td className="p-1 text-right">
                    {formatCurrency(totalCostInBase, baseCurrency)}
                  </td>
                  <td></td>
                  <td className="p-1 text-right">
                    {formatCurrency(totalMarketValueInBase, baseCurrency)}
                  </td>
                  <td className="p-1 text-right">
                    {formatCurrency(
                      holdings.reduce((sum, h) => {
                        const rate = fxRates[h.currency?.toUpperCase() || 'GBP'] ?? 1;
                        const baseRate = fxRates[baseCurrency] ?? 1;
                        return sum + (h.realised_value ?? 0) * (rate / baseRate);
                      }, 0),
                      baseCurrency
                    )}
                  </td>
                  <td className="p-1 text-right">
                    {formatCurrency(totalProfitLossInBase, baseCurrency)}
                  </td>
                </tr>

                {cash_balances?.length ? (
                  <>
                    <tr className="font-semibold border-t bg-yellow-50 text-s">
                      <td className="p-1 text-left">
                        {isISA
                          ? 'AVAILABLE CASH (GBP – ISA, auto-converted)'
                          : `AVAILABLE CASH (in ${baseCurrency})`}
                      </td>
                      <td colSpan={4}></td>
                      <td className="p-1 text-right">
                        {formatCurrency(cashTotalInBase, baseCurrency)}
                      </td>
                      <td colSpan={2}></td>
                    </tr>
                    {!isISA && (
                      <tr className="text-xs text-gray-600">
                        <td className="p-1 text-left">Cash breakdown</td>
                        <td colSpan={7} className="p-1 text-right">
                          {cash_balances.map((cb) => {
                            const sym =
                              cb.currency === 'GBP'
                                ? '£'
                                : cb.currency === 'USD'
                                ? '$'
                                : '€';
                            return (
                              <span key={cb.currency} className="ml-3">
                                {cb.currency}: {sym}
                                {cb.balance.toFixed(2)}
                              </span>
                            );
                          })}
                        </td>
                      </tr>
                    )}
                  </>
                ) : null}

                <tr className="font-bold border-t bg-green-50 text-s">
                  <td className="p-1 text-left">
                    TOTAL PORTFOLIO VALUE (in {baseCurrency})
                  </td>
                  <td colSpan={4}></td>
                  <td className="p-1 text-right text-green-800">
                    {formatCurrency(totalPortfolioValue, baseCurrency)}
                  </td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            </table>
            {/* ==== END: your original per-portfolio table ==== */}

            <div className="text-right mt-1">
              <a
                href={`/transactions?portfolio=${portfolio.id}`}
                className="text-gray-400 text-sm hover:underline"
              >
                Transactions
              </a>
            </div>
          </div>
        );
      })}
    </div>
  );
}
