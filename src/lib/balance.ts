// lib/balance.ts
import { createClient } from '@supabase/supabase-js';

type Ccy = 'GBP' | 'USD' | 'EUR';

export async function ensureCashAssetId(supabase: any, ccy: Ccy) {
  const ticker = `CASH.${ccy}`;
  const { data, error } = await supabase
    .from('assets')
    .select('id')
    .eq('ticker', ticker)
    .maybeSingle();
  if (error || !data) {
    throw new Error(`Missing asset for ${ticker}. Create it first in assets.ticker.`);
  }
  return data.id as string;
}

/**
 * Insert a BAL transaction at `date` for signed `amount` in base currency.
 * Positive = increase cash, Negative = decrease.
 * All portfolios now use gbp_value in their base currency.
 */
export async function insertBalanceAdjustment(opts: {
  supabase: any;
  portfolio_id: string;
  date: string;
  amount: number;   // signed
  ccy: Ccy;         // portfolio base currency
  note?: string;
}) {
  const { supabase, portfolio_id, date, amount, ccy, note } = opts;
  if (!amount || !isFinite(amount)) throw new Error('Amount must be a (non-zero) number');

  const asset_id = await ensureCashAssetId(supabase, ccy);
  const signQty = amount >= 0 ? 1 : -1;

  const row: any = {
    portfolio_id,
    asset_id,
    type: 'BAL',
    date,
    quantity: signQty,
    price: 0,
    fee: 0,
    notes: note ?? `Balance adjustment to ${ccy} as of ${date}`,
    gbp_value: Math.abs(amount),   // single source of truth
    // 🔥 removed cash_value + cash_ccy
  };

  const { error } = await supabase.from('transactions').insert([row]);
  if (error) throw error;

  return true;
}
