-- Per-user settings — structure only (Phase 2a).
--
-- Adds the ownership column and its foreign key to the settings table
-- (still keyed by the old `id text` singleton PK at this point — that PK
-- is only replaced once every row has a user_id, in the finalize
-- migration below). Contains NO backfill and NO environment-specific
-- values — safe to run against any environment as written.
--
-- See 20260914100010_portfolio_ownership_structure.sql for why the
-- backfill step is deliberately not part of this migration, and where
-- each environment's own backfill mechanism lives.
alter table public.settings
  add column user_id uuid references auth.users(id);
