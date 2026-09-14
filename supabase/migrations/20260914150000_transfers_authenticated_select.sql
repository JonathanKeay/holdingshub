-- Authenticated read access for transfers (Phase 6).
--
-- `transfers` has actually been read by the live dashboard/mobile financial
-- calculations (src/lib/queries.ts's getPortfoliosWithHoldingsAndCash and
-- getAllHoldingsAndCashSummary) since commit ddbe0cf ("Use resolved
-- transfer cost in holdings replay") — despite the Phase 1 migration's
-- header comment describing this table as "not yet client-facing", and
-- despite the RLS-hardening migration (20260914100200_rls_owned_tables.sql)
-- explicitly leaving it untouched on that same stale assumption.
--
-- Because `authenticated` has never had any grant on this table, every
-- authenticated read has been failing with a permission-denied error, which
-- the calling code (before this change) silently converted into an empty
-- transfer set. That made every TIN/TOT fall back to legacy,
-- pre-transfer-resolution cost behaviour for every real user, on every page
-- load, with no indication anything had gone wrong — see the transfer
-- financial-correctness investigation for the full analysis and confirmed
-- financial impact (PLTR, PYPL, POLB.L in DEV).
--
-- This grants SELECT only. INSERT/UPDATE/DELETE remain service_role-only:
-- there is still no authenticated-facing UI for creating or confirming a
-- transfer match, and opening a direct authenticated write path is a
-- separate decision from fixing the read-path regression this migration
-- addresses.
--
-- Ownership model: `transfers` gets no user_id column. Ownership is derived
-- through whichever transaction leg(s) a row carries -> that transaction's
-- portfolio -> portfolios.user_id — the same pattern already used for
-- cash_balances. A transfer is visible only when EVERY non-null leg it
-- carries belongs to the caller:
--   - pending_out / external_out (out_transaction_id set, in_transaction_id
--     null): the OUT leg's owner must be the caller.
--   - pending_in / external_in (in_transaction_id set, out_transaction_id
--     null): the IN leg's owner must be the caller.
--   - matched (both set): BOTH legs' owners must be the caller.
-- AND (not OR) semantics are deliberate: under the current one-owner-per-
-- portfolio model (no shared portfolios), a matched transfer's two legs
-- should always share one owner. Should the matching layer ever produce a
-- cross-user row despite that (a defect, not an intended state — see
-- src/lib/transferMatching.ts's ownership scoping added alongside this
-- migration), AND semantics make that row invisible to BOTH users rather
-- than disclosing it to either; OR semantics would leak it to whichever
-- side happens to query it.

grant select on public.transfers to authenticated;

create policy transfers_select_own on public.transfers
  for select to authenticated
  using (
    (
      transfers.out_transaction_id is null
      or exists (
        select 1 from public.transactions t
        join public.portfolios p on p.id = t.portfolio_id
        where t.id = transfers.out_transaction_id and p.user_id = auth.uid()
      )
    )
    and (
      transfers.in_transaction_id is null
      or exists (
        select 1 from public.transactions t
        join public.portfolios p on p.id = t.portfolio_id
        where t.id = transfers.in_transaction_id and p.user_id = auth.uid()
      )
    )
  );
