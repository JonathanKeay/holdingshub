// src/lib/transferPersistence.ts
//
// Thin Supabase-facing wrappers around the pure builders/validators in
// src/lib/transfers.ts. NOT called by any authenticated route or UI yet —
// there is still no user-facing way to confirm a transfer match — these
// exist as the persistence primitives that step is scoped to build on. Live
// holdings replay (src/lib/queries.ts) does not call these wrappers either,
// but it DOES consult their end result: once a transfer reaches matched/
// external_in/external_out (by whatever means — today, only directly), the
// dashboard/mobile replay resolves and applies it. See src/lib/transfers.ts
// for the current wiring status of each function this file wraps.
//
// Every write here touches only the `transfers` table. None of these
// functions ever update or delete a `transactions` row.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type NewTransferRow,
  type TransferRecord,
  type ExternalInCost,
  type TransferLinkedBy,
  confirmExternalIn as confirmExternalInPure,
  confirmExternalOut as confirmExternalOutPure,
} from './transfers';

async function insertTransfer(supabase: SupabaseClient, row: NewTransferRow): Promise<TransferRecord> {
  const { data, error } = await supabase.from('transfers').insert(row).select().single();
  if (error) throw error;
  return data as TransferRecord;
}

export async function insertPendingOut(supabase: SupabaseClient, row: NewTransferRow): Promise<TransferRecord> {
  return insertTransfer(supabase, row);
}

export async function insertPendingIn(supabase: SupabaseClient, row: NewTransferRow): Promise<TransferRecord> {
  return insertTransfer(supabase, row);
}

/**
 * Atomically confirms a pending_out + pending_in as the same transfer via
 * the confirm_transfer_match() DB function (see the Phase 1 migration) —
 * asset/quantity agreement and status checks are enforced there, in the
 * same transaction as the update+delete, under row locks.
 */
export async function confirmMatch(
  supabase: SupabaseClient,
  pendingOutId: string,
  pendingInId: string
): Promise<TransferRecord> {
  const { data, error } = await supabase.rpc('confirm_transfer_match', {
    p_pending_out_id: pendingOutId,
    p_pending_in_id: pendingInId,
  });
  if (error) throw error;
  return data as TransferRecord;
}

export async function confirmExternalOut(
  supabase: SupabaseClient,
  pendingOut: TransferRecord,
  opts?: { linkedBy?: TransferLinkedBy }
): Promise<TransferRecord> {
  const updated = confirmExternalOutPure(pendingOut, opts);
  const { data, error } = await supabase
    .from('transfers')
    .update({ status: updated.status, linked_by: updated.linked_by, linked_at: updated.linked_at, updated_at: updated.updated_at })
    .eq('id', pendingOut.id)
    .select()
    .single();
  if (error) throw error;
  return data as TransferRecord;
}

export async function confirmExternalIn(
  supabase: SupabaseClient,
  pendingIn: TransferRecord,
  cost: ExternalInCost,
  opts?: { linkedBy?: TransferLinkedBy }
): Promise<TransferRecord> {
  const updated = confirmExternalInPure(pendingIn, cost, opts);
  const { data, error } = await supabase
    .from('transfers')
    .update({
      status: updated.status,
      native_cost: updated.native_cost,
      native_ccy: updated.native_ccy,
      base_cost: updated.base_cost,
      base_ccy: updated.base_ccy,
      base_cost_status: updated.base_cost_status,
      linked_by: updated.linked_by,
      linked_at: updated.linked_at,
      updated_at: updated.updated_at,
    })
    .eq('id', pendingIn.id)
    .select()
    .single();
  if (error) throw error;
  return data as TransferRecord;
}
