-- Transfer persistence / matching foundation (Phase 1).
--
-- Represents an in-specie (TIN/TOT) transfer as its own record, independent
-- of whichever transaction leg(s) have been imported so far. The two legs
-- may arrive minutes or months apart, in either order, from separate broker
-- exports. Original `transactions` rows are NEVER modified by anything in
-- this table or its supporting function — they remain an immutable audit
-- record of what was imported. The authoritative transferred cost basis
-- lives here, as a frozen "cost parcel" snapshot captured once, at
-- transfer-out time (see the CostParcel type in
-- src/lib/transferCostBasis.ts and the capture semantics in
-- src/lib/transfers.ts).
--
-- Five states:
--   pending_out  — TOT recorded, no matching TIN yet. Parcel already frozen.
--   pending_in   — TIN recorded, no matching TOT yet. Cost genuinely unknown
--                  (never a transfer-date market-value guess).
--   matched      — a pending_out and a pending_in have been confirmed by the
--                  user as the same transfer. The pending_out row survives
--                  (its frozen parcel is authoritative); the corresponding
--                  pending_in row is deleted by confirm_transfer_match().
--   external_out — confirmed: no HoldingsHub destination exists. The frozen
--                  parcel is retained for audit even though nothing consumes it.
--   external_in  — confirmed: no HoldingsHub source exists. Native cost (and
--                  optionally base cost) is supplied explicitly by the user,
--                  stored here — never written back onto the transaction.

create table transfers (
  id                 uuid primary key default gen_random_uuid(),
  status             text not null check (status in
                        ('pending_out','pending_in','matched','external_in','external_out')),

  out_transaction_id uuid references transactions(id),
  in_transaction_id  uuid references transactions(id),

  asset_id           uuid not null references assets(id),
  quantity           numeric not null check (quantity > 0),

  -- Frozen at pending_out (or external_in) time. Never recomputed later
  -- merely because a match happens or time passes.
  native_cost        numeric,
  native_ccy         text,
  base_cost          numeric,
  base_ccy           text,
  base_cost_status   text check (base_cost_status in ('verified','unreliable')),

  linked_by          text check (linked_by in ('manual','import_suggested','historical_repair')),
  linked_at          timestamptz,
  match_confidence   text,
  notes              text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Each transaction may participate in at most one transfer record. A plain
  -- UNIQUE constraint is correct here: Postgres treats every NULL as
  -- distinct from every other NULL, so any number of pending_in/external_in
  -- rows (out_transaction_id = null) — or pending_out/external_out rows
  -- (in_transaction_id = null) — coexist without conflict.
  constraint uq_transfers_out_transaction unique (out_transaction_id),
  constraint uq_transfers_in_transaction  unique (in_transaction_id),

  constraint chk_transaction_ids_by_status check (
    (status = 'pending_out'  and out_transaction_id is not null and in_transaction_id is null) or
    (status = 'pending_in'   and in_transaction_id  is not null and out_transaction_id is null) or
    (status = 'matched'      and out_transaction_id is not null and in_transaction_id  is not null) or
    (status = 'external_out' and out_transaction_id is not null and in_transaction_id is null) or
    (status = 'external_in'  and in_transaction_id  is not null and out_transaction_id is null)
  ),

  -- native cost is captured for every status except pending_in (where it is
  -- genuinely not yet known).
  constraint chk_native_cost_by_status check (
    (status = 'pending_in' and native_cost is null and native_ccy is null)
    or (status <> 'pending_in' and native_cost is not null and native_ccy is not null)
  ),

  -- base cost can never exist without native cost (there is nothing to
  -- express a portfolio-base figure for otherwise), and can never exist
  -- without an accompanying verified/unreliable label. Unknown base cost is
  -- represented as NULL — never a fabricated 0.
  constraint chk_base_cost_requires_native check (
    base_cost is null or native_cost is not null
  ),
  constraint chk_base_cost_status_pairing check (
    (base_cost is null and base_cost_status is null)
    or (base_cost is not null and base_cost_status is not null)
  )
);

create index idx_transfers_status on transfers (status);
create index idx_transfers_asset  on transfers (asset_id);

comment on table transfers is
  'Pending/confirmed in-specie transfer records. See migration header comment for the state model. Original transactions rows are never modified by this table.';

-- Atomically confirm that a pending_out and a pending_in are the same
-- transfer. Runs as a single implicit transaction (the whole function body),
-- with row locks to prevent a concurrent confirm racing the same rows.
-- The pending_out row survives (status -> matched, gains in_transaction_id);
-- its frozen native_cost/native_ccy/base_cost/base_ccy/base_cost_status are
-- untouched by this function. The pending_in row is deleted — its only
-- useful information (the in_transaction_id) has been absorbed into the
-- surviving row.
create or replace function confirm_transfer_match(
  p_pending_out_id uuid,
  p_pending_in_id  uuid
) returns transfers
language plpgsql
as $$
declare
  v_out transfers;
  v_in  transfers;
  v_result transfers;
begin
  select * into v_out from transfers where id = p_pending_out_id for update;
  if not found then
    raise exception 'confirm_transfer_match: no transfer % found', p_pending_out_id;
  end if;

  select * into v_in from transfers where id = p_pending_in_id for update;
  if not found then
    raise exception 'confirm_transfer_match: no transfer % found', p_pending_in_id;
  end if;

  if v_out.status <> 'pending_out' then
    raise exception 'confirm_transfer_match: transfer % is not pending_out (status=%)', p_pending_out_id, v_out.status;
  end if;
  if v_in.status <> 'pending_in' then
    raise exception 'confirm_transfer_match: transfer % is not pending_in (status=%)', p_pending_in_id, v_in.status;
  end if;
  if v_out.asset_id <> v_in.asset_id then
    raise exception 'confirm_transfer_match: asset mismatch (% vs %)', v_out.asset_id, v_in.asset_id;
  end if;
  if v_out.quantity <> v_in.quantity then
    raise exception 'confirm_transfer_match: quantity mismatch (% vs %)', v_out.quantity, v_in.quantity;
  end if;

  update transfers
    set status = 'matched',
        in_transaction_id = v_in.in_transaction_id,
        linked_at = now(),
        updated_at = now()
    where id = p_pending_out_id
    returning * into v_result;

  delete from transfers where id = p_pending_in_id;

  return v_result;
end;
$$;

comment on function confirm_transfer_match(uuid, uuid) is
  'Atomically links a pending_out and a pending_in as the same transfer. The pending_out row survives with its frozen parcel unchanged; the pending_in row is deleted.';

-- ---------------------------------------------------------------------
-- Security hardening: this transfer layer is NOT a client-facing feature
-- yet (see src/lib/transferPersistence.ts's header comment — nothing in
-- the app calls it). Until a proper auth/multi-user RLS design exists,
-- only trusted server-side code (service_role, which already holds
-- SUPABASE_SERVICE_ROLE_KEY for the existing import route) should be able
-- to read or mutate it at all.
--
-- A bare CREATE TABLE in the public schema on this project inherits broad
-- default privileges (this project's ALTER DEFAULT PRIVILEGES grants full
-- SELECT/INSERT/UPDATE/DELETE on every new public-schema table to anon AND
-- authenticated) with RLS disabled — meaning, unhardened, any client
-- holding just the anon key could read or write transfers directly via
-- PostgREST. Enabling RLS with NO policies denies every row to anon/
-- authenticated (neither role has BYPASSRLS), while service_role
-- (BYPASSRLS = true in this project) is completely unaffected by RLS
-- either way — so this is pure hardening with no effect on the only role
-- that is meant to use this table today.
-- ---------------------------------------------------------------------

alter table transfers enable row level security;

revoke all on transfers from public, anon, authenticated;
grant select, insert, update, delete on transfers to service_role;

revoke execute on function confirm_transfer_match(uuid, uuid) from public, anon, authenticated;
grant execute on function confirm_transfer_match(uuid, uuid) to service_role;

-- Explicit search_path: prevents the function's unqualified references
-- (e.g. `transfers`) from ever resolving against an object earlier in some
-- other search_path, regardless of security mode. Standard hardening for
-- any function, invoker or definer.
alter function confirm_transfer_match(uuid, uuid) set search_path = public, pg_temp;
