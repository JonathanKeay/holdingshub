-- Row Level Security for user/portfolio-owned tables (Phase 3).
--
-- Model: portfolios are directly user-owned; transactions and
-- cash_balances inherit ownership from their portfolio_id; settings is
-- directly user-owned. `transfers` already has the correct pattern (RLS
-- enabled, zero policies, service_role only) from a previous migration and
-- is intentionally left unchanged here — it is not yet client-facing.
--
-- Pattern mirrors the one already used for `transfers`: revoke the
-- blanket anon/authenticated grants first, enable RLS, then grant back only
-- what `authenticated` needs (policies narrow it to the caller's own rows).
-- `anon` gets nothing on any of these tables — every page that touches
-- personal or financial data requires a logged-in session.

-- ------------------------------- portfolios -------------------------------
revoke all on public.portfolios from public, anon, authenticated;
grant select, insert, update, delete on public.portfolios to authenticated;

alter table public.portfolios enable row level security;

create policy portfolios_select_own on public.portfolios
  for select to authenticated
  using (user_id = auth.uid());

create policy portfolios_insert_own on public.portfolios
  for insert to authenticated
  with check (user_id = auth.uid());

create policy portfolios_update_own on public.portfolios
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy portfolios_delete_own on public.portfolios
  for delete to authenticated
  using (user_id = auth.uid());

-- ------------------------------ transactions ------------------------------
revoke all on public.transactions from public, anon, authenticated;
grant select, insert, update, delete on public.transactions to authenticated;

alter table public.transactions enable row level security;

create policy transactions_select_own on public.transactions
  for select to authenticated
  using (exists (
    select 1 from public.portfolios p
    where p.id = transactions.portfolio_id and p.user_id = auth.uid()
  ));

create policy transactions_insert_own on public.transactions
  for insert to authenticated
  with check (exists (
    select 1 from public.portfolios p
    where p.id = transactions.portfolio_id and p.user_id = auth.uid()
  ));

create policy transactions_update_own on public.transactions
  for update to authenticated
  using (exists (
    select 1 from public.portfolios p
    where p.id = transactions.portfolio_id and p.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.portfolios p
    where p.id = transactions.portfolio_id and p.user_id = auth.uid()
  ));

create policy transactions_delete_own on public.transactions
  for delete to authenticated
  using (exists (
    select 1 from public.portfolios p
    where p.id = transactions.portfolio_id and p.user_id = auth.uid()
  ));

-- ------------------------------ cash_balances ------------------------------
-- Currently unused by application code (no reads or writes anywhere in
-- src/), but given the same ownership treatment as transactions for
-- consistency/safety in case it is ever revived.
revoke all on public.cash_balances from public, anon, authenticated;
grant select, insert, update, delete on public.cash_balances to authenticated;

alter table public.cash_balances enable row level security;

create policy cash_balances_select_own on public.cash_balances
  for select to authenticated
  using (exists (
    select 1 from public.portfolios p
    where p.id = cash_balances.portfolio_id and p.user_id = auth.uid()
  ));

create policy cash_balances_insert_own on public.cash_balances
  for insert to authenticated
  with check (exists (
    select 1 from public.portfolios p
    where p.id = cash_balances.portfolio_id and p.user_id = auth.uid()
  ));

create policy cash_balances_update_own on public.cash_balances
  for update to authenticated
  using (exists (
    select 1 from public.portfolios p
    where p.id = cash_balances.portfolio_id and p.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.portfolios p
    where p.id = cash_balances.portfolio_id and p.user_id = auth.uid()
  ));

create policy cash_balances_delete_own on public.cash_balances
  for delete to authenticated
  using (exists (
    select 1 from public.portfolios p
    where p.id = cash_balances.portfolio_id and p.user_id = auth.uid()
  ));

-- --------------------------------- settings ---------------------------------
revoke all on public.settings from public, anon, authenticated;
grant select, insert, update on public.settings to authenticated;

alter table public.settings enable row level security;

create policy settings_select_own on public.settings
  for select to authenticated
  using (user_id = auth.uid());

create policy settings_insert_own on public.settings
  for insert to authenticated
  with check (user_id = auth.uid());

create policy settings_update_own on public.settings
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- No delete policy/grant for settings: nothing in the app deletes a
-- settings row, and there's no product need for a user to delete their own
-- preferences row today.
