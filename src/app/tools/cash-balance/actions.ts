// app/tools/cash-balance/actions.ts
'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServerClient } from '@/lib/supabase-server';

type Ccy = 'GBP' | 'USD' | 'EUR';

type TxRow = {
  type: string | null;
  date: string | null;
  gbp_value?: number | null;   // <-- always portfolio base currency
  cash_value?: number | null;
  cash_ccy?: string | null;
  settle_value?: number | null;
  settle_ccy?: string | null;
  ticker?: string | null;
};

const CC = (s?: string | null) => String(s || '').toUpperCase();
const N = (v: any) => Number(v || 0);

export async function processBalanceAction(_prev: any, formData: FormData) {
  const supabase = await getSupabaseServerClient();

  const intent = String(formData.get('intent') || 'preview');
  const portfolio_id = String(formData.get('portfolio_id') || '');
  const asOf = String(formData.get('as_of') || '');
  const targetStr = String(formData.get('target') || '').replace(/,/g, '').trim();
  const mode = String(formData.get('mode') || 'pre') as 'pre' | 'post';
  const note = String(formData.get('note') || '').trim();
  const explicitCcy = CC(String(formData.get('ccy') || 'GBP')) as Ccy;

  let portfolio_name: string | undefined;
  let ccy: Ccy = explicitCcy;

  if (portfolio_id) {
    const { data: pRec } = await supabase
      .from('portfolios')
      .select('name, base_currency')
      .eq('id', portfolio_id)
      .single();

    if (pRec) {
      portfolio_name = pRec.name;
      ccy = (pRec.base_currency as Ccy) || explicitCcy;
    }
  }

  if (!portfolio_id || !asOf || !targetStr) {
    return {
      ok: false,
      phase: 'error',
      message: 'Please fill all fields (portfolio, date, amount).',
      portfolio_id,
      portfolio_name,
      asOf,
      ccy,
      mode
    };
  }

  const target = Number(targetStr);
  if (!isFinite(target)) {
    return {
      ok: false,
      phase: 'error',
      message: 'Amount must be numeric.',
      portfolio_id,
      portfolio_name,
      asOf,
      ccy,
      mode
    };
  }

  if (!portfolio_name) {
    return {
      ok: false,
      phase: 'error',
      message: 'Portfolio not found.',
      portfolio_id,
      portfolio_name,
      asOf,
      ccy,
      mode
    };
  }

  const op = mode === 'post' ? 'lte' : 'lt';

  // Main transaction fetch with ticker from assets
  const { data: rows, error: fetchErr } = await supabase
    .from('transactions')
    .select(`
      type,
      date,
      gbp_value,
      cash_value,
      cash_ccy,
      settle_value,
      settle_ccy,
      assets(ticker)
    `)
    .eq('portfolio_id', portfolio_id)
    [op]('date', asOf);

  if (fetchErr) {
    return {
      ok: false,
      phase: 'error',
      message: `Error loading transactions: ${fetchErr.message}`,
      portfolio_id,
      portfolio_name,
      asOf,
      ccy,
      mode
    };
  }

  // Flatten ticker from joined assets
  const txWithTicker = (rows || []).map((r: any) => ({
    ...r,
    ticker: r.assets?.ticker || null
  }));

  // --- unified base currency logic ---
  const perRow = (t: TxRow) => {
    const T = CC(t.type);
    const amt = N(t.gbp_value); // already portfolio base currency

    if (!amt && T !== 'BAL') return { used: 0, reason: 'NO_BASE_VALUE' };

    if (T === 'BUY') return { used: -Math.abs(amt), reason: 'BASE_VALUE' };
    if (T === 'SELL') return { used: +Math.abs(amt), reason: 'BASE_VALUE' };
    if (['DEP', 'DIV', 'INT'].includes(T)) return { used: +Math.abs(amt), reason: 'BASE_VALUE' };
    if (['WIT', 'FEE'].includes(T)) return { used: -Math.abs(amt), reason: 'BASE_VALUE' };
    if (T === 'BAL') return { used: amt, reason: 'BASE_VALUE' }; // signed

    return { used: 0, reason: 'IGNORED' };
  };

  const detailed = txWithTicker.map(r => {
    const { used, reason } = perRow(r);
    return { date: r.date, type: CC(r.type), ticker: r.ticker, used_amount: used, reason };
  });

  const included = detailed.filter(d => d.used_amount !== 0);
  const current = included.reduce((s, r) => s + r.used_amount, 0);

  // Same-day transactions with ticker from assets
  const { data: sameDay } = await supabase
    .from('transactions')
    .select(`
      type,
      date,
      gbp_value,
      cash_value,
      cash_ccy,
      settle_value,
      settle_ccy,
      assets(ticker)
    `)
    .eq('portfolio_id', portfolio_id)
    .eq('date', asOf);

  const sameDayWithTicker = (sameDay || []).map((r: any) => ({
    ...r,
    ticker: r.assets?.ticker || null
  }));

  const sameDaySummary = Object.values(
    (sameDayWithTicker as TxRow[]).reduce((acc: any, r) => {
      const { used } = perRow(r);
      const k = CC(r.type) + '|' + (r.ticker || '-');
      if (!acc[k]) acc[k] = { 
        type: CC(r.type), 
        ticker: r.ticker || '-', 
        n: 0, 
        day_total: 0,
        date: r.date
      };
      acc[k].n += 1;
      acc[k].day_total += used;
      return acc;
    }, {})
  ).sort((a: any, b: any) => a.type.localeCompare(b.type));

  const diff = +(target - current).toFixed(2);

  if (intent === 'preview') {
    return {
      ok: true,
      phase: 'preview',
      portfolio_id,
      portfolio_name,
      asOf,
      ccy,
      mode,
      current,
      target,
      diff,
      sameDaySummary,
      included
    };
  }

  if (Math.abs(diff) < 0.01) {
    return {
      ok: true,
      phase: 'done',
      portfolio_id,
      portfolio_name,
      asOf,
      ccy,
      mode,
      message: `No adjustment needed. Current balance already ${new Intl.NumberFormat('en-GB', { style: 'currency', currency: ccy }).format(current)}.`
    };
  }

  // --- Move this block here, inside the function ---
  const { data: cashAsset } = await supabase
    .from('assets')
    .select('id')
    .eq('ticker', `CASH.${ccy}`)
    .single();

  if (!cashAsset) {
    return {
      ok: false,
      phase: 'error',
      message: `Could not find cash asset for ${ccy}`,
      portfolio_id,
      portfolio_name,
      asOf,
      ccy,
      mode
    };
  }
  // --- End move ---

  const { error: insErr } = await supabase.from('transactions').insert({
    portfolio_id,
    type: 'BAL',
    date: asOf,
    gbp_value: diff,
    asset_id: cashAsset.id, // <-- add this line
    notes: note || `BAL via tool · current=${current} · target=${target} · diff=${diff} · ccy=${ccy} · asOf=${asOf}`,
  });

  if (insErr) {
    return {
      ok: false,
      phase: 'error',
      portfolio_id,
      portfolio_name,
      asOf,
      ccy,
      mode,
      message: `Insert failed: ${insErr.message}`
    };
  }

  revalidatePath('/');
  revalidatePath('/dashboard');

  return {
    ok: true,
    phase: 'done',
    portfolio_id,
    portfolio_name,
    asOf,
    ccy,
    mode,
    message: `Inserted BAL of ${new Intl.NumberFormat('en-GB', { style: 'currency', currency: ccy }).format(diff)} (${ccy}) as of ${asOf}.`
  };
}
