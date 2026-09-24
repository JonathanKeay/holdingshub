-- Database checks for C18 portfolio import names
-- (supabase/migrations/20260924130000_portfolio_import_name.sql).
--
-- LOCAL DEV DATABASE ONLY. Never run against PROD. Everything runs inside
-- one transaction that ALWAYS rolls back: two throwaway auth users and their
-- portfolios are created and discarded, and no existing row is touched.
--
-- Run:
--   docker exec -i supabase_db_holdingshub psql -U postgres -v ON_ERROR_STOP=1 \
--     < tests/db/portfolio-import-name.check.sql
-- Prints "C18 DB CHECKS PASSED" on success; any failed check raises an error.

begin;

insert into auth.users (id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000c1801', 'authenticated', 'authenticated', 'c18-check-owner-a@example.invalid'),
  ('00000000-0000-0000-0000-0000000c1802', 'authenticated', 'authenticated', 'c18-check-owner-b@example.invalid');

-- Baseline for owner A: the real shapes.
insert into public.portfolios (name, import_name, user_id) values
  ('IBKR ISA STK (U9407868)', 'IBKR ISA STK', '00000000-0000-0000-0000-0000000c1801'),
  ('ETRO TRD STK', null, '00000000-0000-0000-0000-0000000c1801'),
  ('T212 ISA STK', null, '00000000-0000-0000-0000-0000000c1801');

create function pg_temp.expect_rejected(label text, stmt text, expected_sqlstate text) returns void
language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if sqlstate = expected_sqlstate then
      raise notice 'ok (rejected, %): %', sqlstate, label;
      return;
    end if;
    raise exception 'FAILED: % — expected SQLSTATE %, got % (%)', label, expected_sqlstate, sqlstate, sqlerrm;
  end;
  raise exception 'FAILED: % — statement was accepted but should have been rejected', label;
end $$;

create function pg_temp.expect_accepted(label text, stmt text) returns void
language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    raise exception 'FAILED: % — expected success, got % (%)', label, sqlstate, sqlerrm;
  end;
  raise notice 'ok (accepted): %', label;
end $$;

-- 23505 = unique_violation, 23514 = check_violation. Each statement runs in
-- its own subtransaction (the BEGIN/EXCEPTION block), so accepted rows
-- persist until the final ROLLBACK and rejected ones leave nothing behind.

-- The key function mirrors portfolioNameKey() in src/lib/portfolioNameMatch.ts.
do $$
begin
  if public.portfolio_import_key('  IBKR ISA STK ') is distinct from 'ibkr isa stk' then raise exception 'FAILED: key trims/lower-cases'; end if;
  if public.portfolio_import_key(E'\tA\n') is distinct from 'a' then raise exception 'FAILED: key trims tab/newline'; end if;
  if public.portfolio_import_key(chr(160) || 'A' || chr(65279)) is distinct from 'a' then raise exception 'FAILED: key trims NBSP/BOM'; end if;
  if public.portfolio_import_key('A  B') is distinct from 'a  b' then raise exception 'FAILED: key keeps inner whitespace'; end if;
  if public.portfolio_import_key('   ') is not null then raise exception 'FAILED: blank key is null'; end if;
  if public.portfolio_import_key(null) is not null then raise exception 'FAILED: null key is null'; end if;
  raise notice 'ok: portfolio_import_key';
end $$;

-- Duplicate effective import names for one owner are rejected.
select pg_temp.expect_rejected(
  'cross-case: import_name equal to another portfolio''s display name (whose import_name is null)',
  $s$insert into public.portfolios (name, import_name, user_id) values ('Something Else', ' etro trd stk ', '00000000-0000-0000-0000-0000000c1801')$s$,
  '23505');
select pg_temp.expect_rejected(
  'cross-case, reverse: display name (import_name null) equal to another portfolio''s import_name',
  $s$insert into public.portfolios (name, user_id) values ('IBKR ISA STK', '00000000-0000-0000-0000-0000000c1801')$s$,
  '23505');
select pg_temp.expect_rejected(
  'two import_names differing only by case/whitespace',
  $s$insert into public.portfolios (name, import_name, user_id) values ('Other', E'\tIbkr Isa Stk' || chr(160), '00000000-0000-0000-0000-0000000c1801')$s$,
  '23505');
select pg_temp.expect_rejected(
  'two display names (import_name null) differing only by case/whitespace',
  $s$insert into public.portfolios (name, user_id) values ('  t212 isa stk', '00000000-0000-0000-0000-0000000c1801')$s$,
  '23505');
select pg_temp.expect_rejected(
  'an UPDATE that would create a duplicate is rejected too',
  $s$update public.portfolios set import_name = 'T212 ISA STK' where name = 'ETRO TRD STK' and user_id = '00000000-0000-0000-0000-0000000c1801'$s$,
  '23505');

-- import_name, when present, must not be blank after trimming.
select pg_temp.expect_rejected(
  'blank import_name',
  $s$insert into public.portfolios (name, import_name, user_id) values ('Blank Import', '', '00000000-0000-0000-0000-0000000c1801')$s$,
  '23514');
select pg_temp.expect_rejected(
  'whitespace-only import_name',
  $s$insert into public.portfolios (name, import_name, user_id) values ('Blank Import', E' \t' || chr(160), '00000000-0000-0000-0000-0000000c1801')$s$,
  '23514');

-- Allowed.
select pg_temp.expect_accepted(
  'the same effective import name for a different owner',
  $s$insert into public.portfolios (name, user_id) values ('IBKR ISA STK', '00000000-0000-0000-0000-0000000c1802')$s$);
select pg_temp.expect_accepted(
  'the old suffixed display name as another portfolio''s import key (the IBKR portfolio no longer accepts it)',
  $s$insert into public.portfolios (name, user_id) values ('IBKR ISA STK (U9407868)', '00000000-0000-0000-0000-0000000c1801')$s$);
select pg_temp.expect_accepted(
  'names differing only by inner whitespace are different keys',
  $s$insert into public.portfolios (name, user_id) values ('ETRO  TRD STK', '00000000-0000-0000-0000-0000000c1801')$s$);
select pg_temp.expect_accepted(
  'several portfolios with no import key (blank/null name, null import_name)',
  $s$insert into public.portfolios (name, user_id) values ('', '00000000-0000-0000-0000-0000000c1801'), (null, '00000000-0000-0000-0000-0000000c1801'), ('   ', '00000000-0000-0000-0000-0000000c1801')$s$);
select pg_temp.expect_accepted(
  'clearing import_name back to null falls back to the display name',
  $s$update public.portfolios set import_name = null where name = 'ETRO TRD STK' and user_id = '00000000-0000-0000-0000-0000000c1801'$s$);

do $$ begin raise notice 'C18 DB CHECKS PASSED'; end $$;

rollback;
