// ORCHESTRATION — getAllHoldingsAndCashSummary (Phase 0 safety net)
//
// Direct, deterministic tests of the Global (all-portfolio) orchestration in
// src/lib/queries.ts, using the minimal in-memory fake in ./fakeSupabase.ts.
// No database, no network: global fetch is replaced with a throwing stub.
//
// These pin CURRENT behaviour (docs/ACCOUNTING.md §9, §15 item 8).
//
// Paging is not re-tested here: this function uses the same private
// fetchAllTable helper as getPortfoliosWithHoldingsAndCash, whose paging is
// pinned in orchestration.portfolios.spec.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getAllHoldingsAndCashSummary, type Txn } from '../../src/lib/queries';
import { createFakeSupabase, type FakeRow } from './fakeSupabase';
import { makeTxn } from './helpers';

const ASSETS: FakeRow[] = [
  { id: 'a-vod', ticker: 'VOD.L', name: 'Vodafone', currency: 'GBP', logo_url: null, status: 'active' },
  { id: 'a-aapl', ticker: 'AAPL', name: 'Apple', currency: 'USD', logo_url: null, status: 'active' },
  { id: 'a-cash-gbp', ticker: 'CASH.GBP', name: 'Cash GBP', currency: 'GBP', logo_url: null, status: 'active' },
  { id: 'a-cash-usd', ticker: 'CASH.USD', name: 'Cash USD', currency: 'USD', logo_url: null, status: 'active' },
];

const PORTFOLIOS: FakeRow[] = [
  { id: 'p-gbp-1', name: 'ISA', base_currency: 'GBP' },
  { id: 'p-gbp-2', name: 'Trading', base_currency: 'GBP' },
  { id: 'p-usd', name: 'US book', base_currency: 'USD' },
];

function run(transactions: Txn[], opts?: { asOf?: string; errors?: Record<string, { message: string }> }) {
  const fake = createFakeSupabase(
    { portfolios: PORTFOLIOS, assets: ASSETS, transactions, transfers: [] },
    { errors: opts?.errors }
  );
  return getAllHoldingsAndCashSummary(fake.client, opts?.asOf ? { asOf: opts.asOf } : undefined);
}

const vodBuy = (portfolio_id: string, quantity: number, price: number, date = '2024-01-02') =>
  makeTxn({ portfolio_id, asset_id: 'a-vod', type: 'BUY', date, quantity, price, fee: 0, settle_value: quantity * price, settle_ccy: 'GBP', cash_value: quantity * price, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 });

// AAPL (USD asset) traded from a GBP portfolio (fx 0.8) or the USD portfolio (fx 1).
const aapl = (type: 'BUY' | 'SELL', portfolio_id: 'p-gbp-1' | 'p-usd', quantity: number, price: number, date: string) => {
  const usd = quantity * price;
  const inGbp = portfolio_id === 'p-gbp-1';
  return makeTxn({
    portfolio_id, asset_id: 'a-aapl', type, date, quantity, price, fee: 0,
    settle_value: usd, settle_ccy: 'USD',
    cash_value: inGbp ? usd * 0.8 : usd, cash_ccy: inGbp ? 'GBP' : 'USD', cash_fx_to_portfolio: inGbp ? 0.8 : 1,
  });
};

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network access is not allowed in orchestration tests');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getAllHoldingsAndCashSummary — blending', () => {
  it('the same ticker in two portfolios becomes ONE holding with combined shares and cost', async () => {
    const res = await run([vodBuy('p-gbp-1', 100, 10), vodBuy('p-gbp-2', 50, 12)]);
    expect(res.holdings).toHaveLength(1);
    const vod = res.holdings[0];
    expect(vod).toMatchObject({ ticker: 'VOD.L', total_shares: 150, total_cost: 1600, base_currency: 'GBP', base_total_cost: 1600, base_cost_reliable: true });
    expect(vod.avg_price).toBeCloseTo(1600 / 150, 10);
  });
});

describe('getAllHoldingsAndCashSummary — realised_ccy', () => {
  it.each([
    {
      label: 'single currency: realised activity only in GBP portfolios -> "GBP"',
      txns: () => [vodBuy('p-gbp-1', 100, 10), makeTxn({ portfolio_id: 'p-gbp-2', asset_id: 'a-vod', type: 'SELL', date: '2024-02-01', quantity: 40, price: 12, fee: 0, settle_value: 480, settle_ccy: 'GBP', cash_value: 480, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 })],
      ticker: 'VOD.L',
      expected: 'GBP',
    },
    {
      label: 'mixed: SELLs in a GBP and a USD portfolio -> "MIXED" (never a guessed single currency)',
      txns: () => [
        aapl('BUY', 'p-gbp-1', 10, 150, '2024-01-02'),
        aapl('BUY', 'p-usd', 10, 150, '2024-01-02'),
        aapl('SELL', 'p-gbp-1', 5, 160, '2024-02-01'),
        aapl('SELL', 'p-usd', 5, 160, '2024-02-01'),
      ],
      ticker: 'AAPL',
      expected: 'MIXED',
    },
    {
      label: 'no realised-affecting activity (BUYs only) -> unset',
      txns: () => [vodBuy('p-gbp-1', 100, 10), vodBuy('p-gbp-2', 50, 12)],
      ticker: 'VOD.L',
      expected: undefined,
    },
  ])('$label', async ({ txns, ticker, expected }) => {
    const res = await run(txns());
    expect(res.holdings.find((h) => h.ticker === ticker)!.realised_ccy).toBe(expected);
  });
});

describe('getAllHoldingsAndCashSummary — Definition B activation', () => {
  it('activates only for a ticker whose BUY/SELL/TIN/TOT portfolios share one base currency; a mixed-base ticker is left dormant', async () => {
    const res = await run([
      vodBuy('p-gbp-1', 100, 10),
      vodBuy('p-gbp-2', 50, 12),
      aapl('BUY', 'p-gbp-1', 10, 150, '2024-01-02'),
      aapl('BUY', 'p-usd', 10, 150, '2024-01-02'),
    ]);
    const vod = res.holdings.find((h) => h.ticker === 'VOD.L')!;
    const apl = res.holdings.find((h) => h.ticker === 'AAPL')!;

    expect(vod).toMatchObject({ base_currency: 'GBP', base_total_cost: 1600 });

    expect(apl.total_shares).toBe(20);
    expect(apl.total_cost).toBe(3000); // native ledger (USD), blended without conversion
    expect(apl.base_currency).toBeUndefined();
    expect(apl.base_total_cost).toBeUndefined();
    expect(apl.base_cost_reliable).toBeUndefined();
  });

  it('CURRENT behaviour: a FEE in a USD portfolio does not affect Definition B activation (not an open-cost type) but does set realised_ccy', async () => {
    const res = await run([
      aapl('BUY', 'p-gbp-1', 10, 150, '2024-01-02'),
      makeTxn({ portfolio_id: 'p-usd', asset_id: 'a-aapl', type: 'FEE', date: '2024-02-01', fee: 3, cash_value: 3, cash_ccy: 'USD' }),
    ]);
    const apl = res.holdings.find((h) => h.ticker === 'AAPL')!;
    expect(apl.base_currency).toBe('GBP');
    expect(apl.realised_ccy).toBe('USD');
    expect(apl.realised_value).toBe(-3);
  });
});

describe('getAllHoldingsAndCashSummary — cash', () => {
  it('aggregates cash by currency across every portfolio', async () => {
    const res = await run([
      makeTxn({ portfolio_id: 'p-gbp-1', asset_id: 'a-cash-gbp', type: 'DEP', date: '2024-01-01', cash_value: 1000, cash_ccy: 'GBP' }),
      makeTxn({ portfolio_id: 'p-gbp-2', asset_id: 'a-cash-gbp', type: 'DEP', date: '2024-01-01', cash_value: 500, cash_ccy: 'GBP' }),
      makeTxn({ portfolio_id: 'p-usd', asset_id: 'a-cash-usd', type: 'DEP', date: '2024-01-01', cash_value: 200, cash_ccy: 'USD' }),
      vodBuy('p-gbp-1', 10, 10),
    ]);
    expect(res.cash_balances).toEqual([
      { currency: 'GBP', balance: 1400 },
      { currency: 'USD', balance: 200 },
    ]);
  });
});

describe('getAllHoldingsAndCashSummary — transfers read failure', () => {
  it('throws instead of silently falling back to legacy TIN/TOT cost', async () => {
    const fake = createFakeSupabase(
      { portfolios: PORTFOLIOS, assets: ASSETS, transactions: [vodBuy('p-gbp-1', 1, 1)], transfers: [] },
      { errors: { transfers: { message: 'permission denied for table transfers' } } }
    );
    await expect(getAllHoldingsAndCashSummary(fake.client)).rejects.toThrow(/failed to read transfers — refusing to silently fall back/);
  });
});

describe('getAllHoldingsAndCashSummary — asOf', () => {
  const txns = () => [
    makeTxn({ portfolio_id: 'p-gbp-1', asset_id: 'a-cash-gbp', type: 'DEP', date: '2024-01-01', cash_value: 5000, cash_ccy: 'GBP' }),
    vodBuy('p-gbp-1', 100, 10, '2024-01-15'),
    vodBuy('p-gbp-2', 50, 10, '2024-06-15'),
    makeTxn({ portfolio_id: 'p-gbp-2', asset_id: 'a-cash-gbp', type: 'DEP', date: '2024-07-01', cash_value: 300, cash_ccy: 'GBP' }),
  ];

  it('excludes later transactions from both blended holdings and cash', async () => {
    const res = await run(txns(), { asOf: '2024-03-31' });
    expect(res.holdings.find((h) => h.ticker === 'VOD.L')).toMatchObject({ total_shares: 100, total_cost: 1000 });
    expect(res.cash_balances).toEqual([{ currency: 'GBP', balance: 4000 }]);
  });

  it('without asOf, every transaction is included', async () => {
    const res = await run(txns());
    expect(res.holdings.find((h) => h.ticker === 'VOD.L')).toMatchObject({ total_shares: 150, total_cost: 1500 });
    // 5000 - 1000 - 500 + 300
    expect(res.cash_balances).toEqual([{ currency: 'GBP', balance: 3800 }]);
  });
});
