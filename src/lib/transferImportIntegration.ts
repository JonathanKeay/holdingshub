// src/lib/transferImportIntegration.ts
//
// Bridges CSV import to the transfer persistence layer (src/lib/transfers.ts).
// A security TOT/TIN row, once successfully inserted into `transactions`,
// gets a pending_out/pending_in transfer record created for it here.
//
// NOT changed by this file: live holdings replay (src/lib/queries.ts is
// untouched), Definition B wiring (still dormant), any existing transaction
// row (nothing here ever updates/deletes a transactions row — only reads
// them, to replay history for parcel capture, and only ever INSERTs new
// transfers rows).
//
// Cash transfers (CASH.* tickers) are out of scope here: they have no
// Holding/cost-basis concept at all (see getPortfoliosWithHoldingsAndCash,
// which excludes CASH.* tickers from holdings entirely) — captureTransferOut
// operates on a Holding, which simply does not apply to a cash movement.

import type { SupabaseClient } from '@supabase/supabase-js';
import { applyTransactionToHolding, type Holding, type Txn } from './queries';
import { captureTransferOut, capturePendingIn, type NewTransferRow, type TransferRecord } from './transfers';
import { suggestTransferMatches, type MatchCandidateInput, type MatchSuggestion } from './transferMatching';

export const isCashTicker = (ticker?: string | null) => !!ticker && ticker.toUpperCase().startsWith('CASH.');

export type InsertedTxnForTransfer = {
  id: string;
  portfolio_id: string;
  asset_id: string;
  type: string;
  quantity: number | null;
  date: string | null;
  notes?: string | null;
};

/** Mirrors queries.ts's compareTxForHoldings ordering (not exported there) so replay for parcel capture matches the live engine's own ordering. */
const TYPE_PRIORITY: Record<string, number> = {
  SPL: 10, TIN: 20, BUY: 30, SELL: 40, TOT: 50, DIV: 90, INT: 95, FEE: 96, DEP: 97, WIT: 98, OTR: 99, BAL: 100,
};

export function compareForReplay(a: Txn, b: Txn): number {
  const da = a.date ?? '';
  const db = b.date ?? '';
  if (da !== db) return da < db ? -1 : 1;
  const ca = a.created_at ?? '';
  const cb = b.created_at ?? '';
  if (ca !== cb) return ca < cb ? -1 : 1;
  const pa = TYPE_PRIORITY[(a.type || '').toUpperCase()] ?? 1000;
  const pb = TYPE_PRIORITY[(b.type || '').toUpperCase()] ?? 1000;
  if (pa !== pb) return pa - pb;
  return a.id < b.id ? -1 : 1;
}

/**
 * From a batch of just-inserted transaction rows, selects only the ones this
 * integration cares about: security (non-CASH.*) TOT/TIN rows. Everything
 * else (BUY/SELL/DIV/.../cash TIN/TOT) is left completely untouched — an
 * import batch with none of these is a no-op for this module.
 */
export function selectTransferRelevantRows(
  insertedRows: InsertedTxnForTransfer[],
  assetTickerById: Record<string, string>
): InsertedTxnForTransfer[] {
  return insertedRows.filter((r) => {
    const t = (r.type || '').toUpperCase();
    if (t !== 'TOT' && t !== 'TIN') return false;
    return !isCashTicker(assetTickerById[r.asset_id]);
  });
}

export type CaptureGroupResult = {
  newTransferRows: NewTransferRow[];
  errors: { transactionId: string; error: string }[];
};

/**
 * Given the FULL sorted transaction history for one (portfolio, asset) —
 * including both pre-existing rows and any new rows from this import batch —
 * and the ids of the NEW TOT rows within it that need a parcel captured,
 * replays the holding once and captures each parcel at exactly the right
 * point.
 *
 * For every transaction NOT in `newTotTransactionIds` (including any
 * pre-existing, already-processed TOT/TIN — this import never retroactively
 * creates transfer records for those), the ordinary, unchanged
 * applyTransactionToHolding is used to advance the holding. For a
 * newTotTransactionIds row, captureTransferOut is used INSTEAD — never in
 * addition — so the TOT's effect on the holding is applied exactly once
 * (see transfer-cost-basis.spec.ts's "exactly once" regression, and
 * transfers.spec.ts's persistence-layer equivalent).
 */
export function captureTransferOutsForGroup(
  sortedTxns: Txn[],
  newTotTransactionIds: Set<string>,
  holdingSeed: { assetId: string; ticker: string; currency: string }
): CaptureGroupResult {
  const holding: Holding = {
    asset_id: holdingSeed.assetId,
    ticker: holdingSeed.ticker,
    total_shares: 0,
    avg_price: 0,
    total_cost: 0,
    currency: holdingSeed.currency,
  };

  const newTransferRows: NewTransferRow[] = [];
  const errors: { transactionId: string; error: string }[] = [];

  for (const txn of sortedTxns) {
    if (newTotTransactionIds.has(txn.id)) {
      try {
        const quantity = Math.abs(Number(txn.quantity) || 0);
        const { transfer } = captureTransferOut(holding, { outTransactionId: txn.id, quantity, linkedBy: 'import_suggested' });
        newTransferRows.push(transfer);
      } catch (e: any) {
        errors.push({ transactionId: txn.id, error: String(e?.message ?? e) });
      }
    } else {
      applyTransactionToHolding(holding, txn);
    }
  }

  return { newTransferRows, errors };
}

/**
 * Defensive idempotency guard: removes any transaction id that ALREADY has
 * a transfers row from a candidate set before attempting to insert new
 * ones. In normal operation this can never trigger for freshly-inserted
 * transaction ids (they are new UUIDs that cannot already be referenced),
 * but it makes the "a transaction cannot participate in two transfer
 * records" invariant explicit at the application layer too, not just as a
 * DB constraint discovered via an error.
 */
export function filterAlreadyLinkedTransactionIds(
  candidateTransactionIds: string[],
  alreadyLinkedTransactionIds: Iterable<string>
): string[] {
  const linked = new Set(alreadyLinkedTransactionIds);
  return candidateTransactionIds.filter((id) => !linked.has(id));
}

export type ProcessImportedTransfersResult = {
  created: { transactionId: string; transferId: string; status: TransferRecord['status'] }[];
  suggestions: Record<string, MatchSuggestion[]>; // keyed by the NEW transfer's id
  errors: { transactionId: string; error: string }[];
};

/**
 * Orchestrates the DB side: for each newly-inserted security TOT/TIN row,
 * creates its pending_out/pending_in transfer record, then looks for
 * opposite-leg pending candidates (any portfolio) and ranks them via
 * suggestTransferMatches — surfaced in the result for the caller (the
 * import route) to include in its response. Never confirms/links anything.
 *
 * If a transaction was successfully imported but its transfer record fails
 * to insert, the transaction row is NOT rolled back (it already committed,
 * and — per this system's established design — a TIN/TOT with no transfers
 * row simply behaves exactly as it always has, which is safe, just
 * untracked) — the failure is reported in `errors` instead.
 */
export async function processImportedTransfers(
  supabase: SupabaseClient,
  insertedRows: InsertedTxnForTransfer[],
  assetTickerById: Record<string, string>
): Promise<ProcessImportedTransfersResult> {
  const result: ProcessImportedTransfersResult = { created: [], suggestions: {}, errors: [] };

  const relevant = selectTransferRelevantRows(insertedRows, assetTickerById);
  if (relevant.length === 0) return result;

  const totRows = relevant.filter((r) => (r.type || '').toUpperCase() === 'TOT');
  const tinRows = relevant.filter((r) => (r.type || '').toUpperCase() === 'TIN');

  const newTransferRows: NewTransferRow[] = [];

  // TOT rows: group by (portfolio, asset) so each holding is replayed once.
  const groups = new Map<string, InsertedTxnForTransfer[]>();
  for (const r of totRows) {
    const key = `${r.portfolio_id}::${r.asset_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  for (const [key, rows] of groups) {
    const [portfolioId, assetId] = key.split('::');
    const { data: history, error } = await supabase
      .from('transactions')
      .select('id, type, date, created_at, quantity, price, fee, cash_value, cash_ccy, settle_value, settle_ccy, cash_fx_to_portfolio, split_factor')
      .eq('portfolio_id', portfolioId)
      .eq('asset_id', assetId);

    if (error) {
      for (const r of rows) result.errors.push({ transactionId: r.id, error: error.message });
      continue;
    }

    const sorted = ([...(history ?? [])] as Txn[]).sort(compareForReplay);
    const totIds = new Set(rows.map((r) => r.id));

    const { data: assetRow } = await supabase.from('assets').select('currency').eq('id', assetId).single();
    const currency = (assetRow?.currency as string) ?? 'GBP';

    const { newTransferRows: rowsForGroup, errors } = captureTransferOutsForGroup(sorted, totIds, {
      assetId,
      ticker: assetTickerById[assetId] ?? assetId,
      currency,
    });

    newTransferRows.push(...rowsForGroup);
    result.errors.push(...errors);
  }

  // TIN rows: no replay needed at all — no cost is ever derived here.
  for (const r of tinRows) {
    newTransferRows.push(capturePendingIn({ inTransactionId: r.id, assetId: r.asset_id, quantity: Math.abs(Number(r.quantity) || 0) }));
  }

  if (newTransferRows.length === 0) return result;

  const { data: inserted, error: insertErr } = await supabase.from('transfers').insert(newTransferRows).select();
  if (insertErr) {
    for (const row of newTransferRows) {
      const txnId = row.out_transaction_id ?? row.in_transaction_id ?? 'unknown';
      result.errors.push({ transactionId: txnId, error: insertErr.message });
    }
    return result;
  }

  const insertedRecords = (inserted ?? []) as TransferRecord[];
  for (const tr of insertedRecords) {
    const txnId = (tr.out_transaction_id ?? tr.in_transaction_id)!;
    result.created.push({ transactionId: txnId, transferId: tr.id, status: tr.status });
  }

  // Candidate suggestions: fetch all currently-pending opposite-leg rows
  // (across every portfolio) and rank each new row against them. Read-only;
  // nothing is confirmed.
  const { data: pending } = await supabase
    .from('transfers')
    .select('id, status, out_transaction_id, in_transaction_id, asset_id, quantity')
    .in('status', ['pending_out', 'pending_in']);

  if (pending && pending.length > 0) {
    const txnIds = Array.from(
      new Set([
        ...pending.map((p: any) => p.out_transaction_id).filter(Boolean),
        ...pending.map((p: any) => p.in_transaction_id).filter(Boolean),
      ])
    );
    const { data: txnMeta } = await supabase
      .from('transactions')
      .select('id, portfolio_id, date, notes')
      .in('id', txnIds.length > 0 ? txnIds : ['00000000-0000-0000-0000-000000000000']);
    const metaById = new Map((txnMeta ?? []).map((t: any) => [t.id, t]));

    const toCandidateInput = (p: any): MatchCandidateInput | null => {
      const txnId = p.out_transaction_id ?? p.in_transaction_id;
      const meta = metaById.get(txnId);
      if (!meta) return null;
      return {
        transferId: p.id,
        transactionId: txnId,
        portfolioId: meta.portfolio_id,
        assetId: p.asset_id,
        quantity: Number(p.quantity),
        date: meta.date ?? null,
        notes: meta.notes ?? null,
      };
    };

    for (const tr of insertedRecords) {
      const targetInput = toCandidateInput(tr);
      if (!targetInput) continue;
      const oppositeStatus = tr.status === 'pending_out' ? 'pending_in' : 'pending_out';
      const candidateInputs = (pending as any[])
        .filter((p) => p.status === oppositeStatus && p.id !== tr.id)
        .map(toCandidateInput)
        .filter((c): c is MatchCandidateInput => c != null);
      const suggestions = suggestTransferMatches(targetInput, candidateInputs);
      if (suggestions.length > 0) result.suggestions[tr.id] = suggestions;
    }
  }

  return result;
}
