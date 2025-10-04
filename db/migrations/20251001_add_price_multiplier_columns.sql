-- Migration: Add price_multiplier columns to prices and price_history (idempotent)
-- Date: 2025-10-01

-- prices table: add column if not exists
ALTER TABLE public.prices
  ADD COLUMN IF NOT EXISTS price_multiplier numeric DEFAULT 1;

-- price_history table: add column if not exists
ALTER TABLE public.price_history
  ADD COLUMN IF NOT EXISTS price_multiplier numeric DEFAULT 1;

-- Backfill any NULLs to 1
UPDATE public.prices SET price_multiplier = 1 WHERE price_multiplier IS NULL;
UPDATE public.price_history SET price_multiplier = 1 WHERE price_multiplier IS NULL;

-- (Optional) COMMENT for clarity
COMMENT ON COLUMN public.prices.price_multiplier IS 'Multiplier applied to raw price (e.g. ADR ratio or reverse split factor).';
COMMENT ON COLUMN public.price_history.price_multiplier IS 'Multiplier applied to raw price on that date.';

-- NOTE: If RLS exists, ensure policies allow service-role upserts including new column.
-- To refresh PostgREST schema cache (if using Supabase) you may need to restart or:
-- NOTIFY pgrst, 'reload schema';
