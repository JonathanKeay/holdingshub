import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { fetchAndCachePrices } from '../src/lib/prices';

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !anon) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
    process.exit(1);
  }
  // Simulate the server-side client (not forcing service role) by default
  const client = createClient(url, svc || anon);
  const tickers = process.argv.slice(2).length ? process.argv.slice(2) : ['AMD'];
  console.log('Checking prices for', tickers.join(','));
  const result = await fetchAndCachePrices(tickers, undefined, client);
  console.log('fetchAndCachePrices =>', result);
  // Also show the raw DB rows for visibility
  const { data } = await client
    .from('prices')
    .select('ticker,price,previous_close,price_multiplier,updated_at,source')
    .in('ticker', tickers)
    .order('updated_at', { ascending: false });
  console.log('DB rows (desc):', data);
}

main().catch((e) => { console.error(e); process.exit(1); });
