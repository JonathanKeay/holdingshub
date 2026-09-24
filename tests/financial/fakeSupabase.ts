// Deliberately minimal, deterministic in-memory stand-in for the Supabase
// client, for orchestration tests of src/lib/queries.ts
// (getPortfoliosWithHoldingsAndCash, getAllHoldingsAndCashSummary).
//
// It implements ONLY the query shapes those two functions use today:
//   from(table).select(cols)                  — awaited directly (portfolios, assets)
//   from(table).select(cols).range(from, to)  — fetchAllTable's paging (transactions)
//   from(table).select(cols).in(col, values)  — the transfers status filter
//
// It is NOT a general Supabase emulator:
//   - column projection in select(cols) is not applied; full row copies are returned;
//   - any other builder method (eq, order, insert, ...) does not exist, so an
//     unexpected new query shape fails loudly with a TypeError instead of
//     silently returning plausible data;
//   - a table not supplied to createFakeSupabase throws on from().
// No network or database access of any kind.

import type { SupabaseClient } from '@supabase/supabase-js';

export type FakeRow = Record<string, any>;

export type FakeCall =
  | { table: string; op: 'select'; columns: string }
  | { table: string; op: 'range'; from: number; to: number }
  | { table: string; op: 'in'; column: string; values: unknown[] };

export type FakeSupabaseOptions = {
  /** Make every read of the named table resolve to { data: null, error }. */
  errors?: Record<string, { message: string }>;
};

type Result = { data: FakeRow[] | null; error: { message: string } | null };

export function createFakeSupabase(tables: Record<string, FakeRow[]>, options: FakeSupabaseOptions = {}) {
  const calls: FakeCall[] = [];

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
              calls.push({ table, op: 'range', from, to });
              return Promise.resolve(resultFor(table, rows.slice(from, to + 1)));
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
