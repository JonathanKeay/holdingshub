-- Global singleton lock for price streamer using Postgres advisory locks
-- Creates RPCs that the streamer calls to acquire/release the lock.
-- Usage: select try_lock_price_streamer();  -- boolean
--        select unlock_price_streamer();    -- void

create or replace function public.try_lock_price_streamer()
returns boolean
language sql
security definer
set search_path = public
as $$
  select pg_try_advisory_lock(747474, 1001);
$$;

create or replace function public.unlock_price_streamer()
returns void
language sql
security definer
set search_path = public
as $$
  select pg_advisory_unlock(747474, 1001);
$$;

-- Optional: allow anon/authenticated to call; service role bypasses RLS anyway
-- grant execute on function public.try_lock_price_streamer() to anon, authenticated;
-- grant execute on function public.unlock_price_streamer() to anon, authenticated;
