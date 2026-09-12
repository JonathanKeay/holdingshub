SET local check_function_bodies = off;

CREATE TABLE "public"."assets" (
  "id"                          uuid                        NOT NULL DEFAULT gen_random_uuid(),
  "ticker"                      text                        NOT NULL,
  "name"                        text,
  "currency"                    text                        DEFAULT 'GBP'::text,
  "created_at"                  timestamp without time zone DEFAULT now(),
  "resolved_ticker"             text,
  "price_multiplier"            numeric                     DEFAULT 1,
  "logo_url"                    text,
  "domain"                      text,
  "status"                      text                        DEFAULT 'active'::text,
  "delisted_at"                 date,
  "last_failed_resolved_ticker" text,
  "resolution_attempted_at"     timestamp with time zone,
  CONSTRAINT "assets_pkey" PRIMARY KEY (id),
  CONSTRAINT "assets_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'delisted'::text, 'acquired'::text, 'inactive'::text, 'unknown'::text])))
);

CREATE TABLE "public"."cash_balances" (
  "id"           uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "portfolio_id" uuid                     NOT NULL,
  "currency"     text                     NOT NULL,
  "balance"      numeric                  NOT NULL DEFAULT 0,
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "cash_balances_pkey" PRIMARY KEY (id),
  CONSTRAINT "cash_balances_unique_portfolio_currency" UNIQUE (portfolio_id, currency)
);

CREATE TABLE "public"."fx_rates" (
  "date"   text  NOT NULL,
  "source" text,
  "quotes" jsonb,
  CONSTRAINT "fx_rates_pkey" PRIMARY KEY (date)
);

CREATE TABLE "public"."portfolios" (
  "id"            uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "name"          text,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "base_currency" text                     DEFAULT 'GBP'::text,
  CONSTRAINT "portfolios_pkey" PRIMARY KEY (id)
);

CREATE TABLE "public"."price_history" (
  "ticker"           text    NOT NULL,
  "price"            numeric,
  "date"             date    NOT NULL DEFAULT CURRENT_DATE,
  "previous_close"   numeric,
  "source"           text,
  "price_multiplier" numeric DEFAULT 1,
  CONSTRAINT "price_history_pkey" PRIMARY KEY (ticker, date)
);

CREATE TABLE "public"."prices" (
  "ticker"           text                     NOT NULL,
  "price"            numeric                  NOT NULL,
  "updated_at"       timestamp with time zone DEFAULT now(),
  "previous_close"   numeric,
  "source"           text,
  "price_multiplier" numeric                  DEFAULT 1,
  CONSTRAINT "prices_pkey" PRIMARY KEY (ticker)
);

CREATE TABLE "public"."settings" (
  "id"                 text                     NOT NULL DEFAULT 'global'::text,
  "show_zero_holdings" boolean                  NOT NULL DEFAULT true,
  "updated_at"         timestamp with time zone DEFAULT now(),
  "visible_statuses"   text[]                   DEFAULT '{active}'::text[],
  "portfolio_prefs"    jsonb                    DEFAULT '{}'::jsonb,
  CONSTRAINT "settings_pkey" PRIMARY KEY (id)
);

CREATE TABLE "public"."transactions" (
  "id"                   uuid                     NOT NULL DEFAULT gen_random_uuid(),
  "portfolio_id"         uuid,
  "asset_id"             uuid,
  "type"                 text                     DEFAULT ''::text,
  "quantity"             numeric,
  "price"                numeric,
  "fee"                  numeric,
  "created_at"           timestamp with time zone NOT NULL DEFAULT now(),
  "date"                 timestamp with time zone,
  "gbp_value"            numeric,
  "notes"                text,
  "split_factor"         numeric,
  "cash_value"           numeric,
  "cash_ccy"             text,
  "cash_fx_to_portfolio" numeric,
  "settle_value"         numeric,
  "settle_ccy"           text,
  CONSTRAINT "cash_value_requires_ccy" CHECK (((cash_value IS NULL) OR (cash_ccy IS NOT NULL))),
  CONSTRAINT "chk_spl_factor" CHECK ((((type <> 'SPL'::text) AND ((split_factor IS NULL) OR (split_factor > (0)::numeric))) OR ((type = 'SPL'::text) AND (split_factor IS
    NOT NULL) AND (split_factor > (0)::numeric)))),
  CONSTRAINT "transactions_cash_ccy_check" CHECK ((cash_ccy = ANY (ARRAY['GBP'::text, 'USD'::text, 'EUR'::text]))),
  CONSTRAINT "transactions_pkey" PRIMARY KEY (id),
  CONSTRAINT "transactions_settle_ccy_check" CHECK ((settle_ccy = ANY (ARRAY['GBP'::text, 'USD'::text, 'EUR'::text])))
);

CREATE OR REPLACE FUNCTION public.trg_transactions_mirror_settle_to_cash()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $function$
begin
  if upper(new.type) in ('BUY','SELL') then
    if new.cash_value is null and new.settle_value is not null then
      new.cash_value := new.settle_value;
    end if;
    if new.cash_ccy   is null and new.settle_ccy   is not null then
      new.cash_ccy := upper(new.settle_ccy);
    end if;
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.try_lock_price_streamer()
  RETURNS boolean
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
  select pg_try_advisory_lock(747474, 1001);
$function$;

CREATE OR REPLACE FUNCTION public.unlock_price_streamer()
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
  select pg_advisory_unlock(747474, 1001);
$function$;

CREATE OR REPLACE FUNCTION public.upsert_cash_balance (
  p_portfolio_id uuid,
  p_currency     text,
  p_amount       numeric
)
  RETURNS void
  LANGUAGE plpgsql
  AS $function$
begin
  insert into cash_balances (portfolio_id, currency, amount)
  values (p_portfolio_id, p_currency, p_amount)
  on conflict (portfolio_id, currency)
  do update set amount = excluded.amount, updated_at = now();
end;
$function$;

ALTER TABLE "public"."cash_balances"
  ADD CONSTRAINT "cash_balances_portfolio_id_fkey" FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(id) ON DELETE CASCADE;

ALTER TABLE "public"."transactions"
  ADD CONSTRAINT "transactions_asset_id_fkey" FOREIGN KEY (asset_id) REFERENCES public.assets(id);

ALTER TABLE "public"."transactions"
  ADD CONSTRAINT "transactions_portfolio_id_fkey" FOREIGN KEY (portfolio_id) REFERENCES public.portfolios(id);

CREATE UNIQUE INDEX uq_bal_one_per_day_cash ON public.transactions USING btree (portfolio_id, date, cash_ccy)
  WHERE (upper(TYPE) = 'BAL'::text);

CREATE TRIGGER mirror_settle_to_cash
  BEFORE INSERT OR UPDATE ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_transactions_mirror_settle_to_cash();

COMMENT ON COLUMN "public"."price_history"."price_multiplier" IS 'Multiplier applied to raw price on that date.';

COMMENT ON COLUMN "public"."prices"."price_multiplier" IS 'Multiplier applied to raw price (e.g. ADR ratio or reverse split factor).';

COMMENT ON COLUMN "public"."transactions"."gbp_value" IS 'Total value of this transction in GBP';

COMMENT ON COLUMN "public"."transactions"."split_factor" IS 'Use for stock splits (2 = 2 for 1) & reverse splits (0.2 = 5 for 1)';

GRANT EXECUTE ON FUNCTION "public"."trg_transactions_mirror_settle_to_cash"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."try_lock_price_streamer"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."unlock_price_streamer"() TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT EXECUTE ON FUNCTION "public"."upsert_cash_balance"(uuid, text, numeric) TO PUBLIC, "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."assets" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."cash_balances" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."fx_rates" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."portfolios" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."price_history" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."prices" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."settings" TO "anon", "authenticated", "postgres", "service_role";

GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."transactions" TO "anon", "authenticated", "postgres", "service_role";

