-- Portfolio ownership — structure only (multi-user foundation, Phase 1a).
--
-- Adds the ownership column and its foreign key. Deliberately contains NO
-- backfill and NO environment-specific values — this file is safe to run
-- against any environment (including, eventually, PROD) exactly as
-- written, at any point, regardless of what data already exists.
--
-- Nullable for now: existing portfolio rows (in ANY environment that
-- already has data) get no value here. A separate, explicitly
-- environment-specific backfill step must populate user_id before
-- 20260914100030_portfolio_ownership_finalize.sql can safely make it
-- NOT NULL. For DEV, that backfill is
-- scripts/dev/backfill-dev-ownership.ts (guarded, DEV-only, never a
-- migration). For PROD, it is the separately-approved PROD backfill
-- procedure using PROD's own auth.users row — never this file, and never
-- any DEV-derived value.
alter table public.portfolios
  add column user_id uuid references auth.users(id);
