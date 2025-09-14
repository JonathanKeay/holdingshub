// scripts/test-suffix-debug.ts
import 'dotenv/config';
import { fetchAndCachePrices } from '../src/lib/prices';
import { createClient } from '@supabase/supabase-js';

console.log('--- ENV CHECK ---');
console.log('SUPABASE URL:', process.env.NEXT_PUBLIC_SUPABASE_URL);
console.log('SUPABASE KEY:', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.slice(0, 6) + '...');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

(async () => {
  console.log('--- Running suffix resolution test ---');
  const tickers = ['HVO', 'UKW'];
  const prices = await fetchAndCachePrices(tickers);

  console.log('Prices result:', prices);

  const { data, error } = await supabase
    .from('ticker_metadata')
    .select('*')
    .in('original_ticker', tickers);

  if (error) {
    console.error('Error reading ticker_metadata:', error);
  } else {
    console.log('Metadata entries:');
    for (const row of data) {
      console.log(`  ${row.original_ticker} -> ${row.resolved_ticker}`);
    }
  }
})();