-- Per-user settings — finalize (Phase 2b).
--
-- Requires that every settings row already has a user_id — i.e. that this
-- environment's own backfill mechanism has already run (see the matching
-- note in 20260914100030_portfolio_ownership_finalize.sql). This file
-- itself contains no backfill and no environment-specific values.
--
-- `settings` was a single global singleton row (id = 'global') holding
-- show_zero_holdings / visible_statuses / portfolio_prefs (column order,
-- hidden state, theme). Per the approved design, all of this is personal
-- configuration and must belong to the individual authenticated user, not
-- be shared app-wide.

do $$
declare
  orphaned int;
begin
  select count(*) into orphaned from public.settings where user_id is null;
  if orphaned > 0 then
    raise exception 'settings_per_user_finalize: % settings row(s) have no user_id — run this environment''s backfill first', orphaned;
  end if;
end $$;

alter table public.settings
  alter column user_id set not null;

-- Re-key: user_id replaces the old text 'global' id as the primary key.
alter table public.settings drop constraint settings_pkey;
alter table public.settings add constraint settings_pkey primary key (user_id);

-- The old singleton id column no longer means anything once every row is
-- keyed by its owning user — dropping it rather than leaving a vestigial,
-- always-'global' column behind.
alter table public.settings drop column id;
