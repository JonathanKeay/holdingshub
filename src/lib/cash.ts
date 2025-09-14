// src/lib/cash.ts
export function resolveCashTicker(
  ticker: string | null | undefined,
  currency: string | null | undefined,
  portfolioBase: string | null | undefined
): 'CASH.GBP' | 'CASH.USD' | 'CASH.EUR' {
  const valid = ['GBP', 'USD', 'EUR'] as const;
  if (typeof ticker === 'string' && /^CASH\.(GBP|USD|EUR)$/i.test(ticker)) {
    return ticker.toUpperCase() as any;
  }
  if (typeof currency === 'string' && valid.includes(currency.toUpperCase() as any)) {
    return `CASH.${currency.toUpperCase()}` as any;
  }
  const base = (portfolioBase && valid.includes(portfolioBase.toUpperCase() as any))
    ? (portfolioBase.toUpperCase() as any)
    : 'GBP';
  return `CASH.${base}` as any;
}

export function createCashAssetIdResolver(supabase: any) {
  const cache: Record<string, string> = {};

  return async function ensureCashAssetId(ticker: 'CASH.GBP'|'CASH.USD'|'CASH.EUR'): Promise<string> {
    if (cache[ticker]) return cache[ticker];

    // Try fetch
    let { data, error } = await supabase
      .from('assets')
      .select('id')
      .eq('ticker', ticker)
      .maybeSingle();

    // If missing, create it (safe for concurrent inserts with unique ticker)
    if (!data) {
      const currency = ticker.split('.')[1]; // GBP|USD|EUR
      const name = `Cash (${currency})`;
      const insert = await supabase
        .from('assets')
        .insert({ ticker, currency, name, status: 'active' })
        .select('id')
        .single();

      if (insert.data) {
        data = insert.data;
      } else if (insert.error?.code === '23505') {
        // unique constraint race: fetch again
        const retry = await supabase.from('assets').select('id').eq('ticker', ticker).single();
        data = retry.data!;
      } else if (insert.error) {
        throw insert.error;
      }
    }

    if (error) throw error;
    cache[ticker] = data.id;
    return data.id;
  };
}
