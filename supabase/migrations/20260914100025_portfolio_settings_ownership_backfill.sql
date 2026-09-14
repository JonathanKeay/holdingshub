-- Portfolio + settings ownership backfill (Phase 1a.5 / 2a.5).
--
-- Positioned between the "structure" migrations (...100010, ...100020,
-- which add nullable user_id columns) and the "finalize" migrations
-- (...100030, ...100040, which make user_id NOT NULL and, for settings,
-- re-key the primary key). This is the step that actually decides WHO
-- existing pre-multi-user data belongs to.
--
-- Contains NO hardcoded UUID (neither a DEV id nor a PROD id) and no
-- hardcoded email — it is safe to run, as written, against any
-- environment, because "who owns the existing data" is derived entirely
-- from that environment's own auth.users table at migration time:
--
--   - Every environment this migration is designed for (DEV today; PROD,
--     once this migration is separately approved to run there) has
--     pre-existing portfolios/settings data that predates multi-user
--     support, together with exactly one signed-up auth user. In that
--     state, "the existing data belongs to the one user who has ever
--     signed in" is the only answer that is not a guess.
--   - If that invariant does not hold — no auth user yet, or more than
--     one — there is no safe automatic answer, and this migration aborts
--     loudly rather than attaching pre-existing financial data to the
--     wrong account, or to an arbitrarily-chosen one.
--
-- This mirrors scripts/dev/backfill-dev-ownership.ts's guard logic
-- (abort on zero or >1 candidate) but is not that script: this file is a
-- committed part of the real migration sequence and is the mechanism
-- intended for PROD's own backfill once separately approved for that
-- environment. backfill-dev-ownership.ts additionally hardcodes one
-- specific email and a "not a hosted URL" check purely as belt-and-braces
-- safety for ad hoc local rehearsal, and is never applied as a migration
-- in any environment.
--
-- Idempotent: every UPDATE below only touches rows that still have no
-- user_id, so re-running this migration after it has already succeeded
-- changes nothing.
--
-- Does not touch shared reference data (assets/prices/price_history/
-- fx_rates/asset_aliases) or transactions/cash_balances directly — only
-- portfolios.user_id and settings.user_id are set. Existing portfolio ids
-- and all financial figures are untouched.

do $$
declare
  v_user_count        int;
  v_user_id           uuid;
  v_orphaned_portfolios int;
  v_orphaned_settings   int;
begin
  select count(*) into v_user_count from auth.users;

  if v_user_count = 0 then
    raise exception
      'portfolio_settings_ownership_backfill: no auth.users rows exist in this environment — cannot determine who owns the existing portfolios/settings. Create (or confirm) the intended user first, then re-run this migration.';
  end if;

  if v_user_count > 1 then
    raise exception
      'portfolio_settings_ownership_backfill: % auth.users rows exist — refusing to guess which one owns the existing pre-multi-user portfolios/settings. Resolve ownership with a deliberate, reviewed backfill before this migration can proceed.',
      v_user_count;
  end if;

  select id into v_user_id from auth.users limit 1;

  -- Portfolios: only rows still left NULL by the structure migration —
  -- i.e. every portfolio that predates multi-user support. Row ids and
  -- every other column are untouched.
  update public.portfolios
    set user_id = v_user_id
    where user_id is null;

  -- Settings: same idempotent shape. Pre-multi-user this table was a
  -- singleton ('global') row; whichever row(s) still have no owner become
  -- this user's. Only user_id changes — show_zero_holdings/
  -- visible_statuses/portfolio_prefs are untouched.
  update public.settings
    set user_id = v_user_id
    where user_id is null;

  -- Verify before allowing this migration to succeed: the *_finalize
  -- migrations that follow require zero NULL user_id rows to set the
  -- column NOT NULL without themselves failing. Checking it here, with a
  -- specific message, is deliberately redundant with that later failure —
  -- it fails at the step that actually made the ownership decision,
  -- rather than downstream.
  select count(*) into v_orphaned_portfolios from public.portfolios where user_id is null;
  select count(*) into v_orphaned_settings from public.settings where user_id is null;

  if v_orphaned_portfolios > 0 or v_orphaned_settings > 0 then
    raise exception
      'portfolio_settings_ownership_backfill: backfill incomplete after assigning ownership to % — % portfolio row(s) and % settings row(s) still have no user_id.',
      v_user_id, v_orphaned_portfolios, v_orphaned_settings;
  end if;

  raise notice 'portfolio_settings_ownership_backfill: portfolios and settings backfilled to user %', v_user_id;
end $$;
