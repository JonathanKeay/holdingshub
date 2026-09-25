// TRANSACTION MUTATIONS — src/lib/transactionMutations.ts
//
// The only writes the Transactions screen makes to existing rows: a
// safety-checked hard delete, and a notes-only update. Uses a small recording
// fake of the Supabase query builder (only the shapes this module uses) so the
// exact payloads and the user-facing messages can be asserted. No database.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  deleteTransactionSafely,
  describeWriteError,
  loadDeleteAssessment,
  NOT_FOUND_MESSAGE,
  updateTransactionNotes,
} from '../../src/lib/transactionMutations';

type Row = Record<string, unknown>;
type Result = { data: Row[] | null; error: Err | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a chainable query-builder fake is untyped by nature
type Builder = any;
type Err = { code?: string; message: string; details?: string };
type Call = { table: string; op: 'select' | 'delete' | 'update'; payload?: Row; filters: [string, unknown][]; range?: [number, number] };

type FakeOptions = {
  /** Force an error for a table/op, e.g. { 'transfers:select': {...} }. */
  errors?: Record<string, Err>;
  /** Simulate RLS: rows for which this returns false are invisible and unwritable. */
  visible?: (table: string, row: Row) => boolean;
  /** Make a write throw (network failure). */
  throwOn?: 'delete' | 'update';
};

function createRecordingClient(tables: Record<string, Row[]>, options: FakeOptions = {}) {
  const calls: Call[] = [];
  const visible = options.visible ?? (() => true);

  function builder(table: string) {
    const state: Call = { table, op: 'select', filters: [] };
    const matching = () =>
      (tables[table] ?? []).filter((r) => visible(table, r) && state.filters.every(([c, v]) => r[c] === v));

    const run = (): Result => {
      calls.push({ ...state, filters: [...state.filters] });
      const err = options.errors?.[`${table}:${state.op}`];
      if (err) return { data: null, error: err };
      if (options.throwOn === state.op) throw new TypeError('fetch failed');
      if (state.op === 'select') {
        let rows = [...matching()].sort((a, b) => (a.id < b.id ? -1 : 1));
        if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
        return { data: rows.map((r) => ({ ...r })), error: null };
      }
      if (state.op === 'delete') {
        const hit = matching();
        tables[table] = tables[table].filter((r) => !hit.includes(r));
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      const hit = matching();
      for (const r of hit) Object.assign(r, state.payload);
      return { data: hit.map((r) => ({ id: r.id, notes: r.notes })), error: null };
    };

    const b: Builder = {
      select() { return b; },
      delete() { state.op = 'delete'; return b; },
      update(payload: Row) { state.op = 'update'; state.payload = payload; return b; },
      eq(col: string, v: unknown) { state.filters.push([col, v]); return b; },
      order() { return b; },
      range(a: number, z: number) { state.range = [a, z]; return Promise.resolve().then(run); },
      maybeSingle() {
        return Promise.resolve().then(() => {
          const res = run();
          return { data: res.error || !res.data ? null : (res.data[0] ?? null), error: res.error };
        });
      },
      then(onOk: (r: Result) => unknown, onErr: (e: unknown) => unknown) { return Promise.resolve().then(run).then(onOk, onErr); },
    };
    return b;
  }

  const client = { from: (table: string) => builder(table) } as unknown as SupabaseClient;
  return { client, calls, tables };
}

const USER_PORTFOLIO = { id: 'p1', name: 'ISA', base_currency: 'GBP' };
const ASSETS = [
  { id: 'a-vod', ticker: 'VOD.L', currency: 'GBP' },
  { id: 'a-cash', ticker: 'CASH.GBP', currency: 'GBP' },
];
const base = {
  portfolio_id: 'p1', created_at: '2026-09-12T07:00:00+00:00', price: null, fee: null, quantity: null,
  cash_value: null, cash_ccy: null, cash_fx_to_portfolio: null, settle_value: null, settle_ccy: null, split_factor: null, notes: null,
};
const dep = { ...base, id: 'dep', asset_id: 'a-cash', type: 'DEP', date: '2024-01-01T00:00:00+00:00', quantity: 1, price: 1000, cash_value: 1000, cash_ccy: 'GBP' };
const buyRow = { ...base, id: 'buy', asset_id: 'a-vod', type: 'BUY', date: '2024-01-02T00:00:00+00:00', quantity: 10, price: 10, fee: 5, cash_value: 105, cash_ccy: 'GBP', settle_value: 105, settle_ccy: 'GBP', notes: 'old note' };
const sellRow = { ...base, id: 'sell', asset_id: 'a-vod', type: 'SELL', date: '2024-02-01T00:00:00+00:00', quantity: 10, price: 15, fee: 5, cash_value: 145, cash_ccy: 'GBP', settle_value: 155, settle_ccy: 'GBP' };
const tinRow = { ...base, id: 'tin', asset_id: 'a-vod', type: 'TIN', date: '2024-03-01T00:00:00+00:00', quantity: 5, price: 0, fee: 0, cash_value: 0, cash_ccy: 'GBP', settle_value: 0, settle_ccy: 'GBP' };

function world(extra: Partial<Record<string, Row[]>> = {}, options: FakeOptions = {}) {
  return createRecordingClient(
    {
      transactions: [dep, buyRow, sellRow, tinRow].map((r) => ({ ...r })),
      portfolios: [{ ...USER_PORTFOLIO }],
      assets: ASSETS.map((a) => ({ ...a })),
      transfers: [
        { id: 'tr', status: 'external_in', out_transaction_id: null, in_transaction_id: 'tin', quantity: 5, native_cost: 50, native_ccy: 'GBP', base_cost: 50, base_ccy: 'GBP' },
      ],
      ...extra,
    },
    options
  );
}

const errorMessage = (r: { status: string; message?: string }) => (r.status === 'error' ? r.message : `not an error: ${r.status}`);

const RAW_DB_TEXT = /foreign key|constraint|violates|transfers_(in|out)_transaction_id|permission denied for|PGRST|23503|42501|fetch failed/i;

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('updateTransactionNotes — notes only', () => {
  it('sends exactly { notes } and nothing else', async () => {
    const w = world();
    const res = await updateTransactionNotes(w.client, 'buy', 'Checked against HL statement');
    expect(res).toEqual({ status: 'saved', notes: 'Checked against HL statement' });
    const updates = w.calls.filter((c) => c.op === 'update');
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0].payload!)).toEqual(['notes']);
    expect(updates[0].filters).toEqual([['id', 'buy']]);
  });

  it('changes only the notes; every financial field is untouched', async () => {
    const w = world();
    const before = { ...w.tables.transactions.find((r) => r.id === 'buy')! };
    await updateTransactionNotes(w.client, 'buy', 'new');
    const after = w.tables.transactions.find((r) => r.id === 'buy')!;
    expect(after).toEqual({ ...before, notes: 'new' });
  });

  it('a blank note is stored as NULL', async () => {
    const w = world();
    const res = await updateTransactionNotes(w.client, 'buy', '   ');
    expect(res).toEqual({ status: 'saved', notes: null });
    expect(w.calls.find((c) => c.op === 'update')!.payload).toEqual({ notes: null });
  });

  it('a row that is not visible (another user / RLS) reports a clear not-found message', async () => {
    const w = world({}, { visible: (t, r) => !(t === 'transactions' && r.id === 'buy') });
    expect(await updateTransactionNotes(w.client, 'buy', 'x')).toEqual({ status: 'error', message: NOT_FOUND_MESSAGE });
  });

  it('a database error is shown in plain English, never raw', async () => {
    const w = world({}, { errors: { 'transactions:update': { code: '42501', message: 'permission denied for table transactions' } } });
    const res = await updateTransactionNotes(w.client, 'buy', 'x');
    expect(res.status).toBe('error');
    expect(errorMessage(res)).toBe('You do not have permission to change this transaction. The notes were not saved.');
  });

  it('a network failure is shown in plain English', async () => {
    const w = world({}, { throwOn: 'update' });
    const res = await updateTransactionNotes(w.client, 'buy', 'x');
    expect(errorMessage(res)).toContain('Could not reach the database');
    expect(errorMessage(res)).not.toMatch(RAW_DB_TEXT);
  });
});

describe('loadDeleteAssessment — reads fresh data', () => {
  it('assesses a cash row as allowed with its cash effect', async () => {
    const w = world();
    const ctx = await loadDeleteAssessment(w.client, 'dep');
    expect(ctx.status).toBe('ok');
    if (ctx.status !== 'ok') return;
    expect(ctx.assessment.allowed).toBe(true);
    expect(ctx.assessment.cashEffect).toEqual([{ currency: 'GBP', amount: 1000 }]);
    expect(ctx.portfolioName).toBe('ISA');
    expect(ctx.ticker).toBe('CASH.GBP');
  });

  it('reads the portfolio history, assets and transfers (and only the target portfolio)', async () => {
    const w = world();
    await loadDeleteAssessment(w.client, 'buy');
    const tables = w.calls.map((c) => c.table);
    expect(tables).toEqual(expect.arrayContaining(['transactions', 'portfolios', 'assets', 'transfers']));
    const history = w.calls.find((c) => c.table === 'transactions' && c.range);
    expect(history!.filters).toEqual([['portfolio_id', 'p1']]);
  });

  it('pages through histories larger than one PostgREST page', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({
      ...dep, id: `int${String(i).padStart(5, '0')}`, type: 'INT', cash_value: 1,
    }));
    const w = world({ transactions: [dep, buyRow, sellRow, tinRow, ...many].map((r) => ({ ...r })) });
    const ctx = await loadDeleteAssessment(w.client, 'dep');
    expect(ctx.status).toBe('ok');
    const pages = w.calls.filter((c) => c.table === 'transactions' && c.range);
    expect(pages.map((p) => p.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('a transfers read failure blocks (fails closed) rather than assuming no transfers', async () => {
    const w = world({}, { errors: { 'transfers:select': { message: 'permission denied for table transfers' } } });
    const ctx = await loadDeleteAssessment(w.client, 'dep');
    expect(ctx.status).toBe('ok');
    if (ctx.status !== 'ok') return;
    expect(ctx.assessment.allowed).toBe(false);
    expect(ctx.assessment.reasons[0].code).toBe('CANNOT_ASSESS');
  });

  it('a history read failure gives a readable error', async () => {
    const w = world({}, { errors: { 'assets:select': { message: 'boom' } } });
    const ctx = await loadDeleteAssessment(w.client, 'dep');
    expect(ctx).toEqual({ status: 'error', message: 'The information needed to check this delete could not be loaded. Nothing was changed.' });
  });
});

describe('deleteTransactionSafely', () => {
  it('a normal cash transaction is hard-deleted', async () => {
    const w = world();
    expect(await deleteTransactionSafely(w.client, 'dep')).toEqual({ status: 'deleted' });
    expect(w.tables.transactions.some((r) => r.id === 'dep')).toBe(false);
    const deletes = w.calls.filter((c) => c.op === 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].filters).toEqual([['id', 'dep']]);
  });

  it('a SELL whose removal leaves a valid history is deleted', async () => {
    const w = world();
    expect(await deleteTransactionSafely(w.client, 'sell')).toEqual({ status: 'deleted' });
  });

  it('a BUY a later SELL depends on is blocked, and no delete is sent', async () => {
    const w = world();
    const res = await deleteTransactionSafely(w.client, 'buy');
    expect(res.status).toBe('blocked');
    if (res.status === 'blocked') expect(res.assessment.reasons.map((r) => r.code)).toContain('WOULD_OVERSELL');
    expect(w.calls.some((c) => c.op === 'delete')).toBe(false);
    expect(w.tables.transactions.some((r) => r.id === 'buy')).toBe(true);
  });

  it('a transfer-linked TIN is blocked with a readable message, and no delete is sent', async () => {
    const w = world();
    const res = await deleteTransactionSafely(w.client, 'tin');
    expect(res.status).toBe('blocked');
    if (res.status !== 'blocked') return;
    const msg = res.assessment.reasons.map((r) => r.message).join(' ');
    expect(msg).toContain('incoming side of a recorded transfer');
    expect(msg).not.toMatch(RAW_DB_TEXT);
    expect(w.calls.some((c) => c.op === 'delete')).toBe(false);
  });

  it('safety is re-checked at delete time against fresh data (a SELL added since the dialog opened)', async () => {
    const w = world({ transactions: [dep, buyRow, tinRow].map((r) => ({ ...r })) });
    const first = await loadDeleteAssessment(w.client, 'buy');
    expect(first.status === 'ok' && first.assessment.allowed).toBe(true);
    w.tables.transactions.push({ ...sellRow });
    const res = await deleteTransactionSafely(w.client, 'buy');
    expect(res.status).toBe('blocked');
    expect(w.calls.some((c) => c.op === 'delete')).toBe(false);
  });

  it('a transaction the user cannot see (ownership/RLS) is reported clearly and never deleted', async () => {
    const w = world({}, { visible: (t, r) => !(t === 'transactions' && r.id === 'dep') });
    expect(await deleteTransactionSafely(w.client, 'dep')).toEqual({ status: 'error', message: NOT_FOUND_MESSAGE });
    expect(w.calls.some((c) => c.op === 'delete')).toBe(false);
  });

  it('a portfolio the user does not own is reported clearly', async () => {
    const w = world({ portfolios: [] });
    expect(await deleteTransactionSafely(w.client, 'dep')).toEqual({ status: 'error', message: NOT_FOUND_MESSAGE });
  });

  it('a delete that matches no row (RLS filtered it out) is not reported as success', async () => {
    const w = world();
    // Visible for reading, but the write itself touches nothing.
    const originalFrom = w.client.from.bind(w.client);
    (w.client as unknown as { from: (t: string) => Builder }).from = (table: string) => {
      const b = originalFrom(table);
      const del = b.delete;
      b.delete = () => { const r = del(); r.eq = () => ({ select: () => Promise.resolve({ data: [], error: null }) }); return r; };
      return b;
    };
    expect(await deleteTransactionSafely(w.client, 'dep')).toEqual({ status: 'error', message: NOT_FOUND_MESSAGE });
  });

  it('a raw foreign-key error from the database is translated, never shown', async () => {
    const w = world({}, {
      errors: {
        'transactions:delete': {
          code: '23503',
          message: 'update or delete on table "transactions" violates foreign key constraint "transfers_in_transaction_id_fkey" on table "transfers"',
          details: 'Key is still referenced from table "transfers".',
        },
      },
    });
    const res = await deleteTransactionSafely(w.client, 'dep');
    expect(res).toEqual({
      status: 'error',
      message: 'This transaction is linked to a transfer record, so the database refused to delete it. Nothing was deleted.',
    });
  });

  it('a network failure during delete is translated', async () => {
    const w = world({}, { throwOn: 'delete' });
    const res = await deleteTransactionSafely(w.client, 'dep');
    expect(res.status).toBe('error');
    expect(errorMessage(res)).toContain('Could not reach the database');
  });
});

describe('describeWriteError never exposes raw database text', () => {
  const samples: unknown[] = [
    { code: '23503', message: 'violates foreign key constraint "transfers_out_transaction_id_fkey"' },
    { code: '42501', message: 'permission denied for table transactions' },
    { code: 'PGRST301', message: 'JWT expired' },
    { code: '23514', message: 'new row violates check constraint "chk_spl_factor"' },
    { code: 'XX000', message: 'internal error' },
    new TypeError('fetch failed'),
    null,
    undefined,
  ];
  it.each(samples.map((s) => [s]))('sample #%#', (sample) => {
    for (const action of ['delete', 'notes'] as const) {
      const msg = describeWriteError(sample, action);
      expect(msg).not.toMatch(RAW_DB_TEXT);
      expect(msg).toMatch(action === 'delete' ? /Nothing was deleted\.$/ : /The notes were not saved\.$/);
    }
  });
});
