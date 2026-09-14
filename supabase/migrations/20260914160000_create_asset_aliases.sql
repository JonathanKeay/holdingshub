-- Canonical asset alias resolution for CSV import (importer stabilisation,
-- item 2). See the CAKE.US investigation: an eToro export represents
-- Cheesecake Factory as "CAKE.US", which HoldingsHub already holds as the
-- canonical asset "CAKE" — but nothing before this migration lets the
-- importer know those two strings mean the same real instrument. Blind
-- suffix-stripping (dropping ".US") was deliberately rejected: ".L" and
-- ".DE" are meaningful, canonical HoldingsHub suffixes (see LLOY.L, SAP.DE
-- in this DEV data), so a generic "strip anything after a dot" rule would
-- silently corrupt those. This adds a small, explicit many-to-one alias
-- table instead: only an EXACT, deliberately-created alias ever resolves —
-- nothing is ever guessed.
--
-- Why not reuse assets.resolved_ticker for this? resolved_ticker already has
-- a job: a single manually-set PRICE-PROVIDER symbol override (e.g.
-- VOD -> VOD.L, so the historical-chart/diagnostic code knows what to ask
-- Yahoo for — see src/app/api/portfolio-series/route.ts and
-- src/app/api/prices/debug/route.ts). It is a one-value-per-asset field.
-- Reusing it as a broker-alias slot would mean an asset that legitimately
-- needs a price-provider override could never also carry an import alias
-- (and vice versa) — the two purposes would collide in one column. Keeping
-- them separate avoids that collision entirely and keeps resolved_ticker's
-- existing, working behaviour completely untouched.
--
-- Global vs source-specific: aliases here are GLOBAL (alias string alone is
-- unique, independent of which broker/source it came from), not scoped to
-- e.g. "eToro + CAKE.US". Reasoning: HoldingsHub's CSV import format has no
-- broker/source field anywhere in its pipeline today (see
-- src/app/api/import-transactions/route.ts's CSV schema — portfolio,
-- ticker, transaction_type, date_time, quantity, price, fee, fxrate,
-- cash_value, notes; nothing else) — there is no real "source" signal to
-- scope aliases by, so a source column would sit permanently unused. Adding
-- one now, before any actual multi-broker symbol collision has ever been
-- observed, would be speculative complexity for a problem that doesn't
-- exist yet. Every alias is also created deliberately and manually (never
-- auto-invented by suffix-guessing), so the user sees exactly what they're
-- mapping at creation time, which keeps the practical collision risk low
-- for a single-user tracker. If a genuine cross-broker collision is ever
-- hit, a `source` column can be added later (and the UNIQUE constraint
-- below changed to (source, alias)) without disturbing existing data — it
-- is a strictly additive migration from here, not a redesign.
--
-- Shared reference data, same model as `assets` itself (see
-- 20260914100300_rls_shared_reference_data.sql): every user's import
-- benefits from the same alias, there is no per-user ownership concept for
-- "CAKE.US means CAKE", and mutation happens only through service_role or a
-- validated server route — never a direct authenticated-browser write. That
-- keeps ordinary portfolio/import use from ever being able to corrupt a
-- shared alias mapping, matching the security model established in
-- c105c56 ("Harden portfolio ownership and RLS").

create table "public"."asset_aliases" (
  "id"         uuid                        not null default gen_random_uuid(),
  "alias"      text                        not null,
  "asset_id"   uuid                        not null,
  "created_at" timestamp with time zone    not null default now(),
  constraint "asset_aliases_pkey" primary key (id),
  constraint "asset_aliases_asset_id_fkey" foreign key (asset_id) references public.assets(id) on delete cascade,
  -- One alias can only ever point at one asset. Storage is required to
  -- already be normalized uppercase (matching how canonical `assets.ticker`
  -- values are stored) so this constraint can't be bypassed by case alone.
  constraint "asset_aliases_alias_key" unique (alias),
  constraint "asset_aliases_alias_upper_chk" check (alias = upper(alias)),
  constraint "asset_aliases_alias_not_blank_chk" check (length(btrim(alias)) > 0)
);

create index "asset_aliases_asset_id_idx" on public.asset_aliases (asset_id);

-- Same read/write shape as `assets`: authenticated users can read (the
-- importer's client-side preview logic and the Asset Edit admin page both
-- need this), nobody gets a direct write grant. service_role (the CSV
-- importer's alias lookup, and the new /api/asset-aliases admin route)
-- bypasses RLS entirely, same as every other shared-reference table.
revoke all on public.asset_aliases from public, anon, authenticated;
grant select on public.asset_aliases to authenticated;

alter table public.asset_aliases enable row level security;

create policy asset_aliases_select_all on public.asset_aliases
  for select to authenticated
  using (true);

-- No INSERT/UPDATE/DELETE policies — matches assets/prices/price_history/
-- fx_rates. All writes go through service_role via the validated
-- /api/asset-aliases route (session required, service-role used
-- internally), never a direct browser write.
