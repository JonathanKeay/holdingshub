// app/tools/cash-balance/actions.ts
'use server';

import { revalidatePath } from 'next/cache';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { computeBalancePreview, type AssetMeta, type Ccy, type Txn } from '@/lib/queries';
import { fetchAllPages, type PagedQuery } from '@/lib/fetchAllPages';

const CC = (s?: string | null) => String(s || '').toUpperCase();

export async function processBalanceAction(_prev: any, formData: FormData) {
  const supabase = await getSupabaseServerClient();

  const intent = String(formData.get('intent') || 'preview');
  const portfolio_id = String(formData.get('portfolio_id') || '');
  const asOf = String(formData.get('as_of') || '');
  const targetStr = String(formData.get('target') || '').replace(/,/g, '').trim();
  const mode = String(formData.get('mode') || 'pre') as 'pre' | 'post';
  const note = String(formData.get('note') || '').trim();

  let portfolio_name: string | undefined;
  // The portfolio's own base_currency is the single authoritative
  // reconciliation currency — there is no caller-supplied override.
  let ccy: Ccy = 'GBP';

  if (portfolio_id) {
    const { data: pRec } = await supabase
      .from('portfolios')
      .select('name, base_currency')
      .eq('id', portfolio_id)
      .single();

    if (pRec) {
      portfolio_name = pRec.name;
      ccy = ((pRec.base_currency as Ccy) || 'GBP');
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

  // Canonical fields only (id, asset_id, type, date, quantity, price, fee,
  // cash_value, cash_ccy) — the same fields calculateCashBalancesMulti reads
  // for the dashboard. gbp_value is never used here. Paged, so a portfolio
  // with more than 1,000 transactions is never silently truncated.
  const { data: txnRows, error: fetchErr } = await fetchAllPages<Txn>(
    () =>
      supabase
        .from('transactions')
        .select('id, portfolio_id, asset_id, type, date, quantity, price, fee, cash_value, cash_ccy')
        .eq('portfolio_id', portfolio_id) as unknown as PagedQuery<Txn>
  );

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

  type AssetRow = { id: string; ticker: string; currency: string | null };
  const { data: assetRows, error: assetsErr } = await fetchAllPages<AssetRow>(
    () => supabase.from('assets').select('id, ticker, currency') as unknown as PagedQuery<AssetRow>
  );

  if (assetsErr) {
    return {
      ok: false,
      phase: 'error',
      message: `Error loading assets: ${assetsErr.message}`,
      portfolio_id,
      portfolio_name,
      asOf,
      ccy,
      mode
    };
  }

  const assetMeta: Record<string, AssetMeta> = {};
  for (const a of assetRows || []) {
    assetMeta[a.id] = { ticker: a.ticker, currency: (a.currency as Ccy) ?? 'GBP' };
  }

  const txns = (txnRows || []) as Txn[];

  const { current, diff, foreignCurrencyWarning } = computeBalancePreview(txns, assetMeta, {
    baseCcy: ccy,
    asOf,
    mode,
    target,
  });

  // Same-day transactions, for the preview's informational breakdown only.
  // Each row's own contribution is computed via the same canonical engine
  // (a single-row call), so this is guaranteed consistent with `current`.
  const sameDayTxns = txns.filter(t => (t.date || '').slice(0, 10) === asOf);
  const sameDaySummary = Object.values(
    sameDayTxns.reduce((acc: any, t) => {
      const ticker = assetMeta[t.asset_id]?.ticker || '-';
      // A single-row call to the canonical engine — guarantees this figure
      // is always consistent with how `current` above was computed.
      const used = computeBalancePreview([t], assetMeta, {
        baseCcy: ccy,
        asOf,
        mode: 'post',
        target: 0,
      }).current;
      const k = CC(t.type) + '|' + ticker;
      if (!acc[k]) acc[k] = { type: CC(t.type), ticker, n: 0, day_total: 0, date: t.date };
      acc[k].n += 1;
      acc[k].day_total += used;
      return acc;
    }, {})
  ).sort((a: any, b: any) => a.type.localeCompare(b.type));

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
      foreignCurrencyWarning,
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

  const defaultNote =
    `BAL reconciliation: calculated ${ccy} ${current.toFixed(2)} vs broker ${ccy} ${target.toFixed(2)} ` +
    `(${mode}-trade) as of ${asOf}. Adjustment ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}.`;

  const { error: insErr } = await supabase.from('transactions').insert({
    portfolio_id,
    type: 'BAL',
    date: asOf,
    asset_id: cashAsset.id,
    quantity: null,
    cash_value: diff, // signed: carries both sign and magnitude, no quantity flag
    cash_ccy: ccy,
    notes: note || defaultNote,
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
