-- Portfolio ownership — finalize (Phase 1b).
--
-- Requires that every portfolio row already has a user_id — i.e. that this
-- environment's own backfill mechanism has already run (DEV:
-- scripts/dev/backfill-dev-ownership.ts; PROD: the separately-approved
-- PROD backfill procedure). This file itself contains no backfill and no
-- environment-specific values — it only enforces/relies on that
-- invariant and is safe to run, as written, against any environment where
-- the invariant already holds.
--
-- Each portfolio gets exactly one owner. No shared/multi-owner portfolios
-- are introduced here (out of scope per the agreed design).

-- Fail loudly (with a clear, specific message) rather than let the
-- NOT NULL constraint below fail with Postgres's generic "column contains
-- null values" error — if this fires, the environment's backfill step has
-- not been run yet (or did not cover every row).
do $$
declare
  orphaned int;
begin
  select count(*) into orphaned from public.portfolios where user_id is null;
  if orphaned > 0 then
    raise exception 'portfolio_ownership_finalize: % portfolio row(s) have no user_id — run this environment''s backfill first', orphaned;
  end if;
end $$;

alter table public.portfolios
  alter column user_id set not null;

create index idx_portfolios_user_id on public.portfolios (user_id);
