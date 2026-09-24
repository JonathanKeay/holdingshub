// Narrow test harness for characterising the CONFIRM stage of
// src/app/api/import-transactions/route.ts (POST ?stage=confirm).
//
// Provides only:
//   - toCsv / confirmRequest: build the multipart CSV Request the route reads;
//   - createImportFake: an in-memory stand-in for the service-role Supabase
//     client, implementing exactly the query shapes the confirm stage uses when
//     every ticker already exists (no asset creation):
//       portfolios    .select(cols).eq('user_id', id)
//       assets        .select(cols)                    (awaited directly)
//       asset_aliases .select(cols)                    (awaited directly)
//       fx_rates      .select(cols).in('date', dates)
//       transactions  .insert(rows).select(cols)       (captured, never persisted)
//     Any other table, method, or an insert into any table other than
//     `transactions` throws, so an unexpected code path (e.g. asset creation)
//     fails loudly instead of passing silently.
//
// Module mocking (session, createClient, processImportedTransfers, and the
// network-capable ticker/logo lookups) lives in the spec file itself, because
// vi.mock is hoisted per test file.
// No network or database access of any kind.

export type Row = Record<string, any>;

export type ImportFakeTables = {
  portfolios: Row[];
  assets: Row[];
  asset_aliases: Row[];
  fx_rates: Row[];
};

export type ImportFakeCall =
  | { table: string; op: 'select'; columns: string }
  | { table: string; op: 'eq'; column: string; value: unknown }
  | { table: string; op: 'in'; column: string; values: unknown[] }
  | { table: string; op: 'insert'; rows: Row[] };

type Result = { data: Row[] | null; error: null };

export function createImportFake(tables: ImportFakeTables) {
  const calls: ImportFakeCall[] = [];
  /** Every array passed to transactions.insert(), in call order. */
  const transactionInserts: Row[][] = [];

  const copy = (rows: Row[]): Result => ({ data: rows.map((r) => ({ ...r })), error: null });

  const client = {
    from(table: string) {
      if (table === 'transactions') {
        return {
          insert(rows: Row[]) {
            const captured = rows.map((r) => ({ ...r }));
            calls.push({ table, op: 'insert', rows: captured });
            transactionInserts.push(captured);
            return {
              select(columns: string): Promise<Result> {
                calls.push({ table, op: 'select', columns });
                return Promise.resolve(copy(captured.map((r, i) => ({ id: `inserted-${i}`, ...r }))));
              },
            };
          },
        };
      }

      if (!Object.prototype.hasOwnProperty.call(tables, table)) {
        throw new Error(`importRouteHarness: unexpected table "${table}"`);
      }
      const rows = (tables as Record<string, Row[]>)[table];
      return {
        select(columns: string) {
          calls.push({ table, op: 'select', columns });
          return {
            then<T1 = Result, T2 = never>(
              onFulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
              onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
            ) {
              return Promise.resolve(copy(rows)).then(onFulfilled, onRejected);
            },
            eq(column: string, value: unknown): Promise<Result> {
              calls.push({ table, op: 'eq', column, value });
              return Promise.resolve(copy(rows.filter((r) => r[column] === value)));
            },
            in(column: string, values: unknown[]): Promise<Result> {
              calls.push({ table, op: 'in', column, values: [...values] });
              return Promise.resolve(copy(rows.filter((r) => values.includes(r[column]))));
            },
          };
        },
        insert() {
          throw new Error(`importRouteHarness: unexpected insert into "${table}" (asset creation is out of scope)`);
        },
      };
    },
  };

  return { client, calls, transactionInserts };
}

/** RFC 4180-style CSV: every field quoted, so values like "£1,234.50" survive. */
export function toCsv(header: string[], rows: Array<Array<string | number>>): string {
  const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  return [header.map(q).join(','), ...rows.map((r) => r.map(q).join(','))].join('\n');
}

export function confirmRequest(csvText: string, opts: { confirmedTickers?: string[] } = {}): Request {
  const fd = new FormData();
  fd.append('file', new File([csvText], 'import.csv', { type: 'text/csv' }));
  fd.append('confirmedTickers', JSON.stringify(opts.confirmedTickers ?? []));
  return new Request('http://localhost/api/import-transactions?stage=confirm', { method: 'POST', body: fd });
}
