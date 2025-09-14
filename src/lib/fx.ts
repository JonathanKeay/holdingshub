// src/lib/fx.ts
import { supabase } from './supabase';

export async function fetchExchangeRatesToGBP(): Promise<Record<string, number>> {
  const today = new Date().toISOString().slice(0, 10);

  // 1. Try cache first
  const { data: cached, error } = await supabase
    .from('fx_rates')
    .select('quotes')
    .eq('date', today)
    .single();

  if (cached?.quotes) {
    console.log('Using cached FX rates for', today);
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

  console.log('Fetched and cached new FX rates for', today);
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