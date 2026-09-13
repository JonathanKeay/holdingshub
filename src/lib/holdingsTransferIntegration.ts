// src/lib/holdingsTransferIntegration.ts
//
// Pure helpers bridging RESOLVED transfer records (transfers table, status =
// 'matched' or 'external_in' only) into live holdings replay. No runtime
// dependency on queries.ts/transferCostBasis.ts/transfers.ts — every import
// below is `import type`, deliberately, so this module has zero runtime
// module-graph edges (queries.ts's orchestration functions import FROM
// here, and also from transferCostBasis.ts; if this file also imported
// applyTransactionToHolding at runtime, that would be a circular import).
//
// The actual dispatch wrapper that DECIDES which function to call
// (applyTransferIn for a resolved TIN, applyTransactionToHolding for
// everything else) lives in queries.ts itself, right next to
// applyTransactionToHolding — which remains completely unmodified.

import type { Holding, Txn } from './queries';
import type { CostParcel } from './transferCostBasis';
import type { TransferRecord } from './transfers';

/** Only the fields actually needed from a transfers row, to keep the query this is built from minimal. */
export type ResolvedTransferForReplay = Pick<
  TransferRecord,
  | 'id'
  | 'status'
  | 'out_transaction_id'
  | 'in_transaction_id'
  | 'quantity'
  | 'native_cost'
  | 'native_ccy'
  | 'base_cost'
  | 'base_ccy'
>;

export type ResolvedTransferLookup = Map<string, ResolvedTransferForReplay>; // keyed by in_transaction_id, or by out_transaction_id — see the two index functions below

const RESOLVED_STATUSES = new Set(['matched', 'external_in']);
const RESOLVED_OUT_STATUSES = new Set(['matched', 'external_out']);

/**
 * Builds the in_transaction_id -> resolved transfer lookup from a batch of
 * transfers rows already fetched ONCE per replay (never per transaction).
 * Filters defensively to matched/external_in — the only statuses this
 * integration ever acts on; a pending_in or pending_out row passed in here
 * is simply ignored.
 */
export function indexResolvedTransfersByTinTransactionId(
  transfers: ResolvedTransferForReplay[]
): ResolvedTransferLookup {
  const map: ResolvedTransferLookup = new Map();
  for (const t of transfers) {
    if (RESOLVED_STATUSES.has(t.status) && t.in_transaction_id) {
      map.set(t.in_transaction_id, t);
    }
  }
  return map;
}

/**
 * Builds the out_transaction_id -> resolved transfer lookup — the TOT-side
 * mirror of indexResolvedTransfersByTinTransactionId. Filters to
 * matched/external_out (the only statuses whose out leg is resolved); a
 * pending_out row is simply ignored, exactly as a pending_in is on the TIN
 * side. Callers may pass the SAME transfers array fetched for the TIN index
 * — one query serves both, since both are pure filters over the same rows.
 */
export function indexResolvedTransfersByOutTransactionId(
  transfers: ResolvedTransferForReplay[]
): ResolvedTransferLookup {
  const map: ResolvedTransferLookup = new Map();
  for (const t of transfers) {
    if (RESOLVED_OUT_STATUSES.has(t.status) && t.out_transaction_id) {
      map.set(t.out_transaction_id, t);
    }
  }
  return map;
}

/**
 * Returns the frozen CostParcel a resolved transfer supplies for `txn`, or
 * null if `txn` is not a TIN, or has no matched/external_in transfer record
 * (a pending_in or a legacy/unlinked TIN — both return null here, meaning
 * "use legacy behaviour", exactly as today).
 *
 * baseCost/baseCcy are always carried through when present on the transfer
 * record, even though Definition B is dormant today (no live Holding sets
 * base_currency) — so activating Definition B later needs no change here:
 * applyTransferIn already marks a Holding's base ledger unreliable rather
 * than inventing a figure when a resolved transfer has no base cost.
 */
export function resolveTransferParcelForTin(
  txn: Txn,
  resolvedTinTransfers: ResolvedTransferLookup,
  holding: Pick<Holding, 'asset_id' | 'ticker'>
): CostParcel | null {
  if ((txn.type ?? '').toUpperCase() !== 'TIN') return null;
  const resolved = resolvedTinTransfers.get(txn.id);
  if (!resolved) return null;

  return {
    assetId: holding.asset_id,
    ticker: holding.ticker,
    quantity: resolved.quantity,
    // native_cost/native_ccy are guaranteed non-null for matched/external_in
    // by the transfers table's own chk_native_cost_by_status constraint.
    nativeCost: resolved.native_cost as number,
    nativeCcy: resolved.native_ccy as string,
    baseCost: resolved.base_cost ?? undefined,
    baseCcy: resolved.base_ccy ?? undefined,
  };
}

/**
 * The TOT-side mirror of resolveTransferParcelForTin. Returns the frozen
 * CostParcel a resolved transfer's OUT leg carries for `txn`, or null if
 * `txn` is not a TOT, or has no matched/external_out transfer record.
 *
 * Unlike the TIN side, this parcel is never applied wholesale to a holding
 * (a source holding already removes its own shares/cost via the ordinary
 * TOT arithmetic in applyTransactionToHolding — that must stay exactly as
 * it is, since it is native-ledger arithmetic already proven correct for
 * both a single-portfolio and a blended/global holding). What this parcel
 * IS used for is correcting Definition B's base-currency ledger only: the
 * plain TOT branch conservatively marks base_cost_reliable false because —
 * absent a resolved transfer — the shares' true carried-forward base cost
 * is unknowable. Once a transfer is resolved, that base cost IS known
 * (captured once, at the moment the TOT was first turned into a pending_out
 * row — see transfers.ts's captureTransferOut), so the conservative taint
 * is no longer warranted and can be corrected using this parcel's
 * baseCost/baseCcy. See applyTransactionToHoldingResolvingTransfers in
 * queries.ts for exactly how/when that correction is applied.
 */
export function resolveTransferParcelForTot(
  txn: Txn,
  resolvedTotTransfers: ResolvedTransferLookup,
  holding: Pick<Holding, 'asset_id' | 'ticker'>
): CostParcel | null {
  if ((txn.type ?? '').toUpperCase() !== 'TOT') return null;
  const resolved = resolvedTotTransfers.get(txn.id);
  if (!resolved) return null;
  if (resolved.native_cost == null || !resolved.native_ccy) return null;

  return {
    assetId: holding.asset_id,
    ticker: holding.ticker,
    quantity: resolved.quantity,
    nativeCost: resolved.native_cost,
    nativeCcy: resolved.native_ccy,
    baseCost: resolved.base_cost ?? undefined,
    baseCcy: resolved.base_ccy ?? undefined,
  };
}
