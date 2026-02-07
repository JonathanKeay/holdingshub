import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { fetchAndCachePrices } from '../src/lib/prices';

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) {
    console.error('Missing env: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const tickersArg = process.argv.slice(2);
  const tickers = tickersArg.length ? tickersArg : ['AMD'];
  const supabase = createClient(url, serviceRole);
  console.log(`Reading latest DB prices for: ${tickers.join(', ')}`);
  const result = await fetchAndCachePrices(tickers, undefined, supabase);
  // Echo DB rows post-write to confirm
  const { data, error } = await supabase
    .from('prices')
    .select('ticker,price,previous_close,price_multiplier,updated_at,source')
    .in('ticker', tickers)
    .order('updated_at', { ascending: false });
  if (error) {
    console.error('DB read error:', error);
  }
  console.log('Fetch result:', result);
  console.log('DB state:', data);
}

main().catch((e) => { console.error(e); process.exit(1); });
