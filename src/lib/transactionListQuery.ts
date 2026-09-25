// src/lib/transactionListQuery.ts
//
// Loads the Transactions screen's list. PostgREST caps every response at
// max_rows (1,000), silently, so a single unpaged select hides older rows once
// the table grows past that. This pages through the whole list instead.
//
// Every page uses the same ordering (date desc, then id desc as a tie-breaker)
// so rows sharing a date cannot be skipped or repeated at a page boundary.
// A failure on any page returns an error, never a partial list.

import type { SupabaseClient } from '@supabase/supabase-js';

export const TRANSACTION_LIST_PAGE_SIZE = 1000;

export const TRANSACTION_LIST_COLUMNS = `
  id, date, created_at, type, quantity, price, fee, cash_value, cash_ccy, cash_fx_to_portfolio,
  settle_value, settle_ccy, notes, split_factor,
  assets ( ticker, currency ),
  portfolios ( name )
`;

type DbError = { message: string } | null;

export type TransactionListResult<T> =
  | { data: T[]; error: null }
  | { data: null; error: { message: string } };

/** All transactions (optionally for one portfolio), newest first, fetched in 1,000-row pages. */
export async function fetchTransactionListRows<T = Record<string, unknown>>(
  supabase: SupabaseClient,
  portfolioId?: string | null
): Promise<TransactionListResult<T>> {
  const rows: T[] = [];
  for (let from = 0; ; from += TRANSACTION_LIST_PAGE_SIZE) {
    let query = supabase
      .from('transactions')
      .select(TRANSACTION_LIST_COLUMNS)
      .order('date', { ascending: false })
      .order('id', { ascending: false });
    if (portfolioId) query = query.eq('portfolio_id', portfolioId);

    const { data, error } = (await query.range(from, from + TRANSACTION_LIST_PAGE_SIZE - 1)) as {
      data: T[] | null;
      error: DbError;
    };
    if (error) return { data: null, error: { message: error.message } };

    const page = data ?? [];
    rows.push(...page);
    if (page.length < TRANSACTION_LIST_PAGE_SIZE) return { data: rows, error: null };
  }
}
