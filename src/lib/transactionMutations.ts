// src/lib/transactionMutations.ts
//
// The only two writes the Transactions screen makes to existing rows:
//   - deleteTransactionSafely: re-reads fresh data, re-runs the delete-safety
//     assessment (src/lib/transactionDeleteSafety.ts), and hard-deletes only
//     if it passes;
//   - updateTransactionNotes: sends ONLY the notes column.
// Financial fields are immutable after creation/import, so nothing here can
// write them. Every database error is translated into plain English; the raw
// error is logged to the console, never shown as the primary message.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssetMeta, Ccy, Txn } from './queries';
import { assessTransactionDelete, type DeleteAssessment, type TransferRecord } from './transactionDeleteSafety';

export const TRANSACTION_DETAIL_COLUMNS =
  'id, portfolio_id, asset_id, type, date, created_at, quantity, price, fee, cash_value, cash_ccy, ' +
  'cash_fx_to_portfolio, settle_value, settle_ccy, split_factor, notes';

export const TRANSFER_LINK_COLUMNS =
  'id, status, out_transaction_id, in_transaction_id, quantity, native_cost, native_ccy, base_cost, base_ccy';

export type TransactionDetail = Txn & { notes?: string | null };

type DbError = { code?: string; message?: string; details?: string; hint?: string } | null | undefined;

const PAGE = 1000;

export const NOT_FOUND_MESSAGE =
  'This transaction could not be found, or you do not have permission to change it. Nothing was changed.';

/** Plain-English description of a failed write. Never returns the raw database text. */
export function describeWriteError(error: DbError | unknown, action: 'delete' | 'notes'): string {
  const e = (error ?? {}) as { code?: string; message?: string; name?: string };
  const nothing = action === 'delete' ? 'Nothing was deleted.' : 'The notes were not saved.';
  if (e.code === '23503') {
    return `This transaction is linked to a transfer record, so the database refused to delete it. ${nothing}`;
  }
  if (e.code === '42501' || e.code === 'PGRST301' || e.code === 'PGRST302') {
    return `You do not have permission to change this transaction. ${nothing}`;
  }
  if (e.name === 'TypeError' || /fetch|network/i.test(e.message ?? '')) {
    return `Could not reach the database. Check your connection and try again. ${nothing}`;
  }
  return `The database did not accept the change. ${nothing}`;
}

type PagedQuery<T> = {
  order: (col: string) => { range: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: DbError }> };
};

async function fetchAll<T>(build: () => PagedQuery<T>): Promise<{ data: T[] | null; error: DbError }> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().order('id').range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return { data: out, error: null };
  }
}

export type DeleteContextResult =
  | { status: 'ok'; target: TransactionDetail; assessment: DeleteAssessment; portfolioName: string | null; ticker: string | null }
  | { status: 'error'; message: string };

/** Reads everything the delete-safety assessment needs, fresh from the database. */
export async function loadDeleteAssessment(supabase: SupabaseClient, id: string): Promise<DeleteContextResult> {
  const failed = 'The information needed to check this delete could not be loaded. Nothing was changed.';

  const { data: target, error: targetErr } = await supabase
    .from('transactions')
    .select(TRANSACTION_DETAIL_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (targetErr) {
    console.error('loadDeleteAssessment: transaction read failed', targetErr);
    return { status: 'error', message: failed };
  }
  if (!target) return { status: 'error', message: NOT_FOUND_MESSAGE };
  const row = target as unknown as TransactionDetail;

  const { data: portfolio, error: portfolioErr } = await supabase
    .from('portfolios')
    .select('id, name, base_currency')
    .eq('id', row.portfolio_id)
    .maybeSingle();
  if (portfolioErr || !portfolio) {
    if (portfolioErr) console.error('loadDeleteAssessment: portfolio read failed', portfolioErr);
    return { status: 'error', message: portfolioErr ? failed : NOT_FOUND_MESSAGE };
  }

  type AssetRow = { id: string; ticker: string; currency: string };
  const txns = await fetchAll<TransactionDetail>(
    () =>
      supabase
        .from('transactions')
        .select(TRANSACTION_DETAIL_COLUMNS)
        .eq('portfolio_id', row.portfolio_id) as unknown as PagedQuery<TransactionDetail>
  );
  const assets = await fetchAll<AssetRow>(
    () => supabase.from('assets').select('id, ticker, currency') as unknown as PagedQuery<AssetRow>
  );
  if (txns.error || assets.error) {
    console.error('loadDeleteAssessment: history read failed', txns.error ?? assets.error);
    return { status: 'error', message: failed };
  }

  // A failed transfers read is NOT "no transfers": the assessment blocks on null.
  const { data: transfers, error: transfersErr } = await supabase.from('transfers').select(TRANSFER_LINK_COLUMNS);
  if (transfersErr) console.error('loadDeleteAssessment: transfers read failed', transfersErr);

  const assetMeta: Record<string, AssetMeta> = {};
  for (const a of assets.data ?? []) {
    assetMeta[a.id] = { ticker: a.ticker, currency: ((a.currency as Ccy) ?? 'GBP') };
  }

  const assessment = assessTransactionDelete({
    target: row,
    portfolioTxns: txns.data ?? [],
    assetMeta,
    transfers: transfersErr ? null : ((transfers ?? []) as TransferRecord[]),
    baseCurrency: ((portfolio.base_currency as Ccy) ?? 'GBP'),
  });

  return {
    status: 'ok',
    target: row,
    assessment,
    portfolioName: portfolio.name ?? null,
    ticker: assetMeta[row.asset_id]?.ticker ?? null,
  };
}

export type DeleteResult =
  | { status: 'deleted' }
  | { status: 'blocked'; assessment: DeleteAssessment }
  | { status: 'error'; message: string };

/** Re-checks safety against fresh data, then hard-deletes the single row. */
export async function deleteTransactionSafely(supabase: SupabaseClient, id: string): Promise<DeleteResult> {
  const ctx = await loadDeleteAssessment(supabase, id);
  if (ctx.status === 'error') return ctx;
  if (!ctx.assessment.allowed) return { status: 'blocked', assessment: ctx.assessment };

  try {
    const { data, error } = await supabase.from('transactions').delete().eq('id', id).select('id');
    if (error) {
      console.error('deleteTransactionSafely: delete failed', error);
      return { status: 'error', message: describeWriteError(error, 'delete') };
    }
    if (!data || data.length === 0) return { status: 'error', message: NOT_FOUND_MESSAGE };
    return { status: 'deleted' };
  } catch (err) {
    console.error('deleteTransactionSafely: delete threw', err);
    return { status: 'error', message: describeWriteError(err, 'delete') };
  }
}

export type NotesResult = { status: 'saved'; notes: string | null } | { status: 'error'; message: string };

/** Updates the notes column only. A blank note is stored as NULL. */
export async function updateTransactionNotes(supabase: SupabaseClient, id: string, notes: string): Promise<NotesResult> {
  const value = notes.trim() === '' ? null : notes;
  try {
    const { data, error } = await supabase
      .from('transactions')
      .update({ notes: value })
      .eq('id', id)
      .select('id, notes');
    if (error) {
      console.error('updateTransactionNotes: update failed', error);
      return { status: 'error', message: describeWriteError(error, 'notes') };
    }
    if (!data || data.length === 0) return { status: 'error', message: NOT_FOUND_MESSAGE };
    return { status: 'saved', notes: (data[0] as { notes: string | null }).notes ?? null };
  } catch (err) {
    console.error('updateTransactionNotes: update threw', err);
    return { status: 'error', message: describeWriteError(err, 'notes') };
  }
}
