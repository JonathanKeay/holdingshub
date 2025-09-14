// scripts/cacheLogos.ts
import { supabase } from '../lib/supabase';
import { fetchAndCacheLogos } from '../lib/logo';

async function run() {
  const { data, error } = await supabase.from('assets').select('ticker');
  if (error) {
    console.error('Failed to fetch tickers', error);
    return;
  }

  const tickers = data.map((row) => row.ticker);
  await fetchAndCacheLogos(tickers);
  console.log('Done caching logos');
}

run();
