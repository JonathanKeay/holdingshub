// Deliberately minimal, deterministic in-memory stand-in for the Supabase
// client, for orchestration tests of src/lib/queries.ts
// (getPortfoliosWithHoldingsAndCash, getAllHoldingsAndCashSummary).
//
// It implements ONLY the query shapes those two functions use today:
//   from(table).select(cols)                  — awaited directly (portfolios, assets)
//   from(table).select(cols).range(from, to)  — unordered paging
//   from(table).select(cols).order(col).range(from, to) — fetchAllTable's paging (transactions)
//   from(table).select(cols).in(col, values)  — the transfers status filter
//
// It is NOT a general Supabase emulator:
//   - column projection in select(cols) is not applied; full row copies are returned;
//   - order(col) sorts ascending by that column (string comparison) and only
//     range() may follow it;
//   - any other builder method (eq, insert, ...) does not exist, so an
//     unexpected new query shape fails loudly with a TypeError instead of
//     silently returning plausible data;
//   - a table not supplied to createFakeSupabase throws on from().
// No network or database access of any kind.

import type { SupabaseClient } from '@supabase/supabase-js';

export type FakeRow = Record<string, any>;

export type FakeCall =
  | { table: string; op: 'select'; columns: string }
  | { table: string; op: 'order'; column: string }
  | { table: string; op: 'range'; from: number; to: number }
  | { table: string; op: 'in'; column: string; values: unknown[] };

export type FakeSupabaseOptions = {
  /** Make every read of the named table resolve to { data: null, error }. */
  errors?: Record<string, { message: string }>;
  /** Make one range() read of the named table fail, identified by its start offset. */
  failRangeAt?: Record<string, number>;
  /**
   * Model Postgres's lack of an order guarantee: an UNORDERED range() read of
   * the named tables sees the rows in a fresh (seeded) shuffle every time.
   * An ordered read is unaffected.
   */
  shuffleUnordered?: string[];
};

type Result = { data: FakeRow[] | null; error: { message: string } | null };

export function createFakeSupabase(tables: Record<string, FakeRow[]>, options: FakeSupabaseOptions = {}) {
  const calls: FakeCall[] = [];
  let seed = 1;
  const shuffle = (rows: FakeRow[]) => {
    const out = [...rows];
    for (let i = out.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const rangeRead = (table: string, rows: FakeRow[], from: number, to: number): Promise<Result> => {
    calls.push({ table, op: 'range', from, to });
    if (options.failRangeAt?.[table] === from) return Promise.resolve({ data: null, error: { message: `page at ${from} failed` } });
    return Promise.resolve(resultFor(table, rows.slice(from, to + 1)));
  };

  const resultFor = (table: string, rows: FakeRow[]): Result => {
    const error = options.errors?.[table];
    if (error) return { data: null, error };
    return { data: rows.map((r) => ({ ...r })), error: null };
  };

  const client = {
    from(table: string) {
      if (!Object.prototype.hasOwnProperty.call(tables, table)) {
        throw new Error(`fakeSupabase: unexpected table "${table}"`);
      }
      const rows = tables[table];
      return {
        select(columns: string) {
          calls.push({ table, op: 'select', columns });
          return {
            // Awaiting the select() builder directly returns every row.
            then<T1 = Result, T2 = never>(
              onFulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
              onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
            ) {
              return Promise.resolve(resultFor(table, rows)).then(onFulfilled, onRejected);
            },
            range(from: number, to: number): Promise<Result> {
              const source = options.shuffleUnordered?.includes(table) ? shuffle(rows) : rows;
              return rangeRead(table, source, from, to);
            },
            order(column: string) {
              calls.push({ table, op: 'order', column });
              const sorted = [...rows].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0));
              return { range: (from: number, to: number) => rangeRead(table, sorted, from, to) };
            },
            in(column: string, values: unknown[]): Promise<Result> {
              calls.push({ table, op: 'in', column, values: [...values] });
              return Promise.resolve(resultFor(table, rows.filter((r) => values.includes(r[column]))));
            },
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}
