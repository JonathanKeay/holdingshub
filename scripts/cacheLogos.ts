// scripts/cacheLogos.ts
import { createClient } from '@supabase/supabase-js';
import { fetchAndCacheLogos } from '../lib/logo';

async function run() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !svc) {
    console.error('Missing env: NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY');
    return;
  }
  const client = createClient(url, svc);
  const { data, error } = await client.from('assets').select('ticker');
  if (error) {
    console.error('Failed to fetch tickers', error);
    return;
  }

  const tickers = data.map((row) => row.ticker);
  await fetchAndCacheLogos(tickers, client);
  console.log('Done caching logos');
}

run();
