-- Shared reference/market data (Phase 4).
--
-- assets, prices, price_history and fx_rates are NOT user-owned — the same
-- AAPL row, price and FX rate are correct for every user. Per the approved
-- design:
--   - everyone who is logged in (and, for these specifically, even
--     anonymous callers — see the note below) may READ this data.
--   - ordinary authenticated users must NOT get unrestricted direct
--     INSERT/UPDATE/DELETE. Mutations happen only through service_role
--     (the price streamer, the logo updater, the CSV importer's new-asset
--     creation) or, for the one genuine end-user editing feature (manual
--     asset metadata correction), a controlled server-side API route that
--     validates input and uses service_role internally — never a direct
--     browser write. That route is added separately in the app-code phase
--     of this change.
--
-- SELECT is granted to `anon` as well as `authenticated`, deliberately:
-- two existing, intentionally-public, low-sensitivity endpoints
-- (/api/prices/version, /api/prices/health) read `prices`/`price_history`
-- without requiring a session, and this data carries no personal or
-- financial-position information on its own (just market prices/FX/ticker
-- metadata) — unlike portfolios/transactions, there is nothing here that
-- distinguishes one user from another.

-- ---------------------------------- assets ----------------------------------
revoke all on public.assets from public, anon, authenticated;
grant select on public.assets to anon, authenticated;

alter table public.assets enable row level security;

create policy assets_select_all on public.assets
  for select to anon, authenticated
  using (true);

-- ---------------------------------- prices ----------------------------------
revoke all on public.prices from public, anon, authenticated;
grant select on public.prices to anon, authenticated;

alter table public.prices enable row level security;

create policy prices_select_all on public.prices
  for select to anon, authenticated
  using (true);

-- ------------------------------ price_history -------------------------------
revoke all on public.price_history from public, anon, authenticated;
grant select on public.price_history to anon, authenticated;

alter table public.price_history enable row level security;

create policy price_history_select_all on public.price_history
  for select to anon, authenticated
  using (true);

-- --------------------------------- fx_rates ---------------------------------
revoke all on public.fx_rates from public, anon, authenticated;
grant select on public.fx_rates to anon, authenticated;

alter table public.fx_rates enable row level security;

create policy fx_rates_select_all on public.fx_rates
  for select to anon, authenticated
  using (true);

-- No INSERT/UPDATE/DELETE policies on any of the four tables above — none
-- are needed. service_role bypasses RLS entirely (BYPASSRLS = true in this
-- project), so the price streamer, logo updater and CSV importer are
-- completely unaffected by this migration.
