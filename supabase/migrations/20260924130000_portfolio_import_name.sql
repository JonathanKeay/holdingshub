-- Portfolio import names (C18).
--
-- A CSV row's `portfolio` value must match one of the importing user's
-- portfolios EXACTLY (surrounding whitespace and letter case ignored) — no
-- substring, prefix or similar-name matching. See docs/ACCOUNTING.md §12 and
-- src/lib/portfolioNameMatch.ts.
--
-- The display `name` may carry cosmetic detail the broker export doesn't,
-- e.g. "IBKR ISA STK (U9407868)" while the IBKR import file says
-- "IBKR ISA STK". Rather than guess by stripping a recognised suffix (the
-- same approach deliberately rejected for asset tickers in
-- 20260914160000_create_asset_aliases.sql), each portfolio may carry one
-- explicit `import_name`. A portfolio's EFFECTIVE import name is
-- `coalesce(import_name, name)`: when import_name is set, the display name is
-- NOT also accepted. When it is null, the display name is used, so
-- portfolios whose display name already equals their CSV name need nothing.
--
-- Uniqueness is enforced on the effective import name, per owner, so one
-- portfolio's import_name can never equal another portfolio's display name
-- that is acting as its import name (or another import_name). The importer
-- still rejects an ambiguous match at run time as a second guard.

-- The comparison key. Must stay identical to portfolioNameKey() in
-- src/lib/portfolioNameMatch.ts: remove surrounding whitespace, lower-case,
-- nothing else. The whitespace set is spelled out (it equals JavaScript's
-- String.prototype.trim set) instead of using \s, whose meaning depends on
-- the database locale. A key that is empty after trimming is NULL, so such a
-- portfolio has no import name and takes no part in uniqueness.
-- Used by a unique index: changing its body requires a REINDEX.
create function public.portfolio_import_key(value text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(
    lower(
      regexp_replace(
        value,
        '^[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$',
        '',
        'g'
      )
    ),
    ''
  )
$$;

alter table public.portfolios
  add column import_name text;

comment on column public.portfolios.import_name is
  'Exact portfolio name accepted from CSV imports (trimmed, case-insensitive). '
  'Null = the display name is used. When set, the display name is not accepted.';

-- When present, import_name must not be blank after trimming.
alter table public.portfolios
  add constraint portfolios_import_name_not_blank
  check (import_name is null or public.portfolio_import_key(import_name) is not null);

-- One owner cannot have two portfolios with the same effective import name.
create unique index portfolios_user_effective_import_name_key
  on public.portfolios (user_id, public.portfolio_import_key(coalesce(import_name, name)));
