// CASH BALANCE TOOL — src/app/tools/cash-balance/actions.ts (processBalanceAction)
//
// The tool must always see a portfolio's COMPLETE transaction history. PostgREST
// silently caps every response at max_rows (1,000), so an unpaged read of a
// larger portfolio understates the balance and the tool then proposes (and on
// apply, inserts) a wrong BAL adjustment. Uses a small recording fake of the
// Supabase query builder that enforces the same 1,000-row cap. No database.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchAllPages, type PagedQuery } from '../../src/lib/fetchAllPages';

type Row = Record<string, unknown>;
type Err = { message: string };
type Result = { data: Row[] | null; error: Err | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a chainable query-builder fake is untyped by nature
type Builder = any;
type Call = { table: string; op: 'select' | 'insert'; payload?: Row; filters: [string, unknown][]; orders: string[]; range?: [number, number] };

const MAX_ROWS = 1000;

let tables: Record<string, Row[]>;
let calls: Call[];
/** Fail the read of `table` whose range starts at `from`, e.g. { transactions: 1000 }. */
let failPageAt: Record<string, number>;

function builder(table: string) {
  const state: Call = { table, op: 'select', filters: [], orders: [] };
  const run = (): Result => {
    calls.push({ ...state, filters: [...state.filters], orders: [...state.orders] });
    if (state.op === 'insert') {
      tables[table].push({ id: `inserted-${calls.length}`, ...state.payload });
      return { data: null, error: null };
    }
    if (failPageAt[table] !== undefined && state.range?.[0] === failPageAt[table]) {
      return { data: null, error: { message: 'connection reset' } };
    }
    // Storage order unless ordered; then the PostgREST cap, like the real server.
    let rows = tables[table].filter((r) => state.filters.every(([c, v]) => r[c] === v));
    for (const col of state.orders) rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1));
    const [from, to] = state.range ?? [0, Infinity];
    rows = rows.slice(from, Math.min(to + 1, from + MAX_ROWS));
    return { data: rows.map((r) => ({ ...r })), error: null };
  };
  const b: Builder = {
    select() { return b; },
    insert(payload: Row) { state.op = 'insert'; state.payload = payload; return Promise.resolve().then(run); },
    eq(col: string, v: unknown) { state.filters.push([col, v]); return b; },
    order(col: string) { state.orders.push(col); return b; },
    range(a: number, z: number) { state.range = [a, z]; return Promise.resolve().then(run); },
    single() {
      return Promise.resolve().then(() => {
        const res = run();
        return res.data?.length === 1 ? { data: res.data[0], error: null } : { data: null, error: { message: 'not one row' } };
      });
    },
    then(onOk: (r: Result) => unknown, onErr: (e: unknown) => unknown) { return Promise.resolve().then(run).then(onOk, onErr); },
  };
  return b;
}

vi.mock('@/lib/supabase-server', () => ({ getSupabaseServerClient: async () => ({ from: (t: string) => builder(t) }) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
const { processBalanceAction } = await import('../../src/app/tools/cash-balance/actions');

const CASH_GBP = { id: 'a-cash', ticker: 'CASH.GBP', currency: 'GBP' };

/** `n` £10 deposits in portfolio p1, one per day from 2020-01-01, plus one in another portfolio. */
function seed(n: number, assets: Row[] = [CASH_GBP]) {
  const txns: Row[] = [];
  for (let i = 0; i < n; i++) {
    txns.push({
      id: `t${String(i).padStart(5, '0')}`, portfolio_id: 'p1', asset_id: 'a-cash', type: 'DEP',
      date: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      quantity: null, price: null, fee: null, cash_value: 10, cash_ccy: 'GBP',
    });
  }
  txns.push({ id: 'other', portfolio_id: 'p2', asset_id: 'a-cash', type: 'DEP', date: '2020-01-01', cash_value: 5000, cash_ccy: 'GBP' });
  tables = {
    portfolios: [{ id: 'p1', name: 'Big ISA', base_currency: 'GBP' }, { id: 'p2', name: 'Other', base_currency: 'GBP' }],
    assets: assets.map((a) => ({ ...a })),
    transactions: txns,
  };
}

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries({ portfolio_id: 'p1', as_of: '2030-01-01', mode: 'post', ...fields })) f.set(k, v);
  return f;
}

const txnPages = () => calls.filter((c) => c.table === 'transactions' && c.op === 'select');
const inserts = () => calls.filter((c) => c.op === 'insert');

beforeEach(() => {
  calls = [];
  failPageAt = {};
});

describe('processBalanceAction — sees the complete history of a portfolio larger than one PostgREST page', () => {
  it('1,200 transactions: the preview balance uses every row', async () => {
    seed(1200);
    const res = await processBalanceAction(null, form({ intent: 'preview', target: '12000' }));
    expect(res).toMatchObject({ ok: true, phase: 'preview', current: 12000, diff: 0 });
    expect(txnPages().map((c) => c.range)).toEqual([[0, 999], [1000, 1999]]);
  });

  it('matching broker target: apply inserts no BAL', async () => {
    seed(1200);
    const res = await processBalanceAction(null, form({ intent: 'apply', target: '12000' }));
    expect(res).toMatchObject({ ok: true, phase: 'done' });
    expect(res.message).toMatch(/No adjustment needed/);
    expect(inserts()).toHaveLength(0);
  });

  it('differing broker target: apply inserts exactly one BAL for the true difference', async () => {
    seed(1200);
    const res = await processBalanceAction(null, form({ intent: 'apply', target: '11950.5' }));
    expect(res).toMatchObject({ ok: true, phase: 'done' });
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].payload).toMatchObject({
      portfolio_id: 'p1', type: 'BAL', date: '2030-01-01', asset_id: 'a-cash', quantity: null, cash_value: -49.5, cash_ccy: 'GBP',
    });
  });

  it('exactly 1,000 rows triggers a second (empty) request', async () => {
    seed(1000);
    const res = await processBalanceAction(null, form({ intent: 'preview', target: '10000' }));
    expect(res).toMatchObject({ current: 10000, diff: 0 });
    expect(txnPages().map((c) => c.range)).toEqual([[0, 999], [1000, 1999]]);
  });

  it('every transaction page is ordered by id and filtered to the portfolio', async () => {
    seed(2500);
    await processBalanceAction(null, form({ intent: 'preview', target: '0' }));
    const pages = txnPages();
    expect(pages).toHaveLength(3);
    for (const p of pages) {
      expect(p.orders).toEqual(['id']);
      expect(p.filters).toEqual([['portfolio_id', 'p1']]);
    }
  });

  it('a failure on page 2 returns the error and inserts no BAL', async () => {
    seed(1200);
    failPageAt = { transactions: 1000 };
    const res = await processBalanceAction(null, form({ intent: 'apply', target: '99999' }));
    expect(res).toMatchObject({ ok: false, phase: 'error', message: 'Error loading transactions: connection reset' });
    expect(inserts()).toHaveLength(0);
  });

  it('assets are paged too: a cash asset beyond the first 1,000 is still recognised', async () => {
    const filler = Array.from({ length: 1005 }, (_, i) => ({ id: `a${String(i).padStart(5, '0')}`, ticker: `X${i}`, currency: 'GBP' }));
    // 'a-cash' sorts after every filler id, so it only arrives on page 2.
    seed(3, [...filler, CASH_GBP]);
    const res = await processBalanceAction(null, form({ intent: 'preview', target: '30' }));
    expect(res).toMatchObject({ current: 30, diff: 0 });
    const assetPages = calls.filter((c) => c.table === 'assets' && c.range);
    expect(assetPages.map((c) => [c.range, c.orders])).toEqual([[[0, 999], ['id']], [[1000, 1999], ['id']]]);
  });

  it('an asset page failure returns the error and inserts no BAL', async () => {
    seed(10);
    failPageAt = { assets: 0 };
    const res = await processBalanceAction(null, form({ intent: 'apply', target: '500' }));
    expect(res).toMatchObject({ ok: false, phase: 'error', message: 'Error loading assets: connection reset' });
    expect(inserts()).toHaveLength(0);
  });
});

describe('fetchAllPages — the shared paging helper', () => {
  const query = (table: string) => () => builder(table).select('*') as unknown as PagedQuery<Row>;

  it('stops on the first short page; an empty table needs one request', async () => {
    seed(0, []);
    const res = await fetchAllPages(query('assets'));
    expect(res).toEqual({ data: [], error: null });
    expect(calls.map((c) => c.range)).toEqual([[0, 999]]);
  });

  it('never returns a partial list when a later page fails', async () => {
    seed(1500);
    failPageAt = { transactions: 1000 };
    const res = await fetchAllPages(query('transactions'));
    expect(res).toEqual({ data: null, error: { message: 'connection reset' } });
  });
});
