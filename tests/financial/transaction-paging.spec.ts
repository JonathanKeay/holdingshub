// DETERMINISTIC TRANSACTION PAGING (Task 4)
//
// The three loaders that read the whole transactions table in 1,000-row pages
// must order every page by id. Postgres gives no row order without ORDER BY,
// so an unordered page loop can skip some rows and repeat others at a page
// boundary. The fake below models that: an UNORDERED range() read of
// transactions sees a fresh shuffle every time; an order('id') read does not.
//
//   A. src/lib/queries.ts fetchAllTable (both holdings/cash orchestrations)
//   B. src/app/api/portfolio-series/fetchAllTable.ts (historical chart)
//   C. scripts/price-streamer.ts (ticker selection; source check only, since
//      importing the script would start the streamer)
//
// No database, no network.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getAllHoldingsAndCashSummary, getPortfoliosWithHoldingsAndCash, type Txn } from '../../src/lib/queries';
import { fetchAllTable as seriesFetchAllTable } from '../../src/app/api/portfolio-series/fetchAllTable';
import { createFakeSupabase, type FakeRow } from './fakeSupabase';
import { makeTxn } from './helpers';

const N = 2500;

const ASSETS: FakeRow[] = [
  { id: 'a-vod', ticker: 'VOD.L', name: 'Vodafone', currency: 'GBP', logo_url: null, status: 'active' },
  { id: 'a-cash-gbp', ticker: 'CASH.GBP', name: 'Cash GBP', currency: 'GBP', logo_url: null, status: 'active' },
];
const PORTFOLIOS: FakeRow[] = [{ id: 'p1', name: 'ISA', base_currency: 'GBP' }];

// 2,500 transactions on one day with one created_at, so replay order among them
// is decided by id alone. Even rows deposit a distinct amount; odd rows buy a
// distinct quantity of VOD.L at £1. Any lost or repeated row changes a total.
function txns(): Txn[] {
  return Array.from({ length: N }, (_, i) => {
    const id = `tx-${String(i).padStart(5, '0')}`;
    if (i % 2 === 0) {
      return makeTxn({ id, portfolio_id: 'p1', asset_id: 'a-cash-gbp', type: 'DEP', date: '2024-01-02', created_at: '2024-01-02T00:00:00Z', cash_value: 100 + i, cash_ccy: 'GBP' });
    }
    const qty = (i % 7) + 1;
    return makeTxn({ id, portfolio_id: 'p1', asset_id: 'a-vod', type: 'BUY', date: '2024-01-02', created_at: '2024-01-02T00:00:00Z', quantity: qty, price: 1, fee: 0, settle_value: qty, settle_ccy: 'GBP', cash_value: qty, cash_ccy: 'GBP', cash_fx_to_portfolio: 1 });
  });
}

// Totals of a complete, single-set replay of txns(), worked out independently.
const ALL = txns();
const EXPECTED_SHARES = ALL.filter((t) => t.type === 'BUY').reduce((s, t) => s + Number(t.quantity), 0);
const EXPECTED_CASH = ALL.reduce((s, t) => s + (t.type === 'DEP' ? Number(t.cash_value) : -Number(t.cash_value)), 0);

function fakeWith(transactions: FakeRow[], failRangeAt?: Record<string, number>) {
  return createFakeSupabase(
    { portfolios: PORTFOLIOS, assets: ASSETS, transactions, transfers: [] },
    { shuffleUnordered: ['transactions'], failRangeAt }
  );
}

const txnReads = (calls: ReturnType<typeof createFakeSupabase>['calls']) => calls.filter((c) => c.table === 'transactions');

// Every range() read of transactions must be immediately preceded by order('id').
function expectEveryPageOrderedById(calls: ReturnType<typeof createFakeSupabase>['calls'], froms: number[]) {
  const reads = txnReads(calls).filter((c) => c.op === 'order' || c.op === 'range');
  expect(reads).toEqual(
    froms.flatMap((from) => [
      { table: 'transactions', op: 'order', column: 'id' },
      { table: 'transactions', op: 'range', from, to: from + 999 },
    ])
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network access is not allowed in paging tests');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the shuffled fake really does break unordered paging (control)', () => {
  it('an unordered 1,000-row page loop over 2,500 shuffled rows skips and repeats rows', async () => {
    const fake = fakeWith(ALL);
    const got: FakeRow[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await fake.client.from('transactions').select('*').range(from, from + 999);
      if (!data) throw new Error('unexpected empty page');
      got.push(...data);
      if (data.length < 1000) break;
    }
    const unique = new Set(got.map((r) => r.id)).size;
    expect(got).toHaveLength(N);
    expect(unique).toBeLessThan(N); // some rows repeated, the same number missing
  });
});

describe('A. queries.ts fetchAllTable — getAllHoldingsAndCashSummary', () => {
  it('reads all 2,500 shuffled rows exactly once, every page ordered by id, and totals match a complete replay', async () => {
    const fake = fakeWith(ALL);
    const res = await getAllHoldingsAndCashSummary(fake.client);

    expectEveryPageOrderedById(fake.calls, [0, 1000, 2000]);
    const vod = res.holdings.find((h) => h.ticker === 'VOD.L')!;
    expect(vod.total_shares).toBe(EXPECTED_SHARES);
    expect(vod.total_cost).toBe(EXPECTED_SHARES);
    expect(res.cash_balances).toEqual([expect.objectContaining({ currency: 'GBP', balance: EXPECTED_CASH })]);
  });

  it('the result does not depend on the physical row order in the table', async () => {
    const forward = await getAllHoldingsAndCashSummary(fakeWith(ALL).client);
    const reversed = await getAllHoldingsAndCashSummary(fakeWith([...ALL].reverse()).client);
    expect(reversed).toEqual(forward);
  });

  it('a failed page still throws the page error (existing behaviour kept)', async () => {
    const fake = fakeWith(ALL, { transactions: 1000 });
    await expect(getAllHoldingsAndCashSummary(fake.client)).rejects.toEqual({ message: 'page at 1000 failed' });
  });
});

describe('A. queries.ts fetchAllTable — getPortfoliosWithHoldingsAndCash', () => {
  it('reads all 2,500 shuffled rows exactly once, every page ordered by id, and totals match a complete replay', async () => {
    const fake = fakeWith(ALL);
    const res = await getPortfoliosWithHoldingsAndCash(fake.client);

    expectEveryPageOrderedById(fake.calls, [0, 1000, 2000]);
    const p1 = res.find((r) => r.portfolio.id === 'p1')!;
    const vod = p1.holdings.find((h) => h.ticker === 'VOD.L')!;
    expect(vod.total_shares).toBe(EXPECTED_SHARES);
    expect(p1.cash_balances).toEqual([expect.objectContaining({ currency: 'GBP', balance: EXPECTED_CASH })]);
  });

  it('a failed page still throws the page error (existing behaviour kept)', async () => {
    const fake = fakeWith(ALL, { transactions: 2000 });
    await expect(getPortfoliosWithHoldingsAndCash(fake.client)).rejects.toEqual({ message: 'page at 2000 failed' });
  });
});

describe('B. portfolio-series fetchAllTable', () => {
  const SELECT = 'id,asset_id,type,date,created_at,quantity,price,fee,cash_value,cash_ccy,settle_value,settle_ccy,split_factor';

  it('reads all 2,500 shuffled rows exactly once, every page ordered by id', async () => {
    const fake = fakeWith(ALL);
    const rows = await seriesFetchAllTable<Txn>(fake.client, 'transactions', { select: SELECT });

    expectEveryPageOrderedById(fake.calls, [0, 1000, 2000]);
    expect(txnReads(fake.calls).find((c) => c.op === 'select')).toEqual({ table: 'transactions', op: 'select', columns: SELECT });
    expect(rows).toHaveLength(N);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(ALL.map((t) => t.id)));
  });

  it('an exact multiple of the page size stops after one extra, empty page', async () => {
    const fake = fakeWith(ALL.slice(0, 2000));
    const rows = await seriesFetchAllTable<Txn>(fake.client, 'transactions');
    expectEveryPageOrderedById(fake.calls, [0, 1000, 2000]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2000);
  });

  it('a failed page throws the page error', async () => {
    const fake = fakeWith(ALL, { transactions: 1000 });
    await expect(seriesFetchAllTable(fake.client, 'transactions')).rejects.toEqual({ message: 'page at 1000 failed' });
  });
});

describe('C. price-streamer transaction loader (source check)', () => {
  const src = readFileSync(resolve(__dirname, '../../scripts/price-streamer.ts'), 'utf8');

  it('the paged transactions read orders by id before range()', () => {
    const reads = src.match(/from\('transactions'\)[^;\n]*\.range\(/g) ?? [];
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/\.select\('\*'\)\.order\('id'\)\.range\($/);
  });

  it('stays standalone: does not import the app paging helper', () => {
    expect(src).not.toMatch(/fetchAllPages/);
  });
});
