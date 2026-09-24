// ORCHESTRATION — getPortfoliosWithHoldingsAndCash (Phase 0 safety net)
//
// Direct, deterministic tests of the per-portfolio orchestration in
// src/lib/queries.ts, using the minimal in-memory fake in ./fakeSupabase.ts.
// No database, no network: global fetch is replaced with a throwing stub for
// every test in this file.
//
// These pin CURRENT behaviour (docs/ACCOUNTING.md §7–§10, §15 item 8). Where a
// test pins something that looks questionable, it says so; that is not an
// endorsement of the behaviour.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getPortfoliosWithHoldingsAndCash, type Txn } from '../../src/lib/queries';
import { createFakeSupabase, type FakeRow } from './fakeSupabase';
import { makeTxn } from './helpers';

const ASSETS: FakeRow[] = [
  { id: 'a-vod', ticker: 'VOD.L', name: 'Vodafone', currency: 'GBP', logo_url: null, status: 'active' },
  { id: 'a-bp', ticker: 'BP.L', name: 'BP', currency: 'GBP', logo_url: null, status: 'active' },
  { id: 'a-xyz', ticker: 'XYZ.L', name: 'XYZ', currency: 'GBP', logo_url: null, status: 'active' },
  { id: 'a-abc', ticker: 'ABC.L', name: 'ABC', currency: 'GBP', logo_url: null, status: 'active' },
  { id: 'a-aapl', ticker: 'AAPL', name: 'Apple', currency: 'USD', logo_url: null, status: 'active' },
  { id: 'a-cash-gbp', ticker: 'CASH.GBP', name: 'Cash GBP', currency: 'GBP', logo_url: null, status: 'active' },
];

function run(tables: { portfolios: FakeRow[]; transactions: Txn[]; transfers?: FakeRow[] }, opts?: { asOf?: string; errors?: Record<string, { message: string }> }) {
  const fake = createFakeSupabase(
    { portfolios: tables.portfolios, assets: ASSETS, transactions: tables.transactions, transfers: tables.transfers ?? [] },
    { errors: opts?.errors }
  );
  return { fake, result: getPortfoliosWithHoldingsAndCash(fake.client, opts?.asOf ? { asOf: opts.asOf } : undefined) };
}

function holdingOf(result: Awaited<ReturnType<typeof getPortfoliosWithHoldingsAndCash>>, portfolioId: string, ticker: string) {
  return result.find((r) => r.portfolio.id === portfolioId)?.holdings.find((h) => h.ticker === ticker);
}

function cashOf(result: Awaited<ReturnType<typeof getPortfoliosWithHoldingsAndCash>>, portfolioId: string) {
  return result.find((r) => r.portfolio.id === portfolioId)?.cash_balances;
}

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network access is not allowed in orchestration tests');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getPortfoliosWithHoldingsAndCash — portfolio isolation', () => {
  it('the same ticker held in two portfolios produces two independent holdings and two independent cash balances', async () => {
    const { result } = run({
      portfolios: [
        { id: 'p1', name: 'ISA', base_currency: 'GBP' },
        { id: 'p2', name: 'Trading', base_currency: 'GBP' },
      ],
      transactions: [
        makeTxn({ portfolio_id: 'p1', asset_id: 'a-cash-gbp', type: 'DEP', date: '2024-01-01', cash_value: 5000, cash_ccy: 'GBP' }),
        makeTxn({ portfolio_id: 'p1', asset_id: 'a-vod', type: 'BUY', date: '2024-01-02', quantity: 100, price: 10, fee: 5, settle_value: 1005, settle_ccy: 'GBP', cash_value: 1005, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 }),
        makeTxn({ portfolio_id: 'p2', asset_id: 'a-cash-gbp', type: 'DEP', date: '2024-01-01', cash_value: 1000, cash_ccy: 'GBP' }),
        makeTxn({ portfolio_id: 'p2', asset_id: 'a-vod', type: 'BUY', date: '2024-01-03', quantity: 50, price: 12, fee: 0, settle_value: 600, settle_ccy: 'GBP', cash_value: 600, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 }),
      ],
    });
    const res = await result;

    expect(res.map((r) => r.portfolio.id)).toEqual(['p1', 'p2']);

    const v1 = holdingOf(res, 'p1', 'VOD.L')!;
    const v2 = holdingOf(res, 'p2', 'VOD.L')!;
    expect(v1).not.toBe(v2);
    expect(v1).toMatchObject({ total_shares: 100, total_cost: 1005 });
    expect(v1.avg_price).toBeCloseTo(10.05, 10);
    expect(v2).toMatchObject({ total_shares: 50, total_cost: 600, avg_price: 12 });

    expect(cashOf(res, 'p1')).toEqual([{ currency: 'GBP', balance: 3995 }]);
    expect(cashOf(res, 'p2')).toEqual([{ currency: 'GBP', balance: 400 }]);
  });
});

describe('getPortfoliosWithHoldingsAndCash — holdings versus cash-only transactions', () => {
  it('DIV/INT and CASH.* rows never reach holdings replay but do move cash; a non-cash ticker with only an OTR row appears as a zero-share holding (CURRENT behaviour)', async () => {
    const { result } = run({
      portfolios: [{ id: 'p1', name: 'ISA', base_currency: 'GBP' }],
      transactions: [
        makeTxn({ portfolio_id: 'p1', asset_id: 'a-cash-gbp', type: 'DEP', date: '2024-01-01', cash_value: 2000, cash_ccy: 'GBP' }),
        makeTxn({ portfolio_id: 'p1', asset_id: 'a-vod', type: 'BUY', date: '2024-01-02', quantity: 100, price: 10, fee: 0, settle_value: 1000, settle_ccy: 'GBP', cash_value: 1000, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 }),
        makeTxn({ portfolio_id: 'p1', asset_id: 'a-vod', type: 'DIV', date: '2024-02-01', cash_value: 42.5, cash_ccy: 'GBP' }),
        makeTxn({ portfolio_id: 'p1', asset_id: 'a-bp', type: 'OTR', date: '2024-02-02', cash_value: -1.5, cash_ccy: 'GBP' }),
        makeTxn({ portfolio_id: 'p1', asset_id: 'a-cash-gbp', type: 'FEE', date: '2024-02-03', cash_value: 2, cash_ccy: 'GBP' }),
      ],
    });
    const res = await result;
    const holdings = res[0].holdings;

    expect(holdings.map((h) => h.ticker).sort()).toEqual(['BP.L', 'VOD.L']); // no CASH.GBP holding
    expect(holdingOf(res, 'p1', 'VOD.L')).toMatchObject({ total_shares: 100, total_cost: 1000, realised_value: 0 }); // DIV not replayed
    expect(holdingOf(res, 'p1', 'BP.L')).toMatchObject({ total_shares: 0, total_cost: 0 }); // OTR-only ticker

    // 2000 - 1000 + 42.50 - 1.50 - 2.00
    expect(cashOf(res, 'p1')).toEqual([{ currency: 'GBP', balance: 1039 }]);
  });
});

describe('getPortfoliosWithHoldingsAndCash — Definition B uses each portfolio\'s own base currency', () => {
  it('GBP and USD portfolios each get base_currency = their own base; a cross-currency BUY without an FX rate is unreliable', async () => {
    const { result } = run({
      portfolios: [
        { id: 'p-gbp', name: 'GBP book', base_currency: 'GBP' },
        { id: 'p-usd', name: 'USD book', base_currency: 'USD' },
        { id: 'p-gbp-nofx', name: 'GBP no fx', base_currency: 'GBP' },
      ],
      transactions: [
        makeTxn({ portfolio_id: 'p-gbp', asset_id: 'a-aapl', type: 'BUY', date: '2024-01-02', quantity: 10, price: 150, fee: 2, settle_value: 1502, settle_ccy: 'USD', cash_value: 1185.98, cash_ccy: 'GBP', cash_fx_to_portfolio: 0.7896 }),
        makeTxn({ portfolio_id: 'p-usd', asset_id: 'a-aapl', type: 'BUY', date: '2024-01-02', quantity: 10, price: 150, fee: 2, settle_value: 1502, settle_ccy: 'USD', cash_value: 1502, cash_ccy: 'USD', cash_fx_to_portfolio: 1 }),
        makeTxn({ portfolio_id: 'p-gbp-nofx', asset_id: 'a-aapl', type: 'BUY', date: '2024-01-02', quantity: 10, price: 150, fee: 2, settle_value: 1502, settle_ccy: 'USD', cash_value: 1185.98, cash_ccy: 'GBP', cash_fx_to_portfolio: null }),
      ],
    });
    const res = await result;

    expect(holdingOf(res, 'p-gbp', 'AAPL')).toMatchObject({
      total_cost: 1502, // native ledger, USD
      base_currency: 'GBP',
      base_total_cost: 1185.98,
      base_cost_reliable: true,
    });
    expect(holdingOf(res, 'p-gbp', 'AAPL')!.base_avg_cost).toBeCloseTo(118.598, 10);

    expect(holdingOf(res, 'p-usd', 'AAPL')).toMatchObject({ total_cost: 1502, base_currency: 'USD', base_total_cost: 1502, base_cost_reliable: true });

    const noFx = holdingOf(res, 'p-gbp-nofx', 'AAPL')!;
    expect(noFx).toMatchObject({ total_cost: 1502, base_currency: 'GBP', base_cost_reliable: false });
    expect(noFx.base_avg_cost).toBeUndefined();
  });

  it('a portfolio with base_currency NULL currently falls back to GBP for both the returned portfolio and Definition B', async () => {
    const { result } = run({
      portfolios: [{ id: 'p-null', name: 'Legacy', base_currency: null }],
      transactions: [
        makeTxn({ portfolio_id: 'p-null', asset_id: 'a-vod', type: 'BUY', date: '2024-01-02', quantity: 100, price: 10, fee: 0, settle_value: 1000, settle_ccy: 'GBP', cash_value: 1000, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 }),
      ],
    });
    const res = await result;

    expect(res[0].portfolio.base_currency).toBe('GBP');
    expect(holdingOf(res, 'p-null', 'VOD.L')).toMatchObject({ base_currency: 'GBP', base_total_cost: 1000, base_cost_reliable: true });
  });
});

describe('getPortfoliosWithHoldingsAndCash — asOf', () => {
  const portfolios = [{ id: 'p1', name: 'ISA', base_currency: 'GBP' }];
  const transactions = () => [
    makeTxn({ portfolio_id: 'p1', asset_id: 'a-cash-gbp', type: 'DEP', date: '2024-01-10', cash_value: 5000, cash_ccy: 'GBP' }),
    makeTxn({ portfolio_id: 'p1', asset_id: 'a-vod', type: 'BUY', date: '2024-01-15', quantity: 100, price: 10, fee: 0, settle_value: 1000, settle_ccy: 'GBP', cash_value: 1000, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 }),
    makeTxn({ portfolio_id: 'p1', asset_id: 'a-vod', type: 'BUY', date: '2024-06-15', quantity: 50, price: 10, fee: 0, settle_value: 500, settle_ccy: 'GBP', cash_value: 500, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 }),
    makeTxn({ portfolio_id: 'p1', asset_id: 'a-cash-gbp', type: 'DEP', date: '2024-07-01', cash_value: 300, cash_ccy: 'GBP' }),
  ];

  it('excludes later transactions from BOTH holdings and cash', async () => {
    const res = await run({ portfolios, transactions: transactions() }, { asOf: '2024-03-31' }).result;
    expect(holdingOf(res, 'p1', 'VOD.L')).toMatchObject({ total_shares: 100, total_cost: 1000 });
    expect(cashOf(res, 'p1')).toEqual([{ currency: 'GBP', balance: 4000 }]);
  });

  it('without asOf, every transaction is included', async () => {
    const res = await run({ portfolios, transactions: transactions() }).result;
    expect(holdingOf(res, 'p1', 'VOD.L')).toMatchObject({ total_shares: 150, total_cost: 1500 });
    expect(cashOf(res, 'p1')).toEqual([{ currency: 'GBP', balance: 3800 }]);
  });
});

describe('getPortfoliosWithHoldingsAndCash — resolved transfers', () => {
  it('an external_in TIN uses its frozen parcel cost; a pending_in TIN is not fetched and falls back to legacy cost with an unreliable base ledger', async () => {
    const { result, fake } = run({
      portfolios: [{ id: 'p1', name: 'ISA', base_currency: 'GBP' }],
      transactions: [
        // Importer shape: settle_value = qty*price+fee (legacy cost 100.00).
        makeTxn({ id: 'tin-resolved', portfolio_id: 'p1', asset_id: 'a-xyz', type: 'TIN', date: '2024-03-01', quantity: 100, price: 1, fee: 0, settle_value: 100, settle_ccy: 'GBP', cash_value: 100, cash_ccy: 'GBP' }),
        makeTxn({ id: 'tin-pending', portfolio_id: 'p1', asset_id: 'a-abc', type: 'TIN', date: '2024-03-01', quantity: 10, price: 2, fee: 0, settle_value: 20, settle_ccy: 'GBP', cash_value: 20, cash_ccy: 'GBP' }),
      ],
      transfers: [
        { id: 'tr-1', status: 'external_in', in_transaction_id: 'tin-resolved', out_transaction_id: null, quantity: 100, native_cost: 500, native_ccy: 'GBP', base_cost: 500, base_ccy: 'GBP' },
        { id: 'tr-2', status: 'pending_in', in_transaction_id: 'tin-pending', out_transaction_id: null, quantity: 10, native_cost: null, native_ccy: null, base_cost: null, base_ccy: null },
      ],
    });
    const res = await result;

    expect(holdingOf(res, 'p1', 'XYZ.L')).toMatchObject({ total_shares: 100, total_cost: 500, base_total_cost: 500, base_cost_reliable: true });
    expect(holdingOf(res, 'p1', 'ABC.L')).toMatchObject({ total_shares: 10, total_cost: 20, base_cost_reliable: false });

    // Security TIN rows have no cash effect.
    expect(cashOf(res, 'p1')).toEqual([]);

    expect(fake.calls).toContainEqual({ table: 'transfers', op: 'in', column: 'status', values: ['matched', 'external_in', 'external_out'] });
  });

  it('a transfers-table read error throws instead of silently falling back to legacy TIN/TOT cost', async () => {
    const { result } = run(
      {
        portfolios: [{ id: 'p1', name: 'ISA', base_currency: 'GBP' }],
        transactions: [makeTxn({ portfolio_id: 'p1', asset_id: 'a-vod', type: 'BUY', quantity: 1, price: 1 })],
      },
      { errors: { transfers: { message: 'permission denied for table transfers' } } }
    );
    await expect(result).rejects.toThrow(/failed to read transfers — refusing to silently fall back/);
  });
});

describe('getPortfoliosWithHoldingsAndCash — transaction paging', () => {
  function deposits(n: number): Txn[] {
    return Array.from({ length: n }, (_, i) =>
      makeTxn({ id: `dep-${String(i).padStart(5, '0')}`, portfolio_id: 'p1', asset_id: 'a-cash-gbp', type: 'DEP', date: '2024-01-01', cash_value: 1, cash_ccy: 'GBP' })
    );
  }
  const portfolios = [{ id: 'p1', name: 'ISA', base_currency: 'GBP' }];

  it('reads beyond 1,000 transactions in pages of 1,000 (2,050 rows -> 3 pages, all counted)', async () => {
    const { result, fake } = run({ portfolios, transactions: deposits(2050) });
    const res = await result;
    expect(cashOf(res, 'p1')).toEqual([{ currency: 'GBP', balance: 2050 }]);
    expect(fake.calls.filter((c) => c.op === 'range')).toEqual([
      { table: 'transactions', op: 'range', from: 0, to: 999 },
      { table: 'transactions', op: 'range', from: 1000, to: 1999 },
      { table: 'transactions', op: 'range', from: 2000, to: 2999 },
    ]);
  });

  it('an exact multiple of the page size (1,000 rows) stops after one extra, empty page', async () => {
    const { result, fake } = run({ portfolios, transactions: deposits(1000) });
    const res = await result;
    expect(cashOf(res, 'p1')).toEqual([{ currency: 'GBP', balance: 1000 }]);
    expect(fake.calls.filter((c) => c.op === 'range').map((c) => (c as any).from)).toEqual([0, 1000]);
  });
});

describe('getPortfoliosWithHoldingsAndCash — transaction whose asset is missing', () => {
  it('CURRENT behaviour: it is skipped for holdings, but its cash effect is still applied (as a GBP non-cash asset)', async () => {
    const { result } = run({
      portfolios: [{ id: 'p1', name: 'ISA', base_currency: 'GBP' }],
      transactions: [
        makeTxn({ portfolio_id: 'p1', asset_id: 'a-vod', type: 'BUY', date: '2024-01-02', quantity: 10, price: 10, fee: 0, settle_value: 100, settle_ccy: 'GBP', cash_value: 100, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 }),
        makeTxn({ portfolio_id: 'p1', asset_id: 'a-ghost', type: 'BUY', date: '2024-01-02', quantity: 10, price: 10, fee: 0, settle_value: 100, settle_ccy: 'GBP', cash_value: 100, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 }),
      ],
    });
    const res = await result;
    expect(res[0].holdings.map((h) => h.ticker)).toEqual(['VOD.L']);
    expect(cashOf(res, 'p1')).toEqual([{ currency: 'GBP', balance: -200 }]);
  });
});

describe('getPortfoliosWithHoldingsAndCash — same-day ordering', () => {
  const portfolios = [{ id: 'p1', name: 'ISA', base_currency: 'GBP' }];
  const buy = (overrides: Partial<Txn>) =>
    makeTxn({ portfolio_id: 'p1', asset_id: 'a-vod', type: 'BUY', date: '2024-05-01', quantity: 100, price: 10, fee: 0, settle_value: 1000, settle_ccy: 'GBP', cash_value: 1000, cash_ccy: 'GBP', cash_fx_to_portfolio: 1, ...overrides });
  const sell = (overrides: Partial<Txn>) =>
    makeTxn({ portfolio_id: 'p1', asset_id: 'a-vod', type: 'SELL', date: '2024-05-01', quantity: 40, price: 12, fee: 0, settle_value: 480, settle_ccy: 'GBP', cash_value: 480, cash_ccy: 'GBP', cash_fx_to_portfolio: 1, ...overrides });

  it('identical date and created_at: the BUY is replayed before the SELL even though the SELL id sorts first', async () => {
    const res = await run({
      portfolios,
      transactions: [
        sell({ id: 'a-sell', created_at: '2024-05-01T09:00:00.000Z' }),
        buy({ id: 'z-buy', created_at: '2024-05-01T09:00:00.000Z' }),
      ],
    }).result;
    expect(holdingOf(res, 'p1', 'VOD.L')).toMatchObject({
      total_shares: 60,
      total_cost: 600,
      realised_cost: 400,
      realised_value: 80,
      base_total_cost: 600,
      base_realised_value: 80,
    });
  });

  it('CURRENT behaviour: a SELL created before a same-day BUY is replayed first; the oversold position snaps to zero before the BUY (see known defect C8)', async () => {
    const res = await run({
      portfolios,
      transactions: [
        buy({ id: 'z-buy', created_at: '2024-05-01T09:00:00.001Z' }),
        sell({ id: 'a-sell', created_at: '2024-05-01T09:00:00.000Z' }),
      ],
    }).result;
    expect(holdingOf(res, 'p1', 'VOD.L')).toMatchObject({
      total_shares: 100,
      total_cost: 1000,
      realised_cost: 0,
      realised_value: 480,
    });
  });
});
