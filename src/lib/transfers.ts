// src/lib/transfers.ts
//
// Pure builders/validators for the transfer persistence model (Phase 1 —
// see supabase/migrations/20260913091500_create_transfers_table.sql for the
// schema these mirror). No Supabase client, no I/O — these functions take
// and return plain data, exactly like src/lib/queries.ts and
// src/lib/transferCostBasis.ts. Thin DB-facing wrappers live separately in
// src/lib/transferPersistence.ts.
//
// NOT YET WIRED IN: nothing in the import route, UI, or live holdings replay
// calls any of this. Definition B stays dormant; current TIN/TOT production
// behaviour (src/lib/queries.ts's applyTransactionToHolding) is completely
// unchanged and does not consult this module.
//
// Transaction immutability: no function here accepts a transaction row to
// mutate, and none returns one. The only mutation these functions perform is
// on an in-memory Holding object passed in for cost derivation (exactly the
// same contract as applyTransferOut/applyTransferIn already have) — the
// underlying `transactions` table is never touched.

import type { Holding } from './queries';
import { applyTransferOut, type CostParcel } from './transferCostBasis';

export type TransferStatus = 'pending_out' | 'pending_in' | 'matched' | 'external_in' | 'external_out';
export type TransferLinkedBy = 'manual' | 'import_suggested' | 'historical_repair';
export type BaseCostStatus = 'verified' | 'unreliable';

export type TransferRecord = {
  id: string;
  status: TransferStatus;
  out_transaction_id: string | null;
  in_transaction_id: string | null;
  asset_id: string;
  quantity: number;
  native_cost: number | null;
  native_ccy: string | null;
  base_cost: number | null;
  base_ccy: string | null;
  base_cost_status: BaseCostStatus | null;
  linked_by: TransferLinkedBy | null;
  linked_at: string | null;
  match_confidence: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

/** Shape to INSERT — everything the DB assigns by default is omitted. */
export type NewTransferRow = Omit<TransferRecord, 'id' | 'created_at' | 'updated_at'>;

function nowIso(now?: () => string): string {
  return (now ?? (() => new Date().toISOString()))();
}

// ---------------------------------------------------------------------
// pending_out — freeze the cost parcel exactly once, from the source
// holding's state immediately before this TOT.
// ---------------------------------------------------------------------

export type CaptureTransferOutParams = {
  outTransactionId: string;
  quantity: number;
  linkedBy?: TransferLinkedBy;
  now?: () => string;
};

/**
 * Applies the TOT to `sourceHolding` via applyTransferOut — EXACTLY ONCE —
 * and builds the pending_out row from the resulting parcel.
 *
 * Caller contract (this is what guarantees "exactly once"): `sourceHolding`
 * must already reflect every OTHER transaction on this (portfolio, asset)
 * up to but NOT INCLUDING this TOT (i.e. produced by replaying the prior
 * history with applyTransactionToHolding, the normal replay function). This
 * function performs the TOT's removal itself, via applyTransferOut — the
 * normal replay's own TOT branch of applyTransactionToHolding must NOT also
 * be run for this same row, or the cost would be removed twice. See
 * tests/financial/transfers.spec.ts's "exactly once" regression test.
 */
export function captureTransferOut(
  sourceHolding: Holding,
  params: CaptureTransferOutParams
): { parcel: CostParcel; transfer: NewTransferRow } {
  const parcel = applyTransferOut(sourceHolding, params.quantity);
  const ts = nowIso(params.now);

  const baseCostStatus: BaseCostStatus | null = parcel.baseCost != null ? 'verified' : null;

  const transfer: NewTransferRow = {
    status: 'pending_out',
    out_transaction_id: params.outTransactionId,
    in_transaction_id: null,
    asset_id: parcel.assetId,
    quantity: parcel.quantity,
    native_cost: parcel.nativeCost,
    native_ccy: parcel.nativeCcy,
    base_cost: parcel.baseCost ?? null,
    base_ccy: parcel.baseCcy ?? null,
    base_cost_status: baseCostStatus,
    linked_by: params.linkedBy ?? null,
    linked_at: null,
    match_confidence: null,
    notes: null,
  };

  return { parcel, transfer };
}

// ---------------------------------------------------------------------
// pending_in — record shares/asset/quantity only. No invented cost.
// ---------------------------------------------------------------------

export type CapturePendingInParams = {
  inTransactionId: string;
  assetId: string;
  quantity: number;
};

export function capturePendingIn(params: CapturePendingInParams): NewTransferRow {
  return {
    status: 'pending_in',
    out_transaction_id: null,
    in_transaction_id: params.inTransactionId,
    asset_id: params.assetId,
    quantity: Math.abs(params.quantity),
    native_cost: null,
    native_ccy: null,
    base_cost: null,
    base_ccy: null,
    base_cost_status: null,
    linked_by: null,
    linked_at: null,
    match_confidence: null,
    notes: null,
  };
}

// ---------------------------------------------------------------------
// Matching — explicit confirmation only. No fuzzy/auto matching here.
// ---------------------------------------------------------------------

export class TransferMatchError extends Error {}

/**
 * Pure validation + merge for confirming a pending_out and a pending_in are
 * the same transfer. Mirrors confirm_transfer_match()'s SQL-level checks
 * exactly, so the same invariant is enforced at both the app layer (fast
 * feedback, unit-testable without a DB) and the DB layer (the actual source
 * of truth once persisted).
 *
 * The result always carries the pending_out's frozen cost fields forward
 * completely unchanged (spread first, then only status/in_transaction_id/
 * linked_at/updated_at are overwritten) — matching never recomputes cost.
 */
export function matchTransfer(
  pendingOut: TransferRecord,
  pendingIn: TransferRecord,
  opts?: { linkedBy?: TransferLinkedBy; now?: () => string }
): TransferRecord {
  if (pendingOut.status !== 'pending_out') {
    throw new TransferMatchError(`matchTransfer: expected pending_out, got ${pendingOut.status}`);
  }
  if (pendingIn.status !== 'pending_in') {
    throw new TransferMatchError(`matchTransfer: expected pending_in, got ${pendingIn.status}`);
  }
  if (!pendingIn.in_transaction_id) {
    throw new TransferMatchError('matchTransfer: pendingIn has no in_transaction_id');
  }
  if (pendingOut.asset_id !== pendingIn.asset_id) {
    throw new TransferMatchError(
      `matchTransfer: asset mismatch (${pendingOut.asset_id} vs ${pendingIn.asset_id})`
    );
  }
  if (Math.abs(pendingOut.quantity - pendingIn.quantity) > 1e-6) {
    throw new TransferMatchError(
      `matchTransfer: quantity mismatch (${pendingOut.quantity} vs ${pendingIn.quantity})`
    );
  }

  const ts = nowIso(opts?.now);
  return {
    ...pendingOut,
    status: 'matched',
    in_transaction_id: pendingIn.in_transaction_id,
    linked_by: opts?.linkedBy ?? 'manual',
    linked_at: ts,
    updated_at: ts,
  };
}

// ---------------------------------------------------------------------
// External states
// ---------------------------------------------------------------------

export function confirmExternalOut(
  pendingOut: TransferRecord,
  opts?: { linkedBy?: TransferLinkedBy; now?: () => string }
): TransferRecord {
  if (pendingOut.status !== 'pending_out') {
    throw new TransferMatchError(`confirmExternalOut: expected pending_out, got ${pendingOut.status}`);
  }
  const ts = nowIso(opts?.now);
  return {
    ...pendingOut,
    status: 'external_out',
    linked_by: opts?.linkedBy ?? 'manual',
    linked_at: ts,
    updated_at: ts,
  };
}

export type ExternalInCost = {
  nativeCost: number;
  nativeCcy: string;
  baseCost?: number;
  baseCcy?: string;
};

/**
 * Confirms a pending_in as an external transfer-in. Requires an explicit
 * native historical cost (never derived from transfer-date market value).
 * Base cost is optional; if supplied it is recorded as 'verified' — the
 * user is asserting it directly, the same trust level as a manual entry
 * anywhere else in the app.
 */
export function confirmExternalIn(
  pendingIn: TransferRecord,
  cost: ExternalInCost,
  opts?: { linkedBy?: TransferLinkedBy; now?: () => string }
): TransferRecord {
  if (pendingIn.status !== 'pending_in') {
    throw new TransferMatchError(`confirmExternalIn: expected pending_in, got ${pendingIn.status}`);
  }
  if (cost.nativeCost == null || !isFinite(cost.nativeCost)) {
    throw new TransferMatchError('confirmExternalIn: an explicit native historical cost is required');
  }
  if (!cost.nativeCcy) {
    throw new TransferMatchError('confirmExternalIn: native currency is required alongside native cost');
  }
  const baseProvided = cost.baseCost != null;
  if (baseProvided && !cost.baseCcy) {
    throw new TransferMatchError('confirmExternalIn: base currency is required when a base cost is supplied');
  }

  const ts = nowIso(opts?.now);
  return {
    ...pendingIn,
    status: 'external_in',
    native_cost: cost.nativeCost,
    native_ccy: cost.nativeCcy.toUpperCase(),
    base_cost: baseProvided ? cost.baseCost! : null,
    base_ccy: baseProvided ? cost.baseCcy!.toUpperCase() : null,
    base_cost_status: baseProvided ? 'verified' : null,
    linked_by: opts?.linkedBy ?? 'manual',
    linked_at: ts,
    updated_at: ts,
  };
}
