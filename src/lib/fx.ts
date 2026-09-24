// src/lib/fx.ts
import { createClient } from '@supabase/supabase-js';

// This function only ever runs in trusted server code (wrapped in
// unstable_cache and called from React Server Components — never exposed to
// the browser). `fx_rates` is shared reference data: SELECT is open to
// anon/authenticated, but INSERT/UPDATE/DELETE are service-role only (see
// 20260914100300_rls_shared_reference_data.sql), so the caching upsert
// below needs a service-role client, not the plain anon-key one.
function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('fetchExchangeRatesToGBP: missing Supabase service-role env vars');
  return createClient(url, key);
}

export async function fetchExchangeRatesToGBP(): Promise<Record<string, number>> {
  const supabase = getServiceClient();
  const today = new Date().toISOString().slice(0, 10);

  // 1. Try cache first
  const { data: cached } = await supabase
    .from('fx_rates')
    .select('quotes')
    .eq('date', today)
    .single();

  if (cached?.quotes) {
    // debug log removed (using cached FX rates)
    return parseQuotesToGBP(cached.quotes);
  }

  // 2. Fetch from API
  const url = `https://api.exchangerate.host/live?access_key=${process.env.EXCHANGE_RATE_API_KEY}&source=GBP`;
  const res = await fetch(url);
  const json = await res.json();

  if (!json.success) {
    console.error('FX API error:', json.error);
    return { GBP: 1 };
  }

  const quotes = json.quotes;

  // 3. Cache in Supabase
  await supabase.from('fx_rates').upsert({
    date: today,
    source: 'GBP',
    quotes,
  });

  // debug log removed (fetched and cached new FX rates)
  return parseQuotesToGBP(quotes);
}

// Helper: Convert {GBPUSD: 1.29} → {USD: 1 / 1.29}
function parseQuotesToGBP(quotes: Record<string, number>): Record<string, number> {
  const rates: Record<string, number> = {};

  for (const [key, rate] of Object.entries(quotes)) {
    const match = key.match(/^GBP([A-Z]{3})$/);
    if (match) {
      const currency = match[1];
      rates[currency] = 1 / rate;
    }
  }

  rates['GBP'] = 1;
  return rates;
}