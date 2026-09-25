// TRANSACTION LIST QUERY — src/lib/transactionListQuery.ts
//
// The Transactions screen's list loader. PostgREST silently caps a response at
// 1,000 rows, so the loader must page. Uses a small recording fake of the
// Supabase query builder that honours order/eq/range the way PostgREST does
// and caps every response at 1,000 rows. No database.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchTransactionListRows, TRANSACTION_LIST_PAGE_SIZE } from '../../src/lib/transactionListQuery';

type Row = { id: string; date: string; portfolio_id: string };
type Call = { table: string; orders: [string, boolean][]; filters: [string, unknown][]; range?: [number, number] };
type Err = { message: string };

const MAX_ROWS = 1000;

function tieKey(id: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

function createClient(rows: Row[], options: { failOnCall?: number; error?: Err } = {}) {
  const calls: Call[] = [];

  function builder(table: string) {
    const state: Call = { table, orders: [], filters: [] };
    const run = () => {
      calls.push({ ...state, orders: [...state.orders], filters: [...state.filters] });
      if (options.failOnCall === calls.length) return { data: null, error: options.error ?? { message: 'boom' } };
      const matching = rows.filter((r) => state.filters.every(([c, v]) => (r as Record<string, unknown>)[c] === v));
      matching.sort((a, b) => {
        for (const [col, asc] of state.orders) {
          const x = (a as Record<string, string>)[col];
          const y = (b as Record<string, string>)[col];
          if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
        }
        // Postgres gives no guaranteed order for rows the ORDER BY leaves tied;
        // model that by ordering ties differently on every request.
        return tieKey(a.id, calls.length) - tieKey(b.id, calls.length);
      });
      const [from, to] = state.range ?? [0, Infinity];
      const end = Math.min(to + 1, from + MAX_ROWS);
      return { data: matching.slice(from, end).map((r) => ({ ...r })), error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a chainable query-builder fake is untyped by nature
    const b: any = {
      select() { return b; },
      order(col: string, opts?: { ascending?: boolean }) { state.orders.push([col, opts?.ascending ?? true]); return b; },
      eq(col: string, v: unknown) { state.filters.push([col, v]); return b; },
      range(a: number, z: number) { state.range = [a, z]; return Promise.resolve().then(run); },
    };
    return b;
  }

  const client = { from: (table: string) => builder(table) } as unknown as SupabaseClient;
  return { client, calls };
}

function makeRows(n: number, opts: { portfolio?: string; date?: (i: number) => string; prefix?: string } = {}): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${opts.prefix ?? 'tx'}-${String(i).padStart(5, '0')}`,
    date: opts.date ? opts.date(i) : `20${String(10 + (i % 15)).padStart(2, '0')}-01-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00+00:00`,
    portfolio_id: opts.portfolio ?? 'p1',
  }));
}

const ranges = (calls: Call[]) => calls.map((c) => c.range);

describe('fetchTransactionListRows', () => {
  it('uses 1,000-row pages', () => {
    expect(TRANSACTION_LIST_PAGE_SIZE).toBe(1000);
  });

  it('returns all 2,500 rows over 3 requests', async () => {
    const { client, calls } = createClient(makeRows(2500));
    const res = await fetchTransactionListRows<Row>(client);
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(2500);
    expect(new Set(res.data!.map((r) => r.id)).size).toBe(2500);
    expect(ranges(calls)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('makes a second request when exactly 1,000 rows exist', async () => {
    const { client, calls } = createClient(makeRows(1000));
    const res = await fetchTransactionListRows<Row>(client);
    expect(res.data).toHaveLength(1000);
    expect(ranges(calls)).toEqual([[0, 999], [1000, 1999]]);
  });

  it('stops after one request when fewer than 1,000 rows exist', async () => {
    const { client, calls } = createClient(makeRows(686));
    const res = await fetchTransactionListRows<Row>(client);
    expect(res.data).toHaveLength(686);
    expect(ranges(calls)).toEqual([[0, 999]]);
  });

  it('returns an error, not partial data, when page 2 fails', async () => {
    const { client, calls } = createClient(makeRows(2500), { failOnCall: 2, error: { message: 'timeout' } });
    const res = await fetchTransactionListRows<Row>(client);
    expect(res.data).toBeNull();
    expect(res.error).toEqual({ message: 'timeout' });
    expect(calls).toHaveLength(2);
  });

  it('does not skip or duplicate same-date rows crossing a page boundary', async () => {
    // 1,200 rows all on one date: the page boundary falls inside the tie.
    const rows = makeRows(1200, { date: () => '2023-11-27T00:00:00+00:00' });
    const { client } = createClient(rows);
    const res = await fetchTransactionListRows<Row>(client);
    const ids = res.data!.map((r) => r.id);
    expect(ids).toHaveLength(1200);
    expect(new Set(ids).size).toBe(1200);
    expect([...ids].sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it('(control) a date-only ordering does lose rows at that boundary under this fake', async () => {
    const rows = makeRows(1200, { date: () => '2023-11-27T00:00:00+00:00' });
    const { client } = createClient(rows);
    const ids: string[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await client.from('transactions').select('*').order('date', { ascending: false }).range(from, from + 999);
      ids.push(...(data as Row[]).map((r) => r.id));
      if ((data as Row[]).length < 1000) break;
    }
    expect(new Set(ids).size).toBeLessThan(1200);
  });

  it('orders every page by date desc then id desc, and returns newest first', async () => {
    const { client, calls } = createClient(makeRows(2100));
    const res = await fetchTransactionListRows<Row>(client);
    for (const c of calls) {
      expect(c.table).toBe('transactions');
      expect(c.orders).toEqual([['date', false], ['id', false]]);
    }
    const data = res.data!;
    for (let i = 1; i < data.length; i++) {
      const a = data[i - 1];
      const b = data[i];
      expect(a.date > b.date || (a.date === b.date && a.id > b.id)).toBe(true);
    }
  });

  it('applies the portfolio filter on every request', async () => {
    const rows = [...makeRows(1500, { portfolio: 'p1', prefix: 'a' }), ...makeRows(300, { portfolio: 'p2', prefix: 'b' })];
    const { client, calls } = createClient(rows);
    const res = await fetchTransactionListRows<Row>(client, 'p1');
    expect(res.data).toHaveLength(1500);
    expect(res.data!.every((r) => r.portfolio_id === 'p1')).toBe(true);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.filters).toEqual([['portfolio_id', 'p1']]);
  });

  it('applies no portfolio filter when none is given', async () => {
    const { client, calls } = createClient(makeRows(10));
    await fetchTransactionListRows<Row>(client, null);
    expect(calls[0].filters).toEqual([]);
  });
});

// The page is a client component (no DOM test environment here), so its
// wiring is checked at source level: the list loader is the paged helper, and
// every refresh goes through it.
describe('Transactions page wiring', () => {
  const src = readFileSync(join(__dirname, '../../src/app/transactions/page.tsx'), 'utf8');
  const body = (name: string) => {
    const start = src.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf('\n  async function ', start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  };

  it('fetchTransactions loads through the paged helper with the portfolio filter', () => {
    expect(body('fetchTransactions')).toContain('fetchTransactionListRows(supabase, portfolioFilter)');
  });

  it('never reads the transactions table directly (only the insert in handleCreate)', () => {
    const direct = src.match(/from\('transactions'\)[\s\S]{0,40}/g) ?? [];
    expect(direct).toHaveLength(1);
    expect(direct[0]).toContain('.insert(');
  });

  it('refreshes after delete and create via fetchTransactions', () => {
    expect(body('handleConfirmDelete')).toContain('await fetchTransactions()');
    expect(body('handleCreate')).toContain('await fetchTransactions()');
  });

  it('saving notes patches the loaded full list in place rather than reloading a subset', () => {
    const notes = body('handleSaveNotes');
    expect(notes).toContain('setTransactions((prev) => prev.map(');
    expect(notes).not.toContain('.from(');
  });
});
